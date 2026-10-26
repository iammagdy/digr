import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // Lets a test render a component to markup; tsconfig keeps jsx for Next.
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    environment: "node",
    include: ["tests/**/*.test.{ts,tsx}"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/supabase/functions/**"],
    testTimeout: 30000,
    setupFiles: ["tests/setup/mailDomain.ts"],
    // The suites written before the cap was raised assume the 600-point cap. The cap can be LOWERED by this variable (`effectiveJobPointsCap`, read by every surface that decides
    // what a plan may hold), so they run lowered to 600 and keep every one of their assertions. The 25,000 default is tested where it matters with the variable cleared
    // (`vi.stubEnv("JOB_MAX_POINTS_CAP", "")`: tests/cap-25000-default.test.ts, tests/phase5-discovery-and-honest-limits.test.ts) and on the real PostgreSQL replica (tests/sql/job-cap-25000.replica.test.ts, tests/replica-money-properties.test.ts).
    env: { JOB_MAX_POINTS_CAP: "600" },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
