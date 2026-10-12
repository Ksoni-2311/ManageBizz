import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EvidenceBundle } from "@nexusops/shared-types";
import { OpenAIResponseProvider } from "../agent/llm/unifiedLLM.js";

const evidence: EvidenceBundle = {
  sufficiency: "SUPPORTED",
  items: [{
    evidenceRef: "crm.searchLeads#1",
    source: "crm",
    statement: "CRM returned 1 matching record.",
    recordRefs: ["crm.contact#hashed"],
    resolvedEntityRefs: ["crm.contact#hashed"],
    matchingCriteria: [],
    sourceMatches: [{
      source: "crm",
      recordRef: "crm.contact#hashed",
      resolvedEntityRef: "crm.contact#hashed",
      matchedBy: "crm_query",
      confidence: 1,
      summary: "CRM contact Dana at Example Corp with deal value 42000.",
      relevantFields: { name: "Dana", company: "Example Corp", dealValue: 42_000 }
    }]
  }],
  resolvedEntities: [{ entityRef: "crm.contact#hashed", type: "crm_contact", name: "Dana", company: "Example Corp" }],
  sourceCoverage: [{ source: "crm", status: "SUPPORTED", retrievalStatus: "RETRIEVED", evidenceRefs: ["crm.searchLeads#1"] }],
  conflicts: [],
  limitations: []
};

describe("structured grounded-answer generation", () => {
  it("sends only the sanitized evidence bundle and requests structured claims", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const provider = new OpenAIResponseProvider({
      apiKey: "test-key",
      fetcher: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify({
            status: "SUPPORTED",
            answer: "Untrusted freeform output.",
            claims: [{
              claimId: "claim-1",
              text: "CRM returned 1 matching record.",
              evidenceRefs: ["crm.searchLeads#1"],
              status: "supported"
            }],
            evidenceRefs: ["crm.searchLeads#1"],
            limitations: [],
            recommendations: []
          }) } }]
        }), { status: 200 });
      }
    });
    const result = await provider.generateGroundedAnswer("Summarize the CRM result", evidence);
    assert.equal(result.kind, "generated");
    if (result.kind !== "generated") return;
    const candidate = result.candidate as { claims: Array<{ text: string }> };
    assert.equal(candidate.claims[0]?.text, "CRM returned 1 matching record.");
    const messages = requestBody?.messages as Array<{ role: string; content: string }>;
    assert.match(messages[1]!.content, /crm\.contact#hashed/);
    assert.match(messages[0]!.content, /every factual claim.*evidenceRef/i);
    assert.doesNotMatch(messages[1]!.content, /email|phone|notes|owner|token/i);
    assert.doesNotMatch(messages[1]!.content, /Untrusted freeform output/);
  });

  it("returns no model candidate on malformed or unavailable responses for deterministic fallback", async () => {
    const malformed = new OpenAIResponseProvider({
      apiKey: "test-key",
      fetcher: async () => new Response(JSON.stringify({ choices: [{ message: { content: "{not-json" } }] }), { status: 200 })
    });
    assert.deepEqual(await malformed.generateGroundedAnswer("Summarize", evidence), {
      kind: "unavailable", reason: "malformed_output"
    });

    const unavailable = new OpenAIResponseProvider({
      apiKey: "test-key",
      fetcher: async () => new Response("", { status: 503 })
    });
    assert.deepEqual(await unavailable.generateGroundedAnswer("Summarize", evidence), {
      kind: "unavailable", reason: "service_unavailable"
    });
  });
});
