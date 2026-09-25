import mongoose, { Schema, Document } from "mongoose";
import { RiskLevel } from "@nexusops/shared-types";

export interface IAuditLog extends Document {
  orgId: string;
  userId?: string;
  goalId?: string;
  runId?: string;
  eventType: string;
  riskLevel?: RiskLevel;
  details: Record<string, unknown>;
  timestamp: Date;
}

const AuditLogSchema = new Schema<IAuditLog>({
  orgId: { type: String, required: true },
  userId: { type: String },
  goalId: { type: String },
  runId: { type: String },
  eventType: { type: String, required: true },
  riskLevel: { type: String, enum: Object.values(RiskLevel) },
  details: { type: Schema.Types.Mixed, default: {} },
  timestamp: { type: Date, default: Date.now }
});

export const AuditLogModel = mongoose.model<IAuditLog>("AuditLog", AuditLogSchema);
