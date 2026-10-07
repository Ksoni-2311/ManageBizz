export type RunStatus = "running" | "awaiting_approval" | "completed" | "failed";
const SESSION_TOKEN_KEY = "managebizz.session.token";
export type AuthenticatedUser = { id: string; name: string; email: string; role: string; workspaceId: string };
export type AuthSession = { token: string; user: AuthenticatedUser };
function sessionToken(): string | null { try { return sessionStorage.getItem(SESSION_TOKEN_KEY); } catch { return null; } }
export function getSessionToken(): string | null { return sessionToken(); }
function saveSession(session: AuthSession): void { sessionStorage.setItem(SESSION_TOKEN_KEY, session.token); }
export function clearSession(): void { try { sessionStorage.removeItem(SESSION_TOKEN_KEY); } catch { /* Storage may be disabled. */ } }

export type CRMCurrentStatus = {
  loaded: boolean;
  sourceName?: string;
  importedAt?: string;
  recordCount: number;
};

export type CRMPreviewRow = {
  rowNumber: number;
  issues: Array<{ field: string; reason: string }>;
};

export type CRMImportPreview = {
  status: "READY" | "REJECTED";
  previewId?: string;
  sourceName: string;
  totalRows: number;
  validRecordCount: number;
  invalidRows: CRMPreviewRow[];
  fileIssues: Array<{ field: string; reason: string }>;
  sample: Array<{
    id: string; name: string; email: string; company: string; dealValue: number;
    lastContactedAt: string | Date; status?: string; phone?: string; owner?: string; notes: string[];
  }>;
  sampleLimit: number;
  canImport: boolean;
  replacesExisting: boolean;
};

export type CalendarConnectionStatus = "connected" | "disconnected" | "reauthorization_required" | "access_denied" | "unavailable";
export type GmailConnectionStatus = "connected" | "disconnected" | "reauthorization_required" | "access_denied" | "unavailable";

export class ManageBizzApiError extends Error {
  constructor(message: string, readonly code?: string, readonly details?: unknown) { super(message); }
}

export function gmailStatusAfterApiError(code?: string): GmailConnectionStatus {
  if (code === "EMAIL_NOT_CONNECTED") return "disconnected";
  if (code === "EMAIL_AUTH_EXPIRED" || code === "EMAIL_AUTH_REQUIRED") return "reauthorization_required";
  if (code === "EMAIL_ACCESS_DENIED") return "access_denied";
  return "unavailable";
}

export function calendarStatusAfterApiError(code?: string): CalendarConnectionStatus {
  if (code === "CALENDAR_NOT_CONNECTED") return "disconnected";
  if (code === "CALENDAR_AUTH_EXPIRED" || code === "CALENDAR_AUTH_REQUIRED") return "reauthorization_required";
  if (code === "CALENDAR_ACCESS_DENIED") return "access_denied";
  return "unavailable";
}

export type TraceEvent = {
  eventId: string;
  runId: string;
  eventType: string;
  timestamp: string;
  toolName?: string;
  action?: string;
  resultStatus?: "SUCCESS" | "FAILED" | "PENDING";
  durationMs?: number;
  error?: { code: string; message: string };
  details?: unknown;
};

export type Trace = {
  runId: string;
  status: "RUNNING" | "COMPLETED" | "FAILED";
  startedAt: string;
  endedAt?: string;
  events: TraceEvent[];
};

export type EvidenceFact = {
  evidenceRef: string;
  tool: string;
  action: string;
  statement: string;
  outcome: "EMPTY_RESULT" | "RESULT_RETURNED" | "SUCCESS_NOT_CONFIRMED";
  error?: { code: string; message: string };
};

export type ActionProposal = {
  id: string;
  riskLevel: string;
  tool: string;
  action: string;
  params: Record<string, unknown>;
  lifecycle: string;
  approvalStatus: string;
  result?: { success: boolean; data?: unknown; error?: { code: string; message: string } };
  verification?: string;
};

export type AgentRun = {
  success?: boolean;
  runId: string;
  status: RunStatus;
  answer: string;
  response?: {
    summary: string;
    facts: EvidenceFact[];
    inferences: string[];
    recommendations: Array<{ statement: string; evidenceRefs: string[] }>;
    evidenceInsufficient: boolean;
  };
  plan?: { objective: string; factsRequired: string[]; steps: Array<{ tool: string; action: string; purpose: string; dependsOnCRMResults: boolean }> };
  evidence: { facts: EvidenceFact[]; inferences: string[]; evidenceInsufficient: boolean };
  recommendations: Array<{ statement: string; evidenceRefs: string[] }>;
  actions: ActionProposal[];
  trace: Trace;
  error?: { code: string; message: string };
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = sessionToken();
  const response = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init?.headers
    }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.success === false) {
    if (response.status === 401 && token && !path.startsWith("/api/auth/")) {
      clearSession();
      window.dispatchEvent(new Event("managebizz:session-expired"));
    }
    const message = typeof payload.error === "string" ? payload.error : payload.error?.message ?? `Request failed (${response.status}).`;
    throw new ManageBizzApiError(message, payload.error?.code, payload.error?.details);
  }
  return payload as T;
}

