import { randomUUID } from "node:crypto";
import { Request, Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth.js";
import { resolveWorkspaceScope } from "../middleware/workspace.js";
import { gmailOAuthService } from "../integrations/gmail/gmailOAuthService.js";
import { GoogleProviderError } from "../integrations/googleOAuth/googleProviderError.js";
import { EmailTool } from "../tools/emailTool.js";

function owner(req: AuthenticatedRequest, res: Response) {
  const { userId, orgId } = req.user ?? {}, workspaceId = orgId && userId ? resolveWorkspaceScope(req) : undefined;
  if (!workspaceId || !orgId || !userId) { res.status(403).json({ success: false, error: { code: "AUTH_REQUIRED", message: "An authenticated user and workspace are required." } }); return undefined; }
  return { workspaceId, userId };
}
function reportError(res: Response, error: unknown) {
  if (error instanceof GoogleProviderError) { res.status(error.status).json({ success: false, error: { code: error.code, message: error.message } }); return; }
  res.status(500).json({ success: false, error: { code: "EMAIL_INTEGRATION_ERROR", message: "Gmail integration request failed." } });
}
function context(identity: { workspaceId: string; userId: string }) { return { goalId: "email-activity", runId: `email-${randomUUID()}`, actionId: `email-${randomUUID()}`, userId: identity.userId, orgId: identity.workspaceId }; }
export const connectGmail = (req: AuthenticatedRequest, res: Response) => {
  const identity = owner(req, res); if (!identity) return;
  try { res.json({ success: true, authorizationUrl: gmailOAuthService.authorizationUrl(identity) }); } catch (error) { reportError(res, error); }
};
export const gmailCallback = async (req: Request, res: Response) => {
  const webUrl = (process.env.WEB_APP_URL ?? "http://localhost:3000").replace(/\/$/, ""), code = typeof req.query.code === "string" ? req.query.code : "", state = typeof req.query.state === "string" ? req.query.state : "";
  try { await gmailOAuthService.complete(code, state); res.redirect(`${webUrl}/?gmailConnection=connected`); }
  catch (error) { const reason = error instanceof GoogleProviderError ? error.code : "OAUTH_FAILED"; res.redirect(`${webUrl}/?gmailConnection=error&reason=${encodeURIComponent(reason)}`); }
};
export const gmailStatus = async (req: AuthenticatedRequest, res: Response) => {
  const identity = owner(req, res); if (!identity) return;
  try { const status = await gmailOAuthService.status(identity); const provider = await EmailTool.connectionStatus(context(identity)); res.json({ success: true, status: !status.connected ? "disconnected" : provider.reauthorizationRequired ? "reauthorization_required" : "connected", connectedAt: status.connectedAt }); }
  catch (error) { reportError(res, error); }
};
export const disconnectGmail = async (req: AuthenticatedRequest, res: Response) => {
  const identity = owner(req, res); if (!identity) return;
  try { await gmailOAuthService.disconnect(identity); res.json({ success: true, status: "disconnected" }); } catch (error) { reportError(res, error); }
};
export const emailActivity = async (req: AuthenticatedRequest, res: Response) => {
  const identity = owner(req, res); if (!identity) return;
  const query = typeof req.query.q === "string" ? req.query.q : "newer_than:30d";
  const result = await EmailTool.getEmailHistory({ query }, context(identity));
  if (!result.success) {
    const status = result.error.code === "EMAIL_NOT_CONNECTED" ? 409 : result.error.code === "EMAIL_AUTH_EXPIRED" ? 401 : result.error.code === "EMAIL_RATE_LIMITED" ? 429 : result.error.code === "INVALID_INPUT" ? 400 : 503;
    res.status(status).json({ success: false, error: result.error }); return;
  }
  res.json({ success: true, data: result.data });
};
