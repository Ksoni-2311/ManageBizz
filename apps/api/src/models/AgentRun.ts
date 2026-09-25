import mongoose, { Schema, Document } from "mongoose";
import { AgentState } from "@nexusops/shared-types";

export interface IStateTransition {
  fromState: AgentState;
  toState: AgentState;
  timestamp: Date;
  reason?: string;
  metadata?: Record<string, unknown>;
}

export interface IAgentRun extends Document {
  goalId: string;
  orgId: string;
  userId: string;
  currentState: AgentState;
  stateHistory: IStateTransition[];
  currentPlanId?: string;
  startedAt: Date;
  endedAt?: Date;
  error?: string;
}

const StateTransitionSchema = new Schema<IStateTransition>({
  fromState: { type: String, enum: Object.values(AgentState), required: true },
  toState: { type: String, enum: Object.values(AgentState), required: true },
  timestamp: { type: Date, default: Date.now },
  reason: { type: String },
  metadata: { type: Schema.Types.Mixed }
});

const AgentRunSchema = new Schema<IAgentRun>({
  goalId: { type: String, required: true },
  orgId: { type: String, required: true },
  userId: { type: String, required: true, index: true },
  currentState: { type: String, enum: Object.values(AgentState), default: AgentState.IDLE },
  stateHistory: [StateTransitionSchema],
  currentPlanId: { type: String },
  startedAt: { type: Date, default: Date.now },
  endedAt: { type: Date },
  error: { type: String }
});

export const AgentRunModel = mongoose.model<IAgentRun>("AgentRun", AgentRunSchema);
