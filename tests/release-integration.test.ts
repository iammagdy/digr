import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Release-branch integration guardrails (release/digr-redesign-main).
 * The redesign was integrated onto main WITHOUT the stacked PR #6
 * (goodwill money logic) and PR #7 (dependent execution) changes.
 * These checks fail if any of that surface ever leaks into this branch.
 */
const read = (path: string) => readFileSync(path, "utf8");

describe("release integration: PR #6 / PR #7 stay out", () => {
  it("financial core files carry no goodwill or dependent-plan logic", () => {
    const ledger = read("src/functions/shared/ledger.ts");
    expect(ledger).not.toContain("createGoodwillAdjustment");
    expect(ledger).not.toContain("GOODWILL");

    const quoteAccept = read("src/functions/shared/quoteAccept.ts");
    expect(quoteAccept).not.toContain("dependentPlans");
    expect(quoteAccept).not.toContain("hasDependentSteps");

    const planManager = read("src/functions/shared/planManager.ts");
    expect(planManager).not.toContain("dependentPlans");
    expect(planManager).not.toContain("calculateDependentPlanQuote");

    const worker = read("src/functions/shared/multiStepWorker.ts");
    expect(worker).not.toContain("goodwillRefund");
    expect(worker).not.toContain("applyGoodwillOutcome");

    const jobWorker = read("src/functions/job-worker/src/main.ts");
    expect(jobWorker).not.toContain("goodwillRefund");
  });

  it("excluded modules and routes do not exist on this branch", () => {
    for (const path of [
      "src/functions/shared/goodwillRefund.ts",
      "src/functions/shared/dependentPlans.ts",
      "src/app/admin/goodwill/page.tsx",
      "src/app/api/admin/goodwill/route.ts",
      "src/app/api/notifications/route.ts",
      "src/app/api/jobs/[id]/complaint/route.ts",
      "src/app/dashboard/chat/components/NotificationsBell.tsx",
    ]) {
      expect(existsSync(path), path).toBe(false);
    }
  });

  it("admin navigation does not link to the excluded goodwill console", () => {
    expect(read("src/app/admin/layout.tsx")).not.toContain("/admin/goodwill");
  });

  it("jobs data responses carry no goodwill refund field", () => {
    expect(read("src/app/api/jobs/[id]/data/route.ts")).not.toContain("goodwillRefund");
  });

  it("redesign honesty fixes are present", () => {
    const chat = read("src/app/dashboard/chat/page.tsx");
    // The in-page message replaced the browser alert; the charge comes only from the server value.
    expect(chat).toContain("methodologyMessageText(data.chargedPoints");
    expect(chat).not.toMatch(/(?:window\.)?alert\(/);
    expect(chat).not.toContain("اقتطاع 10 نقاط");
    expect(read("src/lib/honestDisplay.ts")).toContain("methodologyMessageText");
  });

  it("PR #3 trust boundary is preserved", () => {
    const route = read("src/app/api/chat/route.ts");
    expect(route).toContain("validateStructuredClarificationAnswers");
    const clarification = read("src/functions/shared/clarification.ts");
    expect(clarification).toContain("needsUserChoice");
  });
});
