import { ToolExecutionContext, ToolResponse } from "@nexusops/shared-types";
import { z } from "zod";
import { emailAddress, nonEmpty, runValidated, ToolDomainError } from "./contract.js";
import { EmailIdentity, EmailProvider, EmailSearch, GmailProvider, MockEmailProvider, ProviderEmail } from "../integrations/gmail/emailProvider.js";
import { GoogleProviderError } from "../integrations/googleOAuth/googleProviderError.js";

const historySchema = z.object({ leadEmail: emailAddress.optional(), leadEmails: z.array(emailAddress).max(500).optional(), query: z.string().trim().min(1).max(500).optional() }).strict()
  .refine(({ leadEmail, leadEmails }) => !(leadEmail && leadEmails), "Use leadEmail or leadEmails, not both")
  .refine(({ leadEmails }) => !leadEmails || new Set(leadEmails.map((email) => email.toLowerCase())).size === leadEmails.length, "leadEmails must be unique")
const metadataSchema = z.object({ messageId: nonEmpty.max(500) }).strict();
const emailSchema = z.object({ to: emailAddress, subject: nonEmpty, body: nonEmpty }).strict();
const sendSchema = emailSchema.extend({ draftId: nonEmpty.optional() }).strict();
const messageSchema = z.object({ id: nonEmpty, threadId: nonEmpty.optional(), leadEmail: emailAddress.optional(), direction: z.enum(["OUTBOUND", "INBOUND"]), subject: nonEmpty.optional(), sentAt: z.string().datetime().optional(), inReplyToMessageId: nonEmpty.optional(), messageId: nonEmpty.optional() }).strict();
const messagesSchema = z.array(messageSchema);
type StoredMessage = z.infer<typeof messageSchema>;
export type EmailHistoryMessage = StoredMessage & { responseStatus: "INBOUND" | "ANSWERED" | "UNANSWERED" };
type Draft = { draftId: string; to: string; subject: string; body: string; status: "DRAFT" };
const emptyContext: ToolExecutionContext = { goalId: "", runId: "", actionId: "", userId: "", orgId: "" };

/** Email domain logic delegates reads to an injected provider; it never synthesizes records. */
export class EmailService {
  constructor(private readonly provider: EmailProvider) {}
  async history(identity: EmailIdentity, query: EmailSearch): Promise<EmailHistoryMessage[]> {
    const records = messagesSchema.parse(await this.provider.search(identity, query));
    assertUnique(records);
    return records.map((message) => ({ ...message, responseStatus: responseStatus(message, records) }));
  }
  async unanswered(identity: EmailIdentity, query: EmailSearch): Promise<EmailHistoryMessage[]> {
    return (await this.history(identity, query)).filter((message) => message.responseStatus === "UNANSWERED");
  }
  async metadata(identity: EmailIdentity, id: string): Promise<ProviderEmail | undefined> {
    const record = await this.provider.getMetadata(identity, id);
    return record ? messageSchema.parse(record) : undefined;
  }
  status(identity: EmailIdentity) { return this.provider.connectionStatus(identity); }
}

export class EmailToolService {
  private drafts = new Map<string, Draft>();
  private readonly service: EmailService;
  constructor(private readonly provider: EmailProvider = new MockEmailProvider()) { this.service = new EmailService(provider); }
  /** Test-only seeding is available only when explicitly using MockEmailProvider. */
  setMessages(rows: readonly unknown[]): void {
    const messages = messagesSchema.parse(rows); assertUnique(messages);
    if (!(this.provider instanceof MockEmailProvider)) throw new ToolDomainError("INVALID_DATA", "Messages can only be seeded into the explicit mock provider.");
    this.provider.seed({ workspaceId: "*", userId: "*" }, messages);
  }
  getEmailHistory(params: unknown, context: ToolExecutionContext): Promise<ToolResponse<EmailHistoryMessage[]>> {
    return runValidated(historySchema, params, context, async (query) => this.translate(() => this.service.history(identity(context), query)));
  }
  getUnansweredMessages(params: unknown, context: ToolExecutionContext): Promise<ToolResponse<EmailHistoryMessage[]>> {
    return runValidated(historySchema, params, context, async (query) => this.translate(() => this.service.unanswered(identity(context), query)));
  }
  getEmailMetadata(params: unknown, context: ToolExecutionContext): Promise<ToolResponse<ProviderEmail | null>> {
    return runValidated(metadataSchema, params, context, async ({ messageId }) => (await this.translate(() => this.service.metadata(identity(context), messageId))) ?? null);
  }
  connectionStatus(context: ToolExecutionContext) { return this.service.status(identity(context)); }
  private async translate<T>(run: () => Promise<T>): Promise<T> {
    try { return await run(); }
    catch (error) {
      if (error instanceof GoogleProviderError) throw new ToolDomainError(error.code, error.message);
      throw error;
    }
  }
  draftEmail(params: unknown, context: ToolExecutionContext): Promise<ToolResponse<Draft>> {
    return runValidated(emailSchema, params, context, ({ to, subject, body }) => { const draftId = `draft-${context.actionId}`; const draft = { draftId, to, subject, body, status: "DRAFT" as const }; this.drafts.set(draftId, draft); return { ...draft }; });
  }
  sendEmail(params: unknown, context: ToolExecutionContext): Promise<ToolResponse<never>> {
    return runValidated(sendSchema, params, context, ({ draftId }) => {
      if (draftId && !this.drafts.has(draftId)) throw new ToolDomainError("NOT_FOUND", `Draft '${draftId}' was not found.`);
      throw new ToolDomainError("INTEGRATION_UNAVAILABLE", "Email sending is disabled; no message was sent.");
    });
  }
}
function responseStatus(message: StoredMessage, records: StoredMessage[]): EmailHistoryMessage["responseStatus"] {
  if (message.direction === "INBOUND") return "INBOUND";
  const repliedByReference = records.some((candidate) => candidate.direction === "INBOUND" && candidate.inReplyToMessageId === message.id);
  const repliedInThread = Boolean(message.threadId && message.sentAt && records.some((candidate) => candidate.direction === "INBOUND" && candidate.threadId === message.threadId && candidate.sentAt && candidate.sentAt > message.sentAt!));
  return repliedByReference || repliedInThread ? "ANSWERED" : "UNANSWERED";
}
function assertUnique(messages: readonly StoredMessage[]) { const ids = new Set<string>(); for (const message of messages) { if (ids.has(message.id)) throw new ToolDomainError("INVALID_DATA", `Duplicate email message identity: ${message.id}`); ids.add(message.id); } }
function identity(context: ToolExecutionContext): EmailIdentity { return { workspaceId: context.orgId, userId: context.userId }; }

// Production explicitly binds Gmail: an unconnected Gmail account never falls back to dummy data.
export const EmailTool = new EmailToolService(new GmailProvider());
