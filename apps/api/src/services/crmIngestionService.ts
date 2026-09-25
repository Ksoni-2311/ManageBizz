import { randomUUID } from "node:crypto";
import * as XLSX from "xlsx";
import { CRMLead, normalizeCRMDate, normalizeCRMLead } from "../tools/crmDomain.js";
import { CRMRepository, StoredCRM } from "../tools/crmRepository.js";
import { crmRepository } from "../tools/crmRepository.js";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_ROWS = 50_000;
const PREVIEW_TTL_MS = 30 * 60 * 1000;
const REQUIRED_COLUMNS = ["name", "email", "company", "dealValue", "lastContactedAt"] as const;
const COLUMN_NAMES: Record<string, string> = {
  name: "name", leadname: "name",
  email: "email",
  company: "company",
  dealvalue: "dealValue", value: "dealValue",
  lastcontactedat: "lastContactedAt", lastcontacted: "lastContactedAt",
  phone: "phone", status: "status", owner: "owner", notes: "notes",
  id: "id", leadid: "id"
};

export type CRMRowIssue = { field: string; reason: string };
export type CRMInvalidRow = { rowNumber: number; issues: CRMRowIssue[] };
export type CRMUploadPreview = {
  status: "READY" | "REJECTED";
  previewId?: string;
  sourceName: string;
  totalRows: number;
  validRecordCount: number;
  invalidRows: CRMInvalidRow[];
  fileIssues: CRMRowIssue[];
  sample: CRMLead[];
  sampleLimit: number;
  canImport: boolean;
  replacesExisting: boolean;
};
export type CRMCurrentStatus = {
  loaded: boolean;
  sourceName?: string;
  importedAt?: string;
  recordCount: number;
};

export class CRMIngestionError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode = 400, readonly details?: unknown) {
    super(message);
  }
}

type StagedImport = {
  workspaceId: string;
  ownerUserId: string;
  sourceName: string;
  createdAt: number;
  validLeads: CRMLead[];
};
type ParsedRow = { rowNumber: number; cells: unknown[] };

export class CRMIngestionService {
  private readonly staged = new Map<string, StagedImport>();

  constructor(
    private readonly repository: CRMRepository = crmRepository,
    private readonly now: () => Date = () => new Date()
  ) {}

