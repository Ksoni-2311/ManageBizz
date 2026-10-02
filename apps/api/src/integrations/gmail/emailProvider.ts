import { EmailConnectionRepository, emailConnectionRepository } from "./emailConnectionRepository.js";
import { decryptGoogleRefreshToken } from "../googleOAuth/tokenEncryption.js";
import { GoogleProviderError } from "../googleOAuth/googleProviderError.js";

export type EmailIdentity = { workspaceId: string; userId: string };
export type ProviderEmail = { id: string; threadId?: string | undefined; leadEmail?: string | undefined; direction: "INBOUND" | "OUTBOUND"; subject?: string | undefined; sentAt?: string | undefined; inReplyToMessageId?: string | undefined; messageId?: string | undefined };
export type EmailSearch = { leadEmail?: string | undefined; leadEmails?: string[] | undefined; query?: string | undefined };
export type EmailDraftInput = { to: string; subject: string; body: string };
export type ProviderEmailDraft = EmailDraftInput & { draftId: string; status: "DRAFT" };
export type ProviderSentEmail = { messageId: string; draftId: string; to: string; subject: string; sentAt: string; status: "SENT" };
export interface EmailProvider {
  search(identity: EmailIdentity, query: EmailSearch): Promise<ProviderEmail[]>;
  getMetadata(identity: EmailIdentity, messageId: string): Promise<ProviderEmail | undefined>;
  connectionStatus(identity: EmailIdentity): Promise<{ connected: boolean; reauthorizationRequired?: boolean }>;
  createDraft(identity: EmailIdentity, draft: EmailDraftInput, actionId: string): Promise<ProviderEmailDraft>;
  sendDraft(identity: EmailIdentity, draftId: string, actionId: string): Promise<ProviderSentEmail>;
}

/** Explicit fake provider for deterministic tests; the production singleton never uses it. */
export class MockEmailProvider implements EmailProvider {
  private values = new Map<string, ProviderEmail[]>();
  private drafts = new Map<string, ProviderEmailDraft>();
  private sentActions = new Map<string, ProviderSentEmail>();
  seed(identity: EmailIdentity, messages: ProviderEmail[]) { this.values.set(key(identity), messages.map((message) => ({ ...message }))); }
  async search(identity: EmailIdentity, query: EmailSearch) {
    const values = this.values.get(key(identity)) ?? this.values.get("*\0*") ?? [];
    const addresses = query.leadEmail ? [query.leadEmail.toLowerCase()] : query.leadEmails?.map((email) => email.toLowerCase());
    return values.filter((message) => !addresses || Boolean(message.leadEmail && addresses.includes(message.leadEmail.toLowerCase()))).map((message) => ({ ...message }));
  }
  async getMetadata(identity: EmailIdentity, id: string) { const value = (this.values.get(key(identity)) ?? this.values.get("*\0*") ?? []).find((message) => message.id === id); return value ? { ...value } : undefined; }
  async connectionStatus(identity: EmailIdentity) { return { connected: this.values.has(key(identity)) }; }
  async createDraft(identity: EmailIdentity, draft: EmailDraftInput, actionId: string): Promise<ProviderEmailDraft> {
    const idempotencyKey = `${key(identity)}\0${actionId}`;
    const existing = this.drafts.get(idempotencyKey);
    if (existing) return { ...existing };
    const value: ProviderEmailDraft = { ...draft, draftId: `mock-draft-${actionId}`, status: "DRAFT" };
    this.drafts.set(idempotencyKey, value);
    this.drafts.set(`${key(identity)}\0draft-id\0${value.draftId}`, value);
    return { ...value };
  }
  async sendDraft(identity: EmailIdentity, draftId: string, actionId: string): Promise<ProviderSentEmail> {
    const idempotencyKey = `${key(identity)}\0${actionId}`;
    const previous = this.sentActions.get(idempotencyKey);
    if (previous) return { ...previous };
    const draft = this.drafts.get(`${key(identity)}\0draft-id\0${draftId}`);
    if (!draft) throw new GoogleProviderError("EMAIL_DRAFT_NOT_FOUND", "The requested Gmail draft was not found in this account.", 404);
    const sent: ProviderSentEmail = { messageId: `mock-message-${actionId}`, draftId, to: draft.to, subject: draft.subject, sentAt: new Date().toISOString(), status: "SENT" };
    this.sentActions.set(idempotencyKey, sent);
    this.values.set(key(identity), [...(this.values.get(key(identity)) ?? []), { id: sent.messageId, leadEmail: sent.to, direction: "OUTBOUND", subject: sent.subject, sentAt: sent.sentAt }]);
    return { ...sent };
  }
}

