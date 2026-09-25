import { Request } from "express";
import { AuthenticatedRequest } from "./auth.js";
import { workspaceIdFor } from "../domain/businessData.js";

/** Derive ownership only from authenticated server-side identity. Browser workspace headers are ignored. */
export function resolveWorkspaceScope(request: Request): string | undefined {
  const identity = (request as AuthenticatedRequest).user;
  const organizationId = identity?.orgId;
  const ownerUserId = identity?.userId;
  if (!organizationId || !ownerUserId) return undefined;
  return workspaceIdFor(organizationId, ownerUserId);
}

export function getWorkspaceId(request: Request): string | undefined {
  const identity = (request as AuthenticatedRequest).user;
  return resolveWorkspaceScope(request);
}
