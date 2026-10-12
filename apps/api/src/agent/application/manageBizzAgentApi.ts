import { randomUUID } from "node:crypto";
import {
  AgentPlan, AgentStructuredResult, EvidenceBundle, GroundedAnswer, ParsedGoal,
  ToolExecutionContext, ToolResponse
} from "@nexusops/shared-types";
import { ToolOrchestrator, ACTION_TOOL_ACTIONS } from "../../tools/index.js";
import {
  buildEvidenceReport, ToolObservation, validateGroundedAnswer
} from "../policies/dataIntegrity.js";
import { ApprovalActionWorkflow, ActionProposal } from "../runtime/approvalWorkflow.js";
import { ControlledAgentOrchestrator, PlanningError, type InvestigationPlan, type PlannedToolCall, planBusinessGoal } from "../runtime/controlledOrchestrator.js";
import { RunTraceRecord, RunTraceStore, runTraceStore } from "../runtime/runTrace.js";
import { getLLMProvider, type GroundedAnswerGeneration } from "../llm/unifiedLLM.js";
import { deterministicQueryAnalysis } from "../queryAnalysis.js";

export type ManageBizzRunStatus = "running" | "awaiting_approval" | "completed" | "failed";
export type ManageBizzRunResult = {
  runId: string;
  status: ManageBizzRunStatus;
  answer: string;
  response: {
    summary: string;
    facts: AgentEvidenceFact[];
    inferences: string[];
    recommendations: ReturnType<typeof buildEvidenceReport>["recommendationEvidence"];
    evidenceInsufficient: boolean;
    groundedAnswer?: GroundedAnswer;
    limitations: string[];
  };
  structuredResult?: AgentStructuredResult;
  plan: { objective: string; factsRequired: string[]; steps: Array<{ tool: string; action: string; purpose: string; dependsOnCRMResults: boolean }> };
  queryPlan?: AgentPlan;
  evidence: { facts: AgentEvidenceFact[]; inferences: string[]; evidenceInsufficient: boolean; bundle: EvidenceBundle };
  groundedAnswer?: GroundedAnswer;
  recommendations: ReturnType<typeof buildEvidenceReport>["recommendationEvidence"];
  actions: ActionProposal[];
  trace: RunTraceRecord;
  error?: { code: string; message: string };
};
type AgentEvidenceFact = ReturnType<typeof buildEvidenceReport>["FACT"][number];
export type ManageBizzRunInput = { goal: string; orgId: string; userId: string; timezone?: string };
type GoalParser = {
  parseGoal(goal: string): Promise<ParsedGoal>;
  analyzeQuery?(goal: string, timezone?: string): Promise<AgentPlan>;
  generateGroundedAnswer?(goal: string, evidence: EvidenceBundle): Promise<GroundedAnswerGeneration>;
};
type Session = {
  orgId: string;
  userId: string;
  workflow: ApprovalActionWorkflow;
  observations: ToolObservation[];
  plan?: InvestigationPlan;
  queryPlan?: AgentPlan;
  completion: Promise<ManageBizzRunResult>;
  proposalReady: Promise<ActionProposal>;
  proposalCount: number;
  proposalWaiters: Array<{ after: number; resolve: () => void }>;
  resolveProposal: (proposal: ActionProposal) => void;
  finalResult?: ManageBizzRunResult;
};
export type ApplicationToolExecutor = (call: PlannedToolCall, context: ToolExecutionContext) => Promise<ToolResponse>;

