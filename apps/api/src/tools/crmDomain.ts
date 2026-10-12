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

export type CRMContactMatchMethod =
  | "exact_email"
  | "normalized_email"
  | "exact_phone"
  | "exact_name"
  | "exact_person_company"
  | "exact_company"
  | "email_domain"
  | "name_component"
  | "fuzzy_name"
  | "fuzzy_company";

export type CRMContactResolution =
  | {
    status: "RESOLVED";
    entity: {
      entityType: "person" | "company";
      crmRecordRef: string;
      canonicalName: string;
      company: string;
      email: string;
      confidence: number;
      matchedBy: CRMContactMatchMethod;
    };
  }
  | {
    status: "AMBIGUOUS";
    candidates: Array<{
      crmRecordRef: string;
      canonicalName: string;
      company: string;
      matchedBy: CRMContactMatchMethod;
      confidence: number;
    }>;
  }
  | { status: "NOT_FOUND"; query: string };

export function normalizeCRMEmail(value: string): string {
  return value.trim().normalize("NFKC").toLocaleLowerCase("en-US");
}

function normalizeCRMPhone(value: string): string {
  return value.replace(/\D/g, "");
}

function normalizeCRMName(value: string): string {
  return value.trim().normalize("NFKC").toLocaleLowerCase("en-US").replace(/\s+/g, " ");
}

