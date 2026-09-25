import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { after, describe, it } from "node:test";
import * as XLSX from "xlsx";
import { CRMIngestionError, CRMIngestionService } from "../services/crmIngestionService.js";
import { CRMToolService } from "../tools/crmTool.js";
import { JsonCRMRepository, InMemoryCRMRepository } from "../tools/crmRepository.js";

const requiredHeaders = ["name", "email", "company", "dealValue", "lastContactedAt"];
const tempDirs: string[] = [];

after(async () => {
  await Promise.all(tempDirs.map((directory) => rm(directory, { recursive: true, force: true })));
});

function makeRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const suffix = randomUUID();
  return {
    name: `Fixture ${suffix.slice(0, 8)}`,
    email: `fixture-${suffix}@example.test`,
    company: `Example ${suffix.slice(0, 6)}`,
    dealValue: 51_250,
    lastContactedAt: "2025-02-03T04:05:06.000Z",
    ...overrides
  };
}

function asCSV(headers: string[], records: Array<Record<string, unknown>>): Buffer {
  const cell = (value: unknown) => {
    const text = value instanceof Date ? value.toISOString() : String(value ?? "");
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [headers, ...records.map((record) => headers.map((header) => record[header]))]
    .map((row) => row.map(cell).join(","));
  return Buffer.from(`${lines.join("\r\n")}\r\n`, "utf8");
}

function asXLSX(headers: string[], records: Array<Record<string, unknown>>): Buffer {
  const values = [headers, ...records.map((record) => headers.map((header) => record[header] ?? ""))];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(values), "CRM");
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

function upload(service: CRMIngestionService, workspaceId: string, fileName: string, contentType: string, bytes: Buffer) {
  return service.preview({ workspaceId, ownerUserId: "user-test", fileName, contentType, bytes });
}

describe("CRM ingestion", () => {
  it("parses valid XLSX records and normalizes Excel serial dates without requiring optional status", async () => {
    const repository = new InMemoryCRMRepository();
    const service = new CRMIngestionService(repository);
    const record = makeRecord({ lastContactedAt: 45_000 });
    const headers = [...requiredHeaders];
    const result = await upload(service, "workspace-xlsx", "crm.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", asXLSX(headers, [record]));

    assert.equal(result.status, "READY");
    assert.equal(result.validRecordCount, 1);
    assert.deepEqual(result.invalidRows, []);
    assert.equal(result.sample[0]?.id, record.email);
    assert.equal(result.sample[0]?.email, record.email);
    assert.equal(result.sample[0]?.status, undefined);
    assert.equal(new Date(result.sample[0]!.lastContactedAt).toISOString(), "2023-03-15T00:00:00.000Z");
  });

  it("parses valid CSV values, including quoted fields and optional columns", async () => {
    const service = new CRMIngestionService(new InMemoryCRMRepository());
    const record = makeRecord({ name: "Fixture, Contact", status: "Proposal", owner: "Owner Example", phone: "000-555-0100", notes: "Asked for a quote, then follow up" });
    const headers = [...requiredHeaders, "status", "owner", "phone", "notes"];
    const result = await upload(service, "workspace-csv", "leads.csv", "text/csv", asCSV(headers, [record]));

    assert.equal(result.status, "READY");
    assert.equal(result.validRecordCount, 1);
    assert.equal(result.sample[0]?.name, record.name);
    assert.equal(result.sample[0]?.status, "Proposal");
    assert.equal(result.sample[0]?.owner, "Owner Example");
    assert.equal(result.sample[0]?.phone, "000-555-0100");
    assert.deepEqual(result.sample[0]?.notes, ["Asked for a quote, then follow up"]);
  });

  it("reports all missing required columns in the preview", async () => {
    const service = new CRMIngestionService(new InMemoryCRMRepository());
    const headers = requiredHeaders.slice(0, 3);
    const result = await upload(service, "workspace-missing-columns", "missing.csv", "text/csv", asCSV(headers, []));
    const requiredMissing = requiredHeaders.slice(3);

    assert.equal(result.status, "REJECTED");
    assert.equal(result.canImport, false);
    assert.ok(requiredMissing.every((field) => result.fileIssues.some((issue) => issue.reason.includes(field))));
  });

  it("reports invalid deal values with their row number and field", async () => {
    const service = new CRMIngestionService(new InMemoryCRMRepository());
    const record = makeRecord({ dealValue: "not a number" });
    const result = await upload(service, "workspace-bad-value", "bad-value.csv", "text/csv", asCSV(requiredHeaders, [record]));
    const rowNumber = result.invalidRows[0];

    assert.equal(result.status, "REJECTED");
    assert.equal(result.canImport, false);
    assert.equal(rowNumber?.rowNumber, 2);
    assert.equal(rowNumber?.issues[0]?.field, "dealValue");
    assert.match(rowNumber?.issues[0]?.reason ?? "", /finite non-negative number/);
  });

  it("reports invalid dates with their row number and field", async () => {
    const service = new CRMIngestionService(new InMemoryCRMRepository());
    const record = makeRecord({ lastContactedAt: "not a date" });
    const result = await upload(service, "workspace-bad-date", "bad-date.csv", "text/csv", asCSV(requiredHeaders, [record]));

    assert.equal(result.invalidRows[0]?.rowNumber, 2);
    assert.ok(result.invalidRows[0]?.issues.some((issue) => issue.field === "lastContactedAt"));
  });

  it("rejects an empty file", async () => {
    const service = new CRMIngestionService(new InMemoryCRMRepository());
    await assert.rejects(
      upload(service, "workspace-empty-file", "empty.csv", "text/csv", Buffer.alloc(0)),
      (error: unknown) => error instanceof CRMIngestionError && error.code === "EMPTY_FILE"
    );
  });

  it("marks every row with a duplicate email identity invalid instead of choosing a merge winner", async () => {
    const service = new CRMIngestionService(new InMemoryCRMRepository());
    const recordA = makeRecord();
    const recordB = makeRecord({ email: String(recordA.email).toUpperCase() });
    const result = await upload(service, "workspace-duplicates", "duplicates.csv", "text/csv", asCSV(requiredHeaders, [recordA, recordB]));

    assert.equal(result.validRecordCount, 0);
    assert.deepEqual(result.invalidRows.map(({ rowNumber }) => rowNumber), [2, 3]);
    assert.ok(result.invalidRows.every(({ issues }) => issues.some(({ field, reason }) => field === "email" && reason.includes("Duplicate lead identity"))));
    assert.equal(result.canImport, false);
  });

  it("rejects an import with zero valid rows and does not persist an empty CRM", async () => {
    const repository = new InMemoryCRMRepository();
    const service = new CRMIngestionService(repository);
    const invalid = makeRecord({ dealValue: -1 });
    const result = await upload(service, "workspace-empty-import", "invalid.csv", "text/csv", asCSV(requiredHeaders, [invalid]));

    assert.equal(result.status, "REJECTED");
    assert.equal(result.previewId, undefined);
    assert.equal(result.validRecordCount, 0);
    assert.equal((await service.current("workspace-empty-import", "user-test")).loaded, false);
  });

  it("requires confirmation, stores normalized records, persists them, and exposes them to that workspace's CRM tools", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "managebizz-crm-"));
    tempDirs.push(directory);
    const repository = new JsonCRMRepository(directory);
    const service = new CRMIngestionService(repository);
    const records = [makeRecord(), makeRecord({ status: "Negotiation" })];
    const result = await service.preview({ workspaceId: "org-test:workspace-success", ownerUserId: "user", fileName: "customer-export.csv", contentType: "text/csv", bytes: asCSV([...requiredHeaders, "status"], records) });

    assert.equal(result.canImport, true);
    assert.ok(result.previewId);
    await assert.rejects(service.confirm("org-test:workspace-success", result.previewId!, false), /Explicit confirmation/);
    const imported = await service.confirm("org-test:workspace-success", result.previewId!, true);
    const current = await service.current("org-test:workspace-success", "user");
    const context = { goalId: "goal", runId: "run", actionId: "search", userId: "user", orgId: "org-test:workspace-success" };
    const crm = new CRMToolService({ repository });
    const search = await crm.searchLeads({}, context);
    const otherWorkspace = await crm.searchLeads({}, { ...context, orgId: "org-test:other-workspace" });
    const reopened = await new JsonCRMRepository(directory).get("org-test:workspace-success", "user");

    assert.equal(imported.leads.length, records.length);
    assert.equal(current.loaded, true);
    assert.equal(current.recordCount, records.length);
    assert.equal(search.success, true);
    if (search.success) assert.deepEqual(search.data.map(({ email }) => email), records.map(({ email }) => email));
    assert.equal(otherWorkspace.success, true);
    if (otherWorkspace.success) assert.deepEqual(otherWorkspace.data, []);
    assert.equal(reopened?.leads.length, records.length);
    assert.ok(reopened?.leads.every((lead) => records.some((record) => lead.email === record.email)));
  });
});
