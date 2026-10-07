import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CalendarToolService } from "../tools/calendarTool.js";
import { CalendarIdentity, encryptRefreshToken, GoogleCalendarProvider, MockCalendarProvider } from "../integrations/googleCalendar/calendarProvider.js";
import { InMemoryCalendarConnectionRepository } from "../integrations/googleCalendar/calendarConnectionRepository.js";
import { GoogleCalendarOAuthService } from "../integrations/googleCalendar/googleCalendarOAuthService.js";

const identity: CalendarIdentity = { workspaceId: "workspace-one", userId: "user-one" };
const context = { goalId: "calendar-test", runId: "calendar-test", actionId: "calendar-test", orgId: identity.workspaceId, userId: identity.userId };
const key = Buffer.alloc(32, 7).toString("base64");

function withEnv(values: Record<string, string>, fn: () => Promise<void>): Promise<void> {
  const previous = new Map(Object.keys(values).map((name) => [name, process.env[name]]));
  Object.assign(process.env, values);
  return fn().finally(() => {
    for (const [name, value] of previous) if (value === undefined) delete process.env[name]; else process.env[name] = value;
  });
}

describe("Google Calendar provider architecture", () => {
  it("uses a fake provider for upcoming, lead-relevant, and detail reads", async () => {
    const provider = new MockCalendarProvider();
    provider.seed(identity, [
      { id: "event-1", title: "Review", attendees: ["lead@example.test"], startTime: "2026-10-01T10:00:00.000Z", endTime: "2026-10-01T11:00:00.000Z", status: "SCHEDULED" },
      { id: "event-2", title: "Other", attendees: ["other@example.test"], startTime: "2026-10-02T10:00:00.000Z", endTime: "2026-10-02T11:00:00.000Z", status: "SCHEDULED" }
    ]);
    const calendar = new CalendarToolService({ clock: () => new Date("2026-09-30T00:00:00Z"), provider });
    const upcoming = await calendar.listUpcomingEvents({}, context);
    const relevant = await calendar.findEventsForLead({ leadEmail: "lead@example.test" }, context);
    const detail = await calendar.getMeeting({ meetingId: "event-1" }, context);
    assert.equal(upcoming.success && upcoming.data.length, 2);
    assert.deepEqual(relevant.success && relevant.data.map(({ id }) => id), ["event-1"]);
    assert.equal(detail.success && detail.data.title, "Review");
    const foreignDetail = await calendar.getMeeting({ meetingId: "event-1" }, { ...context, orgId: "another-workspace", userId: "another-user" });
    assert.equal(foreignDetail.success, false, "another workspace must not read event details from the seeded calendar");
  });

  it("returns authoritative empty Google results and never uses mock data when disconnected", async () => {
    await withEnv({ GOOGLE_CALENDAR_CLIENT_ID: "client", GOOGLE_CALENDAR_CLIENT_SECRET: "secret", CALENDAR_TOKEN_ENCRYPTION_KEY: key }, async () => {
      const repository = new InMemoryCalendarConnectionRepository();
      await repository.save({ ...identity, encryptedRefreshToken: encryptRefreshToken("refresh-token"), connectedAt: new Date().toISOString() });
      const fetcher = async () => new Response(JSON.stringify({ access_token: "access", expires_in: 3600 }), { status: 200 });
      const tokenOnly = fetcher as typeof fetch;
      const provider = new GoogleCalendarProvider(repository, async (input, init) => {
        if (String(input).includes("oauth2.googleapis.com")) return tokenOnly(input, init);
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      });
      const calendar = new CalendarToolService({ provider });
      const empty = await calendar.listUpcomingEvents({}, context);
      assert.equal(empty.success, true);
      if (empty.success) assert.deepEqual(empty.data, []);

      const disconnectedIdentity = { workspaceId: "workspace-empty", userId: "user-empty" };
      const disconnected = new GoogleCalendarProvider(repository, async () => { throw new Error("must not call Google"); });
      const disconnectedCalendar = new CalendarToolService({ provider: disconnected });
      const result = await disconnectedCalendar.listUpcomingEvents({}, { ...context, ...disconnectedIdentity, orgId: disconnectedIdentity.workspaceId });
      assert.equal(result.success, false);
      if (!result.success) assert.equal(result.error.code, "CALENDAR_NOT_CONNECTED");
    });
  });

  it("surfaces expired authorization and Google rate limits as explicit tool errors", async () => {
    await withEnv({ GOOGLE_CALENDAR_CLIENT_ID: "client", GOOGLE_CALENDAR_CLIENT_SECRET: "secret", CALENDAR_TOKEN_ENCRYPTION_KEY: key }, async () => {
      const repository = new InMemoryCalendarConnectionRepository();
      await repository.save({ ...identity, encryptedRefreshToken: encryptRefreshToken("refresh-token"), connectedAt: new Date().toISOString() });
      const expired = new GoogleCalendarProvider(repository, async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }));
      const expiredResult = await new CalendarToolService({ provider: expired }).listUpcomingEvents({}, context);
      assert.equal(expiredResult.success, false);
      if (!expiredResult.success) assert.equal(expiredResult.error.code, "CALENDAR_AUTH_EXPIRED");
      assert.equal((await expired.connectionStatus(identity)).reauthorizationRequired, true);

      const rateLimitRepository = new InMemoryCalendarConnectionRepository();
      await rateLimitRepository.save({ ...identity, encryptedRefreshToken: encryptRefreshToken("refresh-token"), connectedAt: new Date().toISOString() });
      let requestCount = 0;
      const rateLimited = new GoogleCalendarProvider(rateLimitRepository, async () => {
        requestCount += 1;
        return requestCount === 1
          ? new Response(JSON.stringify({ access_token: "access", expires_in: 3600 }), { status: 200 })
          : new Response(JSON.stringify({ error: { errors: [{ reason: "rateLimitExceeded" }] } }), { status: 429 });
      });
      const rateResult = await new CalendarToolService({ provider: rateLimited }).listUpcomingEvents({}, context);
      assert.equal(rateResult.success, false);
      if (!rateResult.success) assert.equal(rateResult.error.code, "CALENDAR_RATE_LIMITED");
    });
  });

  it("creates calendar events with Google and verifies the returned event resource", async () => {
    await withEnv({ GOOGLE_CALENDAR_CLIENT_ID: "client", GOOGLE_CALENDAR_CLIENT_SECRET: "secret", CALENDAR_TOKEN_ENCRYPTION_KEY: key }, async () => {
      const repository = new InMemoryCalendarConnectionRepository();
      await repository.save({ ...identity, encryptedRefreshToken: encryptRefreshToken("refresh-token"), connectedAt: new Date().toISOString() });
      const calls: Array<{ url: string; init?: RequestInit }> = [];
      const fetcher: typeof fetch = async (input, init) => {
        const url = String(input); calls.push({ url, ...(init ? { init } : {}) });
        if (url.includes("oauth2.googleapis.com")) return new Response(JSON.stringify({ access_token: "access", expires_in: 3600 }), { status: 200 });
        if (url.includes("/events?") && init?.method === "POST") return new Response(JSON.stringify({
          id: "event-confirmed", summary: "Review", status: "confirmed", attendees: [{ email: "lead@example.test" }],
          start: { dateTime: "2026-10-05T10:00:00.000Z" }, end: { dateTime: "2026-10-05T10:30:00.000Z" }
        }), { status: 200 });
        return new Response(JSON.stringify({ error: "unexpected request" }), { status: 500 });
      };
      const provider = new GoogleCalendarProvider(repository, fetcher);
      const event = await provider.createEvent(identity, { title: "Review", attendees: ["lead@example.test"], startTime: "2026-10-05T10:00:00.000Z", endTime: "2026-10-05T10:30:00.000Z" }, "create-event");
      assert.equal(event.id, "event-confirmed");
      assert.equal(event.status, "SCHEDULED");
      assert.equal(calls.find(({ url }) => url.includes("/events?"))?.init?.method, "POST");
      assert.equal(new URL(calls.find(({ url }) => url.includes("/events?"))!.url).searchParams.get("sendUpdates"), "all");
    });
  });

  it("binds OAuth state to the requesting user, encrypts refresh tokens, and disconnects", async () => {
    await withEnv({
      GOOGLE_CALENDAR_CLIENT_ID: "client-id", GOOGLE_CALENDAR_CLIENT_SECRET: "client-secret",
      GOOGLE_CALENDAR_REDIRECT_URI: "http://localhost:5000/api/integrations/google-calendar/callback",
      CALENDAR_TOKEN_ENCRYPTION_KEY: key
    }, async () => {
      const repository = new InMemoryCalendarConnectionRepository();
      const fetcher: typeof fetch = async (input, init) => {
        if (String(input) === "https://oauth2.googleapis.com/token") {
          assert.equal(init?.method, "POST");
          return new Response(JSON.stringify({ access_token: "temporary-access", refresh_token: "long-lived-refresh" }), { status: 200 });
        }
        assert.equal(String(input), "https://www.googleapis.com/calendar/v3/calendars/primary");
        return new Response(JSON.stringify({ id: "primary" }), { status: 200 });
      };
      const oauth = new GoogleCalendarOAuthService(repository, fetcher);
      const authorizationUrl = new URL(oauth.authorizationUrl(identity));
      assert.equal(authorizationUrl.searchParams.get("access_type"), "offline");
      assert.equal(authorizationUrl.searchParams.get("scope"), "https://www.googleapis.com/auth/calendar.events");
      assert.equal(authorizationUrl.searchParams.get("code_challenge_method"), "S256");
      const state = authorizationUrl.searchParams.get("state")!;
      await assert.rejects(oauth.complete("auth-code", "unknown-state"), /could not be verified/);
      await oauth.complete("auth-code", state);
      const status = await oauth.status(identity);
      assert.equal(status.connected, true);
      assert.notEqual((await repository.get(identity.workspaceId, identity.userId))?.encryptedRefreshToken, "long-lived-refresh");
      assert.deepEqual(await oauth.status({ workspaceId: identity.workspaceId, userId: "another-user" }), { connected: false });
      await oauth.disconnect(identity);
      assert.deepEqual(await oauth.status(identity), { connected: false });
    });
  });

  it("creates events through the mock provider and validates event input", async () => {
    const provider = new MockCalendarProvider();
    const calendar = new CalendarToolService({ provider });
    const input = { title: "Planning review", attendees: ["lead@example.test"], startTime: "2026-10-03T10:00:00.000Z", endTime: "2026-10-03T10:30:00.000Z" };
    const created = await calendar.createMeeting(input, { ...context, actionId: "create-event", approvedActionId: "create-event" });
    assert.equal(created.success, true);
    if (created.success) {
      const details = await calendar.getMeeting({ meetingId: created.data.id }, context);
      assert.equal(details.success, true);
    }
    const invalid = await calendar.createMeeting({ ...input, endTime: input.startTime }, { ...context, actionId: "invalid-event", approvedActionId: "invalid-event" });
    assert.equal(invalid.success, false);
    if (!invalid.success) assert.equal(invalid.error.code, "INVALID_INPUT");
  });
});