function normalizeCRMCompany(value: string): string {
  return normalizeCRMName(value)
    .replace(/[.,'’]/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+(incorporated|corporation|corp|company|co|limited|ltd|llc|plc|gmbh)$/g, "")
    .trim();
}

function editSimilarity(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    let diagonal = previous[0]!;
    previous[0] = row;
    for (let column = 1; column <= right.length; column += 1) {
      const above = previous[column]!;
      previous[column] = Math.min(previous[column]! + 1, previous[column - 1]! + 1, diagonal + (left[row - 1] === right[column - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return 1 - previous[right.length]! / Math.max(left.length, right.length, 1);
}

/** Exact identity is preferred; weak/approximate candidates are always returned for clarification. */
export function resolveCRMContact(
  leads: readonly CRMLead[],
  input: { query: string; company?: string }
): CRMContactResolution {
  const query = input.query.trim();
  const normalizedQuery = normalizeCRMName(query);
  const normalizedCompany = input.company ? normalizeCRMCompany(input.company) : undefined;
  const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(query) ? normalizeCRMEmail(query) : undefined;
  const candidates: Array<{ lead: CRMLead; matchedBy: CRMContactMatchMethod; confidence: number }> = [];

  const collect = (
    matches: CRMLead[],
    matchedBy: CRMContactMatchMethod,
    confidence: number,
    entityType: "person" | "company"
  ): CRMContactResolution | undefined => {
    if (!matches.length) return undefined;
    const unique = [...new Map(matches.map((lead) => [lead.id, lead])).values()];
    if (unique.length > 1) {
      return {
        status: "AMBIGUOUS",
        candidates: unique.sort((left, right) => left.name.localeCompare(right.name, "en-US") || left.id.localeCompare(right.id, "en-US")).slice(0, 10).map((lead) => ({
          crmRecordRef: lead.id, canonicalName: lead.name, company: lead.company, matchedBy, confidence
        }))
      };
    }
    const lead = unique[0]!;
    return {
      status: "RESOLVED",
      entity: {
        entityType, crmRecordRef: lead.id, canonicalName: lead.name, company: lead.company,
        email: normalizeCRMEmail(lead.email), confidence, matchedBy
      }
    };
  };

  if (email) {
    const exact = leads.filter((lead) => lead.email === email);
    const match = collect(exact, "exact_email", 1, "person");
    if (match) return match;
    // Normalized matching remains explicit even though validated CRM rows are canonicalized at ingestion.
    const normalized = leads.filter((lead) => normalizeCRMEmail(lead.email) === email);
    const normalizedMatch = collect(normalized, "normalized_email", 0.99, "person");
    if (normalizedMatch) return normalizedMatch;
    const domain = email.slice(email.lastIndexOf("@") + 1);
    const domainCandidates = leads.filter((lead) => lead.email.split("@")[1]?.toLocaleLowerCase("en-US") === domain);
    if (domainCandidates.length) {
      return {
        status: "AMBIGUOUS",
        candidates: domainCandidates
          .sort((left, right) => left.name.localeCompare(right.name, "en-US") || left.id.localeCompare(right.id, "en-US"))
          .slice(0, 10)
          .map((lead) => ({
            crmRecordRef: lead.id, canonicalName: lead.name, company: lead.company,
            matchedBy: "email_domain", confidence: 0.7
          }))
      };
    }
    return { status: "NOT_FOUND", query };
  }

  const phoneDigits = normalizeCRMPhone(query);
  if (phoneDigits.length >= 7 && !/[a-z]/i.test(query)) {
    const phoneMatches = leads.filter((lead) => lead.phone && normalizeCRMPhone(lead.phone) === phoneDigits);
    return collect(phoneMatches, "exact_phone", 0.99, "person") ?? { status: "NOT_FOUND", query };
  }

  if (!normalizedQuery) return { status: "NOT_FOUND", query };
  if (normalizedCompany) {
    const personAndCompany = leads.filter((lead) =>
      normalizeCRMName(lead.name) === normalizedQuery && normalizeCRMCompany(lead.company) === normalizedCompany);
    const match = collect(personAndCompany, "exact_person_company", 0.98, "person");
    if (match) return match;
  }

  const exactNames = leads.filter((lead) => normalizeCRMName(lead.name) === normalizedQuery &&
    (!normalizedCompany || normalizeCRMCompany(lead.company) === normalizedCompany));
  const exactNameMatch = collect(exactNames, normalizedCompany ? "exact_person_company" : "exact_name", normalizedCompany ? 0.98 : 0.97, "person");
  if (exactNameMatch) return exactNameMatch;

  if (normalizedCompany && /\S+/.test(normalizedQuery)) {
    const sameFirstNameAndCompany = leads.filter((lead) =>
      normalizeCRMName(lead.name).split(" ")[0] === normalizedQuery &&
      normalizeCRMCompany(lead.company) === normalizedCompany);
    const partialNameMatch = collect(sameFirstNameAndCompany, "name_component", 0.86, "person");
    if (partialNameMatch) return partialNameMatch;
  }

  const exactCompanies = leads.filter((lead) =>
    normalizeCRMCompany(lead.company) === normalizeCRMCompany(query) &&
    (!normalizedCompany || normalizeCRMCompany(lead.company) === normalizedCompany));
  const companyMatch = collect(exactCompanies, "exact_company", 0.96, "company");
  if (companyMatch) return companyMatch;

  if (query.includes("@")) {
    const domain = query.slice(query.lastIndexOf("@") + 1).toLocaleLowerCase("en-US");
    const domainMatches = leads.filter((lead) => lead.email.split("@")[1]?.toLocaleLowerCase("en-US") === domain);
    const domainMatch = collect(domainMatches, "email_domain", 0.8, "company");
    if (domainMatch) return domainMatch;
  }

  const queryTokens = normalizedQuery.split(" ").filter(Boolean);
  const exactComponentMatches = leads.filter((lead) => {
    const nameTokens = normalizeCRMName(lead.name).split(" ");
    return queryTokens.length === 1 && nameTokens.includes(queryTokens[0]!) &&
      (!normalizedCompany || normalizeCRMCompany(lead.company) === normalizedCompany);
  });
  if (exactComponentMatches.length) {
    const match = collect(exactComponentMatches, "name_component", exactComponentMatches.length > 1 ? 0.72 : 0.88, "person");
    if (match) return match;
  }

  for (const lead of leads) {
    const nameScore = editSimilarity(normalizedQuery, normalizeCRMName(lead.name));
    const companyScore = editSimilarity(normalizeCRMCompany(query), normalizeCRMCompany(lead.company));
    if (normalizedCompany && normalizeCRMCompany(lead.company) !== normalizedCompany) continue;
    if (nameScore >= 0.82) candidates.push({ lead, matchedBy: "fuzzy_name", confidence: Number(nameScore.toFixed(2)) });
    else if (companyScore >= 0.82) candidates.push({ lead, matchedBy: "fuzzy_company", confidence: Number(companyScore.toFixed(2)) });
  }
  if (candidates.length) {
    return {
      status: "AMBIGUOUS",
      candidates: candidates
        .sort((left, right) => right.confidence - left.confidence || left.lead.name.localeCompare(right.lead.name, "en-US") || left.lead.id.localeCompare(right.lead.id, "en-US"))
        .slice(0, 10)
        .map(({ lead, matchedBy, confidence }) => ({
          crmRecordRef: lead.id, canonicalName: lead.name, company: lead.company, matchedBy, confidence
        }))
    };
  }

  return { status: "NOT_FOUND", query };
}

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
