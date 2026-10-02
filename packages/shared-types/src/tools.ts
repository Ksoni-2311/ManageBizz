import { RiskLevel } from "./agent.js";

export type ToolCategory = "crm" | "email" | "calendar" | "tasks" | "analytics";

export interface ToolResult<T = unknown> {
  success: true;
  data: T;
  metadata?: {
    executionTimeMs: number;
    actionId: string;
    cached?: boolean;
  };
}

export interface ToolError {
  code: string;
  message: string;
  details?: unknown;
}

export interface ToolFailure {
  success: false;
  error: ToolError;
  metadata?: {
    executionTimeMs: number;
    actionId: string;
    cached?: boolean;
  };
}

export type ToolResponse<T = unknown> = ToolResult<T> | ToolFailure;

export interface ToolExecutionContext {
  goalId: string;
  runId: string;
  actionId: string;
  userId: string;
  orgId: string;
  /** Server-internal marker attached only after an approval workflow accepts the proposal. */
  approvedActionId?: string;
}

export interface BusinessToolContract<TInput = unknown, TOutput = unknown> {
  name: string;
  category: ToolCategory;
  description: string;
  riskLevel: RiskLevel;
  validate(input: unknown): TInput;
  execute(input: TInput, context: ToolExecutionContext): Promise<ToolResponse<TOutput>>;
}
