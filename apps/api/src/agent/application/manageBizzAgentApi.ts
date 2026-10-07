import { randomUUID } from "node:crypto";
import { ParsedGoal, ToolExecutionContext, ToolResponse } from "@nexusops/shared-types";
import { ToolOrchestrator, ACTION_TOOL_ACTIONS } from "../../tools/index.js";
import { buildEvidenceReport, ToolObservation } from "../policies/dataIntegrity.js";
import { ApprovalActionWorkflow, ActionProposal } from "../runtime/approvalWorkflow.js";
import { ControlledAgentOrchestrator, type InvestigationPlan, type PlannedToolCall, planBusinessGoal } from "../runtime/controlledOrchestrator.js";
import { RunTraceRecord, RunTraceStore, runTraceStore } from "../runtime/runTrace.js";
import { getLLMProvider } from "../llm/unifiedLLM.js";

export type ManageBizzRunStatus = "running" | "awaiting_approval" | "completed" | "failed";
export type ManageBizzRunResult = {
  runId: string;
  status: ManageBizzRunStatus;
  answer: string;
  response: {
    summary: string;
    facts: AgentEvidenceFact[];
    inferences: string[];
    recommendations: Array<{ statement: string; evidenceRefs: string[] }>;
    evidenceInsufficient: boolean;
  };
  plan: { objective: string; factsRequired: string[]; steps: Array<{ tool: string; action: string; purpose: string; dependsOnCRMResults: boolean }> };
  evidence: { facts: AgentEvidenceFact[]; inferences: string[]; evidenceInsufficient: boolean };
  recommendations: Array<{ statement: string; evidenceRefs: string[] }>;
  actions: ActionProposal[];
  trace: RunTraceRecord;
  error?: { code: string; message: string };
};
type AgentEvidenceFact = ReturnType<typeof buildEvidenceReport>["FACT"][number];
export type ManageBizzRunInput = { goal: string; orgId: string; userId: string };
type GoalParser = {
  parseGoal(goal: string): Promise<ParsedGoal>;
  planGoal?(goal: ParsedGoal, fallbackPlan: InvestigationPlan): Promise<InvestigationPlan>;
  generateResponse?(goal: string, observations: readonly ToolObservation[], evidenceReport: string): Promise<string>;
};
type Session = {
  orgId: string;
  userId: string;
  workflow: ApprovalActionWorkflow;
  observations: ToolObservation[];
  plan?: InvestigationPlan;
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

  async run({ goal, orgId, userId }: ManageBizzRunInput): Promise<ManageBizzRunResult> {
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
        const fallbackPlan = planBusinessGoal(parsedGoal);
        const plan = this.parser.planGoal ? await this.parser.planGoal(parsedGoal, fallbackPlan) : fallbackPlan;
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
        const answer = run.status === "completed" && this.parser.generateResponse
          ? await this.parser.generateResponse(goal, observations, run.finalText)
          : run.finalText;
        const result = this.buildResult(runId, orgId, run.status, answer, observations, workflow.list(), plan,
          run.status === "failed" ? this.failureFor(run.error, observations) : undefined);
        this.traces.finishRun(runId, result.status === "completed" ? "COMPLETED" : "FAILED", result.error?.message);
        session.finalResult = this.withTrace(result);
        observations.length = 0;
        return session.finalResult;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Agent execution failed.";
        this.traces.finishRun(runId, "FAILED", message);
        const result = this.buildResult(runId, orgId, "failed", "Insufficient evidence to determine the requested result.", observations, workflow.list(), session.plan, {
          code: "AGENT_FAILURE", message
        });
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
    return this.buildResult(runId, orgId, "awaiting_approval", "An action has been proposed and is awaiting approval.", observations, workflow.list(), session.plan);
  }

  async getRun(runId: string, orgId: string, userId: string): Promise<ManageBizzRunResult | undefined> {
    const session = this.sessions.get(runId);
    if (!session || session.orgId !== orgId || session.userId !== userId) return undefined;
    if (session.finalResult) return this.withTrace(session.finalResult);
    const pending = session.workflow.list().some(({ lifecycle }) => lifecycle === "PROPOSED");
    return this.buildResult(runId, orgId, pending ? "awaiting_approval" : "running", pending
      ? "An action has been proposed and is awaiting approval."
      : "The agent run is in progress.", session.observations, session.workflow.list(), session.plan);
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
    return this.buildResult(runId, orgId, "awaiting_approval", "The previous action was processed. The next proposed action is awaiting approval.", session.observations, session.workflow.list(), session.plan);
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
    error?: { code: string; message: string }
  ): ManageBizzRunResult {
    const report = buildEvidenceReport(observations);
    const trace = this.traces.getRunTrace(runId, orgId)!;
    const summary = structuredSummary(answer, observations);
    return {
      runId, status, answer: summary,
      response: {
        summary,
        facts: report.FACT,
        inferences: report.INFERENCE,
        recommendations: report.recommendationEvidence,
        evidenceInsufficient: report.evidenceInsufficient
      },
      plan: toUiPlan(plan),
      evidence: { facts: report.FACT, inferences: report.INFERENCE, evidenceInsufficient: report.evidenceInsufficient },
      recommendations: report.recommendationEvidence,
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

function structuredSummary(answer: string, observations: readonly ToolObservation[]): string {
  const first = answer.split("\n").map((line) => line.trim()).find((line) => line && !/^(INFERENCE|RECOMMENDATION):/i.test(line));
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
