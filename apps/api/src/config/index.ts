import dotenv from "dotenv";
import dns from "node:dns";
import mongoose from "mongoose";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Resolve from this module so `pnpm dev:api` loads apps/api/.env regardless of
// whether pnpm starts the script from the repository root or package directory.
const apiDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
dotenv.config({ path: path.join(apiDirectory, ".env") });

const nodeEnv = process.env.NODE_ENV || "development";
const mvpMode = process.env.MVP_MODE === "true";
assertMvpModeAllowed(nodeEnv, mvpMode);

export const config = {
  port: process.env.PORT || 7000,
  // Keep credentials outside source control and allow the runtime environment
  // to select the database (for example, local MongoDB during development).
  mongoUri: process.env.MONGODB_URI || "",
  mongoDnsServers: (process.env.MONGODB_DNS_SERVERS || "")
    .split(",")
    .map((server) => server.trim())
    .filter(Boolean),
  jwtSecret: process.env.JWT_SECRET || "",
  nodeEnv,
  mvpMode,
  llmProvider: process.env.LLM_PROVIDER || "mock",
  openaiApiKey: process.env.OPENAI_API_KEY || "",
  geminiApiKey: process.env.GEMINI_API_KEY || "",
};

export function assertMvpModeAllowed(environment: string, enabled: boolean): void {
  if (enabled && environment.toLocaleLowerCase("en-US") === "production") {
    throw new Error("MVP_MODE=true is not allowed when NODE_ENV=production.");
  }
}

export async function connectDB(): Promise<void> {
  if (!config.mongoUri) throw new Error("MONGODB_URI is missing from apps/api/.env.");
  try {
    if (config.mongoDnsServers.length > 0) dns.setServers(config.mongoDnsServers);
    await mongoose.connect(config.mongoUri);
  } catch (error) {
    const name = error instanceof Error ? error.name : "UnknownError";
    const message = error instanceof Error ? error.message : "Database driver returned an unknown error.";
    const safeMessage = sanitizeDatabaseError(message);
    const failure = new Error(`MongoDB connection failed (${name}): ${safeMessage}`);
    failure.name = name;
    throw failure;
  }
  console.log("[MongoDB] Connected successfully.");
}

function sanitizeDatabaseError(message: string): string {
  return message
    .replaceAll(config.mongoUri, "[MONGODB_URI]")
    .replace(/mongodb(?:\+srv)?:\/\/[^\s"'<>]+/gi, "[MONGODB_URI]")
    .replace(/\b(password|passwd|pwd)=([^&\s]+)/gi, "$1=[REDACTED]");
}
