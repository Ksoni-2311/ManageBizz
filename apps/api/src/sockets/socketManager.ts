import { Server as SocketIOServer } from "socket.io";
import { Server as HTTPServer } from "http";
import jwt from "jsonwebtoken";
import { UserRole } from "@nexusops/shared-types";
import { config } from "../config/index.js";
import { workspaceIdFor } from "../domain/businessData.js";
import { UserModel } from "../models/User.js";

function workspaceRoom(workspaceId: string) { return `workspace:${workspaceId}`; }
export class SocketManager {
  private static io: SocketIOServer | null = null;
  private static readonly runOwners = new Map<string, string>();

  static initialize(httpServer: HTTPServer): SocketIOServer {
    this.io = new SocketIOServer(httpServer, { cors: { origin: process.env.WEB_APP_URL ?? "http://localhost:3000", methods: ["GET", "POST"] } });
    this.io.use(async (socket, next) => {
      try {
        const token = typeof socket.handshake.auth?.token === "string" ? socket.handshake.auth.token : "";
        if (!token || !config.jwtSecret || config.jwtSecret.length < 32) return next(new Error("Authentication required"));
        const payload = jwt.verify(token, config.jwtSecret, { algorithms: ["HS256"], issuer: "managebizz", audience: "managebizz-api" });
        if (typeof payload === "string" || typeof payload.userId !== "string" || typeof payload.orgId !== "string" || typeof payload.email !== "string" || payload.sub !== payload.userId || !Object.values(UserRole).includes(payload.role as UserRole)) return next(new Error("Invalid session"));
        const user = await UserModel.findById(payload.userId).select("_id email orgId sessionVersion").lean();
        if (!user || user.email !== payload.email || user.orgId !== payload.orgId || user.sessionVersion !== payload.sessionVersion) return next(new Error("Session is no longer valid"));
        socket.data.userId = String(user._id);
        socket.data.workspaceId = workspaceIdFor(user.orgId, String(user._id));
        socket.data.expiresAt = typeof payload.exp === "number" ? payload.exp * 1000 : 0;
        next();
      } catch { next(new Error("Invalid or expired session")); }
    });
    this.io.on("connection", (socket) => {
      const ownerWorkspace = socket.data.workspaceId as string;
      const expiresAt = socket.data.expiresAt as number;
      socket.join(workspaceRoom(ownerWorkspace));
      if (expiresAt > Date.now()) {
        const expiryTimer = setTimeout(() => socket.disconnect(true), expiresAt - Date.now());
        expiryTimer.unref();
        socket.once("disconnect", () => clearTimeout(expiryTimer));
      } else socket.disconnect(true);
      // Clients can only request their own workspace room; arbitrary room joins are rejected.
      socket.on("join_room", (room: unknown) => {
        if (room === ownerWorkspace || room === workspaceRoom(ownerWorkspace)) socket.join(workspaceRoom(ownerWorkspace));
      });
    });
    return this.io;
  }

  static bindRun(runId: string, workspaceId: string): void { this.runOwners.set(runId, workspaceId); }
  static releaseRun(runId: string): void { this.runOwners.delete(runId); }
  static emitEvent(eventName: string, payload: Record<string, unknown>): void {
    const runId = typeof payload.runId === "string" ? payload.runId : undefined;
    const workspaceId = runId ? this.runOwners.get(runId) : undefined;
    if (this.io && workspaceId) this.io.to(workspaceRoom(workspaceId)).emit(eventName, payload);
  }
}
