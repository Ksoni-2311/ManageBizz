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
    crm.setLeads([], "org", "user");
    const result = await crm.listActiveHighValueLeads({ minDealValue: 100_000 }, context);
    assert.equal(result.success, true);
    if (!result.success) return;
    const report = buildEvidenceReport([{ tool: "crm", action: "listActiveHighValueLeads", params: { minDealValue: 100_000 }, result }]);
    assert.equal(report.FACT[0]!.statement, "No CRM records matched the requested criteria.");
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

  it("normalizes CRM evidence without exposing private fields or inventing ranking recommendations", () => {
    const report = buildEvidenceReport([
      {
        tool: "crm", action: "listInactiveLeads", params: { minDealValue: 100_000 },
        result: { success: true, data: [
          {
            id: "internal-crm-id",
            name: "Prospect One",
            email: "person@example.test",
            company: "Example Company",
            dealValue: 120_000,
            status: "Negotiation",
            lastContactedAt: new Date("2026-01-01T00:00:00.000Z"),
            phone: "555-0100",
            notes: ["private note"],
            owner: "private owner"
          },
          {
            id: "internal-crm-id-2",
            name: "Prospect Two",
            company: "Other Company",
            dealValue: 80_000
          }
        ], metadata: { executionTimeMs: 1, actionId: "crm-action" } }
      },
      {
        tool: "email", action: "getEmailHistory", params: {},
        result: { success: true, data: [], metadata: { executionTimeMs: 1, actionId: "email-action" } }
      }
    ]);

    assert.equal(report.structuredResult?.resultType, "crm_records");
    assert.equal(report.structuredResult?.count, 2);
    assert.equal(report.structuredResult?.records.length, 2);
    assert.deepEqual(report.structuredResult?.records[0], {
      recordRef: "crm.listInactiveLeads#1:record-1",
      name: "Prospect One",
      company: "Example Company",
      dealValue: 120_000,
      status: "Negotiation",
      lastContactedAt: "2026-01-01T00:00:00.000Z"
    });
    assert.doesNotMatch(JSON.stringify(report.structuredResult), /person@example\.test|555-0100|private note|private owner|internal-crm-id/);
    assert.equal(report.FACT[0]!.statement, "CRM returned 2 record(s) matching the requested criteria.");
    assert.deepEqual(report.FACT[0]!.recordRefs, [
      "crm.listInactiveLeads#1:record-1",
      "crm.listInactiveLeads#1:record-2"
    ]);
    assert.deepEqual(report.recommendationEvidence, []);
    assert.equal(report.bundle.resolvedEntities.length, 2);
    assert.doesNotMatch(JSON.stringify(report.bundle), /person@example\.test|555-0100|private note|private owner|internal-crm-id/);
    assert.ok(report.INFERENCE.some((line) => /Insufficient evidence to determine/i.test(line)));
    assert.equal(report.FACT[1]!.evidenceRef, "email.getEmailHistory#2");
  });

  it("omits malformed and absent CRM fields without inventing replacement values", () => {
    const report = buildEvidenceReport([{
      tool: "crm",
      action: "searchLeads",
      params: { minDealValue: 25_000 },
      result: {
        success: true,
        data: [
          null,
          { name: "Partial record", company: "", dealValue: Number.NaN, status: 17 },
          { name: 99 }
        ]
      }
    }]);

    assert.equal(report.structuredResult?.count, 3);
    assert.equal(report.structuredResult?.omittedCount, 2);
    assert.deepEqual(report.structuredResult?.records, [{
      recordRef: "crm.searchLeads#1:record-2",
      name: "Partial record"
    }]);
    assert.equal(report.FACT[0]!.outcome, "RESULT_RETURNED");
    assert.equal(report.evidenceInsufficient, true);
  });

  it("represents an empty CRM query as an empty scoped result", () => {
    const report = buildEvidenceReport([{
      tool: "crm",
      action: "listInactiveLeads",
      params: { minDaysInactive: 30, minDealValue: 25_000 },
      result: { success: true, data: [] }
    }]);
    assert.deepEqual(report.structuredResult, {
      resultType: "crm_records",
      source: "crm",
      title: "Inactive high-value leads",
      count: 0,
      records: [],
      omittedCount: 0,
      truncatedCount: 0,
      matchingCriteria: [
        "Last contacted more than 30 days ago",
        "Deal value at least 25,000"
      ]
    });
    assert.equal(report.FACT[0]!.statement, "No CRM records matched the requested criteria.");
    assert.equal(report.evidenceInsufficient, true);
  });

  it("does not expose a malformed CRM collection or a failed tool as structured records", () => {
    const malformed = buildEvidenceReport([{
      tool: "crm", action: "listInactiveLeads", params: {},
      result: { success: true, data: { unexpected: "payload" } }
    }]);
    assert.equal(malformed.structuredResult, undefined);
    assert.equal(malformed.FACT[0]!.statement, "CRM did not return a valid record collection.");
    assert.equal(malformed.FACT[0]!.outcome, "SUCCESS_NOT_CONFIRMED");
    assert.equal(malformed.evidenceInsufficient, true);

    const failed = buildEvidenceReport([{
      tool: "crm", action: "listInactiveLeads", params: {},
      result: { success: false, error: { code: "DATA_UNAVAILABLE", message: "CRM unavailable" } }
    }]);
    assert.equal(failed.structuredResult, undefined);
    assert.equal(failed.FACT[0]!.outcome, "SUCCESS_NOT_CONFIRMED");
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

  it("keeps cross-source evidence attributable without exposing source identifiers or contact email", () => {
    const report = buildEvidenceReport([
      { tool: "crm", action: "resolveContact", params: { query: "Rahul" }, result: { success: true, data: {
        status: "RESOLVED", entity: { crmRecordRef: "private-crm-record", canonicalName: "Rahul Sharma", company: "Acme", email: "rahul@acme.test", confidence: 0.99, matchedBy: "exact_email" }
      } } },
      { tool: "email", action: "getEmailHistory", params: { leadEmail: "rahul@acme.test" }, result: { success: true, data: [
        { id: "private-message", threadId: "private-thread", leadEmail: "rahul@acme.test", direction: "OUTBOUND", responseStatus: "ANSWERED", subject: "Proposal" },
        { id: "private-reply", threadId: "private-thread", leadEmail: "rahul@acme.test", senderEmail: "rahul@acme.test", direction: "INBOUND", responseStatus: "INBOUND", subject: "Re: Proposal" }
      ] } },
      { tool: "calendar", action: "findEventsForLead", params: { leadEmail: "rahul@acme.test" }, result: { success: true, data: [
        { id: "private-event", title: "Proposal review", attendees: ["rahul@acme.test"], startTime: "2026-10-05T10:00:00.000Z", endTime: "2026-10-05T10:30:00.000Z" }
      ] } }
    ]);
    assert.equal(report.FACT[0]?.resolutionStatus, "RESOLVED");
    assert.equal(report.FACT[1]?.resolutionStatus, "RESOLVED");
    assert.equal(report.FACT[2]?.resolutionStatus, "RESOLVED");
    assert.match(report.FACT[1]?.matchingCriteria?.join(" ") ?? "", /exact CRM-resolved email participant/);
    assert.match(report.FACT[2]?.matchingCriteria?.join(" ") ?? "", /exact attendee email/);
    assert.doesNotMatch(JSON.stringify(report), /private-crm-record|private-thread|private-message|private-event|rahul@acme\.test/);
    assert.ok(report.FACT[1]?.recordRefs?.[0]?.startsWith("gmail.thread#"));
    assert.ok(report.FACT[2]?.recordRefs?.[0]?.startsWith("calendar.event#"));
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
