import express from "express";
import http from "http";
import cors from "cors";
import { config, connectDB } from "./config/index.js";
import apiRoutes from "./routes/apiRoutes.js";
import { SocketManager } from "./sockets/socketManager.js";

const app = express();
const server = http.createServer(app);

// Middleware
app.use(cors());
app.use(express.json());

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", name: "NexusOps API Server", time: new Date().toISOString() });
});

// API Routes
app.use("/api", apiRoutes);

// Socket.IO Setup
SocketManager.initialize(server);

// Start server
async function startServer() {
  await connectDB();
  server.listen(config.port, () => {
    console.log(`[NexusOps Server] Running on http://localhost:${config.port}`);
  });
}

startServer();