/** Stable UI-facing boundary. Agent tools, planner and approval internals remain behind this contract. */
export class ManageBizzAgentApi {
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly executeTool: ApplicationToolExecutor = (call, context) =>
      ToolOrchestrator.executeToolCall(call.tool, call.action, call.params, context),
    private readonly parser: GoalParser = getLLMProvider(),
    private readonly traces: RunTraceStore = runTraceStore
  ) {}

  async run({ goal, orgId, userId, timezone }: ManageBizzRunInput): Promise<ManageBizzRunResult> {
    if (!goal.trim() || !orgId || !userId) throw new Error("Agent runs require a goal and trusted authenticated workspace identity.");
    const runId = `run-${randomUUID()}`;
    const goalId = `goal-${randomUUID()}`;
    this.traces.startRun({ runId, goalId, orgId, userId });

    let resolveProposal!: (proposal: ActionProposal) => void;
    const proposalReady = new Promise<ActionProposal>((resolve) => { resolveProposal = resolve; });
    const observations: ToolObservation[] = [];
    let sessionRef: Session | undefined;
    const workflow = new ApprovalActionWorkflow({ onUpdate: async (proposal) => {
      this.traceActionLifecycle(runId, proposal);
      if (proposal.lifecycle === "PROPOSED") {
        resolveProposal(proposal);
        if (sessionRef) {
          sessionRef.proposalCount += 1;
          for (const waiter of sessionRef.proposalWaiters.splice(0)) {
            if (sessionRef.proposalCount > waiter.after) waiter.resolve();
            else sessionRef.proposalWaiters.push(waiter);
          }
        }
      }
    } });

    const session = {} as Session;
    Object.assign(session, { orgId, userId, workflow, observations, proposalReady, resolveProposal, proposalCount: 0, proposalWaiters: [] });
    sessionRef = session;
    this.sessions.set(runId, session);

    const complete = async (): Promise<ManageBizzRunResult> => {
      try {
        const parsedGoal = await this.parser.parseGoal(goal);
        const queryPlan = this.parser.analyzeQuery
          ? await this.parser.analyzeQuery(goal, timezone)
          : deterministicQueryAnalysis(goal, timezone);
        session.queryPlan = queryPlan;
        if (queryPlan.intent === "unknown" || queryPlan.sources.length === 0) {
          throw new PlanningError("The request could not be classified safely, so no business tools were called.");
        }
        if (queryPlan.ambiguity.type !== "none" && queryPlan.ambiguity.type !== "entity_resolution_required") {
          throw new PlanningError(
            queryPlan.ambiguity.details || "The request needs clarification before a safe lookup can be made.",
            "AMBIGUOUS_QUERY"
          );
        }
        const plan = planBusinessGoal(parsedGoal, queryPlan, timezone);
        session.plan = plan;
        this.traces.append(runId, "PLAN_CREATED", {
          resultStatus: "SUCCESS",
          details: {
            ...toUiPlan(plan)
          }
        });
        const orchestrator = new ControlledAgentOrchestrator(async (call, context) => {
          const result = await this.executePlannedCall(call, context, workflow);
          observations.push({ tool: call.tool, action: call.action, params: call.params, result });
          return result;
        });
        const run = await orchestrator.run(parsedGoal, { runId, goalId, orgId, userId }, plan);
        const report = buildEvidenceReport(observations, queryPlan.sources);
        const generated = run.status === "completed" && report.bundle.sufficiency === "SUPPORTED" && this.parser.generateGroundedAnswer
          ? await this.parser.generateGroundedAnswer(goal, report.bundle)
          : undefined;
        const groundedAnswer = validateGroundedAnswer(
          generated?.kind === "generated" ? generated.candidate : undefined,
          report.bundle,
          report.FACT,
          generated?.kind === "unavailable" ? generated.reason : "not_generated"
        );
        const result = this.buildResult(runId, orgId, run.status, groundedAnswer.answer, observations,
          workflow.list(), plan, run.status === "failed" ? this.failureFor(run.error, observations) : undefined,
          session.queryPlan, report, groundedAnswer);
        this.traces.finishRun(runId, result.status === "completed" ? "COMPLETED" : "FAILED", result.error?.message);
        session.finalResult = this.withTrace(result);
        observations.length = 0;
        return session.finalResult;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Agent execution failed.";
        const planningError = error instanceof PlanningError ? error : undefined;
        this.traces.finishRun(runId, "FAILED", message);
        const answer = planningError?.code === "AMBIGUOUS_QUERY"
          ? "I need more information to safely identify the requested person or company before checking connected business data."
          : planningError
            ? "I couldn't safely create a tool plan for that request. Please clarify the requested entity, criteria, or time range."
            : "Insufficient evidence to determine the requested result.";
        const report = buildEvidenceReport(observations, session.queryPlan?.sources ?? []);
        const groundedAnswer = validateGroundedAnswer(undefined, report.bundle, report.FACT, "not_generated");
        const result = this.buildResult(runId, orgId, "failed", groundedAnswer.answer, observations, workflow.list(), session.plan, {
          code: planningError?.code ?? "AGENT_FAILURE", message
        }, session.queryPlan, report, groundedAnswer);
        session.finalResult = this.withTrace(result);
        observations.length = 0;
        return session.finalResult;
      }
    };

    session.completion = complete();
    const first = await Promise.race([
      proposalReady.then((proposal) => ({ kind: "proposal" as const, proposal })),
      session.completion.then((result) => ({ kind: "result" as const, result }))
    ]);
    if (first.kind === "result") return first.result;
    return this.buildResult(runId, orgId, "awaiting_approval", "An action has been proposed and is awaiting approval.", observations, workflow.list(), session.plan, undefined, session.queryPlan);
  }

  async getRun(runId: string, orgId: string, userId: string): Promise<ManageBizzRunResult | undefined> {
    const session = this.sessions.get(runId);
    if (!session || session.orgId !== orgId || session.userId !== userId) return undefined;
    if (session.finalResult) return this.withTrace(session.finalResult);
    const pending = session.workflow.list().some(({ lifecycle }) => lifecycle === "PROPOSED");
    return this.buildResult(runId, orgId, pending ? "awaiting_approval" : "running", pending
      ? "An action has been proposed and is awaiting approval."
      : "The agent run is in progress.", session.observations, session.workflow.list(), session.plan, undefined, session.queryPlan);
  }

  async decideAction(
    runId: string,
    orgId: string,
    userId: string,
    proposalId: string,
    decision: "APPROVE" | "REJECT" | "MODIFY",
    decidedById: string,
    feedback?: string
  ): Promise<ManageBizzRunResult | undefined> {
    const session = this.sessions.get(runId);
    if (!session || session.orgId !== orgId || session.userId !== userId) return undefined;
    const priorProposalCount = session.proposalCount;
    const accepted = await session.workflow.decide(proposalId, decision, decidedById, feedback);
    if (!accepted) return undefined;
    const next = await Promise.race([
      session.completion.then((result) => ({ kind: "complete" as const, result })),
      waitForProposalAfter(session, priorProposalCount).then(() => ({ kind: "proposal" as const }))
    ]);
    if (next.kind === "complete") return next.result;
    return this.buildResult(runId, orgId, "awaiting_approval", "The previous action was processed. The next proposed action is awaiting approval.", session.observations, session.workflow.list(), session.plan, undefined, session.queryPlan);
  }

  private async executePlannedCall(call: PlannedToolCall, context: ToolExecutionContext, workflow: ApprovalActionWorkflow): Promise<ToolResponse> {
    const execute = (executionContext: ToolExecutionContext = context) => this.traces.traceToolCall({
      runId: context.runId, toolName: call.tool, action: call.action, input: call.params,
      execute: () => this.executeTool(call, executionContext)
    });
    return ACTION_TOOL_ACTIONS[call.tool]?.includes(call.action)
      ? workflow.proposeExecuteVerify(call, context, execute)
      : execute();
  }

  private traceActionLifecycle(runId: string, proposal: ActionProposal): void {
    if (proposal.lifecycle === "PROPOSED") {
      this.traces.append(runId, "ACTION_PROPOSED", {
        toolName: proposal.tool, action: proposal.action, input: proposal.params, resultStatus: "PENDING",
        details: { proposalId: proposal.id, riskLevel: proposal.riskLevel }
      });
    } else if (proposal.lifecycle === "APPROVED") {
      this.traces.append(runId, "ACTION_APPROVED", {
        toolName: proposal.tool, action: proposal.action, resultStatus: "SUCCESS", details: { proposalId: proposal.id }
      });
    } else if (proposal.lifecycle === "REJECTED") {
      this.traces.append(runId, "ACTION_REJECTED", {
        toolName: proposal.tool, action: proposal.action, resultStatus: "FAILED", details: { proposalId: proposal.id }
      });
    } else if (proposal.lifecycle === "EXECUTED") {
      this.traces.append(runId, "ACTION_EXECUTED", {
        toolName: proposal.tool, action: proposal.action, resultStatus: "SUCCESS", details: { proposalId: proposal.id }
      });
    } else if (proposal.lifecycle === "VERIFIED" || proposal.lifecycle === "VERIFICATION_FAILED") {
      this.traces.append(runId, "ACTION_VERIFIED", {
        toolName: proposal.tool, action: proposal.action,
        resultStatus: proposal.lifecycle === "VERIFIED" ? "SUCCESS" : "FAILED",
        details: { proposalId: proposal.id, verification: proposal.lifecycle }
      });
    }
  }

  private failureFor(error: string | undefined, observations: readonly ToolObservation[]): { code: string; message: string } {
    const toolError = observations.find(({ result }) => !result.success);
    return toolError && !toolError.result.success
      ? { code: toolError.result.error.code, message: toolError.result.error.message }
      : { code: "AGENT_FAILURE", message: error ?? "The agent run failed." };
  }

  private buildResult(
    runId: string,
    orgId: string,
    status: ManageBizzRunStatus,
    answer: string,
    observations: readonly ToolObservation[],
    actions: ActionProposal[],
    plan?: InvestigationPlan,
    error?: { code: string; message: string },
    queryPlan?: AgentPlan,
    reportOverride?: ReturnType<typeof buildEvidenceReport>,
    groundedAnswer?: GroundedAnswer
  ): ManageBizzRunResult {
    const report = reportOverride ?? buildEvidenceReport(observations, queryPlan?.sources ?? []);
    const trace = this.traces.getRunTrace(runId, orgId)!;
    const summary = groundedAnswer?.answer ?? (report.structuredResult
      ? structuredCRMResultSummary(report.structuredResult, answer)
      : structuredSummary(answer, observations));
    return {
      runId, status, answer: summary,
      response: {
        summary,
        facts: report.FACT,
        inferences: report.INFERENCE,
        recommendations: groundedAnswer?.recommendations ?? [],
        evidenceInsufficient: report.evidenceInsufficient,
        ...(groundedAnswer ? { groundedAnswer } : {}),
        limitations: groundedAnswer?.limitations ?? report.bundle.limitations
      },
      ...(report.structuredResult ? { structuredResult: report.structuredResult } : {}),
      plan: toUiPlan(plan),
      ...(queryPlan ? { queryPlan } : {}),
      evidence: { facts: report.FACT, inferences: report.INFERENCE, evidenceInsufficient: report.evidenceInsufficient, bundle: report.bundle },
      ...(groundedAnswer ? { groundedAnswer } : {}),
      recommendations: groundedAnswer?.recommendations ?? [],
      actions,
      trace,
      ...(error ? { error } : {})
    };
  }

  private withTrace(result: ManageBizzRunResult): ManageBizzRunResult {
    return { ...result, trace: this.traces.getRunTrace(result.runId, result.trace.orgId) ?? result.trace };
  }
}

