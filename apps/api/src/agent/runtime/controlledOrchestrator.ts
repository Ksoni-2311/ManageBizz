import { ParsedGoal, ToolExecutionContext, ToolResponse } from "@nexusops/shared-types";
import { emptyToolCallKey, ToolObservation, verifiedActionStatement } from "../policies/dataIntegrity.js";
import { DEFAULT_MIN_DEAL_VALUE } from "../../tools/crmDomain.js";

export type BusinessToolName = "crm" | "email" | "calendar" | "tasks" | "analytics";
export type PlannedToolCall = {
  tool: BusinessToolName;
  action: string;
  params: Record<string, unknown>;
  purpose: string;
};

export type InvestigationPlan = {
  objective: string;
  factsRequired: string[];
  toolMappings: Array<{ fact: string; tool: BusinessToolName; action: string }>;
  initialCalls: PlannedToolCall[];
  /** Read-only calls that require CRM candidates; executed serially only after CRM returns them. */
  dependentCalls?: PlannedToolCall[];
  downstream: { emailHistoryForCandidates: boolean; emailAction: "getEmailHistory" | "getUnansweredMessages"; calendarAvailabilityForCandidates: boolean; calendarParams: Record<string, unknown>; sendFollowUpForCandidates: boolean; createFollowUpTasksForCandidates: boolean };
  finalEvidence: string[];
};

export type ToolCallExecutor = (call: PlannedToolCall, context: ToolExecutionContext) => Promise<ToolResponse>;

export type ControlledRunResult = {
  status: "completed" | "failed";
  plan: InvestigationPlan;
  observations: ToolObservation[];
  finalText: string;
  error?: string;
};

function matches(text: string, expression: RegExp): boolean {
  return expression.test(text);
}

export function parseRequestedMinimumDealValue(objective: string): number | undefined {
  // An upper bound cannot be translated into the CRM's minimum-value filter.
  if (/\b(below|under|less than|at most|maximum)\b|<=|≤/i.test(objective)) return undefined;
  const amount = objective.match(/(?:\bat least\b|\bminimum(?: deal value)?(?: of)?\b|>=|≥)\s*[$₹]?\s*(\d[\d,]*(?:\.\d+)?)\s*(k|m|million|lakh|lakhs)?\b/i)
    ?? objective.match(/[$₹]\s*(\d[\d,]*(?:\.\d+)?)\s*(k|m|million|lakh|lakhs)?\b/i);
  if (!amount) return undefined;
  const numeric = Number(amount[1]!.replaceAll(",", ""));
  const suffix = amount[2]?.toLocaleLowerCase("en-US");
  const multiplier = suffix === "k" ? 1_000 : suffix === "m" || suffix === "million" ? 1_000_000 : suffix === "lakh" || suffix === "lakhs" ? 100_000 : 1;
  const result = numeric * multiplier;
  return Number.isFinite(result) && result >= 0 ? result : undefined;
}

