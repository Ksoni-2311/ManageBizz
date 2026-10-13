import { createHash } from "node:crypto";
import { ApprovalStatus, RiskLevel, ToolExecutionContext, ToolResponse } from "@nexusops/shared-types";
import { ACTION_TOOL_ACTIONS } from "../../tools/index.js";
import { verifiedActionStatement } from "../policies/dataIntegrity.js";
import { PolicyEngine } from "../policies/policyEngine.js";
import type { PlannedToolCall } from "./controlledOrchestrator.js";

export type ApprovalLifecycle =
  | "PROPOSED" | "APPROVED" | "REJECTED" | "EXECUTING" | "EXECUTED" | "FAILED" | "EXPIRED"
  | "VERIFYING" | "VERIFIED" | "VERIFICATION_FAILED";

export type ActionProposal = {
  id: string;
  runId: string;
  goalId: string;
  stepId: string;
  actionType: string;
  tool: string;
  action: string;
  target?: { description: string; identityRef?: string };
  params: Record<string, unknown>;
  rationale: string;
  evidenceRefs: string[];
  expectedOutcome: string;
  requiredPermissions: string[];
  approvalRequired: true;
  createdAt: string;
  expiresAt: string;
  paramsFingerprint: string;
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
const APPROVAL_TTL_MS = 5 * 60 * 1_000;

function fingerprint(params: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(params)).digest("hex");
}

function targetFor(call: PlannedToolCall): ActionProposal["target"] {
  const target = call.params.to ?? call.params.leadId ?? call.params.draftId ?? call.params.title ?? call.params.taskId;
  return typeof target === "string" && target.trim()
    ? { description: target.trim().slice(0, 300) }
    : undefined;
}

function expectedOutcomeFor(call: PlannedToolCall): string {
  if (call.tool === "email" && call.action === "draftEmail") return "A Gmail draft with the exact previewed recipient, subject, and body is created; it is not sent.";
  if (call.tool === "email" && call.action === "sendEmail") return "The exact existing Gmail draft shown in the preview is sent.";
  if (call.tool === "calendar" && call.action === "createMeeting") return "The calendar event with the exact previewed time and attendees is created.";
  if (call.tool === "crm" && call.action === "updateLead") return "Only the explicitly listed CRM fields on the identified lead are updated.";
  if (call.tool === "crm" && call.action === "addLeadNote") return "The exact note shown in the preview is added to the identified CRM lead.";
  if (call.tool === "tasks" && call.action === "completeTask") return "The identified task is marked complete.";
  if (call.tool === "tasks" && call.action === "createTask") return "The previewed task is created.";
  return `The requested ${call.tool}.${call.action} mutation is completed and verified.`;
}

function permissionsFor(call: PlannedToolCall): string[] {
  if (call.tool === "email") return ["gmail.modify"];
  if (call.tool === "calendar") return ["calendar.events"];
  if (call.tool === "crm") return ["crm.write"];
  return ["tasks.write"];
}

/** Per-run in-memory PLAN → APPROVAL → EXECUTE → VERIFY lifecycle for mutations. */
export class ApprovalActionWorkflow {
  private readonly proposals = new Map<string, ActionProposal>();
  private readonly decisions = new Map<string, (decision: Decision) => void>();

  constructor(private readonly options: ApprovalWorkflowOptions = {}) {}

  list(): ActionProposal[] {
    return [...this.proposals.values()].map((proposal) => structuredClone(proposal));
  }

  async decide(idOrStepId: string, decision: "APPROVE" | "REJECT" | "MODIFY", decidedById: string, feedback?: string): Promise<boolean> {
    const proposal = this.proposals.get(idOrStepId);
    if (!proposal || proposal.lifecycle !== "PROPOSED" || proposal.approvalStatus !== ApprovalStatus.PENDING) return false;
    const resolver = this.decisions.get(proposal.id);
    if (!resolver) return false;
    if (Date.now() >= Date.parse(proposal.expiresAt)) {
      proposal.lifecycle = "EXPIRED";
      proposal.feedback = "This proposal expired; submit the action again for a fresh preview.";
      this.decisions.delete(proposal.id);
      await this.options.onUpdate?.(structuredClone(proposal));
      resolver({ approved: false, decidedById, feedback: proposal.feedback });
      return false;
    }
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

    const rawTarget = call.target ?? targetFor(call);
    const target = rawTarget
      ? {
        ...rawTarget,
        ...(!rawTarget.identityRef ? { identityRef: createHash("sha256").update(rawTarget.description).digest("hex") } : {})
      }
      : undefined;
    const proposal: ActionProposal = {
      id: `${context.runId}:approval:${context.actionId}`,
      runId: context.runId,
      goalId: context.goalId,
      stepId: context.actionId,
      actionType: `${call.tool}.${call.action}`,
      tool: call.tool,
      action: call.action,
      ...(target ? { target } : {}),
      params: structuredClone(call.params),
      rationale: call.purpose,
      evidenceRefs: call.evidenceRefs ?? [],
      expectedOutcome: expectedOutcomeFor(call),
      requiredPermissions: permissionsFor(call),
      approvalRequired: true,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + APPROVAL_TTL_MS).toISOString(),
      paramsFingerprint: fingerprint(call.params),
      riskLevel,
      approvalStatus: ApprovalStatus.PENDING,
      lifecycle: "PROPOSED",
      proposedAt: new Date().toISOString(),
      verification: "PENDING"
    };
    this.proposals.set(proposal.id, proposal);
    const decisionPromise = new Promise<Decision>((resolve) => this.decisions.set(proposal.id, resolve));
    const expiryTimer = setTimeout(() => {
      if (proposal.lifecycle !== "PROPOSED") return;
      const resolve = this.decisions.get(proposal.id);
      proposal.lifecycle = "EXPIRED";
      proposal.feedback = "This proposal expired; submit the action again for a fresh preview.";
      this.decisions.delete(proposal.id);
      void this.options.onUpdate?.(structuredClone(proposal));
      resolve?.({ approved: false, decidedById: "", feedback: proposal.feedback });
    }, APPROVAL_TTL_MS);
    await this.options.onUpdate?.(structuredClone(proposal));
    let decision: Decision;
    try {
      decision = await decisionPromise;
    } finally {
      clearTimeout(expiryTimer);
    }
    if (!decision.approved) {
      proposal.lifecycle = "REJECTED";
      const failure: ToolResponse = { success: false, error: { code: "APPROVAL_REJECTED", message: "The proposed action was rejected; no action was executed." } };
      proposal.result = failure;
      return failure;
    }

    if (Date.now() >= Date.parse(proposal.expiresAt) || fingerprint(proposal.params) !== proposal.paramsFingerprint ||
        fingerprint(call.params) !== proposal.paramsFingerprint) {
      proposal.lifecycle = Date.now() >= Date.parse(proposal.expiresAt) ? "EXPIRED" : "REJECTED";
      proposal.feedback = proposal.lifecycle === "EXPIRED"
        ? "This proposal expired before execution; no action was performed."
        : "The approved parameters changed; no action was performed.";
      proposal.result = { success: false, error: { code: proposal.lifecycle, message: proposal.feedback } };
      await this.options.onUpdate?.(structuredClone(proposal));
      return proposal.result;
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
