import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OpenAIResponseProvider } from "../agent/llm/unifiedLLM.js";
import { deterministicQueryAnalysis } from "../agent/queryAnalysis.js";
import { planBusinessGoal } from "../agent/runtime/controlledOrchestrator.js";

const parsed = (objective: string) => ({ objective, timeWindowDays: 30, constraints: [], successCriteria: [] });

describe("structured business query analysis", () => {
  it("routes a reply check through runtime CRM identity resolution", () => {
    const plan = deterministicQueryAnalysis("Did Rahul reply to my proposal?");
    assert.equal(plan.intent, "email_reply_check");
    assert.deepEqual(plan.entities, [{ type: "person", value: "Rahul" }]);
    assert.deepEqual(plan.sources, ["crm", "gmail"]);
    assert.ok(plan.requestedFacts.some((fact) => fact.includes("reply")));
    assert.equal(plan.ambiguity.type, "none");
    assert.deepEqual(plan.ambiguity.candidates, []);
  });

  it("extracts the explicit high-value and 30-day last-contact criteria", () => {
    const plan = deterministicQueryAnalysis("Which high-value leads haven't been contacted in the last 30 days?");
    assert.equal(plan.intent, "crm_lead_search");
    assert.deepEqual(plan.sources, ["crm"]);
    assert.ok(plan.filters.some(({ field, value }) => field === "highValue" && value === true));
    assert.ok(plan.filters.some(({ field, value }) => field === "lastContactedAt" && value === "last 30 days"));
    assert.equal(plan.dateRange?.expression, "last 30 days");
  });

  it("requires CRM identities before checking client reply status or high-value email interaction", () => {
    const clients = deterministicQueryAnalysis("Which clients haven't replied?");
    assert.equal(clients.intent, "email_reply_check");
    assert.deepEqual(clients.sources, ["crm", "gmail"]);
    const highValue = deterministicQueryAnalysis("Which high-value leads have no recent email interaction?");
    assert.equal(highValue.intent, "crm_lead_search");
    assert.deepEqual(highValue.sources, ["crm", "gmail"]);
    assert.deepEqual(highValue.entities, []);
    assert.ok(highValue.filters.some(({ field }) => field === "highValue"));
  });

  it("extracts tomorrow as a calendar range and preserves the supplied timezone", () => {
    const plan = deterministicQueryAnalysis("What meetings do I have tomorrow?", "Asia/Kolkata");
    assert.equal(plan.intent, "calendar_event_search");
    assert.deepEqual(plan.sources, ["calendar"]);
    assert.deepEqual(plan.dateRange, { type: "relative", expression: "tomorrow", timezone: "Asia/Kolkata" });
  });

  it("extracts a company for a CRM deal-value lookup", () => {
    const plan = deterministicQueryAnalysis("What is ABC Technologies' deal value?");
    assert.equal(plan.intent, "crm_deal_value");
    assert.deepEqual(plan.entities, [{ type: "company", value: "ABC Technologies" }]);
    assert.deepEqual(plan.sources, ["crm"]);
  });

  it("routes named sender searches through CRM before Gmail", () => {
    const plan = deterministicQueryAnalysis("Find emails from Rahul");
    assert.equal(plan.intent, "email_search");
    assert.deepEqual(plan.entities, [{ type: "person", value: "Rahul" }]);
    assert.deepEqual(plan.sources, ["crm", "gmail"]);
    assert.equal(plan.ambiguity.type, "none");
  });

  it("selects CRM and Calendar for meetings requested with CRM clients", () => {
    const plan = deterministicQueryAnalysis("Show upcoming meetings with my clients");
    assert.equal(plan.intent, "calendar_event_search");
    assert.deepEqual(plan.sources, ["crm", "calendar"]);
    assert.deepEqual(plan.dependencies, [{ source: "calendar", dependsOn: "crm" }]);
  });

  it("selects CRM and Gmail for a company reply check", () => {
    const plan = deterministicQueryAnalysis("Did ABC respond to my proposal?");
    assert.equal(plan.intent, "email_reply_check");
    assert.deepEqual(plan.entities, [{ type: "company", value: "ABC" }]);
    assert.deepEqual(plan.sources, ["crm", "gmail"]);
  });

  it("defers first-name ambiguity to the CRM resolver instead of blocking planning", () => {
    const plan = deterministicQueryAnalysis("Did Rahul reply?");
    assert.equal(plan.ambiguity.type, "none");
    assert.deepEqual(plan.sources, ["crm", "gmail"]);
  });

  it("extracts an explicit email address as an email entity", () => {
    const plan = deterministicQueryAnalysis("Find emails from rahul@abc.com");
    assert.deepEqual(plan.entities, [{ type: "email", value: "rahul@abc.com" }]);
    assert.deepEqual(plan.sources, ["crm", "gmail"]);
  });

  it("selects CRM, Gmail, and Calendar for a single identity and honors the calendar date range", () => {
    const plan = deterministicQueryAnalysis("Did Rahul reply to my proposal, and do I have a meeting with him next week?", "America/Los_Angeles");
    assert.equal(plan.intent, "cross_source_contact_status");
    assert.deepEqual(plan.entities, [{ type: "person", value: "Rahul" }]);
    assert.deepEqual(plan.sources, ["crm", "gmail", "calendar"]);
    assert.equal(plan.dateRange?.expression, "next week");
    assert.ok(plan.dependencies.some(({ source, dependsOn }) => source === "gmail" && dependsOn === "crm"));
    assert.ok(plan.dependencies.some(({ source, dependsOn }) => source === "calendar" && dependsOn === "crm"));
  });

  it("plans an unfamiliar multi-source comparison from extracted requirements without a query-specific rule", async () => {
    const prompt = "Compare pipeline potential with customer conversations and scheduled interactions, then suggest a follow-up.";
    const modelPlan = {
      intent: "crm_lead_search",
      entities: [],
      requestedFacts: ["CRM pipeline records", "customer conversations", "scheduled interactions"],
      analyticalRequirements: ["Compare pipeline potential with customer conversations and scheduled interactions"],
      outputRequirements: ["Summarize the comparison and suggest a follow-up"],
      sources: ["crm", "gmail", "calendar"],
      filters: [],
      dependencies: [
        { source: "gmail", dependsOn: "crm" },
        { source: "calendar", dependsOn: "crm" }
      ],
      ambiguity: { type: "none", details: "", candidates: [] },
      confidence: 0.88,
      decisionSummary: "The request requires comparable evidence from connected business sources."
    };
    const provider = new OpenAIResponseProvider({
      apiKey: "test-key",
      fetcher: async () => new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(modelPlan) } }]
      }), { status: 200 })
    });
    const analysis = await provider.analyzeQuery(prompt);
    assert.equal(analysis.planningMethod, "llm");
    assert.deepEqual(analysis.sources, ["crm", "gmail", "calendar"]);
    assert.equal(analysis.analyticalRequirements.length, 1);
    const plan = planBusinessGoal(parsed(prompt), analysis);
    assert.deepEqual(plan.initialCalls.map(({ tool }) => tool), ["crm"]);
    assert.deepEqual(plan.dependentCalls?.map(({ tool }) => tool), ["email", "calendar"]);
  });

  it("extracts both person and company from a CRM/Gmail context request", () => {
    const plan = deterministicQueryAnalysis("What happened with Rahul from Acme?");
    assert.equal(plan.intent, "cross_source_contact_status");
    assert.deepEqual(plan.entities, [{ type: "company", value: "Acme" }, { type: "person", value: "Rahul" }]);
    assert.deepEqual(plan.sources, ["crm", "gmail"]);
  });

  it("classifies broad named-contact relationship questions without inventing filters or dates", () => {
    const prompts = [
      "What is the current status of my relationship with Keshav?",
      "Summarize the interactions I have had with Keshav.",
      "Give me an overview of Keshav's business engagement."
    ];
    for (const prompt of prompts) {
      const analysis = deterministicQueryAnalysis(prompt);
      assert.equal(analysis.intent, "cross_source_contact_status", prompt);
      assert.deepEqual(analysis.entities, [{ type: "person", value: "Keshav" }], prompt);
      assert.deepEqual(analysis.sources, ["crm", "gmail", "calendar"], prompt);
      assert.equal(analysis.dateRange, undefined, prompt);
      assert.deepEqual(analysis.filters, [], prompt);
      assert.deepEqual(analysis.dependencies, [
        { source: "gmail", dependsOn: "crm" },
        { source: "calendar", dependsOn: "crm" }
      ], prompt);
    }

    const objective = prompts[0]!;
    const investigation = planBusinessGoal(parsed(objective), deterministicQueryAnalysis(objective), "Asia/Kolkata");
    assert.deepEqual(investigation.initialCalls.map(({ tool, action }) => `${tool}.${action}`), ["crm.resolveContact"]);
    assert.deepEqual(investigation.dependentCalls?.map(({ tool, action }) => `${tool}.${action}`), [
      "email.getEmailHistory",
      "calendar.findEventsForLead"
    ]);
    assert.equal(investigation.dependentCalls?.[0]?.params.leadEmail, undefined);
    assert.equal(investigation.dependentCalls?.[1]?.params.until, undefined);
  });

  it("resolves a named Calendar attendee through CRM before searching Calendar", () => {
    const plan = deterministicQueryAnalysis("Do I have a meeting with Rahul next week?", "Asia/Kolkata");
    assert.equal(plan.intent, "calendar_event_search");
    assert.deepEqual(plan.sources, ["crm", "calendar"]);
  });

  it("plans an identity-dependent tool chain CRM then Gmail then Calendar", () => {
    const queryPlan = deterministicQueryAnalysis("Did Rahul reply to my proposal, and do I have a meeting with him next week?", "Asia/Kolkata");
    const investigation = planBusinessGoal(parsed("Did Rahul reply to my proposal, and do I have a meeting with him next week?"), queryPlan, "Asia/Kolkata");
    assert.deepEqual(investigation.initialCalls.map(({ tool, action }) => `${tool}.${action}`), ["crm.resolveContact"]);
    assert.deepEqual(investigation.dependentCalls?.map(({ tool, action }) => `${tool}.${action}`), ["email.getEmailHistory", "calendar.findEventsForLead"]);
    assert.equal("queryTerm" in (investigation.dependentCalls?.[1]?.params ?? {}), false);
    assert.equal(Date.parse(String(investigation.dependentCalls?.[1]?.params.until)) - Date.parse(String(investigation.dependentCalls?.[1]?.params.from)), 7 * 24 * 60 * 60 * 1000);
  });

  it("preserves relative and explicit date expressions without inventing a range", () => {
    for (const expression of ["today", "tomorrow", "yesterday", "this week", "next week", "last 30 days", "before Friday", "after Monday"]) {
      assert.equal(deterministicQueryAnalysis(`What meetings do I have ${expression}?`).dateRange?.expression, expression);
    }
    const explicit = deterministicQueryAnalysis("Show meetings on 2026-10-07");
    assert.deepEqual(explicit.dateRange, { type: "absolute", expression: "2026-10-07", start: "2026-10-07" });
    const named = deterministicQueryAnalysis("Show meetings on October 7, 2026");
    assert.equal(named.dateRange?.type, "absolute");
    assert.equal(named.dateRange?.start, "2026-10-07");
    assert.equal(deterministicQueryAnalysis("Show upcoming meetings").dateRange, undefined);
  });

  it("falls back safely when the LLM output is invalid", async () => {
    const provider = new OpenAIResponseProvider({
      apiKey: "test-key",
      fetcher: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ intent: "crm_deal_value", sources: ["gmail"], unexpected: true }) } }] }), { status: 200 })
    });
    const plan = await provider.analyzeQuery("What is ABC Technologies' deal value?");
    assert.equal(plan.planningMethod, "deterministic_fallback");
    assert.equal(plan.fallbackReason, "invalid_llm_output");
    assert.equal(plan.intent, "crm_deal_value");
  });

  it("accepts a schema-valid and prompt-grounded LLM analysis", async () => {
    const { planningMethod: _method, fallbackReason: _reason, ...details } =
      deterministicQueryAnalysis("What is ABC Technologies' deal value?");
    const provider = new OpenAIResponseProvider({
      apiKey: "test-key",
      fetcher: async () => new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(details) } }]
      }), { status: 200 })
    });
    const plan = await provider.analyzeQuery("What is ABC Technologies' deal value?");
    assert.equal(plan.planningMethod, "llm");
    assert.equal(plan.intent, "crm_deal_value");
    assert.deepEqual(plan.entities, [{ type: "company", value: "ABC Technologies" }]);
  });

  it("uses a safe deterministic fallback when the LLM is unavailable", async () => {
    const provider = new OpenAIResponseProvider({ apiKey: "test-key", fetcher: async () => { throw new Error("offline"); } });
    const plan = await provider.analyzeQuery("What meetings do I have tomorrow?", "Europe/London");
    assert.equal(plan.planningMethod, "deterministic_fallback");
    assert.equal(plan.fallbackReason, "llm_unavailable");
    assert.equal(plan.dateRange?.timezone, "Europe/London");
  });

  it("selects only CRM for a deal-value question", () => {
    const plan = deterministicQueryAnalysis("What is Rahul Sharma's deal value?");
    assert.deepEqual(plan.sources, ["crm"]);
  });

  it("selects CRM and Gmail for unanswered client queries", () => {
    const plan = deterministicQueryAnalysis("Which clients haven't replied?");
    assert.deepEqual(plan.sources, ["crm", "gmail"]);
  });

  it("selects only Calendar for a date-specific meeting query", () => {
    const plan = deterministicQueryAnalysis("What meetings do I have tomorrow?");
    assert.deepEqual(plan.sources, ["calendar"]);
    assert.equal(plan.dateRange?.expression, "tomorrow");
  });

  it("maps explicit CRM criteria to existing tool calls without applying an implicit value/date filter", () => {
    const prompt = "Which high-value leads haven't been contacted in the last 30 days?";
    const plan = planBusinessGoal(parsed(prompt), deterministicQueryAnalysis(prompt));
    assert.deepEqual(plan.initialCalls.map(({ tool, action }) => `${tool}.${action}`), ["crm.listInactiveLeads"]);
    assert.deepEqual(plan.initialCalls[0]?.params, { minDaysInactive: 30, minDealValue: 25_000 });

    assert.throws(
      () => planBusinessGoal(parsed("Find inactive high-value leads"), deterministicQueryAnalysis("Find inactive high-value leads")),
      /does not specify one; no date range was invented/
    );
  });

  it("maps an explicit CRM-only deal-value question to CRM search", () => {
    const prompt = "What is ABC Technologies' deal value?";
    const plan = planBusinessGoal(parsed(prompt), deterministicQueryAnalysis(prompt));
    assert.deepEqual(plan.initialCalls.map(({ tool, action }) => `${tool}.${action}`), ["crm.searchLeads"]);
    assert.deepEqual(plan.initialCalls[0]?.params, { query: "ABC Technologies" });
  });

  it("maps calendar date expressions using the supplied IANA timezone", () => {
    const prompt = "What meetings do I have tomorrow?";
    const analysis = deterministicQueryAnalysis(prompt, "Asia/Kolkata");
    const plan = planBusinessGoal(parsed(prompt), analysis, "Asia/Kolkata");
    const { from, until } = plan.initialCalls[0]!.params;
    assert.equal(Date.parse(String(until)) - Date.parse(String(from)), 24 * 60 * 60 * 1000);
    assert.notEqual(new Date(String(from)).getUTCHours(), 0);
  });

  it("does not assume UTC when a Calendar date range has no user timezone", () => {
    const prompt = "What meetings do I have tomorrow?";
    assert.throws(
      () => planBusinessGoal(parsed(prompt), deterministicQueryAnalysis(prompt)),
      /no UTC range was assumed/
    );
  });
});
