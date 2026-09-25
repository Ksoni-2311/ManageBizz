import { create } from "zustand";
import { AgentState, PlanStep, ApprovalRequest, RiskLevel, StepStatus } from "@nexusops/shared-types";

export interface TimelineEvent {
  id: string;
  timestamp: string;
  type: "state" | "plan" | "approval" | "action" | "complete" | "error";
  title: string;
  details?: string;
  metadata?: Record<string, unknown>;
}

interface AgentStore {
  activeRunId: string | null;
  activeGoalId: string | null;
  currentState: AgentState;
  rawPrompt: string;
  timeline: TimelineEvent[];
  planSteps: PlanStep[];
  pendingApprovals: ApprovalRequest[];
  metrics: {
    completedGoals: number;
    pendingApprovalsCount: number;
    toolCallsCount: number;
    totalPipelineRecovered: string;
  };

  setActiveRun: (runId: string, goalId: string, prompt: string) => void;
  updateState: (newState: AgentState, reason?: string) => void;
  setPlan: (steps: PlanStep[]) => void;
  addApprovalRequired: (approval: ApprovalRequest) => void;
  resolveApproval: (approvalId: string, decision: "APPROVE" | "REJECT" | "MODIFY") => void;
  addTimelineEvent: (event: Omit<TimelineEvent, "id">) => void;
}

export const useAgentStore = create<AgentStore>((set) => ({
  activeRunId: null,
  activeGoalId: null,
  currentState: AgentState.IDLE,
  rawPrompt: "",
  timeline: [],
  planSteps: [],
  pendingApprovals: [],
  metrics: {
    completedGoals: 12,
    pendingApprovalsCount: 1,
    toolCallsCount: 48,
    totalPipelineRecovered: "$195,000"
  },

  setActiveRun: (runId, goalId, prompt) => set({
    activeRunId: runId,
    activeGoalId: goalId,
    rawPrompt: prompt,
    currentState: AgentState.GOAL_RECEIVED,
    timeline: [
      {
        id: `tl-${Date.now()}`,
        timestamp: new Date().toLocaleTimeString(),
        type: "state",
        title: "Goal Received",
        details: prompt
      }
    ]
  }),

  updateState: (newState, reason) => set((state) => ({
    currentState: newState,
    timeline: [
      ...state.timeline,
      {
        id: `tl-${Date.now()}-${Math.random()}`,
        timestamp: new Date().toLocaleTimeString(),
        type: newState === AgentState.FAILED ? "error" : "state",
        title: `State Transition: ${newState}`,
        details: reason
      }
    ]
  })),

  setPlan: (steps) => set({ planSteps: steps }),

  addApprovalRequired: (approval) => set((state) => ({
    pendingApprovals: [...state.pendingApprovals, approval],
    metrics: {
      ...state.metrics,
      pendingApprovalsCount: state.metrics.pendingApprovalsCount + 1
    }
  })),

  resolveApproval: (approvalId, decision) => set((state) => ({
    pendingApprovals: state.pendingApprovals.filter(a => a.id !== approvalId && a.stepId !== approvalId),
    metrics: {
      ...state.metrics,
      pendingApprovalsCount: Math.max(0, state.metrics.pendingApprovalsCount - 1)
    },
    planSteps: state.planSteps.map(step => {
      if (step.id === approvalId || step.actionId === approvalId) {
        return {
          ...step,
          status: decision === "APPROVE" ? StepStatus.APPROVED : StepStatus.SKIPPED
        };
      }
      return step;
    })
  })),

  addTimelineEvent: (event) => set((state) => ({
    timeline: [
      ...state.timeline,
      { ...event, id: `tl-${Date.now()}-${Math.random()}` }
    ]
  }))
}));
