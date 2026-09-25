import { io, Socket } from "socket.io-client";
import { useAgentStore } from "../store/useAgentStore.js";
import { AgentState, RiskLevel, ApprovalStatus } from "@nexusops/shared-types";
import { getSessionToken } from "./manageBizzClient.js";

let socket: Socket | null = null;

export function initializeSocket() {
  if (socket) return socket;

  socket = io(window.location.origin || "http://localhost:5000", {
    transports: ["websocket", "polling"],
    auth: { token: getSessionToken() }
  });

  socket.on("connect", () => {
    console.log("[Socket.IO Client] Connected to NexusOps API Server");
  });

  socket.on("agent.state.changed", (data: { runId: string; toState: AgentState; reason?: string }) => {
    useAgentStore.getState().updateState(data.toState, data.reason);
  });

  socket.on("agent.plan.created", (data: { steps: any[] }) => {
    useAgentStore.getState().setPlan(data.steps);
    useAgentStore.getState().addTimelineEvent({
      timestamp: new Date().toLocaleTimeString(),
      type: "plan",
      title: "Action Plan Formulated",
      details: `Generated ${data.steps.length} executable steps`
    });
  });

  socket.on("agent.approval.required", (data: { stepId: string; tool: string; action: string; params: any; riskLevel: RiskLevel; reason: string }) => {
    const approval = {
      id: data.stepId,
      runId: useAgentStore.getState().activeRunId || "",
      goalId: useAgentStore.getState().activeGoalId || "",
      stepId: data.stepId,
      tool: data.tool,
      action: data.action,
      params: data.params,
      riskLevel: data.riskLevel,
      reason: data.reason,
      status: ApprovalStatus.PENDING,
      requestedAt: new Date().toISOString()
    };

    useAgentStore.getState().addApprovalRequired(approval);
    useAgentStore.getState().addTimelineEvent({
      timestamp: new Date().toLocaleTimeString(),
      type: "approval",
      title: `Approval Required: ${data.tool}.${data.action}`,
      details: data.reason
    });
  });

  socket.on("agent.action.completed", (data: { stepId: string; result: any }) => {
    useAgentStore.getState().addTimelineEvent({
      timestamp: new Date().toLocaleTimeString(),
      type: "action",
      title: "Tool Action Executed Successfully",
      details: JSON.stringify(data.result)
    });
  });

  return socket;
}

export function disconnectSocket() {
  socket?.disconnect();
  socket = null;
}

export async function createGoalApi(prompt: string, timeWindowDays = 30) {
  const token = getSessionToken();
  const res = await fetch("/api/goals", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ prompt, timeWindowDays })
  });
  return res.json();
}

export async function submitApprovalApi(approvalId: string, runId: string, stepId: string, decision: "APPROVE" | "REJECT" | "MODIFY", feedback?: string) {
  const token = getSessionToken();
  const res = await fetch(`/api/plans/${approvalId}/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ runId, stepId, decision, feedback })
  });
  return res.json();
}
