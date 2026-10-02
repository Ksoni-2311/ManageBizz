import { z, ZodError, ZodType } from "zod";
import { ToolExecutionContext, ToolResponse } from "@nexusops/shared-types";

export const nonEmpty = z.string().trim().min(1);
export const emailAddress = z.string().trim().email();
export const nonNegativeNumber = z.number().finite().nonnegative();
export const positiveInteger = z.number().int().positive();

export class ToolDomainError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export function requireApprovedAction(context: ToolExecutionContext): void {
  if (!context.actionId || context.approvedActionId !== context.actionId) {
    throw new ToolDomainError("APPROVAL_REQUIRED", "This mutation requires an explicit approval decision before execution.");
  }
}

export function ok<T>(data: T, context: ToolExecutionContext): ToolResponse<T> {
  return { success: true, data, metadata: { executionTimeMs: 0, actionId: context.actionId } };
}

export function fail(code: string, message: string, context?: ToolExecutionContext, details?: unknown): ToolResponse<never> {
  return {
    success: false,
    error: { code, message, ...(details === undefined ? {} : { details }) },
    ...(context ? { metadata: { executionTimeMs: 0, actionId: context.actionId } } : {})
  };
}

export async function runValidated<I, O>(
  schema: ZodType<I>, input: unknown, context: ToolExecutionContext,
  handler: (params: I) => O | Promise<O>
): Promise<ToolResponse<O>> {
  if (!context.userId?.trim() || !context.orgId?.trim()) {
    return fail("AUTH_REQUIRED", "Business tools require an authenticated user and workspace context.", context);
  }
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    return fail("INVALID_INPUT", "Tool input did not match the required contract.", context,
      parsed.error.issues.map(({ path, message }) => ({ path: path.join("."), message })));
  }
  try {
    return ok(await handler(parsed.data), context);
  } catch (error) {
    if (error instanceof ToolDomainError) return fail(error.code, error.message, context);
    if (error instanceof ZodError) {
      return fail("INVALID_DATA", "Business data failed validation.", context,
        error.issues.map(({ path, message }) => ({ path: path.join("."), message })));
    }
    return fail("TOOL_ERROR", error instanceof Error ? error.message : "Tool execution failed.", context);
  }
}
