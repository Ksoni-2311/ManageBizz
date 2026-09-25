import { AgentState } from "@nexusops/shared-types";
import { AgentRunModel } from "../../models/AgentRun.js";
import { AuditLogModel } from "../../models/AuditLog.js";
import { SocketManager } from "../../sockets/socketManager.js";

export class AgentStateMachine {
  private runId: string;
  private goalId: string;
  private orgId: string;
  private userId: string;
  private currentState: AgentState;

  constructor(runId: string, goalId: string, orgId: string, userId: string, initialState: AgentState = AgentState.IDLE) {
    this.runId = runId;
    this.goalId = goalId;
    this.orgId = orgId;
    this.userId = userId;
    this.currentState = initialState;
  }

  public getCurrentState(): AgentState {
    return this.currentState;
  }

  public async transitionTo(newState: AgentState, reason?: string, metadata?: Record<string, unknown>): Promise<void> {
    const previousState = this.currentState;
    this.currentState = newState;

    console.log(`[AgentStateMachine] Run ${this.runId}: ${previousState} ──> ${newState} (${reason || "No reason specified"})`);

    // 1. Update AgentRun DB Record
    try {
      await AgentRunModel.findOneAndUpdate({ _id: this.runId, orgId: this.orgId, userId: this.userId }, {
        currentState: newState,
        $push: {
          stateHistory: {
            fromState: previousState,
            toState: newState,
            timestamp: new Date(),
            reason,
            metadata
          }
        },
        ...(newState === AgentState.COMPLETED || newState === AgentState.FAILED || newState === AgentState.CANCELLED
          ? { endedAt: new Date() }
          : {})
      });
    } catch {
      // Mock mode fallback
    }

    // 2. Log Audit Event
    try {
      await AuditLogModel.create({
        orgId: this.orgId,
        userId: this.userId,
        goalId: this.goalId,
        runId: this.runId,
        eventType: "AGENT_STATE_CHANGED",
        details: { fromState: previousState, toState: newState, reason, metadata },
        timestamp: new Date()
      });
    } catch {
      // Mock mode fallback
    }

    // 3. Emit Socket.IO Event
    SocketManager.emitEvent("agent.state.changed", {
      runId: this.runId,
      goalId: this.goalId,
      fromState: previousState,
      toState: newState,
      reason,
      timestamp: new Date().toISOString()
    });
  }
}
