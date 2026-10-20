import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// UI render tests (jsdom). They never reach the API: each test mocks lib/api.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.tsx"],
  },
});
