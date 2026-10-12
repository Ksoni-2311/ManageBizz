import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ManageBizzAgentApi, ApplicationToolExecutor } from "../agent/application/manageBizzAgentApi.js";
import { RunTraceStore } from "../agent/runtime/runTrace.js";
import { EvidenceBundle, ToolResponse } from "@nexusops/shared-types";
import { TaskToolService } from "../tools/taskTool.js";
import { InMemoryTaskRepository } from "../tools/taskRepository.js";

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
    assert.equal(await api.getRun(result.runId, "another-org", "user-a"), undefined);
  });

  it("composes the answer from a structured evidence bundle without passing raw tool observations", async () => {
    let composedGoal = "";
    let composedEvidenceCount = 0;
    const goalParser = {
      ...parser,
      generateGroundedAnswer: async (goal: string, evidence: EvidenceBundle) => {
        composedGoal = goal;
        composedEvidenceCount = evidence.items.length;
        const item = evidence.items[0]!;
        return { kind: "generated", candidate: {
          status: evidence.sufficiency,
          answer: "Ignored freeform answer.",
          claims: [{ claimId: "fact-1", text: item.statement, evidenceRefs: [item.evidenceRef], status: "supported" }],
          evidenceRefs: [item.evidenceRef],
          limitations: [],
          recommendations: []
        } };
      }
    };
    const api = apiWith(async () => ({ success: true, data: { total: 12 } }), goalParser);
    const result = await api.run({ goal: "Summarize my sales metrics", ...identity });

    assert.equal(composedGoal, "Summarize my sales metrics");
    assert.equal(composedEvidenceCount, 1);
    assert.match(result.answer, /business tool returned a result/);
    assert.doesNotMatch(result.answer, /Ignored freeform answer/);
    assert.equal(result.groundedAnswer?.claims[0]?.evidenceRefs[0], "analytics.getSalesMetrics#1");
  });

  it("returns a successful explicit empty-result run", async () => {
    const api = apiWith(async () => ({ success: true, data: [] }));
    const result = await api.run({ goal: "Find inactive high-value leads from the last 30 days", ...identity });
    assert.equal(result.status, "completed");
    assert.match(result.answer, /^No CRM records matched the requested criteria\. \[evidence: crm\.listInactiveLeads#1\]$/);
    assert.equal(result.evidence.facts[0]!.outcome, "EMPTY_RESULT");
    assert.equal(result.error, undefined);
  });

  it("returns normalized CRM records and evidence references without raw tool fields", async () => {
    const api = apiWith(async () => ({
      success: true,
      data: [
        {
          id: "internal-record-id",
          name: "Prospect One",
          email: "one@example.test",
          company: "Example Company",
          dealValue: 85_000,
          status: "Proposal",
          lastContactedAt: new Date("2026-01-05T12:00:00.000Z"),
          notes: ["private note"]
        },
        {
          id: "internal-record-id-2",
          name: "Prospect Two",
          company: "Other Company",
          dealValue: 42_000
        }
      ]
    }));
    const result = await api.run({ goal: "Find my high-value leads", ...identity });
    const serialized = JSON.stringify(result);

    assert.equal(result.status, "completed");
    assert.equal(result.queryPlan?.intent, "crm_lead_search");
    assert.deepEqual(result.queryPlan?.sources, ["crm"]);
    assert.deepEqual(result.plan?.steps.map(({ tool, action }) => `${tool}.${action}`), ["crm.searchLeads"]);
    assert.equal(result.structuredResult?.resultType, "crm_records");
    assert.equal(result.structuredResult?.count, 2);
    assert.equal(result.structuredResult?.records.length, 2);
    assert.match(result.answer, /CRM returned 2 record/);
    assert.match(result.evidence.facts[0]!.statement, /CRM returned 2 record/);
    assert.deepEqual(result.evidence.facts[0]!.recordRefs, [
      "crm.searchLeads#1:record-1",
      "crm.searchLeads#1:record-2"
    ]);
    assert.doesNotMatch(serialized, /one@example\.test|private note|internal-record-id/);
    assert.equal(result.trace.events.at(-1)?.eventType, "AGENT_COMPLETED");
  });

  it("retains explicit inactivity criteria and does not invent a window for an unspecified inactive query", async () => {
    const params: Record<string, unknown>[] = [];
    const api = apiWith(async (call) => {
      params.push(call.params);
      return { success: true, data: [] };
    });
    const valid = await api.run({
      goal: "Which high-value leads haven't been contacted in the last 30 days?",
      ...identity
    });
    assert.deepEqual(valid.queryPlan?.sources, ["crm"]);
    assert.equal(valid.queryPlan?.dateRange?.expression, "last 30 days");
    assert.deepEqual(params[0], { minDaysInactive: 30, minDealValue: 25_000 });
    assert.equal(valid.structuredResult?.count, 0);
    assert.match(valid.answer, /^No CRM records matched the requested criteria\. \[evidence: crm\.listInactiveLeads#1\]$/);

    let calls = 0;
    const unspecified = await apiWith(async () => {
      calls += 1;
      return { success: true, data: [] };
    }).run({ goal: "Find my inactive high-value leads", ...identity });
    assert.equal(unspecified.status, "failed");
    assert.equal(unspecified.queryPlan?.dateRange, undefined);
    assert.equal(calls, 0);
  });

  it("resolves a first name against CRM and returns CRM candidates when ambiguous", async () => {
    const calls: string[] = [];
    const api = apiWith(async (call) => {
      calls.push(`${call.tool}.${call.action}`);
      return { success: true, data: { status: "AMBIGUOUS", candidates: [
        { crmRecordRef: "private-a", canonicalName: "Rahul Sharma", company: "Acme", matchedBy: "name_component", confidence: 0.72 },
        { crmRecordRef: "private-b", canonicalName: "Rahul Verma", company: "Other", matchedBy: "name_component", confidence: 0.72 }
      ] } };
    });
    const result = await api.run({ goal: "Did Rahul reply to my proposal?", ...identity });
    assert.equal(result.status, "completed");
    assert.equal(result.queryPlan?.intent, "email_reply_check");
    assert.deepEqual(result.queryPlan?.sources, ["crm", "gmail"]);
    assert.equal(result.queryPlan?.ambiguity.type, "none");
    assert.deepEqual(calls, ["crm.resolveContact"]);
    assert.match(result.answer, /identity is ambiguous/);
    assert.match(result.answer, /Rahul Sharma at Acme; Rahul Verma at Other/);
    assert.doesNotMatch(JSON.stringify(result), /private-a|private-b|rahul@/i);
  });

  it("passes the user's timezone through to Calendar date planning", async () => {
    let range: Record<string, unknown> | undefined;
    const api = apiWith(async (call) => {
      range = call.params;
      return { success: true, data: [] };
    });
    const result = await api.run({ goal: "What meetings do I have tomorrow?", timezone: "Asia/Kolkata", ...identity });
    assert.equal(result.status, "completed");
    assert.equal(result.queryPlan?.dateRange?.timezone, "Asia/Kolkata");
    assert.equal(Date.parse(String(range?.until)) - Date.parse(String(range?.from)), 24 * 60 * 60 * 1000);
    assert.notEqual(new Date(String(range?.from)).getUTCHours(), 0);
  });

  it("returns a structured tool failure", async () => {
    const failure: ToolResponse = { success: false, error: { code: "DATA_UNAVAILABLE", message: "CRM unavailable" } };
    const api = apiWith(async () => failure);
    const result = await api.run({ goal: "Find inactive high-value leads from the last 30 days", ...identity });
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

  it("proposes CRM-linked follow-up tasks, waits for approval, then verifies each task", async () => {
    const calls: string[] = [];
    const taskService = new TaskToolService(new InMemoryTaskRepository());
    const api = apiWith(async (call, context) => {
      calls.push(`${call.tool}.${call.action}`);
      if (call.tool === "crm") return { success: true, data: [
        { id: "crm-1", name: "Prospect One", email: "one@example.test", company: "One Co", dealValue: 50_000, status: "New", lastContactedAt: new Date("2025-01-01T00:00:00Z") },
        { id: "crm-2", name: "Prospect Two", email: "two@example.test", company: "Two Co", dealValue: 60_000, status: "Negotiation", lastContactedAt: new Date("2025-01-01T00:00:00Z") }
      ] };
      if (call.tool === "tasks" && call.action === "createTask") return taskService.createTask(call.params, context);
      return { success: false, error: { code: "UNEXPECTED_TOOL", message: "Unexpected call." } };
    });

    let result = await api.run({ goal: "Find high-value leads that haven't been contacted in the last 30 days and create follow-up tasks for them", ...identity });
    assert.equal(result.status, "awaiting_approval");
    assert.deepEqual(calls, ["crm.listInactiveLeads"]);
    assert.equal(result.actions[0]?.action, "createTask");
    assert.equal(result.actions[0]?.params.leadId, "crm-1");
    const beforeApproval = await taskService.listOpenTasks({}, { goalId: "g", runId: result.runId, actionId: "read-before", userId: identity.userId, orgId: identity.orgId });
    assert.deepEqual(beforeApproval.success && beforeApproval.data, [], "proposal must not create a task before approval");

    let approvals = 0;
    while (result.status === "awaiting_approval") {
      const pending = result.actions.find((action) => action.lifecycle === "PROPOSED");
      assert.ok(pending);
      const next = await api.decideAction(result.runId, identity.orgId, identity.userId, pending.id, "APPROVE", identity.userId);
      assert.ok(next);
      result = next!;
      approvals++;
      assert.ok(approvals <= 2);
    }
    assert.equal(result.status, "completed", `${result.error?.code ?? ""} ${result.error?.message ?? ""} ${result.answer}`);
    assert.equal(approvals, 2);
    assert.equal(result.actions.filter((action) => action.lifecycle === "VERIFIED").length, 2);
    assert.equal(calls.filter((call) => call === "tasks.createTask").length, 2);
    assert.equal(calls.filter((call) => call === "tasks.listOpenTasks").length, 0, "read-back verification is performed inside TaskToolService");
    const persisted = await taskService.listOpenTasks({}, { goalId: "g", runId: result.runId, actionId: "read-after", userId: identity.userId, orgId: identity.orgId });
    assert.equal(persisted.success && persisted.data.length, 2);
    assert.match(result.answer, /Created task/);
  });

  it("does not propose a task for an empty CRM result", async () => {
    const calls: string[] = [];
    const api = apiWith(async (call) => { calls.push(`${call.tool}.${call.action}`); return { success: true, data: [] }; });
    const result = await api.run({ goal: "Find high-value leads that haven't been contacted in the last 30 days and create follow-up tasks for them", ...identity });
    assert.equal(result.status, "completed");
    assert.deepEqual(result.actions, []);
    assert.deepEqual(calls, ["crm.listInactiveLeads"]);
    assert.match(result.answer, /No CRM records matched the requested criteria/);
  });

  it("reports task action failures without a false success claim", async () => {
    const api = apiWith(async (call) => call.tool === "crm"
      ? { success: true, data: [{ id: "crm-1", name: "Prospect One", email: "one@example.test" }] }
      : { success: false, error: { code: "TASK_STORE_FAILED", message: "Task storage failed." } });
    const proposed = await api.run({ goal: "Find high-value leads that haven't been contacted in the last 30 days and create follow-up tasks for them", ...identity });
    const result = await api.decideAction(proposed.runId, identity.orgId, identity.userId, proposed.actions[0]!.id, "APPROVE", identity.userId);
    assert.equal(result?.status, "failed");
    assert.doesNotMatch(result!.answer, /Created task/);
    assert.match(result!.answer, /no successful task action was confirmed/);
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

  it("requires approval before drafting an email and reports only the verified Gmail result", async () => {
    let calls = 0;
    const api = apiWith(async (call) => {
      calls++;
      return { success: true, data: { draftId: "draft-confirmed", to: String(call.params.to), subject: String(call.params.subject), status: "DRAFT" } };
    });
    const proposed = await api.run({ goal: 'Draft email to lead@example.test subject "Next steps" body "Would you like to discuss next steps?"', ...identity });
    assert.equal(proposed.status, "awaiting_approval");
    assert.equal(calls, 0);
    const result = await api.decideAction(proposed.runId, identity.orgId, identity.userId, proposed.actions[0]!.id, "APPROVE", identity.userId);
    assert.equal(result?.status, "completed");
    assert.equal(calls, 1);
    assert.match(result!.answer, /Created Gmail draft/);
    assert.equal(result!.actions[0]!.lifecycle, "VERIFIED");
  });

  it("does not claim a sent email when execution fails or result verification mismatches", async () => {
    const failingApi = apiWith(async () => ({ success: false, error: { code: "EMAIL_RATE_LIMITED", message: "Gmail rate limited the request." } }));
    const sendProposal = await failingApi.run({ goal: "Send email draft draft-existing", ...identity });
    const failed = await failingApi.decideAction(sendProposal.runId, identity.orgId, identity.userId, sendProposal.actions[0]!.id, "APPROVE", identity.userId);
    assert.equal(failed?.status, "failed");
    assert.doesNotMatch(failed!.answer, /FACT: Sent Gmail message/);
    assert.match(failed!.answer, /no successful action was confirmed/);

    const invalidApi = apiWith(async () => ({ success: true, data: { messageId: "message-1", draftId: "different-draft", to: "lead@example.test", subject: "Subject", sentAt: "2026-09-30T00:00:00.000Z", status: "SENT" } }));
    const invalidProposal = await invalidApi.run({ goal: "Send email draft draft-requested", ...identity });
    const unverified = await invalidApi.decideAction(invalidProposal.runId, identity.orgId, identity.userId, invalidProposal.actions[0]!.id, "APPROVE", identity.userId);
    assert.equal(unverified?.status, "failed");
    assert.equal(unverified?.actions[0]?.lifecycle, "VERIFICATION_FAILED");
    assert.doesNotMatch(unverified!.answer, /FACT: Sent Gmail message/);
    assert.match(unverified!.answer, /could not be verified/);
  });

  it("approves and verifies a calendar event before reporting creation", async () => {
    let calls = 0;
    const api = apiWith(async (call) => {
      calls++;
      return { success: true, data: { id: "event-created", title: String(call.params.title), status: "SCHEDULED", startTime: call.params.startTime, endTime: call.params.endTime, attendees: call.params.attendees } };
    });
    const proposed = await api.run({ goal: 'Create calendar event titled "Lead review" from 2026-10-05T10:00:00.000Z to 2026-10-05T10:30:00.000Z attendees lead@example.test', ...identity });
    assert.equal(proposed.status, "awaiting_approval");
    assert.equal(proposed.actions[0]!.riskLevel, "HIGH");
    assert.equal(calls, 0);
    const result = await api.decideAction(proposed.runId, identity.orgId, identity.userId, proposed.actions[0]!.id, "APPROVE", identity.userId);
    assert.equal(result?.status, "completed");
    assert.match(result!.answer, /Created calendar event/);
    assert.equal(result!.actions[0]!.lifecycle, "VERIFIED");
  });

  it("keeps each follow-up email proposed until approved and processes CRM candidates one action at a time", async () => {
    const drafts = new Map<string, { to: string; subject: string }>();
    const calls: string[] = [];
    const api = apiWith(async (call) => {
      calls.push(`${call.tool}.${call.action}`);
      if (call.tool === "crm") return { success: true, data: [
        { id: "crm-1", name: "Prospect One", email: "one@example.test" },
        { id: "crm-2", name: "Prospect Two", email: "two@example.test" }
      ] };
      if (call.tool === "email" && call.action === "getEmailHistory") return { success: true, data: [] };
      if (call.tool === "email" && call.action === "draftEmail") {
        const draftId = `draft-${String(call.params.to)}`;
        drafts.set(draftId, { to: String(call.params.to), subject: String(call.params.subject) });
        return { success: true, data: { draftId, ...drafts.get(draftId)!, status: "DRAFT" } };
      }
      if (call.tool === "email" && call.action === "sendEmail") {
        const draftId = String(call.params.draftId), draft = drafts.get(draftId)!;
        return { success: true, data: { messageId: `message-${draftId}`, draftId, ...draft, sentAt: "2026-09-30T00:00:00.000Z", status: "SENT" } };
      }
      return { success: false, error: { code: "UNEXPECTED_TOOL", message: "Unexpected tool call." } };
    });
    let result = await api.run({ goal: "Follow up with all inactive high-value leads from the last 30 days", ...identity });
    assert.equal(result.status, "awaiting_approval");
    assert.deepEqual(calls, ["crm.listInactiveLeads", "email.getEmailHistory"]);
    let approvals = 0;
    while (result.status === "awaiting_approval") {
      const pending = result.actions.find((action) => action.lifecycle === "PROPOSED");
      assert.ok(pending, "run must expose the next proposed write action");
      const next = await api.decideAction(result.runId, identity.orgId, identity.userId, pending.id, "APPROVE", identity.userId);
      assert.ok(next);
      result = next!;
      approvals++;
      assert.ok(approvals <= 4, "each of two candidates gets one approved draft and one approved send");
    }
    assert.equal(result.status, "completed");
    assert.equal(approvals, 4);
    assert.equal(result.actions.filter((action) => action.lifecycle === "VERIFIED").length, 4);
    assert.equal(calls.filter((call) => call === "email.sendEmail").length, 2);
  });
});
