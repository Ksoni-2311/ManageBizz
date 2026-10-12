import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ACTIVE_PIPELINE_STATUSES, getActiveHighValueLeads, getInactiveHighValueLeads, normalizeCRMDate, resolveCRMContact, validateCRMLeads } from "../tools/crmDomain.js";
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
  it("resolves exact and normalized identities, exact company pairs, and reports ambiguous candidates", () => {
    const contacts = validateCRMLeads([
      { ...records[0], id: "rahul-a", name: "Rahul Sharma", email: "Rahul@Acme.test", company: "Acme Technologies Ltd" },
      { ...records[1], id: "rahul-b", name: "Rahul Verma", email: "rahul@other.test", company: "Other Inc" },
      { ...records[2], id: "maya", name: "Maya Shah", email: "maya@acme.test", company: "Acme Technologies Limited", phone: "+1 (555) 321-9876" }
    ]);
    assert.equal(resolveCRMContact(contacts, { query: " rahul@ACME.TEST " }).status, "RESOLVED");
    assert.equal(resolveCRMContact(contacts, { query: "Rahul Sharma", company: "Acme Technologies" }).status, "RESOLVED");
    const firstName = resolveCRMContact(contacts, { query: "Rahul" });
    assert.equal(firstName.status, "AMBIGUOUS");
    if (firstName.status === "AMBIGUOUS") assert.deepEqual(firstName.candidates.map(({ canonicalName }) => canonicalName), ["Rahul Sharma", "Rahul Verma"]);
    const company = resolveCRMContact(contacts, { query: "Acme Technologies" });
    assert.equal(company.status, "AMBIGUOUS", "a company with multiple CRM contacts requires clarification");
    const domain = resolveCRMContact(contacts, { query: "new@acme.test" });
    assert.equal(domain.status, "AMBIGUOUS", "domain similarity must never choose a different person's email");
    const fuzzy = resolveCRMContact(contacts, { query: "Rahul Sharm" });
    assert.equal(fuzzy.status, "AMBIGUOUS", "fuzzy candidates require clarification");
    const phone = resolveCRMContact(contacts, { query: "1-555-321-9876" });
    assert.equal(phone.status, "RESOLVED");
    if (phone.status === "RESOLVED") assert.equal(phone.entity.matchedBy, "exact_phone");
    assert.deepEqual(resolveCRMContact(contacts, { query: "Missing Person" }), { status: "NOT_FOUND", query: "Missing Person" });
  });

  it("loads validated CRM rows into the service without altering record identity", async () => {
    const service = new CRMToolService({ clock: () => fixedNow });
    service.setLeads(records, "o", "u");
    const context = { goalId: "g", runId: "r", actionId: "load", userId: "u", orgId: "o" };
    const loaded = await service.searchLeads({}, context);
    assert.equal(loaded.success, true);
    if (loaded.success) {
      assert.equal(loaded.data.length, records.length);
      assert.ok(loaded.data.every((lead) => records.some((source) => source.id === lead.id)));
    }
    const invalid = records.map((record) => ({ ...record }));
    invalid.push({ ...records[0]!, id: "duplicate-row" });
    assert.throws(() => service.setLeads(invalid, "o", "u"), /Duplicate CRM lead identity/);
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

  it("applies a requested minimum deal value through the CRM search service", async () => {
    const service = new CRMToolService({ clock: () => fixedNow });
    service.setLeads(records, "o", "u");
    const context = { goalId: "g", runId: "r", actionId: "search", userId: "u", orgId: "o" };
    const response = await service.searchLeads({ minDealValue: 100_000 }, context);
    assert.equal(response.success, true);
    if (response.success) {
      assert.ok(response.data.every((lead) => lead.dealValue >= 100_000));
      assert.ok(response.data.every((lead) => leads.some((source) => source.id === lead.id)));
    }
  });

  it("scopes development fallback CRM records by both workspace and user", async () => {
    const service = new CRMToolService();
    service.setLeads(records, "workspace", "owner");
    const owner = await service.searchLeads({}, { goalId: "g", runId: "r", actionId: "a", userId: "owner", orgId: "workspace" });
    const anotherUser = await service.searchLeads({}, { goalId: "g", runId: "r", actionId: "b", userId: "other", orgId: "workspace" });
    assert.equal(owner.success && owner.data.length, records.length);
    assert.deepEqual(anotherUser.success && anotherUser.data, []);
  });
});
