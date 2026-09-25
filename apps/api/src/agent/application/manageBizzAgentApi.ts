import { randomUUID } from "node:crypto";
import { ParsedGoal, ToolExecutionContext, ToolResponse } from "@nexusops/shared-types";
import { ToolOrchestrator, ACTION_TOOL_ACTIONS } from "../../tools/index.js";
import { buildEvidenceReport, ToolObservation } from "../policies/dataIntegrity.js";
import { ApprovalActionWorkflow, ActionProposal } from "../runtime/approvalWorkflow.js";
import { ControlledAgentOrchestrator, PlannedToolCall, planBusinessGoal } from "../runtime/controlledOrchestrator.js";
import { RunTraceRecord, RunTraceStore, runTraceStore } from "../runtime/runTrace.js";
import { MockLLMProvider } from "../llm/unifiedLLM.js";

export type ManageBizzRunStatus = "running" | "awaiting_approval" | "completed" | "failed";
export type ManageBizzRunResult = {
  runId: string;
  status: ManageBizzRunStatus;
  answer: string;
  evidence: { facts: AgentEvidenceFact[]; inferences: string[]; evidenceInsufficient: boolean };
  recommendations: Array<{ statement: string; evidenceRefs: string[] }>;
  actions: ActionProposal[];
  trace: RunTraceRecord;
  error?: { code: string; message: string };
};
type AgentEvidenceFact = ReturnType<typeof buildEvidenceReport>["FACT"][number];
export type ManageBizzRunInput = { goal: string; orgId: string; userId: string };
type GoalParser = { parseGoal(goal: string): Promise<ParsedGoal> };
type Session = {
  orgId: string;
  userId: string;
  workflow: ApprovalActionWorkflow;
  observations: ToolObservation[];
  completion: Promise<ManageBizzRunResult>;
  proposalReady: Promise<ActionProposal>;
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
    private readonly parser: GoalParser = new MockLLMProvider(),
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
    const workflow = new ApprovalActionWorkflow({ onUpdate: async (proposal) => {
      this.traceActionLifecycle(runId, proposal);
      if (proposal.lifecycle === "PROPOSED") resolveProposal(proposal);
    } });

    const session = {} as Session;
    Object.assign(session, { orgId, userId, workflow, observations, proposalReady, resolveProposal });
    this.sessions.set(runId, session);

    const complete = async (): Promise<ManageBizzRunResult> => {
      try {
        const parsedGoal = await this.parser.parseGoal(goal);
        const plan = planBusinessGoal(parsedGoal);
        this.traces.append(runId, "PLAN_CREATED", {
          resultStatus: "SUCCESS",
          details: { steps: plan.initialCalls.map(({ tool, action }) => ({ tool, action })) }
        });
        const orchestrator = new ControlledAgentOrchestrator(async (call, context) => {
          const result = await this.executePlannedCall(call, context, workflow);
          observations.push({ tool: call.tool, action: call.action, params: call.params, result });
          return result;
        });
        const run = await orchestrator.run(parsedGoal, { runId, goalId, orgId, userId }, plan);
        const result = this.buildResult(runId, orgId, run.status, run.finalText, observations, workflow.list(),
          run.status === "failed" ? this.failureFor(run.error, observations) : undefined);
        this.traces.finishRun(runId, result.status === "completed" ? "COMPLETED" : "FAILED", result.error?.message);
        session.finalResult = this.withTrace(result);
        return session.finalResult;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Agent execution failed.";
        this.traces.finishRun(runId, "FAILED", message);
        const result = this.buildResult(runId, orgId, "failed", "Insufficient evidence to determine the requested result.", observations, workflow.list(), {
          code: "AGENT_FAILURE", message
        });
        session.finalResult = this.withTrace(result);
        return session.finalResult;
      }
    };

    session.completion = complete();
    const first = await Promise.race([
      proposalReady.then((proposal) => ({ kind: "proposal" as const, proposal })),
      session.completion.then((result) => ({ kind: "result" as const, result }))
    ]);
    if (first.kind === "result") return first.result;
    return this.buildResult(runId, orgId, "awaiting_approval", "An action has been proposed and is awaiting approval.", observations, workflow.list());
  }

  async getRun(runId: string, orgId: string, userId: string): Promise<ManageBizzRunResult | undefined> {
    const session = this.sessions.get(runId);
    if (!session || session.orgId !== orgId || session.userId !== userId) return undefined;
    if (session.finalResult) return this.withTrace(session.finalResult);
    const pending = session.workflow.list().some(({ lifecycle }) => lifecycle === "PROPOSED");
    return this.buildResult(runId, orgId, pending ? "awaiting_approval" : "running", pending
      ? "An action has been proposed and is awaiting approval."
      : "The agent run is in progress.", session.observations, session.workflow.list());
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
    const accepted = await session.workflow.decide(proposalId, decision, decidedById, feedback);
    if (!accepted) return undefined;
    return session.completion;
  }

  private async executePlannedCall(call: PlannedToolCall, context: ToolExecutionContext, workflow: ApprovalActionWorkflow): Promise<ToolResponse> {
    const execute = () => this.traces.traceToolCall({
      runId: context.runId, toolName: call.tool, action: call.action, input: call.params,
      execute: () => this.executeTool(call, context)
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
    error?: { code: string; message: string }
  ): ManageBizzRunResult {
    const report = buildEvidenceReport(observations);
    const trace = this.traces.getRunTrace(runId, orgId)!;
    return {
      runId, status, answer,
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

export const manageBizzAgentApi = new ManageBizzAgentApi();
