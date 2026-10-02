import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { CalendarConnectionRepository, calendarConnectionRepository } from "./calendarConnectionRepository.js";

export type CalendarIdentity = { workspaceId: string; userId: string };
export type CalendarEvent = {
  id: string;
  title: string;
  attendees: string[];
  startTime: string;
  endTime: string;
  status: "SCHEDULED" | "CANCELLED";
  description?: string;
  location?: string;
};
export type CalendarListQuery = { from?: string; until?: string };
export type CalendarEventInput = { title: string; attendees: string[]; startTime: string; endTime: string; description?: string | undefined; location?: string | undefined };
export interface CalendarProvider {
  listUpcomingEvents(identity: CalendarIdentity, query: CalendarListQuery): Promise<CalendarEvent[]>;
  findEventsForLead(identity: CalendarIdentity, leadEmail: string): Promise<CalendarEvent[]>;
  getEventDetails(identity: CalendarIdentity, eventId: string): Promise<CalendarEvent | undefined>;
  connectionStatus(identity: CalendarIdentity): Promise<{ connected: boolean; reauthorizationRequired?: boolean }>;
  createEvent(identity: CalendarIdentity, event: CalendarEventInput, actionId: string): Promise<CalendarEvent>;
}

export class CalendarProviderError extends Error {
  constructor(readonly code: string, message: string, readonly status = 503) { super(message); }
}

export class MockCalendarProvider implements CalendarProvider {
  private readonly events = new Map<string, CalendarEvent[]>();
  private readonly createdByAction = new Map<string, CalendarEvent>();
  seed(identity: CalendarIdentity, events: CalendarEvent[]): void {
    this.events.set(key(identity), events.map((event) => ({ ...event, attendees: [...event.attendees] })));
  }
  async listUpcomingEvents(identity: CalendarIdentity, query: CalendarListQuery): Promise<CalendarEvent[]> {
    const start = query.from ? Date.parse(query.from) : Date.now();
    const end = query.until ? Date.parse(query.until) : Number.POSITIVE_INFINITY;
    return (this.events.get(key(identity)) ?? []).filter((event) => event.status === "SCHEDULED" && Date.parse(event.startTime) >= start && Date.parse(event.startTime) < end)
      .sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime)).map(cloneEvent);
  }
  async findEventsForLead(identity: CalendarIdentity, leadEmail: string): Promise<CalendarEvent[]> {
    const needle = leadEmail.toLocaleLowerCase("en-US");
    return (this.events.get(key(identity)) ?? []).filter((event) => event.attendees.some((email) => email.toLocaleLowerCase("en-US") === needle)).map(cloneEvent);
  }
  async getEventDetails(identity: CalendarIdentity, eventId: string): Promise<CalendarEvent | undefined> {
    const event = (this.events.get(key(identity)) ?? []).find(({ id }) => id === eventId);
    return event ? cloneEvent(event) : undefined;
  }
  async connectionStatus(identity: CalendarIdentity): Promise<{ connected: boolean }> {
    return { connected: this.events.has(key(identity)) };
  }
  async createEvent(identity: CalendarIdentity, input: CalendarEventInput, actionId: string): Promise<CalendarEvent> {
    const actionKey = `${key(identity)}\0${actionId}`;
    const previous = this.createdByAction.get(actionKey);
    if (previous) return cloneEvent(previous);
    const event: CalendarEvent = {
      id: `mock-event-${actionId}`, title: input.title, startTime: input.startTime, endTime: input.endTime,
      status: "SCHEDULED", attendees: [...input.attendees],
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.location === undefined ? {} : { location: input.location })
    };
    const scopedKey = key(identity);
    this.events.set(scopedKey, [...(this.events.get(scopedKey) ?? []), event]);
    this.createdByAction.set(actionKey, event);
    return cloneEvent(event);
  }
}

type GoogleEventResource = {
  id?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  status?: string;
  attendees?: Array<{ email?: string }>;
};

type GoogleEventList = { items?: GoogleEventResource[]; nextPageToken?: string };

export class GoogleCalendarProvider implements CalendarProvider {
  private readonly accessTokens = new Map<string, { token: string; expiresAt: number }>();
  private readonly reauthorizationRequired = new Set<string>();
  constructor(
    private readonly repository: CalendarConnectionRepository = calendarConnectionRepository,
    private readonly request: typeof fetch = fetch
  ) {}

  async listUpcomingEvents(identity: CalendarIdentity, query: CalendarListQuery): Promise<CalendarEvent[]> {
    const events = await this.listEvents(identity, {
      timeMin: query.from ?? new Date().toISOString(),
      ...(query.until ? { timeMax: query.until } : {}),
      singleEvents: "true", orderBy: "startTime", showDeleted: "false", maxResults: "250"
    });
    return events.map(mapEvent).filter((event): event is CalendarEvent => Boolean(event)).filter(({ status }) => status === "SCHEDULED");
  }

