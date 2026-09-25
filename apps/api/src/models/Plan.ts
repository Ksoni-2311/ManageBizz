import mongoose, { Schema, Document } from "mongoose";
import { PlanStatus, StepStatus, RiskLevel } from "@nexusops/shared-types";

export interface IPlanStep {
  id: string;
  actionId: string;
  stepNumber: number;
  tool: "crm" | "email" | "calendar" | "tasks" | "analytics";
  action: string;
  params: Record<string, unknown>;
  riskLevel: RiskLevel;
  requiresApproval: boolean;
  reasoning: string;
  status: StepStatus;
  result?: Record<string, unknown>;
  error?: string;
}

export interface IPlan extends Document {
  goalId: string;
  runId: string;
  version: number;
  steps: IPlanStep[];
  status: PlanStatus;
  createdAt: Date;
}

const PlanStepSchema = new Schema<IPlanStep>({
  id: { type: String, required: true },
  actionId: { type: String, required: true },
  stepNumber: { type: Number, required: true },
  tool: { type: String, required: true },
  action: { type: String, required: true },
  params: { type: Schema.Types.Mixed, default: {} },
  riskLevel: { type: String, enum: Object.values(RiskLevel), required: true },
  requiresApproval: { type: Boolean, required: true },
  reasoning: { type: String, required: true },
  status: { type: String, enum: Object.values(StepStatus), default: StepStatus.PENDING },
  result: { type: Schema.Types.Mixed },
  error: { type: String }
});

const PlanSchema = new Schema<IPlan>({
  goalId: { type: String, required: true },
  runId: { type: String, required: true },
  version: { type: Number, default: 1 },
  steps: [PlanStepSchema],
  status: { type: String, enum: Object.values(PlanStatus), default: PlanStatus.DRAFT },
  createdAt: { type: Date, default: Date.now }
});

export const PlanModel = mongoose.model<IPlan>("Plan", PlanSchema);
