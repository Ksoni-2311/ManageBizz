import { createHash, randomBytes } from "node:crypto";
import { CalendarConnectionRepository, calendarConnectionRepository } from "./calendarConnectionRepository.js";
import { assertCalendarEncryptionKey, decryptRefreshToken, encryptRefreshToken } from "./calendarProvider.js";

const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE = "https://oauth2.googleapis.com/revoke";
const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events";
type Owner = { workspaceId: string; userId: string };
type OAuthState = Owner & { createdAt: number; verifier: string };

export class GoogleCalendarOAuthError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); }
}

export class GoogleCalendarOAuthService {
  private readonly states = new Map<string, OAuthState>();
  constructor(
    private readonly repository: CalendarConnectionRepository = calendarConnectionRepository,
    private readonly request: typeof fetch = fetch,
    private readonly now: () => number = Date.now
  ) {}

  authorizationUrl(owner: Owner): string {
    const { clientId, redirectUri } = this.requireConfig();
    try { assertCalendarEncryptionKey(); }
    catch { throw new GoogleCalendarOAuthError("CALENDAR_CONFIGURATION_ERROR", "Configure CALENDAR_TOKEN_ENCRYPTION_KEY with a 32-byte base64 or hex key.", 503); }
    const state = randomBytes(32).toString("base64url");
    const verifier = randomBytes(48).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    this.expireStates();
    this.states.set(state, { ...owner, verifier, createdAt: this.now() });
    const query = new URLSearchParams({
      client_id: clientId, redirect_uri: redirectUri, response_type: "code", scope: CALENDAR_SCOPE,
      access_type: "offline", include_granted_scopes: "true", prompt: "consent", state, code_challenge: challenge,
      code_challenge_method: "S256"
    });
    return `${GOOGLE_AUTH}?${query.toString()}`;
  }