  async preview(input: {
    workspaceId: string;
    ownerUserId: string;
    fileName: string;
    contentType: string;
    bytes: Buffer;
  }): Promise<CRMUploadPreview> {
    this.expireOldPreviews();
    const sourceName = safeFileName(input.fileName);
    const extension = sourceName.toLocaleLowerCase("en-US").split(".").pop();
    if (extension !== "xlsx" && extension !== "csv") {
      throw new CRMIngestionError("UNSUPPORTED_FILE_TYPE", "Upload a .xlsx or .csv CRM file.", 415);
    }
    if (!hasMatchingMimeType(extension, input.contentType)) {
      throw new CRMIngestionError("FILE_TYPE_MISMATCH", "The uploaded file type does not match its extension.", 415);
    }
    if (input.bytes.length === 0) throw new CRMIngestionError("EMPTY_FILE", "The uploaded file is empty.");
    if (input.bytes.length > MAX_FILE_BYTES) throw new CRMIngestionError("FILE_TOO_LARGE", "CRM uploads must be 10 MB or smaller.", 413);

    const rows = extension === "csv" ? parseCSV(input.bytes) : parseXLSX(input.bytes);
    if (rows.length === 0 || rows.every(({ cells }) => cells.every(isBlank))) {
      throw new CRMIngestionError("EMPTY_FILE", "The uploaded file does not contain a header row or CRM records.");
    }
    if (rows.length > MAX_ROWS + 1) throw new CRMIngestionError("TOO_MANY_ROWS", `CRM uploads may contain at most ${MAX_ROWS} data rows.`, 413);

    const headerIndex = rows.findIndex(({ cells }) => cells.some((cell) => !isBlank(cell)));
    const header = rows[headerIndex]!;
    const fileIssues: CRMRowIssue[] = [];
    const columns = new Map<string, number>();
    for (const [index, cell] of header.cells.entries()) {
      const key = COLUMN_NAMES[normalizeHeader(cell)];
      if (!key) continue;
      if (columns.has(key)) fileIssues.push({ field: key, reason: "Column appears more than once." });
      else columns.set(key, index);
    }
    const missing = REQUIRED_COLUMNS.filter((field) => !columns.has(field));
    if (missing.length) fileIssues.push({ field: "columns", reason: `Missing required columns: ${missing.join(", ")}.` });
    if (fileIssues.length) {
      return {
        status: "REJECTED", sourceName, totalRows: 0, validRecordCount: 0,
        invalidRows: [], fileIssues, sample: [], sampleLimit: 20, canImport: false,
        replacesExisting: Boolean(await this.repository.get(input.workspaceId, input.ownerUserId))
      };
    }

    const invalidRows: CRMInvalidRow[] = [];
    const validWithRows: Array<{ rowNumber: number; lead: CRMLead }> = [];
    const dataRows = rows.slice(headerIndex + 1).filter(({ cells }) => cells.some((cell) => !isBlank(cell)));
    for (const row of dataRows) {
      const normalized = this.normalizeRow(row, columns);
      if (normalized.issues.length) invalidRows.push({ rowNumber: row.rowNumber, issues: normalized.issues });
      else if (normalized.lead) validWithRows.push({ rowNumber: row.rowNumber, lead: normalized.lead });
    }

    const duplicates = new Map<string, typeof validWithRows>();
    for (const item of validWithRows) {
      const key = item.lead.email.toLocaleLowerCase("en-US");
      duplicates.set(key, [...(duplicates.get(key) ?? []), item]);
    }
    const duplicateRows = new Set<number>();
    for (const group of duplicates.values()) {
      if (group.length < 2) continue;
      for (const { rowNumber } of group) {
        duplicateRows.add(rowNumber);
        invalidRows.push({ rowNumber, issues: [{ field: "email", reason: "Duplicate lead identity: this email appears in more than one row. All rows with this email are excluded; no merge was performed." }] });
      }
    }
    invalidRows.sort((left, right) => left.rowNumber - right.rowNumber);
    const validLeads = validWithRows.filter(({ rowNumber }) => !duplicateRows.has(rowNumber)).map(({ lead }) => lead);
    const replacesExisting = Boolean(await this.repository.get(input.workspaceId, input.ownerUserId));
    const previewId = validLeads.length ? randomUUID() : undefined;
    if (previewId) this.staged.set(previewId, {
      workspaceId: input.workspaceId,
      ownerUserId: input.ownerUserId,
      sourceName,
      createdAt: this.now().getTime(),
      validLeads
    });

    return {
      status: validLeads.length ? "READY" : "REJECTED",
      ...(previewId ? { previewId } : {}),
      sourceName,
      totalRows: dataRows.length,
      validRecordCount: validLeads.length,
      invalidRows,
      fileIssues: validLeads.length ? [] : [{ field: "records", reason: "No valid records were found. Import is rejected." }],
      sample: validLeads.slice(0, 20).map(cloneLead),
      sampleLimit: 20,
      canImport: validLeads.length > 0,
      replacesExisting
    };
  }

  async confirm(workspaceId: string, previewId: string, confirmed: boolean): Promise<StoredCRM> {
    this.expireOldPreviews();
    if (!confirmed) throw new CRMIngestionError("CONFIRMATION_REQUIRED", "Explicit confirmation is required before importing CRM records.", 400);
    const staged = this.staged.get(previewId);
    if (!staged || staged.workspaceId !== workspaceId) {
      throw new CRMIngestionError("PREVIEW_NOT_FOUND", "The CRM preview was not found or has expired.", 404);
    }
    if (staged.validLeads.length === 0) {
      throw new CRMIngestionError("EMPTY_IMPORT", "The import contains zero valid records and was rejected.", 422);
    }
    const crm: StoredCRM = {
      workspaceId,
      ownerUserId: staged.ownerUserId,
      sourceName: staged.sourceName,
      importedAt: this.now().toISOString(),
      leads: staged.validLeads.map(cloneLead)
    };
    await this.repository.save(workspaceId, crm);
    this.staged.delete(previewId);
    return crm;
  }

