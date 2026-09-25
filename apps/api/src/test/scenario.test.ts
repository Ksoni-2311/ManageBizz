import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RiskLevel } from "@nexusops/shared-types";
import { MockLLMProvider } from "../agent/llm/unifiedLLM.js";
import { PolicyEngine } from "../agent/policies/policyEngine.js";
import { CRMToolService } from "../tools/crmTool.js";
import { AGENT_INTEGRITY_INSTRUCTIONS } from "../agent/policies/dataIntegrity.js";

describe("agent tool scenarios", () => {
  it("parses the supplied goal text and extracts a requested time window", async () => {
    const parsed = await new MockLLMProvider().parseGoal("Review CRM leads from the last 45 days");
    assert.equal(parsed.objective, "Review CRM leads from the last 45 days");
    assert.equal(parsed.timeWindowDays, 45);
    assert.deepEqual(parsed.successCriteria, []);
  });

  it("classifies high impact external email actions for approval", () => {
    const risk = PolicyEngine.classifyRisk("email", "sendEmail", { to: "lead@example.test" });
    assert.equal(risk, RiskLevel.HIGH);
    assert.equal(PolicyEngine.requiresApproval(risk), true);
  });

  it("keeps read-only CRM queries low risk", () => {
    const risk = PolicyEngine.classifyRisk("crm", "listInactiveLeads", {});
    assert.equal(risk, RiskLevel.LOW);
    assert.equal(PolicyEngine.requiresApproval(risk), false);
  });

  it("requires approval for medium-risk task mutations", () => {
    const risk = PolicyEngine.classifyRisk("tasks", "createTask", { title: "Task" });
    assert.equal(risk, RiskLevel.MEDIUM);
    assert.equal(PolicyEngine.requiresApproval(risk), true);
  });

  it("returns an empty successful CRM query when no records have been loaded", async () => {
    const context = { goalId: "g", runId: "r", actionId: "scenario", userId: "u", orgId: "o" };
    const response = await new CRMToolService().listInactiveLeads({}, context);
    assert.equal(response.success, true);
    if (response.success) assert.deepEqual(response.data, []);
  });

  it("does not invent a plan when no planning provider is configured", async () => {
    await assert.rejects(() => new MockLLMProvider().generatePlan(
      { objective: "Do work", timeWindowDays: 30, constraints: [], successCriteria: [] }, {}, AGENT_INTEGRITY_INSTRUCTIONS
    ), /No planning model is configured/);
  });
});