export async function restoreSession(): Promise<AuthenticatedUser | null> {
  try {
    // The API returns a fixed, server-owned development identity only when
    // MVP_MODE is explicitly enabled in NODE_ENV=development. Normal sessions
    // still require the stored signed token.
    const result = await request<{ user: AuthenticatedUser }>("/api/auth/me");
    return result.user;
  } catch (error) {
    if (!sessionToken() && error instanceof ManageBizzApiError && error.code === "AUTH_REQUIRED") return null;
    throw error;
  }
}
export async function authenticate(email: string, password: string, name?: string): Promise<AuthenticatedUser> {
  const path = name === undefined ? "/api/auth/login" : "/api/auth/register";
  const result = await request<AuthSession>(path, { method: "POST", body: JSON.stringify({ email, password, ...(name === undefined ? {} : { name }) }) });
  saveSession(result);
  return result.user;
}
export async function signOut(): Promise<void> {
  await request("/api/auth/logout", { method: "POST" });
}

export function getCRMStatus(): Promise<{ crm: CRMCurrentStatus }> {
  return request<{ crm: CRMCurrentStatus }>("/api/crm/current");
}

export function getGoogleCalendarStatus(): Promise<{ status: CalendarConnectionStatus }> {
  return request("/api/integrations/google-calendar/status");
}

export function getGoogleCalendarAuthorizationUrl(): Promise<{ authorizationUrl: string }> {
  return request("/api/integrations/google-calendar/connect");
}

export function disconnectGoogleCalendar(): Promise<{ status: "disconnected" }> {
  return request("/api/integrations/google-calendar", { method: "DELETE" });
}

export function getGmailStatus(): Promise<{ status: GmailConnectionStatus }> {
  return request("/api/integrations/gmail/status");
}
export function getGmailAuthorizationUrl(): Promise<{ authorizationUrl: string }> {
  return request("/api/integrations/gmail/connect");
}
export function disconnectGmail(): Promise<{ status: "disconnected" }> {
  return request("/api/integrations/gmail", { method: "DELETE" });
}

export async function previewCRMFile(file: File): Promise<CRMImportPreview> {
  const response = await fetch("/api/crm/imports/preview", {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-File-Name": file.name,
      "X-File-Type": file.type || (file.name.toLocaleLowerCase("en-US").endsWith(".csv") ? "text/csv" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
      ...(sessionToken() ? { Authorization: `Bearer ${sessionToken()}` } : {})
    },
    body: await file.arrayBuffer()
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.success === false) {
    if (response.status === 401 && sessionToken()) {
      clearSession();
      window.dispatchEvent(new Event("managebizz:session-expired"));
    }
    throw new ManageBizzApiError(payload.error?.message ?? `Upload preview failed (${response.status}).`, payload.error?.code, payload.error?.details);
  }
  return payload.preview as CRMImportPreview;
}

export function confirmCRMImport(previewId: string): Promise<{ imported: { sourceName: string; importedAt: string; recordCount: number } }> {
  return request("/api/crm/imports/confirm", {
    method: "POST",
    body: JSON.stringify({ previewId, confirm: true })
  });
}

export async function checkApi(): Promise<void> {
  await request<{ status: string }>("/health");
}

export function submitGoal(goal: string): Promise<AgentRun> {
  return request<AgentRun>("/api/agent/runs", {
    method: "POST",
    body: JSON.stringify({ goal })
  });
}

export function getRun(runId: string): Promise<AgentRun> {
  return request<AgentRun>(`/api/agent/runs/${encodeURIComponent(runId)}`);
}

export function decideAction(
  runId: string,
  proposalId: string,
  decision: "APPROVE" | "REJECT"
): Promise<AgentRun> {
  return request<AgentRun>(
    `/api/agent/runs/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(proposalId)}`,
    { method: "POST", body: JSON.stringify({ decision }) }
  );
}

export async function getRunTrace(runId: string): Promise<Trace> {
  const result = await request<{ trace: Trace }>(`/api/runs/${encodeURIComponent(runId)}/trace`);
  return result.trace;
}
