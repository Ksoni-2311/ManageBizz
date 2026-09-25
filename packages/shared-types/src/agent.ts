export enum AgentState {
  IDLE = "IDLE",
  GOAL_RECEIVED = "GOAL_RECEIVED",
  GOAL_PARSED = "GOAL_PARSED",
  OBSERVING = "OBSERVING",
  ANALYZING = "ANALYZING",
  PLANNING = "PLANNING",
  RISK_CHECK = "RISK_CHECK",
  WAITING_FOR_APPROVAL = "WAITING_FOR_APPROVAL",
  EXECUTING = "EXECUTING",
  VERIFYING = "VERIFYING",
  REPLANNING = "REPLANNING",
  COMPLETED = "COMPLETED",
  FAILED = "FAILED",
  CANCELLED = "CANCELLED"
}

export enum RiskLevel {
  LOW = "LOW",
  MEDIUM = "MEDIUM",
  HIGH = "HIGH"
}

export interface StateTransitionLog {
  fromState: AgentState;
  toState: AgentState;
  timestamp: string;
  reason?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentRun {
  id: string;
  goalId: string;
  orgId: string;
  currentState: AgentState;
  stateHistory: StateTransitionLog[];
  currentPlanId?: string;
  startedAt: string;
  endedAt?: string;
  error?: string;
}
