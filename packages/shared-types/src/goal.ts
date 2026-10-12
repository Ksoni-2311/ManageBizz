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

export const AgentPlanDetailsSchema = z.object({
  intent: z.enum([
    "email_reply_check",
    "cross_source_contact_status",
    "email_search",
    "email_content_question",
    "crm_lead_search",
    "crm_deal_value",
    "calendar_event_search",
    "calendar_availability",
    "analytics_query",
    "task_query",
    "task_action",
    "unknown"
  ]),
  entities: z.array(z.object({
    type: z.enum(["person", "company", "email", "phone"]),
    value: z.string().trim().min(1).max(200)
  }).strict()).max(20),
  requestedFacts: z.array(z.string().trim().min(1).max(300)).max(12),
  analyticalRequirements: z.array(z.string().trim().min(1).max(300)).max(12).default([]),
  outputRequirements: z.array(z.string().trim().min(1).max(200)).max(12).default([]),
  sources: z.array(z.enum(["crm", "gmail", "calendar", "analytics", "tasks"])).max(5)
    .refine((sources) => new Set(sources).size === sources.length, "Sources must be unique."),
  dateRange: z.object({
    type: z.enum(["relative", "absolute"]),
    expression: z.string().trim().min(1).max(120),
    start: z.string().trim().min(1).max(40).optional(),
    end: z.string().trim().min(1).max(40).optional(),
    timezone: z.string().trim().min(1).max(100).optional()
  }).strict().optional(),
  filters: z.array(z.object({
    field: z.string().trim().min(1).max(80),
    operator: z.enum(["equals", "contains", "greater_than", "greater_than_or_equal", "less_than", "less_than_or_equal", "before", "after"]),
    value: z.union([z.string().max(200), z.number().finite(), z.boolean()])
  }).strict()).max(20),
  sort: z.object({
    field: z.string().trim().min(1).max(80),
    direction: z.enum(["ascending", "descending"])
  }).strict().optional(),
  limit: z.number().int().min(1).max(100).optional(),
  dependencies: z.array(z.object({
    source: z.enum(["crm", "gmail", "calendar", "analytics", "tasks"]),
    dependsOn: z.enum(["crm", "gmail", "calendar", "analytics", "tasks"])
  }).strict()).max(10),
  ambiguity: z.object({
    type: z.enum(["none", "entity_resolution_required", "multiple_entity_matches", "unclear_intent"]),
    details: z.string().trim().max(300),
    entity: z.string().trim().min(1).max(200).optional(),
    candidates: z.array(z.string().trim().min(1).max(200)).max(10).default([])
  }).strict(),
  confidence: z.number().min(0).max(1),
  decisionSummary: z.string().trim().max(300)
}).strict();

export const AgentPlanSchema = AgentPlanDetailsSchema.extend({
  planningMethod: z.enum(["llm", "deterministic_fallback"]),
  fallbackReason: z.enum(["llm_unavailable", "invalid_llm_output", "llm_not_configured"]).optional()
}).strict();

export type AgentPlanDetails = z.infer<typeof AgentPlanDetailsSchema>;
export type AgentPlan = z.infer<typeof AgentPlanSchema>;

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
