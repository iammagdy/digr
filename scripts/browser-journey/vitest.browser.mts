import { defineConfig } from "vitest/config";
import path from "node:path";

// Browser journey config: only tests/browser/*.browser.ts, one at a time, long timeouts. Not part of the default suite.
const root = process.env.APP_DIR ?? process.cwd();
export default defineConfig({
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    environment: "node",
    include: ["scripts/browser-journey/**/*.browser.ts"],
    testTimeout: 600_000,
    hookTimeout: 180_000,
    fileParallelism: false,
    env: { JOB_MAX_POINTS_CAP: "600" },
    setupFiles: ["tests/setup/mailDomain.ts", "tests/setup/legacyModelPlanning.ts"],
  },
  resolve: { alias: { "@": path.resolve(root, "./src"), playwright: "/opt/node-tools/node_modules/playwright/index.js" } },
});
