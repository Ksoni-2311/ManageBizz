import { Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth.js";
import { runTraceStore } from "../agent/runtime/runTrace.js";
import { resolveWorkspaceScope } from "../middleware/workspace.js";

export const getRunTrace = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const runId = req.params.runId;
  const orgId = req.user ? resolveWorkspaceScope(req) : undefined;
  if (!runId || !orgId) {
    res.status(403).json({ success: false, error: "An organization-scoped session is required." });
    return;
  }
  const trace = runTraceStore.getRunTrace(runId, orgId, req.user!.userId);
  if (!trace) {
    res.status(404).json({ success: false, error: "Run trace was not found." });
    return;
  }
  res.json({ success: true, trace });
};
