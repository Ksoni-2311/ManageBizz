import { Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth.js";
import { resolveWorkspaceScope } from "../middleware/workspace.js";
import { CRMIngestionError, crmIngestionService } from "../services/crmIngestionService.js";

function uploadScope(req: AuthenticatedRequest, res: Response): string | undefined {
  const workspaceId = req.user?.orgId && req.user.userId ? resolveWorkspaceScope(req) : undefined;
  if (!workspaceId) {
    res.status(400).json({
      success: false,
      error: { code: "INVALID_WORKSPACE", message: "A valid ManageBizz workspace identifier is required." }
    });
  }
  return workspaceId;
}

function sendError(res: Response, error: unknown): void {
  if (error instanceof CRMIngestionError) {
    res.status(error.statusCode).json({
      success: false,
      error: { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) }
    });
    return;
  }
  res.status(500).json({
    success: false,
    error: { code: "CRM_STORAGE_ERROR", message: "CRM data could not be read or stored." }
  });
}

export const getCurrentCRM = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const workspaceId = uploadScope(req, res);
  if (!workspaceId) return;
  try {
    res.json({ success: true, crm: await crmIngestionService.current(workspaceId, req.user!.userId) });
  } catch (error) {
    sendError(res, error);
  }
};

export const previewCRMImport = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const workspaceId = uploadScope(req, res);
  if (!workspaceId) return;
  const fileName = req.get("x-file-name") ?? "";
  const contentType = req.get("x-file-type") ?? "";
  if (!Buffer.isBuffer(req.body)) {
    res.status(400).json({ success: false, error: { code: "FILE_REQUIRED", message: "Choose a .xlsx or .csv CRM file." } });
    return;
  }
  try {
    const preview = await crmIngestionService.preview({ workspaceId, ownerUserId: req.user!.userId, fileName, contentType, bytes: req.body });
    res.json({ success: true, preview });
  } catch (error) {
    sendError(res, error);
  }
};

export const confirmCRMImport = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const workspaceId = uploadScope(req, res);
  if (!workspaceId) return;
  const { previewId, confirm } = req.body ?? {};
  if (typeof previewId !== "string" || !previewId.trim() || typeof confirm !== "boolean") {
    res.status(400).json({
      success: false,
      error: { code: "INVALID_CONFIRMATION", message: "previewId and an explicit boolean confirm value are required." }
    });
    return;
  }
  try {
    const imported = await crmIngestionService.confirm(workspaceId, previewId, confirm);
    res.json({
      success: true,
      imported: {
        sourceName: imported.sourceName,
        importedAt: imported.importedAt,
        recordCount: imported.leads.length
      }
    });
  } catch (error) {
    sendError(res, error);
  }
};