function toUiPlan(plan?: InvestigationPlan): ManageBizzRunResult["plan"] {
  if (!plan) return { objective: "", factsRequired: [], steps: [] };
  const steps: Array<PlannedToolCall & { dependsOnCRMResults: boolean }> = [
    ...plan.initialCalls.map((call) => ({ ...call, dependsOnCRMResults: false })),
    ...(plan.dependentCalls ?? []).map((call) => ({ ...call, dependsOnCRMResults: true }))
  ];
  const downstream = plan.downstream;
  if (downstream.emailHistoryForCandidates) steps.push({ tool: "email", action: downstream.emailAction, params: {}, purpose: "Inspect email history for CRM-matched candidates.", dependsOnCRMResults: true });
  if (downstream.calendarAvailabilityForCandidates) steps.push({ tool: "calendar", action: "getAvailability", params: {}, purpose: "Check availability for CRM-matched candidates.", dependsOnCRMResults: true });
  if (downstream.createFollowUpTasksForCandidates) steps.push({ tool: "tasks", action: "createTask", params: {}, purpose: "Propose follow-up tasks for CRM-matched candidates; approval is required.", dependsOnCRMResults: true });
  if (downstream.sendFollowUpForCandidates) {
    steps.push({ tool: "email", action: "draftEmail", params: {}, purpose: "Prepare follow-up drafts for CRM-matched candidates; approval is required.", dependsOnCRMResults: true });
    steps.push({ tool: "email", action: "sendEmail", params: {}, purpose: "Send approved follow-up drafts and verify the result.", dependsOnCRMResults: true });
  }
  return {
    objective: plan.objective,
    factsRequired: plan.factsRequired,
    steps: steps.map(({ tool, action, purpose, dependsOnCRMResults }) => ({ tool, action, purpose, dependsOnCRMResults }))
  };
}

