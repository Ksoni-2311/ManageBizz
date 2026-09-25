import { Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth.js";
import { activeEnginesMap } from "./goalsController.js";
import { resolveWorkspaceScope } from "../middleware/workspace.js";

export const approvePlanStep = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params; // approvalId or stepId
    const { runId, stepId, decision, feedback } = req.body;
    if (!runId || !["APPROVE", "REJECT", "MODIFY"].includes(decision)) {
      res.status(400).json({ success: false, error: "runId and a valid decision are required." });
      return;
    }
    const workspaceId = resolveWorkspaceScope(req);
    const owner = activeEnginesMap.get(runId);
    if (!workspaceId || !req.user?.userId || !owner || owner.workspaceId !== workspaceId || owner.userId !== req.user.userId) {
      res.status(404).json({ success: false, error: "No active run is awaiting this approval." });
      return;
    }
    const accepted = await owner.engine.resumeAfterApproval(stepId || id, decision, feedback, req.user.userId);
    if (!accepted) {
      res.status(409).json({ success: false, error: "No matching pending proposal was found; no approval was recorded." });
      return;
    }
    res.json({ success: true, message: `Decision recorded as ${decision}; action execution continues only if approved.` });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
};
