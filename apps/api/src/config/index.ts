import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

export const config = {
  port: process.env.PORT || 5000,
  mongoUri: process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/nexusops",
  jwtSecret: process.env.JWT_SECRET || "",
  nodeEnv: process.env.NODE_ENV || "development",
  llmProvider: process.env.LLM_PROVIDER || "mock",
  openaiApiKey: process.env.OPENAI_API_KEY || "",
  geminiApiKey: process.env.GEMINI_API_KEY || ""
};

export async function connectDB(): Promise<void> {
  try {
    await mongoose.connect(config.mongoUri);
    console.log(`[MongoDB] Connected to database: ${config.mongoUri}`);
  } catch (error) {
    console.warn(`[MongoDB] Connection error (running in fallback mock mode):`, (error as Error).message);
  }
}
