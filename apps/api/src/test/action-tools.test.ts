import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ControlledAgentOrchestrator } from "../agent/runtime/controlledOrchestrator.js";
import { buildEvidenceReport, ToolObservation, verifiedActionStatement } from "../agent/policies/dataIntegrity.js";
import { TaskToolService } from "../tools/taskTool.js";
import { InMemoryTaskRepository } from "../tools/taskRepository.js";
import { ToolResponse } from "@nexusops/shared-types";
import { ACTION_TOOL_ACTIONS, InMemoryActionIdempotencyStore, READ_ONLY_TOOL_ACTIONS, ToolOrchestrator } from "../tools/index.js";
import { EmailToolService } from "../tools/emailTool.js";
import { MockEmailProvider } from "../integrations/gmail/emailProvider.js";
import { CalendarToolService } from "../tools/calendarTool.js";
import { MockCalendarProvider } from "../integrations/googleCalendar/calendarProvider.js";

const context = { goalId: "goal", runId: "actions-test", userId: "user", orgId: "org" };
const approved = <T extends typeof context & { actionId: string }>(ctx: T) => ({ ...ctx, approvedActionId: ctx.actionId });
const goal = (objective: string) => ({ objective, timeWindowDays: 30, constraints: [], successCriteria: [] });

describe("controlled task actions", () => {
  it("keeps the supported read and mutation capabilities separate", () => {
    assert.deepEqual(ACTION_TOOL_ACTIONS, { email: ["draftEmail", "sendEmail"], calendar: ["createMeeting"], tasks: ["createTask", "completeTask"] });
    assert.ok(READ_ONLY_TOOL_ACTIONS.crm?.includes("searchLeads"));
    assert.ok(READ_ONLY_TOOL_ACTIONS.email?.includes("getEmailHistory"));
    assert.ok(!READ_ONLY_TOOL_ACTIONS.crm?.includes("updateLead"));
    assert.ok(ACTION_TOOL_ACTIONS.email?.includes("sendEmail"));
    assert.ok(ACTION_TOOL_ACTIONS.calendar?.includes("createMeeting"));
  });

  it("blocks mutation methods outside the allowed task action set", async () => {
    const result = await ToolOrchestrator.executeToolCall("crm", "updateLead", {}, { ...context, actionId: "unsupported-mutation" });
    assert.equal(result.success, false);
    if (!result.success) assert.equal(result.error.code, "UNKNOWN_ACTION");
  });

  it("refuses direct valid mutations without an approval marker and leaves state unchanged", async () => {
    const tasks = new TaskToolService(new InMemoryTaskRepository());
    const isolated = { ...context, runId: "approval-boundary-test", actionId: "unapproved-create" };
    const result = await tasks.createTask({ title: "Must wait for approval" }, isolated);
    assert.equal(result.success, false);
    if (!result.success) assert.equal(result.error.code, "APPROVAL_REQUIRED");
    const listed = await tasks.listOpenTasks({}, isolated);
    assert.deepEqual(listed.success && listed.data, []);
  });

  it("the orchestrator rejects an unapproved mutation before claiming or invoking it", async () => {
    const store = new InMemoryActionIdempotencyStore();
    let calls = 0;
    const registry = { ...({} as typeof import("../tools/index.js").ToolsRegistry), tasks: { createTask: async () => { calls += 1; return { success: true as const, data: {} }; } } };
    const result = await ToolOrchestrator.executeToolCall("tasks", "createTask", { title: "Wait" }, { ...context, actionId: "not-approved" }, store, registry);
    assert.equal(result.success, false);
    if (!result.success) assert.equal(result.error.code, "APPROVAL_REQUIRED");
    assert.equal(calls, 0);
    assert.equal((await store.begin({ context: approved({ ...context, actionId: "not-approved" }), tool: "tasks", action: "createTask", paramsHash: "unused" })).status, "CLAIMED");
  });

  it("creates a task and verifies the returned entity before reporting success", async () => {
    const tasks = new TaskToolService(new InMemoryTaskRepository());
    const run = await new ControlledAgentOrchestrator((call, toolContext) => {
      assert.equal(call.tool, "tasks");
      assert.equal(call.action, "createTask");
      return tasks.createTask(call.params, approved(toolContext));
    }).run(goal('Create task titled "Follow up"'), context);

    assert.equal(run.status, "completed");
    assert.match(run.finalText, /FACT: Created task "Follow up" \(id: task-actions-test:investigation:1\)/);
    const report = buildEvidenceReport(run.observations);
    assert.equal(report.FACT[0]!.outcome, "RESULT_RETURNED");
    assert.equal(report.FACT[0]!.evidenceRef, "tasks.createTask#1");
    assert.match(report.FACT[0]!.statement, /Created task/);
  });

  it("fails task creation when the saved entity cannot be read back", async () => {
    const repository = { list: async () => [], save: async () => undefined };
    const tasks = new TaskToolService(repository);
    const result = await tasks.createTask({ title: "Follow up", leadId: "crm-lead" }, approved({ ...context, actionId: "unverified-task" }));
    assert.equal(result.success, false);
    if (!result.success) assert.equal(result.error.code, "VERIFICATION_FAILED");
  });

  it("completes an existing task and reports its returned completed status", async () => {
    const tasks = new TaskToolService(new InMemoryTaskRepository());
    const created = await tasks.createTask({ title: "Task" }, approved({ ...context, actionId: "seed-create" }));
    assert.equal(created.success, true);
    if (!created.success) return;

    const run = await new ControlledAgentOrchestrator((call, toolContext) => tasks.completeTask(call.params, approved(toolContext)))
      .run(goal(`Complete task with id ${created.data.task.id}`), context);
    assert.equal(run.status, "completed");
    assert.match(run.finalText, new RegExp(`FACT: Completed task ${created.data.task.id}`));
  });

  it("returns explicit failures for missing tasks and invalid action input", async () => {
    const tasks = new TaskToolService();
    const missing = await tasks.completeTask({ taskId: "task-missing" }, approved({ ...context, actionId: "missing" }));
    const invalidCreate = await tasks.createTask({ title: "  " }, { ...context, actionId: "invalid-create" });
    const invalidComplete = await tasks.completeTask({ taskId: "" }, { ...context, actionId: "invalid-complete" });
    assert.equal(missing.success, false);
    if (!missing.success) assert.equal(missing.error.code, "NOT_FOUND");
    for (const result of [invalidCreate, invalidComplete]) {
      assert.equal(result.success, false);
      if (!result.success) assert.equal(result.error.code, "INVALID_INPUT");
    }
  });

  it("does not claim completion after a failed action", async () => {
    const tasks = new TaskToolService();
    const run = await new ControlledAgentOrchestrator((call, toolContext) => tasks.completeTask(call.params, approved(toolContext)))
      .run(goal("Complete task task-missing"), context);
    assert.equal(run.status, "failed");
    assert.doesNotMatch(run.finalText, /FACT: Completed task/);
    assert.match(run.finalText, /no successful task action was confirmed/);
    const report = buildEvidenceReport(run.observations);
    assert.equal(report.FACT[0]!.outcome, "SUCCESS_NOT_CONFIRMED");
  });

  it("rejects malformed successful responses as action confirmation", () => {
    const malformed: ToolResponse = { success: true, data: { updated: true, task: { id: "task-x", status: "OPEN" } } };
    const observation: ToolObservation = { tool: "tasks", action: "completeTask", params: { taskId: "task-x" }, result: malformed };
    assert.equal(verifiedActionStatement("tasks", "completeTask", malformed), undefined);
    const report = buildEvidenceReport([observation]);
    assert.equal(report.FACT[0]!.outcome, "SUCCESS_NOT_CONFIRMED");
    assert.doesNotMatch(report.FACT[0]!.statement, /Completed task/);
  });

  it("creates and sends only an existing scoped draft and verifies the returned send entity", async () => {
    const provider = new MockEmailProvider();
    const email = new EmailToolService(provider);
    const draft = await email.draftEmail({ to: "lead@example.test", subject: "Follow up", body: "Checking whether you would like to discuss next steps." }, approved({ ...context, actionId: "draft-email-1" }));
    assert.equal(draft.success, true);
    if (!draft.success) return;
    assert.equal(draft.data.status, "DRAFT");
    assert.equal(verifiedActionStatement("email", "draftEmail", draft, { to: "lead@example.test", subject: "Follow up" })?.includes("Created Gmail draft"), true);
    const foreign = await email.sendEmail({ draftId: draft.data.draftId }, approved({ ...context, userId: "user-b", orgId: "org-b", actionId: "foreign-send" }));
    assert.equal(foreign.success, false);
    if (!foreign.success) assert.equal(foreign.error.code, "EMAIL_DRAFT_NOT_FOUND");
    const sent = await email.sendEmail({ draftId: draft.data.draftId }, approved({ ...context, actionId: "send-email-1" }));
    assert.equal(sent.success, true);
    if (!sent.success) return;
    assert.equal(sent.data.status, "SENT");
    assert.equal(verifiedActionStatement("email", "sendEmail", sent, { draftId: draft.data.draftId })?.includes("Sent Gmail message"), true);
    assert.equal((await email.sendEmail({ draftId: "missing" }, approved({ ...context, actionId: "send-missing" }))).success, false);
  });

  it("creates calendar events deterministically and rejects invalid dates", async () => {
    const provider = new MockCalendarProvider();
    const calendar = new CalendarToolService({ provider });
    const input = { title: "Lead review", startTime: "2026-10-02T10:00:00.000Z", endTime: "2026-10-02T10:30:00.000Z", attendees: ["lead@example.test"] };
    const created = await calendar.createMeeting(input, approved({ ...context, actionId: "calendar-create-1" }));
    assert.equal(created.success, true);
    if (!created.success) return;
    assert.ok(verifiedActionStatement("calendar", "createMeeting", created, input));
    const invalid = await calendar.createMeeting({ ...input, endTime: input.startTime }, approved({ ...context, actionId: "calendar-invalid" }));
    assert.equal(invalid.success, false);
    if (!invalid.success) assert.equal(invalid.error.code, "INVALID_INPUT");
  });

  it("persists action idempotency before execution and replays a confirmed result once", async () => {
    const store = new InMemoryActionIdempotencyStore();
    let calls = 0;
    const registry = { ...({} as typeof import("../tools/index.js").ToolsRegistry), tasks: { createTask: async () => {
      calls += 1;
      return { success: true as const, data: { created: true, task: { id: "task-idempotent", title: "Once", status: "OPEN" } } };
    } } };
    const input = { title: "Once" };
    const ctx = approved({ ...context, actionId: "stable-action-id" });
    const first = await ToolOrchestrator.executeToolCall("tasks", "createTask", input, ctx, store, registry);
    const retried = await ToolOrchestrator.executeToolCall("tasks", "createTask", input, ctx, store, registry);
    assert.equal(first.success, true);
    assert.equal(retried.success, true);
    assert.equal(retried.metadata?.cached, true);
    assert.equal(calls, 1);
  });

  it("fails closed when it cannot reserve an idempotency key", async () => {
    let calls = 0;
    const store = { begin: async () => { throw new Error("store unavailable"); }, finish: async () => undefined };
    const registry = { ...({} as typeof import("../tools/index.js").ToolsRegistry), tasks: { createTask: async () => { calls += 1; return { success: true as const, data: {} }; } } };
    const result = await ToolOrchestrator.executeToolCall("tasks", "createTask", { title: "Do not duplicate" }, approved({ ...context, actionId: "cannot-reserve" }), store, registry);
    assert.equal(result.success, false);
    if (!result.success) assert.equal(result.error.code, "ACTION_IDEMPOTENCY_UNAVAILABLE");
    assert.equal(calls, 0);
  });

  it("caches failures, rejects changed parameters for an action ID, and blocks concurrent retries", async () => {
    const store = new InMemoryActionIdempotencyStore();
    let calls = 0;
    let finishCall!: () => void;
    const entered = new Promise<void>((resolve) => { finishCall = resolve; });
    const registry = { ...({} as typeof import("../tools/index.js").ToolsRegistry), tasks: { createTask: async () => {
      calls += 1;
      finishCall();
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { success: false as const, error: { code: "WRITE_FAILED", message: "provider failed" } };
    } } };
    const ctx = approved({ ...context, actionId: "failed-stable-action" });
    const firstPromise = ToolOrchestrator.executeToolCall("tasks", "createTask", { title: "Original" }, ctx, store, registry);
    await entered;
    const concurrent = await ToolOrchestrator.executeToolCall("tasks", "createTask", { title: "Original" }, ctx, store, registry);
    const first = await firstPromise;
    const retry = await ToolOrchestrator.executeToolCall("tasks", "createTask", { title: "Original" }, ctx, store, registry);
    const changed = await ToolOrchestrator.executeToolCall("tasks", "createTask", { title: "Changed" }, ctx, store, registry);
    assert.equal(calls, 1);
    assert.equal(concurrent.success, false);
    if (!concurrent.success) assert.equal(concurrent.error.code, "ACTION_IN_PROGRESS");
    assert.equal(first.success, false);
    assert.equal(retry.success, false);
    assert.equal(retry.metadata?.cached, true);
    assert.equal(changed.success, false);
    if (!changed.success) assert.equal(changed.error.code, "ACTION_ID_CONFLICT");
  });
});