  async findEventsForLead(identity: CalendarIdentity, leadEmail: string): Promise<CalendarEvent[]> {
    const events = await this.listEvents(identity, { q: leadEmail, showDeleted: "false", maxResults: "250" });
    const email = leadEmail.toLocaleLowerCase("en-US");
    return events.map(mapEvent).filter((event): event is CalendarEvent => event !== undefined && event.attendees.some((attendee) => attendee.toLocaleLowerCase("en-US") === email));
  }

  async getEventDetails(identity: CalendarIdentity, eventId: string): Promise<CalendarEvent | undefined> {
    const token = await this.accessToken(identity);
    const response = await this.request(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (response.status === 404) return undefined;
    if (!response.ok) throw this.recordAuthError(identity, await this.googleError(response));
    const event = mapEvent(await response.json() as GoogleEventResource);
    return event;
  }

  async connectionStatus(identity: CalendarIdentity): Promise<{ connected: boolean; reauthorizationRequired?: boolean }> {
    const connection = await this.repository.get(identity.workspaceId, identity.userId);
    return connection ? { connected: true, ...(this.reauthorizationRequired.has(key(identity)) ? { reauthorizationRequired: true } : {}) } : { connected: false };
  }

  async createEvent(identity: CalendarIdentity, event: CalendarEventInput, _actionId: string): Promise<CalendarEvent> {
    const token = await this.accessToken(identity);
    const query = new URLSearchParams({ sendUpdates: event.attendees.length ? "all" : "none" });
    const body = {
      summary: event.title,
      start: { dateTime: event.startTime },
      end: { dateTime: event.endTime },
      attendees: event.attendees.map((email) => ({ email })),
      ...(event.description ? { description: event.description } : {}),
      ...(event.location ? { location: event.location } : {})
    };
    let response: Response;
    try {
      response = await this.request(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${query}`, {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body)
      });
    } catch { throw new CalendarProviderError("CALENDAR_UNAVAILABLE", "Google Calendar event creation could not reach Google.", 503); }
    if (!response.ok) throw this.recordAuthError(identity, await this.googleError(response));
    const resource = await response.json() as GoogleEventResource;
    const created = mapEvent(resource);
    if (!created || created.status !== "SCHEDULED" || created.title !== event.title || created.startTime !== new Date(event.startTime).toISOString() || created.endTime !== new Date(event.endTime).toISOString()) {
      throw new CalendarProviderError("CALENDAR_CREATE_UNVERIFIED", "Google returned an event that did not verify the requested event details.", 502);
    }
    const requestedAttendees = event.attendees.map((email) => email.toLocaleLowerCase("en-US")).sort();
    const actualAttendees = created.attendees.map((email) => email.toLocaleLowerCase("en-US")).sort();
    if (JSON.stringify(requestedAttendees) !== JSON.stringify(actualAttendees)) {
      throw new CalendarProviderError("CALENDAR_CREATE_UNVERIFIED", "Google returned an event with attendees that did not match the requested event.", 502);
    }
    return created;
  }

  private async listEvents(identity: CalendarIdentity, params: Record<string, string>): Promise<GoogleEventResource[]> {
    const token = await this.accessToken(identity);
    const all: GoogleEventResource[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const query = new URLSearchParams({ ...params, ...(pageToken ? { pageToken } : {}) });
      const response = await this.request(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${query.toString()}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!response.ok) throw this.recordAuthError(identity, await this.googleError(response));
      const result = await response.json() as GoogleEventList;
      all.push(...(result.items ?? []));
      pageToken = result.nextPageToken;
      if (!pageToken) break;
    }
    if (pageToken) throw new CalendarProviderError("CALENDAR_RESULT_LIMIT", "Calendar returned more than 2,500 matching events; narrow the requested time range.", 413);
    return all;
  }

  private async accessToken(identity: CalendarIdentity): Promise<string> {
    const cacheKey = key(identity);
    const connection = await this.repository.get(identity.workspaceId, identity.userId);
    if (!connection) throw new CalendarProviderError("CALENDAR_NOT_CONNECTED", "Google Calendar is not connected for this workspace.", 409);
    const cached = this.accessTokens.get(cacheKey);
    if (!this.reauthorizationRequired.has(cacheKey) && cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
    const refreshToken = decryptRefreshToken(connection.encryptedRefreshToken);
    const clientId = process.env.GOOGLE_CALENDAR_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CALENDAR_CLIENT_SECRET;
    if (!clientId || !clientSecret) throw new CalendarProviderError("CALENDAR_CONFIGURATION_ERROR", "Google Calendar integration is not configured.", 503);
    let response: Response;
    try {
      response = await this.request("https://oauth2.googleapis.com/token", {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" })
      });
    } catch {
      throw new CalendarProviderError("CALENDAR_UNAVAILABLE", "Google authorization service could not be reached.", 503);
    }
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (body.error === "invalid_grant") {
        this.reauthorizationRequired.add(cacheKey);
        throw new CalendarProviderError("CALENDAR_AUTH_EXPIRED", "Google Calendar authorization expired. Reconnect the calendar.", 401);
      }
      throw new CalendarProviderError("CALENDAR_AUTH_ERROR", "Google Calendar authorization could not be refreshed.", response.status);
    }
    const token = await response.json() as { access_token?: string; expires_in?: number };
    if (!token.access_token) throw new CalendarProviderError("CALENDAR_AUTH_ERROR", "Google did not return an access token.", 502);
    this.accessTokens.set(cacheKey, { token: token.access_token, expiresAt: Date.now() + (token.expires_in ?? 3600) * 1000 });
    this.reauthorizationRequired.delete(cacheKey);
    return token.access_token;
  }

  private async googleError(response: Response): Promise<CalendarProviderError> {
    const body = await response.json().catch(() => ({})) as { error?: { message?: string; errors?: Array<{ reason?: string }> } };
    const reason = body.error?.errors?.[0]?.reason;
    if (response.status === 401) return new CalendarProviderError("CALENDAR_AUTH_EXPIRED", "Google Calendar authorization expired. Reconnect the calendar.", 401);
    if (response.status === 403 || response.status === 429) {
      if (response.status === 429 || reason?.toLowerCase().includes("ratelimit") || reason?.toLowerCase().includes("quota")) {
        return new CalendarProviderError("CALENDAR_RATE_LIMITED", "Google Calendar is rate limited. Try again later.", 429);
      }
      return new CalendarProviderError("CALENDAR_API_ERROR", "Google Calendar denied this request.", 403);
    }
    return new CalendarProviderError("CALENDAR_API_ERROR", body.error?.message ?? "Google Calendar request failed.", response.status || 502);
  }

  private recordAuthError(identity: CalendarIdentity, error: CalendarProviderError): CalendarProviderError {
    if (error.code === "CALENDAR_AUTH_EXPIRED") this.reauthorizationRequired.add(key(identity));
    return error;
  }
}

export function mapEvent(resource: GoogleEventResource): CalendarEvent | undefined {
  if (!resource.id || !resource.start || !resource.end) return undefined;
  const startTime = resource.start.dateTime ?? dateOnlyToUtc(resource.start.date);
  const endTime = resource.end.dateTime ?? dateOnlyToUtc(resource.end.date);
  if (!startTime || !endTime) return undefined;
  return {
    id: resource.id,
    title: resource.summary?.trim() ?? "",
    attendees: (resource.attendees ?? []).flatMap(({ email }) => email ? [email] : []),
    startTime: new Date(startTime).toISOString(), endTime: new Date(endTime).toISOString(),
    status: resource.status === "cancelled" ? "CANCELLED" : "SCHEDULED",
    ...(resource.description ? { description: resource.description } : {}),
    ...(resource.location ? { location: resource.location } : {})
  };
}

function dateOnlyToUtc(value?: string): string | undefined {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00.000Z` : undefined;
}
function cloneEvent(event: CalendarEvent): CalendarEvent { return { ...event, attendees: [...event.attendees] }; }
function key(identity: CalendarIdentity): string { return `${identity.workspaceId}\0${identity.userId}`; }

function encryptionKey(): Buffer {
  const value = process.env.CALENDAR_TOKEN_ENCRYPTION_KEY ?? "";
  const key = /^[a-f0-9]{64}$/i.test(value) ? Buffer.from(value, "hex") : Buffer.from(value, "base64");
  if (key.length !== 32) throw new CalendarProviderError("CALENDAR_CONFIGURATION_ERROR", "Set CALENDAR_TOKEN_ENCRYPTION_KEY to a 32-byte base64 or 64-character hex key.", 503);
  return key;
}

export function encryptRefreshToken(token: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return `${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${ciphertext.toString("base64url")}`;
}
export function decryptRefreshToken(value: string): string {
  try {
    const [iv, tag, ciphertext] = value.split(".").map((part) => Buffer.from(part!, "base64url"));
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv!);
    decipher.setAuthTag(tag!);
    return Buffer.concat([decipher.update(ciphertext!), decipher.final()]).toString("utf8");
  } catch {
    throw new CalendarProviderError("CALENDAR_CONFIGURATION_ERROR", "Stored Google Calendar credentials could not be decrypted.", 503);
  }
}
export function assertCalendarEncryptionKey(): void { encryptionKey(); }
