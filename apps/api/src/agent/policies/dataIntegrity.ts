import { createHash } from "node:crypto";
import {
  AgentCRMRecord, AgentCRMRecordSchema, AgentCRMRecordsResult, AgentCRMRecordsResultSchema, AgentStructuredResult,
  EvidenceBundle, EvidenceBundleSchema, EvidenceStatus, GroundedAnswer, GroundedAnswerSchema,
  StepStatus, ToolResponse, ToolResult
} from "@nexusops/shared-types";

export const AGENT_INTEGRITY_INSTRUCTIONS = `
NON-NEGOTIABLE DATA INTEGRITY RULES
1. Never invent business data, records, values, dates, or outcomes.
2. Never regenerate or replace data when a business tool returns no results.
3. Preserve business tool results exactly; never modify, duplicate, omit, or complete them.
4. When a query returns an empty result, report explicitly that no matching records were found.
5. Do not repeat a tool call with identical arguments because its result was empty.
6. Do not relax user criteria unless the user explicitly requests it.
7. Claim an action occurred only when its action tool returned success and confirmed that action.
8. Business facts must come from business tool results.
9. Label every reported statement as FACT, INFERENCE, or RECOMMENDATION.
10. If available evidence is insufficient, say so; do not fill gaps with assumptions.
11. Every final factual claim must cite evidence from this run that directly supports it.
12. Keep not-found, ambiguous, conflicting, unavailable, disconnected, denied, and tool-failure states distinct.
13. Never present an unverified recommendation or a proposed action as a completed result.
`;

export type EvidenceItem = {
  evidenceRef: string;
  tool: string;
  action: string;
  statement: string;
  outcome: "EMPTY_RESULT" | "RESULT_RETURNED" | "SUCCESS_NOT_CONFIRMED";
  resolutionStatus?: "RESOLVED" | "AMBIGUOUS" | "NOT_FOUND" | "INSUFFICIENT_EVIDENCE" |
    "SOURCE_UNAVAILABLE" | "INTEGRATION_NOT_CONNECTED" | "AUTHORIZATION_DENIED" | "TOOL_FAILURE";
  recordRefs?: string[];
  matchingCriteria?: string[];
  error?: { code: string; message: string };
  sourceMatches?: Array<{
    source: "crm" | "gmail" | "calendar";
    recordRef: string;
    resolvedEntityRef?: string;
    matchedBy: string;
    confidence: number;
    timestamp?: string;
    summary: string;
    relevantFields?: Record<string, string | number | boolean>;
  }>;
};

export type EvidenceLinkedRecommendation = {
  statement: string;
  reason: string;
  evidenceRefs: string[];
  expectedOutcome: string;
};

export type AgentEvidenceReport = {
  FACT: EvidenceItem[];
  INFERENCE: string[];
  RECOMMENDATION: string[];
  recommendationEvidence: EvidenceLinkedRecommendation[];
  evidenceInsufficient: boolean;
  bundle: EvidenceBundle;
  structuredResult?: AgentStructuredResult;
};

export type ToolObservation = {
  tool: string;
  action: string;
  params: Record<string, unknown>;
  result: ToolResponse;
};

function safeSourceRef(source: string, kind: string, value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const digest = createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
  return `${source}.${kind}#${digest}`;
}

function sourceFailureStatus(code: string): NonNullable<EvidenceItem["resolutionStatus"]> {
  if (/NOT_CONNECTED/.test(code)) return "INTEGRATION_NOT_CONNECTED";
  if (/ACCESS_DENIED|AUTH_REQUIRED|AUTH_EXPIRED|AUTHORIZATION/.test(code)) return "AUTHORIZATION_DENIED";
  if (/UNAVAILABLE|RATE_LIMITED|RESULT_LIMIT|TIMEOUT/.test(code)) return "SOURCE_UNAVAILABLE";
  return "TOOL_FAILURE";
}

/** Returns a user-facing claim only when the action result confirms its mutation. */
export function verifiedActionStatement(tool: string, action: string, result: ToolResponse, params: Record<string, unknown> = {}): string | undefined {
  if (!result.success) return undefined;
  if (typeof result.data !== "object" || result.data === null) return undefined;
  const data = result.data as Record<string, unknown>;
  if (tool === "crm" && action === "updateLead" && data.updated === true && typeof data.lead === "object" && data.lead !== null) {
    const lead = data.lead as Record<string, unknown>;
    if (lead.id === params.leadId &&
        (params.status === undefined || lead.status === params.status) &&
        (params.dealValue === undefined || lead.dealValue === params.dealValue)) {
      return "Updated the CRM record with the explicitly requested field values.";
    }
  }
  if (tool === "crm" && action === "addLeadNote" && data.leadId === params.leadId &&
      typeof data.noteCount === "number" && Number.isInteger(data.noteCount) && data.noteCount > 0) {
    return "Added the explicitly requested note to the CRM record.";
  }
  if (tool === "tasks" && (action === "createTask" || action === "completeTask")) {
    if (typeof data.task !== "object" || data.task === null) return undefined;
    const task = data.task as Record<string, unknown>;
    if (action === "createTask" && data.created === true && typeof task.id === "string" && typeof task.title === "string" && task.status === "OPEN" && task.title === params.title) return `Created task "${task.title}" (id: ${task.id}).`;
    if (action === "completeTask" && data.updated === true && typeof task.id === "string" && task.status === "COMPLETED" && task.id === params.taskId) return `Completed task ${task.id}.`;
  }
  if (tool === "email" && action === "draftEmail" && typeof data.draftId === "string" && data.draftId && typeof data.to === "string" && data.to.toLowerCase() === String(params.to ?? "").toLowerCase() && typeof data.subject === "string" && data.subject === params.subject && data.status === "DRAFT") {
    return `Created Gmail draft "${data.subject}" for ${data.to} (draft id: ${data.draftId}).`;
  }
  if (tool === "email" && action === "sendEmail" && typeof data.messageId === "string" && data.messageId && data.draftId === params.draftId && typeof data.to === "string" && typeof data.subject === "string" && data.status === "SENT" && typeof data.sentAt === "string" && Number.isFinite(Date.parse(data.sentAt))) {
    return `Sent Gmail message "${data.subject}" to ${data.to} (message id: ${data.messageId}).`;
  }
  const returnedAttendees = Array.isArray(data.attendees) ? data.attendees.map(String).map((email) => email.toLowerCase()).sort() : [];
  const requestedAttendees = Array.isArray(params.attendees) ? params.attendees.map(String).map((email) => email.toLowerCase()).sort() : [];
  if (tool === "calendar" && action === "createMeeting" && typeof data.id === "string" && data.id && typeof data.title === "string" && data.title === params.title && data.status === "SCHEDULED" && typeof data.startTime === "string" && Date.parse(data.startTime) === Date.parse(String(params.startTime)) && typeof data.endTime === "string" && Date.parse(data.endTime) === Date.parse(String(params.endTime)) && JSON.stringify(returnedAttendees) === JSON.stringify(requestedAttendees)) {
    return `Created calendar event "${data.title}" (id: ${data.id}).`;
  }
  return undefined;
}

