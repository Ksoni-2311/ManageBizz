import mongoose, { Schema, Document } from "mongoose";
import { GoalStatus } from "@nexusops/shared-types";

export interface IGoal extends Document {
  orgId: string;
  createdById: string;
  rawPrompt: string;
  parsedGoal?: {
    objective: string;
    timeWindowDays: number;
    constraints: string[];
    successCriteria: string[];
  };
  status: GoalStatus;
  createdAt: Date;
  updatedAt: Date;
}

const GoalSchema = new Schema<IGoal>({
  orgId: { type: String, required: true },
  createdById: { type: String, required: true },
  rawPrompt: { type: String, required: true },
  parsedGoal: {
    objective: { type: String },
    timeWindowDays: { type: Number },
    constraints: [{ type: String }],
    successCriteria: [{ type: String }]
  },
  status: { type: String, enum: Object.values(GoalStatus), default: GoalStatus.ACTIVE },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

export const GoalModel = mongoose.model<IGoal>("Goal", GoalSchema);
