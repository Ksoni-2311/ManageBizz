import { AgentState, ParsedGoal, StepStatus, ToolExecutionContext } from "@nexusops/shared-types";
import { AgentStateMachine } from "../state/stateMachine.js";
import { getLLMProvider } from "../llm/unifiedLLM.js";
import { ACTION_TOOL_ACTIONS, ToolOrchestrator } from "../../tools/index.js";
import { SocketManager } from "../../sockets/socketManager.js";
import { buildEvidenceReport } from "../policies/dataIntegrity.js";
import { PolicyEngine } from "../policies/policyEngine.js";
import { ControlledAgentOrchestrator, InvestigationPlan, planBusinessGoal, PlannedToolCall } from "./controlledOrchestrator.js";
import { ApprovalActionWorkflow, ActionProposal } from "./approvalWorkflow.js";
import { runTraceStore } from "./runTrace.js";

export class AgentEngine {
  private readonly stateMachine: AgentStateMachine;
  private readonly llmProvider = getLLMProvider();
  private readonly actionWorkflow: ApprovalActionWorkflow;

  constructor(
    private readonly runId: string,
    private readonly goalId: string,
    private readonly orgId: string,
    private readonly userId: string
  ) {
    SocketManager.bindRun(runId, orgId);
    this.stateMachine = new AgentStateMachine(runId, goalId, orgId, userId);
    this.actionWorkflow = new ApprovalActionWorkflow({ onUpdate: async (proposal) => this.onActionLifecycle(proposal) });
  }

