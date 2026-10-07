import { ToolExecutionContext, ToolResponse } from "@nexusops/shared-types";
import { z } from "zod";
import { emailAddress, nonEmpty, requireApprovedAction, runValidated, ToolDomainError } from "./contract.js";
import { EmailContent, EmailDraftInput, EmailIdentity, EmailProvider, EmailSearch, GmailProvider, MockEmailProvider, ProviderEmail, ProviderEmailDraft, ProviderSentEmail } from "../integrations/gmail/emailProvider.js";
import { GoogleProviderError } from "../integrations/googleOAuth/googleProviderError.js";

const historySchema = z.object({ leadEmail: emailAddress.optional(), leadEmails: z.array(emailAddress).max(500).optional(), query: z.string().trim().min(1).max(500).optional() }).strict()
  .refine(({ leadEmail, leadEmails }) => !(leadEmail && leadEmails), "Use leadEmail or leadEmails, not both")
  .refine(({ leadEmails }) => !leadEmails || new Set(leadEmails.map((email) => email.toLowerCase())).size === leadEmails.length, "leadEmails must be unique")
const metadataSchema = z.object({ messageId: nonEmpty.max(500) }).strict();
const contentSearchSchema = z.object({ leadEmail: emailAddress.optional(), query: z.string().trim().min(1).max(500), limit: z.number().int().min(1).max(5).default(5) }).strict();
const emailSchema = z.object({ to: emailAddress, subject: nonEmpty.max(998).refine((value) => !/[\r\n]/.test(value), "Subject cannot contain line breaks."), body: nonEmpty.max(100_000) }).strict();
const sendSchema = z.object({ draftId: nonEmpty.max(500) }).strict();
const messageSchema = z.object({ id: nonEmpty, threadId: nonEmpty.optional(), leadEmail: emailAddress.optional(), direction: z.enum(["OUTBOUND", "INBOUND"]), subject: nonEmpty.optional(), sentAt: z.string().datetime().optional(), inReplyToMessageId: nonEmpty.optional(), messageId: nonEmpty.optional() }).strict();
const messagesSchema = z.array(messageSchema);
type StoredMessage = z.infer<typeof messageSchema>;
export type EmailHistoryMessage = StoredMessage & { responseStatus: "INBOUND" | "ANSWERED" | "UNANSWERED" };
type Draft = ProviderEmailDraft;
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
  createDraft(identity: EmailIdentity, draft: EmailDraftInput, actionId: string) { return this.provider.createDraft(identity, draft, actionId); }
  sendDraft(identity: EmailIdentity, draftId: string, actionId: string) { return this.provider.sendDraft(identity, draftId, actionId); }
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
  getEmailContent(params: unknown, context: ToolExecutionContext): Promise<ToolResponse<EmailContent[]>> {
    return runValidated(contentSearchSchema, params, context, ({ leadEmail, query, limit }) =>
      this.translate(() => this.provider.searchContent(identity(context), { ...(leadEmail ? { leadEmail } : {}), query }, limit ?? 5)));
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
    return runValidated(emailSchema, params, context, (draft) => { requireApprovedAction(context); return this.translate(() => this.service.createDraft(identity(context), draft, context.actionId)); });
  }
  sendEmail(params: unknown, context: ToolExecutionContext): Promise<ToolResponse<ProviderSentEmail>> {
    return runValidated(sendSchema, params, context, ({ draftId }) => { requireApprovedAction(context); return this.translate(() => this.service.sendDraft(identity(context), draftId, context.actionId)); });
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
