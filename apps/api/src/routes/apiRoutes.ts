import express, { Router } from "express";
import { authenticateToken } from "../middleware/auth.js";
import * as authCtrl from "../controllers/authController.js";
import * as goalsCtrl from "../controllers/goalsController.js";
import * as plansCtrl from "../controllers/plansController.js";
import * as auditCtrl from "../controllers/auditController.js";
import * as runTraceCtrl from "../controllers/runTraceController.js";
import * as agentApplicationCtrl from "../controllers/agentApplicationController.js";
import * as crmUploadCtrl from "../controllers/crmUploadController.js";
import * as googleCalendarCtrl from "../controllers/googleCalendarController.js";
import * as gmailCtrl from "../controllers/gmailController.js";

const router: Router = Router();

// 1. Auth Routes
router.post("/auth/register", authCtrl.register);
router.post("/auth/login", authCtrl.login);
router.get("/auth/me", authenticateToken, authCtrl.getMe);
router.post("/auth/logout", authenticateToken, authCtrl.logout);

// 2. Goal Routes
router.post("/goals", authenticateToken, goalsCtrl.createGoal);
router.get("/goals", authenticateToken, goalsCtrl.getGoals);
router.get("/goals/:id", authenticateToken, goalsCtrl.getGoalById);
router.post("/goals/:id/cancel", authenticateToken, goalsCtrl.cancelGoal);
router.get("/runs/:runId/trace", authenticateToken, runTraceCtrl.getRunTrace);
router.get("/crm/current", authenticateToken, crmUploadCtrl.getCurrentCRM);
router.post("/crm/imports/preview", authenticateToken, express.raw({ type: "application/octet-stream", limit: "10mb" }), crmUploadCtrl.previewCRMImport);
router.post("/crm/imports/confirm", authenticateToken, crmUploadCtrl.confirmCRMImport);
router.get("/integrations/google-calendar/connect", authenticateToken, googleCalendarCtrl.connectGoogleCalendar);
router.get("/integrations/google-calendar/callback", googleCalendarCtrl.googleCalendarCallback);
router.get("/integrations/google-calendar/status", authenticateToken, googleCalendarCtrl.googleCalendarStatus);
router.delete("/integrations/google-calendar", authenticateToken, googleCalendarCtrl.disconnectGoogleCalendar);
router.get("/calendar/events/upcoming", authenticateToken, googleCalendarCtrl.upcomingCalendarEvents);
router.get("/integrations/gmail/connect", authenticateToken, gmailCtrl.connectGmail);
router.get("/integrations/gmail/callback", gmailCtrl.gmailCallback);
router.get("/integrations/gmail/status", authenticateToken, gmailCtrl.gmailStatus);
router.delete("/integrations/gmail", authenticateToken, gmailCtrl.disconnectGmail);
router.get("/email/activity", authenticateToken, gmailCtrl.emailActivity);
router.post("/agent/runs", authenticateToken, agentApplicationCtrl.runAgent);
router.get("/agent/runs/:runId", authenticateToken, agentApplicationCtrl.getAgentRun);
router.post("/agent/runs/:runId/approvals/:proposalId", authenticateToken, agentApplicationCtrl.decideAgentAction);

// 3. Plan & Approval Routes
router.post("/plans/:id/approve", authenticateToken, plansCtrl.approvePlanStep);

// 4. Audit Routes
router.get("/audit", authenticateToken, auditCtrl.getAuditLogs);

export default router;
