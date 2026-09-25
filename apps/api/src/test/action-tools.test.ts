import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ControlledAgentOrchestrator } from "../agent/runtime/controlledOrchestrator.js";
import { buildEvidenceReport, ToolObservation, verifiedActionStatement } from "../agent/policies/dataIntegrity.js";
import { TaskToolService } from "../tools/taskTool.js";
import { ToolResponse } from "@nexusops/shared-types";
import { ACTION_TOOL_ACTIONS, READ_ONLY_TOOL_ACTIONS, ToolOrchestrator } from "../tools/index.js";

const context = { goalId: "goal", runId: "actions-test", userId: "user", orgId: "org" };
const goal = (objective: string) => ({ objective, timeWindowDays: 30, constraints: [], successCriteria: [] });

describe("controlled task actions", () => {
  it("keeps the supported read and mutation capabilities separate", () => {
    assert.deepEqual(ACTION_TOOL_ACTIONS, { tasks: ["createTask", "completeTask"] });
    assert.ok(READ_ONLY_TOOL_ACTIONS.crm?.includes("searchLeads"));
    assert.ok(READ_ONLY_TOOL_ACTIONS.email?.includes("getEmailHistory"));
    assert.ok(!READ_ONLY_TOOL_ACTIONS.crm?.includes("updateLead"));
    assert.equal(Object.hasOwn(ACTION_TOOL_ACTIONS, "email"), false);
  });

  it("blocks mutation methods outside the allowed task action set", async () => {
    const result = await ToolOrchestrator.executeToolCall("crm", "updateLead", {}, { ...context, actionId: "unsupported-mutation" });
    assert.equal(result.success, false);
    if (!result.success) assert.equal(result.error.code, "UNKNOWN_ACTION");
  });

  it("creates a task and verifies the returned entity before reporting success", async () => {
    const tasks = new TaskToolService();
    const run = await new ControlledAgentOrchestrator((call, toolContext) => {
      assert.equal(call.tool, "tasks");
      assert.equal(call.action, "createTask");
      return tasks.createTask(call.params, toolContext);
    }).run(goal('Create task titled "Follow up"'), context);

    assert.equal(run.status, "completed");
    assert.match(run.finalText, /FACT: Created task "Follow up" \(id: task-actions-test:investigation:1\)/);
    const report = buildEvidenceReport(run.observations);
    assert.equal(report.FACT[0]!.outcome, "RESULT_RETURNED");
    assert.equal(report.FACT[0]!.evidenceRef, "tasks.createTask#1");
    assert.match(report.FACT[0]!.statement, /Created task/);
  });

  it("completes an existing task and reports its returned completed status", async () => {
    const tasks = new TaskToolService();
    const created = await tasks.createTask({ title: "Task" }, { ...context, actionId: "seed-create" });
    assert.equal(created.success, true);
    if (!created.success) return;

    const run = await new ControlledAgentOrchestrator((call, toolContext) => tasks.completeTask(call.params, toolContext))
      .run(goal(`Complete task with id ${created.data.task.id}`), context);
    assert.equal(run.status, "completed");
    assert.match(run.finalText, new RegExp(`FACT: Completed task ${created.data.task.id}`));
  });

  it("returns explicit failures for missing tasks and invalid action input", async () => {
    const tasks = new TaskToolService();
    const missing = await tasks.completeTask({ taskId: "task-missing" }, { ...context, actionId: "missing" });
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
    const run = await new ControlledAgentOrchestrator((call, toolContext) => tasks.completeTask(call.params, toolContext))
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
});
