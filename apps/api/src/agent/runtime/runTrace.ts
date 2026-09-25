import { randomUUID } from "node:crypto";
import { ToolResponse } from "@nexusops/shared-types";

export type RunTraceEventType =
  | "AGENT_STARTED" | "TOOL_CALLED" | "TOOL_COMPLETED" | "TOOL_FAILED" | "PLAN_CREATED"
  | "ACTION_PROPOSED" | "ACTION_APPROVED" | "ACTION_REJECTED" | "ACTION_EXECUTED" | "ACTION_VERIFIED"
  | "AGENT_COMPLETED" | "AGENT_FAILED";

export type RunTraceEvent = {
  eventId: string;
  runId: string;
  eventType: RunTraceEventType;
  timestamp: string;
  toolName?: string;
  action?: string;
  input?: unknown;
  resultStatus?: "SUCCESS" | "FAILED" | "PENDING";
  durationMs?: number;
  error?: { code: string; message: string };
  details?: unknown;
};

export type RunTraceRecord = {
  runId: string;
  goalId: string;
  orgId: string;
  userId?: string;
  status: "RUNNING" | "COMPLETED" | "FAILED";
  startedAt: string;
  endedAt?: string;
  events: RunTraceEvent[];
};

type StartRun = { runId: string; goalId: string; orgId: string; userId?: string };
type TraceToolCallArgs = {
  runId: string;
  toolName: string;
  action: string;
  input: Record<string, unknown>;
  execute: () => Promise<ToolResponse>;
};

const sensitiveKey = /password|secret|token|api.?key|authorization|cookie|email|phone|mobile|body|content|notes?|title|query/i;
const sensitiveString = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|\bBearer\s+\S+|\b(?:sk|key|token)[-_][A-Za-z0-9_-]{12,}\b/gi;

export function sanitizeTraceValue(value: unknown, key = ""): unknown {
  if (sensitiveKey.test(key)) return "[REDACTED]";
  if (typeof value === "string") return value.replace(sensitiveString, "[REDACTED]").slice(0, 500);
  if (Array.isArray(value)) return value.map((entry) => sanitizeTraceValue(entry));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, sanitizeTraceValue(childValue, childKey)]));
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  return String(value).slice(0, 500);
}

export function createRunId(): string {
  return `run-${randomUUID()}`;
}

/** Small process-local trace registry for the MVP; consumers receive defensive copies. */
export class RunTraceStore {
  private readonly runs = new Map<string, RunTraceRecord>();

  startRun(input: StartRun): RunTraceRecord {
    if (this.runs.has(input.runId)) throw new Error(`Run ID '${input.runId}' is already active.`);
    const run: RunTraceRecord = {
      ...input,
      status: "RUNNING",
      startedAt: new Date().toISOString(),
      events: []
    };
    this.runs.set(input.runId, run);
    this.append(input.runId, "AGENT_STARTED", { details: { goalId: input.goalId } });
    return structuredClone(run);
  }

  append(runId: string, eventType: RunTraceEventType, fields: Omit<Partial<RunTraceEvent>, "eventId" | "runId" | "eventType" | "timestamp"> = {}): void {
    const run = this.runs.get(runId);
    if (!run) return;
    run.events.push({
      eventId: randomUUID(),
      runId,
      eventType,
      timestamp: new Date().toISOString(),
      ...sanitizeTraceValue(fields) as typeof fields
    });
  }

  async traceToolCall({ runId, toolName, action, input, execute }: TraceToolCallArgs): Promise<ToolResponse> {
    const started = Date.now();
    this.append(runId, "TOOL_CALLED", { toolName, action, input, resultStatus: "PENDING", durationMs: 0 });
    let result: ToolResponse;
    try {
      result = await execute();
    } catch (error) {
      result = {
        success: false,
        error: { code: "TOOL_EXECUTION_ERROR", message: error instanceof Error ? error.message : "Tool execution failed." }
      };
    }
    const durationMs = Math.max(0, Date.now() - started);
    if (result.success) {
      this.append(runId, "TOOL_COMPLETED", { toolName, action, input, resultStatus: "SUCCESS", durationMs });
    } else {
      this.append(runId, "TOOL_FAILED", {
        toolName, action, input, resultStatus: "FAILED", durationMs,
        error: { code: result.error.code, message: result.error.message }
      });
    }
    return result;
  }

  finishRun(runId: string, status: "COMPLETED" | "FAILED", error?: string): void {
    const run = this.runs.get(runId);
    if (!run) return;
    run.status = status;
    run.endedAt = new Date().toISOString();
    this.append(runId, status === "COMPLETED" ? "AGENT_COMPLETED" : "AGENT_FAILED", {
      resultStatus: status === "COMPLETED" ? "SUCCESS" : "FAILED",
      ...(error ? { error: { code: "AGENT_FAILED", message: error } } : {})
    });
  }

  getRunTrace(runId: string, orgId?: string, userId?: string): RunTraceRecord | undefined {
    const run = this.runs.get(runId);
    if (!run || (orgId !== undefined && run.orgId !== orgId) || (userId !== undefined && run.userId !== userId)) return undefined;
    return structuredClone(run);
  }
}

export const runTraceStore = new RunTraceStore();
