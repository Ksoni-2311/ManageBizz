import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  Activity, AlertCircle, ArrowDownRight, ArrowUpRight, Check,
  CalendarDays, ChevronRight, CircleHelp, Clock3, Database, ExternalLink, FileSpreadsheet, LoaderCircle, Play, RefreshCw, Mail,
  ShieldCheck, Sparkles, X, LogOut
} from "lucide-react";
import type {
  ActionProposal, AgentRun, CalendarConnectionStatus, CRMCurrentStatus, CRMImportPreview, TraceEvent, GmailConnectionStatus, AuthenticatedUser
} from "./services/manageBizzClient.js";
import { authenticate, calendarStatusAfterApiError, checkApi, clearSession, confirmCRMImport, decideAction, disconnectGoogleCalendar, getCRMStatus, getGoogleCalendarAuthorizationUrl, getGoogleCalendarStatus, getRun, getRunTrace, gmailStatusAfterApiError, ManageBizzApiError, previewCRMFile, restoreSession, signOut, submitGoal, disconnectGmail, getGmailAuthorizationUrl, getGmailStatus } from "./services/manageBizzClient.js";
import { disconnectSocket } from "./services/api.js";

const suggestions = [
  "Find inactive high-value leads from the last 30 days.",
  "Show upcoming calendar events.",
  "Create task titled \"Review next steps\"."
];

