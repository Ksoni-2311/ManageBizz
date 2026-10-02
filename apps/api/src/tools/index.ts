import { createHash } from "node:crypto";
import { ToolExecutionContext, ToolResponse } from "@nexusops/shared-types";
import { CRMTool } from "./crmTool.js";
import { EmailTool } from "./emailTool.js";
import { CalendarTool } from "./calendarTool.js";
import { TaskTool } from "./taskTool.js";
import { AnalyticsTool } from "./analyticsTool.js";
import { ToolExecutionModel } from "../models/BusinessEntities.js";
import { fail } from "./contract.js";
import { EmptyResultCallGuard, emptyToolCallKey } from "../agent/policies/dataIntegrity.js";

const emptyResultCallGuard = new EmptyResultCallGuard();

export const ToolsRegistry = {
  crm: CRMTool,
  email: EmailTool,
  calendar: CalendarTool,
  tasks: TaskTool,
  analytics: AnalyticsTool
};

/** Explicit capability lists keep read-only queries separate from mutations. */
export const READ_ONLY_TOOL_ACTIONS: Readonly<Record<string, readonly string[]>> = {
  crm: ["listActiveHighValueLeads", "listInactiveLeads", "searchLeads"],
  email: ["getEmailHistory", "getUnansweredMessages", "getEmailMetadata"],
  calendar: ["getAvailability", "getMeeting", "listUpcomingEvents", "findEventsForLead"],
  analytics: ["getLeadMetrics", "getConversionMetrics", "getSalesMetrics", "getActivityMetrics"],
  tasks: ["listOpenTasks"]
};

export const ACTION_TOOL_ACTIONS: Readonly<Record<string, readonly string[]>> = {
  email: ["draftEmail", "sendEmail"],
  calendar: ["createMeeting"],
  tasks: ["createTask", "completeTask"]
};

type ActionIdempotencyInput = {
  context: ToolExecutionContext;
  tool: string;
  action: string;
  paramsHash: string;
};
type BeginActionResult =
  | { status: "CLAIMED" }
  | { status: "CACHED"; result: ToolResponse }
  | { status: "IN_PROGRESS" }
  | { status: "CONFLICT" };

export interface ActionIdempotencyStore {
  begin(input: ActionIdempotencyInput): Promise<BeginActionResult>;
  finish(input: ActionIdempotencyInput, result: ToolResponse): Promise<void>;
}

/** Durable action claim. A claim is written before any external mutation begins. */
export class MongooseActionIdempotencyStore implements ActionIdempotencyStore {
  async begin(input: ActionIdempotencyInput): Promise<BeginActionResult> {
    const { context, tool, action, paramsHash } = input;
    const existing = await ToolExecutionModel.findOne({ actionId: context.actionId }).lean();
    if (existing) return this.existingResult(existing as Record<string, unknown>, input);
    try {
      await ToolExecutionModel.create({
        orgId: context.orgId, userId: context.userId, actionId: context.actionId,
        goalId: context.goalId, runId: context.runId, stepId: context.actionId,
        tool, action, params: { fingerprint: paramsHash }, paramsHash,
        result: {}, executionStatus: "PENDING", executedAt: new Date()
      });
      return { status: "CLAIMED" };
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
      const raced = await ToolExecutionModel.findOne({ actionId: context.actionId }).lean();
      return raced ? this.existingResult(raced as Record<string, unknown>, input) : { status: "IN_PROGRESS" };
    }
  }

  async finish(input: ActionIdempotencyInput, result: ToolResponse): Promise<void> {
    const { context } = input;
    const storedResult = safeActionResult(input.tool, input.action, result);
    const updated = await ToolExecutionModel.updateOne(
      { actionId: context.actionId, orgId: context.orgId, userId: context.userId, runId: context.runId, executionStatus: "PENDING" },
      { $set: { result: storedResult, executionStatus: result.success ? "SUCCEEDED" : "FAILED", executedAt: new Date() } }
    );
    if (updated.matchedCount !== 1) throw new Error("Action idempotency claim was lost before its result was recorded.");
  }

