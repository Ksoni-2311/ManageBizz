import { RiskLevel } from "./agent.js";

export enum StepStatus {
  PENDING = "PENDING",
  APPROVED = "APPROVED",
  EXECUTING = "EXECUTING",
  COMPLETED = "COMPLETED",
  FAILED = "FAILED",
  SKIPPED = "SKIPPED"
}

export interface PlanStep {
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

export enum PlanStatus {
  DRAFT = "DRAFT",
  PENDING_APPROVAL = "PENDING_APPROVAL",
  APPROVED = "APPROVED",
  REJECTED = "REJECTED",
  EXECUTING = "EXECUTING",
  COMPLETED = "COMPLETED",
  FAILED = "FAILED"
}

export interface ActionPlan {
  id: string;
  goalId: string;
  runId: string;
  version: number;
  steps: PlanStep[];
  status: PlanStatus;
  createdAt: string;
}