  async complete(code: string, state: string): Promise<Owner> {
    this.expireStates();
    const pending = this.states.get(state);
    this.states.delete(state);
    if (!pending || !code) throw new GoogleCalendarOAuthError("OAUTH_STATE_INVALID", "Google Calendar authorization could not be verified.", 400);
    const { clientId, clientSecret, redirectUri } = this.requireConfig();
    let response: Response;
    try {
      response = await this.request(GOOGLE_TOKEN, {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri,
          grant_type: "authorization_code", code_verifier: pending.verifier })
      });
    } catch {
      throw new GoogleCalendarOAuthError("OAUTH_UNAVAILABLE", "Google authorization service could not be reached.", 503);
    }
    const tokens = await response.json().catch(() => ({})) as { access_token?: string; refresh_token?: string; error?: string };
    if (!response.ok || !tokens.access_token) throw new GoogleCalendarOAuthError("OAUTH_TOKEN_EXCHANGE_FAILED", "Google did not provide an access token to verify Calendar access.", 502);
    const existing = await this.repository.get(pending.workspaceId, pending.userId);
    const encryptedRefreshToken = tokens.refresh_token
      ? encryptRefreshToken(tokens.refresh_token)
      : existing?.encryptedRefreshToken;
    if (!encryptedRefreshToken) throw new GoogleCalendarOAuthError("OAUTH_TOKEN_EXCHANGE_FAILED", "Google did not provide a refresh token. Retry connecting and approve offline access.", 502);
    try {
      const verification = await this.request("https://www.googleapis.com/calendar/v3/calendars/primary", {
        headers: { Authorization: `Bearer ${tokens.access_token}` }
      });
      if (!verification.ok) {
        const body = await verification.json().catch(() => ({})) as { error?: { status?: string; errors?: Array<{ reason?: string }> } };
        const reasons = body.error?.errors?.map(({ reason }) => reason?.toLowerCase()) ?? [];
        const code = verification.status === 401 ? "CALENDAR_AUTH_EXPIRED"
          : reasons.some((reason) => reason === "insufficientpermissions" || reason === "insufficient_scope") ? "CALENDAR_AUTH_REQUIRED"
          : verification.status === 403 && (reasons.some((reason) => reason === "forbidden" || reason === "permissiondenied" || reason === "accessdenied") || body.error?.status?.toLowerCase() === "permission_denied") ? "CALENDAR_ACCESS_DENIED"
          : "CALENDAR_API_ERROR";
        const message = code === "CALENDAR_AUTH_REQUIRED" ? "Google denied Calendar access because the required authorization scope is missing. Reconnect and approve the requested access."
          : code === "CALENDAR_ACCESS_DENIED" ? "Google denied access to this calendar."
          : code === "CALENDAR_AUTH_EXPIRED" ? "Google Calendar authorization expired. Reconnect the calendar."
          : "Google Calendar access could not be verified.";
        throw new GoogleCalendarOAuthError(code, message, verification.status);
      }
    } catch (error) {
      const calendarError = error instanceof GoogleCalendarOAuthError
        ? error
        : new GoogleCalendarOAuthError("CALENDAR_UNAVAILABLE", "Calendar access could not be verified because Google could not be reached.", 503);
      if (existing) await this.repository.save({ ...existing, health: healthForError(calendarError.code) });
      throw calendarError;
    }
    await this.repository.save({
      workspaceId: pending.workspaceId, userId: pending.userId,
      encryptedRefreshToken, connectedAt: new Date(this.now()).toISOString(),
      tokenVersion: randomBytes(16).toString("hex"), health: "verified"
    });
    return { workspaceId: pending.workspaceId, userId: pending.userId };
  }

  async status(owner: Owner): Promise<{ connected: boolean; connectedAt?: string; reauthorizationRequired?: boolean; accessDenied?: boolean; unavailable?: boolean }> {
    const connection = await this.repository.get(owner.workspaceId, owner.userId);
    if (!connection) return { connected: false };
    return {
      connected: true,
      connectedAt: connection.connectedAt,
      ...(connection.health === "reauthorization_required" ? { reauthorizationRequired: true } : {}),
      ...(connection.health === "access_denied" ? { accessDenied: true } : {}),
      ...(connection.health !== "verified" && connection.health !== "reauthorization_required" && connection.health !== "access_denied" ? { unavailable: true } : {})
    };
  }

  async disconnect(owner: Owner): Promise<void> {
    const connection = await this.repository.get(owner.workspaceId, owner.userId);
    await this.repository.delete(owner.workspaceId, owner.userId);
    if (!connection) return;
    try {
      const { clientId, clientSecret } = this.requireConfig();
      const token = decryptForRevoke(connection.encryptedRefreshToken);
      await this.request(GOOGLE_REVOKE, {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token, client_id: clientId, client_secret: clientSecret })
      });
    } catch {
      // Local access is removed even if Google's revoke endpoint is unavailable.
    }
  }

  private requireConfig(): { clientId: string; clientSecret: string; redirectUri: string } {
    const clientId = process.env.GOOGLE_CALENDAR_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CALENDAR_CLIENT_SECRET;
    const redirectUri = process.env.GOOGLE_CALENDAR_REDIRECT_URI;
    if (!clientId || !clientSecret || !redirectUri) {
      throw new GoogleCalendarOAuthError("CALENDAR_CONFIGURATION_ERROR", "Configure GOOGLE_CALENDAR_CLIENT_ID, GOOGLE_CALENDAR_CLIENT_SECRET, and GOOGLE_CALENDAR_REDIRECT_URI.", 503);
    }
    return { clientId, clientSecret, redirectUri };
  }

  private expireStates(): void {
    const oldest = this.now() - 10 * 60 * 1000;
    for (const [state, value] of this.states) if (value.createdAt < oldest) this.states.delete(state);
  }
}

const decryptForRevoke = decryptRefreshToken;

export const googleCalendarOAuthService = new GoogleCalendarOAuthService();

function healthForError(code: string): "reauthorization_required" | "access_denied" | "unavailable" {
  if (code === "CALENDAR_AUTH_EXPIRED" || code === "CALENDAR_AUTH_REQUIRED") return "reauthorization_required";
  if (code === "CALENDAR_ACCESS_DENIED") return "access_denied";
  return "unavailable";
}
