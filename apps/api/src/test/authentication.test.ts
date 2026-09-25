import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Response } from "express";
import { UserRole } from "@nexusops/shared-types";
import { config } from "../config/index.js";
import { AuthenticatedRequest, authenticateToken, createAuthenticateToken, signSession } from "../middleware/auth.js";
import { resolveWorkspaceScope } from "../middleware/workspace.js";
import { workspaceIdFor } from "../domain/businessData.js";
import { register } from "../controllers/authController.js";

function responseMock() {
  const state: { statusCode?: number; body?: unknown } = {};
  const response = {
    status(code: number) { state.statusCode = code; return this; },
    json(value: unknown) { state.body = value; return this; }
  } as unknown as Response;
  return { response, state };
}

describe("authenticated identity and workspace boundaries", () => {
  it("rejects missing and invalid bearer sessions without a demo identity", async () => {
    const noToken = { headers: {} } as AuthenticatedRequest;
    const noTokenResponse = responseMock();
    let continued = false;
    await authenticateToken(noToken, noTokenResponse.response, () => { continued = true; });
    assert.equal(continued, false);
    assert.equal(noTokenResponse.state.statusCode, 401);
    assert.equal(noToken.user, undefined);

    config.jwtSecret = "unit-test-secret-that-is-at-least-32-bytes-long";
    const invalid = { headers: { authorization: "Bearer forged" } } as AuthenticatedRequest;
    const invalidResponse = responseMock();
    await authenticateToken(invalid, invalidResponse.response, () => { continued = true; });
    assert.equal(invalidResponse.state.statusCode, 401);
    assert.equal(invalid.user, undefined);
  });

  it("derives identity from the signed session and ignores browser owner/workspace values", async () => {
    config.jwtSecret = "unit-test-secret-that-is-at-least-32-bytes-long";
    const token = signSession({ userId: "account-a", email: "a@example.test", role: UserRole.MEMBER, orgId: "server-org-a" });
    const request = { headers: { authorization: `Bearer ${token}`, "x-managebizz-workspace": "attacker-workspace" }, body: { userId: "account-b", workspaceId: "account-b-workspace", ownerId: "account-b" } } as unknown as AuthenticatedRequest;
    const response = responseMock();
    let continued = false;
    const authenticate = createAuthenticateToken(async (userId) => ({ _id: userId, email: "a@example.test", role: UserRole.MEMBER, orgId: "server-org-a", sessionVersion: 0 }));
    await authenticate(request, response.response, () => { continued = true; });
    assert.equal(continued, true);
    assert.equal(request.user?.userId, "account-a");
    assert.equal(request.businessOwner?.userId, "account-a");
    assert.equal(request.businessOwner?.workspaceId, workspaceIdFor("server-org-a", "account-a"));
    assert.equal(resolveWorkspaceScope(request), workspaceIdFor("server-org-a", "account-a"));
    assert.notEqual(request.businessOwner?.workspaceId, request.body.workspaceId);
  });

  it("rejects deleted or changed accounts and fails closed when the user store is unavailable", async () => {
    config.jwtSecret = "unit-test-secret-that-is-at-least-32-bytes-long";
    const token = signSession({ userId: "account-a", email: "a@example.test", role: UserRole.MEMBER, orgId: "server-org-a" });
    const request = { headers: { authorization: `Bearer ${token}` } } as AuthenticatedRequest;
    const revokedResponse = responseMock();
    await createAuthenticateToken(async () => null)(request, revokedResponse.response, () => assert.fail("revoked session must not continue"));
    assert.equal(revokedResponse.state.statusCode, 401);

    const unavailableResponse = responseMock();
    await createAuthenticateToken(async () => { throw new Error("storage offline"); })(request, unavailableResponse.response, () => assert.fail("unverified identity must not continue"));
    assert.equal(unavailableResponse.state.statusCode, 503);

    const signedOutResponse = responseMock();
    await createAuthenticateToken(async (userId) => ({ _id: userId, email: "a@example.test", role: UserRole.MEMBER, orgId: "server-org-a", sessionVersion: 1 }))(request, signedOutResponse.response, () => assert.fail("signed-out token must not continue"));
    assert.equal(signedOutResponse.state.statusCode, 401);
  });

  it("rejects client-selected elevated roles and workspace IDs during registration", async () => {
    const request = { body: { email: "new@example.test", password: "correct horse battery", role: "ADMIN", workspaceId: "shared", ownerId: "someone-else" } } as AuthenticatedRequest;
    const response = responseMock();
    await register(request, response.response);
    assert.equal(response.state.statusCode, 400);
  });
});
