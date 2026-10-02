import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EmailToolService } from "../tools/emailTool.js";
import { MockEmailProvider } from "../integrations/gmail/emailProvider.js";
import { InMemoryEmailConnectionRepository } from "../integrations/gmail/emailConnectionRepository.js";
import { encryptGoogleRefreshToken } from "../integrations/googleOAuth/tokenEncryption.js";
import { GmailOAuthService } from "../integrations/gmail/gmailOAuthService.js";
import { GmailProvider } from "../integrations/gmail/emailProvider.js";

const context = { goalId: "goal", runId: "gmail-test", actionId: "action", userId: "user-a", orgId: "workspace-a" };
const identity = { workspaceId: context.orgId, userId: context.userId };

describe("Gmail read integration contracts", () => {
  it("uses only fake-provider results and reports authoritative empty history", async () => {
    const provider = new MockEmailProvider();
    const email = new EmailToolService(provider);
    const empty = await email.getEmailHistory({ leadEmail: "nobody@example.test" }, context);
    assert.equal(empty.success, true);
    if (empty.success) assert.deepEqual(empty.data, []);
  });

  it("identifies unanswered communication only from explicit thread evidence", async () => {
    const provider = new MockEmailProvider();
    provider.seed(identity, [
      { id: "sent-1", threadId: "thread-1", leadEmail: "lead@example.test", direction: "OUTBOUND", subject: "Update", sentAt: "2026-09-01T09:00:00.000Z" },
      { id: "reply-1", threadId: "thread-1", leadEmail: "lead@example.test", direction: "INBOUND", subject: "Re: Update", sentAt: "2026-09-02T09:00:00.000Z" },
      { id: "sent-2", threadId: "thread-2", leadEmail: "lead@example.test", direction: "OUTBOUND", subject: "Next step", sentAt: "2026-09-03T09:00:00.000Z" }
    ]);
    const email = new EmailToolService(provider);
    const history = await email.getEmailHistory({ leadEmail: "lead@example.test" }, context);
    assert.equal(history.success, true);
    if (history.success) {
      assert.equal(history.data.find(({ id }) => id === "sent-1")?.responseStatus, "ANSWERED");
      assert.equal(history.data.find(({ id }) => id === "sent-2")?.responseStatus, "UNANSWERED");
    }
    const metadata = await email.getEmailMetadata({ messageId: "sent-2" }, context);
    assert.equal(metadata.success, true);
    if (metadata.success) assert.equal(metadata.data?.id, "sent-2");
  });

  it("isolates fake mailbox data per workspace and never falls back to demo records", async () => {
    const provider = new MockEmailProvider();
    provider.seed(identity, [{ id: "private-message", leadEmail: "lead@example.test", direction: "INBOUND" }]);
    const email = new EmailToolService(provider);
    const other = await email.getEmailHistory({ leadEmail: "lead@example.test" }, { ...context, orgId: "workspace-b" });
    assert.equal(other.success, true);
    if (other.success) assert.deepEqual(other.data, []);
    assert.deepEqual(await provider.connectionStatus({ workspaceId: "workspace-b", userId: context.userId }), { connected: false });
  });

  it("persists connections only under their owner identity", async () => {
    const repository = new InMemoryEmailConnectionRepository();
    await repository.save({ ...identity, encryptedRefreshToken: "ciphertext", connectedAt: "2026-09-01T00:00:00.000Z" });
    assert.equal((await repository.get(identity.workspaceId, identity.userId))?.encryptedRefreshToken, "ciphertext");
    assert.equal(await repository.get("workspace-b", identity.userId), undefined);
  });

  it("requests explicit read and compose scopes for OAuth", async () => {
    const original = { id: process.env.GOOGLE_GMAIL_CLIENT_ID, secret: process.env.GOOGLE_GMAIL_CLIENT_SECRET, redirect: process.env.GOOGLE_GMAIL_REDIRECT_URI, key: process.env.GOOGLE_TOKEN_ENCRYPTION_KEY };
    Object.assign(process.env, { GOOGLE_GMAIL_CLIENT_ID: "client", GOOGLE_GMAIL_CLIENT_SECRET: "secret", GOOGLE_GMAIL_REDIRECT_URI: "http://localhost/callback", GOOGLE_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64") });
    try {
      const oauth = new GmailOAuthService(new InMemoryEmailConnectionRepository());
      const url = new URL(oauth.authorizationUrl(identity));
      assert.deepEqual(url.searchParams.get("scope")?.split(" ").sort(), ["https://www.googleapis.com/auth/gmail.compose", "https://www.googleapis.com/auth/gmail.readonly"].sort());
    } finally {
      for (const [name, value] of [["GOOGLE_GMAIL_CLIENT_ID", original.id], ["GOOGLE_GMAIL_CLIENT_SECRET", original.secret], ["GOOGLE_GMAIL_REDIRECT_URI", original.redirect], ["GOOGLE_TOKEN_ENCRYPTION_KEY", original.key]] as const) {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
    }
  });

  it("creates a draft, sends only that draft, and verifies Gmail's SENT metadata", async () => {
    const envNames = ["GOOGLE_GMAIL_CLIENT_ID", "GOOGLE_GMAIL_CLIENT_SECRET", "GOOGLE_TOKEN_ENCRYPTION_KEY"] as const;
    const previous = envNames.map((name) => process.env[name]);
    Object.assign(process.env, { GOOGLE_GMAIL_CLIENT_ID: "client", GOOGLE_GMAIL_CLIENT_SECRET: "secret", GOOGLE_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString("base64") });
    try {
      const repository = new InMemoryEmailConnectionRepository();
      await repository.save({ ...identity, encryptedRefreshToken: encryptGoogleRefreshToken("refresh"), connectedAt: new Date().toISOString() });
      const sentAt = String(Date.now());
      const calls: Array<{ url: string; init?: RequestInit }> = [];
      const fetcher: typeof fetch = async (input, init) => {
        const url = String(input); calls.push({ url, ...(init ? { init } : {}) });
        if (url.includes("oauth2.googleapis.com")) return new Response(JSON.stringify({ access_token: "access", expires_in: 3600 }), { status: 200 });
        if (url.endsWith("/drafts") && init?.method === "POST") return new Response(JSON.stringify({ id: "draft-1", message: { id: "draft-message-1" } }), { status: 200 });
        if (url.includes("/drafts/draft-1?") && init?.method !== "POST") return new Response(JSON.stringify({ id: "draft-1", message: { id: "draft-message-1", labelIds: ["DRAFT"], payload: { headers: [{ name: "To", value: "lead@example.test" }, { name: "Subject", value: "Review" }] } } }), { status: 200 });
        if (url.endsWith("/drafts/send") && init?.method === "POST") return new Response(JSON.stringify({ id: "sent-1" }), { status: 200 });
        if (url.includes("/messages/sent-1?") && init?.method !== "POST") return new Response(JSON.stringify({ id: "sent-1", labelIds: ["SENT"], internalDate: sentAt, payload: { headers: [{ name: "To", value: "lead@example.test" }, { name: "Subject", value: "Review" }] } }), { status: 200 });
        return new Response(JSON.stringify({ error: "unexpected request" }), { status: 500 });
      };
      const provider = new GmailProvider(repository, fetcher);
      const draft = await provider.createDraft(identity, { to: "lead@example.test", subject: "Review", body: "Please review." }, "draft-action");
      assert.equal(draft.draftId, "draft-1");
      assert.equal(draft.status, "DRAFT");
      const sent = await provider.sendDraft(identity, draft.draftId, "send-action");
      assert.equal(sent.messageId, "sent-1");
      assert.equal(sent.status, "SENT");
      assert.ok(calls.some(({ url, init }) => url.includes("/drafts/send") && init?.method === "POST"));
    } finally {
      envNames.forEach((name, index) => { const value = previous[index]; if (value === undefined) delete process.env[name]; else process.env[name] = value; });
    }
  });
});
