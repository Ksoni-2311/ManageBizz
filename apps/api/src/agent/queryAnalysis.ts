import { AgentPlan, AgentPlanDetails, AgentPlanDetailsSchema, AgentPlanSchema } from "@nexusops/shared-types";

const sourceNames = ["crm", "gmail", "calendar", "analytics", "tasks"] as const;

export function deterministicQueryAnalysis(prompt: string, timezone?: string): AgentPlan {
  const text = prompt.trim();
  const lower = text.toLocaleLowerCase("en-US");
  const entities = extractEntities(text);
  const dateRange = extractDateRange(text, timezone);
  const sources = new Set<AgentPlanDetails["sources"][number]>();
  const filters: AgentPlanDetails["filters"] = [];
  let intent: AgentPlanDetails["intent"] = "unknown";
  let requestedFacts: string[] = [];
  let confidence = 0.45;
  let decisionSummary = "The request does not match a supported deterministic query pattern.";

  const explicitTaskAction = /\b(?:create|add)\s+(?:a\s+)?task\s+(?:titled|called)\b|\bcomplete\s+task\s+(?:with\s+id\s+)?task-[\w:.-]+/i.test(text);
  const explicitEmailAction = /^\s*(?:please\s+)?(?:draft email to|send (?:the )?email draft)\b/i.test(text);
  const explicitCalendarAction = /^\s*(?:please\s+)?create calendar event titled\b/i.test(text);

  if (explicitTaskAction || explicitEmailAction || explicitCalendarAction) {
    intent = "task_action";
    sources.add(explicitEmailAction ? "gmail" : explicitCalendarAction ? "calendar" : "tasks");
    requestedFacts = ["the explicitly requested action result"];
    confidence = 0.95;
    decisionSummary = "The request contains a complete explicit action already supported by the approval workflow.";
  } else if (/\b(lead|leads|client|clients|prospect|prospects)\b/i.test(text) &&
      /\b(reply|replied|respond|responded|response|answered)\b/i.test(text)) {
    intent = "email_reply_check";
    sources.add("crm");
    sources.add("gmail");
    requestedFacts = ["CRM contact identities in the requested client group", "whether matching CRM contacts have replied in Gmail"];
    confidence = 0.82;
    decisionSummary = "The request asks about replies across CRM clients, so Gmail lookup is dependent on CRM-returned contact identities.";
  } else if (/\b(reply|replied|respond|responded|response|answered)\b/i.test(text) &&
      /\b(meeting|meetings|calendar|event|events)\b/i.test(text) &&
      /\b(email|mail|proposal|message|reply|replied|respond|responded|response|answered)\b/i.test(text)) {
    intent = "cross_source_contact_status";
    sources.add("crm");
    sources.add("gmail");
    sources.add("calendar");
    requestedFacts = ["the resolved CRM identity", "whether a reply from that contact exists", "the relevant communication", "calendar events with that contact in the requested time range"];
    confidence = 0.9;
    decisionSummary = "The request needs one CRM identity to verify both Gmail reply attribution and Calendar attendee identity.";
  } else if ((/\b(context|history)\b/i.test(text) && /\b(crm|gmail|email)\b/i.test(text) ||
      /\bwhat happened\b/i.test(text)) && entities.some(({ type }) => type !== "email")) {
    intent = "cross_source_contact_status";
    sources.add("crm");
    sources.add("gmail");
    requestedFacts = ["the resolved CRM identity", "relevant Gmail context for that identity"];
    confidence = 0.84;
    decisionSummary = "The request asks for a named contact's business context, so CRM identity is resolved before related Gmail retrieval.";
  } else if (/\b(reply|replied|respond|responded|response|answered)\b/i.test(text) &&
      /\b(email|mail|proposal|message|reply|replied|respond|responded|response|answered)\b/i.test(text)) {
    intent = "email_reply_check";
    sources.add("crm");
    sources.add("gmail");
    requestedFacts = ["whether a reply exists", "the relevant communication", "the latest matching communication"];
    confidence = 0.82;
    decisionSummary = "The request asks whether a person or company replied and requires CRM identity context plus Gmail.";
  } else if (/\b(what did .+ say|what .+ say about|mention(?:ed)?|message content|email content|deadline)\b/i.test(text)) {
    intent = "email_content_question";
    sources.add("gmail");
    requestedFacts = ["the relevant message content", "the requested information stated in that message"];
    if (entities.length) {
      sources.add("crm");
      requestedFacts.unshift("the CRM identity of the message participant");
      decisionSummary = "Resolve the named message participant against CRM before retrieving matching Gmail content.";
    } else {
      decisionSummary = "The request asks for information contained in email content.";
    }
    confidence = 0.8;
  } else if (/\b(leads?|clients?|prospects?)\b/i.test(text) && /\b(no|without|haven't|have not|zero)\b/i.test(text) &&
      /\b(email|mail|interaction|communication)\b/i.test(text)) {
    intent = "crm_lead_search";
    sources.add("crm");
    sources.add("gmail");
    requestedFacts = ["CRM lead records matching the stated criteria", "Gmail interaction evidence for each returned CRM contact"];
    confidence = 0.8;
    decisionSummary = "The request asks for CRM leads and requires checking email interaction using each CRM identity.";
  } else if (/\b(emails?|gmail|mailbox|messages?)\b/i.test(text)) {
    intent = "email_search";
    sources.add("gmail");
    requestedFacts = ["email messages matching the stated sender, terms, and date constraints"];
    if (entities.length) {
      sources.add("crm");
      requestedFacts.unshift("the CRM identity for the named sender");
      decisionSummary = "The named sender should be resolved against CRM before Gmail is searched.";
    }
    confidence = 0.78;
    if (!entities.some(({ type }) => type !== "email")) decisionSummary = "The request asks to find email messages.";
  } else if (/\b(deal value|deal amount|value of .+ deal)\b/i.test(text)) {
    intent = "crm_deal_value";
    sources.add("crm");
    requestedFacts = ["the matching CRM record's deal value"];
    confidence = 0.8;
    decisionSummary = "The request asks for a deal value stored in CRM.";
  } else if (/\b(available|availability|free|open time|time slots?)\b/i.test(text) &&
      /\b(calendar|meeting|meetings|schedule|tomorrow|today|week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(text)) {
    intent = "calendar_availability";
    sources.add("calendar");
    requestedFacts = ["busy periods in the requested time range", "available time within that range"];
    confidence = 0.78;
    decisionSummary = "The request asks about calendar availability.";
  } else if (/\b(meeting|meetings|calendar|event|events)\b/i.test(text)) {
    intent = "calendar_event_search";
    sources.add("calendar");
    requestedFacts = ["calendar events in the requested time range"];
    if (/\b(client|clients|lead|leads|prospect|prospects)\b/i.test(text)) {
      sources.add("crm");
      requestedFacts.push("CRM identities relevant to the requested clients");
      decisionSummary = "The request asks for meetings associated with CRM clients.";
    } else if (entities.length) {
      sources.add("crm");
      requestedFacts.push("the CRM identity of the named attendee");
      decisionSummary = "The named attendee should be resolved against CRM before Calendar attendee matching.";
    } else {
      decisionSummary = "The request asks for calendar events.";
    }
    confidence = 0.78;
  } else if (/\b(lead|leads|prospect|prospects|client|clients)\b/i.test(text)) {
    intent = "crm_lead_search";
    sources.add("crm");
    requestedFacts = ["CRM lead records matching the stated criteria"];
    confidence = 0.76;
    decisionSummary = "The request asks for CRM lead or client records.";
  } else if (/\b(sales|revenue|mrr|arr|conversion|win rate|analytics|metrics|performance)\b/i.test(text)) {
    intent = "analytics_query";
    sources.add("analytics");
    requestedFacts = ["the requested business metrics"];
    confidence = 0.7;
    decisionSummary = "The request asks for business metrics.";
  } else if (/\b(tasks?|to-?dos?)\b/i.test(text)) {
    intent = /\b(create|add|complete|finish)\b/i.test(text) ? "task_action" : "task_query";
    sources.add("tasks");
    requestedFacts = [intent === "task_action" ? "the explicitly requested task action result" : "tasks matching the request"];
    confidence = 0.72;
    decisionSummary = "The request asks about tasks.";
  }

  if (/\bhigh[- ]?value\b/i.test(text)) {
    filters.push({ field: "highValue", operator: "equals", value: true });
  }
  const lastContact = text.match(/\b(?:haven't|have not|not)\s+been\s+contacted\b|\b(?:last|past)\s+\d+\s+(?:days?|weeks?|months?)\b/i);
  if (lastContact && intent === "crm_lead_search") {
    filters.push({ field: "lastContactedAt", operator: "after", value: dateRange?.expression ?? lastContact[0] });
    if (dateRange) requestedFacts.push("last-contact date within the requested time range");
  }
  const minimum = text.match(/\b(?:at least|minimum(?: deal value)?(?: of)?)\s*[$₹]?\s*([\d,]+(?:\.\d+)?)\s*(k|m|million|lakh|lakhs)?\b/i);
  if (minimum) {
    const amount = Number(minimum[1]!.replaceAll(",", ""));
    const multiplier = /^(k)$/i.test(minimum[2] ?? "") ? 1_000
      : /^(m|million)$/i.test(minimum[2] ?? "") ? 1_000_000
        : /^(lakh|lakhs)$/i.test(minimum[2] ?? "") ? 100_000 : 1;
    const value = amount * multiplier;
    if (Number.isFinite(value)) filters.push({ field: "dealValue", operator: "greater_than_or_equal", value });
  }

  const dependencies: AgentPlanDetails["dependencies"] = [];
  if (sources.has("crm") && sources.has("gmail")) dependencies.push({ source: "gmail", dependsOn: "crm" });
  if (sources.has("crm") && sources.has("calendar")) dependencies.push({ source: "calendar", dependsOn: "crm" });
  const ambiguity: AgentPlanDetails["ambiguity"] = { type: "none", details: "", candidates: [] };

  const limitMatch = text.match(/\b(?:top|first|latest)\s+(\d{1,2})\b/i);
  const sort = /\b(?:sort|order)\s+by\s+(date|name|deal value|value)\b/i.test(text)
    ? { field: text.match(/\b(?:sort|order)\s+by\s+(date|name|deal value|value)\b/i)![1]!.toLocaleLowerCase("en-US"), direction: /\b(desc|descending|newest|latest)\b/i.test(text) ? "descending" as const : "ascending" as const }
    : /\b(oldest|earliest|latest|most recent|newest)\s+first\b/i.test(text)
      ? { field: "date", direction: /\b(oldest|earliest)\s+first\b/i.test(text) ? "ascending" as const : "descending" as const }
      : undefined;
  const details = AgentPlanDetailsSchema.parse({
    intent,
    entities,
    requestedFacts,
    sources: sourceNames.filter((source) => sources.has(source)),
    ...(dateRange ? { dateRange } : {}),
    filters,
    ...(sort ? { sort } : {}),
    ...(limitMatch ? { limit: Math.min(Number(limitMatch[1]), 100) } : {}),
    dependencies,
    ambiguity,
    confidence,
    decisionSummary
  });
  return AgentPlanSchema.parse({ ...details, planningMethod: "deterministic_fallback", fallbackReason: "llm_not_configured" });
}

export function withPlanningFallbackReason(plan: AgentPlan, reason: "llm_unavailable" | "invalid_llm_output"): AgentPlan {
  return AgentPlanSchema.parse({ ...plan, planningMethod: "deterministic_fallback", fallbackReason: reason });
}

export function validateAgentPlanDetails(value: unknown): AgentPlanDetails | undefined {
  const parsed = AgentPlanDetailsSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function extractEntities(text: string): AgentPlanDetails["entities"] {
  const entities: AgentPlanDetails["entities"] = [];
  const email = text.match(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/)?.[0];
  if (email) entities.push({ type: "email", value: email });
  const phone = !email ? text.match(/(?<!\w)\+?\d[\d ()-]{6,}\d(?!\w)/)?.[0]?.trim() : undefined;
  if (phone && phone.replace(/\D/g, "").length >= 7) entities.push({ type: "phone", value: phone });

  const companyFromDeal = text.match(/\b([A-Z][\w&.-]*(?:\s+[A-Z][\w&.-]*){0,4})['’]s\s+(?:deal|value)\b/)?.[1];
  const companyWithSuffix = text.match(/\b([A-Z][\w&.-]*(?:\s+[A-Z][\w&.-]*){0,3}\s+(?:Technologies|Technology|Solutions|Systems|Corporation|Company|Inc\.?|LLC|Ltd\.?|Limited|Group))\b/)?.[1];
  const acronymCompany = text.match(/\b([A-Z]{2,})\s+(?:respond|responded|replied|reply|deal value)\b/)?.[1];
  const companyInPersonPhrase = text.match(/\bwith\s+[A-Z][a-z]+\s+from\s+([A-Z][\w&.-]*(?:\s+[A-Z][\w&.-]*){0,3})\b/)?.[1];
  const company = companyWithSuffix ?? companyInPersonPhrase ?? acronymCompany ??
    (companyFromDeal && (/^[A-Z]{2,}$/.test(companyFromDeal) || /\b(Technologies|Technology|Solutions|Systems|Corporation|Company|Inc\.?|LLC|Ltd\.?|Limited|Group)\b/i.test(companyFromDeal)) ? companyFromDeal : undefined);
  if (company && !email) entities.push({ type: "company", value: company.trim() });

  if (!email) {
    const person = (company ? undefined : companyFromDeal)
      ?? text.match(/\b(?:did|has|have|from|about|for)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\s+(?:(?:reply|replied|respond|responded|email|emails|message|messages)\b)/i)?.[1]
      ?? text.match(/\b(?:email|emails|message|messages)\s+from\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/)?.[1]
      ?? text.match(/\bwhat did\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\s+(?:say|mention|write|send)\b/i)?.[1]
      ?? text.match(/\b(?:meeting|meetings|event|events)\s+with\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/)?.[1]
      ?? text.match(/\b(?:context|history|deal value|CRM)\s+(?:for|with|of)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/)?.[1]
      ?? text.match(/\b(?:with|from)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})(?:\s+from\s+[A-Z][\w&.-]+)?\b/)?.[1]
      ?? text.match(/\b(?:find|show|tell me about)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\s+(?:in|from)\s+(?:my\s+)?CRM\b/i)?.[1];
    if (person && !/^(my|the|our|your|their)$/i.test(person) &&
      (!company || person.trim().toLocaleLowerCase("en-US") !== company.trim().toLocaleLowerCase("en-US"))) {
      entities.push({ type: "person", value: person.trim() });
    }
  }
  return entities;
}

function extractDateRange(text: string, timezone?: string): AgentPlanDetails["dateRange"] {
  const namedDate = parseNamedDate(text);
  if (namedDate) {
    const validTimezone = timezone && isValidTimezone(timezone) ? timezone : undefined;
    return { type: "absolute", expression: namedDate.expression, start: namedDate.isoDate, ...(validTimezone ? { timezone: validTimezone } : {}) };
  }
  const expressions = [
    /\b(?:last|past)\s+\d+\s+(?:days?|weeks?|months?)\b/i,
    /\b(?:today|tomorrow|yesterday|this week|next week)\b/i,
    /\b(?:before|by|after|on)\s+(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/i,
    /\b\d{4}-\d{2}-\d{2}\b/
  ];
  const expression = expressions.map((pattern) => text.match(pattern)?.[0]).find(Boolean);
  if (!expression) return undefined;
  const iso = expression.match(/^\d{4}-\d{2}-\d{2}$/) !== null;
  const validTimezone = timezone && isValidTimezone(timezone) ? timezone : undefined;
  return {
    type: iso ? "absolute" : "relative",
    expression,
    ...(iso ? { start: expression } : {}),
    ...(validTimezone ? { timezone: validTimezone } : {})
  };
}

function parseNamedDate(text: string): { expression: string; isoDate: string } | undefined {
  const match = text.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.?\s+(\d{1,2}),?\s+(\d{4})\b/i)
    ?? text.match(/\b(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.?\s+(\d{4})\b/i);
  if (!match) return undefined;
  const monthNames = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const monthText = (match[1]!.match(/^\d/) ? match[2]! : match[1]!).toLocaleLowerCase("en-US").replace(/\.$/, "").slice(0, 3);
  const month = monthNames.indexOf(monthText) + 1;
  const dateValue = Number(match[1]!.match(/^\d/) ? match[1] : match[2]);
  const year = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, dateValue));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== dateValue) return undefined;
  return { expression: match[0], isoDate: `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${dateValue.toString().padStart(2, "0")}` };
}

function isValidTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
