import express from "express";
import http from "node:http";
import mongoose from "mongoose";
import cors from "cors";

import { config, connectDB } from "./config/index.js";
import apiRoutes from "./routes/apiRoutes.js";
import { SocketManager } from "./sockets/socketManager.js";

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok", name: "NexusOps API Server", time: new Date().toISOString() });
});

app.use("/api", apiRoutes);

function logEnvironmentStatus(): void {
  console.log(`[Startup] NODE_ENV: ${config.nodeEnv}`);
  console.log(`[Startup] PORT: ${config.port}`);
  console.log(`[Startup] MVP_MODE: ${config.mvpMode ? "[ENABLED - DEVELOPMENT ONLY]" : "[DISABLED]"}`);
  console.log(`[Startup] MONGODB_URI: ${config.mongoUri ? "[SET - HIDDEN]" : "[NOT SET]"}`);
  console.log(`[Startup] JWT_SECRET: ${config.jwtSecret ? "[SET - HIDDEN]" : "[NOT SET]"}`);
  console.log(`[Startup] OPENAI_API_KEY: ${config.openaiApiKey ? "[SET - HIDDEN]" : "[NOT SET]"}`);
}

async function startServer(): Promise<void> {
  logEnvironmentStatus();
  console.log("[Startup] Connecting to MongoDB...");
  await connectDB();

  // Initialize Socket.IO once, after required database initialization succeeds.
  SocketManager.initialize(server);
  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => reject(error);
    server.once("error", onError);
    server.listen(config.port, () => {
      server.off("error", onError);
      resolve();
    });
  });
  console.log(`[Startup] API listening on port ${config.port}.`);
}

startServer().catch(async (error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown startup error.";
  const code = typeof error === "object" && error !== null && "code" in error
    ? ` (${String((error as { code?: unknown }).code)})`
    : "";
  console.error(`[Startup] ${message}${code}`);
  await mongoose.disconnect().catch(() => undefined);
  process.exitCode = 1;
});