export function canAssertGoalCompletion(statuses: readonly StepStatus[]): boolean {
  return statuses.length > 0 && statuses.every((status) => status === StepStatus.COMPLETED);
}

function emptyResultStatement(tool: string, action: string, params: Record<string, unknown>): string {
  if (tool === "crm" && ["listActiveHighValueLeads", "listInactiveLeads", "searchLeads"].includes(action)) {
    return "No CRM records matched the requested criteria.";
  }
  if (tool === "email" && action === "getUnansweredMessages") return "No unanswered email messages were found.";
  if (tool === "email" && action === "getEmailHistory") {
    return params.leadEmail ? "No email history was found for this lead." : "No email history was found for the requested criteria.";
  }
  if (tool === "calendar" && action === "getAvailability") return "No matching calendar availability was found.";
  if (tool === "calendar" && (action === "getMeeting" || action === "listUpcomingEvents")) return "No matching calendar events were found.";
  if (tool === "email" && action === "getUnansweredMessages") return "No unanswered email messages were found.";
  return "No matching records were found.";
}

const CRM_READ_ACTIONS = new Set(["listInactiveLeads", "listActiveHighValueLeads", "searchLeads"]);

function crmResultTitle(action: string, params: Record<string, unknown>): string {
  if (action === "listInactiveLeads") return "Inactive high-value leads";
  if (action === "listActiveHighValueLeads") return "Active high-value leads";
  return typeof params.minDealValue === "number" ? "High-value leads" : "CRM records";
}

function crmMatchingCriteria(params: Record<string, unknown>): string[] {
  const criteria: string[] = [];
  if (typeof params.minDaysInactive === "number" && Number.isFinite(params.minDaysInactive)) {
    criteria.push(`Last contacted more than ${params.minDaysInactive} days ago`);
  }
  if (typeof params.minDealValue === "number" && Number.isFinite(params.minDealValue)) {
    criteria.push(`Deal value at least ${new Intl.NumberFormat("en-US").format(params.minDealValue)}`);
  }
  if (typeof params.query === "string" && params.query.trim()) criteria.push("Matches the CRM search terms in your request");
  return criteria;
}

function evidenceSource(tool: string): EvidenceBundle["items"][number]["source"] | undefined {
  if (tool === "email") return "gmail";
  return ["crm", "calendar", "analytics", "tasks"].includes(tool)
    ? tool as EvidenceBundle["items"][number]["source"]
    : undefined;
}

function statusForEvidenceItems(facts: readonly EvidenceItem[], hasConflict = false): EvidenceStatus {
  if (facts.some(({ resolutionStatus }) => resolutionStatus === "AMBIGUOUS")) return "AMBIGUOUS";
  if (hasConflict) return "CONFLICTING";
  if (facts.some(({ resolutionStatus }) => resolutionStatus === "INTEGRATION_NOT_CONNECTED")) return "INTEGRATION_NOT_CONNECTED";
  if (facts.some(({ resolutionStatus }) => resolutionStatus === "AUTHORIZATION_DENIED")) return "AUTHORIZATION_DENIED";
  if (facts.some(({ resolutionStatus }) => resolutionStatus === "SOURCE_UNAVAILABLE")) return "SOURCE_UNAVAILABLE";
  if (facts.some((fact) => fact.resolutionStatus === "TOOL_FAILURE" ||
    !fact.resolutionStatus && fact.outcome === "SUCCESS_NOT_CONFIRMED")) return "TOOL_FAILURE";
  if (facts.some(({ resolutionStatus }) => resolutionStatus === "INSUFFICIENT_EVIDENCE")) return "INSUFFICIENT_EVIDENCE";
  if (facts.length > 0 && facts.every(({ outcome }) => outcome === "EMPTY_RESULT")) return "NOT_FOUND";
  if (facts.some(({ outcome }) => outcome === "EMPTY_RESULT")) return "INSUFFICIENT_EVIDENCE";
  if (facts.length > 0 && facts.every(({ outcome }) => outcome === "RESULT_RETURNED")) return "SUPPORTED";
  return "INSUFFICIENT_EVIDENCE";
}

function crossSourceConflicts(items: EvidenceBundle["items"]): EvidenceBundle["conflicts"] {
  const valuesByField = new Map<string, {
    field: string;
    values: EvidenceBundle["conflicts"][number]["values"];
  }>();
  for (const item of items) {
    for (const sourceMatch of item.sourceMatches) {
      if (!sourceMatch.resolvedEntityRef) continue;
      for (const field of ["name", "company"] as const) {
        const value = sourceMatch.relevantFields?.[field];
        if (typeof value !== "string" || !value.trim()) continue;
        const key = `${sourceMatch.resolvedEntityRef}\u001f${field}`;
        const grouped = valuesByField.get(key) ?? { field, values: [] };
        if (!grouped.values.some(({ source, value: existing }) =>
          source === sourceMatch.source && existing.toLocaleLowerCase("en-US") === value.toLocaleLowerCase("en-US"))) {
          grouped.values.push({ source: sourceMatch.source, value, evidenceRef: item.evidenceRef });
        }
        valuesByField.set(key, grouped);
      }
    }
  }
  return [...valuesByField.values()]
    .filter(({ values }) => new Set(values.map(({ value }) => value.toLocaleLowerCase("en-US"))).size > 1)
    .map(({ field, values }) => ({ field, values: values.slice(0, 10) }));
}

