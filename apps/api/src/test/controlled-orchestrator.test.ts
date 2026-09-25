import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ParsedGoal, ToolResponse } from "@nexusops/shared-types";
import { ControlledAgentOrchestrator, parseRequestedMinimumDealValue, PlannedToolCall, planBusinessGoal, RunToolCallTracker } from "../agent/runtime/controlledOrchestrator.js";

const context = { goalId: "goal", runId: "controlled-test", userId: "user", orgId: "org" };
const goal = (objective: string): ParsedGoal => ({ objective, timeWindowDays: 30, constraints: [], successCriteria: [] });

describe("controlled investigation orchestration", () => {
  it("stops downstream investigation when the CRM root query is empty", async () => {
    const called: string[] = [];
    const orchestrator = new ControlledAgentOrchestrator(async (call) => {
      called.push(`${call.tool}.${call.action}`);
      return { success: true, data: [] };
    });
    const result = await orchestrator.run(goal("Find inactive high-value leads and determine follow-up actions"), context);
    assert.deepEqual(called, ["crm.listInactiveLeads"]);
    assert.equal(result.status, "completed");
    assert.match(result.finalText, /No inactive high-value leads were found/);
    assert.equal(result.observations.length, 1);
  });

  it("queries email history once for returned candidates when a follow-up recommendation needs it", async () => {
    const calls: Array<{ tool: string; action: string; params: Record<string, unknown> }> = [];
    const orchestrator = new ControlledAgentOrchestrator(async (call) => {
      calls.push({ tool: call.tool, action: call.action, params: call.params });
      const data = call.tool === "crm"
        ? [{ email: "one@example.test" }, { email: "two@example.test" }]
        : [];
      return { success: true, data };
    });
    const result = await orchestrator.run(goal("Find inactive high-value leads and determine follow-up actions"), context);
    assert.deepEqual(calls.map(({ tool, action }) => `${tool}.${action}`), ["crm.listInactiveLeads", "email.getEmailHistory"]);
    assert.deepEqual(calls[1]!.params, { leadEmails: ["one@example.test", "two@example.test"] });
    assert.match(result.finalText, /No email history was found for the requested CRM-matched candidates/);
    assert.match(result.finalText, /Insufficient evidence to determine whether follow-up is due/);
    assert.match(result.finalText, /RECOMMENDATION: Review these matching leads.*evidence: crm\.listInactiveLeads#1/);
    assert.doesNotMatch(result.finalText, /was sent|email delivered/i);
    assert.equal(result.status, "completed");
  });

  it("does not inspect email or calendar when the objective only asks for CRM matches", async () => {
    const calls: string[] = [];
    const result = await new ControlledAgentOrchestrator(async (call) => {
      calls.push(`${call.tool}.${call.action}`);
      return { success: true, data: [{ email: "candidate@example.test" }] };
    }).run(goal("Find inactive high-value leads"), context);
    assert.deepEqual(calls, ["crm.listInactiveLeads"]);
    assert.equal(result.status, "completed");
  });

  it("calls calendar only when requested, and only after matching CRM candidates exist", async () => {
    const calls: Array<{ label: string; params: Record<string, unknown> }> = [];
    const orchestrator = new ControlledAgentOrchestrator(async (call) => {
      calls.push({ label: `${call.tool}.${call.action}`, params: call.params });
      return { success: true, data: call.tool === "crm" ? [{ email: "candidate@example.test" }] : [] };
    });
    const result = await orchestrator.run(goal("Find inactive high-value leads and check calendar availability for 2026-10-02 for 30 minutes"), context);
    assert.deepEqual(calls.map(({ label }) => label), ["crm.listInactiveLeads", "calendar.getAvailability"]);
    assert.deepEqual(calls[1]!.params, { date: "2026-10-02T00:00:00.000Z", durationMinutes: 30, attendeeEmails: ["candidate@example.test"] });
    assert.equal(result.status, "completed");
  });

  it("preserves an explicitly requested deal-value threshold in the CRM query", () => {
    assert.equal(parseRequestedMinimumDealValue("Find leads with deal value >= $125k"), 125_000);
    const plan = planBusinessGoal(goal("Find inactive high-value leads with at least ₹1 lakh deal value"));
    assert.deepEqual(plan.initialCalls[0]!.params, { minDaysInactive: 30, minDealValue: 100_000 });
  });

  it("does not reinterpret an upper deal-value bound as a minimum", async () => {
    let calls = 0;
    const result = await new ControlledAgentOrchestrator(async () => {
      calls++;
      return { success: true, data: [] };
    }).run(goal("Find inactive high-value leads below $100k"), context);
    assert.equal(calls, 0);
    assert.match(result.finalText, /upper bound cannot be answered/i);
  });

  it("does not call a downstream tool when the CRM root query fails", async () => {
    const calls: string[] = [];
    const orchestrator = new ControlledAgentOrchestrator(async (call) => {
      calls.push(`${call.tool}.${call.action}`);
      return { success: false, error: { code: "DATA_UNAVAILABLE", message: "CRM unavailable" } };
    });
    const result = await orchestrator.run(goal("Find inactive high-value leads and inspect email history"), context);
    assert.deepEqual(calls, ["crm.listInactiveLeads"]);
    assert.equal(result.status, "failed");
    assert.match(result.finalText, /insufficient/i);
  });

  it("tracks calls per run and blocks identical tool arguments", () => {
    const tracker = new RunToolCallTracker();
    const call: PlannedToolCall = { tool: "crm", action: "listInactiveLeads", params: { minDaysInactive: 30 }, purpose: "root" };
    assert.equal(tracker.claim(context.runId, context.orgId, call), true);
    assert.equal(tracker.claim(context.runId, context.orgId, { ...call, params: { minDaysInactive: 30 } }), false);
    assert.equal(tracker.claim(context.runId, context.orgId, { ...call, params: { minDaysInactive: 60 } }), true);
  });

  it("completes an empty-result investigation with concise final text and a minimal plan", async () => {
    const result = await new ControlledAgentOrchestrator(async (): Promise<ToolResponse> => ({ success: true, data: [] }))
      .run(goal("Find inactive high-value leads"), context);
    const plan = planBusinessGoal(goal("Find inactive high-value leads"));
    assert.equal(result.status, "completed");
    assert.ok(result.finalText.trim().length > 0);
    assert.equal(result.observations.length, 1);
    assert.match(result.finalText, /RECOMMENDATION: No lead-specific follow-up action is supported/);
    assert.equal(plan.initialCalls.length, 1);
    assert.deepEqual(plan.toolMappings.map(({ tool }) => tool), ["crm"]);
  });
});
