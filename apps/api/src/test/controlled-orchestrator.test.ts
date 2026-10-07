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
    const result = await orchestrator.run(goal("Find inactive high-value leads and inspect email history for follow-up recommendations"), context);
    assert.deepEqual(called, ["crm.listInactiveLeads"]);
    assert.equal(result.status, "completed");
    assert.match(result.finalText, /No inactive high-value leads were found/);
    assert.equal(result.observations.length, 1);
  });

  it("does not propose follow-up writes when the inactive-lead query is empty", async () => {
    const calls: string[] = [];
    const result = await new ControlledAgentOrchestrator(async (call) => {
      calls.push(`${call.tool}.${call.action}`);
      return { success: true, data: [] };
    }).run(goal("Follow up with all inactive high-value leads"), context);
    assert.deepEqual(calls, ["crm.listInactiveLeads"]);
    assert.equal(result.status, "completed");
    assert.match(result.finalText, /No inactive high-value leads were found/);
  });

  it("plans complete explicit write intents but does not turn mere mentions into writes", () => {
    const draft = planBusinessGoal(goal('Draft email to lead@example.test subject "Next steps" body "Would you like to talk?"'));
    assert.deepEqual(draft.initialCalls.map(({ tool, action }) => `${tool}.${action}`), ["email.draftEmail"]);
    const send = planBusinessGoal(goal("Send email draft draft-123"));
    assert.deepEqual(send.initialCalls.map(({ tool, action }) => `${tool}.${action}`), ["email.sendEmail"]);
    const event = planBusinessGoal(goal('Create calendar event titled "Review" from 2026-10-05T10:00:00.000Z to 2026-10-05T10:30:00.000Z'));
    assert.deepEqual(event.initialCalls.map(({ tool, action }) => `${tool}.${action}`), ["calendar.createMeeting"]);
    const mentioned = planBusinessGoal(goal("Review what sending an email or creating a calendar event would involve"));
    assert.equal(mentioned.initialCalls.some(({ action }) => ["draftEmail", "sendEmail", "createMeeting"].includes(action)), false);
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
    const result = await orchestrator.run(goal("Find inactive high-value leads and inspect email history for follow-up recommendations"), context);
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

  it("uses a bounded Gmail query for recent unanswered-message prompts", async () => {
    const plan = planBusinessGoal(goal("Find recent emails from clients that haven't received a reply."));
    assert.deepEqual(plan.initialCalls.map(({ tool, action }) => `${tool}.${action}`), ["email.getUnansweredMessages"]);
    assert.equal(plan.initialCalls[0]?.params.query, "newer_than:30d");
  });

  it("queries Gmail content only for message-content questions and Calendar only for date-relevant prompts", () => {
    const emailPlan = planBusinessGoal(goal("What did the client say about the project deadline?"));
    assert.deepEqual(emailPlan.initialCalls.map(({ tool, action }) => `${tool}.${action}`), ["email.getEmailContent"]);
    assert.match(String(emailPlan.initialCalls[0]?.params.query), /deadline/);
    assert.equal(emailPlan.initialCalls[0]?.params.limit, 5);

    const calendarPlan = planBusinessGoal(goal("What meetings do I have tomorrow?"));
    assert.deepEqual(calendarPlan.initialCalls.map(({ tool, action }) => `${tool}.${action}`), ["calendar.listUpcomingEvents"]);
    const { from, until } = calendarPlan.initialCalls[0]!.params;
    assert.equal(Date.parse(String(until)) - Date.parse(String(from)), 24 * 60 * 60 * 1000);

    const irrelevantPlan = planBusinessGoal(goal("Find my inactive high-value leads."));
    assert.equal(irrelevantPlan.initialCalls.some(({ tool }) => tool === "email" || tool === "calendar"), false);
  });

  it("calls calendar only when requested, and only after matching CRM candidates exist", async () => {
    const calls: Array<{ label: string; params: Record<string, unknown> }> = [];
    const orchestrator = new ControlledAgentOrchestrator(async (call) => {
      calls.push({ label: `${call.tool}.${call.action}`, params: call.params });
      return { success: true, data: call.tool === "crm" ? [{ email: "candidate@example.test" }] : [] };
    });
    const result = await orchestrator.run(goal("Find inactive high-value leads and check calendar availability for 2026-10-02 for 30 minutes"), context);
    assert.deepEqual(calls.map(({ label }) => label), ["crm.listInactiveLeads", "calendar.getAvailability"]);
    assert.deepEqual(calls[1]!.params, { from: "2026-10-02T00:00:00.000Z", until: "2026-10-03T00:00:00.000Z", durationMinutes: 30 });
    assert.equal(result.status, "completed");
  });

  it("preserves an explicitly requested deal-value threshold in the CRM query", () => {
    assert.equal(parseRequestedMinimumDealValue("Find leads with deal value >= $125k"), 125_000);
    const plan = planBusinessGoal(goal("Find inactive high-value leads with at least ₹1 lakh deal value"));
    assert.deepEqual(plan.initialCalls[0]!.params, { minDaysInactive: 30, minDealValue: 100_000 });
  });

  it("routes generic high-value requests through CRM and preserves rupee thresholds", async () => {
    const generic = planBusinessGoal(goal("Find my high-value leads"));
    assert.deepEqual(generic.initialCalls.map(({ tool, action }) => `${tool}.${action}`), ["crm.searchLeads"]);
    assert.deepEqual(generic.initialCalls[0]!.params, { minDealValue: 25_000 });

    const threshold = planBusinessGoal(goal("Find high-value leads above ₹1,000,000"));
    assert.equal(parseRequestedMinimumDealValue("Find high-value leads above ₹1,000,000"), 1_000_000);
    assert.deepEqual(threshold.initialCalls[0]!.params, { minDealValue: 1_000_000 });
  });

  it("maps attention and follow-up questions to the deterministic inactive high-value query", () => {
    for (const objective of ["Which leads need my attention?", "Why do they need attention?", "Why do these leads need follow-up?"]) {
      const plan = planBusinessGoal(goal(objective));
      assert.equal(plan.initialCalls[0]?.tool, "crm");
      assert.equal(plan.initialCalls[0]?.action, "listInactiveLeads");
      assert.deepEqual(plan.initialCalls[0]?.params, { minDaysInactive: 30, minDealValue: 25_000 });
    }
  });

  it("resolves a follow-up task request for them through CRM before proposing tasks", () => {
    const plan = planBusinessGoal(goal("Create follow-up tasks for them."));
    assert.deepEqual(plan.initialCalls.map(({ tool, action }) => `${tool}.${action}`), ["crm.listInactiveLeads"]);
    assert.equal(plan.downstream.createFollowUpTasksForCandidates, true);
  });

  it("reports only CRM-returned high-value records with linked evidence", async () => {
    const lead = { id: "lead-1", name: "Prospect A", email: "a@example.test", company: "A Co", dealValue: 50_000, status: "New", lastContactedAt: new Date("2026-08-01T00:00:00Z"), notes: [] };
    const result = await new ControlledAgentOrchestrator(async () => ({ success: true, data: [lead] }))
      .run(goal("Find my high-value leads"), context);
    assert.match(result.finalText, /Prospect A; company A Co; deal value 50000; pipeline status New/);
    assert.match(result.finalText, /evidence: crm\.searchLeads#1/);
    assert.doesNotMatch(result.finalText, /INFERENCE:.*last contacted/);
  });

  it("reports a generic empty CRM search as no matching records", async () => {
    const result = await new ControlledAgentOrchestrator(async () => ({ success: true, data: [] }))
      .run(goal("Find my high-value leads"), context);
    assert.equal(result.status, "completed");
    assert.match(result.finalText, /No matching records were found/);
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