  async current(workspaceId: string, ownerUserId: string): Promise<CRMCurrentStatus> {
    const stored = await this.repository.get(workspaceId, ownerUserId);
    return stored
      ? { loaded: true, sourceName: stored.sourceName, importedAt: stored.importedAt, recordCount: stored.leads.length }
      : { loaded: false, recordCount: 0 };
  }

  private normalizeRow(row: ParsedRow, columns: Map<string, number>): { lead?: CRMLead; issues: CRMRowIssue[] } {
    const values: Record<string, unknown> = {};
    for (const [field, index] of columns) values[field] = row.cells[index];
    const issues: CRMRowIssue[] = [];
    const requiredText = ["name", "email", "company"] as const;
    for (const field of requiredText) {
      const value = values[field];
      if (typeof value !== "string" || !value.trim()) issues.push({ field, reason: "A non-empty text value is required." });
    }
    const email = typeof values.email === "string" ? values.email.trim().toLocaleLowerCase("en-US") : "";
    if (email && !/^\S+@\S+\.\S+$/.test(email)) issues.push({ field: "email", reason: "Enter a valid email address." });

    const dealValue = parseDealValue(values.dealValue);
    if (dealValue === undefined) issues.push({ field: "dealValue", reason: "Enter a finite non-negative number." });

    let lastContactedAt: Date | undefined;
    const rawDate = values.lastContactedAt;
    if (isBlank(rawDate)) issues.push({ field: "lastContactedAt", reason: "A date is required." });
    else {
      try {
        const dateValue = typeof rawDate === "string" && /^\d+(?:\.\d+)?$/.test(rawDate.trim())
          ? Number(rawDate.trim())
          : rawDate;
        lastContactedAt = normalizeCRMDate(dateValue as Date | string | number, `row ${row.rowNumber} lastContactedAt`);
        if (lastContactedAt.getUTCFullYear() < 1900 || lastContactedAt.getUTCFullYear() > 9999) {
          throw new Error("Date is outside the supported range.");
        }
      } catch (error) {
        issues.push({ field: "lastContactedAt", reason: error instanceof Error ? error.message.replace(/^row \d+ lastContactedAt:?\s*/i, "") : "Enter a valid date or Excel serial date." });
      }
    }

    for (const field of ["phone", "status", "owner", "notes"] as const) {
      if (!isBlank(values[field]) && typeof values[field] !== "string") {
        issues.push({ field, reason: "Value must be text." });
      }
    }
    if (issues.length || dealValue === undefined || !lastContactedAt) return { issues };
    const canonical: Record<string, unknown> = {
      name: String(values.name).trim(), email, company: String(values.company).trim(), dealValue, lastContactedAt,
      ...(typeof values.id === "string" && values.id.trim() ? { id: values.id.trim() } : {}),
      ...(typeof values.status === "string" && values.status.trim() ? { status: values.status.trim() } : {}),
      ...(typeof values.phone === "string" && values.phone.trim() ? { phone: values.phone.trim() } : {}),
      ...(typeof values.owner === "string" && values.owner.trim() ? { owner: values.owner.trim() } : {}),
      ...(typeof values.notes === "string" && values.notes.trim() ? { notes: [values.notes.trim()] } : { notes: [] })
    };
    try {
      return { lead: normalizeCRMLead(canonical, row.rowNumber), issues: [] };
    } catch (error) {
      return { issues: [{ field: "row", reason: error instanceof Error ? error.message : "Row normalization failed." }] };
    }
  }

  private expireOldPreviews(): void {
    const oldestValid = this.now().getTime() - PREVIEW_TTL_MS;
    for (const [id, preview] of this.staged) if (preview.createdAt < oldestValid) this.staged.delete(id);
  }
}

