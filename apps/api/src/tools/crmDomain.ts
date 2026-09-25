/** Pipeline stages that count as active, independent of communication recency. */
export const ACTIVE_PIPELINE_STATUSES = [
  "New",
  "Interested",
  "Proposal",
  "Negotiation"
] as const;

export const DEFAULT_MIN_DEAL_VALUE = 25_000;

export type CRMLead = {
  id: string;
  name: string;
  email: string;
  company: string;
  dealValue: number;
  status?: string;
  lastContactedAt: Date;
  notes: string[];
  phone?: string;
  owner?: string;
};

export type CRMLeadInput = Omit<CRMLead, "lastContactedAt"> & {
  lastContactedAt: Date | string | number;
};

/** Excel's 1900 date system uses 1899-12-30 as its serial-date epoch. */
export function normalizeCRMDate(value: Date | string | number, field = "lastContactedAt"): Date {
  let date: Date;
  if (value instanceof Date) {
    date = new Date(value.getTime());
  } else if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${field} must be a valid Excel serial date`);
    date = new Date(Date.UTC(1899, 11, 30) + value * 86_400_000);
  } else {
    date = new Date(value);
  }
  if (Number.isNaN(date.getTime())) throw new Error(`${field} must be a valid date`);
  return date;
}

/** Accept workbook headings and legacy value column while exposing one canonical domain shape. */
export function normalizeCRMLead(row: Record<string, unknown>, rowNumber = 1): CRMLead {
  const pick = (...keys: string[]) => keys.map((key) => row[key]).find((value) => value !== undefined && value !== null);
  const id = pick("id", "leadId", "Lead ID");
  const name = pick("name", "Name", "leadName");
  const email = pick("email", "Email");
  const company = pick("company", "Company");
  const rawValue = pick("dealValue", "Deal Value", "value", "Value");
  const status = pick("status", "Status");
  const contacted = pick("lastContactedAt", "Last Contacted At", "lastContacted", "Last Contacted");
  const required = { name, email, company, dealValue: rawValue, lastContactedAt: contacted };
  for (const [field, value] of Object.entries(required)) {
    if (value === undefined || value === null || (typeof value === "string" && !value.trim())) {
      throw new Error(`CRM row ${rowNumber}: required field '${field}' is missing`);
    }
  }
  const dealValue = typeof rawValue === "number" ? rawValue : Number(rawValue);
  if (!Number.isFinite(dealValue) || dealValue < 0) {
    throw new Error(`CRM row ${rowNumber}: dealValue must be a finite non-negative number`);
  }
  if ((id !== undefined && typeof id !== "string") || (status !== undefined && typeof status !== "string") ||
      typeof email !== "string" || typeof name !== "string" || typeof company !== "string") {
    throw new Error(`CRM row ${rowNumber}: name, email, company, optional id, and optional status must be text`);
  }
  const canonicalEmail = email.trim().toLocaleLowerCase("en-US");
  if (!/^\S+@\S+\.\S+$/.test(canonicalEmail)) throw new Error(`CRM row ${rowNumber}: email must be a valid email address`);
  const notesValue = pick("notes", "Notes");
  const notes = notesValue === undefined ? [] : Array.isArray(notesValue) ? notesValue : [notesValue];
  if (!notes.every((note) => typeof note === "string")) throw new Error(`CRM row ${rowNumber}: notes must be text`);
  const phone = pick("phone", "Phone");
  const owner = pick("owner", "Owner");
  if (phone !== undefined && typeof phone !== "string") throw new Error(`CRM row ${rowNumber}: phone must be text`);
  if (owner !== undefined && typeof owner !== "string") throw new Error(`CRM row ${rowNumber}: owner must be text`);
  return {
    // The system identity is deterministically derived from the required email when no ID column is supplied.
    id: typeof id === "string" && id.trim() ? id.trim() : canonicalEmail,
    name: name.trim(), email: canonicalEmail, company: company.trim(),
    dealValue, ...(typeof status === "string" && status.trim() ? { status: status.trim() } : {}),
    lastContactedAt: normalizeCRMDate(contacted as Date | string | number, `CRM row ${rowNumber} lastContactedAt`),
    notes: [...notes],
    ...(typeof phone === "string" && phone.trim() ? { phone: phone.trim() } : {}),
    ...(typeof owner === "string" && owner.trim() ? { owner: owner.trim() } : {})
  };
}

export function validateCRMLeads(rows: readonly Record<string, unknown>[]): CRMLead[] {
  const leads = rows.map((row, index) => normalizeCRMLead(row, index + 2));
  const identities = new Set<string>();
  for (const lead of leads) {
    const identity = lead.email.toLocaleLowerCase("en-US");
    if (identities.has(identity)) throw new Error(`Duplicate CRM lead identity (email): ${lead.email}`);
    identities.add(identity);
  }
  return leads;
}

export function getActiveHighValueLeads(leads: readonly CRMLead[], minDealValue: number): CRMLead[] {
  if (!Number.isFinite(minDealValue) || minDealValue < 0) throw new Error("minDealValue must be a finite non-negative number");
  return leads.filter((lead) => lead.dealValue >= minDealValue &&
    (ACTIVE_PIPELINE_STATUSES as readonly string[]).includes(lead.status ?? ""));
}

export function getInactiveHighValueLeads(
  leads: readonly CRMLead[], minDealValue: number, olderThanDays: number, now: Date
): CRMLead[] {
  if (!Number.isFinite(minDealValue) || minDealValue < 0) throw new Error("minDealValue must be a finite non-negative number");
  if (!Number.isFinite(olderThanDays) || olderThanDays < 0) throw new Error("olderThanDays must be a finite non-negative number");
  if (Number.isNaN(now.getTime())) throw new Error("now must be a valid date");
  const cutoff = now.getTime() - olderThanDays * 86_400_000;
  return leads.filter((lead) => lead.dealValue >= minDealValue && lead.lastContactedAt.getTime() < cutoff);
}
