import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EmailToolService } from "../tools/emailTool.js";
import { CalendarToolService } from "../tools/calendarTool.js";
import { MockCalendarProvider, CalendarEvent } from "../integrations/googleCalendar/calendarProvider.js";
import { AnalyticsToolService } from "../tools/analyticsTool.js";
import { planBusinessGoal } from "../agent/runtime/controlledOrchestrator.js";

const context = { goalId: "goal", runId: "read-tools", actionId: "action", userId: "user", orgId: "org" };
const fixedNow = new Date("2026-09-10T12:00:00.000Z");

describe("email, calendar, and analytics system contracts", () => {
  it("looks up message history, marks unanswered outbound messages, and returns empty matches", async () => {
    const email = new EmailToolService();
    email.setMessages([
      { id: "outbound-with-reply", leadEmail: "one@example.invalid", direction: "OUTBOUND", subject: "First", sentAt: "2026-09-08T10:00:00.000Z" },
      { id: "inbound-reply", leadEmail: "one@example.invalid", direction: "INBOUND", subject: "Reply", sentAt: "2026-09-09T10:00:00.000Z", inReplyToMessageId: "outbound-with-reply" },
      { id: "outbound-unanswered", leadEmail: "one@example.invalid", direction: "OUTBOUND", subject: "Second", sentAt: "2026-09-10T10:00:00.000Z" }
    ]);
    const history = await email.getEmailHistory({ leadEmail: "ONE@example.invalid" }, context);
    assert.equal(history.success, true);
    if (history.success) {
      assert.equal(history.data.length, 3);
      assert.equal(history.data.find(({ id }) => id === "outbound-with-reply")?.responseStatus, "ANSWERED");
      assert.equal(history.data.find(({ id }) => id === "outbound-unanswered")?.responseStatus, "UNANSWERED");
    }
    const unanswered = await email.getUnansweredMessages({ leadEmail: "one@example.invalid" }, context);
    assert.equal(unanswered.success, true);
    if (unanswered.success) assert.deepEqual(unanswered.data.map(({ id }) => id), ["outbound-unanswered"]);
    const empty = await email.getEmailHistory({ leadEmail: "missing@example.invalid" }, context);
    assert.equal(empty.success, true);
    if (empty.success) assert.deepEqual(empty.data, []);
    const emailPlan = planBusinessGoal({ objective: "Find unanswered emails", timeWindowDays: 30, constraints: [], successCriteria: [] });
    assert.equal(emailPlan.initialCalls[0]?.tool, "email");
    assert.equal(emailPlan.initialCalls[0]?.action, "getUnansweredMessages");
    assert.throws(() => email.setMessages([{ id: "broken", leadEmail: "not-an-address", direction: "OUTBOUND", subject: "x", sentAt: "invalid" } ]));
  });

  it("looks up calendar events, returns upcoming events in order, and returns empty when none match", async () => {
    const provider = new MockCalendarProvider();
    const events: CalendarEvent[] = [
      { id: "event-a", title: "Event A", attendees: ["attendee@example.invalid"], startTime: "2026-09-12T10:00:00.000Z", endTime: "2026-09-12T11:00:00.000Z", status: "SCHEDULED" },
      { id: "event-b", title: "Event B", attendees: ["attendee@example.invalid"], startTime: "2026-09-11T10:00:00.000Z", endTime: "2026-09-11T11:00:00.000Z", status: "SCHEDULED" },
      { id: "event-past", title: "Past event", attendees: ["attendee@example.invalid"], startTime: "2026-09-09T10:00:00.000Z", endTime: "2026-09-09T11:00:00.000Z", status: "SCHEDULED" }
    ];
    provider.seed({ workspaceId: context.orgId, userId: context.userId }, events);
    const calendar = new CalendarToolService({ clock: () => fixedNow, provider });
    const lookup = await calendar.getMeeting({ meetingId: "event-a" }, context);
    assert.equal(lookup.success, true);
    if (lookup.success) assert.equal(lookup.data.id, "event-a");
    const upcoming = await calendar.listUpcomingEvents({}, context);
    assert.equal(upcoming.success, true);
    if (upcoming.success) {
      assert.equal(upcoming.data.length, 2);
      assert.ok(upcoming.data.every(({ startTime }) => Date.parse(startTime) >= fixedNow.getTime()));
      assert.ok(Date.parse(upcoming.data[0]!.startTime) < Date.parse(upcoming.data[1]!.startTime));
    }
    const empty = await new CalendarToolService({ clock: () => fixedNow, provider: new MockCalendarProvider() }).listUpcomingEvents({}, context);
    assert.equal(empty.success, true);
    if (empty.success) assert.deepEqual(empty.data, []);
    const missing = await calendar.getMeeting({ meetingId: "missing" }, context);
    assert.equal(missing.success, false);
    if (!missing.success) assert.equal(missing.error.code, "NOT_FOUND");
    const relevant = await calendar.findEventsForLead({ leadEmail: "attendee@example.invalid" }, context);
    assert.equal(relevant.success && relevant.data.length, 3);
    const plan = planBusinessGoal({ objective: "Show upcoming calendar events", timeWindowDays: 30, constraints: [], successCriteria: [] });
    assert.equal(plan.initialCalls[0]?.action, "listUpcomingEvents");
  });

  it("calculates deterministic analytics and returns successful empty metrics for an empty dataset", async () => {
    const analytics = new AnalyticsToolService({ clock: () => fixedNow });
    analytics.setEvents([
      { id: "lead-a", eventType: "LEAD_CREATED", leadId: "lead-a", occurredAt: "2026-09-05T10:00:00.000Z" },
      { id: "lead-b", eventType: "LEAD_CREATED", leadId: "lead-b", occurredAt: "2026-09-06T10:00:00.000Z" },
      { id: "won-a", eventType: "DEAL_WON", leadId: "lead-a", amount: 120, occurredAt: "2026-09-08T10:00:00.000Z" },
      { id: "email-a", eventType: "EMAIL_SENT", occurredAt: "2026-09-08T11:00:00.000Z" },
      { id: "meeting-a", eventType: "MEETING_HELD", occurredAt: "2026-09-09T10:00:00.000Z" },
      { id: "task-a", eventType: "TASK_COMPLETED", occurredAt: "2026-09-09T11:00:00.000Z" },
      { id: "old-lead", eventType: "LEAD_CREATED", leadId: "old-lead", occurredAt: "2026-08-01T10:00:00.000Z" }
    ], context);
    const leadMetrics = await analytics.getLeadMetrics({ timeWindowDays: 7 }, context);
    const conversion = await analytics.getConversionMetrics({ timeWindowDays: 7 }, context);
    const sales = await analytics.getSalesMetrics({ timeWindowDays: 7 }, context);
    const activity = await analytics.getActivityMetrics({ timeWindowDays: 7 }, context);
    assert.deepEqual(leadMetrics.success && leadMetrics.data, [{ leadsCreated: 2 }]);
    assert.deepEqual(conversion.success && conversion.data, [{ leadsCreated: 2, dealsWon: 1, conversionRate: 50 }]);
    assert.deepEqual(sales.success && sales.data, [{ dealsWon: 1, revenue: 120, averageDealValue: 120 }]);
    assert.deepEqual(activity.success && activity.data, [{ emailsSent: 1, meetingsHeld: 1, tasksCompleted: 1 }]);

    const empty = new AnalyticsToolService({ clock: () => fixedNow });
    for (const result of [
      await empty.getLeadMetrics({}, context), await empty.getConversionMetrics({}, context),
      await empty.getSalesMetrics({}, context), await empty.getActivityMetrics({}, context)
    ]) {
      assert.equal(result.success, true);
      if (result.success) assert.deepEqual(result.data, []);
    }
    assert.throws(() => analytics.setEvents([{ id: "invalid-won", eventType: "DEAL_WON", amount: -1, occurredAt: "2026-09-09T00:00:00.000Z" }], context));
    const otherOwner = { ...context, userId: "other-user", orgId: "other-workspace" };
    const isolated = await analytics.getLeadMetrics({}, otherOwner);
    assert.deepEqual(isolated.success && isolated.data, []);
  });
});
