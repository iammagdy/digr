import { describe, expect, it } from "vitest";
import { parseStoredPlan, serializeStoredPlan, type PlanState } from "../src/functions/shared/planManager";
import {
  buildFallbackReview,
  buildNormalizedRequestSpec,
  computeRunFacts,
  parseResultReview,
} from "../src/functions/shared/resultReview";

const basePlan: PlanState = {
  summaryAr: "تحليل منشورات عامة",
  items: [{ capabilitySlug: "x-keyword-search", params: { query: "data science" }, targetVolumeMin: 20, targetVolumeMax: 100 }],
  outputFormats: ["csv", "xlsx"],
  executionOptions: { windowing: "per_day", windowFrom: "2026-01-01", windowTo: "2026-01-03", includeReplies: true, anonymize: true },
};

function codes(facts: ReturnType<typeof computeRunFacts>) {
  return facts.findings.map((finding) => finding.code);
}

describe("C: result review facts and request specification", () => {
  it("stores a normalized request spec in a backwards-compatible plan envelope", () => {
    const envelope = serializeStoredPlan(basePlan, buildNormalizedRequestSpec(basePlan));
    const parsed = parseStoredPlan(JSON.stringify(envelope));

    expect(parsed.legacy).toBe(false);
    expect(parsed.items[0].capabilitySlug).toBe("x-keyword-search");
    expect(parsed.outputFormats).toEqual(["csv", "xlsx"]);
    expect(parsed.executionOptions?.includeReplies).toBe(true);
    expect((parsed.requestSpec as any).sources[0].params.query).toBe("data science");
    expect((parsed.requestSpec as any).volumeRange).toEqual({ min: 20, max: 100 });
  });

  it("continues to read legacy quote arrays with safe defaults", () => {
    const parsed = parseStoredPlan(JSON.stringify(basePlan.items));
    expect(parsed.legacy).toBe(true);
    expect(parsed.items).toEqual(basePlan.items);
    expect(parsed.outputFormats).toEqual(["xlsx", "pdf", "csv"]);
  });

  it("flags a near-empty reply share when replies were requested", () => {
    const spec = buildNormalizedRequestSpec(basePlan);
    const facts = computeRunFacts(spec, Array.from({ length: 30 }, (_, id) => ({ id: `post-${id}`, text: "data science" })));
    expect(codes(facts)).toContain("replies_sparse");
    expect(facts.severity).toBe("critical");
  });

  it("detects latest-first skew for a long request without windowing", () => {
    const plan = { ...basePlan, executionOptions: { windowing: "none" as const, windowFrom: "2026-01-01", windowTo: "2026-04-30", includeReplies: false } };
    const spec = buildNormalizedRequestSpec(plan);
    const rows = ["2026-04-28", "2026-04-29", "2026-04-30"].map((date, id) => ({ id: `n-${id}`, createdAt: date, title: "data science update" }));
    const facts = computeRunFacts(spec, rows);
    expect(codes(facts)).toContain("latest_first_skew");
    expect(codes(facts)).toContain("critical_period_coverage");
    expect(facts.severity).toBe("critical");
    expect(facts.observedDateRange).toEqual({ from: "2026-04-28", to: "2026-04-30" });
  });

  it("detects duplicate rows deterministically", () => {
    const spec = buildNormalizedRequestSpec({ ...basePlan, executionOptions: { includeReplies: false } });
    const facts = computeRunFacts(spec, [
      { id: "same", text: "one" }, { id: "same", text: "one" }, { id: "two", text: "two" },
      { id: "three", text: "three" }, { id: "four", text: "four" }, { id: "five", text: "five" },
      { id: "six", text: "six" }, { id: "seven", text: "seven" }, { id: "eight", text: "eight" }, { id: "nine", text: "nine" },
    ]);
    expect(facts.duplicateCount).toBe(1);
    expect(codes(facts)).toContain("many_duplicates");
  });

  it("detects empty requested daily windows", () => {
    const spec = buildNormalizedRequestSpec(basePlan);
    const facts = computeRunFacts(spec, [{ id: "one", createdAt: "2026-01-01" }]);
    expect(facts.emptyWindows).toEqual(["2026-01-02", "2026-01-03"]);
    expect(codes(facts)).toContain("empty_windows");
  });

  it("flags likely unrelated rows using code-owned query matching", () => {
    const spec = buildNormalizedRequestSpec({ ...basePlan, executionOptions: { includeReplies: false } });
    const facts = computeRunFacts(spec, Array.from({ length: 5 }, (_, id) => ({ id, title: `unrelated topic ${id}` })));
    expect(codes(facts)).toContain("many_unrelated_items");
  });

  it("returns a code-generated review and validates suggestion enum and params", () => {
    const spec = buildNormalizedRequestSpec(basePlan);
    const facts = computeRunFacts(spec, []);
    const review = buildFallbackReview(facts, spec);
    expect(review.comparisonAr).toContain("اللي اتجمع فعليًا");
    expect(review.suggestions.length).toBeLessThanOrEqual(3);
    expect(parseResultReview(review)).not.toBeNull();
    expect(parseResultReview({ comparisonAr: "مراجعة", suggestions: [{ type: "refund_me", labelAr: "رد النقاط", params: {} }] })).toBeNull();
    expect(parseResultReview({ comparisonAr: "مراجعة", suggestions: [{ type: "dedupe", labelAr: "إزالة التكرار", params: { keys: ["id"], runNow: true } }] })).toBeNull();
  });

  it("bounds and strips HTML from untrusted collected samples", () => {
    const spec = buildNormalizedRequestSpec({ ...basePlan, executionOptions: { includeReplies: false } });
    const facts = computeRunFacts(spec, [{ id: "x", title: `<b>${"x".repeat(900)}</b><script>alert(1)</script>` }]);
    const sampleText = String(facts.samples[0].title);
    expect(sampleText.length).toBeLessThanOrEqual(500);
    expect(sampleText).not.toContain("<b>");
    expect(sampleText).not.toContain("<script>");
  });
});