function structuredCRMResultSummary(result: AgentStructuredResult, answer: string): string {
  if (result.count === 0) return "No CRM records matched the requested criteria.";
  if (result.omittedCount === result.count) {
    return `CRM returned ${result.count} record(s), but none had valid displayable fields.`;
  }
  const singular = result.title === "Inactive high-value leads" ? "inactive high-value lead"
    : result.title === "Active high-value leads" ? "active high-value lead"
      : result.title === "High-value leads" ? "high-value lead" : "CRM record";
  const plural = result.count === 1 ? singular : `${singular}s`;
  const omitted = result.omittedCount > 0
    ? ` ${result.omittedCount} record(s) could not be displayed because their fields were invalid.`
    : "";
  const truncated = result.truncatedCount > 0
    ? ` ${result.truncatedCount} additional matching record(s) are not shown due to the display limit.`
    : "";
  const actionFact = answer.split("\n").map((line) => line.trim()).find((line) =>
    /^FACT:/i.test(line) && /\b(Created task|Completed task|tasks\.(?:createTask|completeTask)|no successful task action was confirmed|task tool result could not be verified|proposed .* action was rejected)\b/i.test(line));
  const actionSummary = actionFact
    ? ` ${actionFact.replace(/^FACT:\s*/i, "").replace(/\s*\[evidence:.*$/i, "")}`
    : "";
  return `Found ${result.count} matching ${plural}.${omitted}${truncated}${actionSummary}`;
}