function calendarParams(objective: string, now = new Date()): Record<string, unknown> {
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const explicitDate = objective.match(/\b(\d{4}-\d{2}-\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/)?.[1];
  let start: Date | undefined;
  let days = 1;
  if (explicitDate) start = new Date(`${explicitDate}T00:00:00.000Z`);
  else if (/\btomorrow\b/i.test(objective)) {
    start = new Date(day); start.setUTCDate(start.getUTCDate() + 1);
  } else if (/\btoday\b/i.test(objective)) start = day;
  else if (/\bthis week\b/i.test(objective)) {
    start = day;
    days = 7;
  }
  const weekday = objective.match(/\b(?:before|by|on)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i)?.[1]?.toLocaleLowerCase("en-US");
  if (!start && weekday) {
    const weekdayIndex = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"].indexOf(weekday);
    const offset = (weekdayIndex - day.getUTCDay() + 7) % 7 || 7;
    start = day;
    days = offset + (/\b(before|by)\b/i.test(objective) ? 0 : 1);
  }
  if (!start) {
    start = now;
    days = 7;
  }
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + days);
  const params: Record<string, unknown> = { from: start.toISOString(), until: end.toISOString() };
  const duration = objective.match(/\b(\d+)\s*(?:minutes?|mins?)\b/i)?.[1];
  if (duration) params.durationMinutes = Number(duration);
  const searchTerm = objective.match(/\b(?:with|about|titled)\s+([a-z0-9][a-z0-9 .'-]{1,60})/i)?.[1]?.trim().split(/\s+(?:before|after|tomorrow|today|this|next|on|for)\b/i)[0]?.trim();
  if (searchTerm && !/^(my|the|a|an|calendar)$/i.test(searchTerm)) params.queryTerm = searchTerm;
  return params;
}

function gmailQuery(objective: string): string {
  const range = objective.match(/\b(?:last|past)\s+(\d+)\s+(day|days|week|weeks|month|months)\b/i);
  const recent = /\b(recent|latest|new|last|past)\b/i.test(objective);
  const rangeQuery = range
    ? `newer_than:${Number(range[1]) * (range[2]!.toLowerCase().startsWith("week") ? 7 : range[2]!.toLowerCase().startsWith("month") ? 30 : 1)}d`
    : recent || /\b(unanswered|unreplied|haven.t received a reply)\b/i.test(objective) ? "newer_than:30d" : "";
  const keywords = [...new Set((objective.match(/[a-z0-9]{4,}/gi) ?? [])
    .map((word) => word.toLocaleLowerCase("en-US"))
    .filter((word) => !new Set(["find", "show", "recent", "latest", "email", "emails", "mail", "messages", "message", "from", "with", "that", "have", "received", "receive", "reply", "replies", "client", "clients", "about", "what", "did", "say", "said", "tell", "told", "when", "check", "please", "my", "the", "for", "has", "been", "their", "haven", "they", "who", "were", "was", "are", "is", "not"]).has(word)))];
  return [rangeQuery, ...keywords.slice(0, 5)].filter(Boolean).join(" ");
}

function metricCall(goal: string, days: number): PlannedToolCall | undefined {
  if (matches(goal, /\b(conversion|win rate)\b/i)) return { tool: "analytics", action: "getConversionMetrics", params: { timeWindowDays: days }, purpose: "Retrieve the requested conversion metrics." };
  if (matches(goal, /\b(sales|revenue|mrr|arr)\b/i)) return { tool: "analytics", action: "getSalesMetrics", params: { timeWindowDays: days }, purpose: "Retrieve the requested sales metrics." };
  if (matches(goal, /\b(activity|emails sent|meetings held|tasks completed)\b/i)) return { tool: "analytics", action: "getActivityMetrics", params: { timeWindowDays: days }, purpose: "Retrieve the requested activity metrics." };
  if (matches(goal, /\b(analytics|metrics|performance)\b/i)) return { tool: "analytics", action: "getLeadMetrics", params: { timeWindowDays: days }, purpose: "Retrieve the requested lead metrics." };
  return undefined;
}

function requestedTaskAction(objective: string): PlannedToolCall | undefined {
  const create = objective.match(/\b(?:create|add)\s+(?:a\s+)?task\s+(?:titled|called)\s+["']([^"']+)["']/i)
    ?? objective.match(/\b(?:create|add)\s+(?:a\s+)?task\s*:\s*["']?([^"'\r\n.]+)["']?/i);
  if (create?.[1]?.trim()) {
    return {
      tool: "tasks", action: "createTask", params: { title: create[1].trim() },
      purpose: "Create a task with the title explicitly supplied by the user, then verify the returned task."
    };
  }
  const complete = objective.match(/\bcomplete\s+task\s+(?:with\s+id\s+)?(task-[\w:.-]+)/i);
  if (complete?.[1]) {
    return {
      tool: "tasks", action: "completeTask", params: { taskId: complete[1] },
      purpose: "Complete only the task ID explicitly supplied by the user, then verify its returned completed status."
    };
  }
  return undefined;
}

/** Direct external writes require an explicit, complete imperative from the user. */
function requestedDirectAction(objective: string): PlannedToolCall | undefined {
  const draft = objective.match(/^\s*(?:please\s+)?draft email to\s+(\S+)\s+subject\s+"([^"\r\n]+)"\s+body\s+"([\s\S]+)"\s*$/i);
  if (draft) return { tool: "email", action: "draftEmail", params: { to: draft[1], subject: draft[2], body: draft[3] }, purpose: "Create exactly the email draft explicitly supplied by the user; wait for approval and verify Gmail's returned draft." };
  const send = objective.match(/^\s*(?:please\s+)?send (?:the )?email draft\s+([A-Za-z0-9._:-]+)\s*$/i);
  if (send) return { tool: "email", action: "sendEmail", params: { draftId: send[1] }, purpose: "Send only the identified existing Gmail draft after approval, then verify the sent message." };
  const event = objective.match(/^\s*(?:please\s+)?create calendar event titled\s+"([^"\r\n]+)"\s+from\s+(\d{4}-\d{2}-\d{2}T[^\s]+)\s+to\s+(\d{4}-\d{2}-\d{2}T[^\s]+)(?:\s+attendees?\s+(.+))?\s*$/i);
  if (event) return { tool: "calendar", action: "createMeeting", params: {
    title: event[1], startTime: event[2], endTime: event[3],
    attendees: event[4] ? event[4].split(/[;,\s]+/).filter(Boolean) : []
  }, purpose: "Create exactly the calendar event requested by the user after approval, then verify Google's returned event." };
  return undefined;
}

/** A small deterministic planner: one root query, then only evidence-gated follow-up queries. */
export function planBusinessGoal(parsed: ParsedGoal): InvestigationPlan {
  const objective = parsed.objective.trim();
  const lower = objective.toLocaleLowerCase("en-US");
  const directAction = requestedDirectAction(objective);
  const taskAction = directAction ? undefined : requestedTaskAction(objective);
  const intentLower = directAction ? "" : taskAction
    ? lower.replace(/\b(?:create|add)\s+(?:a\s+)?task\s+(?:titled|called)\s+["'][^"']+["']/i, "")
      .replace(/\b(?:create|add)\s+(?:a\s+)?task\s*:\s*["']?[^"'\r\n.]+["']?/i, "")
    : lower;
  const mentionsLeads = matches(intentLower, /\b(lead|leads|prospect|prospects)\b/) ||
    matches(intentLower, /\b(attention|follow[- ]?up)\b/);
  const highValueRequested = matches(intentLower, /\bhigh[- ]?value\b/) || parseRequestedMinimumDealValue(objective) !== undefined ||
    (mentionsLeads && matches(intentLower, /\b(attention|follow[- ]?up|stale|dormant)\b/));
  // For the MVP, "needs attention" means a high-value lead whose last contact
  // is older than the requested/default recency window. Pipeline status remains
  // a separate definition used only by the active query.
  const wantsInactiveLeads = mentionsLeads && highValueRequested && matches(lower, /\b(inactive|stale|dormant|attention|follow[- ]?up)\b/);
  const wantsActiveLeads = mentionsLeads && highValueRequested && matches(lower, /\bactive\b/);
  const hasUnsupportedUpperBound = highValueRequested && /\b(below|under|less than|at most|maximum)\b|<=|≤/i.test(lower);
  const wantsHighValueLeads = mentionsLeads && highValueRequested;
  const wantsLeadInvestigation = !hasUnsupportedUpperBound && wantsHighValueLeads;
  const createFollowUpTasksForCandidates = wantsLeadInvestigation && !taskAction &&
    matches(objective, /\b(?:create|add)\b[\s\S]{0,50}\b(?:tasks?)\b/i) &&
    matches(objective, /\b(follow[- ]?up|these leads|those leads|them)\b/i);
  const wantsEmail = !createFollowUpTasksForCandidates && matches(intentLower, /\b(email|emails|gmail|mailbox|communication|repl(?:y|ied|ies)|response|outreach|follow[- ]?up|re-engage|reengage|unanswered messages?|deadline|what did .+ say|mention(?:ed)?)\b/);
  const sendFollowUpForCandidates = wantsInactiveLeads && matches(objective, /^\s*(?:please\s+)?(?:follow[- ]?up with|send follow[- ]?up(?: emails?)? to|email all)\b/i);
  const emailAction: InvestigationPlan["downstream"]["emailAction"] = matches(intentLower, /\b(unanswered|unreplied)\b|haven.t received a reply|no reply\b/) ? "getUnansweredMessages" : "getEmailHistory";
  const wantsCalendar = matches(intentLower, /\b(calendar|availability|schedule|scheduling|meeting|meetings|event|events|time slots?|tomorrow|today)\b/);
  const wantsTasks = matches(intentLower, /\b(open tasks?|list tasks?|show tasks?)\b/);
  const metric = metricCall(intentLower, parsed.timeWindowDays);
  const minDealValue = parseRequestedMinimumDealValue(objective) ?? DEFAULT_MIN_DEAL_VALUE;
  const requestedCalendarParams = calendarParams(objective);
  const factsRequired: string[] = [];
  const toolMappings: InvestigationPlan["toolMappings"] = [];
  const initialCalls: PlannedToolCall[] = [];

  if (wantsLeadInvestigation) {
    const action = wantsInactiveLeads ? "listInactiveLeads" : wantsActiveLeads ? "listActiveHighValueLeads" : "searchLeads";
    const fact = action === "listInactiveLeads" ? "Matching inactive high-value CRM leads" : action === "listActiveHighValueLeads" ? "Matching active high-value CRM leads" : "Matching high-value CRM leads";
    factsRequired.push(fact);
    toolMappings.push({ fact, tool: "crm", action });
    initialCalls.push({
      tool: "crm", action,
      params: action === "listInactiveLeads"
        ? { minDaysInactive: parsed.timeWindowDays, minDealValue }
        : { minDealValue },
      purpose: "Establish the matching CRM records before investigating any related source."
    });
  }

  if (wantsTasks && !wantsLeadInvestigation) {
    const fact = "Open operational tasks";
    factsRequired.push(fact);
    toolMappings.push({ fact, tool: "tasks", action: "listOpenTasks" });
    initialCalls.push({ tool: "tasks", action: "listOpenTasks", params: {}, purpose: "Retrieve open tasks requested by the user." });
  }

  if (taskAction) {
    const fact = taskAction.action === "createTask" ? "Task creation result" : "Task completion result";
    factsRequired.push(fact);
    toolMappings.push({ fact, tool: "tasks", action: taskAction.action });
    initialCalls.push(taskAction);
  }

  if (directAction) {
    const fact = `${directAction.action} result`;
    factsRequired.push(fact);
    toolMappings.push({ fact, tool: directAction.tool, action: directAction.action });
    initialCalls.push(directAction);
  }

  if (metric && !wantsLeadInvestigation) {
    factsRequired.push("Requested business metrics");
    toolMappings.push({ fact: "Requested business metrics", tool: "analytics", action: metric.action });
    initialCalls.push(metric);
  }

  const address = intentLower.match(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/)?.[0];
  if (!wantsLeadInvestigation && wantsEmail) {
    const requestsMessageBody = matches(intentLower, /\b(what did .+ say|what .+ say about|content|body|said about|mention(?:ed)?|deadline|what does .+ email say)\b/);
    const action = requestsMessageBody ? "getEmailContent" : emailAction;
    const query = gmailQuery(objective);
    const fact = address ? "Email messages for the explicitly identified address" : "Email messages matching the requested criteria";
    factsRequired.push(fact);
    toolMappings.push({ fact, tool: "email", action });
    initialCalls.push({ tool: "email", action, params: requestsMessageBody ? { ...(address ? { leadEmail: address } : {}), query, limit: 5 } : { ...(address ? { leadEmail: address } : {}), query }, purpose: "Retrieve only Gmail messages matching the user's requested terms and time range." });
  }

  if (!wantsLeadInvestigation && wantsCalendar) {
    const availability = matches(lower, /\b(free|available|availability|time slots?)\b/);
    const action = availability ? "getAvailability" : "listUpcomingEvents";
    const fact = availability ? "Calendar busy periods matching the requested range" : "Calendar events matching the requested range";
    factsRequired.push(fact);
    toolMappings.push({ fact, tool: "calendar", action });
    initialCalls.push({ tool: "calendar", action, params: requestedCalendarParams, purpose: availability
      ? "Retrieve only busy time ranges for the date range needed to answer the user's calendar availability question."
      : "Retrieve only calendar events within the date range needed to answer the user's question." });
  }

  const downstream = {
    emailHistoryForCandidates: wantsLeadInvestigation && wantsEmail,
    emailAction,
    calendarAvailabilityForCandidates: wantsLeadInvestigation && wantsCalendar,
    calendarParams: requestedCalendarParams,
    sendFollowUpForCandidates,
    createFollowUpTasksForCandidates
  };
  if (downstream.createFollowUpTasksForCandidates) {
    factsRequired.push("Verified task records for CRM-matched leads");
    toolMappings.push({ fact: "Verified task records for CRM-matched leads", tool: "tasks", action: "createTask" });
  }
  if (downstream.emailHistoryForCandidates) {
    factsRequired.push("Email history for CRM-matched candidates");
    toolMappings.push({ fact: "Email history for CRM-matched candidates", tool: "email", action: "getEmailHistory" });
  }
  if (downstream.calendarAvailabilityForCandidates) {
    factsRequired.push("Calendar availability relevant to CRM-matched candidates");
    toolMappings.push({ fact: "Calendar availability relevant to CRM-matched candidates", tool: "calendar", action: "getAvailability" });
  }

  return {
    objective,
    factsRequired,
    toolMappings,
    initialCalls,
    downstream,
    finalEvidence: factsRequired.length ? factsRequired : ["Whether a configured business tool can answer the user's objective"]
  };
}

function finalText(plan: InvestigationPlan, observations: readonly ToolObservation[], error?: string): string {
  const crmObservation = observations.find(({ tool, action }) => tool === "crm" && ["listInactiveLeads", "listActiveHighValueLeads", "searchLeads"].includes(action));
  if (crmObservation?.result.success && Array.isArray(crmObservation.result.data) && crmObservation.result.data.length === 0 && observations.length === 1) {
    const evidenceRef = `crm.${crmObservation.action}#${observations.indexOf(crmObservation) + 1}`;
    if (plan.downstream.createFollowUpTasksForCandidates) {
      return `FACT: No matching leads were found [evidence: ${evidenceRef}].\nRECOMMENDATION: No matching leads were found, so there are no follow-up actions to create.`;
    }
    if (crmObservation.action === "listInactiveLeads") {
      return [
        `FACT: No inactive high-value leads were found [evidence: ${evidenceRef}].`,
        "INFERENCE: No lead-specific follow-up need can be inferred from an empty CRM result. Insufficient evidence to determine whether any follow-up is due.",
        "RECOMMENDATION: No lead-specific follow-up action is supported by the available evidence."
      ].join("\n");
    }
    return [
      `FACT: ${crmObservation.action === "searchLeads" ? "No matching records were found" : "No active high-value leads were found"} [evidence: ${evidenceRef}].`,
      "INFERENCE: No lead-specific conclusion can be drawn from an empty CRM result. Insufficient evidence to determine whether any action is needed.",
      "RECOMMENDATION: No lead-specific action is supported by the available evidence."
    ].join("\n");
  }

  const lines: string[] = [];
  for (const [index, observation] of observations.entries()) {
    const evidenceRef = `${observation.tool}.${observation.action}#${index + 1}`;
    const isWrite = (observation.tool === "email" && (observation.action === "draftEmail" || observation.action === "sendEmail")) ||
      (observation.tool === "calendar" && observation.action === "createMeeting");
    if (isWrite) {
      const statement = verifiedActionStatement(observation.tool, observation.action, observation.result, observation.params);
      if (statement) lines.push(`FACT: ${statement} [evidence: ${evidenceRef}]`);
      else if (!observation.result.success && observation.result.error.code === "APPROVAL_REJECTED") lines.push(`FACT: The proposed ${observation.tool}.${observation.action} action was rejected; it was not executed [evidence: ${evidenceRef}].`);
      else if (!observation.result.success && observation.result.error.code === "VERIFICATION_FAILED") lines.push(`FACT: ${observation.tool}.${observation.action} execution could not be verified; no success claim is made [evidence: ${evidenceRef}].`);
      else if (!observation.result.success) lines.push(`FACT: ${observation.tool}.${observation.action} failed (${observation.result.error.code}); no successful action was confirmed [evidence: ${evidenceRef}].`);
      else lines.push(`FACT: ${observation.tool}.${observation.action} returned success without verifiable action details; the action is not confirmed [evidence: ${evidenceRef}].`);
      continue;
    }
    if (observation.tool === "tasks" && (observation.action === "createTask" || observation.action === "completeTask")) {
      const result = observation.result;
      const confirmedStatement = verifiedActionStatement(observation.tool, observation.action, result, observation.params);
      if (confirmedStatement) {
        lines.push(`FACT: ${confirmedStatement} [evidence: ${evidenceRef}].`);
      } else if (!result.success) {
        if (result.error.code === "APPROVAL_REJECTED") {
          lines.push(`FACT: The proposed ${observation.action} was rejected; no task action was executed [evidence: ${evidenceRef}].`);
        } else if (result.error.code === "VERIFICATION_FAILED") {
          lines.push(`FACT: The task tool result could not be verified; no success claim is made [evidence: ${evidenceRef}].`);
        } else {
          lines.push(`FACT: ${observation.action} failed (${result.error.code}); no successful task action was confirmed [evidence: ${evidenceRef}].`);
        }
      } else {
        lines.push(`FACT: The task tool returned success without a verifiable ${observation.action === "createTask" ? "created task" : "completed task"}; the action is not confirmed [evidence: ${evidenceRef}].`);
      }
      continue;
    }
    if (!observation.result.success) {
      lines.push(`FACT: ${observation.tool}.${observation.action} did not confirm success (${observation.result.error.code}) [evidence: ${evidenceRef}].`);
    } else if (Array.isArray(observation.result.data) && observation.result.data.length === 0) {
      if (observation.tool === "email" && observation.action === "getUnansweredMessages") lines.push(`FACT: No unanswered email messages were found [evidence: ${evidenceRef}].`);
      else if (observation.tool === "email") lines.push(`FACT: No email history was found for the requested CRM-matched candidates [evidence: ${evidenceRef}].`);
      else if (observation.tool === "calendar") lines.push(`FACT: No matching calendar availability was found [evidence: ${evidenceRef}].`);
      else if (observation.tool === "tasks") lines.push(`FACT: No matching open tasks were found [evidence: ${evidenceRef}].`);
      else if (observation.tool === "analytics") lines.push(`FACT: No matching metrics were returned [evidence: ${evidenceRef}].`);
      else lines.push(`FACT: No matching records were found [evidence: ${evidenceRef}].`);
    } else if (observation.tool === "crm" && Array.isArray(observation.result.data) && observation.result.success) {
      const records = observation.result.data;
      const crmAction = observation.action === "listInactiveLeads" ? "inactive high-value" : observation.action === "listActiveHighValueLeads" ? "active high-value" : "high-value";
      lines.push(`FACT: CRM returned ${records.length} matching ${crmAction} lead(s) [evidence: ${evidenceRef}].`);
      for (const record of records) {
        if (!record || typeof record !== "object") continue;
        const lead = record as Record<string, unknown>;
        const details = [
          typeof lead.name === "string" ? lead.name : undefined,
          typeof lead.company === "string" ? `company ${lead.company}` : undefined,
          typeof lead.dealValue === "number" ? `deal value ${lead.dealValue}` : undefined,
          typeof lead.status === "string" ? `pipeline status ${lead.status}` : undefined,
          lead.lastContactedAt instanceof Date ? `last contacted ${lead.lastContactedAt.toISOString()}` : undefined
        ].filter(Boolean);
        if (details.length) lines.push(`FACT: ${details.join("; ")} [evidence: ${evidenceRef}].`);
      }
      if (observation.action === "listInactiveLeads") {
        lines.push(`INFERENCE: These leads meet the CRM's high-value and contact-recency criteria; recency alone does not establish email response status [evidence: ${evidenceRef}].`);
        lines.push(`RECOMMENDATION: Review these matching leads to decide whether follow-up is appropriate [evidence: ${evidenceRef}].`);
      } else if (matches(plan.objective, /\b(attention|follow[- ]?up|why)\b/i)) {
        lines.push("INFERENCE: High deal value alone is insufficient to establish that a lead needs follow-up.");
        lines.push("RECOMMENDATION: Review pipeline status and communication recency before prioritizing follow-up.");
      }
    } else {
      const count = Array.isArray(observation.result.data) ? ` ${observation.result.data.length} matching record(s)` : " matching data";
      lines.push(`FACT: ${observation.tool}.${observation.action} returned${count} [evidence: ${evidenceRef}].`);
    }
  }

  if (observations.some(({ tool, action, result }) => tool === "email" && (action === "getEmailHistory" || action === "getUnansweredMessages") && result.success && Array.isArray(result.data) && result.data.length === 0)) {
    lines.push("INFERENCE: Insufficient evidence to determine whether follow-up is due because no email history was returned.");
  }
  if (error) lines.push(`FACT: Investigation stopped because ${error}`);
  if (observations.length === 0) {
    lines.push(/\b(below|under|less than|at most|maximum)\b|<=|≤/i.test(plan.objective)
      ? "FACT: The requested deal-value upper bound cannot be answered by the configured minimum-value CRM filter."
      : plan.initialCalls.length === 0
      ? "FACT: No configured business tool was selected for this objective."
      : "FACT: No business tool result is available.");
  }
  if (!observations.some(({ tool, action, result }) => tool === "crm" && action === "listInactiveLeads" && result.success && Array.isArray(result.data) && result.data.length > 0)) {
    lines.push("INFERENCE: Available evidence is insufficient for further supported conclusions.");
    lines.push("RECOMMENDATION: No unsupported action is recommended.");
  }
  return lines.join("\n");
}

function isLeadRecord(value: unknown): value is { email: string; name?: string } {
  return typeof value === "object" && value !== null && "email" in value &&
    typeof (value as { email?: unknown }).email === "string" && (value as { email: string }).email.includes("@");
}

export class RunToolCallTracker {
  private readonly seen = new Set<string>();

  claim(runId: string, orgId: string, call: PlannedToolCall): boolean {
    const key = emptyToolCallKey(runId, orgId, call.tool, call.action, call.params);
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }
}

export class ControlledAgentOrchestrator {
  constructor(private readonly executeTool: ToolCallExecutor) {}

  async run(
    parsedGoal: ParsedGoal,
    context: Omit<ToolExecutionContext, "actionId">,
    plan: InvestigationPlan = planBusinessGoal(parsedGoal)
  ): Promise<ControlledRunResult> {
    const observations: ToolObservation[] = [];
    const tracker = new RunToolCallTracker();
    let callIndex = 0;
    let stopError: string | undefined;

    const callTool = async (call: PlannedToolCall): Promise<ToolResponse> => {
      if (!tracker.claim(context.runId, context.orgId, call)) {
        stopError = "an identical tool call was already made in this run";
        return { success: false, error: { code: "DUPLICATE_TOOL_CALL_BLOCKED", message: "An identical tool call was blocked." } };
      }
      const callContext: ToolExecutionContext = { ...context, actionId: `${context.runId}:investigation:${++callIndex}` };
      let result: ToolResponse;
      try {
        result = await this.executeTool(call, callContext);
      } catch (error) {
        result = {
          success: false,
          error: { code: "TOOL_EXECUTION_ERROR", message: error instanceof Error ? error.message : "Tool execution failed." },
          metadata: { executionTimeMs: 0, actionId: callContext.actionId }
        };
      }
      observations.push({ tool: call.tool, action: call.action, params: call.params, result });
      return result;
    };

    for (const call of plan.initialCalls) {
      const result = await callTool(call);
      if (!result.success) {
        stopError = `${call.tool}.${call.action} returned ${result.error.code}`;
        break;
      }

      if (call.tool === "crm" && ["listInactiveLeads", "listActiveHighValueLeads", "searchLeads"].includes(call.action)) {
        if (!Array.isArray(result.data)) {
          stopError = `${call.tool}.${call.action} returned an invalid record collection`;
          break;
        }
        // An empty CRM result blocks candidate-dependent lookups, but does not
        // cancel other independent requests the user explicitly made.
        if (result.data.length === 0) continue;

        if (plan.downstream.createFollowUpTasksForCandidates) {
          const leads = result.data.filter((value): value is { id: string; name: string } =>
            typeof value === "object" && value !== null &&
            typeof (value as { id?: unknown }).id === "string" && !!(value as { id: string }).id.trim() &&
            typeof (value as { name?: unknown }).name === "string" && !!(value as { name: string }).name.trim()
          );
          for (const lead of leads) {
            const task = await callTool({
              tool: "tasks", action: "createTask",
              params: { title: `Follow up with ${lead.name.trim()}`, leadId: lead.id, priority: "MEDIUM" },
              purpose: "Propose a follow-up task only for this lead returned by CRM; approval is required before task creation and the task tool must verify persistence."
            });
            if (!task.success) { stopError = `tasks.createTask returned ${task.error.code}`; break; }
          }
          if (stopError) break;
        }

        const candidateEmails = result.data.filter(isLeadRecord).map((lead) => lead.email);
        const uniqueEmails = [...new Set(candidateEmails.map((email) => email.toLocaleLowerCase("en-US")))];
        if ((plan.downstream.emailHistoryForCandidates || plan.downstream.calendarAvailabilityForCandidates) && uniqueEmails.length === 0) {
          stopError = "CRM candidates did not contain valid email addresses required for the requested follow-up investigation";
          break;
        }

        if (plan.downstream.emailHistoryForCandidates) {
          const emailCall: PlannedToolCall = {
            tool: "email", action: plan.downstream.emailAction, params: { leadEmails: uniqueEmails },
            purpose: "Inspect email history only for lead emails returned by the CRM query."
          };
          const emailResult = await callTool(emailCall);
          if (!emailResult.success) { stopError = `email.getEmailHistory returned ${emailResult.error.code}`; break; }
        }

        if (plan.downstream.sendFollowUpForCandidates) {
          const candidateByEmail = new Map<string, { email: string; name: string }>();
          for (const value of result.data) {
            if (isLeadRecord(value) && typeof value.name === "string" && value.name.trim()) candidateByEmail.set(value.email.toLowerCase(), { email: value.email, name: value.name.trim() });
          }
          const candidates = [...candidateByEmail.values()];
          for (const lead of candidates) {
            const draft = await callTool({
              tool: "email", action: "draftEmail",
              params: {
                to: lead.email,
                subject: "Following up",
                body: `Hi ${lead.name.trim()},\n\nI'm following up to see whether you'd like to discuss next steps.`
              },
              purpose: "Prepare neutral follow-up wording using only the lead name and address returned by CRM. The user asked for follow-up; approval is still required before any external action."
            });
            if (!draft.success) { stopError = `email.draftEmail returned ${draft.error.code}`; break; }
            const draftId = typeof draft.data === "object" && draft.data !== null && "draftId" in draft.data && typeof (draft.data as { draftId?: unknown }).draftId === "string"
              ? (draft.data as { draftId: string }).draftId : undefined;
            if (!draftId) { stopError = "email.draftEmail returned no verifiable Gmail draft ID"; break; }
            const sent = await callTool({
              tool: "email", action: "sendEmail", params: { draftId },
              purpose: "Send the approved Gmail draft for a CRM-matched lead, then verify Gmail's sent-message result."
            });
            if (!sent.success) { stopError = `email.sendEmail returned ${sent.error.code}`; break; }
          }
          if (stopError) break;
        }

        if (plan.downstream.calendarAvailabilityForCandidates) {
          const calendarCall: PlannedToolCall = {
            tool: "calendar", action: "getAvailability", params: plan.downstream.calendarParams,
            purpose: "Check availability only after CRM returned candidates and the user requested scheduling information."
          };
          const calendarResult = await callTool(calendarCall);
          if (!calendarResult.success) { stopError = `calendar.getAvailability returned ${calendarResult.error.code}`; break; }
        }

        for (const dependentCall of plan.dependentCalls ?? []) {
          let dependentParams = { ...dependentCall.params };
          if (dependentCall.tool === "email" && ["getEmailHistory", "getUnansweredMessages"].includes(dependentCall.action)) {
            dependentParams = { ...dependentParams, leadEmails: uniqueEmails };
          } else if (dependentCall.tool === "calendar" && dependentCall.action === "findEventsForLead") {
            for (const leadEmail of uniqueEmails) {
              const result = await callTool({ ...dependentCall, params: { ...dependentParams, leadEmail } });
              if (!result.success) { stopError = `calendar.findEventsForLead returned ${result.error.code}`; break; }
            }
            if (stopError) break;
            continue;
          }
          const dependentResult = await callTool({ ...dependentCall, params: dependentParams });
          if (!dependentResult.success) { stopError = `${dependentCall.tool}.${dependentCall.action} returned ${dependentResult.error.code}`; break; }
        }
        if (stopError) break;
      }
    }

    if (plan.initialCalls.length === 0 && !stopError) stopError = "no configured business tool matched the objective";
    const status = stopError ? "failed" : "completed";
    return {
      status,
      plan,
      observations,
      finalText: finalText(plan, observations, stopError),
      ...(stopError ? { error: stopError } : {})
    };
  }
}
