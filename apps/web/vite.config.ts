import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiTarget = process.env.MANAGEBIZZ_API_TARGET || "http://localhost:5000";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 3000,
    proxy: {
      "/health": {
        target: apiTarget,
        changeOrigin: true
      },
      "/api": {
        target: apiTarget,
        changeOrigin: true
      },
      "/socket.io": {
        target: apiTarget,
        ws: true
      }
    }
  }
});
