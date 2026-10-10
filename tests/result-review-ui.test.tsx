import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("result review UI contracts", () => {
  const canvas = readFileSync("src/app/dashboard/chat/components/ResultsCanvas.tsx", "utf8");
  const page = readFileSync("src/app/dashboard/chat/page.tsx", "utf8");
  const bell = readFileSync("src/app/dashboard/chat/components/NotificationsBell.tsx", "utf8");
  const sidebar = readFileSync("src/app/dashboard/chat/components/ChatSidebar.tsx", "utf8");
  const quote = readFileSync("src/app/dashboard/chat/components/PlanQuoteCard.tsx", "utf8");
  const activity = readFileSync("src/app/dashboard/chat/components/ActivityTimeline.tsx", "utf8");
  const complaint = readFileSync("src/app/api/jobs/[id]/complaint/route.ts", "utf8");
  const adminApi = readFileSync("src/app/api/admin/goodwill/route.ts", "utf8");
  const schema = readFileSync("scripts/setup-db.ts", "utf8");

  it("shows the review comparison, user-controlled actions, and categorized complaint choices", () => {
    expect(canvas).toContain("مراجعة النتيجة");
    expect(canvas).toContain("كمّل بالنتيجة دي");
    expect(canvas).toContain("عدّل واسحب تاني");
    expect(canvas).toContain("مش ده المطلوب؟");
    expect(canvas).toContain("نوع البيانات");
    expect(canvas).toContain("الفترة");
    expect(canvas).toContain("العدد");
    expect(canvas).toContain("الجودة");
    expect(canvas).toContain("أخرى");
  });

  it("routes edits and undo through versioned artifact APIs without charging points", () => {
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
    expect(page).toContain("بدون خصم نقاط");
  });

  it("asks for a quote for new data instead of automatically approving or starting extraction", () => {
    const start = page.indexOf("function handleReviewSuggestion");
    const end = page.indexOf("\n  return (", start);
    const handler = page.slice(start, end);
    expect(handler).toContain("اعرض عرض سعر جديدًا فقط، ولا تعتمد أو تبدأ التنفيذ");
    expect(handler).not.toMatch(/handleAcceptQuote|accept-quote|startJob/i);
  });

  it("keeps complaints outcome-neutral and limits notices/admin data to verified owners", () => {
    expect(complaint).toContain("job.userId !== userId");
    expect(complaint).toContain("saveCustomerComplaint");
    expect(complaint).not.toMatch(/applyGoodwillOutcome|createGoodwillAdjustment|chargeCredits/);
    expect(bell).toContain("unreadCount");
    expect(bell).toContain('method: "PATCH"');
    expect(bell).toContain("aria-expanded={open}");
    expect(adminApi).toContain('user.labels.includes("admin")');
    expect(adminApi).not.toMatch(/export async function (POST|PATCH|DELETE)/);
    expect(schema).toContain('"notifications"');
    expect(schema).toContain('"autoRefundMonthlyPointsCap"');
  });

  it("keeps chat panels touch-accessible, focusable, and reduced-motion aware", () => {
    expect(page).toContain("aria-controls=\"results-canvas\"");
    expect(page).toContain("min-h-11 min-w-11");
    expect(page).toContain("motion-reduce:animate-none");
    expect(sidebar).toContain('aria-current={isActive ? "page" : undefined}');
    expect(sidebar).toContain("لا توجد محادثات سابقة");
    expect(sidebar).toContain("duration-200 ease-out motion-reduce:transition-none");
    expect(bell).toContain("left-1/2");
    expect(bell).toContain("min-h-11");
    expect(quote).toContain("focus-visible:outline-2");
    expect(quote).toContain("motion-safe:animate-spin motion-reduce:animate-none");
    expect(activity).toContain("aria-expanded={!collapsed}");
    expect(activity).toContain("min-h-11");
  });
});
