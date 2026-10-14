import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Release-branch variant of the result-review UI contracts.
 * The mismatch/complaint flow and notifications bell depend on PR #6
 * (goodwill review queue + notifications table), which is intentionally
 * NOT part of this release. Those assertions were replaced by explicit
 * exclusion checks so the release can never silently absorb them.
 */
describe("result review UI contracts (release branch)", () => {
  const canvas = readFileSync("src/app/dashboard/chat/components/ResultsCanvas.tsx", "utf8");
  const page = readFileSync("src/app/dashboard/chat/page.tsx", "utf8");
  const sidebar = readFileSync("src/components/app/AppShell.tsx", "utf8");
  const quote = readFileSync("src/app/dashboard/chat/components/PlanQuoteCard.tsx", "utf8");
  const activity = readFileSync("src/app/dashboard/chat/components/ActivityTimeline.tsx", "utf8");

  it("shows the review comparison and user-controlled keep/edit actions", () => {
    expect(canvas).toContain("مراجعة النتيجة");
    expect(canvas).toContain("كمّل بالنتيجة دي");
    expect(canvas).toContain("عدّل واسحب تاني");
  });

  it("routes edits and undo through versioned artifact APIs with honest 10-point revision pricing", () => {
    expect(canvas).toContain('action: "dedupe"');
    expect(canvas).toContain('action: "sort"');
    expect(canvas).toContain('action: "select_columns"');
    expect(canvas).toContain('action: "rename_columns"');
    expect(canvas).toContain('action: "group_aggregate"');
    expect(canvas).toContain('action: "rewrite_summary"');
    expect(canvas).toContain('action: "convert_formats"');
    expect(canvas).toContain("onUndoVersion(parentId)");
    expect(page).toContain('fetch(`/api/jobs/${activeJob.jobId}/artifacts`');
    expect(page).toContain("expectedVersionId: activeJob.artifactVersion?.id || null");
    expect(page).toContain("تكلفة التعديل: ١٠ نقاط");
    expect(page).not.toContain("بدون خصم نقاط");
  });

  it("asks for a quote for new data instead of automatically approving or starting extraction", () => {
    const start = page.indexOf("function handleReviewSuggestion");
    const end = page.indexOf("\n  return (", start);
    const handler = page.slice(start, end);
    expect(handler).toContain("اعرض عرض سعر جديدًا فقط، ولا تعتمد أو تبدأ التنفيذ");
    expect(handler).not.toMatch(/handleAcceptQuote|accept-quote|startJob/i);
  });

  it("excludes the PR #6 complaint/notifications surface from this release", () => {
    // No complaint submission (its only backend writes to the PR #6 review queue).
    expect(page).not.toContain("/complaint");
    expect(page).not.toContain("handleReportMismatch");
    expect(canvas).not.toContain("onReportMismatch");
    expect(canvas).not.toContain("مش ده المطلوب؟");
    // No goodwill refund notices and no notifications bell (no backend on main).
    expect(page).not.toContain("appendGoodwillRefundNotice");
    expect(page).not.toContain("NotificationsBell");
    expect(existsSync("src/app/dashboard/chat/components/NotificationsBell.tsx")).toBe(false);
    expect(existsSync("src/app/api/notifications/route.ts")).toBe(false);
    expect(existsSync("src/app/api/admin/goodwill/route.ts")).toBe(false);
    expect(existsSync("src/functions/shared/goodwillRefund.ts")).toBe(false);
  });

  it("keeps chat panels touch-accessible, focusable, and reduced-motion aware", () => {
    const runSections = readFileSync("src/app/dashboard/chat/components/RunSections.tsx", "utf8");
    expect(runSections).toContain("aria-controls=\"results-canvas\"");
    expect(runSections).toContain("min-h-11 min-w-11");
    expect(page).toContain("motion-reduce:animate-none");
    expect(sidebar).toContain('aria-current={n.active ? "page" : undefined}');
    expect(quote).toContain("focus-visible:outline-2");
    expect(quote).toContain("motion-safe:animate-spin motion-reduce:animate-none");
  });
});