function parseCSV(bytes: Buffer): ParsedRow[] {
  const text = bytes.toString("utf8").replace(/^\uFEFF/, "");
  const rows: ParsedRow[] = [];
  let cells: string[] = [];
  let field = "";
  let quoted = false;
  let closedQuote = false;
  let physicalRow = 1;
  let rowStartNumber = 1;

  const finishField = () => { cells.push(field); field = ""; closedQuote = false; };
  const finishRow = () => { finishField(); rows.push({ rowNumber: rowStartNumber, cells }); cells = []; };
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') { field += '"'; index += 1; }
      else if (character === '"') { quoted = false; closedQuote = true; }
      else { field += character; if (character === "\n") physicalRow += 1; }
      continue;
    }
    if (closedQuote && character !== "," && character !== "\r" && character !== "\n" && character !== " " && character !== "\t") {
      throw new CRMIngestionError("FILE_PARSE_ERROR", `CSV row ${physicalRow}: unexpected character after a closing quote.`);
    }
    if (character === '"') {
      if (field.length > 0) throw new CRMIngestionError("FILE_PARSE_ERROR", `CSV row ${physicalRow}: quote inside an unquoted field.`);
      quoted = true;
    } else if (character === ",") finishField();
    else if (character === "\n") { finishRow(); physicalRow += 1; rowStartNumber = physicalRow; }
    else if (character === "\r") {
      if (text[index + 1] === "\n") index += 1;
      finishRow();
      physicalRow += 1;
      rowStartNumber = physicalRow;
    } else if (!closedQuote) field += character;
  }
  if (quoted) throw new CRMIngestionError("FILE_PARSE_ERROR", `CSV row ${physicalRow}: quoted field is not closed.`);
  if (field.length || cells.length || (text.length && !/[\r\n]$/.test(text))) finishRow();
  return rows;
}

function parseXLSX(bytes: Buffer): ParsedRow[] {
  try {
    const workbook = XLSX.read(bytes, { type: "buffer", cellDates: false, dense: true, sheetRows: MAX_ROWS + 2 });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) return [];
    const table = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]!, {
      header: 1, defval: "", raw: true, blankrows: true
    }) as unknown[][];
    return table.map((cells, index) => ({ rowNumber: index + 1, cells }));
  } catch (error) {
    if (error instanceof CRMIngestionError) throw error;
    throw new CRMIngestionError("FILE_PARSE_ERROR", "The XLSX file could not be parsed. Check that it is a valid .xlsx workbook.");
  }
}

function normalizeHeader(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/^\uFEFF/, "").toLocaleLowerCase("en-US").replace(/[^a-z0-9]/g, "") : "";
}

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && !value.trim());
}

function parseDealValue(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : undefined;
  if (typeof value !== "string") return undefined;
  const cleaned = value.trim().replace(/^[$₹€£]\s*/, "");
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(cleaned)) return undefined;
  const parsed = Number(cleaned.replace(/,/g, ""));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function hasMatchingMimeType(extension: string, contentType: string): boolean {
  const type = contentType.split(";")[0]!.trim().toLocaleLowerCase("en-US");
  if (type === "application/octet-stream") return true;
  if (extension === "xlsx") return type === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  return ["text/csv", "application/csv", "text/plain", "application/vnd.ms-excel"].includes(type);
}

function safeFileName(value: string): string {
  const fileName = value.replace(/[/\\\\]/g, "/").split("/").pop()?.replace(/[\r\n\0]/g, "").trim();
  if (!fileName || fileName.length > 200 || fileName.startsWith(".")) {
    throw new CRMIngestionError("INVALID_FILE_NAME", "A valid .xlsx or .csv filename is required.");
  }
  return fileName;
}

function cloneLead(lead: CRMLead): CRMLead {
  return { ...lead, lastContactedAt: new Date(lead.lastContactedAt), notes: [...lead.notes] };
}

export const crmIngestionService = new CRMIngestionService();
