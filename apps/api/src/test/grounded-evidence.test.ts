import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EvidenceBundle } from "@nexusops/shared-types";
import {
  buildEvidenceBundle,
  buildEvidenceReport,
  type EvidenceItem,
  type ToolObservation,
  validateGroundedAnswer
} from "../agent/policies/dataIntegrity.js";

const evidenceRefs = {
  crm: "crm.resolveContact#1",
  gmail: "email.getEmailHistory#2",
  calendar: "calendar.findEventsForLead#3"
};

function crossSourceObservations(): ToolObservation[] {
  return [
    {
      tool: "crm",
      action: "resolveContact",
      params: { query: "Rahul" },
      result: { success: true, data: {
        status: "RESOLVED",
        entity: {
          crmRecordRef: "private-crm-id", canonicalName: "Rahul Sharma", company: "Acme",
          email: "rahul@acme.invalid", confidence: 0.99, matchedBy: "exact_identity"
        }
      } }
    },
    {
      tool: "email",
      action: "getEmailHistory",
      params: { leadEmail: "rahul@acme.invalid" },
      result: { success: true, data: [
        { id: "private-message", threadId: "private-thread", direction: "OUTBOUND", responseStatus: "ANSWERED" },
        { id: "private-reply", threadId: "private-thread", direction: "INBOUND", senderEmail: "rahul@acme.invalid", sentAt: "2026-09-30T10:00:00.000Z" }
      ] }
    },
    {
      tool: "calendar",
      action: "findEventsForLead",
      params: { leadEmail: "rahul@acme.invalid" },
      result: { success: true, data: [
        { id: "private-event", title: "Quarterly review", attendees: ["rahul@acme.invalid"], startTime: "2026-10-05T10:00:00.000Z" }
      ] }
    }
  ];
}

function answerCandidate(
  evidence: EvidenceBundle,
  claims: Array<{ text: string; evidenceRefs: string[] }>,
  recommendations: Array<{ statement: string; reason: string; evidenceRefs: string[]; expectedOutcome: string }> = []
) {
  return {
    status: evidence.sufficiency,
    answer: "Untrusted freeform text is never returned.",
    claims: claims.map((claim, index) => ({
      claimId: `claim-${index + 1}`, ...claim, status: "supported" as const
    })),
    evidenceRefs: claims.flatMap(({ evidenceRefs }) => evidenceRefs),
    limitations: [],
    recommendations
  };
}

