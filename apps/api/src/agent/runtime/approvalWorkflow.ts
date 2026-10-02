import { ApprovalStatus, RiskLevel, ToolExecutionContext, ToolResponse } from "@nexusops/shared-types";
import { ACTION_TOOL_ACTIONS } from "../../tools/index.js";
import { verifiedActionStatement } from "../policies/dataIntegrity.js";
import { PolicyEngine } from "../policies/policyEngine.js";
import type { PlannedToolCall } from "./controlledOrchestrator.js";

export type ApprovalLifecycle =
  | "PROPOSED" | "APPROVED" | "REJECTED" | "EXECUTING" | "EXECUTED" | "FAILED"
  | "VERIFYING" | "VERIFIED" | "VERIFICATION_FAILED";

export type ActionProposal = {
  id: string;
  runId: string;
  goalId: string;
  stepId: string;
  tool: string;
  action: string;
  params: Record<string, unknown>;
  riskLevel: RiskLevel;
  approvalStatus: ApprovalStatus;
  lifecycle: ApprovalLifecycle;
  proposedAt: string;
  decidedAt?: string;
  decidedById?: string;
  feedback?: string;
  result?: ToolResponse;
  verification?: "PENDING" | "VERIFIED" | "FAILED";
};

type Decision = { approved: boolean; decidedById: string; feedback?: string };
type ApprovalWorkflowOptions = { onUpdate?: (proposal: ActionProposal) => void | Promise<void> };

/** Per-run in-memory PLAN → APPROVAL → EXECUTE → VERIFY lifecycle for mutations. */
export class ApprovalActionWorkflow {
  private readonly proposals = new Map<string, ActionProposal>();
  private readonly decisions = new Map<string, (decision: Decision) => void>();

  constructor(private readonly options: ApprovalWorkflowOptions = {}) {}

  list(): ActionProposal[] {
    return [...this.proposals.values()].map((proposal) => structuredClone(proposal));
  }

  async decide(idOrStepId: string, decision: "APPROVE" | "REJECT" | "MODIFY", decidedById: string, feedback?: string): Promise<boolean> {
    const proposal = [...this.proposals.values()].find(({ id, stepId }) => id === idOrStepId || stepId === idOrStepId);
    if (!proposal || proposal.lifecycle !== "PROPOSED" || proposal.approvalStatus !== ApprovalStatus.PENDING) return false;
    const resolver = this.decisions.get(proposal.id);
    if (!resolver) return false;
    if (decision === "MODIFY") {
      proposal.approvalStatus = ApprovalStatus.MODIFIED;
      proposal.lifecycle = "REJECTED";
      proposal.feedback = feedback ?? "Modified actions must be submitted as a new proposal.";
      proposal.decidedById = decidedById;
      proposal.decidedAt = new Date().toISOString();
      this.decisions.delete(proposal.id);
      await this.options.onUpdate?.(structuredClone(proposal));
      resolver({ approved: false, decidedById, feedback: proposal.feedback });
      return true;
    }
    proposal.approvalStatus = decision === "APPROVE" ? ApprovalStatus.APPROVED : ApprovalStatus.REJECTED;
    proposal.lifecycle = decision === "APPROVE" ? "APPROVED" : "REJECTED";
    proposal.decidedById = decidedById;
    proposal.decidedAt = new Date().toISOString();
    if (feedback !== undefined) proposal.feedback = feedback;
    await this.options.onUpdate?.(structuredClone(proposal));
    this.decisions.delete(proposal.id);
    resolver({ approved: decision === "APPROVE", decidedById, ...(feedback === undefined ? {} : { feedback }) });
    return true;
  }

  async proposeExecuteVerify(
    call: PlannedToolCall,
    context: ToolExecutionContext,
  executor: (context?: ToolExecutionContext) => Promise<ToolResponse>
  ): Promise<ToolResponse> {
    const mutation = ACTION_TOOL_ACTIONS[call.tool]?.includes(call.action) ?? false;
    const riskLevel = PolicyEngine.classifyRisk(call.tool, call.action, call.params);
    if (!mutation) return executor(context);

    const proposal: ActionProposal = {
      id: `${context.runId}:approval:${context.actionId}`,
      runId: context.runId,
      goalId: context.goalId,
      stepId: context.actionId,
      tool: call.tool,
      action: call.action,
      params: structuredClone(call.params),
      riskLevel,
      approvalStatus: ApprovalStatus.PENDING,
      lifecycle: "PROPOSED",
      proposedAt: new Date().toISOString(),
      verification: "PENDING"
    };
    this.proposals.set(proposal.id, proposal);
    const decisionPromise = new Promise<Decision>((resolve) => this.decisions.set(proposal.id, resolve));
    await this.options.onUpdate?.(structuredClone(proposal));
    const decision = await decisionPromise;
    if (!decision.approved) {
      proposal.lifecycle = "REJECTED";
      const failure: ToolResponse = { success: false, error: { code: "APPROVAL_REJECTED", message: "The proposed action was rejected; no action was executed." } };
      proposal.result = failure;
      return failure;
    }

    proposal.lifecycle = "EXECUTING";
    await this.options.onUpdate?.(structuredClone(proposal));
    let result: ToolResponse;
    try {
      result = await executor({ ...context, approvedActionId: context.actionId });
    } catch (error) {
      result = {
        success: false,
        error: { code: "ACTION_EXECUTION_ERROR", message: error instanceof Error ? error.message : "Action execution failed." }
      };
    }
    proposal.result = structuredClone(result);
    if (!result.success) {
      proposal.lifecycle = "FAILED";
      proposal.verification = "FAILED";
      await this.options.onUpdate?.(structuredClone(proposal));
      return result;
    }

    proposal.lifecycle = "EXECUTED";
    proposal.verification = "PENDING";
    await this.options.onUpdate?.(structuredClone(proposal));
    proposal.lifecycle = "VERIFYING";
    await this.options.onUpdate?.(structuredClone(proposal));
    const verificationPassed = verifiedActionStatement(call.tool, call.action, result, call.params) !== undefined;
    if (!verificationPassed) {
      proposal.lifecycle = "VERIFICATION_FAILED";
      proposal.verification = "FAILED";
      await this.options.onUpdate?.(structuredClone(proposal));
      return {
        success: false,
        error: { code: "VERIFICATION_FAILED", message: "The action tool returned success, but its result did not verify the requested mutation." },
        ...(result.metadata ? { metadata: result.metadata } : {})
      };
    }

    proposal.lifecycle = "VERIFIED";
    proposal.verification = "VERIFIED";
    await this.options.onUpdate?.(structuredClone(proposal));
    return result;
  }
}
