import {
  AgentPlan, AgentPlanDetails, EvidenceBundle, GroundedAnswerSchema, ParsedGoal, PlanStep
} from "@nexusops/shared-types";
import { z } from "zod";
import { config } from "../../config/index.js";
import { AGENT_INTEGRITY_INSTRUCTIONS } from "../policies/dataIntegrity.js";
import { deterministicQueryAnalysis, validateAgentPlanDetails, withPlanningFallbackReason } from "../queryAnalysis.js";

export interface ILLMProvider {
  parseGoal(prompt: string): Promise<ParsedGoal>;
  analyzeQuery?(prompt: string, timezone?: string): Promise<AgentPlan>;
  generatePlan(parsedGoal: ParsedGoal, observationData: Record<string, unknown>, instructions: string): Promise<Omit<PlanStep, "status">[]>;
  generateGroundedAnswer?(goal: string, evidence: EvidenceBundle): Promise<GroundedAnswerGeneration>;
}

export type GroundedAnswerGeneration =
  | { kind: "generated"; candidate: unknown }
  | { kind: "unavailable"; reason: "service_unavailable" | "malformed_output" };

/** Deterministic placeholder adapter. It parses only the supplied goal and never invents actions or records. */
export class MockLLMProvider implements ILLMProvider {
  async parseGoal(prompt: string): Promise<ParsedGoal> {
    const objective = z.string().trim().min(1).parse(prompt);
    const dayMatch = objective.match(/\b(\d+)\s+days?\b/i);
    const timeWindowDays = dayMatch ? Number(dayMatch[1]) : 30;
    return {
      objective,
      timeWindowDays,
      constraints: [],
      successCriteria: []
    };
  }

  async analyzeQuery(prompt: string, timezone?: string): Promise<AgentPlan> {
    return deterministicQueryAnalysis(prompt, timezone);
  }

  async generatePlan(_parsedGoal: ParsedGoal, _observationData: Record<string, unknown>, _instructions: string): Promise<Omit<PlanStep, "status">[]> {
    if (_instructions !== AGENT_INTEGRITY_INSTRUCTIONS) throw new Error("Required agent integrity instructions are missing.");
    throw new Error("No planning model is configured. No plan or business actions were generated.");
  }

  async generateGroundedAnswer(_goal: string, evidence: EvidenceBundle): Promise<GroundedAnswerGeneration> {
    const claims = evidence.items.map((item, index) => ({
      claimId: `evidence-${index + 1}`,
      text: item.statement,
      evidenceRefs: [item.evidenceRef],
      status: "supported" as const
    }));
    return { kind: "generated", candidate: {
      status: evidence.sufficiency,
      answer: claims.map(({ text }) => text).join("\n") || "Insufficient evidence to determine the requested result.",
      claims,
      evidenceRefs: claims.flatMap(({ evidenceRefs }) => evidenceRefs),
      limitations: evidence.limitations,
      recommendations: []
    } };
  }
}

type OpenAIResponseOptions = {
  apiKey: string;
  model?: string;
  fetcher?: typeof fetch;
};

/** Extends the existing query planner and grounds structured answers in sanitized run evidence. */
export class OpenAIResponseProvider extends MockLLMProvider {
  private readonly fetcher: typeof fetch;
  private readonly model: string;

  constructor(private readonly options: OpenAIResponseOptions) {
    super();
    this.fetcher = options.fetcher ?? fetch;
    this.model = options.model ?? "gpt-4o-mini";
  }

  /** Falls back on unavailable or schema/grounding-invalid output; the mock provider always uses deterministic patterns. */
  override async analyzeQuery(prompt: string, timezone?: string): Promise<AgentPlan> {
    const response = await this.requestQueryAnalysis(prompt, timezone);
    if (!response.ok) {
      return withPlanningFallbackReason(deterministicQueryAnalysis(prompt, timezone), response.reason);
    }
    const details = validateAgentPlanDetails(response.value);
    if (!details || !analysisMatchesPrompt(details, prompt, timezone)) {
      return withPlanningFallbackReason(deterministicQueryAnalysis(prompt, timezone), "invalid_llm_output");
    }
    return { ...details, planningMethod: "llm" };
  }

