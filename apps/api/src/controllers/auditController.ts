import { Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth.js";
import { AuditLogModel } from "../models/AuditLog.js";
import { resolveWorkspaceScope } from "../middleware/workspace.js";

export const getAuditLogs = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const workspaceId = resolveWorkspaceScope(req);
    if (!workspaceId || !req.user?.userId) { res.status(401).json({ success: false, error: { code: "AUTH_REQUIRED", message: "Sign in is required." } }); return; }
    const logs = await AuditLogModel.find({ orgId: workspaceId, userId: req.user.userId }).sort({ timestamp: -1 }).limit(50);
    res.json({ success: true, logs });
  } catch {
    res.status(503).json({ success: false, error: { code: "AUDIT_STORAGE_UNAVAILABLE", message: "Audit data is unavailable." } });
  }
};