function safeLimitations(facts: readonly EvidenceItem[], missingSources: readonly string[]): string[] {
  const limitations = new Set<string>();
  for (const fact of facts) {
    switch (fact.resolutionStatus) {
      case "AMBIGUOUS": limitations.add("The identity is ambiguous; dependent source lookups were not used to choose a candidate."); break;
      case "NOT_FOUND": limitations.add("No matching record was found within the executed query criteria."); break;
      case "INSUFFICIENT_EVIDENCE": limitations.add("Retrieved data does not establish the requested conclusion."); break;
      case "SOURCE_UNAVAILABLE": limitations.add(`${fact.tool} data was unavailable for this run.`); break;
      case "INTEGRATION_NOT_CONNECTED": limitations.add(`${fact.tool} is not connected for this workspace.`); break;
      case "AUTHORIZATION_DENIED": limitations.add(`${fact.tool} access was denied or requires authorization.`); break;
      case "TOOL_FAILURE": limitations.add(`${fact.tool} could not complete the requested retrieval.`); break;
    }
    if (!fact.resolutionStatus && fact.outcome === "SUCCESS_NOT_CONFIRMED") {
      limitations.add(`${fact.tool} did not return a usable result.`);
    }
  }
  for (const source of missingSources) limitations.add(`${source} retrieval was not attempted.`);
  return [...limitations];
}

function safeEvidenceStatement(fact: EvidenceItem): string {
  if (fact.tool === "email" && fact.action === "draftEmail") return "Gmail draft creation was verified.";
  if (fact.tool === "email" && fact.action === "sendEmail") return "Gmail send execution was verified.";
  if (fact.tool === "calendar" && fact.action === "createMeeting") return "Calendar event creation was verified.";
  if (fact.tool === "tasks" && ["createTask", "completeTask"].includes(fact.action)) {
    return `Task ${fact.action === "createTask" ? "creation" : "completion"} was verified.`;
  }
  return fact.statement;
}

export function buildEvidenceBundle(
  facts: readonly EvidenceItem[],
  requiredSources: readonly string[] = []
): EvidenceBundle {
  const items: EvidenceBundle["items"] = facts.flatMap((fact) => {
    const source = evidenceSource(fact.tool);
    if (!source) return [];
    return [{
      evidenceRef: fact.evidenceRef,
      source,
      statement: safeEvidenceStatement(fact),
      recordRefs: fact.recordRefs ?? [],
      resolvedEntityRefs: [...new Set((fact.sourceMatches ?? []).flatMap(({ resolvedEntityRef }) => resolvedEntityRef ? [resolvedEntityRef] : []))],
      matchingCriteria: fact.matchingCriteria ?? [],
      ...(fact.sourceMatches?.find(({ timestamp }) => timestamp)?.timestamp
        ? { timestamp: fact.sourceMatches.find(({ timestamp }) => timestamp)!.timestamp }
        : {}),
      sourceMatches: fact.sourceMatches ?? []
    }];
  });
  const conflicts = crossSourceConflicts(items);
  const missingSources = requiredSources
    .filter((source) => !items.some(({ source: itemSource }) => itemSource === source))
    .filter((source) => ["crm", "gmail", "calendar", "analytics", "tasks"].includes(source));
  const sufficiency = statusForEvidenceItems(facts, conflicts.length > 0);
  const attemptedSources = [...new Set(items.map(({ source }) => source))];
  const sourceCoverage: EvidenceBundle["sourceCoverage"] = attemptedSources.map((source) => {
    const sourceFacts = facts.filter((fact) => evidenceSource(fact.tool) === source);
    const status = statusForEvidenceItems(sourceFacts);
    const retrievalStatus = status === "NOT_FOUND" ? "NO_MATCH"
      : ["SOURCE_UNAVAILABLE", "INTEGRATION_NOT_CONNECTED", "AUTHORIZATION_DENIED", "TOOL_FAILURE"].includes(status)
        ? "FAILED" : "RETRIEVED";
    return { source, status, retrievalStatus, evidenceRefs: sourceFacts.map(({ evidenceRef }) => evidenceRef) };
  });
  for (const source of missingSources) {
    const typedSource = source as EvidenceBundle["sourceCoverage"][number]["source"];
    sourceCoverage.push({
      source: typedSource,
      status: sufficiency === "AMBIGUOUS" ? "AMBIGUOUS" : "INSUFFICIENT_EVIDENCE",
      retrievalStatus: "NOT_ATTEMPTED",
      evidenceRefs: []
    });
  }
  const resolvedEntities: EvidenceBundle["resolvedEntities"] = [];
  for (const fact of facts) {
    if (fact.tool !== "crm") continue;
    for (const match of fact.sourceMatches ?? []) {
      const entityRef = match.resolvedEntityRef;
      if (!entityRef || resolvedEntities.some((entity) => entity.entityRef === entityRef)) continue;
      resolvedEntities.push({
        entityRef,
        type: "crm_contact",
        ...(typeof match.relevantFields?.name === "string" ? { name: match.relevantFields.name } : {}),
        ...(typeof match.relevantFields?.company === "string" ? { company: match.relevantFields.company } : {})
      });
    }
  }
  return EvidenceBundleSchema.parse({
    sufficiency: missingSources.length > 0 && sufficiency === "SUPPORTED" ? "INSUFFICIENT_EVIDENCE" : sufficiency,
    items,
    resolvedEntities,
    sourceCoverage,
    conflicts,
    limitations: safeLimitations(facts, missingSources)
  });
}

const NON_FACT_WORDS = new Set([
  "a", "about", "after", "all", "an", "and", "are", "as", "at", "be", "been", "before", "being", "but", "by",
  "can", "could", "did", "do", "does", "for", "from", "had", "has", "have", "in", "into", "is", "it", "its",
  "may", "might", "more", "most", "of", "on", "or", "our", "please", "should", "so", "than", "that", "the",
  "their", "there", "these", "this", "those", "to", "was", "were", "what", "when", "where", "which", "who",
  "will", "with", "would", "your"
]);
const NON_FACT_RECOMMENDATION_WORDS = new Set([
  ...NON_FACT_WORDS,
  "available", "based", "check", "clarify", "consider", "continue", "coordinate", "could", "discuss",
  "ensure", "follow", "help", "may", "out", "plan", "prepare", "recommend", "review", "schedule",
  "should", "steps", "using", "would"
]);