type GmailMessage = { id?: string; threadId?: string; labelIds?: string[]; internalDate?: string; payload?: { headers?: Array<{ name?: string; value?: string }> } };
type GmailThread = { messages?: GmailMessage[] };
type GmailDraftResource = { id?: string; message?: GmailMessage };
const headersToGet = ["From", "To", "Cc", "Subject", "Date", "In-Reply-To", "References", "Message-ID"];

/** Uses metadata format only; message bodies are never requested. */
export class GmailProvider implements EmailProvider {
  private tokens = new Map<string, { value: string; expiresAt: number }>();
  private expired = new Set<string>();
  constructor(private readonly repository: EmailConnectionRepository = emailConnectionRepository, private readonly request: typeof fetch = fetch) {}
  async connectionStatus(identity: EmailIdentity) {
    const connection = await this.repository.get(identity.workspaceId, identity.userId);
    return connection ? { connected: true, ...(this.expired.has(key(identity)) ? { reauthorizationRequired: true } : {}) } : { connected: false };
  }
  async search(identity: EmailIdentity, criteria: EmailSearch): Promise<ProviderEmail[]> {
    const q = buildQuery(criteria), token = await this.accessToken(identity), threads = new Set<string>();
    let pageToken: string | undefined;
    for (let page = 0; page < 10; page++) {
      const query = new URLSearchParams({ q, maxResults: "100", ...(pageToken ? { pageToken } : {}) });
      const response = await this.request(`https://gmail.googleapis.com/gmail/v1/users/me/messages?${query}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) throw await this.apiError(identity, response);
      const result = await response.json() as { messages?: Array<{ threadId?: string }>; nextPageToken?: string };
      for (const message of result.messages ?? []) if (message.threadId) threads.add(message.threadId);
      pageToken = result.nextPageToken;
      if (!pageToken) break;
    }
    if (pageToken) throw new GoogleProviderError("EMAIL_RESULT_LIMIT", "Gmail returned more than 1,000 matching messages; narrow the search.", 413);
    const messages = (await Promise.all([...threads].map(async (threadId) => {
      const params = metadataParams();
      const response = await this.request(`https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(threadId)}?${params}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) throw await this.apiError(identity, response);
      return (await response.json() as GmailThread).messages ?? [];
    }))).flat();
    const ids = new Set(messages.flatMap((message) => message.id ? [message.id] : []));
    return messages.flatMap((message) => {
      if (!message.id) return [];
      const h = headerMap(message), sent = message.labelIds?.includes("SENT") ?? false;
      const from = addresses(h.get("from")), to = [...addresses(h.get("to")), ...addresses(h.get("cc"))];
      const leadEmail = sent ? to.find((email) => !addresses(h.get("from")).includes(email)) : from[0];
      const date = message.internalDate ? new Date(Number(message.internalDate)).toISOString() : validDate(h.get("date"));
      const reply = h.get("in-reply-to")?.replace(/[<>]/g, "").trim();
      return [{ id: message.id, ...(message.threadId ? { threadId: message.threadId } : {}), ...(leadEmail ? { leadEmail } : {}), direction: sent ? "OUTBOUND" as const : "INBOUND" as const,
        ...(h.get("subject") ? { subject: h.get("subject") } : {}), ...(date ? { sentAt: date } : {}), ...(reply && ids.has(reply) ? { inReplyToMessageId: reply } : {}), ...(h.get("message-id") ? { messageId: h.get("message-id") } : {}) }];
    });
  }
  async getMetadata(identity: EmailIdentity, id: string): Promise<ProviderEmail | undefined> {
    const token = await this.accessToken(identity), params = metadataParams();
    const response = await this.request(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?${params}`, { headers: { Authorization: `Bearer ${token}` } });
    if (response.status === 404) return undefined;
    if (!response.ok) throw await this.apiError(identity, response);
    const message = await response.json() as GmailMessage;
    if (!message.id) return undefined;
    const h = headerMap(message), sent = message.labelIds?.includes("SENT") ?? false;
    const contact = sent ? addresses(h.get("to"))[0] : addresses(h.get("from"))[0];
    const date = message.internalDate ? new Date(Number(message.internalDate)).toISOString() : validDate(h.get("date"));
    return { id: message.id, ...(message.threadId ? { threadId: message.threadId } : {}), ...(contact ? { leadEmail: contact } : {}), direction: sent ? "OUTBOUND" : "INBOUND", ...(h.get("subject") ? { subject: h.get("subject") } : {}), ...(date ? { sentAt: date } : {}) };
  }
  async createDraft(identity: EmailIdentity, draft: EmailDraftInput, _actionId: string): Promise<ProviderEmailDraft> {
    const token = await this.accessToken(identity);
    const raw = encodeMimeMessage(draft);
    let response: Response;
    try {
      response = await this.request("https://gmail.googleapis.com/gmail/v1/users/me/drafts", {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ message: { raw } })
      });
    } catch { throw new GoogleProviderError("EMAIL_UNAVAILABLE", "Gmail draft creation could not reach Google.", 503); }
    if (!response.ok) throw await this.apiError(identity, response);
    const result = await response.json() as GmailDraftResource;
    if (!result.id) throw new GoogleProviderError("EMAIL_DRAFT_UNVERIFIED", "Gmail did not return a draft ID; draft creation could not be verified.", 502);
    const verifyResponse = await this.request(`https://gmail.googleapis.com/gmail/v1/users/me/drafts/${encodeURIComponent(result.id)}?${metadataParams()}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!verifyResponse.ok) throw new GoogleProviderError("EMAIL_DRAFT_VERIFICATION_FAILED", "Gmail created a draft but its recipient and subject could not be verified.", 502);
    const verified = await verifyResponse.json() as GmailDraftResource;
    const headers = headerMap(verified.message ?? {});
    const verifiedTo = addresses(headers.get("to"))[0];
    if (verified.id !== result.id || !verified.message?.id || !(verified.message.labelIds ?? []).includes("DRAFT") || verifiedTo !== draft.to.toLowerCase() || headers.get("subject") !== draft.subject) {
      throw new GoogleProviderError("EMAIL_DRAFT_VERIFICATION_FAILED", "The returned Gmail draft did not verify the requested recipient and subject.", 502);
    }
    return { ...draft, to: verifiedTo, subject: headers.get("subject")!, draftId: result.id, status: "DRAFT" };
  }
  async sendDraft(identity: EmailIdentity, draftId: string, _actionId: string): Promise<ProviderSentEmail> {
    const token = await this.accessToken(identity);
    const draftResponse = await this.request(`https://gmail.googleapis.com/gmail/v1/users/me/drafts/${encodeURIComponent(draftId)}?${metadataParams()}`, { headers: { Authorization: `Bearer ${token}` } });
    if (draftResponse.status === 404) throw new GoogleProviderError("EMAIL_DRAFT_NOT_FOUND", "The requested Gmail draft was not found in this account.", 404);
    if (!draftResponse.ok) throw await this.apiError(identity, draftResponse);
    const existingDraft = await draftResponse.json() as GmailDraftResource;
    if (!existingDraft.id || !existingDraft.message?.id) throw new GoogleProviderError("EMAIL_DRAFT_UNVERIFIED", "The Gmail draft could not be verified before sending.", 502);
    const draftHeaders = headerMap(existingDraft.message);
    const to = addresses(draftHeaders.get("to"))[0];
    const subject = draftHeaders.get("subject");
    if (!to || !subject) throw new GoogleProviderError("EMAIL_DRAFT_INVALID", "The Gmail draft is missing a verifiable recipient or subject.", 422);

    const sendResponse = await this.request("https://gmail.googleapis.com/gmail/v1/users/me/drafts/send", {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ id: draftId })
    });
    if (!sendResponse.ok) throw await this.apiError(identity, sendResponse);
    const sent = await sendResponse.json() as GmailMessage;
    if (!sent.id) throw new GoogleProviderError("EMAIL_SEND_UNVERIFIED", "Gmail accepted the send request without returning a message ID.", 502);

    const verificationQuery = new URLSearchParams({ format: "metadata" });
    verificationQuery.append("metadataHeaders", "To");
    verificationQuery.append("metadataHeaders", "Subject");
    const verifyResponse = await this.request(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(sent.id)}?${verificationQuery}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!verifyResponse.ok) throw new GoogleProviderError("EMAIL_SEND_VERIFICATION_FAILED", "Gmail accepted the send request, but the sent message could not be verified.", 502);
    const verifiedMessage = await verifyResponse.json() as GmailMessage;
    const verifiedHeaders = headerMap(verifiedMessage);
    const verifiedTo = addresses(verifiedHeaders.get("to"))[0];
    const verifiedSubject = verifiedHeaders.get("subject");
    if (verifiedMessage.id !== sent.id || verifiedTo !== to || verifiedSubject !== subject || !(verifiedMessage.labelIds ?? []).includes("SENT")) {
      throw new GoogleProviderError("EMAIL_SEND_VERIFICATION_FAILED", "The returned Gmail message did not verify the requested recipient, subject, and sent status.", 502);
    }
    const sentAt = verifiedMessage.internalDate ? new Date(Number(verifiedMessage.internalDate)).toISOString() : undefined;
    if (!sentAt || !Number.isFinite(Date.parse(sentAt))) {
      throw new GoogleProviderError("EMAIL_SEND_VERIFICATION_FAILED", "Gmail returned no verifiable sent timestamp; the send outcome could not be fully verified.", 502);
    }
    return { messageId: sent.id, draftId, to, subject, sentAt, status: "SENT" };
  }
  private async accessToken(identity: EmailIdentity): Promise<string> {
    const id = key(identity), connection = await this.repository.get(identity.workspaceId, identity.userId);
    if (!connection) throw new GoogleProviderError("EMAIL_NOT_CONNECTED", "Gmail is not connected for this workspace.", 409);
    const cached = this.tokens.get(id);
    if (!this.expired.has(id) && cached && cached.expiresAt > Date.now() + 60_000) return cached.value;
    const clientId = process.env.GOOGLE_GMAIL_CLIENT_ID, clientSecret = process.env.GOOGLE_GMAIL_CLIENT_SECRET;
    if (!clientId || !clientSecret) throw new GoogleProviderError("EMAIL_CONFIGURATION_ERROR", "Gmail integration is not configured.", 503);
    let response: Response;
    try { response = await this.request("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: decryptGoogleRefreshToken(connection.encryptedRefreshToken), grant_type: "refresh_token" }) }); }
    catch { throw new GoogleProviderError("EMAIL_UNAVAILABLE", "Google authorization service could not be reached.", 503); }
    if (!response.ok) {
      const error = await response.json().catch(() => ({})) as { error?: string };
      if (error.error === "invalid_grant") { this.expired.add(id); throw new GoogleProviderError("EMAIL_AUTH_EXPIRED", "Gmail authorization expired. Reconnect Gmail.", 401); }
      throw new GoogleProviderError("EMAIL_AUTH_ERROR", "Gmail authorization could not be refreshed.", response.status);
    }
    const data = await response.json() as { access_token?: string; expires_in?: number };
    if (!data.access_token) throw new GoogleProviderError("EMAIL_AUTH_ERROR", "Google did not return an access token.", 502);
    this.tokens.set(id, { value: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 }); this.expired.delete(id);
    return data.access_token;
  }
  private async apiError(identity: EmailIdentity, response: Response) {
    if (response.status === 401) { this.expired.add(key(identity)); return new GoogleProviderError("EMAIL_AUTH_EXPIRED", "Gmail authorization expired. Reconnect Gmail.", 401); }
    if (response.status === 429) return new GoogleProviderError("EMAIL_RATE_LIMITED", "Gmail is rate limited. Try again later.", 429);
    if (response.status === 403) return new GoogleProviderError("EMAIL_API_ERROR", "Google denied this Gmail read request.", 403);
    return new GoogleProviderError("EMAIL_API_ERROR", "Gmail request failed.", response.status || 502);
  }
}

function buildQuery(criteria: EmailSearch): string {
  const explicit = criteria.query?.trim();
  const emails = criteria.leadEmail ? [criteria.leadEmail] : criteria.leadEmails;
  const addressQuery = emails?.length ? `(${emails.map((email) => `(from:${email} OR to:${email})`).join(" OR ")})` : undefined;
  if (!explicit && !addressQuery) throw new GoogleProviderError("INVALID_INPUT", "Provide a lead email or Gmail search query; whole-mailbox search is not allowed.", 400);
  return [explicit, addressQuery].filter(Boolean).join(" ");
}
function metadataParams() { const params = new URLSearchParams({ format: "metadata" }); for (const header of headersToGet) params.append("metadataHeaders", header); return params; }
function headerMap(message: GmailMessage) { return new Map((message.payload?.headers ?? []).flatMap(({ name, value }) => name && value ? [[name.toLowerCase(), value] as const] : [])); }
function addresses(value?: string) { return value?.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)?.map((email) => email.toLowerCase()) ?? []; }
function validDate(value?: string) { return value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined; }
function key(identity: EmailIdentity) { return `${identity.workspaceId}\0${identity.userId}`; }
function encodeMimeMessage(draft: EmailDraftInput): string {
  const safeSubject = draft.subject.replace(/[\r\n]/g, " ");
  const mime = `To: ${draft.to}\r\nSubject: ${safeSubject}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(draft.body, "utf8").toString("base64")}`;
  return Buffer.from(mime, "utf8").toString("base64url");
}
