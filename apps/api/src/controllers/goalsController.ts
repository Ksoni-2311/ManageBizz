import { Response } from "express";
import { z } from "zod";
import { AuthenticatedRequest } from "../middleware/auth.js";
import { resolveWorkspaceScope } from "../middleware/workspace.js";
import { GoalModel } from "../models/Goal.js";
import { AgentRunModel } from "../models/AgentRun.js";
import { GoalStatus, AgentState } from "@nexusops/shared-types";
import { AgentEngine } from "../agent/runtime/agentEngine.js";
import { createRunId } from "../agent/runtime/runTrace.js";

type ActiveRun = { engine: AgentEngine; workspaceId: string; userId: string; goalId: string };
export const activeEnginesMap = new Map<string, ActiveRun>();
const goalSchema = z.object({ prompt: z.string().trim().min(1).max(2000), timeWindowDays: z.number().int().positive().max(3650).optional(), constraints: z.array(z.string().trim().min(1).max(500)).max(50).optional() }).passthrough();
function ownership(req: AuthenticatedRequest) {
  if (!req.user?.userId) return undefined;
  const workspaceId = resolveWorkspaceScope(req);
  return workspaceId ? { workspaceId, userId: req.user.userId } : undefined;
}
function unavailable(res: Response) { res.status(503).json({ success: false, error: { code: "BUSINESS_STORAGE_UNAVAILABLE", message: "Goal storage is unavailable. No goal was created." } }); }

export const createGoal = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const identity = ownership(req), parsed = goalSchema.safeParse(req.body);
  if (!identity) { res.status(401).json({ success: false, error: { code: "AUTH_REQUIRED", message: "Sign in is required." } }); return; }
  if (!parsed.success) { res.status(400).json({ success: false, error: { code: "INVALID_GOAL", message: "Provide a non-empty prompt and valid goal options." } }); return; }
  try {
    const goal = await GoalModel.create({ orgId: identity.workspaceId, createdById: identity.userId, rawPrompt: parsed.data.prompt, status: GoalStatus.ACTIVE, createdAt: new Date(), updatedAt: new Date() });
    const goalId = goal._id.toString(), runId = createRunId();
    await AgentRunModel.create({ _id: runId, goalId, orgId: identity.workspaceId, userId: identity.userId, currentState: AgentState.IDLE,
      stateHistory: [{ fromState: AgentState.IDLE, toState: AgentState.IDLE, timestamp: new Date() }], startedAt: new Date() });
    const engine = new AgentEngine(runId, goalId, identity.workspaceId, identity.userId);
    activeEnginesMap.set(runId, { engine, workspaceId: identity.workspaceId, userId: identity.userId, goalId });
    setTimeout(() => { void engine.startExecution(parsed.data.prompt); }, 100);
    res.status(201).json({ success: true, goal: { id: goalId, rawPrompt: parsed.data.prompt, status: GoalStatus.ACTIVE }, runId });
  } catch { unavailable(res); }
};

export const getGoals = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const identity = ownership(req); if (!identity) { res.status(401).json({ success: false, error: { code: "AUTH_REQUIRED", message: "Sign in is required." } }); return; }
  try {
    const goals = await GoalModel.find({ orgId: identity.workspaceId, createdById: identity.userId }).sort({ createdAt: -1 }).limit(20);
    res.json({ success: true, goals });
  } catch { unavailable(res); }
};

export const getGoalById = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const identity = ownership(req); if (!identity) { res.status(401).json({ success: false, error: { code: "AUTH_REQUIRED", message: "Sign in is required." } }); return; }
  try {
    const goal = await GoalModel.findOne({ _id: req.params.id, orgId: identity.workspaceId, createdById: identity.userId });
    if (!goal) { res.status(404).json({ success: false, error: { code: "GOAL_NOT_FOUND", message: "Goal was not found." } }); return; }
    res.json({ success: true, goal });
  } catch { res.status(404).json({ success: false, error: { code: "GOAL_NOT_FOUND", message: "Goal was not found." } }); }
};

export const cancelGoal = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const identity = ownership(req); if (!identity) { res.status(401).json({ success: false, error: { code: "AUTH_REQUIRED", message: "Sign in is required." } }); return; }
  try {
    const result = await GoalModel.updateOne({ _id: req.params.id, orgId: identity.workspaceId, createdById: identity.userId }, { $set: { status: GoalStatus.CANCELLED, updatedAt: new Date() } });
    if (result.matchedCount === 0) { res.status(404).json({ success: false, error: { code: "GOAL_NOT_FOUND", message: "Goal was not found." } }); return; }
    res.json({ success: true, status: GoalStatus.CANCELLED });
  } catch { unavailable(res); }
};
