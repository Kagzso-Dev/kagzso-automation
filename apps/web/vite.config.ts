import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Read the repo-root .env (shared with the API). Only VITE_* variables reach the browser.
  envDir: fileURLToPath(new URL("../..", import.meta.url)),
  server: {
    port: 5173,
    // Fail loudly if 5173 is taken instead of silently drifting to 5174 —
    // a second dev server on a stray port talks to a stale API and hides
    // that another instance is already running. Free the port first:
    //   npm run dev:kill
    strictPort: true,
    proxy: {
      "/api": { target: "http://localhost:4000", changeOrigin: true },
      "/health": { target: "http://localhost:4000", changeOrigin: true },
    },
  },
});