function formatStatus(status: string): string {
  return status.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function StatusPill({ status }: { status: string }) {
  const tone = status === "completed" || status === "COMPLETED" || status === "VERIFIED" || status === "SUCCESS"
    ? "pill-success"
    : status === "failed" || status === "FAILED" || status === "REJECTED" || status === "VERIFICATION_FAILED"
      ? "pill-danger"
      : status === "awaiting_approval" || status === "PROPOSED" || status === "PENDING"
        ? "pill-waiting"
        : "pill-neutral";
  return <span className={`status-pill ${tone}`}>{formatStatus(status)}</span>;
}

function eventLabel(event: TraceEvent): string {
  if (event.toolName) return `${event.toolName}${event.action ? ` · ${event.action}` : ""}`;
  return formatStatus(event.eventType);
}

function eventDetail(event: TraceEvent): string | undefined {
  if (event.error) return `${event.error.code}: ${event.error.message}`;
  if (event.eventType === "PLAN_CREATED") return "Investigation plan prepared.";
  if (event.eventType.startsWith("ACTION_")) return `Action ${event.eventType.replace("ACTION_", "").toLowerCase().replace(/_/g, " ")}.`;
  if (event.eventType === "AGENT_COMPLETED") return "Run completed.";
  if (event.eventType === "AGENT_FAILED") return "Run failed.";
  return undefined;
}

function isEmptyEvidence(fact: AgentRun["evidence"]["facts"][number]): boolean {
  return fact.outcome === "EMPTY_RESULT";
}

function ActionCard({
  action,
  relatedDraft,
  busy,
  onDecision
}: {
  action: ActionProposal;
  relatedDraft?: { to?: string; subject?: string; body?: string };
  busy: boolean;
  onDecision: (action: ActionProposal, decision: "APPROVE" | "REJECT") => void;
}) {
  const pending = action.lifecycle === "PROPOSED" && action.approvalStatus === "PENDING";
  const payload = action.result?.success ? action.result.data : undefined;
  const task = typeof payload === "object" && payload !== null && "task" in payload
    ? (payload as { task?: { id?: string; title?: string; status?: string } }).task
    : undefined;

  return (
    <article className="action-card">
      <div className="action-card-heading">
        <div>
          <p className="eyebrow">{action.tool} · {action.action}</p>
          <h3>{action.action === "createTask" && typeof action.params.title === "string" ? action.params.title : "Proposed action"}</h3>
        </div>
        <StatusPill status={action.lifecycle} />
      </div>
      <StatusPill status={`RISK_${action.riskLevel ?? "UNKNOWN"}`} />
      {action.action === "createTask" && typeof action.params.title === "string" && <p className="muted">Task title: {action.params.title}</p>}
      {action.action === "draftEmail" && <div className="action-preview"><strong>To:</strong> {String(action.params.to ?? "Unavailable")}<br /><strong>Subject:</strong> {String(action.params.subject ?? "Unavailable")}<pre>{String(action.params.body ?? "No draft body supplied.")}</pre></div>}
      {action.action === "sendEmail" && <div className="action-preview"><strong>Draft to send:</strong> {relatedDraft?.to ?? "Recipient unavailable"}<br /><strong>Subject:</strong> {relatedDraft?.subject ?? "Subject unavailable"}<p>{relatedDraft?.body ?? `Draft ID: ${String(action.params.draftId ?? "Unavailable")}`}</p><small>Gmail will send this existing draft only after approval.</small></div>}
      {action.action === "createMeeting" && <div className="action-preview"><strong>Event:</strong> {String(action.params.title ?? "Unavailable")}<br /><strong>Start:</strong> {String(action.params.startTime ?? "Unavailable")}<br /><strong>End:</strong> {String(action.params.endTime ?? "Unavailable")}<br /><strong>Attendees:</strong> {Array.isArray(action.params.attendees) && action.params.attendees.length ? action.params.attendees.join(", ") : "None"}</div>}
      {task?.id && <p className="muted">Task ID: <code>{task.id}</code>{task.status ? ` · ${task.status}` : ""}</p>}
      {action.result && !action.result.success && <div className="inline-error"><AlertCircle size={15} />{action.result.error?.message ?? "Action failed."}</div>}
      {pending && <div className="button-row action-buttons">
        <button className="button button-secondary" disabled={busy} onClick={() => onDecision(action, "REJECT")}><X size={16} /> Reject</button>
        <button className="button button-primary" disabled={busy} onClick={() => onDecision(action, "APPROVE")}><Check size={16} /> Approve &amp; execute</button>
      </div>}
      {action.lifecycle === "PROPOSED" && <p className="hint">No mutation will run until you approve this proposal.</p>}
    </article>
  );
}

export default function App() {
  const [authChecked, setAuthChecked] = useState(false);
  const [authUser, setAuthUser] = useState<AuthenticatedUser | null>(null);
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [authName, setAuthName] = useState("");
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [goal, setGoal] = useState("");
  const [run, setRun] = useState<AgentRun | null>(null);
  const [apiState, setApiState] = useState<"checking" | "available" | "unavailable">("checking");
  const [submitting, setSubmitting] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [refreshingTrace, setRefreshingTrace] = useState(false);
  const [crmStatus, setCRMStatus] = useState<CRMCurrentStatus | null>(null);
  const [calendarStatus, setCalendarStatus] = useState<CalendarConnectionStatus>("disconnected");
  const [calendarBusy, setCalendarBusy] = useState(false);
  const [calendarError, setCalendarError] = useState<string | null>(null);
  const [gmailStatus, setGmailStatus] = useState<GmailConnectionStatus>("disconnected");
  const [gmailBusy, setGmailBusy] = useState(false);
  const [gmailError, setGmailError] = useState<string | null>(null);
  const [crmPreview, setCRMPreview] = useState<CRMImportPreview | null>(null);
  const [crmBusy, setCRMBusy] = useState(false);
  const [crmError, setCRMError] = useState<string | null>(null);
  const [crmErrorDetails, setCRMErrorDetails] = useState<Array<{ field: string; reason: string }> | null>(null);
  const [showAllInvalidRows, setShowAllInvalidRows] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onExpired = () => { disconnectSocket(); setAuthUser(null); setAuthError("Your session expired. Please sign in again."); };
    window.addEventListener("managebizz:session-expired", onExpired);
    void restoreSession().then(setAuthUser).catch((error) => {
      clearSession();
      setAuthError(error instanceof Error ? error.message : "Your session could not be restored. Sign in again.");
    }).finally(() => setAuthChecked(true));
    return () => window.removeEventListener("managebizz:session-expired", onExpired);
  }, []);

  const refreshApi = useCallback(async () => {
    try {
      await checkApi();
      setApiState("available");
    } catch {
      setApiState("unavailable");
    }
  }, []);

  useEffect(() => {
    void refreshApi();
  }, [refreshApi]);

  const refreshCRMStatus = useCallback(async () => {
    try {
      const result = await getCRMStatus();
      setCRMStatus(result.crm);
    } catch {
      setCRMStatus(null);
    }
  }, []);

  useEffect(() => {
    if (!authUser) return;
    void refreshCRMStatus();
  }, [authUser, refreshCRMStatus]);

  const refreshCalendar = useCallback(async () => {
    try {
      const connection = await getGoogleCalendarStatus();
      setCalendarStatus(connection.status);
      setCalendarError(null);
    } catch (error) {
      setCalendarStatus("unavailable");
      setCalendarError(error instanceof Error ? error.message : "Calendar connection status is unavailable.");
    }
  }, []);

  const refreshGmail = useCallback(async () => {
    try {
      const connection = await getGmailStatus();
      setGmailStatus(connection.status);
      setGmailError(null);
    } catch (error) {
      setGmailStatus("unavailable");
      setGmailError(error instanceof Error ? error.message : "Gmail connection status is unavailable.");
    }
  }, []);

  useEffect(() => {
    if (!authUser) return;
    const query = new URLSearchParams(window.location.search);
    const callback = query.get("calendarConnection");
    if (callback === "connected") setCalendarError(null);
    else if (callback === "error") setCalendarError(`Calendar connection could not be completed (${query.get("reason") ?? "OAuth error"}).`);
    if (callback) window.history.replaceState({}, "", window.location.pathname);
    const gmailCallback = query.get("gmailConnection");
    if (gmailCallback === "connected") setGmailError(null);
    else if (gmailCallback === "error") setGmailError(`Gmail connection could not be completed (${query.get("reason") ?? "OAuth error"}).`);
    if (gmailCallback) window.history.replaceState({}, "", window.location.pathname);
    void refreshCalendar();
    void refreshGmail();
  }, [authUser, refreshCalendar, refreshGmail]);

  useEffect(() => {
    const code = run?.error?.code;
    if (code?.startsWith("EMAIL_")) setGmailStatus(gmailStatusAfterApiError(code));
    if (code?.startsWith("CALENDAR_")) setCalendarStatus(calendarStatusAfterApiError(code));
  }, [run?.error?.code]);

  async function handleConnectCalendar() {
    setCalendarBusy(true); setCalendarError(null);
    try {
      const result = await getGoogleCalendarAuthorizationUrl();
      window.location.assign(result.authorizationUrl);
    } catch (error) {
      setCalendarError(error instanceof Error ? error.message : "Google Calendar could not be connected.");
      setCalendarBusy(false);
    }
  }

  async function handleAuthSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAuthBusy(true); setAuthError(null);
    try {
      const user = await authenticate(authEmail.trim(), authPassword, authMode === "register" ? authName.trim() : undefined);
      setAuthUser(user); setAuthPassword("");
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Authentication failed.");
    } finally { setAuthBusy(false); }
  }

  async function handleSignOut() {
    try { await signOut(); } catch { /* Always clear the local session when signing out. */ }
    disconnectSocket(); clearSession(); setAuthUser(null); setRun(null); setCRMStatus(null); setCRMPreview(null);
    setCalendarStatus("disconnected"); setGmailStatus("disconnected");
  }

  async function handleDisconnectCalendar() {
    setCalendarBusy(true); setCalendarError(null);
    try {
      await disconnectGoogleCalendar();
      setCalendarStatus("disconnected");
    } catch (error) {
      setCalendarError(error instanceof Error ? error.message : "Google Calendar could not be disconnected.");
    } finally { setCalendarBusy(false); }
  }

  async function handleConnectGmail() {
    setGmailBusy(true); setGmailError(null);
    try { const result = await getGmailAuthorizationUrl(); window.location.assign(result.authorizationUrl); }
    catch (error) { setGmailError(error instanceof Error ? error.message : "Gmail could not be connected."); setGmailBusy(false); }
  }
  async function handleDisconnectGmail() {
    setGmailBusy(true); setGmailError(null);
    try { await disconnectGmail(); setGmailStatus("disconnected"); }
    catch (error) { setGmailError(error instanceof Error ? error.message : "Gmail could not be disconnected."); }
    finally { setGmailBusy(false); }
  }

  const pendingActions = useMemo(
    () => run?.actions.filter((action) => action.lifecycle === "PROPOSED" && action.approvalStatus === "PENDING") ?? [],
    [run]
  );

  async function handleRun(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!goal.trim() || submitting) return;
    setSubmitting(true);
    setRequestError(null);
    setRun(null);
    try {
      const result = await submitGoal(goal.trim());
      setRun(result);
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : "The agent request failed.");
    } finally {
      setSubmitting(false);
      void refreshApi();
    }
  }

  async function handleDecision(action: ActionProposal, decision: "APPROVE" | "REJECT") {
    if (!run || busyAction) return;
    setBusyAction(action.id);
    setRequestError(null);
    try {
      const result = await decideAction(run.runId, action.id, decision);
      setRun(result);
      const [latestRun, trace] = await Promise.all([getRun(run.runId), getRunTrace(run.runId)]);
      setRun({ ...latestRun, trace });
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : "The approval request failed.");
      try {
        setRun(await getRun(run.runId));
      } catch {
        // Keep the last known run result visible when the refresh also fails.
      }
    } finally {
      setBusyAction(null);
    }
  }

  async function refreshTrace() {
    if (!run || refreshingTrace) return;
    setRefreshingTrace(true);
    try {
      const [latestRun, trace] = await Promise.all([getRun(run.runId), getRunTrace(run.runId)]);
      setRun({ ...latestRun, trace });
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : "Could not refresh run activity.");
    } finally {
      setRefreshingTrace(false);
    }
  }

  async function handleCRMFile(file?: File) {
    setCRMError(null);
    setCRMErrorDetails(null);
    setCRMPreview(null);
    setShowAllInvalidRows(false);
    if (!file) return;
    setCRMBusy(true);
    try {
      setCRMPreview(await previewCRMFile(file));
    } catch (error) {
      if (error instanceof ManageBizzApiError && Array.isArray(error.details)) {
        setCRMErrorDetails(error.details as Array<{ field: string; reason: string }>);
      }
      setCRMError(error instanceof Error ? error.message : "CRM file could not be previewed.");
    } finally {
      setCRMBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function handleCRMImport() {
    if (!crmPreview?.previewId || !crmPreview.canImport || crmBusy) return;
    setCRMBusy(true);
    setCRMError(null);
    try {
      await confirmCRMImport(crmPreview.previewId);
      setCRMPreview(null);
      await refreshCRMStatus();
    } catch (error) {
      setCRMError(error instanceof Error ? error.message : "CRM import failed.");
    } finally {
      setCRMBusy(false);
    }
  }

  const events = run?.trace.events ?? [];
  const toolEvents = events.filter((event) => event.eventType === "TOOL_COMPLETED" || event.eventType === "TOOL_FAILED");

  if (!authChecked) return <div className="auth-shell"><div className="auth-card"><span className="brand-mark"><Activity size={19} /></span><h1>ManageBizz</h1><p>Restoring your secure session…</p></div></div>;
  if (!authUser) return (
    <div className="auth-shell"><form className="auth-card" onSubmit={(event) => void handleAuthSubmit(event)}>
      <span className="brand-mark"><Activity size={19} strokeWidth={2.5} /></span>
      <p className="eyebrow">BUSINESS OPERATIONS · WORKSPACE</p><h1>{authMode === "login" ? "Welcome back" : "Create your account"}</h1>
      <p className="auth-copy">Sign in to access your private ManageBizz workspace.</p>
      {authMode === "register" && <label>Your name<input value={authName} onChange={(event) => setAuthName(event.target.value)} required maxLength={100} autoComplete="name" /></label>}
      <label>Email<input type="email" value={authEmail} onChange={(event) => setAuthEmail(event.target.value)} required autoComplete="email" /></label>
      <label>Password<input type="password" value={authPassword} onChange={(event) => setAuthPassword(event.target.value)} required minLength={authMode === "register" ? 12 : 1} maxLength={128} autoComplete={authMode === "login" ? "current-password" : "new-password"} /></label>
      {authError && <div className="banner banner-error"><AlertCircle size={16} /><span>{authError}</span></div>}
      <button className="button button-primary auth-submit" type="submit" disabled={authBusy}>{authBusy ? <><LoaderCircle className="spin" size={15} /> Please wait…</> : authMode === "login" ? "Sign in" : "Create account"}</button>
      <p className="auth-switch">{authMode === "login" ? "New to ManageBizz?" : "Already have an account?"} <button type="button" onClick={() => { setAuthMode(authMode === "login" ? "register" : "login"); setAuthError(null); }}>{authMode === "login" ? "Create an account" : "Sign in"}</button></p>
      <small>Passwords must be at least 12 characters for new accounts.</small>
    </form></div>
  );

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="ManageBizz home">
          <span className="brand-mark"><Activity size={19} strokeWidth={2.5} /></span>
          <span>Manage<span className="brand-accent">Bizz</span></span>
        </a>
        <div className="topbar-right">
          <div className={`connection ${apiState}`}>
            <span className="connection-dot" />
            {apiState === "checking" ? "Checking API" : apiState === "available" ? "API connected" : "API unavailable"}
          </div>
          <span className="topbar-divider" />
          <span className="user-mark" aria-label={`Signed in as ${authUser.name}`}>{authUser.name.slice(0, 2).toUpperCase()}</span>
          <span className="signed-in-email">{authUser.email}</span>
          <button className="button button-secondary button-small" onClick={() => void handleSignOut()}><LogOut size={14} /> Sign out</button>
        </div>
      </header>

      <main id="top" className="page-content">
        {apiState === "unavailable" && <div className="banner banner-error"><AlertCircle size={18} /><div><strong>ManageBizz API is unavailable.</strong><span>Start the API server, then check the connection again.</span></div><button className="icon-button" onClick={() => void refreshApi()} aria-label="Retry API connection"><RefreshCw size={16} /></button></div>}

        <section className="welcome-row">
          <div>
            <p className="eyebrow">BUSINESS OPERATIONS · WORKSPACE</p>
            <h1>Good day. What would you like to work on?</h1>
            <p className="muted welcome-copy">Give ManageBizz a business goal. It will use the connected business tools and show the evidence behind its response.</p>
          </div>
          <div className="today-chip"><span className="today-dot" /> Agent workspace</div>
        </section>

        <section className="panel gmail-panel">
          <div className="panel-title-row calendar-panel-heading">
            <div><p className="eyebrow">AI CONTEXT</p><h3>Gmail</h3></div>
            <StatusPill status={gmailStatus} />
          </div>
          <div className="calendar-connection-row">
            <span className="calendar-icon gmail-icon"><Mail size={18} /></span>
            <div className="calendar-copy">
              <strong>{gmailStatus === "connected" ? "Connected" : gmailStatus === "reauthorization_required" ? "Reconnect required" : gmailStatus === "access_denied" ? "Access denied" : gmailStatus === "unavailable" ? "Status unavailable" : "Disconnected"}</strong>
              <span>{gmailStatus === "connected" ? "Gmail is connected. Your AI agent can use your email context when needed." : gmailStatus === "reauthorization_required" ? "Gmail needs authorization again. Reconnect and approve the requested access." : gmailStatus === "access_denied" ? "Google denied Gmail access. Reconnect or review your Google account permissions." : gmailStatus === "unavailable" ? "Gmail access could not be verified. Retry or reconnect to check access." : "Connect Gmail to let your AI agent use your email context when needed."}</span>
            </div>
            {gmailStatus === "connected"
              ? <><button className="button button-secondary" disabled={gmailBusy || apiState !== "available"} onClick={() => void handleConnectGmail()}>{gmailBusy ? <><LoaderCircle className="spin" size={15} /> Reconnecting…</> : "Update Gmail access"}</button><button className="button button-secondary" disabled={gmailBusy} onClick={() => void handleDisconnectGmail()}>{gmailBusy ? <><LoaderCircle className="spin" size={15} /> Disconnecting…</> : "Disconnect"}</button></>
              : <><button className="button button-secondary" disabled={gmailBusy || apiState !== "available"} onClick={() => void handleConnectGmail()}>{gmailBusy ? <><LoaderCircle className="spin" size={15} /> Connecting…</> : <><ExternalLink size={15} /> {gmailStatus === "disconnected" ? "Connect Gmail" : "Reconnect Gmail"}</>}</button>{gmailStatus === "unavailable" && <button className="button button-secondary" disabled={gmailBusy} onClick={() => void refreshGmail()}><RefreshCw size={15} /> Retry status</button>}</>}
          </div>
          {gmailError && <div className="inline-error calendar-message"><AlertCircle size={15} />{gmailError}</div>}
        </section>

        <section className="panel calendar-panel">
          <div className="panel-title-row">
            <div><p className="eyebrow">AI CONTEXT</p><h3>Google Calendar</h3></div>
            <StatusPill status={calendarStatus} />
          </div>
          <div className="calendar-connection-row">
            <span className="calendar-icon"><CalendarDays size={18} /></span>
            <div className="calendar-copy">
              <strong>{calendarStatus === "connected" ? "Connected" : calendarStatus === "reauthorization_required" ? "Reconnect required" : calendarStatus === "access_denied" ? "Access denied" : calendarStatus === "unavailable" ? "Status unavailable" : "Disconnected"}</strong>
              <span>{calendarStatus === "connected" ? "Calendar is connected. Your AI agent can use your calendar context when needed." : calendarStatus === "reauthorization_required" ? "Calendar needs authorization again. Reconnect and approve the requested access." : calendarStatus === "access_denied" ? "Google denied Calendar access. Reconnect or review your Google account permissions." : calendarStatus === "unavailable" ? "Calendar access could not be verified. Retry or reconnect to check access." : "Connect Google Calendar to let your AI agent use your calendar context when needed."}</span>
            </div>
            {calendarStatus === "connected"
              ? <><button className="button button-secondary" disabled={calendarBusy || apiState !== "available"} onClick={() => void handleConnectCalendar()}>{calendarBusy ? <><LoaderCircle className="spin" size={15} /> Reconnecting…</> : "Update Calendar access"}</button><button className="button button-secondary" disabled={calendarBusy} onClick={() => void handleDisconnectCalendar()}>{calendarBusy ? <><LoaderCircle className="spin" size={15} /> Disconnecting…</> : "Disconnect"}</button></>
              : <><button className="button button-secondary" disabled={calendarBusy || apiState !== "available"} onClick={() => void handleConnectCalendar()}>{calendarBusy ? <><LoaderCircle className="spin" size={15} /> Connecting…</> : <><ExternalLink size={15} /> {calendarStatus === "disconnected" ? "Connect Google Calendar" : "Reconnect Google Calendar"}</>}</button>{calendarStatus === "unavailable" && <button className="button button-secondary" disabled={calendarBusy} onClick={() => void refreshCalendar()}><RefreshCw size={15} /> Retry status</button>}</>}
          </div>
          {calendarError && <div className="inline-error calendar-message"><AlertCircle size={15} />{calendarError}</div>}
        </section>

        <section className="overview-grid" aria-label="Workspace overview">
          <article className="overview-card"><span className="overview-icon icon-lavender"><Sparkles size={18} /></span><div><p>Agent runs</p><strong>{run ? "1" : "—"}</strong><span>{run ? "Current workspace session" : "No run started"}</span></div></article>
          <article className="overview-card"><span className="overview-icon icon-mint"><Database size={18} /></span><div><p>CRM records</p><strong>{crmStatus?.loaded ? crmStatus.recordCount : "—"}</strong><span>{crmStatus?.loaded ? "Imported for this workspace" : "No CRM uploaded"}</span></div></article>
          <article className="overview-card"><span className="overview-icon icon-peach"><ShieldCheck size={18} /></span><div><p>Pending approvals</p><strong>{run ? pendingActions.length : "—"}</strong><span>{run ? "Actions awaiting your decision" : "No action proposed"}</span></div></article>
          <article className="overview-card"><span className="overview-icon icon-blue"><Activity size={18} /></span><div><p>Tool activity</p><strong>{run ? toolEvents.length : "—"}</strong><span>{run ? "Completed or failed calls" : "No tool calls yet"}</span></div></article>
        </section>

        <section className="panel crm-upload-panel">
          <div className="panel-title-row crm-upload-heading">
            <div><p className="eyebrow">YOUR BUSINESS DATA</p><h3>CRM data source</h3></div>
            {crmStatus?.loaded ? <StatusPill status="LOADED" /> : <StatusPill status="NO_CRM" />}
          </div>
          <div className="crm-source-row">
            <span className="crm-file-icon"><FileSpreadsheet size={19} /></span>
            <div className="crm-source-copy">
              {crmStatus?.loaded ? <><strong>{crmStatus.sourceName}</strong><span>{crmStatus.recordCount} records · imported {crmStatus.importedAt ? new Date(crmStatus.importedAt).toLocaleString() : ""}</span></> : <><strong>No CRM uploaded for this workspace</strong><span>Upload a .xlsx or .csv file to make your CRM available to the existing agent tools.</span></>}
            </div>
            <input ref={fileInputRef} className="sr-only" type="file" accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv" onChange={(event) => void handleCRMFile(event.currentTarget.files?.[0])} />
            <button type="button" className="button button-secondary" disabled={crmBusy || apiState !== "available"} onClick={() => fileInputRef.current?.click()}>{crmBusy ? <><LoaderCircle className="spin" size={15} /> Processing…</> : <><FileSpreadsheet size={15} /> {crmStatus?.loaded ? "Replace CRM" : "Choose CRM file"}</>}</button>
          </div>
          <p className="crm-upload-hint">Supported: .xlsx and .csv · Required columns: name, email, company, dealValue, lastContactedAt · Maximum file size: 10 MB.</p>

          {crmError && <div className="banner banner-error crm-message"><AlertCircle size={16} /><div><strong>CRM upload could not continue.</strong><span>{crmError}</span>{crmErrorDetails?.map((issue, index) => <span key={`${issue.field}-${index}`}>{issue.field}: {issue.reason}</span>)}</div><button className="icon-button" onClick={() => { setCRMError(null); setCRMErrorDetails(null); }} aria-label="Dismiss CRM error"><X size={15} /></button></div>}

          {crmPreview && <div className="crm-preview">
            <div className="crm-preview-heading"><div><p className="eyebrow">IMPORT PREVIEW</p><h4>{crmPreview.sourceName}</h4></div><StatusPill status={crmPreview.status} /></div>
            <div className="preview-stats"><span><strong>{crmPreview.totalRows}</strong> data rows</span><span><strong>{crmPreview.validRecordCount}</strong> valid</span><span><strong>{crmPreview.invalidRows.length}</strong> invalid</span></div>
            {crmPreview.replacesExisting && <p className="replace-warning"><AlertCircle size={15} /> Confirming replaces the currently imported CRM for this workspace. Records are not merged.</p>}
            {crmPreview.fileIssues.length > 0 && <div className="row-issues"><strong>{crmPreview.status === "REJECTED" ? "Import rejected" : "File issues"}</strong>{crmPreview.fileIssues.map((issue, index) => <p key={`${issue.field}-${index}`}><b>{issue.field}</b> · {issue.reason}</p>)}</div>}
            {crmPreview.invalidRows.length > 0 && <div className="row-issues"><strong>{crmPreview.invalidRows.length} invalid row(s) will not be imported</strong><p>Review each row and field below. Invalid records are not silently merged, repaired, or imported.</p><div className="invalid-row-list">{(showAllInvalidRows ? crmPreview.invalidRows : crmPreview.invalidRows.slice(0, 100)).map((row) => <div className="invalid-row" key={row.rowNumber}><b>Row {row.rowNumber}</b><ul>{row.issues.map((issue, index) => <li key={`${issue.field}-${index}`}><strong>{issue.field}:</strong> {issue.reason}</li>)}</ul></div>)}</div>{crmPreview.invalidRows.length > 100 && <button className="button button-secondary button-small show-issues" onClick={() => setShowAllInvalidRows(!showAllInvalidRows)}>{showAllInvalidRows ? "Show first 100 rows" : `Show all ${crmPreview.invalidRows.length} invalid rows`}</button>}</div>}
            {crmPreview.sample.length > 0 && <div className="preview-table-wrap"><div className="preview-table-heading"><strong>Normalized record preview</strong><span>{`First ${crmPreview.sample.length} of ${crmPreview.validRecordCount} valid rows`}</span></div><table className="crm-preview-table"><thead><tr><th>Name</th><th>Email</th><th>Company</th><th>Deal value</th><th>Last contacted</th><th>Status</th></tr></thead><tbody>{crmPreview.sample.map((lead) => <tr key={lead.id}><td>{lead.name}</td><td>{lead.email}</td><td>{lead.company}</td><td>{lead.dealValue.toLocaleString()}</td><td>{new Date(lead.lastContactedAt).toLocaleDateString()}</td><td>{lead.status || "Not provided"}</td></tr>)}</tbody></table></div>}
            {crmPreview.status === "REJECTED" && crmPreview.validRecordCount === 0 && <p className="rejected-note">There are zero valid CRM records. This import cannot be confirmed.</p>}
            {crmPreview.canImport && <div className="crm-confirm-row"><span>{crmPreview.invalidRows.length > 0 ? `Only the ${crmPreview.validRecordCount} valid rows will be imported; ${crmPreview.invalidRows.length} invalid rows are excluded.` : `${crmPreview.validRecordCount} normalized records are ready.`}</span><div><button className="button button-secondary" disabled={crmBusy} onClick={() => setCRMPreview(null)}>Cancel</button><button className="button button-primary" disabled={crmBusy} onClick={() => void handleCRMImport()}>{crmBusy ? <><LoaderCircle className="spin" size={15} /> Importing…</> : crmPreview.replacesExisting ? `Replace CRM with ${crmPreview.validRecordCount} valid rows` : `Import ${crmPreview.validRecordCount} valid rows`}</button></div></div>}
          </div>}
        </section>

        <section className="goal-card panel">
          <div className="section-heading">
            <div><span className="heading-icon"><Sparkles size={18} /></span><div><p className="eyebrow">NEW AGENT RUN</p><h2>Describe your goal</h2></div></div>
            <span className="privacy-note"><ShieldCheck size={15} /> Actions pause for approval</span>
          </div>
          <form onSubmit={handleRun}>
            <label className="sr-only" htmlFor="goal-input">Business goal</label>
            <textarea id="goal-input" value={goal} onChange={(event) => setGoal(event.target.value)} placeholder="For example: Find inactive high-value leads from the last 30 days." maxLength={2000} rows={3} />
            <div className="goal-form-footer"><span>{goal.length}/2000</span><button type="submit" className="button button-primary" disabled={submitting || !goal.trim() || apiState !== "available"}>{submitting ? <><LoaderCircle className="spin" size={16} /> Working…</> : <><Play size={15} fill="currentColor" /> Run Agent</>}</button></div>
          </form>
          <div className="suggestion-row"><span>Try:</span>{suggestions.map((suggestion) => <button type="button" className="suggestion" key={suggestion} onClick={() => setGoal(suggestion)}>{suggestion}<ChevronRight size={14} /></button>)}</div>
          <p className="data-note"><CircleHelp size={14} /> Suggestions are example prompts only. Results come from the connected API; no sample business records are added.</p>
        </section>

        {requestError && <div className="banner banner-error"><AlertCircle size={18} /><div><strong>Request could not be completed.</strong><span>{requestError}</span></div><button className="icon-button" onClick={() => setRequestError(null)} aria-label="Dismiss error"><X size={16} /></button></div>}

        {!run && !requestError && <section className="empty-workspace panel"><span className="empty-icon"><ArrowDownRight size={21} /></span><div><h2>Your agent workspace is ready</h2><p>Start a run to see its response, supporting evidence, recommendations, actions, and tool activity here.</p></div></section>}

        {run && <>
          <section className="run-heading">
            <div><p className="eyebrow">AGENT WORKSPACE · {run.runId}</p><h2>Run details</h2></div>
            <div className="run-status-actions"><StatusPill status={run.status} /><button className="button button-secondary button-small" onClick={() => void refreshTrace()} disabled={refreshingTrace}>{refreshingTrace ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />} Refresh activity</button></div>
          </section>
          <div className="workspace-grid">
            <div className="workspace-main">
              <section className="panel result-panel">
                <div className="section-heading compact"><div><p className="eyebrow">USER GOAL</p><h3>{goal}</h3></div><StatusPill status={run.status} /></div>
                {run.status === "failed" && <div className="banner banner-error"><AlertCircle size={17} /><div><strong>Agent run failed</strong><span>{run.error?.message ?? "The agent could not complete this run."}</span></div></div>}
                <div className="answer-box"><span className="answer-label"><Sparkles size={15} /> SUMMARY</span><p>{run.response?.summary || run.answer || "No response was returned by the agent."}</p>{run.response?.evidenceInsufficient && <small className="insufficient-note">Insufficient evidence to determine the requested result.</small>}</div>
              </section>

              <section className="panel">
                <div className="panel-title-row"><div><p className="eyebrow">GOAL-DRIVEN EXECUTION</p><h3>Investigation plan</h3></div><span className="count-label">{run.plan?.steps.length ?? 0} {run.plan?.steps.length === 1 ? "step" : "steps"}</span></div>
                {!run.plan?.steps.length ? <EmptyNotice title="No tool steps selected" detail="The goal did not map to a configured business tool." /> : <ol className="agent-plan-list">{run.plan.steps.map((step, index) => <li className="agent-plan-step" key={`${step.tool}.${step.action}.${index}`}><span className="plan-sequence">{index + 1}</span><div><div className="plan-title"><strong>{step.tool} · {step.action}</strong>{step.dependsOnCRMResults && <span className="dependency-tag">After CRM matches</span>}</div><p>{step.purpose}</p></div></li>)}</ol>}
              </section>

              <section className="panel">
                <div className="panel-title-row"><div><p className="eyebrow">SOURCE RESULTS</p><h3>Evidence</h3></div><span className="count-label">{run.evidence.facts.length} {run.evidence.facts.length === 1 ? "item" : "items"}</span></div>
                {run.evidence.facts.length === 0 ? <EmptyNotice title="No evidence returned" detail="The agent did not receive business facts from its tools for this run." /> : <div className="evidence-list">{run.evidence.facts.map((fact) => <article className="evidence-item" key={fact.evidenceRef}><div className="evidence-top"><span className="source-tag">{fact.tool} · {fact.action}</span><StatusPill status={isEmptyEvidence(fact) ? "EMPTY_RESULT" : fact.outcome} /></div><p>{fact.statement}</p><span className="evidence-ref">{fact.evidenceRef}</span>{fact.error && <div className="inline-error"><AlertCircle size={15} />{fact.error.code}: {fact.error.message}</div>}</article>)}</div>}
                {run.evidence.inferences.length > 0 && <div className="subsection"><h4>Inferences</h4><ul>{run.evidence.inferences.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul></div>}
              </section>

              <section className="panel">
                <div className="panel-title-row"><div><p className="eyebrow">EVIDENCE-BASED NEXT STEPS</p><h3>Recommendations</h3></div><ArrowUpRight size={18} className="title-muted" /></div>
                {run.recommendations.length === 0 ? <EmptyNotice title="No recommendations" detail="There are no recommendations supported by this run's retrieved evidence." /> : <div className="recommendation-list">{run.recommendations.map((item, index) => <article className="recommendation-item" key={`${index}-${item.statement}`}><span className="recommendation-check"><Check size={15} /></span><div><p>{item.statement}</p><small>Evidence: {item.evidenceRefs.length ? item.evidenceRefs.join(", ") : "No evidence reference supplied"}</small></div></article>)}</div>}
              </section>

              <section className="panel">
                <div className="panel-title-row"><div><p className="eyebrow">PLAN · APPROVAL · EXECUTION</p><h3>Actions</h3></div><span className="count-label">{run.actions.length}</span></div>
                {run.actions.length === 0 ? <EmptyNotice title="No actions proposed" detail="The agent did not propose a mutation for this goal." /> : <div className="action-list">{run.actions.map((action) => {
                  const draftId = typeof action.params.draftId === "string" ? action.params.draftId : undefined;
                  const related = draftId ? run.actions.find((candidate) => candidate.action === "draftEmail" && candidate.result?.success && typeof candidate.result.data === "object" && candidate.result.data !== null && "draftId" in candidate.result.data && candidate.result.data.draftId === draftId) : undefined;
                  const draftData = related?.result?.success && typeof related.result.data === "object" && related.result.data !== null ? related.result.data as { to?: string; subject?: string; body?: string } : undefined;
                  return <ActionCard key={action.id} action={action} relatedDraft={draftData} busy={busyAction !== null} onDecision={(selected, decision) => void handleDecision(selected, decision)} />;
                })}</div>}
              </section>
            </div>

            <aside className="panel activity-panel">
              <div className="panel-title-row"><div><p className="eyebrow">RUN PROGRESS</p><h3>Activity</h3></div><span className="activity-count">{events.length}</span></div>
              {run.trace.status === "FAILED" && <div className="tool-error-summary"><AlertCircle size={15} /><span>Run or tool failure recorded. Review event details below.</span></div>}
              {events.length === 0 ? <EmptyNotice title="No activity recorded" detail="No trace events are available for this run yet." /> : <ol className="activity-list">{events.map((event, index) => <li className="activity-event" key={event.eventId}><span className={`event-marker ${event.eventType.includes("FAILED") ? "event-failed" : event.resultStatus === "SUCCESS" ? "event-success" : ""}`} />{index < events.length - 1 && <span className="event-rail" />}<div className="event-content"><div className="event-title-row"><strong>{eventLabel(event)}</strong><StatusPill status={event.resultStatus ?? event.eventType} /></div><span className="event-kind">{formatStatus(event.eventType)}</span>{eventDetail(event) && <p className={event.eventType.includes("FAILED") ? "event-error-text" : ""}>{eventDetail(event)}</p>}{event.durationMs !== undefined && <span className="event-duration"><Clock3 size={12} />{event.durationMs} ms</span>}<time>{new Date(event.timestamp).toLocaleString()}</time></div></li>)}</ol>}
              <div className="activity-footer"><span><span className={`trace-dot ${run.trace.status === "COMPLETED" ? "done" : run.trace.status === "FAILED" ? "failed" : ""}`} /> Trace {formatStatus(run.trace.status)}</span><span>{toolEvents.length} tool {toolEvents.length === 1 ? "call" : "calls"}</span></div>
            </aside>
          </div>
        </>}

        <section className="data-source-note"><Database size={16} /><span><strong>Business data connection</strong> · CRM uploads, Gmail, and Google Calendar are connected to workspace-scoped tools. External writes require approval and verification. Empty API results are shown as empty; no business records are fabricated.</span></section>
      </main>
      <footer className="footer"><span>ManageBizz</span><span>Business operations workspace</span></footer>
    </div>
  );
}

function EmptyNotice({ title, detail }: { title: string; detail: string }) {
  return <div className="empty-notice"><span><CircleHelp size={17} /></span><div><strong>{title}</strong><p>{detail}</p></div></div>;
}