function claimIsSupported(text: string, evidenceItems: EvidenceBundle["items"]): boolean {
  const words = (value: string) => value.toLocaleLowerCase("en-US").match(/[a-z0-9]+/g) ?? [];
  const claimWords = words(text).filter((word) => word.length > 1 && !NON_FACT_WORDS.has(word));
  if (claimWords.length === 0) return false;
  const sourceText = evidenceItems.flatMap((item) => [
    item.statement,
    ...item.sourceMatches.map(({ summary }) => summary),
    ...item.sourceMatches.flatMap(({ relevantFields }) => Object.values(relevantFields ?? {}).map(String))
  ]).join(" ");
  const evidenceWords = new Set(words(sourceText));
  return claimWords.every((word) => evidenceWords.has(word));
}

function recommendationTextIsSupported(text: string, evidenceItems: EvidenceBundle["items"]): boolean {
  const words = text.toLocaleLowerCase("en-US").match(/[a-z0-9]+/g) ?? [];
  const factualWords = words.filter((word) => word.length > 1 && !NON_FACT_RECOMMENDATION_WORDS.has(word));
  if (factualWords.length === 0) return false;
  const evidenceWords = new Set(evidenceItems.flatMap((item) => [
    item.statement,
    ...item.sourceMatches.map(({ summary }) => summary),
    ...item.sourceMatches.flatMap(({ relevantFields }) => Object.values(relevantFields ?? {}).map(String))
  ]).join(" ").toLocaleLowerCase("en-US").match(/[a-z0-9]+/g) ?? []);
  return factualWords.every((word) => evidenceWords.has(word));
}

function claimConfidence(claim: GroundedAnswer["claims"][number], bundle: EvidenceBundle): number | undefined {
  const referencedItems = bundle.items.filter(({ evidenceRef }) => claim.evidenceRefs.includes(evidenceRef));
  if (referencedItems.length !== claim.evidenceRefs.length) return undefined;
  const confidences = referencedItems.flatMap(({ sourceMatches }) => sourceMatches.map(({ confidence }) => confidence));
  return confidences.length ? Math.min(...confidences) : undefined;
}

function answerForStatus(status: EvidenceStatus): string {
  switch (status) {
    case "SUPPORTED": return "Evidence supports the retrieved results.";
    case "NOT_FOUND": return "No matching evidence was found within the executed search criteria.";
    case "AMBIGUOUS": return "I found multiple possible matches and cannot safely determine which one you mean.";
    case "CONFLICTING": return "The available sources conflict, so I cannot provide a reliable conclusion.";
    case "SOURCE_UNAVAILABLE": return "A required source was unavailable, so the request could not be fully checked.";
    case "INTEGRATION_NOT_CONNECTED": return "A required integration is not connected, so the request could not be fully checked.";
    case "AUTHORIZATION_DENIED": return "A required source denied access, so the request could not be fully checked.";
    case "TOOL_FAILURE": return "A required business-data lookup failed, so the request could not be completed.";
    default: return "Insufficient evidence to determine the requested result.";
  }
}

export function validateGroundedAnswer(
  candidate: unknown,
  bundle: EvidenceBundle,
  facts: readonly EvidenceItem[],
  fallbackReason: "service_unavailable" | "malformed_output" | "not_generated" = candidate === undefined
    ? "not_generated"
    : "malformed_output"
): GroundedAnswer {
  const validRefs = new Set(bundle.items.map(({ evidenceRef }) => evidenceRef));
  const parsed = GroundedAnswerSchema.safeParse(candidate);
  if (bundle.conflicts.length > 0) {
    const conflictRefs = [...new Set(bundle.conflicts.flatMap(({ values }) => values.map(({ evidenceRef }) => evidenceRef)))];
    const conflictFields = [...new Set(bundle.conflicts.map(({ field }) => field))].join(", ");
    const text = `The sources report conflicting values for ${conflictFields}; no reliable conclusion can be drawn.`;
    const claims: GroundedAnswer["claims"] = conflictRefs.length ? [{
      claimId: "source-conflict",
      text,
      evidenceRefs: conflictRefs,
      status: "supported"
    }] : [];
    return GroundedAnswerSchema.parse({
      status: "CONFLICTING",
      answer: claims.length
        ? `${text} [evidence: ${conflictRefs.join(", ")}]`
        : answerForStatus("CONFLICTING"),
      claims,
      evidenceRefs: conflictRefs,
      limitations: bundle.limitations,
      recommendations: []
    });
  }
  if (bundle.sufficiency !== "SUPPORTED") {
    const claims: GroundedAnswer["claims"] = facts.slice(0, 50).map((fact, index) => ({
      claimId: `evidence-${index + 1}`,
      text: fact.statement,
      evidenceRefs: [fact.evidenceRef],
      status: "supported"
    }));
    return GroundedAnswerSchema.parse({
      status: bundle.sufficiency,
      answer: claims.length
        ? claims.map(({ text, evidenceRefs }) => `${text} [evidence: ${evidenceRefs.join(", ")}]`).join("\n")
        : answerForStatus(bundle.sufficiency),
      claims,
      evidenceRefs: claims.map(({ evidenceRefs }) => evidenceRefs[0]!),
      limitations: bundle.limitations,
      recommendations: []
    });
  }
  const isValid = parsed.success &&
    parsed.data.status === bundle.sufficiency &&
    (parsed.data.claims.length > 0 || bundle.items.length === 0) &&
    parsed.data.claims.every((claim) => claim.status === "supported" &&
      claim.evidenceRefs.every((ref) => validRefs.has(ref)) &&
      claimIsSupported(claim.text, bundle.items.filter(({ evidenceRef }) => claim.evidenceRefs.includes(evidenceRef)))) &&
    parsed.data.recommendations.every((recommendation) =>
      recommendation.evidenceRefs.length > 0 &&
      recommendation.evidenceRefs.every((ref) => validRefs.has(ref)) &&
      recommendationTextIsSupported(recommendation.statement, bundle.items.filter(({ evidenceRef }) => recommendation.evidenceRefs.includes(evidenceRef))) &&
      claimIsSupported(recommendation.reason, bundle.items.filter(({ evidenceRef }) => recommendation.evidenceRefs.includes(evidenceRef))) &&
      recommendationTextIsSupported(recommendation.expectedOutcome, bundle.items.filter(({ evidenceRef }) => recommendation.evidenceRefs.includes(evidenceRef)))) &&
    parsed.data.evidenceRefs.every((ref) => validRefs.has(ref)) &&
    (!parsed.data.recommendedNextStep ||
      parsed.data.recommendedNextStep.evidenceRefs.every((ref) => validRefs.has(ref)) &&
      recommendationTextIsSupported(
        parsed.data.recommendedNextStep.text,
        bundle.items.filter(({ evidenceRef }) => parsed.data.recommendedNextStep!.evidenceRefs.includes(evidenceRef))
      ));
  if (isValid && parsed.success) {
    const claims = parsed.data.claims.map((claim) => {
      const confidence = claimConfidence(claim, bundle);
      const { confidence: _modelConfidence, ...withoutModelConfidence } = claim;
      return { ...withoutModelConfidence, ...(confidence !== undefined ? { confidence } : {}) };
    });
    const recommendations = parsed.data.recommendations;
    const answer = claims.length
      ? claims.map(({ text, evidenceRefs }) => `${text} [evidence: ${evidenceRefs.join(", ")}]`).join("\n")
      : answerForStatus(bundle.sufficiency);
    const { confidence: _modelConfidence, ...answerWithoutModelConfidence } = parsed.data;
    const claimConfidences = claims.flatMap(({ confidence }) => confidence === undefined ? [] : [confidence]);
    return {
      ...answerWithoutModelConfidence,
      answer,
      claims,
      evidenceRefs: [...new Set(claims.flatMap(({ evidenceRefs }) => evidenceRefs))],
      limitations: [...new Set([...bundle.limitations, ...parsed.data.limitations])],
      ...(claims.length > 0 && claimConfidences.length === claims.length
        ? { confidence: Math.min(...claimConfidences) }
        : {}),
      recommendations
    };
  }
  const fallbackClaims: GroundedAnswer["claims"] = facts.slice(0, 50).map((fact, index) => ({
    claimId: `evidence-${index + 1}`,
    text: fact.statement,
    evidenceRefs: [fact.evidenceRef],
    status: "supported"
  }));
  const fallbackLimitation = parsed.success
    ? "Generated claims or recommendations failed evidence validation; only tool-reported facts are shown."
    : fallbackReason === "service_unavailable"
      ? "The answer generation service was unavailable; only tool-reported facts are shown."
      : fallbackReason === "not_generated"
        ? "No structured answer was generated; only tool-reported facts are shown."
        : "The answer generator returned malformed output; only tool-reported facts are shown.";
  return GroundedAnswerSchema.parse({
    status: bundle.sufficiency,
    answer: fallbackClaims.length
      ? fallbackClaims.map(({ text, evidenceRefs }) => `${text} [evidence: ${evidenceRefs.join(", ")}]`).join("\n")
      : answerForStatus(bundle.sufficiency),
    claims: fallbackClaims,
    evidenceRefs: fallbackClaims.map(({ evidenceRefs }) => evidenceRefs[0]!),
    limitations: [...bundle.limitations, fallbackLimitation].slice(0, 50),
    recommendations: []
  });
}

