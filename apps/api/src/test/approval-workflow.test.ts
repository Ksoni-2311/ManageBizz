import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ApprovalActionWorkflow } from "../agent/runtime/approvalWorkflow.js";
import { ControlledAgentOrchestrator, PlannedToolCall } from "../agent/runtime/controlledOrchestrator.js";
import { ToolExecutionContext, ToolResponse } from "@nexusops/shared-types";

const context: ToolExecutionContext = { goalId: "goal", runId: "approval-run", actionId: "action-1", userId: "user", orgId: "org" };
const taskAction: PlannedToolCall = { tool: "tasks", action: "completeTask", params: { taskId: "task-target" }, purpose: "Complete the supplied task." };
const verifiedResult: ToolResponse = {
  success: true,
  data: { updated: true, task: { id: "task-target", title: "Task", status: "COMPLETED" } }
};
const failedResult: ToolResponse = { success: false, error: { code: "NOT_FOUND", message: "Task not found." } };
const objective = { objective: "Complete task task-target", timeWindowDays: 30, constraints: [], successCriteria: [] };

describe("approval and action verification workflow", () => {
  it("records a proposed action and waits before executing it", async () => {
    const workflow = new ApprovalActionWorkflow();
    let executed = false;
    const pending = workflow.proposeExecuteVerify(taskAction, context, async () => { executed = true; return verifiedResult; });
    const proposal = workflow.list()[0]!;
    assert.equal(proposal.lifecycle, "PROPOSED");
    assert.equal(proposal.approvalStatus, "PENDING");
    assert.equal(executed, false);
    assert.equal(await workflow.decide(proposal.id, "APPROVE", "reviewer"), true);
    await pending;
  });

  it("executes and verifies an approved action", async () => {
    const updates: string[] = [];
    const workflow = new ApprovalActionWorkflow({ onUpdate: (proposal) => { updates.push(proposal.lifecycle); } });
    const pending = workflow.proposeExecuteVerify(taskAction, context, async () => verifiedResult);
    const proposal = workflow.list()[0]!;
    await workflow.decide(proposal.id, "APPROVE", "reviewer");
    const result = await pending;
    assert.equal(result.success, true);
    assert.deepEqual(updates, ["PROPOSED", "APPROVED", "EXECUTING", "EXECUTED", "VERIFYING", "VERIFIED"]);
    assert.equal(workflow.list()[0]!.verification, "VERIFIED");
  });

  it("rejects an action without executing it", async () => {
    const workflow = new ApprovalActionWorkflow();
    let executions = 0;
    const pending = workflow.proposeExecuteVerify(taskAction, context, async () => { executions++; return verifiedResult; });
    const proposal = workflow.list()[0]!;
    await workflow.decide(proposal.id, "REJECT", "reviewer", "Not needed.");
    const result = await pending;
    assert.equal(result.success, false);
    if (!result.success) assert.equal(result.error.code, "APPROVAL_REJECTED");
    assert.equal(executions, 0);
    assert.equal(workflow.list()[0]!.lifecycle, "REJECTED");
  });

  it("records action execution failures", async () => {
    const workflow = new ApprovalActionWorkflow();
    const pending = workflow.proposeExecuteVerify(taskAction, context, async () => failedResult);
    const proposal = workflow.list()[0]!;
    await workflow.decide(proposal.id, "APPROVE", "reviewer");
    const result = await pending;
    assert.equal(result.success, false);
    assert.equal(workflow.list()[0]!.lifecycle, "FAILED");
  });

  it("marks an action verified only when the returned entity confirms completion", async () => {
    const workflow = new ApprovalActionWorkflow();
    const pending = workflow.proposeExecuteVerify(taskAction, context, async () => verifiedResult);
    const proposal = workflow.list()[0]!;
    await workflow.decide(proposal.id, "APPROVE", "reviewer");
    await pending;
    assert.equal(workflow.list()[0]!.lifecycle, "VERIFIED");
  });

  it("fails verification when a successful tool response does not confirm the mutation", async () => {
    const workflow = new ApprovalActionWorkflow();
    const malformed: ToolResponse = { success: true, data: { updated: true, task: { id: "task-target", status: "OPEN" } } };
    const pending = workflow.proposeExecuteVerify(taskAction, context, async () => malformed);
    const proposal = workflow.list()[0]!;
    await workflow.decide(proposal.id, "APPROVE", "reviewer");
    const result = await pending;
    assert.equal(result.success, false);
    if (!result.success) assert.equal(result.error.code, "VERIFICATION_FAILED");
    assert.equal(workflow.list()[0]!.lifecycle, "VERIFICATION_FAILED");
  });

  it("does not report successful completion after rejection and auto-runs read-only calls", async () => {
    const workflow = new ApprovalActionWorkflow();
    const runPromise = new ControlledAgentOrchestrator(async (call, toolContext) =>
      workflow.proposeExecuteVerify(call, toolContext, async () => verifiedResult)
    ).run(objective, { goalId: context.goalId, runId: context.runId, userId: context.userId, orgId: context.orgId });
    const proposal = workflow.list()[0]!;
    await workflow.decide(proposal.id, "REJECT", "reviewer");
    const rejectedRun = await runPromise;
    assert.equal(rejectedRun.status, "failed");
    assert.doesNotMatch(rejectedRun.finalText, /FACT: Completed task/);
    assert.match(rejectedRun.finalText, /no task action was executed/);

    const readOnlyWorkflow = new ApprovalActionWorkflow();
    let readCalls = 0;
    const readResult = await readOnlyWorkflow.proposeExecuteVerify(
      { tool: "crm", action: "searchLeads", params: {}, purpose: "Read only" },
      context,
      async () => { readCalls++; return { success: true, data: [] }; }
    );
    assert.equal(readResult.success, true);
    assert.equal(readCalls, 1);
    assert.deepEqual(readOnlyWorkflow.list(), []);
  });
});
