import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { CRMLead } from "../tools/crmDomain.js";
import { CRMToolService } from "../tools/crmTool.js";
import { InMemoryCRMRepository, StoredCRM } from "../tools/crmRepository.js";
import { InMemoryTaskRepository, JsonTaskRepository } from "../tools/taskRepository.js";
import { TaskToolService } from "../tools/taskTool.js";
import { resolveWorkspaceScope } from "../middleware/workspace.js";
import { workspaceIdFor } from "../domain/businessData.js";

const lead: CRMLead = {
  id: "lead-1", name: "Example", email: "example@example.test", company: "Example Co",
  dealValue: 1200, lastContactedAt: new Date("2026-01-01T00:00:00Z"), notes: []
};
const crmFor = (workspaceId: string, ownerUserId: string, value = lead): StoredCRM => ({
  workspaceId, ownerUserId, sourceName: "import.csv", importedAt: "2026-01-01T00:00:00.000Z", leads: [value]
});
const toolContext = (orgId: string, userId: string, actionId = "search") => ({
  goalId: "goal", runId: "run", actionId, orgId, userId
});

describe("business data ownership", () => {
  it("derives workspace ownership from authenticated identity and ignores browser workspace IDs", () => {
    const request = {
      get: () => "attacker-selected-workspace",
      user: { userId: "verified-user", orgId: "verified-org" }
    } as never;
    assert.equal(resolveWorkspaceScope(request), workspaceIdFor("verified-org", "verified-user"));
    (request as { user: { userId: string; orgId: string } }).user.userId = "another-user";
    assert.equal(resolveWorkspaceScope(request), workspaceIdFor("verified-org", "another-user"));
  });

  it("stores CRM records with workspace ownership and blocks another user's repository lookup", async () => {
    const repository = new InMemoryCRMRepository();
    const workspace = workspaceIdFor("org", "owner");
    await repository.save(workspace, crmFor(workspace, "owner"));
    assert.equal((await repository.get(workspace, "owner"))?.leads.length, 1);
    assert.equal(await repository.get(workspace, "intruder"), undefined);
    await assert.rejects(repository.save(workspace, crmFor(workspace, "intruder")), /ownership/);
  });

  it("CRM tools only return the current workspace and owner records", async () => {
    const repository = new InMemoryCRMRepository();
    const crm = new CRMToolService({ repository });
    const workspaceA = workspaceIdFor("org", "user-a");
    const workspaceB = workspaceIdFor("org", "user-b");
    await repository.save(workspaceA, crmFor(workspaceA, "user-a"));
    const own = await crm.searchLeads({}, toolContext(workspaceA, "user-a"));
    const other = await crm.searchLeads({}, toolContext(workspaceB, "user-b"));
    const wrongOwner = await crm.searchLeads({}, toolContext(workspaceA, "user-b"));
    assert.equal(own.success && own.data.length, 1);
    assert.deepEqual(other.success && other.data, []);
    assert.deepEqual(wrongOwner.success && wrongOwner.data, []);
  });

  it("keeps development fallback CRM data scoped to the explicitly seeded workspace", async () => {
    const crm = new CRMToolService({ repository: new InMemoryCRMRepository() });
    const workspaceA = workspaceIdFor("org", "user-a");
    const workspaceB = workspaceIdFor("org", "user-b");
    crm.setLeads([lead], workspaceA);
    const own = await crm.searchLeads({}, toolContext(workspaceA, "user-a"));
    const other = await crm.searchLeads({}, toolContext(workspaceB, "user-b"));
    assert.equal(own.success && own.data.length, 1);
    assert.deepEqual(other.success && other.data, []);
    const productionTool = new CRMToolService({ repository: new InMemoryCRMRepository() });
    const empty = await productionTool.searchLeads({}, toolContext(workspaceB, "user-b"));
    assert.deepEqual(empty.success && empty.data, []);
  });

  it("keeps empty workspace CRM results empty", async () => {
    const crm = new CRMToolService({ repository: new InMemoryCRMRepository() });
    const result = await crm.searchLeads({}, toolContext(workspaceIdFor("org", "empty-user"), "empty-user"));
    assert.equal(result.success, true);
    assert.deepEqual(result.data, []);
  });

  it("scopes task listing and completion to the owning workspace and persists tasks", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "managebizz-task-owner-"));
    try {
      const repository = new JsonTaskRepository(directory);
      const tasks = new TaskToolService(repository);
      const owner = workspaceIdFor("org", "task-owner");
      const other = workspaceIdFor("org", "task-other");
      const created = await tasks.createTask({ title: "Review next steps" }, toolContext(owner, "task-owner", "unique-task-action"));
      assert.equal(created.success, true);
      if (!created.success) return;
      assert.equal(created.data.task.workspaceId, owner);
      assert.equal(created.data.task.ownerUserId, "task-owner");
      const ownList = await tasks.listOpenTasks({}, toolContext(owner, "task-owner"));
      const otherList = await tasks.listOpenTasks({}, toolContext(other, "task-other"));
      assert.equal(ownList.success && ownList.data.length, 1);
      assert.deepEqual(otherList.success && otherList.data, []);
      const unauthorizedCompletion = await tasks.completeTask({ taskId: created.data.task.id }, toolContext(other, "task-other", "unauthorized-complete"));
      assert.equal(unauthorizedCompletion.success, false);

      const reopened = await new JsonTaskRepository(directory).list(owner, "task-owner");
      assert.equal(reopened.length, 1);
      const hidden = await new JsonTaskRepository(directory).list(owner, "task-other");
      assert.deepEqual(hidden, []);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("allows task repository fakes without changing the tool interface", async () => {
    const tasks = new TaskToolService(new InMemoryTaskRepository());
    const created = await tasks.createTask({ title: "Owned task" }, toolContext("workspace", "owner", "fake-task"));
    assert.equal(created.success, true);
  });
});
