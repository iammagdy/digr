import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("result review UI contracts", () => {
  const canvas = readFileSync("src/app/dashboard/chat/components/ResultsCanvas.tsx", "utf8");
  const page = readFileSync("src/app/dashboard/chat/page.tsx", "utf8");

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
});