  public async startExecution(rawPrompt: string): Promise<void> {
    let traceStarted = false;
    try {
      runTraceStore.startRun({ runId: this.runId, goalId: this.goalId, orgId: this.orgId, userId: this.userId });
      traceStarted = true;
      await this.stateMachine.transitionTo(AgentState.GOAL_RECEIVED, "Goal prompt received");
      const parsedGoal = await this.llmProvider.parseGoal(rawPrompt);
      await this.stateMachine.transitionTo(AgentState.GOAL_PARSED, "Goal parsed into structured specifications", { parsedGoal });
      await this.stateMachine.transitionTo(AgentState.OBSERVING, "Preparing a tool-backed investigation");
      await this.stateMachine.transitionTo(AgentState.ANALYZING, "Mapping required facts to business tools");
      await this.stateMachine.transitionTo(AgentState.PLANNING, "Building a result-gated investigation plan");

      const plan = planBusinessGoal(parsedGoal);
      this.emitPlan(plan, parsedGoal);
      const orchestrator = new ControlledAgentOrchestrator(async (call, context) => this.executeToolCall(call, context));
      const baseContext = { goalId: this.goalId, runId: this.runId, userId: this.userId, orgId: this.orgId };
      const run = await orchestrator.run(parsedGoal, baseContext, plan);

      const report = buildEvidenceReport(run.observations);
      SocketManager.emitEvent("agent.report", { runId: this.runId, goalId: this.goalId, report, finalText: run.finalText });

      if (run.status === "completed") {
        await this.stateMachine.transitionTo(AgentState.VERIFYING, "Checking final text against tool evidence");
        await this.stateMachine.transitionTo(AgentState.COMPLETED, "Investigation completed from the recorded tool results.", {
          toolCallCount: run.observations.length
        });
        SocketManager.emitEvent("agent.goal.completed", {
          runId: this.runId,
          goalId: this.goalId,
          completedAt: new Date().toISOString(),
          toolCallCount: run.observations.length,
          finalText: run.finalText,
          report
        });
        runTraceStore.finishRun(this.runId, "COMPLETED");
      } else {
        const error = run.error ?? "Investigation did not complete.";
        await this.stateMachine.transitionTo(AgentState.FAILED, error, { toolCallCount: run.observations.length });
        SocketManager.emitEvent("agent.goal.failed", {
          runId: this.runId, goalId: this.goalId, error, finalText: run.finalText, report
        });
        runTraceStore.finishRun(this.runId, "FAILED", error);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Agent execution failed.";
      console.error(`[AgentEngine] Run ${this.runId} failed:`, message);
      await this.stateMachine.transitionTo(AgentState.FAILED, message);
      SocketManager.emitEvent("agent.goal.failed", { runId: this.runId, goalId: this.goalId, error: message });
      if (traceStarted) runTraceStore.finishRun(this.runId, "FAILED", message);
    } finally {
      SocketManager.releaseRun(this.runId);
    }
  }

  public async resumeAfterApproval(
    stepId: string,
    decision: "APPROVE" | "REJECT" | "MODIFY",
    feedback?: string,
    decidedById = "unknown"
  ): Promise<boolean> {
    return this.actionWorkflow.decide(stepId, decision, decidedById, feedback);
  }

  public getApprovalProposals(): ActionProposal[] {
    return this.actionWorkflow.list();
  }

  private async executeToolCall(call: PlannedToolCall, context: ToolExecutionContext) {
    if (ACTION_TOOL_ACTIONS[call.tool]?.includes(call.action)) {
      return this.actionWorkflow.proposeExecuteVerify(call, context, () => this.executeApprovedAction(call, context));
    }
    return this.executeApprovedAction(call, context);
  }

  private async executeApprovedAction(call: PlannedToolCall, context: ToolExecutionContext) {
    await this.stateMachine.transitionTo(AgentState.EXECUTING, `Investigating with ${call.tool}.${call.action}`, {
      actionId: context.actionId,
      purpose: call.purpose
    });
    SocketManager.emitEvent("agent.action.started", {
      runId: this.runId, actionId: context.actionId, tool: call.tool, action: call.action
    });

    const result = await runTraceStore.traceToolCall({
      runId: this.runId,
      toolName: call.tool,
      action: call.action,
      input: call.params,
      execute: () => ToolOrchestrator.executeToolCall(call.tool, call.action, call.params, context)
    });
    if (result.success) {
      SocketManager.emitEvent("agent.action.executed", {
        runId: this.runId, actionId: context.actionId, tool: call.tool, action: call.action, result: result.data
      });
    } else {
      SocketManager.emitEvent("agent.action.failed", {
        runId: this.runId, actionId: context.actionId, tool: call.tool, action: call.action, error: result.error
      });
    }
    return result;
  }

  private async onActionLifecycle(proposal: ActionProposal): Promise<void> {
    SocketManager.emitEvent("agent.action.lifecycle", { runId: this.runId, goalId: this.goalId, proposal });
    if (proposal.lifecycle === "PROPOSED") {
      runTraceStore.append(this.runId, "ACTION_PROPOSED", {
        toolName: proposal.tool, action: proposal.action, input: proposal.params, resultStatus: "PENDING",
        details: { approvalId: proposal.id, riskLevel: proposal.riskLevel }
      });
      await this.stateMachine.transitionTo(AgentState.RISK_CHECK, "Mutation proposed; approval is required before execution", {
        approvalId: proposal.id, actionId: proposal.stepId, riskLevel: proposal.riskLevel
      });
      await this.stateMachine.transitionTo(AgentState.WAITING_FOR_APPROVAL, "Waiting for an explicit approval decision", {
        approvalId: proposal.id, actionId: proposal.stepId
      });
      SocketManager.emitEvent("agent.action.proposed", { runId: this.runId, goalId: this.goalId, proposal });
    } else if (proposal.lifecycle === "APPROVED") {
      runTraceStore.append(this.runId, "ACTION_APPROVED", {
        toolName: proposal.tool, action: proposal.action, resultStatus: "SUCCESS",
        details: { approvalId: proposal.id }
      });
      SocketManager.emitEvent("agent.action.approval.updated", { runId: this.runId, goalId: this.goalId, proposal });
    } else if (proposal.lifecycle === "REJECTED") {
      runTraceStore.append(this.runId, "ACTION_REJECTED", {
        toolName: proposal.tool, action: proposal.action, resultStatus: "FAILED", details: { approvalId: proposal.id }
      });
    } else if (proposal.lifecycle === "EXECUTING") {
      await this.stateMachine.transitionTo(AgentState.EXECUTING, "Approved action is executing", { approvalId: proposal.id, actionId: proposal.stepId });
    } else if (proposal.lifecycle === "EXECUTED") {
      runTraceStore.append(this.runId, "ACTION_EXECUTED", {
        toolName: proposal.tool, action: proposal.action, resultStatus: "SUCCESS", details: { approvalId: proposal.id }
      });
    } else if (proposal.lifecycle === "VERIFYING") {
      await this.stateMachine.transitionTo(AgentState.VERIFYING, "Verifying the action tool result", { approvalId: proposal.id, actionId: proposal.stepId });
    }
    if (proposal.lifecycle === "VERIFIED") {
      runTraceStore.append(this.runId, "ACTION_VERIFIED", {
        toolName: proposal.tool, action: proposal.action, resultStatus: "SUCCESS", details: { approvalId: proposal.id, verification: "VERIFIED" }
      });
      SocketManager.emitEvent("agent.action.verified", { runId: this.runId, goalId: this.goalId, proposal });
    } else if (proposal.lifecycle === "VERIFICATION_FAILED") {
      runTraceStore.append(this.runId, "ACTION_VERIFIED", {
        toolName: proposal.tool, action: proposal.action, resultStatus: "FAILED", details: { approvalId: proposal.id, verification: "FAILED" }
      });
      SocketManager.emitEvent("agent.action.verification_failed", { runId: this.runId, goalId: this.goalId, proposal });
    } else if (proposal.lifecycle === "REJECTED" || proposal.lifecycle === "FAILED") {
      SocketManager.emitEvent("agent.action.lifecycle.failed", { runId: this.runId, goalId: this.goalId, proposal });
    }
  }

  private emitPlan(plan: InvestigationPlan, parsedGoal: ParsedGoal): void {
    const steps = plan.initialCalls.map((call, index) => this.toPlanStep(call, index + 1));
    SocketManager.emitEvent("agent.plan.created", {
      runId: this.runId,
      goalId: this.goalId,
      objective: plan.objective,
      factsRequired: plan.factsRequired,
      toolMappings: plan.toolMappings,
      gatedFollowUps: plan.downstream,
      finalEvidence: plan.finalEvidence,
      timeWindowDays: parsedGoal.timeWindowDays,
      stepsCount: steps.length,
      steps
    });
    runTraceStore.append(this.runId, "PLAN_CREATED", {
      resultStatus: "SUCCESS",
      details: { steps: steps.map(({ tool, action, riskLevel, requiresApproval }) => ({ tool, action, riskLevel, requiresApproval })) }
    });
  }

  private toPlanStep(call: PlannedToolCall, stepNumber: number) {
    const riskLevel = PolicyEngine.classifyRisk(call.tool, call.action, call.params);
    return {
      id: `${this.runId}:plan:${stepNumber}`,
      actionId: `${this.runId}:investigation:${stepNumber}`,
      stepNumber,
      tool: call.tool,
      action: call.action,
      params: call.params,
      riskLevel,
      requiresApproval: PolicyEngine.requiresApproval(riskLevel),
      reasoning: call.purpose,
      status: StepStatus.PENDING
    };
  }
}
