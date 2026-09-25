import { Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth.js";
import { manageBizzAgentApi } from "../agent/application/manageBizzAgentApi.js";
import { resolveWorkspaceScope } from "../middleware/workspace.js";

export const runAgent = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const goal = req.body?.goal;
  if (typeof goal !== "string" || !goal.trim()) {
    res.status(400).json({ success: false, error: "A non-empty goal is required." });
    return;
  }
  if (!req.user?.orgId || !req.user.userId) {
    res.status(403).json({ success: false, error: "An organization-scoped session is required." });
    return;
  }
  const orgId = resolveWorkspaceScope(req);
  if (!orgId) {
    res.status(400).json({ success: false, error: { code: "INVALID_WORKSPACE", message: "A valid ManageBizz workspace identifier is required." } });
    return;
  }
  const result = await manageBizzAgentApi.run({ goal: goal.trim(), orgId, userId: req.user.userId });
  res.json({ success: true, ...result });
};

export const getAgentRun = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const orgId = req.user ? resolveWorkspaceScope(req) : undefined;
  if (!orgId) {
    res.status(403).json({ success: false, error: "An organization-scoped session is required." });
    return;
  }
  const result = await manageBizzAgentApi.getRun(req.params.runId ?? "", orgId, req.user!.userId);
  if (!result) {
    res.status(404).json({ success: false, error: "Run was not found." });
    return;
  }
  res.json({ success: true, ...result });
};

export const decideAgentAction = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const { decision, feedback } = req.body ?? {};
  const orgId = req.user ? resolveWorkspaceScope(req) : undefined;
  if (!orgId || !req.user?.userId) {
    res.status(403).json({ success: false, error: "An organization-scoped session is required." });
    return;
  }
  if (!["APPROVE", "REJECT", "MODIFY"].includes(decision)) {
    res.status(400).json({ success: false, error: "A valid approval decision is required." });
    return;
  }
  const result = await manageBizzAgentApi.decideAction(
    req.params.runId ?? "", orgId, req.user.userId, req.params.proposalId ?? "", decision, req.user.userId, feedback
  );
  if (!result) {
    res.status(409).json({ success: false, error: "No matching pending action proposal was found." });
    return;
  }
  res.json({ success: true, ...result });
};
