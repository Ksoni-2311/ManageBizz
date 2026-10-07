import { GoogleProviderError } from "../googleOAuth/googleProviderError.js";

type GoogleApiErrorBody = {
  error?: {
    status?: string;
    errors?: Array<{ reason?: string }>;
  };
};

const scopeFailureReasons = new Set(["insufficientpermissions", "insufficient_scope"]);
const permissionFailureReasons = new Set(["forbidden", "permissiondenied", "accessdenied"]);
const knownGoogleStatuses = new Set(["failed_precondition", "resource_exhausted", "not_found", "unavailable"]);
const safeGoogleReasons = new Map([
  ["accessnotconfigured", "accessNotConfigured"],
  ["dailylimitexceeded", "dailyLimitExceeded"],
  ["domainpolicy", "domainPolicy"],
  ["failedprecondition", "failedPrecondition"],
  ["ratelimitexceeded", "rateLimitExceeded"],
  ["userratelimitexceeded", "userRateLimitExceeded"]
]);

export async function gmailApiError(response: Response): Promise<GoogleProviderError> {
  const body = await response.json().catch(() => ({})) as GoogleApiErrorBody;
  const reasons = body.error?.errors?.map(({ reason }) => reason?.toLowerCase()).filter((reason): reason is string => Boolean(reason)) ?? [];
  const googleStatus = body.error?.status?.toLowerCase();

  if (response.status === 401) {
    return new GoogleProviderError("EMAIL_AUTH_EXPIRED", "Gmail authorization expired. Reconnect Gmail.", 401);
  }
  if (response.status === 403) {
    if (reasons.some((reason) => scopeFailureReasons.has(reason))) {
      return new GoogleProviderError("EMAIL_AUTH_REQUIRED", "Google denied Gmail access because the required authorization scope is missing. Reconnect Gmail and approve the requested access.", 403);
    }
    if (reasons.some((reason) => permissionFailureReasons.has(reason)) || googleStatus === "permission_denied") {
      return new GoogleProviderError("EMAIL_ACCESS_DENIED", "Google denied access to this Gmail mailbox.", 403);
    }
    const safeStatus = googleStatus && knownGoogleStatuses.has(googleStatus) ? ` (${googleStatus})` : "";
    const safeReason = reasons.map((reason) => safeGoogleReasons.get(reason)).find(Boolean);
    return new GoogleProviderError("EMAIL_API_ERROR", `Gmail API rejected the request with HTTP 403${safeStatus}${safeReason ? ` (Google reason ${safeReason})` : ""}.`, 403);
  }
  return new GoogleProviderError("EMAIL_API_ERROR", "Gmail request failed.", response.status || 502);
}

export function healthForGmailError(code: string): "reauthorization_required" | "access_denied" | "unavailable" {
  if (code === "EMAIL_AUTH_EXPIRED" || code === "EMAIL_AUTH_REQUIRED") return "reauthorization_required";
  if (code === "EMAIL_ACCESS_DENIED") return "access_denied";
  return "unavailable";
}