  override async generateGroundedAnswer(goal: string, evidence: EvidenceBundle): Promise<GroundedAnswerGeneration> {
    if (!this.options.apiKey || evidence.items.length === 0) return super.generateGroundedAnswer(goal, evidence);
    try {
      const response = await this.fetcher("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${this.options.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          temperature: 0,
          max_tokens: 1800,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content: `${AGENT_INTEGRITY_INSTRUCTIONS}\n\nReturn one JSON object matching this shape: {status, answer, claims:[{claimId,text,evidenceRefs,confidence?,status:"supported"|"unsupported"|"uncertain"}],evidenceRefs,limitations,confidence?,recommendedNextStep?:{text,evidenceRefs},recommendations:[{statement,reason,evidenceRefs,expectedOutcome}]}. The supplied evidence bundle is the only source of business facts. Answer only from it. Every factual claim must have one or more exact evidenceRef values from the bundle and status supported. Never invent facts, missing values, definitions, thresholds, or source coverage. Never interpret a no-match result as proof that an event never happened. Preserve ambiguous, conflicting, unavailable, disconnected, denied, and tool-failure states. Do not merge identities unless the bundle links them. Recommendations are optional and must cite evidence; do not propose actions as already executed. Do not include chain-of-thought.`
            },
            { role: "user", content: JSON.stringify({ goal, evidence }) }
          ]
        }),
        signal: AbortSignal.timeout(20_000)
      });
      if (!response.ok) return { kind: "unavailable", reason: "service_unavailable" };
      const payload = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
      const content = payload.choices?.[0]?.message?.content;
      if (typeof content !== "string") return { kind: "unavailable", reason: "malformed_output" };
      try {
        const candidate: unknown = JSON.parse(content);
        const parsed = GroundedAnswerSchema.safeParse(candidate);
        return parsed.success
          ? { kind: "generated", candidate: parsed.data }
          : { kind: "unavailable", reason: "malformed_output" };
      } catch {
        return { kind: "unavailable", reason: "malformed_output" };
      }
    } catch {
      return { kind: "unavailable", reason: "service_unavailable" };
    }
  }

  private async requestQueryAnalysis(prompt: string, timezone?: string): Promise<
    { ok: true; value: unknown } | { ok: false; reason: "llm_unavailable" }
  > {
    try {
      const response = await this.fetcher("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${this.options.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          temperature: 0,
          max_tokens: 1200,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content: `${AGENT_INTEGRITY_INSTRUCTIONS}\n\nAnalyze the user's business query and return one JSON object with intent, entities, requestedFacts, analyticalRequirements, outputRequirements, sources, optional dateRange, filters, optional sort, optional limit, dependencies, ambiguity, confidence, and decisionSummary. Use intent one of email_reply_check, cross_source_contact_status, email_search, email_content_question, crm_lead_search, crm_deal_value, calendar_event_search, calendar_availability, analytics_query, task_query, task_action, unknown. Entity types: person, company, email, phone. Source names: crm, gmail, calendar, analytics, tasks. Date range has type relative or absolute, the literal expression, and optional timezone/start/end. Filter operators: equals, contains, greater_than, greater_than_or_equal, less_than, less_than_or_equal, before, after. Ambiguity types: none, entity_resolution_required, multiple_entity_matches, unclear_intent. Extract the requested analytical operations and answer format generically. Select only existing sources needed to retrieve evidence for the requested facts; add dependencies when one source supplies identity/context required by another. Do not resolve identity against records. Do not invent entities, dates, filters, requested facts, or sources. Use concise decision metadata only; do not provide chain-of-thought. Use unknown and no sources when the request cannot be classified safely.`
            },
            { role: "user", content: JSON.stringify({ query: prompt, timezone: timezone ?? null }) }
          ]
        }),
        signal: AbortSignal.timeout(20_000)
      });
      if (!response.ok) return { ok: false, reason: "llm_unavailable" };
      const payload = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
      const content = payload.choices?.[0]?.message?.content;
      if (typeof content !== "string") return { ok: true, value: undefined };
      try {
        return { ok: true, value: JSON.parse(content) as unknown };
      } catch {
        return { ok: true, value: undefined };
      }
    } catch {
      return { ok: false, reason: "llm_unavailable" };
    }
  }
}

