import { StepStatus, ToolResponse, ToolResult } from "@nexusops/shared-types";

export const AGENT_INTEGRITY_INSTRUCTIONS = `
NON-NEGOTIABLE DATA INTEGRITY RULES
1. Never invent business data, records, values, dates, or outcomes.
2. Never regenerate or replace data when a business tool returns no results.
3. Preserve business tool results exactly; never modify, duplicate, omit, or complete them.
4. When a query returns an empty result, report explicitly that no matching records were found.
5. Do not repeat a tool call with identical arguments because its result was empty.
6. Do not relax user criteria unless the user explicitly requests it.
7. Claim an action occurred only when its action tool returned success and confirmed that action.
8. Business facts must come from business tool results.
9. Label every reported statement as FACT, INFERENCE, or RECOMMENDATION.
10. If available evidence is insufficient, say so; do not fill gaps with assumptions.
`;

export type EvidenceItem = {
  evidenceRef: string;
  tool: string;
  action: string;
  statement: string;
  outcome: "EMPTY_RESULT" | "RESULT_RETURNED" | "SUCCESS_NOT_CONFIRMED";
  error?: { code: string; message: string };
};

export type EvidenceLinkedRecommendation = {
  statement: string;
  evidenceRefs: string[];
};

export type AgentEvidenceReport = {
  FACT: EvidenceItem[];
  INFERENCE: string[];
  RECOMMENDATION: string[];
  recommendationEvidence: EvidenceLinkedRecommendation[];
  evidenceInsufficient: boolean;
};

export type ToolObservation = {
  tool: string;
  action: string;
  params: Record<string, unknown>;
  result: ToolResponse;
};

/** Returns a user-facing claim only when the action result confirms its mutation. */
export function verifiedActionStatement(tool: string, action: string, result: ToolResponse): string | undefined {
  if (tool !== "tasks" || (action !== "createTask" && action !== "completeTask") || !result.success) return undefined;
  if (typeof result.data !== "object" || result.data === null) return undefined;
  const data = result.data as Record<string, unknown>;
  if (typeof data.task !== "object" || data.task === null) return undefined;
  const task = data.task as Record<string, unknown>;
  if (action === "createTask" && data.created === true && typeof task.id === "string" && typeof task.title === "string" && task.status === "OPEN") {
    return `Created task "${task.title}" (id: ${task.id}).`;
  }
  if (action === "completeTask" && data.updated === true && typeof task.id === "string" && task.status === "COMPLETED") {
    return `Completed task ${task.id}.`;
  }
  return undefined;
}

export function canAssertGoalCompletion(statuses: readonly StepStatus[]): boolean {
  return statuses.length > 0 && statuses.every((status) => status === StepStatus.COMPLETED);
}

function emptyResultStatement(tool: string, action: string, params: Record<string, unknown>): string {
  if (tool === "crm" && action === "listActiveHighValueLeads") return "No active high-value leads were found.";
  if (tool === "crm" && action === "listInactiveLeads") return "No inactive high-value leads were found.";
  if (tool === "email" && action === "getUnansweredMessages") return "No unanswered email messages were found.";
  if (tool === "email" && action === "getEmailHistory") {
    return params.leadEmail ? "No email history was found for this lead." : "No email history was found for the requested criteria.";
  }
  if (tool === "calendar" && action === "getAvailability") return "No matching calendar availability was found.";
  if (tool === "calendar" && (action === "getMeeting" || action === "listUpcomingEvents")) return "No matching calendar events were found.";
  if (tool === "email" && action === "getUnansweredMessages") return "No unanswered email messages were found.";
  return "No matching records were found.";
}

export function buildEvidenceReport(observations: readonly ToolObservation[]): AgentEvidenceReport {
  const facts: EvidenceItem[] = observations.map(({ tool, action, params, result }, index) => {
    const evidenceRef = `${tool}.${action}#${index + 1}`;
    const actionStatement = verifiedActionStatement(tool, action, result);
    if (actionStatement) return { evidenceRef, tool, action, statement: actionStatement, outcome: "RESULT_RETURNED" };
    if (!result.success) {
      return {
        evidenceRef,
        tool, action,
        statement: `The tool did not confirm success: ${result.error.code} — ${result.error.message}`,
        outcome: "SUCCESS_NOT_CONFIRMED",
        error: { ...result.error }
      };
    }
    if (tool === "tasks" && (action === "createTask" || action === "completeTask")) {
      return { evidenceRef, tool, action, statement: "The task mutation was not confirmed by the returned task entity.", outcome: "SUCCESS_NOT_CONFIRMED" };
    }
    if (Array.isArray(result.data) && result.data.length === 0) {
      return { evidenceRef, tool, action, statement: emptyResultStatement(tool, action, params), outcome: "EMPTY_RESULT" };
    }
    return {
      evidenceRef,
      tool, action,
      statement: "The business tool returned a result; consult its original action result for details.",
      outcome: "RESULT_RETURNED"
    };
  });

  const evidenceInsufficient = observations.length === 0 || observations.some(({ result }) =>
    !result.success || (Array.isArray(result.data) && result.data.length === 0));
  const inactiveCRM = facts.find((fact) => fact.tool === "crm" && fact.action === "listInactiveLeads" && fact.outcome === "RESULT_RETURNED");
  const recommendationEvidence: EvidenceLinkedRecommendation[] = inactiveCRM
    ? [{ statement: "Review the matching inactive high-value leads to decide whether follow-up is appropriate.", evidenceRefs: [inactiveCRM.evidenceRef] }]
    : [];
  return {
    FACT: facts,
    INFERENCE: [
      ...(inactiveCRM ? ["The CRM query returned records matching its inactive high-value criteria."] : []),
      ...(evidenceInsufficient ? ["Insufficient evidence to determine whether a lead-specific follow-up is due."] : ["No inference was added beyond the returned business tool evidence."])
    ],
    RECOMMENDATION: recommendationEvidence.map(({ statement }) => statement),
    recommendationEvidence,
    evidenceInsufficient
  };
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(",")}}`;
}

export function emptyToolCallKey(
  runId: string, orgId: string, tool: string, action: string, params: Record<string, unknown>
): string {
  return [runId, orgId, tool, action, canonicalize(params)].join("\u001f");
}

/** Suppresses only repeated successful empty queries; errors remain retryable. */
export class EmptyResultCallGuard {
  private readonly emptyResults = new Map<string, ToolResult>();

  async execute(key: string, actionId: string, invoke: () => Promise<ToolResponse>): Promise<ToolResponse> {
    const previous = this.emptyResults.get(key);
    if (previous) {
      return {
        success: false,
        error: { code: "DUPLICATE_EMPTY_QUERY", message: "An identical query already returned no results; the tool was not called again." },
        metadata: { executionTimeMs: 0, actionId, cached: true }
      };
    }
    const result = await invoke();
    if (result.success && Array.isArray(result.data) && result.data.length === 0) {
      this.emptyResults.set(key, structuredClone(result));
      if (this.emptyResults.size > 2_000) {
        const oldestKey = this.emptyResults.keys().next().value;
        if (oldestKey !== undefined) this.emptyResults.delete(oldestKey);
      }
    }
    return result;
  }
}
