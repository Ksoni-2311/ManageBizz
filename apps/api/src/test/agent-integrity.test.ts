import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildEvidenceReport, AGENT_INTEGRITY_INSTRUCTIONS, canAssertGoalCompletion, EmptyResultCallGuard, emptyToolCallKey } from "../agent/policies/dataIntegrity.js";
import { StepStatus } from "@nexusops/shared-types";
import { CRMToolService } from "../tools/crmTool.js";
import { EmailToolService } from "../tools/emailTool.js";
import { CalendarToolService } from "../tools/calendarTool.js";
import { ToolObservation } from "../agent/policies/dataIntegrity.js";

const context = { goalId: "goal", runId: "integrity-test", actionId: "action", userId: "user", orgId: "org" };

describe("agent evidence integrity", () => {
  it("publishes the non-negotiable anti-hallucination rules to the planner", () => {
    for (const required of [
      "Never invent business data", "Never regenerate or replace data", "Preserve business tool results exactly",
      "Do not repeat a tool call with identical arguments", "Do not relax user criteria", "Business facts must come from business tool results",
      "FACT, INFERENCE, or RECOMMENDATION"
    ]) assert.ok(AGENT_INTEGRITY_INSTRUCTIONS.includes(required));
  });

  it("reports empty CRM results explicitly without adding records", async () => {
    const crm = new CRMToolService();
    crm.setLeads([], "org");
    const result = await crm.listActiveHighValueLeads({ minDealValue: 100_000 }, context);
    assert.equal(result.success, true);
    if (!result.success) return;
    const report = buildEvidenceReport([{ tool: "crm", action: "listActiveHighValueLeads", params: { minDealValue: 100_000 }, result }]);
    assert.match(report.FACT[0]!.statement, /No active high-value leads were found/);
    assert.equal(report.FACT[0]!.outcome, "EMPTY_RESULT");
    assert.equal(Object.hasOwn(report.FACT[0]!, "data"), false);
    assert.equal(report.evidenceInsufficient, true);
    assert.deepEqual(report.recommendationEvidence, []);
    assert.equal(report.FACT[0]!.evidenceRef, "crm.listActiveHighValueLeads#1");
  });

  it("reports empty email history without inferring anything about replies", async () => {
    const email = new EmailToolService();
    const result = await email.getEmailHistory({ leadEmail: "person@example.test" }, context);
    assert.equal(result.success, true);
    if (!result.success) return;
    const report = buildEvidenceReport([{ tool: "email", action: "getEmailHistory", params: { leadEmail: "person@example.test" }, result }]);
    assert.equal(report.FACT[0]!.statement, "No email history was found for this lead.");
    assert.match(report.INFERENCE[0]!, /insufficient/i);
    assert.doesNotMatch(report.FACT[0]!.statement, /respond|reply/i);
  });

  it("links recommendations only to retrieved CRM evidence and marks missing email evidence", () => {
    const report = buildEvidenceReport([
      {
        tool: "crm", action: "listInactiveLeads", params: { minDealValue: 100_000 },
        result: { success: true, data: [{}], metadata: { executionTimeMs: 1, actionId: "crm-action" } }
      },
      {
        tool: "email", action: "getEmailHistory", params: {},
        result: { success: true, data: [], metadata: { executionTimeMs: 1, actionId: "email-action" } }
      }
    ]);

    assert.deepEqual(report.recommendationEvidence, [{
      statement: "Review the matching inactive high-value leads to decide whether follow-up is appropriate.",
      evidenceRefs: ["crm.listInactiveLeads#1"]
    }]);
    assert.ok(report.INFERENCE.some((line) => /Insufficient evidence to determine/i.test(line)));
    assert.equal(report.FACT[1]!.evidenceRef, "email.getEmailHistory#2");
  });

  it("reports empty calendar availability as no matching slots", async () => {
    const calendar = new CalendarToolService();
    const result = await calendar.getAvailability({}, context);
    assert.equal(result.success, true);
    if (!result.success) return;
    const report = buildEvidenceReport([{ tool: "calendar", action: "getAvailability", params: {}, result }]);
    assert.equal(report.FACT[0]!.statement, "No matching calendar availability was found.");
    assert.equal(report.FACT[0]!.outcome, "EMPTY_RESULT");
  });

  it("does not repeat a tool call with canonically identical arguments after an empty result", async () => {
    const guard = new EmptyResultCallGuard();
    const paramsA = { threshold: 100, status: "New" };
    const paramsB = { status: "New", threshold: 100 };
    const keyA = emptyToolCallKey(context.runId, context.orgId, "crm", "searchLeads", paramsA);
    const keyB = emptyToolCallKey(context.runId, context.orgId, "crm", "searchLeads", paramsB);
    assert.equal(keyA, keyB);
    let calls = 0;
    const invoke = async () => {
      calls += 1;
      return { success: true as const, data: [], metadata: { executionTimeMs: 1, actionId: context.actionId } };
    };
    const first = await guard.execute(keyA, "first-action", invoke);
    const second = await guard.execute(keyB, "second-action", invoke);
    assert.equal(first.success, true);
    assert.equal(second.success, false);
    if (!second.success) assert.equal(second.error.code, "DUPLICATE_EMPTY_QUERY");
    assert.equal(calls, 1);
  });

  it("does not make unsupported action claims when an action tool rejects the action", () => {
    const rejected = {
      success: false as const,
      error: { code: "INTEGRATION_UNAVAILABLE", message: "No message was sent." }
    };
    const observation: ToolObservation = { tool: "email", action: "sendEmail", params: {}, result: rejected };
    const report = buildEvidenceReport([observation]);
    assert.match(report.FACT[0]!.statement, /did not confirm success/);
    assert.doesNotMatch(JSON.stringify(report), /The email was sent|Email delivered/i);
    assert.deepEqual(report.RECOMMENDATION, []);
    assert.equal(report.evidenceInsufficient, true);
    assert.ok(report.FACT.every((fact) => !Object.hasOwn(fact, "data")));
    assert.equal(canAssertGoalCompletion([StepStatus.FAILED]), false);
    assert.equal(canAssertGoalCompletion([StepStatus.SKIPPED]), false);
    assert.equal(canAssertGoalCompletion([]), false);
    assert.equal(canAssertGoalCompletion([StepStatus.COMPLETED]), true);
  });
});