function analysisMatchesPrompt(plan: AgentPlanDetails, prompt: string, timezone?: string): boolean {
  const lowerPrompt = prompt.toLocaleLowerCase("en-US");
  if (plan.confidence < 0.5) return false;
  if (plan.ambiguity.type === "multiple_entity_matches") return false;
  const groundedPlan = deterministicQueryAnalysis(prompt, timezone);
  if (plan.entities.some(({ value }) => !lowerPrompt.includes(value.toLocaleLowerCase("en-US")))) return false;
  if (groundedPlan.entities.some(({ type, value }) => !plan.entities.some((entity) =>
    entity.type === type && entity.value.toLocaleLowerCase("en-US") === value.toLocaleLowerCase("en-US")))) return false;
  if (groundedPlan.sources.some((source) => !plan.sources.includes(source))) return false;
  if (plan.sources.some((source) => !groundedPlan.sources.includes(source)) && plan.analyticalRequirements.length === 0) return false;
  const queryTerms = new Set(lowerPrompt.match(/[a-z0-9]{4,}/g) ?? []);
  const querySupportsPhrase = (phrase: string) =>
    (phrase.toLocaleLowerCase("en-US").match(/[a-z0-9]{4,}/g) ?? []).some((term) => queryTerms.has(term));
  if (plan.requestedFacts.some((fact) => !querySupportsPhrase(fact)) ||
      plan.analyticalRequirements.some((requirement) => !querySupportsPhrase(requirement)) ||
      plan.outputRequirements.some((requirement) => !querySupportsPhrase(requirement))) return false;
  if (groundedPlan.ambiguity.type !== "none" && plan.ambiguity.type !== groundedPlan.ambiguity.type) return false;
  if (plan.dateRange && !lowerPrompt.includes(plan.dateRange.expression.toLocaleLowerCase("en-US"))) return false;
  if (plan.dateRange && (groundedPlan.dateRange?.expression.toLocaleLowerCase("en-US") !== plan.dateRange.expression.toLocaleLowerCase("en-US") ||
      groundedPlan.dateRange.type !== plan.dateRange.type)) return false;
  if (plan.dateRange?.type === "absolute" && plan.dateRange.start !== groundedPlan.dateRange?.start) return false;
  if (plan.dateRange?.end && plan.dateRange.end !== groundedPlan.dateRange?.end) return false;
  if (plan.dateRange?.timezone && plan.dateRange.timezone !== timezone) return false;
  if (plan.ambiguity.entity && !lowerPrompt.includes(plan.ambiguity.entity.toLocaleLowerCase("en-US"))) return false;
  if (plan.ambiguity.candidates.length > 0) return false;
  if (plan.filters.some(({ field, value }) => {
    if (field === "highValue") return !/\bhigh[- ]?value\b/i.test(prompt);
    if (typeof value === "boolean") return false;
    const valueText = String(value).toLocaleLowerCase("en-US").replaceAll(",", "");
    return !lowerPrompt.replaceAll(",", "").includes(valueText);
  })) return false;
  if (plan.limit && !new RegExp(`\\b(?:top|first|latest)\\s+${plan.limit}\\b`, "i").test(prompt)) return false;
  if (plan.dependencies.some(({ source, dependsOn }) =>
    source === dependsOn || !plan.sources.includes(source) || !plan.sources.includes(dependsOn))) return false;
  return true;
}

export function getLLMProvider(): ILLMProvider {
  if (config.llmProvider.toLocaleLowerCase("en-US") === "openai") {
    if (!config.openaiApiKey) throw new Error("LLM_PROVIDER=openai requires OPENAI_API_KEY.");
    return new OpenAIResponseProvider({
      apiKey: config.openaiApiKey,
      ...(process.env.OPENAI_MODEL ? { model: process.env.OPENAI_MODEL } : {})
    });
  }
  return new MockLLMProvider();
}