function structuredSummary(answer: string, observations: readonly ToolObservation[]): string {
  const lines = answer.split("\n").map((line) => line.trim()).filter(Boolean);
  const actionFact = [...lines].reverse().find((line) =>
    /^FACT:/i.test(line) &&
    /\b(Created task|Completed task|Created Gmail draft|Sent Gmail message|Created calendar event|createTask failed|completeTask failed|draftEmail failed|sendEmail failed|createMeeting failed|action was rejected|could not be verified|no successful action was confirmed)\b/i.test(line));
  const first = actionFact ?? lines.find((line) => !/^(INFERENCE|RECOMMENDATION):/i.test(line));
  if (!first) return "Insufficient evidence to determine the requested result.";
  // Deterministic evidence reports list every matching record in answer. Keep
  // the overview concise; the structured evidence panel contains the records.
  if (/^FACT:\s*CRM returned \d+ matching/i.test(first)) return first.replace(/^FACT:\s*/, "").replace(/\s*\[evidence:.*$/, "");
  if (observations.length === 0 && /^FACT:/i.test(first)) return first.replace(/^FACT:\s*/, "");
  return first.replace(/^FACT:\s*/, "");
}

function waitForProposalAfter(session: Session, previousCount: number): Promise<void> {
  if (session.proposalCount > previousCount) return Promise.resolve();
  return new Promise((resolve) => session.proposalWaiters.push({ after: previousCount, resolve }));
}

export const manageBizzAgentApi = new ManageBizzAgentApi();
