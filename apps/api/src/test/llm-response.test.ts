import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OpenAIResponseProvider } from "../agent/llm/unifiedLLM.js";
import { ToolObservation } from "../agent/policies/dataIntegrity.js";

const context = (data: unknown): ToolObservation[] => [{
  tool: "analytics",
  action: "getSalesMetrics",
  params: { timeWindowDays: 30 },
  result: { success: true, data }
}];

describe("goal-aware evidence response generation", () => {
  it("uses the user's goal and this run's tool results to generate a grounded summary", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const provider = new OpenAIResponseProvider({
      apiKey: "test-key",
      fetcher: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ choices: [{ message: { content: "FACT: Sales metrics returned total 42 [evidence: analytics.getSalesMetrics#1].\nINFERENCE: The total describes the requested period [evidence: analytics.getSalesMetrics#1].\nRECOMMENDATION: Compare against another period if needed [evidence: analytics.getSalesMetrics#1]." } }] }), { status: 200 });
      }
    });
    const results = context({ total: 42, currency: "USD" });
    const answer = await provider.generateResponse("Summarize my sales metrics", results, "FACT: Metrics returned [evidence: analytics.getSalesMetrics#1].");

    assert.match(answer, /total 42/);
    const messages = requestBody?.messages as Array<{ role: string; content: string }>;
    assert.match(messages[1]!.content, /Summarize my sales metrics/);
    assert.match(messages[1]!.content, /\"total\":42/);
  });

  it("keeps the deterministic report if the model cites evidence that was not retrieved", async () => {
    const report = "FACT: Metrics returned [evidence: analytics.getSalesMetrics#1].\nINFERENCE: Insufficient evidence to determine more.\nRECOMMENDATION: No unsupported action is recommended.";
    const provider = new OpenAIResponseProvider({
      apiKey: "test-key",
      fetcher: async () => new Response(JSON.stringify({ choices: [{ message: { content: "FACT: Invented total [evidence: crm.searchLeads#9].\nINFERENCE: Unsupported.\nRECOMMENDATION: Unsupported." } }] }), { status: 200 })
    });

    const answer = await provider.generateResponse("Summarize sales", context({ total: 42 }), report);
    assert.ok(answer.startsWith(report));
    assert.match(answer, /did not pass evidence-reference validation/);
  });

  it("explains when the response service is unavailable", async () => {
    const report = "FACT: Metrics returned [evidence: analytics.getSalesMetrics#1].\nINFERENCE: Insufficient evidence to determine more.\nRECOMMENDATION: No unsupported action is recommended.";
    const provider = new OpenAIResponseProvider({ apiKey: "test-key", fetcher: async () => new Response("", { status: 503 }) });

    const answer = await provider.generateResponse("Summarize sales", context({ total: 42 }), report);
    assert.ok(answer.startsWith(report));
    assert.match(answer, /did not respond successfully/);
  });

  it("preserves authoritative empty results without calling the model", async () => {
    let calls = 0;
    const provider = new OpenAIResponseProvider({ apiKey: "test-key", fetcher: async () => { calls++; throw new Error("must not run"); } });
    const report = "FACT: No matching records were found [evidence: crm.searchLeads#1].\nINFERENCE: Insufficient evidence to determine more.\nRECOMMENDATION: No unsupported action is recommended.";
    const empty: ToolObservation[] = [{ tool: "crm", action: "searchLeads", params: {}, result: { success: true, data: [] } }];

    assert.equal(await provider.generateResponse("Summarize leads", empty, report), report);
    assert.equal(calls, 0);
  });
});
