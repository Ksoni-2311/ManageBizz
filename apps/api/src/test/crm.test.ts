import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ACTIVE_PIPELINE_STATUSES, getActiveHighValueLeads, getInactiveHighValueLeads, normalizeCRMDate, validateCRMLeads } from "../tools/crmDomain.js";
import { CRMToolService } from "../tools/crmTool.js";

const records: Record<string, unknown>[] = [
  { id: "a", name: "A", email: "a@example.test", company: "A Co", dealValue: 100_000, status: "New", lastContactedAt: "2025-01-01T00:00:00Z" },
  { id: "b", name: "B", email: "b@example.test", company: "B Co", dealValue: 99_999, status: "Negotiation", lastContactedAt: "2025-01-01T00:00:00Z" },
  { id: "c", name: "C", email: "c@example.test", company: "C Co", dealValue: 120_000, status: "Closed", lastContactedAt: "2025-01-01T00:00:00Z" },
  { id: "d", name: "D", email: "d@example.test", company: "D Co", dealValue: 150_000, status: "New", lastContactedAt: "2026-08-01T00:00:00Z" }
];
const leads = validateCRMLeads(records);
const fixedNow = new Date("2026-09-01T00:00:00Z");

describe("CRM domain", () => {
  it("loads validated CRM rows into the service without altering record identity", async () => {
    const service = new CRMToolService({ clock: () => fixedNow });
    service.setLeads(records, "o");
    const context = { goalId: "g", runId: "r", actionId: "load", userId: "u", orgId: "o" };
    const loaded = await service.searchLeads({}, context);
    assert.equal(loaded.success, true);
    if (loaded.success) {
      assert.equal(loaded.data.length, records.length);
      assert.ok(loaded.data.every((lead) => records.some((source) => source.id === lead.id)));
    }
    const invalid = records.map((record) => ({ ...record }));
    invalid.push({ ...records[0]!, id: "duplicate-row" });
    assert.throws(() => service.setLeads(invalid, "o"), /Duplicate CRM lead identity/);
    const afterInvalidLoad = await service.searchLeads({}, context);
    if (afterInvalidLoad.success) assert.equal(afterInvalidLoad.data.length, records.length);
  });

  it("filters active high-value leads by value and centralized pipeline status", () => {
    const result = getActiveHighValueLeads(leads, 100_000);
    assert.ok(result.every((lead) => lead.dealValue >= 100_000));
    assert.ok(result.every((lead) => ACTIVE_PIPELINE_STATUSES.includes(lead.status as typeof ACTIVE_PIPELINE_STATUSES[number])));
    assert.ok(result.every((lead) => leads.some((source) => source.id === lead.id)));
    assert.equal(new Set(result.map((lead) => lead.email.toLowerCase())).size, result.length);
  });

  it("filters inactive high-value leads by recency threshold independently of pipeline status", () => {
    const result = getInactiveHighValueLeads(leads, 100_000, 30, fixedNow);
    const cutoff = fixedNow.getTime() - 30 * 86_400_000;
    assert.ok(result.every((lead) => lead.dealValue >= 100_000));
    assert.ok(result.every((lead) => lead.lastContactedAt.getTime() < cutoff));
    assert.ok(result.every((lead) => leads.some((source) => source.id === lead.id)));
    assert.equal(new Set(result.map((lead) => lead.email.toLowerCase())).size, result.length);
  });

  it("normalizes Excel serial dates deterministically", () => {
    assert.equal(normalizeCRMDate(1).toISOString(), "1899-12-31T00:00:00.000Z");
    assert.equal(normalizeCRMDate(2.5).toISOString(), "1900-01-01T12:00:00.000Z");
  });

  it("rejects invalid rows and duplicate lead identities clearly", () => {
    assert.throws(() => validateCRMLeads([{ ...records[0]!, dealValue: "not-a-number" }]), /dealValue/);
    assert.throws(() => validateCRMLeads([records[0]!, { ...records[1]!, email: "A@EXAMPLE.TEST" }]), /Duplicate CRM lead identity/);
  });

  it("returns empty results without inventing data when CRM has not been loaded", async () => {
    const service = new CRMToolService({ clock: () => fixedNow });
    const context = { goalId: "g", runId: "r", actionId: "a", userId: "u", orgId: "o" };
    const response = await service.listInactiveLeads({}, context);
    assert.equal(response.success, true);
    assert.deepEqual(response.data, []);
  });
});
