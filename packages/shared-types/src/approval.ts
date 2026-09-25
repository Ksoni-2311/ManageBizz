import { RiskLevel } from "./agent.js";

export enum ApprovalStatus {
  PENDING = "PENDING",
  APPROVED = "APPROVED",
  REJECTED = "REJECTED",
  MODIFIED = "MODIFIED"
}

export interface ApprovalRequest {
  id: string;
  runId: string;
  goalId: string;
  stepId: string;
  tool: string;
  action: string;
  params: Record<string, unknown>;
  riskLevel: RiskLevel;
  reason: string;
  status: ApprovalStatus;
  requestedAt: string;
  decidedAt?: string;
  decidedById?: string;
  feedback?: string;
}

export interface UserDecisionInput {
  decision: "APPROVE" | "REJECT" | "MODIFY";
  feedback?: string;
  modifiedParams?: Record<string, unknown>;
}
