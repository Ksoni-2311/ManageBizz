import { z } from "zod";

export const GoalInputSchema = z.object({
  prompt: z.string().min(5, "Goal prompt must be at least 5 characters"),
  timeWindowDays: z.number().optional().default(30),
  constraints: z.array(z.string()).optional().default([]),
  allowedTools: z.array(z.string()).optional().default([])
});

export type GoalInput = z.infer<typeof GoalInputSchema>;

export const ParsedGoalSchema = z.object({
  objective: z.string(),
  timeWindowDays: z.number(),
  constraints: z.array(z.string()),
  successCriteria: z.array(z.string())
});

export type ParsedGoal = z.infer<typeof ParsedGoalSchema>;

export enum GoalStatus {
  ACTIVE = "ACTIVE",
  COMPLETED = "COMPLETED",
  FAILED = "FAILED",
  CANCELLED = "CANCELLED"
}

export interface Goal {
  id: string;
  orgId: string;
  createdById: string;
  rawPrompt: string;
  parsedGoal?: ParsedGoal;
  status: GoalStatus;
  createdAt: string;
  updatedAt: string;
}
