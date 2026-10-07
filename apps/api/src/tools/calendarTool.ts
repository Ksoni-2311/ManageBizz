import { ToolExecutionContext, ToolResponse } from "@nexusops/shared-types";
import { z } from "zod";
import { CalendarService } from "../services/calendarService.js";
import { CalendarProvider, CalendarEvent, GoogleCalendarProvider, MockCalendarProvider } from "../integrations/googleCalendar/calendarProvider.js";
import { emailAddress, nonEmpty, requireApprovedAction, runValidated, ToolDomainError } from "./contract.js";

const availabilitySchema = z.object({
  from: z.string().datetime().optional(), until: z.string().datetime().optional(),
  durationMinutes: z.number().int().positive().max(1440).optional()
}).strict();
const meetingLookupSchema = z.object({ meetingId: nonEmpty }).strict();
const leadLookupSchema = z.object({ leadEmail: emailAddress }).strict();
const upcomingSchema = z.object({ from: z.string().datetime().optional(), until: z.string().datetime().optional(), queryTerm: z.string().trim().min(1).max(60).optional() }).strict()
  .refine(({ from, until }) => !from || !until || Date.parse(until) > Date.parse(from), { path: ["until"], message: "until must be later than from" });
const createMeetingSchema = z.object({
  title: nonEmpty.max(300),
  startTime: z.string().datetime(),
  endTime: z.string().datetime(),
  attendees: z.array(emailAddress).max(100).default([]),
  description: z.string().max(10_000).optional(),
  location: z.string().trim().max(500).optional()
}).strict().refine(({ startTime, endTime }) => Date.parse(endTime) > Date.parse(startTime), { path: ["endTime"], message: "endTime must be after startTime" })
  .refine(({ attendees }) => new Set(attendees.map((email) => email.toLowerCase())).size === attendees.length, { path: ["attendees"], message: "attendees must be unique" });
const readOnlyActionSchema = z.object({}).passthrough();
export type Meeting = CalendarEvent;
export type CalendarToolOptions = { clock?: () => Date; provider?: CalendarProvider };

/** Tool-facing wrapper. Provider and Google API details remain in the service and adapter layers. */
export class CalendarToolService {
  private readonly clock: () => Date;
  private readonly service: CalendarService;
  readonly provider: CalendarProvider;

  constructor(options: CalendarToolOptions = {}) {
    this.clock = options.clock ?? (() => new Date());
    this.provider = options.provider ?? new MockCalendarProvider();
    this.service = new CalendarService(this.provider);
  }

  getAvailability(params: unknown, context: ToolExecutionContext): Promise<ToolResponse<Array<{ startTime: string; endTime: string }>>> {
    return runValidated(availabilitySchema, params, context, async ({ from, until }) => {
      if (this.provider instanceof MockCalendarProvider) return [];
      const start = from ?? this.clock().toISOString();
      const end = until ?? new Date(Date.parse(start) + 7 * 24 * 60 * 60 * 1000).toISOString();
      if (Date.parse(end) <= Date.parse(start) || Date.parse(end) - Date.parse(start) > 31 * 24 * 60 * 60 * 1000) {
        throw new ToolDomainError("INVALID_INPUT", "Calendar availability must use a valid range no longer than 31 days.");
      }
      const status = await this.calendarCall(() => this.service.connectionStatus(identity(context)));
      if (!status.connected) throw new ToolDomainError("CALENDAR_NOT_CONNECTED", "Google Calendar is not connected for this workspace.");
      return this.calendarCall(() => this.provider.listBusyPeriods(identity(context), { from: start, until: end }));
    });
  }

  getMeeting(params: unknown, context: ToolExecutionContext): Promise<ToolResponse<Meeting>> {
    return runValidated(meetingLookupSchema, params, context, async ({ meetingId }) => {
      const event = await this.calendarCall(() => this.service.getEventDetails(identity(context), meetingId));
      if (!event) throw new ToolDomainError("NOT_FOUND", `Calendar event '${meetingId}' was not found.`);
      return event;
    });
  }

  listUpcomingEvents(params: unknown, context: ToolExecutionContext): Promise<ToolResponse<Meeting[]>> {
    return runValidated(upcomingSchema, params, context, async ({ from, until, queryTerm }) => {
      const events = await this.calendarCall(() => this.service.listUpcomingEvents(identity(context), {
        from: from ?? this.clock().toISOString(), ...(until ? { until } : {}), ...(queryTerm ? { queryTerm } : {})
      }));
      return events.map(cloneEvent);
    });
  }

  findEventsForLead(params: unknown, context: ToolExecutionContext): Promise<ToolResponse<Meeting[]>> {
    return runValidated(leadLookupSchema, params, context, async ({ leadEmail }) =>
      (await this.calendarCall(() => this.service.findEventsForLead(identity(context), leadEmail))).map(cloneEvent));
  }

  connectionStatus(context: ToolExecutionContext): Promise<{ connected: boolean; reauthorizationRequired?: boolean }> {
    return this.service.connectionStatus(identity(context));
  }

  createMeeting(params: unknown, context: ToolExecutionContext): Promise<ToolResponse<Meeting>> {
    return runValidated(createMeetingSchema, params, context, (event) => { requireApprovedAction(context); return this.calendarCall(() => this.service.createEvent(identity(context), { ...event, attendees: event.attendees ?? [] }, context.actionId)); });
  }
  cancelMeeting(params: unknown, context: ToolExecutionContext): Promise<ToolResponse<never>> {
    return runValidated(readOnlyActionSchema, params, context, () => { throw new ToolDomainError("READ_ONLY_CALENDAR", "Calendar event cancellation is disabled."); });
  }

  private async calendarCall<T>(call: () => Promise<T>): Promise<T> {
    try { return await call(); }
    catch (error) {
      if (error instanceof ToolDomainError) throw error;
      const candidate = error as { code?: unknown; message?: unknown };
      if (typeof candidate?.code === "string") {
        throw new ToolDomainError(candidate.code, typeof candidate.message === "string" ? candidate.message : "Calendar operation failed.");
      }
      throw new ToolDomainError("CALENDAR_UNAVAILABLE", "Calendar data is temporarily unavailable.");
    }
  }
}

function identity(context: ToolExecutionContext) { return { workspaceId: context.orgId, userId: context.userId }; }
function cloneEvent(event: CalendarEvent): CalendarEvent { return { ...event, attendees: [...event.attendees] }; }

/** Production tool is Google-only: a disconnected Google account never falls back to mock records. */
export const CalendarTool = new CalendarToolService({ provider: new GoogleCalendarProvider() });
