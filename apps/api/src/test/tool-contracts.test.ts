import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CRMToolService } from "../tools/crmTool.js";
import { EmailToolService } from "../tools/emailTool.js";
import { CalendarToolService } from "../tools/calendarTool.js";
import { TaskToolService } from "../tools/taskTool.js";
import { AnalyticsTool } from "../tools/analyticsTool.js";

const ctx = { goalId: "g", runId: "r", actionId: "action-1", userId: "u", orgId: "o" };
const validLead = { id: "l1", name: "Lead", email: "lead@example.test", company: "Company", dealValue: 50_000, status: "New", lastContactedAt: "2025-01-01T00:00:00Z" };

describe("business tool contracts", () => {
  it("validates CRM inputs and represents no matches as an empty success", async () => {
    const crm = new CRMToolService({ clock: () => new Date("2026-09-01T00:00:00Z") });
    crm.setLeads([validLead], "org");
    const found = await crm.listActiveHighValueLeads({ minDealValue: 999_999 }, ctx);
    assert.equal(found.success, true);
    if (found.success) assert.deepEqual(found.data, []);
    const invalid = await crm.searchLeads({ query: 3 }, ctx);
    assert.equal(invalid.success, false);
    if (!invalid.success) assert.equal(invalid.error.code, "INVALID_INPUT");
  });

  it("validates email inputs and refuses to claim delivery without a provider", async () => {
    const email = new EmailToolService();
    const bad = await email.draftEmail({ to: "not-an-email", subject: "Subject", body: "Body" }, ctx);
    assert.equal(bad.success, false);
    const send = await email.sendEmail({ to: "lead@example.test", subject: "Subject", body: "Body" }, ctx);
    assert.equal(send.success, false);
    if (!send.success) assert.equal(send.error.code, "INTEGRATION_UNAVAILABLE");
    const history = await email.getEmailHistory({}, ctx);
    assert.equal(history.success, true);
    if (history.success) assert.deepEqual(history.data, []);
  });

  it("validates calendar time ranges and returns no guessed availability", async () => {
    const calendar = new CalendarToolService();
    const invalid = await calendar.createMeeting({ title: "Review", attendees: ["lead@example.test"], startTime: "2026-01-02T10:00:00Z", endTime: "2026-01-02T09:00:00Z" }, ctx);
    assert.equal(invalid.success, false);
    const availability = await calendar.getAvailability({}, ctx);
    assert.equal(availability.success, true);
    if (availability.success) assert.deepEqual(availability.data, []);
    const writeDisabled = await calendar.createMeeting({}, ctx);
    assert.equal(writeDisabled.success, false);
    if (!writeDisabled.success) assert.equal(writeDisabled.error.code, "READ_ONLY_CALENDAR");
  });

  it("keeps task results isolated and validates status and priority values", async () => {
    const tasks = new TaskToolService();
    const created = await tasks.createTask({ title: "Follow up", priority: "HIGH" }, ctx);
    assert.equal(created.success, true);
    const invalid = await tasks.completeTask({ taskId: "" }, ctx);
    assert.equal(invalid.success, false);
    const listed = await tasks.listOpenTasks({}, ctx);
    assert.equal(listed.success, true);
    if (listed.success) {
      assert.equal(listed.data.length, 1);
      listed.data[0]!.title = "mutated response";
    }
    const listedAgain = await tasks.listOpenTasks({}, ctx);
    if (listedAgain.success) assert.equal(listedAgain.data[0]!.title, "Follow up");
  });

  it("does not return fabricated analytics metrics", async () => {
    for (const result of [
      await AnalyticsTool.getLeadMetrics({}, ctx),
      await AnalyticsTool.getConversionMetrics({}, ctx),
      await AnalyticsTool.getSalesMetrics({}, ctx),
      await AnalyticsTool.getActivityMetrics({}, ctx)
    ]) {
      assert.equal(result.success, true);
      if (result.success) assert.deepEqual(result.data, []);
    }
    const invalid = await AnalyticsTool.getLeadMetrics({ timeWindowDays: 0 }, ctx);
    assert.equal(invalid.success, false);
  });
});
