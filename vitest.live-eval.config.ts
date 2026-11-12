import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * THE LIVE INTELLIGENCE EVALUATION ONLY (docs/LIVE-INTELLIGENCE-EVAL.md): `npx vitest run -c vitest.live-eval.config.ts`. It includes only `evals/**` (the default config includes only `tests/**`,
 * so `npm test` never runs it), and the evaluation itself refuses to start without its preflight (budget.ts).
 */
export default defineConfig({
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    environment: "node",
    include: ["evals/**/*.eval.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    fileParallelism: false,
    testTimeout: 30 * 60_000,
    setupFiles: ["tests/setup/mailDomain.ts", "tests/setup/legacyModelPlanning.ts"],
    env: { JOB_MAX_POINTS_CAP: "600" },
  },
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
});
