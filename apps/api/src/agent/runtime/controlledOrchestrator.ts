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
  downstream: { emailHistoryForCandidates: boolean; emailAction: "getEmailHistory" | "getUnansweredMessages"; calendarAvailabilityForCandidates: boolean; calendarParams: Record<string, unknown> };
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

function calendarParams(objective: string): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  const date = objective.match(/\b(\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?)\b/)?.[1];
  if (date) params.date = date.includes("T") ? date : `${date}T00:00:00.000Z`;
  const duration = objective.match(/\b(\d+)\s*(?:minutes?|mins?)\b/i)?.[1];
  if (duration) params.durationMinutes = Number(duration);
  return params;
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

/** A small deterministic planner: one root query, then only evidence-gated follow-up queries. */
export function planBusinessGoal(parsed: ParsedGoal): InvestigationPlan {
  const objective = parsed.objective.trim();
  const lower = objective.toLocaleLowerCase("en-US");
  const taskAction = requestedTaskAction(objective);
  const intentLower = taskAction
    ? lower.replace(/\b(?:create|add)\s+(?:a\s+)?task\s+(?:titled|called)\s+["'][^"']+["']/i, "")
      .replace(/\b(?:create|add)\s+(?:a\s+)?task\s*:\s*["']?[^"'\r\n.]+["']?/i, "")
    : lower;
  const mentionsLeads = matches(lower, /\b(lead|leads|prospect|prospects)\b/);
  const highValueRequested = matches(lower, /\bhigh[- ]?value\b/) || parseRequestedMinimumDealValue(objective) !== undefined;
  const wantsInactiveLeads = mentionsLeads && highValueRequested && matches(lower, /\b(inactive|stale|dormant)\b/);
  const wantsActiveLeads = mentionsLeads && highValueRequested && matches(lower, /\bactive\b/);
  const hasUnsupportedUpperBound = highValueRequested && /\b(below|under|less than|at most|maximum)\b|<=|≤/i.test(lower);
  const wantsLeadInvestigation = !hasUnsupportedUpperBound && (wantsInactiveLeads || wantsActiveLeads);
  const wantsEmail = matches(intentLower, /\b(email|emails|communication|repl(?:y|ied|ies)|response|outreach|follow[- ]?up|re-engage|reengage|unanswered messages?)\b/);
  const emailAction: InvestigationPlan["downstream"]["emailAction"] = matches(intentLower, /\b(unanswered|unreplied)\b/) ? "getUnansweredMessages" : "getEmailHistory";
  const wantsCalendar = matches(intentLower, /\b(calendar|availability|schedule|scheduling|meeting|time slots?)\b/);
  const wantsTasks = matches(intentLower, /\b(open tasks?|list tasks?|show tasks?)\b/);
  const metric = metricCall(intentLower, parsed.timeWindowDays);
  const minDealValue = parseRequestedMinimumDealValue(objective) ?? DEFAULT_MIN_DEAL_VALUE;
  const requestedCalendarParams = calendarParams(objective);
  const factsRequired: string[] = [];
  const toolMappings: InvestigationPlan["toolMappings"] = [];
  const initialCalls: PlannedToolCall[] = [];

  if (wantsLeadInvestigation) {
    const action = wantsActiveLeads && !wantsInactiveLeads ? "listActiveHighValueLeads" : "listInactiveLeads";
    const fact = action === "listInactiveLeads" ? "Matching inactive high-value CRM leads" : "Matching active high-value CRM leads";
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

  if (metric && !wantsLeadInvestigation) {
    factsRequired.push("Requested business metrics");
    toolMappings.push({ fact: "Requested business metrics", tool: "analytics", action: metric.action });
    initialCalls.push(metric);
  }

  const address = intentLower.match(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/)?.[0];
  if (!wantsLeadInvestigation && wantsEmail) {
    const fact = address ? "Email messages for the explicitly identified address" : "Email messages matching the requested criteria";
    factsRequired.push(fact);
    toolMappings.push({ fact, tool: "email", action: emailAction });
    initialCalls.push({ tool: "email", action: emailAction, params: address ? { leadEmail: address } : {}, purpose: "Retrieve only messages matching the requested email criteria." });
  }

  if (!wantsLeadInvestigation && wantsCalendar) {
    const upcoming = matches(lower, /\b(upcoming|future)\b/);
    const action = upcoming ? "listUpcomingEvents" : "getAvailability";
    const fact = upcoming ? "Upcoming calendar events" : "Calendar availability matching the requested duration or date";
    factsRequired.push(fact);
    toolMappings.push({ fact, tool: "calendar", action });
    initialCalls.push({ tool: "calendar", action, params: upcoming ? {} : requestedCalendarParams, purpose: upcoming
      ? "List stored calendar events that are upcoming according to the calendar service clock."
      : "Check calendar availability because the user requested scheduling information." });
  }

  const downstream = {
    emailHistoryForCandidates: wantsLeadInvestigation && wantsEmail,
    emailAction,
    calendarAvailabilityForCandidates: wantsLeadInvestigation && wantsCalendar,
    calendarParams: requestedCalendarParams
  };
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
  const crmObservation = observations.find(({ tool, action }) => tool === "crm" && (action === "listInactiveLeads" || action === "listActiveHighValueLeads"));
  if (crmObservation?.result.success && Array.isArray(crmObservation.result.data) && crmObservation.result.data.length === 0) {
    const evidenceRef = `crm.${crmObservation.action}#${observations.indexOf(crmObservation) + 1}`;
    if (crmObservation.action === "listInactiveLeads") {
      return [
        `FACT: No inactive high-value leads were found [evidence: ${evidenceRef}].`,
        "INFERENCE: No lead-specific follow-up need can be inferred from an empty CRM result. Insufficient evidence to determine whether any follow-up is due.",
        "RECOMMENDATION: No lead-specific follow-up action is supported by the available evidence."
      ].join("\n");
    }
    return [
      `FACT: No active high-value leads were found [evidence: ${evidenceRef}].`,
      "INFERENCE: No lead-specific conclusion can be drawn from an empty CRM result. Insufficient evidence to determine whether any action is needed.",
      "RECOMMENDATION: No lead-specific action is supported by the available evidence."
    ].join("\n");
  }

  const lines: string[] = [];
  for (const [index, observation] of observations.entries()) {
    const evidenceRef = `${observation.tool}.${observation.action}#${index + 1}`;
    if (observation.tool === "tasks" && (observation.action === "createTask" || observation.action === "completeTask")) {
      const result = observation.result;
      const confirmedStatement = verifiedActionStatement(observation.tool, observation.action, result);
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
    } else {
      const count = Array.isArray(observation.result.data) ? ` ${observation.result.data.length} matching record(s)` : " matching data";
      lines.push(`FACT: ${observation.tool}.${observation.action} returned${count} [evidence: ${evidenceRef}].`);
      if (observation.tool === "crm" && observation.action === "listInactiveLeads" && Array.isArray(observation.result.data)) {
        lines.push("INFERENCE: The returned records match the CRM query's inactive high-value criteria.");
        lines.push("RECOMMENDATION: Review these matching leads to decide whether follow-up is appropriate [evidence: " + evidenceRef + "].");
      }
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

function isLeadRecord(value: unknown): value is { email: string } {
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

      if (call.tool === "crm" && (call.action === "listInactiveLeads" || call.action === "listActiveHighValueLeads")) {
        if (!Array.isArray(result.data)) {
          stopError = `${call.tool}.${call.action} returned an invalid record collection`;
          break;
        }
        if (result.data.length === 0) break;

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

        if (plan.downstream.calendarAvailabilityForCandidates) {
          const calendarCall: PlannedToolCall = {
            tool: "calendar", action: "getAvailability", params: { ...plan.downstream.calendarParams, attendeeEmails: uniqueEmails },
            purpose: "Check availability only after CRM returned candidates and the user requested scheduling information."
          };
          const calendarResult = await callTool(calendarCall);
          if (!calendarResult.success) { stopError = `calendar.getAvailability returned ${calendarResult.error.code}`; break; }
        }
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