describe("generic grounded evidence", () => {
  it("grounds CRM, Gmail, Calendar, and cross-source claims in the same resolved identity", () => {
    const report = buildEvidenceReport(crossSourceObservations(), ["crm", "gmail", "calendar"]);
    const crm = report.FACT[0]!;
    const gmail = report.FACT[1]!;
    const calendar = report.FACT[2]!;
    assert.equal(report.bundle.sufficiency, "SUPPORTED");
    assert.equal(report.bundle.resolvedEntities.length, 1);
    assert.equal(gmail.sourceMatches?.[0]?.resolvedEntityRef, crm.sourceMatches?.[0]?.resolvedEntityRef);
    assert.equal(calendar.sourceMatches?.[0]?.resolvedEntityRef, crm.sourceMatches?.[0]?.resolvedEntityRef);

    const answer = validateGroundedAnswer(answerCandidate(report.bundle, [
      { text: crm.statement, evidenceRefs: [crm.evidenceRef] },
      { text: "A reply was received from the exact CRM-resolved contact.", evidenceRefs: [gmail.evidenceRef] },
      { text: "Event matched the exact CRM-resolved attendee email within the bounded search window at 2026-10-05T10:00:00.000Z.", evidenceRefs: [calendar.evidenceRef] },
      { text: "Rahul Sharma at Acme had a reply and an event at 2026-10-05T10:00:00.000Z.", evidenceRefs: [crm.evidenceRef, gmail.evidenceRef, calendar.evidenceRef] }
    ]), report.bundle, report.FACT);
    assert.equal(answer.claims.length, 4);
    assert.ok(answer.claims.every(({ status }) => status === "supported"));
    assert.match(answer.answer, /\[evidence: crm\.resolveContact#1, email\.getEmailHistory#2, calendar\.findEventsForLead#3\]/);
    assert.doesNotMatch(JSON.stringify(report.bundle), /rahul@acme\.invalid|private-crm-id|private-thread|private-message|private-event/);
  });

  it("preserves NOT_FOUND separately from incomplete cross-source evidence", () => {
    const emptyCRM = buildEvidenceReport([{
      tool: "crm", action: "searchLeads", params: {},
      result: { success: true, data: [] }
    }]);
    assert.equal(emptyCRM.bundle.sufficiency, "NOT_FOUND");
    assert.match(emptyCRM.FACT[0]!.statement, /No CRM records matched/);

    const partial = buildEvidenceReport([
      crossSourceObservations()[0]!,
      { tool: "email", action: "getEmailHistory", params: { leadEmail: "private" }, result: { success: true, data: [] } }
    ], ["crm", "gmail", "calendar"]);
    assert.equal(partial.bundle.sufficiency, "INSUFFICIENT_EVIDENCE");
    assert.match(partial.FACT[1]!.statement, /No matching Gmail messages/);
    assert.doesNotMatch(partial.FACT[1]!.statement, /never replied|did not reply/i);
    assert.equal(partial.bundle.sourceCoverage.find(({ source }) => source === "calendar")?.retrievalStatus, "NOT_ATTEMPTED");

    const calendarNoMatch = buildEvidenceReport([
      crossSourceObservations()[0]!,
      { tool: "calendar", action: "findEventsForLead", params: { leadEmail: "private" }, result: { success: true, data: [] } }
    ], ["crm", "calendar"]);
    assert.match(calendarNoMatch.FACT[1]!.statement, /bounded search window/i);
    assert.doesNotMatch(calendarNoMatch.FACT[1]!.statement, /requested date range/i);
  });

  it("links dependent Gmail and Calendar results to one exact CRM candidate email", () => {
    const report = buildEvidenceReport([
      {
        tool: "crm", action: "searchLeads", params: {},
        result: { success: true, data: [{
          id: "candidate-id", name: "Dana Lee", email: "dana@example.invalid",
          company: "Example Corp", dealValue: 42_000
        }] }
      },
      {
        tool: "email", action: "getEmailHistory", params: { leadEmail: "DANA@example.invalid" },
        result: { success: true, data: [
          { id: "message-id", threadId: "thread-id", direction: "OUTBOUND" },
          { id: "reply-id", threadId: "thread-id", direction: "INBOUND", senderEmail: "dana@example.invalid" }
        ] }
      },
      {
        tool: "calendar", action: "findEventsForLead", params: { leadEmail: "dana@example.invalid" },
        result: { success: true, data: [{ id: "event-id", title: "Review", startTime: "2026-10-06T10:00:00.000Z" }] }
      }
    ], ["crm", "gmail", "calendar"]);
    const crmEntityRef = report.FACT[0]!.sourceMatches?.[0]?.resolvedEntityRef;
    assert.ok(crmEntityRef);
    assert.equal(report.FACT[1]!.sourceMatches?.[0]?.resolvedEntityRef, crmEntityRef);
    assert.equal(report.FACT[2]!.sourceMatches?.[0]?.resolvedEntityRef, crmEntityRef);
    assert.doesNotMatch(JSON.stringify(report.bundle), /dana@example\.invalid|candidate-id|thread-id|event-id/);
  });

  it("does not attribute an unrelated inbound sender as the CRM contact's reply", () => {
    const observations = crossSourceObservations();
    const gmail = observations[1]!;
    if (gmail.result.success && Array.isArray(gmail.result.data)) {
      gmail.result.data[1] = { ...gmail.result.data[1] as Record<string, unknown>, senderEmail: "unrelated@example.invalid" };
    }
    const report = buildEvidenceReport(observations);
    assert.equal(report.FACT[1]!.resolutionStatus, "INSUFFICIENT_EVIDENCE");
    assert.match(report.FACT[1]!.statement, /no reply from the exact CRM-resolved contact was established/i);
    assert.doesNotMatch(report.FACT[1]!.statement, /received a reply/);
  });

  it("preserves ambiguity and all source failure categories", () => {
    const ambiguous = buildEvidenceReport([{
      tool: "crm", action: "resolveContact", params: {},
      result: { success: true, data: { status: "AMBIGUOUS", candidates: [{ crmRecordRef: "one" }, { crmRecordRef: "two" }] } }
    }]);
    assert.equal(ambiguous.bundle.sufficiency, "AMBIGUOUS");

    const cases = [
      ["EMAIL_NOT_CONNECTED", "INTEGRATION_NOT_CONNECTED"],
      ["EMAIL_ACCESS_DENIED", "AUTHORIZATION_DENIED"],
      ["EMAIL_UNAVAILABLE", "SOURCE_UNAVAILABLE"],
      ["UNEXPECTED_FAILURE", "TOOL_FAILURE"]
    ] as const;
    for (const [code, expected] of cases) {
      const report = buildEvidenceReport([{
        tool: "email", action: "getEmailHistory", params: {},
        result: { success: false, error: { code, message: "private source error" } }
      }]);
      assert.equal(report.bundle.sufficiency, expected);
      assert.equal(report.bundle.sourceCoverage[0]?.retrievalStatus, "FAILED");
      assert.doesNotMatch(JSON.stringify(report.bundle), /private source error/);
    }
  });

  it("detects conflicting attributes for one cross-source CRM identity", () => {
    const commonRef = "crm.contact#hashed";
    const facts: EvidenceItem[] = [
      {
        evidenceRef: "crm.resolveContact#1", tool: "crm", action: "resolveContact",
        statement: "CRM resolved the requested contact.", outcome: "RESULT_RETURNED", resolutionStatus: "RESOLVED",
        sourceMatches: [{
          source: "crm", recordRef: commonRef, resolvedEntityRef: commonRef,
          matchedBy: "exact_identity", confidence: 1, summary: "CRM identity at Acme.",
          relevantFields: { company: "Acme" }
        }]
      },
      {
        evidenceRef: "email.getEmailHistory#2", tool: "email", action: "getEmailHistory",
        statement: "Gmail returned matching messages.", outcome: "RESULT_RETURNED", resolutionStatus: "RESOLVED",
        sourceMatches: [{
          source: "gmail", recordRef: "gmail.thread#hashed", resolvedEntityRef: commonRef,
          matchedBy: "exact_contact_email", confidence: 1, summary: "Gmail matched the CRM identity.",
          relevantFields: { company: "Other Company" }
        }]
      }
    ];
    const bundle = buildEvidenceBundle(facts);
    assert.equal(bundle.sufficiency, "CONFLICTING");
    assert.equal(bundle.conflicts[0]?.field, "company");
    assert.deepEqual(bundle.conflicts[0]?.values.map(({ value }) => value), ["Acme", "Other Company"]);
    const answer = validateGroundedAnswer(undefined, bundle, facts);
    assert.equal(answer.status, "CONFLICTING");
    assert.match(answer.answer, /conflicting values for company/i);
    assert.match(answer.answer, /\[evidence: crm\.resolveContact#1, email\.getEmailHistory#2\]/);
  });

  it("rejects hallucinated claims, invalid references, and malformed model output", () => {
    const report = buildEvidenceReport(crossSourceObservations());
    const evidence = report.bundle;
    const fact = report.FACT[0]!;
    const fabricated = validateGroundedAnswer(answerCandidate(evidence, [
      { text: "Rahul signed a contract worth 900000.", evidenceRefs: [fact.evidenceRef] }
    ]), evidence, report.FACT);
    assert.doesNotMatch(fabricated.answer, /900000|signed a contract/i);
    assert.ok(fabricated.limitations.some((item) => /failed evidence validation/i.test(item)));

    const invalidRef = validateGroundedAnswer(answerCandidate(evidence, [
      { text: fact.statement, evidenceRefs: ["crm.private#wrong"] }
    ]), evidence, report.FACT);
    assert.equal(invalidRef.claims[0]?.evidenceRefs[0], fact.evidenceRef);

    const malformed = validateGroundedAnswer({ answer: "Unsupported text" }, evidence, report.FACT);
    assert.doesNotMatch(malformed.answer, /Unsupported text/);
    assert.ok(malformed.limitations.some((item) => /malformed output/i.test(item)));

    const unavailable = validateGroundedAnswer(undefined, evidence, report.FACT, "service_unavailable");
    assert.ok(unavailable.limitations.some((item) => /answer generation service was unavailable/i.test(item)));
  });

  it("validates a recommendation only when its reason cites supported evidence", () => {
    const report = buildEvidenceReport(crossSourceObservations());
    const gmail = report.FACT[1]!;
    const accepted = validateGroundedAnswer(answerCandidate(report.bundle, [{
      text: gmail.statement, evidenceRefs: [gmail.evidenceRef]
    }], [{
      statement: "Review the reply.",
      reason: "A reply was received from the exact CRM-resolved contact.",
      evidenceRefs: [gmail.evidenceRef],
      expectedOutcome: "A reply was received from the exact CRM-resolved contact."
    }]), report.bundle, report.FACT);
    assert.equal(accepted.recommendations.length, 1);

    const rejected = validateGroundedAnswer(answerCandidate(report.bundle, [{
      text: gmail.statement, evidenceRefs: [gmail.evidenceRef]
    }], [{
      statement: "Send a contract.",
      reason: "The contact has approved all pricing terms.",
      evidenceRefs: [gmail.evidenceRef],
      expectedOutcome: "Close the deal."
    }]), report.bundle, report.FACT);
    assert.equal(rejected.recommendations.length, 0);
    assert.ok(rejected.limitations.some((item) => /failed evidence validation/i.test(item)));

    for (const recommendation of [
      { statement: "Send the contract.", reason: "A reply was received from the exact CRM-resolved contact.", expectedOutcome: "A reply was received from the exact CRM-resolved contact." },
      { statement: "Review the reply.", reason: "A reply was received from the exact CRM-resolved contact.", expectedOutcome: "Close the deal." }
    ]) {
      const unsupported = validateGroundedAnswer(answerCandidate(report.bundle, [{
        text: gmail.statement, evidenceRefs: [gmail.evidenceRef]
      }], [{
        ...recommendation,
        evidenceRefs: [gmail.evidenceRef]
      }]), report.bundle, report.FACT);
      assert.equal(unsupported.recommendations.length, 0);
    }
  });

  it("does not return a negative person-level claim for empty Gmail evidence", () => {
    const report = buildEvidenceReport([
      crossSourceObservations()[0]!,
      { tool: "email", action: "getEmailHistory", params: { leadEmail: "private" }, result: { success: true, data: [] } }
    ]);
    const gmail = report.FACT[1]!;
    const rejected = validateGroundedAnswer(answerCandidate(report.bundle, [
      { text: "Rahul never replied.", evidenceRefs: [gmail.evidenceRef] }
    ]), report.bundle, report.FACT);
    assert.doesNotMatch(rejected.answer, /Rahul never replied/);
    assert.match(rejected.answer, /does not prove/i.test(rejected.answer) ? /does not prove/i : /No matching Gmail messages/);
  });

  it("returns a clear insufficient-evidence response when no tools ran", () => {
    const report = buildEvidenceReport([]);
    const answer = validateGroundedAnswer(undefined, report.bundle, report.FACT);
    assert.equal(answer.status, "INSUFFICIENT_EVIDENCE");
    assert.match(answer.answer, /Insufficient evidence/);
    assert.equal(answer.claims.length, 0);
  });
});