function normalizedField(value: unknown, maxLength: number): string | undefined {
  return typeof value === "string" && value.trim() && value.trim().length <= maxLength
    ? value.trim()
    : undefined;
}

function normalizedDate(value: unknown): string | undefined {
  if (!(value instanceof Date) && typeof value !== "string" && typeof value !== "number") return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function normalizeCRMRecord(value: unknown, recordRef: string): AgentCRMRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const candidate = {
    recordRef,
    ...(normalizedField(record.name, 200) ? { name: normalizedField(record.name, 200) } : {}),
    ...(normalizedField(record.company, 200) ? { company: normalizedField(record.company, 200) } : {}),
    ...(typeof record.dealValue === "number" && Number.isFinite(record.dealValue) && record.dealValue >= 0
      ? { dealValue: record.dealValue }
      : {}),
    ...(normalizedField(record.status, 100) ? { status: normalizedField(record.status, 100) } : {}),
    ...(normalizedDate(record.lastContactedAt) ? { lastContactedAt: normalizedDate(record.lastContactedAt) } : {})
  };
  if (Object.keys(candidate).length === 1) return undefined;
  const parsed = AgentCRMRecordSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

function crmStructuredResult(
  action: string,
  params: Record<string, unknown>,
  data: unknown,
  evidenceRef: string
): AgentCRMRecordsResult | undefined {
  if (!CRM_READ_ACTIONS.has(action) || !Array.isArray(data)) return undefined;
  const records: AgentCRMRecord[] = [];
  let validCount = 0;
  data.forEach((value, index) => {
    const record = normalizeCRMRecord(value, `${evidenceRef}:record-${index + 1}`);
    if (record) {
      validCount += 1;
      if (records.length < 500) records.push(record);
    }
  });
  return AgentCRMRecordsResultSchema.parse({
    resultType: "crm_records",
    source: "crm",
    title: crmResultTitle(action, params),
    count: data.length,
    records,
    omittedCount: data.length - validCount,
    truncatedCount: validCount - records.length,
    matchingCriteria: crmMatchingCriteria(params)
  });
}

export function buildEvidenceReport(
  observations: readonly ToolObservation[],
  requiredSources: readonly string[] = []
): AgentEvidenceReport {
  let structuredResult: AgentCRMRecordsResult | undefined;
  const crmResolutionObservation = observations.find(({ tool, action, result }) =>
    tool === "crm" && action === "resolveContact" && result.success);
  const crmResolution = crmResolutionObservation?.result.success
    ? crmResolutionObservation.result.data as Record<string, unknown>
    : undefined;
  const crmEntity = crmResolution?.status === "RESOLVED" && crmResolution.entity && typeof crmResolution.entity === "object"
    ? crmResolution.entity as Record<string, unknown>
    : undefined;
  const resolvedEntityRef = crmEntity ? safeSourceRef("crm", "contact", crmEntity.crmRecordRef) : undefined;
  const crmRefsByEmail = new Map<string, Set<string>>();
  for (const observation of observations) {
    if (observation.tool !== "crm" || !CRM_READ_ACTIONS.has(observation.action) ||
        !observation.result.success || !Array.isArray(observation.result.data)) continue;
    for (const value of observation.result.data) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const record = value as Record<string, unknown>;
      const email = typeof record.email === "string" ? record.email.trim().toLocaleLowerCase("en-US") : "";
      const id = typeof record.id === "string" ? record.id : typeof record.recordId === "string" ? record.recordId : undefined;
      if (!email || !id) continue;
      const ref = safeSourceRef("crm", "contact", id);
      if (!ref) continue;
      const refs = crmRefsByEmail.get(email) ?? new Set<string>();
      refs.add(ref);
      crmRefsByEmail.set(email, refs);
    }
  }
  const entityRefForEmail = (params: Record<string, unknown>): string | undefined => {
    if (resolvedEntityRef) return resolvedEntityRef;
    const email = typeof params.leadEmail === "string" ? params.leadEmail.trim().toLocaleLowerCase("en-US") : "";
    const refs = crmRefsByEmail.get(email);
    return refs?.size === 1 ? [...refs][0] : undefined;
  };
  const facts: EvidenceItem[] = observations.map(({ tool, action, params, result }, index) => {
    const evidenceRef = `${tool}.${action}#${index + 1}`;
    const actionStatement = verifiedActionStatement(tool, action, result, params);
    if (actionStatement) return { evidenceRef, tool, action, statement: actionStatement, outcome: "RESULT_RETURNED" };
    if (!result.success) {
      const failedAction = tool === "tasks" ? "task action" : "action";
      return {
        evidenceRef,
        tool, action,
        statement: result.error.code === "VERIFICATION_FAILED"
          ? `${tool}.${action} could not be verified; no successful ${failedAction} was confirmed.`
          : `${tool}.${action} did not confirm success (${result.error.code}); no successful ${failedAction} was confirmed.`,
        outcome: "SUCCESS_NOT_CONFIRMED",
        resolutionStatus: sourceFailureStatus(result.error.code),
        error: { code: result.error.code, message: "The source request failed; no business result was confirmed." }
      };
    }
    if (tool === "crm" && CRM_READ_ACTIONS.has(action) && !Array.isArray(result.data)) {
      return {
        evidenceRef, tool, action,
        statement: "CRM did not return a valid record collection.",
        outcome: "SUCCESS_NOT_CONFIRMED"
      };
    }
    if (tool === "crm" && action === "resolveContact") {
      const resolution = result.data && typeof result.data === "object" && !Array.isArray(result.data)
        ? result.data as Record<string, unknown>
        : undefined;
      if (resolution?.status === "RESOLVED" && resolution.entity && typeof resolution.entity === "object") {
        const entity = resolution.entity as Record<string, unknown>;
        const name = normalizedField(entity.canonicalName, 200) ?? "CRM contact";
        const company = normalizedField(entity.company, 200);
        const matchedBy = normalizedField(entity.matchedBy, 80) ?? "CRM match";
        const confidence = typeof entity.confidence === "number" && Number.isFinite(entity.confidence) ? entity.confidence : 0;
        const recordRef = safeSourceRef("crm", "contact", entity.crmRecordRef) ?? `crm.contact#${index + 1}`;
        return {
          evidenceRef, tool, action,
          statement: `Resolved ${name}${company ? ` at ${company}` : ""} in CRM using ${matchedBy} (confidence ${confidence.toFixed(2)}).`,
          outcome: "RESULT_RETURNED",
          resolutionStatus: "RESOLVED",
          recordRefs: [recordRef],
          matchingCriteria: [matchedBy, `confidence ${confidence.toFixed(2)}`],
          sourceMatches: [{
            source: "crm", recordRef, resolvedEntityRef: recordRef, matchedBy, confidence,
            summary: `CRM identity resolved to ${name}${company ? ` at ${company}` : ""}.`,
            relevantFields: { name, ...(company ? { company } : {}) }
          }]
        };
      }
      if (resolution?.status === "AMBIGUOUS" && Array.isArray(resolution.candidates)) {
        const candidates = resolution.candidates.flatMap((candidate, candidateIndex) => {
          if (!candidate || typeof candidate !== "object") return [];
          const record = candidate as Record<string, unknown>;
          const canonicalName = normalizedField(record.canonicalName, 200);
          const company = normalizedField(record.company, 200);
          const recordRef = safeSourceRef("crm", "candidate", record.crmRecordRef) ?? `crm.candidate#${candidateIndex + 1}`;
          return [{
            recordRef,
            summary: `${canonicalName ?? "CRM contact"}${company ? ` at ${company}` : ""} is a possible match.`,
            ...(canonicalName || company ? {
              relevantFields: { ...(canonicalName ? { name: canonicalName } : {}), ...(company ? { company } : {}) }
            } : {})
          }];
        });
        return {
          evidenceRef, tool, action,
          statement: `CRM identity is ambiguous across ${resolution.candidates.length} candidate contact(s); no candidate was selected.${candidates.length ? ` Possible matches: ${candidates.map(({ summary }) => summary.replace(/ is a possible match\.$/, "")).join("; ")}.` : ""}`,
          outcome: "RESULT_RETURNED",
          resolutionStatus: "AMBIGUOUS",
          recordRefs: candidates.slice(0, 10).map(({ recordRef }) => recordRef),
          matchingCriteria: ["clarification required"],
          sourceMatches: candidates.slice(0, 10).map(({ recordRef, summary, relevantFields }) => ({
            source: "crm" as const, recordRef, matchedBy: "candidate_generation", confidence: 0.5, summary,
            ...(relevantFields ? { relevantFields } : {})
          }))
        };
      }
      if (resolution?.status === "NOT_FOUND") {
        return {
          evidenceRef, tool, action,
          statement: "No CRM contact matched the requested identity; no connected source was queried.",
          outcome: "EMPTY_RESULT",
          resolutionStatus: "NOT_FOUND",
          recordRefs: []
        };
      }
      return {
        evidenceRef, tool, action,
        statement: "CRM returned an invalid contact-resolution result.",
        outcome: "SUCCESS_NOT_CONFIRMED"
      };
    }
    if ((tool === "email" && (action === "getEmailHistory" || action === "getEmailContent")) ||
      (tool === "calendar" && action === "findEventsForLead")) {
      if (!Array.isArray(result.data)) {
        return { evidenceRef, tool, action, statement: `${tool} did not return a valid result collection.`, outcome: "SUCCESS_NOT_CONFIRMED" };
      }
      if (result.data.length === 0) {
        return {
          evidenceRef, tool, action,
          statement: tool === "email" && !resolvedEntityRef
            ? emptyResultStatement(tool, action, params)
            : tool === "email"
            ? "No matching Gmail messages were found for the CRM-resolved identity in the bounded search."
            : "No Calendar event with the CRM-resolved identity as an exact attendee was found in the bounded search window.",
          outcome: "EMPTY_RESULT",
          resolutionStatus: "NOT_FOUND",
          recordRefs: [],
          matchingCriteria: tool === "email" ? ["exact CRM-resolved email participant"] : ["exact attendee email", "bounded date window"]
        };
      }
      if (tool === "email") {
        const messages = result.data.filter((item) => item && typeof item === "object") as Array<Record<string, unknown>>;
        if (action === "getEmailContent") {
          return {
            evidenceRef, tool, action,
            statement: `Gmail returned ${messages.length} matching content result(s); message bodies are not copied into the evidence summary.`,
            outcome: "RESULT_RETURNED",
            resolutionStatus: "RESOLVED",
            recordRefs: messages.flatMap((message) => {
              const ref = safeSourceRef("gmail", "message", message.id);
              return ref ? [ref] : [];
            }),
            matchingCriteria: [typeof params.leadEmail === "string" ? "exact CRM-resolved email participant" : "requested Gmail query"],
            sourceMatches: messages.flatMap((message) => {
              const recordRef = safeSourceRef("gmail", "message", message.id);
              if (!recordRef) return [];
              const timestamp = typeof message.sentAt === "string" ? normalizedDate(message.sentAt) : undefined;
              return [{
                source: "gmail" as const, recordRef,
                ...(entityRefForEmail(params) ? { resolvedEntityRef: entityRefForEmail(params)! } : {}),
                matchedBy: typeof params.leadEmail === "string" ? "exact_contact_email" : "gmail_query",
                confidence: typeof params.leadEmail === "string" ? 1 : 0.75,
                ...(timestamp ? { timestamp } : {}),
                summary: "Metadata-only email content matched the requested identity and query."
              }];
            })
          };
        }
        const threadRefs = new Set<string>();
        for (const message of messages) if (typeof message.threadId === "string" && message.threadId) threadRefs.add(message.threadId);
        const exactReplyThreadCount = [...threadRefs].filter((threadId) => {
          const threadMessages = messages.filter((message) => message.threadId === threadId);
          const hasOutbound = threadMessages.some((message) => message.direction === "OUTBOUND");
          const hasExactInbound = threadMessages.some((message) => message.direction === "INBOUND" &&
            typeof message.senderEmail === "string" && typeof params.leadEmail === "string" &&
            message.senderEmail.toLocaleLowerCase("en-US") === params.leadEmail.toLocaleLowerCase("en-US"));
          return hasOutbound && hasExactInbound;
        }).length;
        return {
          evidenceRef, tool, action,
          statement: exactReplyThreadCount
            ? `Gmail returned ${messages.length} metadata-only message(s) in ${threadRefs.size} matching thread(s); ${exactReplyThreadCount} outbound conversation(s) received a reply from the exact CRM-resolved contact.`
            : `Gmail returned ${messages.length} metadata-only message(s) in ${threadRefs.size} matching thread(s), but no reply from the exact CRM-resolved contact was established.`,
          outcome: "RESULT_RETURNED",
          resolutionStatus: exactReplyThreadCount ? "RESOLVED" : "INSUFFICIENT_EVIDENCE",
          recordRefs: [...threadRefs].map((threadId) => safeSourceRef("gmail", "thread", threadId)!).filter(Boolean),
          matchingCriteria: ["exact CRM-resolved email participant", "reply attribution requires the same contact sender"],
          sourceMatches: [...threadRefs].flatMap((threadId) => {
            const recordRef = safeSourceRef("gmail", "thread", threadId);
            if (!recordRef) return [];
            const threadMessages = messages.filter((message) => message.threadId === threadId);
            const exactReply = threadMessages.some((message) => message.direction === "INBOUND" &&
              typeof message.senderEmail === "string" && typeof params.leadEmail === "string" &&
              message.senderEmail.toLocaleLowerCase("en-US") === params.leadEmail.toLocaleLowerCase("en-US"));
            const timestamps = threadMessages.flatMap((message) => normalizedDate(message.sentAt) ?? []);
            const latestTimestamp = timestamps.sort().at(-1);
            return [{
              source: "gmail" as const, recordRef, ...(entityRefForEmail(params) ? { resolvedEntityRef: entityRefForEmail(params)! } : {}),
              matchedBy: exactReply ? "exact_sender_email" : "exact_contact_participant",
              confidence: exactReply ? 1 : 0.99,
              ...(latestTimestamp ? { timestamp: latestTimestamp } : {}),
              summary: exactReply
                ? "A reply was received from the exact CRM-resolved contact."
                : "The thread matched the exact CRM contact; no reply from that contact was established.",
              relevantFields: { exactContactReply: exactReply }
            }];
          })
        };
      }
      const events = result.data.filter((item) => item && typeof item === "object") as Array<Record<string, unknown>>;
      return {
        evidenceRef, tool, action,
        statement: `Calendar returned ${events.length} event(s) after exact attendee-email matching and date-range filtering.`,
        outcome: "RESULT_RETURNED",
        resolutionStatus: "RESOLVED",
        recordRefs: events.flatMap((event, eventIndex) => {
          const ref = safeSourceRef("calendar", "event", event.id);
          return [ref ?? `calendar.event#${eventIndex + 1}`];
        }),
        matchingCriteria: ["exact attendee email", "bounded date window"],
        sourceMatches: events.flatMap((event) => {
          const recordRef = safeSourceRef("calendar", "event", event.id);
          if (!recordRef) return [];
          const timestamp = normalizedDate(event.startTime);
          return [{
            source: "calendar" as const, recordRef, ...(entityRefForEmail(params) ? { resolvedEntityRef: entityRefForEmail(params)! } : {}),
            matchedBy: "exact_attendee_email", confidence: 1,
            ...(timestamp ? { timestamp } : {}),
            summary: `Event matched the exact CRM-resolved attendee email within the bounded search window${timestamp ? ` at ${timestamp}` : ""}.`,
            ...(normalizedField(event.title, 160) ? { relevantFields: { title: normalizedField(event.title, 160)! } } : {})
          }];
        })
      };
    }
    if ((tool === "crm" && (action === "updateLead" || action === "addLeadNote")) ||
      (tool === "tasks" && (action === "createTask" || action === "completeTask")) ||
      (tool === "email" && (action === "draftEmail" || action === "sendEmail")) ||
      (tool === "calendar" && action === "createMeeting")) {
      return { evidenceRef, tool, action, statement: `The ${tool} mutation was not confirmed by its returned entity.`, outcome: "SUCCESS_NOT_CONFIRMED" };
    }
    if (Array.isArray(result.data) && result.data.length === 0) {
      const crmResult = tool === "crm" ? crmStructuredResult(action, params, result.data, evidenceRef) : undefined;
      if (crmResult) structuredResult ??= crmResult;
      return {
        evidenceRef, tool, action,
        statement: emptyResultStatement(tool, action, params),
        outcome: "EMPTY_RESULT",
        resolutionStatus: "NOT_FOUND",
        ...(crmResult ? { recordRefs: [], matchingCriteria: crmResult.matchingCriteria } : {})
      };
    }
    if (tool === "crm" && result.success && Array.isArray(result.data) && CRM_READ_ACTIONS.has(action)) {
      const crmResult = crmStructuredResult(action, params, result.data, evidenceRef);
      if (crmResult) structuredResult ??= crmResult;
      const recordRefs = crmResult?.records.map(({ recordRef }) => recordRef) ?? [];
      const omittedDetails = [
        ...(crmResult && crmResult.omittedCount > 0 ? [`${crmResult.omittedCount} malformed record(s) were not displayed.`] : []),
        ...(crmResult && crmResult.truncatedCount > 0 ? [`${crmResult.truncatedCount} additional record(s) were omitted at the display limit.`] : [])
      ];
      return {
        evidenceRef, tool, action,
        statement: crmResult && crmResult.omittedCount === crmResult.count
          ? `CRM returned ${crmResult.count} record(s), but none had valid displayable fields.`
          : `CRM returned ${crmResult?.count ?? result.data.length} record(s) matching the requested criteria.${omittedDetails.length ? ` ${omittedDetails.join(" ")}` : ""}`,
        outcome: "RESULT_RETURNED",
        recordRefs,
        matchingCriteria: crmResult?.matchingCriteria ?? [],
        sourceMatches: result.data.flatMap((value, recordIndex) => {
          if (!value || typeof value !== "object" || Array.isArray(value)) return [];
          const record = value as Record<string, unknown>;
          const id = typeof record.id === "string" ? record.id : typeof record.recordId === "string" ? record.recordId : undefined;
          if (!id) return [];
          const recordRef = safeSourceRef("crm", "contact", id);
          if (!recordRef) return [];
          const name = normalizedField(record.name, 200);
          const company = normalizedField(record.company, 200);
          const dealValue = typeof record.dealValue === "number" && Number.isFinite(record.dealValue) ? record.dealValue : undefined;
          const status = normalizedField(record.status, 100);
          const lastContactedAt = normalizedDate(record.lastContactedAt);
          const relevantFields = {
            ...(name ? { name } : {}),
            ...(company ? { company } : {}),
            ...(dealValue !== undefined ? { dealValue } : {}),
            ...(status ? { status } : {}),
            ...(lastContactedAt ? { lastContactedAt } : {})
          };
          const summary = [
            name ? `CRM contact ${name}` : "CRM contact",
            company ? `at ${company}` : "",
            dealValue !== undefined ? `with deal value ${dealValue}` : "",
            status ? `with status ${status}` : "",
            lastContactedAt ? `last contacted ${lastContactedAt}` : ""
          ].filter(Boolean).join(" ");
          return [{
            source: "crm" as const, recordRef, resolvedEntityRef: recordRef,
            matchedBy: "crm_query", confidence: 1,
            ...(lastContactedAt ? { timestamp: lastContactedAt } : {}),
            summary: summary || `CRM record ${recordIndex + 1} matched the query.`,
            ...(Object.keys(relevantFields).length ? { relevantFields } : {})
          }];
        })
      };
    }
    return {
      evidenceRef,
      tool, action,
      statement: "The business tool returned a result; consult its original action result for details.",
      outcome: "RESULT_RETURNED"
    };
  });

  let bundle = buildEvidenceBundle(facts, requiredSources);
  if (structuredResult && (structuredResult.omittedCount > 0 || structuredResult.truncatedCount > 0)) {
    bundle = EvidenceBundleSchema.parse({
      ...bundle,
      sufficiency: "INSUFFICIENT_EVIDENCE",
      limitations: [...bundle.limitations, "Some CRM records were omitted from the displayed result."]
    });
  }
  const evidenceInsufficient = bundle.sufficiency !== "SUPPORTED";
  const recommendationEvidence: EvidenceLinkedRecommendation[] = [];
  return {
    FACT: facts,
    INFERENCE: [
      ...(evidenceInsufficient
        ? ["Insufficient evidence to determine the requested result from the available retrieval."]
        : ["No inference was added beyond the returned business tool evidence."])
    ],
    RECOMMENDATION: recommendationEvidence.map(({ statement }) => statement),
    recommendationEvidence,
    evidenceInsufficient,
    bundle,
    ...(structuredResult ? { structuredResult } : {})
  };
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(",")}}`;
}

export function emptyToolCallKey(
  runId: string, orgId: string, tool: string, action: string, params: Record<string, unknown>
): string {
  return [runId, orgId, tool, action, canonicalize(params)].join("\u001f");
}

/** Suppresses only repeated successful empty queries; errors remain retryable. */
export class EmptyResultCallGuard {
  private readonly emptyResults = new Map<string, ToolResult>();

  async execute(key: string, actionId: string, invoke: () => Promise<ToolResponse>): Promise<ToolResponse> {
    const previous = this.emptyResults.get(key);
    if (previous) {
      return {
        success: false,
        error: { code: "DUPLICATE_EMPTY_QUERY", message: "An identical query already returned no results; the tool was not called again." },
        metadata: { executionTimeMs: 0, actionId, cached: true }
      };
    }
    const result = await invoke();
    if (result.success && Array.isArray(result.data) && result.data.length === 0) {
      this.emptyResults.set(key, structuredClone(result));
      if (this.emptyResults.size > 2_000) {
        const oldestKey = this.emptyResults.keys().next().value;
        if (oldestKey !== undefined) this.emptyResults.delete(oldestKey);
      }
    }
    return result;
  }
}
