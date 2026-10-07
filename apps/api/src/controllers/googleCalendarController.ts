import { Request, Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth.js";
import { resolveWorkspaceScope } from "../middleware/workspace.js";
import { GoogleCalendarOAuthError, googleCalendarOAuthService } from "../integrations/googleCalendar/googleCalendarOAuthService.js";

function owner(req: AuthenticatedRequest, res: Response): { workspaceId: string; userId: string; orgId: string } | undefined {
  const { userId, orgId } = req.user ?? {};
  const workspaceId = orgId && userId ? resolveWorkspaceScope(req) : undefined;
  if (!workspaceId || !orgId || !userId) {
    res.status(403).json({ success: false, error: { code: "AUTH_REQUIRED", message: "An authenticated user and workspace are required." } });
    return undefined;
  }
  return { workspaceId, userId, orgId };
}

function errorResponse(res: Response, error: unknown): void {
  if (error instanceof GoogleCalendarOAuthError) {
    res.status(error.status).json({ success: false, error: { code: error.code, message: error.message } });
    return;
  }
  res.status(500).json({ success: false, error: { code: "CALENDAR_INTEGRATION_ERROR", message: "Google Calendar integration request failed." } });
}

export const connectGoogleCalendar = (req: AuthenticatedRequest, res: Response): void => {
  const identity = owner(req, res);
  if (!identity) return;
  try {
    res.json({ success: true, authorizationUrl: googleCalendarOAuthService.authorizationUrl(identity) });
  } catch (error) { errorResponse(res, error); }
};

export const googleCalendarCallback = async (req: Request, res: Response): Promise<void> => {
  const webUrl = (process.env.WEB_APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
  const code = typeof req.query.code === "string" ? req.query.code : "";
  const state = typeof req.query.state === "string" ? req.query.state : "";
  try {
    await googleCalendarOAuthService.complete(code, state);
    res.redirect(`${webUrl}/?calendarConnection=connected`);
  } catch (error) {
    const reason = error instanceof GoogleCalendarOAuthError ? error.code : "OAUTH_FAILED";
    res.redirect(`${webUrl}/?calendarConnection=error&reason=${encodeURIComponent(reason)}`);
  }
};

export const googleCalendarStatus = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const identity = owner(req, res);
  if (!identity) return;
  try {
    const status = await googleCalendarOAuthService.status(identity);
    res.json({ success: true,
      status: !status.connected ? "disconnected" : status.reauthorizationRequired ? "reauthorization_required" : status.accessDenied ? "access_denied" : status.unavailable ? "unavailable" : "connected"
    });
  } catch (error) { errorResponse(res, error); }
};

export const disconnectGoogleCalendar = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const identity = owner(req, res);
  if (!identity) return;
  try {
    await googleCalendarOAuthService.disconnect(identity);
    res.json({ success: true, status: "disconnected" });
  } catch (error) { errorResponse(res, error); }
};
