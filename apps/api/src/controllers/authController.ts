import { randomUUID } from "node:crypto";
import { Response } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { AuthenticatedRequest, signSession } from "../middleware/auth.js";
import { UserModel } from "../models/User.js";
import { workspaceIdFor } from "../domain/businessData.js";
import { config } from "../config/index.js";

const registerSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  email: z.string().trim().email().max(254),
  password: z.string().min(12).max(128)
}).strict();
const loginSchema = z.object({ email: z.string().trim().email().max(254), password: z.string().min(1).max(128) }).strict();

function publicUser(user: { _id: unknown; name: string; email: string; role: string; orgId: string }) {
  const id = String(user._id);
  return { id, name: user.name, email: user.email, role: user.role, workspaceId: workspaceIdFor(user.orgId, id) };
}
function unavailable(res: Response) { res.status(503).json({ success: false, error: { code: "AUTH_STORAGE_UNAVAILABLE", message: "Authentication storage is unavailable. Please try again later." } }); }

export const register = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, error: { code: "INVALID_REGISTRATION", message: "Provide a valid name, email, and password of at least 12 characters." } }); return; }
  try {
    const email = parsed.data.email.toLowerCase();
    const existing = await UserModel.findOne({ email });
    if (existing) { res.status(409).json({ success: false, error: { code: "ACCOUNT_EXISTS", message: "An account with this email already exists." } }); return; }
    // Each new account receives its own server-created organization/workspace boundary.
    const user = await UserModel.create({ name: parsed.data.name ?? email.split("@")[0], email, passwordHash: await bcrypt.hash(parsed.data.password, 12), role: "MEMBER", orgId: `org-${randomUUID()}`, sessionVersion: 0 });
    let token: string;
    try { token = signSession({ userId: user._id.toString(), email: user.email, role: user.role, orgId: user.orgId, sessionVersion: user.sessionVersion }); }
    catch { await UserModel.deleteOne({ _id: user._id }); res.status(503).json({ success: false, error: { code: "AUTH_CONFIGURATION_ERROR", message: "Session signing is not securely configured." } }); return; }
    res.status(201).json({ success: true, token, user: publicUser(user) });
  } catch (error) {
    if (isDuplicateKey(error)) { res.status(409).json({ success: false, error: { code: "ACCOUNT_EXISTS", message: "An account with this email already exists." } }); return; }
    unavailable(res);
  }
};

export const login = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, error: { code: "INVALID_CREDENTIALS", message: "Provide a valid email and password." } }); return; }
  try {
    const user = await UserModel.findOne({ email: parsed.data.email.toLowerCase() });
    if (!user || !(await bcrypt.compare(parsed.data.password, user.passwordHash))) { res.status(401).json({ success: false, error: { code: "INVALID_CREDENTIALS", message: "Email or password is incorrect." } }); return; }
    let token: string;
    try { token = signSession({ userId: user._id.toString(), email: user.email, role: user.role, orgId: user.orgId, sessionVersion: user.sessionVersion }); }
    catch { res.status(503).json({ success: false, error: { code: "AUTH_CONFIGURATION_ERROR", message: "Session signing is not securely configured." } }); return; }
    res.json({ success: true, token, user: publicUser(user) });
  } catch { unavailable(res); }
};

export const logout = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  if (!req.user) { res.status(401).json({ success: false, error: { code: "AUTH_REQUIRED", message: "Sign in is required." } }); return; }
  try {
    const result = await UserModel.updateOne({ _id: req.user.userId, orgId: req.user.orgId }, { $inc: { sessionVersion: 1 } });
    if (result.matchedCount === 0) { res.status(401).json({ success: false, error: { code: "SESSION_REVOKED", message: "This account session is no longer valid." } }); return; }
    res.json({ success: true, status: "signed_out" });
  } catch { unavailable(res); }
};

export const getMe = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  if (!req.user) { res.status(401).json({ success: false, error: { code: "AUTH_REQUIRED", message: "Sign in is required." } }); return; }
  if (config.mvpMode) {
    res.json({ success: true, user: {
      id: req.user.userId,
      name: "MVP Development User",
      email: req.user.email,
      role: req.user.role,
      workspaceId: workspaceIdFor(req.user.orgId, req.user.userId)
    } });
    return;
  }
  try {
    const user = await UserModel.findById(req.user.userId);
    if (!user || user.orgId !== req.user.orgId) { res.status(401).json({ success: false, error: { code: "SESSION_REVOKED", message: "This account session is no longer valid." } }); return; }
    res.json({ success: true, user: publicUser(user) });
  } catch { unavailable(res); }
};

function isDuplicateKey(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && (error as {code?: unknown}).code === 11000; }