  private existingResult(existing: Record<string, unknown>, input: ActionIdempotencyInput): BeginActionResult {
    const { context, tool, action, paramsHash } = input;
    if (existing.orgId !== context.orgId || existing.userId !== context.userId || existing.runId !== context.runId ||
      existing.tool !== tool || existing.action !== action || existing.paramsHash !== paramsHash) return { status: "CONFLICT" };
    if (existing.executionStatus === "PENDING") return { status: "IN_PROGRESS" };
    const result = existing.result as ToolResponse | undefined;
    if (result && typeof result === "object" && typeof result.success === "boolean") return { status: "CACHED", result };
    // Old success rows predate explicit status/fingerprints. Fail closed instead of repeating a mutation.
    return { status: "CONFLICT" };
  }
}

/** Deterministic store for isolated service tests. Production uses the durable Mongo adapter. */
export class InMemoryActionIdempotencyStore implements ActionIdempotencyStore {
  private readonly values = new Map<string, { input: ActionIdempotencyInput; status: "PENDING" | "FINISHED"; result?: ToolResponse }>();
  async begin(input: ActionIdempotencyInput): Promise<BeginActionResult> {
    const previous = this.values.get(input.context.actionId);
    if (!previous) { this.values.set(input.context.actionId, { input, status: "PENDING" }); return { status: "CLAIMED" }; }
    if (!sameCall(previous.input, input)) return { status: "CONFLICT" };
    if (previous.status === "PENDING") return { status: "IN_PROGRESS" };
    return previous.result ? { status: "CACHED", result: structuredClone(previous.result) } : { status: "CONFLICT" };
  }
  async finish(input: ActionIdempotencyInput, result: ToolResponse): Promise<void> {
    const current = this.values.get(input.context.actionId);
    if (!current || !sameCall(current.input, input) || current.status !== "PENDING") throw new Error("Action idempotency claim was lost.");
    current.status = "FINISHED";
    current.result = structuredClone(safeActionResult(input.tool, input.action, result));
  }
}

const persistentActionIdempotency = new MongooseActionIdempotencyStore();

