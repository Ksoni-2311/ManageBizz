import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ManageBizzAgentApi, ApplicationToolExecutor } from "../agent/application/manageBizzAgentApi.js";
import { RunTraceStore } from "../agent/runtime/runTrace.js";
import { ToolResponse } from "@nexusops/shared-types";

const parser = { parseGoal: async (objective: string) => ({ objective, timeWindowDays: 30, constraints: [], successCriteria: [] }) };
const apiWith = (executor: ApplicationToolExecutor, goalParser = parser) => new ManageBizzAgentApi(executor, goalParser, new RunTraceStore());
const identity = { orgId: "org", userId: "user-a" };

describe("ManageBizz application API", () => {
  it("returns the stable structured contract for a successful run", async () => {
    const api = apiWith(async () => ({ success: true, data: { total: 10 } }));
    const result = await api.run({ goal: "Show sales metrics", ...identity });
    assert.equal(result.status, "completed");
    assert.ok(result.runId);
    assert.ok(result.answer);
    assert.ok(Array.isArray(result.evidence.facts));
    assert.ok(Array.isArray(result.recommendations));
    assert.deepEqual(result.actions, []);
    assert.equal(result.trace.runId, result.runId);
    assert.ok(await api.getRun(result.runId, "org", "user-a"));
    assert.equal(await api.getRun(result.runId, "org", "user-b"), undefined);
  });

  it("returns a successful explicit empty-result run", async () => {
    const api = apiWith(async () => ({ success: true, data: [] }));
    const result = await api.run({ goal: "Find inactive high-value leads", ...identity });
    assert.equal(result.status, "completed");
    assert.match(result.answer, /No inactive high-value leads were found/);
    assert.equal(result.evidence.facts[0]!.outcome, "EMPTY_RESULT");
    assert.equal(result.error, undefined);
  });

  it("returns a structured tool failure", async () => {
    const failure: ToolResponse = { success: false, error: { code: "DATA_UNAVAILABLE", message: "CRM unavailable" } };
    const api = apiWith(async () => failure);
    const result = await api.run({ goal: "Find inactive high-value leads", ...identity });
    assert.equal(result.status, "failed");
    assert.equal(result.error?.code, "DATA_UNAVAILABLE");
    assert.equal(result.trace.events.at(-1)!.eventType, "AGENT_FAILED");
  });

  it("returns an agent failure separately from tool failures", async () => {
    const api = apiWith(async () => ({ success: true, data: [] }), { parseGoal: async () => { throw new Error("Planner unavailable"); } });
    const result = await api.run({ goal: "Any goal", ...identity });
    assert.equal(result.status, "failed");
    assert.equal(result.error?.code, "AGENT_FAILURE");
    assert.equal(result.trace.events.at(-1)!.eventType, "AGENT_FAILED");
  });

  it("returns an action proposal before execution", async () => {
    let toolCalls = 0;
    const api = apiWith(async () => { toolCalls++; return { success: true, data: {} }; });
    const result = await api.run({ goal: 'Create task titled "Review proposal"', ...identity });
    assert.equal(result.status, "awaiting_approval");
    assert.equal(result.actions.length, 1);
    assert.equal(result.actions[0]!.lifecycle, "PROPOSED");
    assert.equal(toolCalls, 0);
    assert.ok(result.trace.events.some(({ eventType }) => eventType === "ACTION_PROPOSED"));
  });

  it("executes an approved action and returns verified evidence and trace", async () => {
    let toolCalls = 0;
    const api = apiWith(async (call) => {
      toolCalls++;
      return { success: true, data: { created: true, task: { id: "task-result", title: String(call.params.title), status: "OPEN" } } };
    });
    const proposalResult = await api.run({ goal: 'Create task titled "Review proposal"', ...identity });
    const proposal = proposalResult.actions[0]!;
    assert.equal(await api.decideAction(proposalResult.runId, "org", "user-b", proposal.id, "APPROVE", "other-user"), undefined);
    assert.equal(toolCalls, 0, "a different user cannot approve or execute the action");
    const result = await api.decideAction(proposalResult.runId, "org", "user-a", proposal.id, "APPROVE", "reviewer");
    assert.ok(result);
    assert.equal(result.status, "completed");
    assert.equal(toolCalls, 1);
    assert.match(result.answer, /Created task/);
    assert.equal(result.actions[0]!.lifecycle, "VERIFIED");
    assert.equal(await api.getRun(proposalResult.runId, "org", "user-b"), undefined);
    assert.deepEqual(result.trace.events.filter(({ eventType }) => eventType.startsWith("ACTION_")).map(({ eventType }) => eventType), [
      "ACTION_PROPOSED", "ACTION_APPROVED", "ACTION_EXECUTED", "ACTION_VERIFIED"
    ]);
  });
});
