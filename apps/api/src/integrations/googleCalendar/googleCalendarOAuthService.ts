import { createHash, randomBytes } from "node:crypto";
import { CalendarConnectionRepository, calendarConnectionRepository } from "./calendarConnectionRepository.js";
import { assertCalendarEncryptionKey, decryptRefreshToken, encryptRefreshToken } from "./calendarProvider.js";

const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE = "https://oauth2.googleapis.com/revoke";
const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events.readonly";
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
    const tokens = await response.json().catch(() => ({})) as { refresh_token?: string; error?: string };
    if (!response.ok || !tokens.refresh_token) {
      throw new GoogleCalendarOAuthError("OAUTH_TOKEN_EXCHANGE_FAILED", "Google did not provide a refresh token. Retry connecting and approve offline access.", 502);
    }
    await this.repository.save({
      workspaceId: pending.workspaceId, userId: pending.userId,
      encryptedRefreshToken: encryptRefreshToken(tokens.refresh_token), connectedAt: new Date(this.now()).toISOString()
    });
    return { workspaceId: pending.workspaceId, userId: pending.userId };
  }

  async status(owner: Owner): Promise<{ connected: boolean; connectedAt?: string }> {
    const connection = await this.repository.get(owner.workspaceId, owner.userId);
    return connection ? { connected: true, connectedAt: connection.connectedAt } : { connected: false };
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