export class ToolOrchestrator {
  static async executeToolCall(
    toolName: string,
    action: string,
    params: Record<string, unknown>,
    context: ToolExecutionContext,
    actionStore: ActionIdempotencyStore = persistentActionIdempotency,
    registry: unknown = ToolsRegistry
  ): Promise<ToolResponse> {
    const isMutation = ACTION_TOOL_ACTIONS[toolName]?.includes(action) ?? false;
    if (!context.userId?.trim() || !context.orgId?.trim() || !context.actionId?.trim() || !context.runId?.trim()) {
      return fail("AUTH_REQUIRED", "Business tools require an authenticated user and workspace context.", context);
    }
    if (![...(READ_ONLY_TOOL_ACTIONS[toolName] ?? []), ...(ACTION_TOOL_ACTIONS[toolName] ?? [])].includes(action)) {
      return fail("UNKNOWN_ACTION", `Action '${action}' is not exposed as a supported business tool action.`, context);
    }
    if (isMutation && context.approvedActionId !== context.actionId) {
      return fail("APPROVAL_REQUIRED", "The write tool was not invoked through an approved action proposal.", context);
    }

    const signature = emptyToolCallKey(context.runId, context.orgId, toolName, action, params);
    const idempotencyInput: ActionIdempotencyInput = { context, tool: toolName, action, paramsHash: hashParams(params) };
    if (isMutation) {
      let begin: BeginActionResult;
      try { begin = await actionStore.begin(idempotencyInput); }
      catch { return fail("ACTION_IDEMPOTENCY_UNAVAILABLE", "The action could not safely reserve an idempotency key; no mutation was attempted.", context); }
      if (begin.status === "CACHED") return withCacheMetadata(begin.result, context.actionId);
      if (begin.status === "IN_PROGRESS") return fail("ACTION_IN_PROGRESS", "This action has already been claimed and will not be executed a second time.", context);
      if (begin.status === "CONFLICT") return fail("ACTION_ID_CONFLICT", "This action ID is already associated with a different owner or action.", context);
    } else {
      // Preserve read-call idempotency when storage is available; reads remain safe to retry on storage errors.
      try {
        const existing = await ToolExecutionModel.findOne({ actionId: context.actionId, orgId: context.orgId, userId: context.userId }).lean();
        if (existing) {
          const existingParams = (existing.params ?? {}) as Record<string, unknown>;
          const cachedKey = emptyToolCallKey(existing.runId, context.orgId, existing.tool, existing.action, existingParams);
          if (existing.runId !== context.runId || cachedKey !== signature) return fail("ACTION_ID_CONFLICT", "This action ID is already associated with a different tool call.", context);
          return { success: true, data: existing.result, metadata: { executionTimeMs: 0, actionId: context.actionId, cached: true } };
        }
      } catch { /* Read-only calls remain available when optional idempotency storage is offline. */ }
    }

    const toolInstance = (registry as unknown as Record<string, Record<string, unknown>>)[toolName];
    const actionFn = toolInstance?.[action];
    if (typeof actionFn !== "function") return fail("UNKNOWN_ACTION", `Action '${action}' is not supported on tool '${toolName}'.`, context);
    const startedAt = Date.now();
    let result: ToolResponse;
    try {
      result = await emptyResultCallGuard.execute(signature, context.actionId, () =>
        (actionFn as (params: Record<string, unknown>, context: ToolExecutionContext) => Promise<ToolResponse>).call(toolInstance, params, context));
    } catch (error) {
      result = fail("TOOL_ERROR", error instanceof Error ? error.message : "Tool execution failed.", context);
    }

    if (isMutation) {
      try { await actionStore.finish(idempotencyInput, result); }
      catch { return fail("ACTION_RESULT_UNRECORDED", "The action result could not be safely recorded. Do not retry this action automatically.", context); }
    } else if (result.success) {
      try {
        await ToolExecutionModel.create({
          orgId: context.orgId, userId: context.userId, actionId: context.actionId,
          goalId: context.goalId, runId: context.runId, stepId: context.actionId,
          tool: toolName, action, params, result: result.data,
          paramsHash: hashParams(params), executionStatus: "SUCCEEDED", executedAt: new Date()
        });
      } catch { /* Read-only results must not fail because best-effort caching is unavailable. */ }
    }
    const metadata = { ...result.metadata, executionTimeMs: Date.now() - startedAt, actionId: context.actionId };
    return { ...result, metadata };
  }
}

function hashParams(value: unknown): string {
  return createHash("sha256").update(canonicalize(value), "utf8").digest("hex");
}
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(",")}}`;
}
function sameCall(a: ActionIdempotencyInput, b: ActionIdempotencyInput): boolean {
  return a.context.actionId === b.context.actionId && a.context.orgId === b.context.orgId && a.context.userId === b.context.userId &&
    a.context.runId === b.context.runId && a.tool === b.tool && a.action === b.action && a.paramsHash === b.paramsHash;
}
function isDuplicateKey(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === 11000; }
function safeActionResult(tool: string, action: string, result: ToolResponse): ToolResponse {
  if (tool !== "email" || action !== "draftEmail" || !result.success || typeof result.data !== "object" || result.data === null) return structuredClone(result);
  const { draftId, to, subject, status } = result.data as Record<string, unknown>;
  return { success: true, data: { draftId, to, subject, status } };
}
function withCacheMetadata(result: ToolResponse, actionId: string): ToolResponse {
  if (result.success) return { ...result, metadata: { executionTimeMs: 0, actionId, cached: true } };
  return { ...result, metadata: { executionTimeMs: 0, actionId, cached: true } };
}
