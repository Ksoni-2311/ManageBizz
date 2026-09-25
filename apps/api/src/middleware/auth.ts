import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { config } from "../config/index.js";
import { UserRole, JwtPayload } from "@nexusops/shared-types";
import { BusinessOwner, workspaceIdFor } from "../domain/businessData.js";
import { UserModel } from "../models/User.js";

export interface AuthenticatedRequest extends Request {
  user?: JwtPayload;
  businessOwner?: BusinessOwner;
}

type AuthUser = { _id: unknown; email: string; role: UserRole; orgId: string; sessionVersion: number };
export type UserLookup = (userId: string) => Promise<AuthUser | null>;

export function createAuthenticateToken(findUser: UserLookup = (userId) => UserModel.findById(userId).select("_id email role orgId sessionVersion").lean() as Promise<AuthUser | null>) {
  return async function authenticateToken(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers["authorization"];
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  if (!token) { res.status(401).json({ success: false, error: { code: "AUTH_REQUIRED", message: "A valid bearer session is required." } }); return; }
  if (!config.jwtSecret || config.jwtSecret.length < 32) {
    res.status(503).json({ success: false, error: { code: "AUTH_CONFIGURATION_ERROR", message: "The API session signing key is not configured securely." } });
    return;
  }

  let claims: JwtPayload;
  try {
    const decoded = jwt.verify(token, config.jwtSecret, { algorithms: ["HS256"], issuer: "managebizz", audience: "managebizz-api" });
    if (typeof decoded === "string" || !isSessionClaims(decoded) || decoded.sub !== decoded.userId) throw new Error("Invalid session claims.");
    claims = decoded as JwtPayload;
  } catch {
    res.status(401).json({ success: false, error: { code: "SESSION_INVALID", message: "The session is invalid or expired. Sign in again." } });
    return;
  }
  try {
    const storedUser = await findUser(claims.userId);
    if (!storedUser || String(storedUser._id) !== claims.userId || storedUser.email !== claims.email || storedUser.orgId !== claims.orgId || storedUser.sessionVersion !== (claims as JwtPayload & { sessionVersion?: number }).sessionVersion) {
      res.status(401).json({ success: false, error: { code: "SESSION_REVOKED", message: "The account session is no longer valid. Sign in again." } });
      return;
    }
    const userId = String(storedUser._id);
    const workspaceId = workspaceIdFor(storedUser.orgId, userId);
    req.user = { userId, email: storedUser.email, role: storedUser.role, orgId: storedUser.orgId,
      ...(claims.iat === undefined ? {} : { iat: claims.iat }), ...(claims.exp === undefined ? {} : { exp: claims.exp }) };
    req.businessOwner = { userId, organizationId: storedUser.orgId, workspaceId };
    next();
  } catch {
    res.status(503).json({ success: false, error: { code: "AUTH_STORAGE_UNAVAILABLE", message: "The account could not be verified. Please try again." } });
  }
  };
}
export const authenticateToken = createAuthenticateToken();

function isSessionClaims(value: jwt.JwtPayload | string): value is jwt.JwtPayload & JwtPayload {
  if (typeof value === "string") return false;
  return typeof value.userId === "string" && value.userId.length > 0
    && typeof value.email === "string" && value.email.length > 0
    && typeof value.orgId === "string" && value.orgId.length > 0
    && Object.values(UserRole).includes(value.role as UserRole);
}

/** Route guard for APIs that require authenticated, server-derived ownership. */
export function requireAuthenticatedIdentity(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  if (!req.user || !req.businessOwner) {
    res.status(401).json({ success: false, error: { code: "AUTH_REQUIRED", message: "An authenticated user and workspace are required." } });
    return;
  }
  next();
}

export function signSession(payload: Omit<JwtPayload, "iat" | "exp"> & { sessionVersion?: number }): string {
  if (!config.jwtSecret || config.jwtSecret.length < 32) throw new Error("JWT_SECRET must contain at least 32 characters.");
  return jwt.sign({ ...payload, sessionVersion: payload.sessionVersion ?? 0 }, config.jwtSecret, { algorithm: "HS256", issuer: "managebizz", audience: "managebizz-api", subject: payload.userId, expiresIn: "8h" });
}

export function requireRole(roles: UserRole[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ success: false, error: "Authentication required" });
      return;
    }

    if (!roles.includes(req.user.role)) {
      res.status(403).json({ success: false, error: "Forbidden: insufficient permissions" });
      return;
    }

    next();
  };
}
