import mongoose, { Schema, Document } from "mongoose";
import { ApprovalStatus, RiskLevel } from "@nexusops/shared-types";

export interface IApproval extends Document {
  runId: string;
  goalId: string;
  stepId: string;
  tool: string;
  action: string;
  params: Record<string, unknown>;
  riskLevel: RiskLevel;
  reason: string;
  status: ApprovalStatus;
  requestedAt: Date;
  decidedAt?: Date;
  decidedById?: string;
  feedback?: string;
}

const ApprovalSchema = new Schema<IApproval>({
  runId: { type: String, required: true },
  goalId: { type: String, required: true },
  stepId: { type: String, required: true },
  tool: { type: String, required: true },
  action: { type: String, required: true },
  params: { type: Schema.Types.Mixed, default: {} },
  riskLevel: { type: String, enum: Object.values(RiskLevel), required: true },
  reason: { type: String, required: true },
  status: { type: String, enum: Object.values(ApprovalStatus), default: ApprovalStatus.PENDING },
  requestedAt: { type: Date, default: Date.now },
  decidedAt: { type: Date },
  decidedById: { type: String },
  feedback: { type: String }
});

export const ApprovalModel = mongoose.model<IApproval>("Approval", ApprovalSchema);
