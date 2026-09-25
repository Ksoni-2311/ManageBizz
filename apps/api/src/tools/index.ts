import { CRMTool } from "./crmTool.js";
import { EmailTool } from "./emailTool.js";
import { CalendarTool } from "./calendarTool.js";
import { TaskTool } from "./taskTool.js";
import { AnalyticsTool } from "./analyticsTool.js";
import { ToolExecutionContext, ToolResponse } from "@nexusops/shared-types";
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
  tasks: ["createTask", "completeTask"]
};

export class ToolOrchestrator {
  static async executeToolCall(
    toolName: string,
    action: string,
    params: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<ToolResponse> {
    console.log(`[ToolOrchestrator] Executing ${toolName}.${action} (actionId: ${context.actionId})`);

    if (!context.userId?.trim() || !context.orgId?.trim()) {
      return fail("AUTH_REQUIRED", "Business tools require an authenticated user and workspace context.", context);
    }

    if (![...(READ_ONLY_TOOL_ACTIONS[toolName] ?? []), ...(ACTION_TOOL_ACTIONS[toolName] ?? [])].includes(action)) {
      return fail("UNKNOWN_ACTION", `Action '${action}' is not exposed as a supported business tool action.`, context);
    }

    // 1. Idempotency Check
    try {
      const existing = await ToolExecutionModel.findOne({ actionId: context.actionId, orgId: context.orgId, userId: context.userId });
      if (existing) {
        const existingParams = (existing.params ?? {}) as Record<string, unknown>;
        const expectedKey = emptyToolCallKey(context.runId, context.orgId, toolName, action, params);
        const cachedKey = emptyToolCallKey(existing.runId, context.orgId, existing.tool, existing.action, existingParams);
        if (existing.runId !== context.runId || cachedKey !== expectedKey) {
          return fail("ACTION_ID_CONFLICT", "This action ID is already associated with a different tool call.", context);
        }
        console.log(`[ToolOrchestrator] ActionId ${context.actionId} already executed. Returning cached result.`);
        return {
          success: true,
          data: existing.result,
          metadata: { executionTimeMs: 0, actionId: context.actionId, cached: true }
        };
      }
    } catch {
      // Fallback if DB not active
    }

    // 2. Dispatch call
    const toolInstance = (ToolsRegistry as Record<string, any>)[toolName];
    if (!toolInstance) {
      return fail("UNKNOWN_TOOL", `Unknown tool category '${toolName}'.`, context);
    }

    const actionFn = toolInstance[action];
    if (typeof actionFn !== "function") {
      return fail("UNKNOWN_ACTION", `Action '${action}' is not supported on tool '${toolName}'.`, context);
    }

    const startTime = Date.now();
    let result: ToolResponse;
    try {
      const signature = emptyToolCallKey(context.runId, context.orgId, toolName, action, params);
      result = await emptyResultCallGuard.execute(signature, context.actionId, () => actionFn.call(toolInstance, params, context));
    } catch (error) {
      result = fail("TOOL_ERROR", error instanceof Error ? error.message : "Tool execution failed.", context);
    }

    // 3. Save Execution Record for Idempotency
    if (result.success) {
      try {
        await ToolExecutionModel.create({
          orgId: context.orgId,
          userId: context.userId,
          actionId: context.actionId,
          goalId: context.goalId,
          runId: context.runId,
          stepId: context.actionId,
          tool: toolName,
          action,
          params,
          result: result.data,
          executedAt: new Date()
        });
      } catch {
        // Ignore DB save error in mock mode
      }
    }

    const metadata = { ...result.metadata, executionTimeMs: Date.now() - startTime, actionId: context.actionId };
    return result.success ? { ...result, metadata } : { ...result, metadata };
  }
}
