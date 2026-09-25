import { ToolExecutionContext, ToolResponse } from "@nexusops/shared-types";
import { z } from "zod";
import { nonEmpty, positiveInteger, runValidated, ToolDomainError } from "./contract.js";

const metricsSchema = z.object({ timeWindowDays: positiveInteger.optional() }).strict();
const analyticsEventSchema = z.object({
  id: nonEmpty,
  eventType: z.enum(["LEAD_CREATED", "DEAL_WON", "EMAIL_SENT", "MEETING_HELD", "TASK_COMPLETED"]),
  occurredAt: z.string().datetime(),
  leadId: nonEmpty.optional(),
  amount: z.number().finite().nonnegative().optional()
}).strict().refine((event) => event.eventType !== "DEAL_WON" || (event.leadId !== undefined && event.amount !== undefined), {
  path: ["leadId"], message: "DEAL_WON events require leadId and amount"
}).refine((event) => event.eventType !== "LEAD_CREATED" || event.leadId !== undefined, {
  path: ["leadId"], message: "LEAD_CREATED events require leadId"
});
const analyticsEventsSchema = z.array(analyticsEventSchema);
type AnalyticsEvent = z.infer<typeof analyticsEventSchema>;
type Metric = Record<string, number>;
export type AnalyticsToolOptions = { clock?: () => Date };

/** Deterministic local analytics. An empty event store returns successful empty metric sets. */
export class AnalyticsToolService {
  private readonly eventsByOwner = new Map<string, AnalyticsEvent[]>();
  private readonly clock: () => Date;

  constructor(options: AnalyticsToolOptions = {}) { this.clock = options.clock ?? (() => new Date()); }

  setEvents(rows: readonly unknown[], context: Pick<ToolExecutionContext, "orgId" | "userId">): void {
    if (!context.orgId || !context.userId) throw new ToolDomainError("INVALID_OWNER", "Analytics events require authenticated workspace ownership.");
    const events = analyticsEventsSchema.parse(rows);
    const ids = new Set<string>();
    for (const event of events) {
      if (ids.has(event.id)) throw new ToolDomainError("INVALID_DATA", `Duplicate analytics event identity: ${event.id}`);
      ids.add(event.id);
    }
    this.eventsByOwner.set(ownerKey(context.orgId, context.userId), events.map((event) => ({ ...event })));
  }

  getLeadMetrics(params: unknown, context: ToolExecutionContext): Promise<ToolResponse<Metric[]>> {
    return runValidated(metricsSchema, params, context, (query) => {
      const leads = new Set(this.windowEvents(query.timeWindowDays, context).filter((event) => event.eventType === "LEAD_CREATED").map(({ leadId }) => leadId));
      return leads.size ? [{ leadsCreated: leads.size }] : [];
    });
  }

  getConversionMetrics(params: unknown, context: ToolExecutionContext): Promise<ToolResponse<Metric[]>> {
    return runValidated(metricsSchema, params, context, (query) => {
      const events = this.windowEvents(query.timeWindowDays, context);
      const leads = new Set(events.filter((event) => event.eventType === "LEAD_CREATED").map(({ leadId }) => leadId));
      if (leads.size === 0) return [];
      const won = new Set(events.filter((event) => event.eventType === "DEAL_WON" && leads.has(event.leadId)).map(({ leadId }) => leadId));
      return [{ leadsCreated: leads.size, dealsWon: won.size, conversionRate: Math.round(won.size / leads.size * 10_000) / 100 }];
    });
  }

  getSalesMetrics(params: unknown, context: ToolExecutionContext): Promise<ToolResponse<Metric[]>> {
    return runValidated(metricsSchema, params, context, (query) => {
      const won = this.windowEvents(query.timeWindowDays, context).filter((event) => event.eventType === "DEAL_WON");
      if (won.length === 0) return [];
      const revenue = won.reduce((total, event) => total + (event.amount ?? 0), 0);
      return [{ dealsWon: won.length, revenue, averageDealValue: revenue / won.length }];
    });
  }

  getActivityMetrics(params: unknown, context: ToolExecutionContext): Promise<ToolResponse<Metric[]>> {
    return runValidated(metricsSchema, params, context, (query) => {
      const events = this.windowEvents(query.timeWindowDays, context);
      const result = {
        emailsSent: events.filter(({ eventType }) => eventType === "EMAIL_SENT").length,
        meetingsHeld: events.filter(({ eventType }) => eventType === "MEETING_HELD").length,
        tasksCompleted: events.filter(({ eventType }) => eventType === "TASK_COMPLETED").length
      };
      return result.emailsSent + result.meetingsHeld + result.tasksCompleted > 0 ? [result] : [];
    });
  }

  private windowEvents(timeWindowDays: number | undefined, context: ToolExecutionContext): AnalyticsEvent[] {
    const now = this.clock().getTime();
    const lowerBound = timeWindowDays === undefined ? Number.NEGATIVE_INFINITY : now - timeWindowDays * 86_400_000;
    return (this.eventsByOwner.get(ownerKey(context.orgId, context.userId)) ?? []).filter(({ occurredAt }) => {
      const time = Date.parse(occurredAt);
      return time >= lowerBound && time <= now;
    });
  }
}

function ownerKey(workspaceId: string, userId: string) { return `${workspaceId}\0${userId}`; }

export const AnalyticsTool = new AnalyticsToolService();
