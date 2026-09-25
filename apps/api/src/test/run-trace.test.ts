import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRunId, RunTraceStore } from "../agent/runtime/runTrace.js";

describe("run tracing", () => {
  it("records every successful tool call with sanitized input, result status, and duration", async () => {
    const traces = new RunTraceStore();
    traces.startRun({ runId: "run-trace-success", goalId: "goal", orgId: "org" });
    const result = await traces.traceToolCall({
      runId: "run-trace-success", toolName: "email", action: "getEmailHistory",
      input: { leadEmail: "private@example.invalid", timeWindowDays: 20, apiKey: "sample-secret" },
      execute: async () => ({ success: true, data: [] })
    });
    assert.equal(result.success, true);
    const events = traces.getRunTrace("run-trace-success")!.events;
    assert.deepEqual(events.map(({ eventType }) => eventType), ["AGENT_STARTED", "TOOL_CALLED", "TOOL_COMPLETED"]);
    assert.equal(events[1]!.resultStatus, "PENDING");
    assert.equal(events[1]!.toolName, "email");
    assert.deepEqual(events[1]!.input, { leadEmail: "[REDACTED]", timeWindowDays: 20, apiKey: "[REDACTED]" });
    assert.equal(events[2]!.resultStatus, "SUCCESS");
    assert.equal(typeof events[2]!.durationMs, "number");
    assert.doesNotMatch(JSON.stringify(events), /private@example\.invalid|sample-secret/);
  });

  it("records failed tool calls with an error", async () => {
    const traces = new RunTraceStore();
    traces.startRun({ runId: "run-trace-failure", goalId: "goal", orgId: "org" });
    await traces.traceToolCall({
      runId: "run-trace-failure", toolName: "crm", action: "searchLeads", input: { query: "prospect" },
      execute: async () => ({ success: false, error: { code: "DATA_INVALID", message: "Invalid input" } })
    });
    const failed = traces.getRunTrace("run-trace-failure")!.events.at(-1)!;
    assert.equal(failed.eventType, "TOOL_FAILED");
    assert.equal(failed.resultStatus, "FAILED");
    assert.equal(failed.error?.code, "DATA_INVALID");
    assert.equal(typeof failed.durationMs, "number");
  });

  it("records run completion and failure", () => {
    const traces = new RunTraceStore();
    traces.startRun({ runId: "run-trace-completed", goalId: "goal", orgId: "org" });
    traces.finishRun("run-trace-completed", "COMPLETED");
    traces.startRun({ runId: "run-trace-failed", goalId: "goal", orgId: "org" });
    traces.finishRun("run-trace-failed", "FAILED", "Tool investigation failed");
    const completed = traces.getRunTrace("run-trace-completed")!;
    const failed = traces.getRunTrace("run-trace-failed")!;
    assert.equal(completed.status, "COMPLETED");
    assert.equal(completed.events.at(-1)!.eventType, "AGENT_COMPLETED");
    assert.equal(failed.status, "FAILED");
    assert.equal(failed.events.at(-1)!.eventType, "AGENT_FAILED");
    assert.equal(failed.events.at(-1)!.error?.message, "Tool investigation failed");
  });

  it("generates unique run IDs and scopes retrieval by organization", () => {
    const first = createRunId();
    const second = createRunId();
    assert.notEqual(first, second);
    const traces = new RunTraceStore();
    traces.startRun({ runId: first, goalId: "goal", orgId: "org-a" });
    assert.ok(traces.getRunTrace(first, "org-a"));
    assert.equal(traces.getRunTrace(first, "org-b"), undefined);
  });
});
