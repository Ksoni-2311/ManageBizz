import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EmailToolService } from "../tools/emailTool.js";
import { MockEmailProvider } from "../integrations/gmail/emailProvider.js";
import { InMemoryEmailConnectionRepository } from "../integrations/gmail/emailConnectionRepository.js";

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
});
