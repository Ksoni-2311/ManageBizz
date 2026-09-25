import { createHash, randomBytes } from "node:crypto";
import { EmailConnectionRepository, emailConnectionRepository } from "./emailConnectionRepository.js";
import { assertGoogleTokenEncryptionKey, encryptGoogleRefreshToken, decryptGoogleRefreshToken } from "../googleOAuth/tokenEncryption.js";
import { GoogleProviderError } from "../googleOAuth/googleProviderError.js";

const SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
type Owner = { workspaceId: string; userId: string };
type Pending = Owner & { verifier: string; createdAt: number };
export class GmailOAuthService {
  private states = new Map<string, Pending>();
  constructor(private readonly repository: EmailConnectionRepository = emailConnectionRepository, private readonly request: typeof fetch = fetch, private readonly now: () => number = Date.now) {}
  authorizationUrl(owner: Owner) {
    const { clientId, redirectUri } = this.config();
    try { assertGoogleTokenEncryptionKey(); } catch { throw new GoogleProviderError("EMAIL_CONFIGURATION_ERROR", "Configure GOOGLE_TOKEN_ENCRYPTION_KEY with a 32-byte base64 or hex key.", 503); }
    const state = randomBytes(32).toString("base64url"), verifier = randomBytes(48).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    this.expireStates(); this.states.set(state, { ...owner, verifier, createdAt: this.now() });
    return `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: "code", scope: SCOPE, access_type: "offline", include_granted_scopes: "true", prompt: "consent", state, code_challenge: challenge, code_challenge_method: "S256" })}`;
  }
  async complete(code: string, state: string): Promise<Owner> {
    this.expireStates(); const pending = this.states.get(state); this.states.delete(state);
    if (!pending || !code) throw new GoogleProviderError("OAUTH_STATE_INVALID", "Gmail authorization could not be verified.", 400);
    const { clientId, clientSecret, redirectUri } = this.config();
    let response: Response;
    try { response = await this.request("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: "authorization_code", code_verifier: pending.verifier }) }); }
    catch { throw new GoogleProviderError("OAUTH_UNAVAILABLE", "Google authorization service could not be reached.", 503); }
    const tokens = await response.json().catch(() => ({})) as { refresh_token?: string };
    if (!response.ok || !tokens.refresh_token) throw new GoogleProviderError("OAUTH_TOKEN_EXCHANGE_FAILED", "Google did not provide a refresh token. Retry connecting and approve offline access.", 502);
    await this.repository.save({ workspaceId: pending.workspaceId, userId: pending.userId, encryptedRefreshToken: encryptGoogleRefreshToken(tokens.refresh_token), connectedAt: new Date(this.now()).toISOString() });
    return { workspaceId: pending.workspaceId, userId: pending.userId };
  }
  async status(owner: Owner) { const value = await this.repository.get(owner.workspaceId, owner.userId); return value ? { connected: true, connectedAt: value.connectedAt } : { connected: false }; }
  async disconnect(owner: Owner) {
    const connection = await this.repository.get(owner.workspaceId, owner.userId); await this.repository.delete(owner.workspaceId, owner.userId); if (!connection) return;
    try {
      const { clientId, clientSecret } = this.config();
      await this.request("https://oauth2.googleapis.com/revoke", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: decryptGoogleRefreshToken(connection.encryptedRefreshToken), client_id: clientId, client_secret: clientSecret }) });
    } catch { /* Local access is removed even if Google's revoke endpoint is unavailable. */ }
  }
  private config() {
    const clientId = process.env.GOOGLE_GMAIL_CLIENT_ID, clientSecret = process.env.GOOGLE_GMAIL_CLIENT_SECRET, redirectUri = process.env.GOOGLE_GMAIL_REDIRECT_URI;
    if (!clientId || !clientSecret || !redirectUri) throw new GoogleProviderError("EMAIL_CONFIGURATION_ERROR", "Configure GOOGLE_GMAIL_CLIENT_ID, GOOGLE_GMAIL_CLIENT_SECRET, and GOOGLE_GMAIL_REDIRECT_URI.", 503);
    return { clientId, clientSecret, redirectUri };
  }
  private expireStates() { const oldest = this.now() - 600_000; for (const [state, value] of this.states) if (value.createdAt < oldest) this.states.delete(state); }
}
export const gmailOAuthService = new GmailOAuthService();
