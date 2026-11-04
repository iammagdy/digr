import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import ReviewReport, { ReviewReportBody } from "../src/components/mission/ReviewReport";
import { REPORT_ERRORS_AR, REPORT_FREE_AR, REPORT_FULL_SCORE_AR, REPORT_HEADING_AR, REPORT_LOADING_AR, REPORT_NO_ISSUES_AR, REPORT_PICK_AR, REPORT_RETRY_AR, REPORT_SCOPE_AR, reviewReportLinesAr, type ReviewReportView } from "../src/lib/agentMission/stage4/reviewReportLabels";
import { fetchReviewedVersions, fetchReviewReport, reviewReportUrl } from "../src/lib/agentMission/stage4/reviewReportClient";
import { checkCustomerLabel, checkCustomerText } from "../src/lib/agentMission/text";

/**
 * STAGE A: THE REVIEW REPORT ON THE REQUEST PAGE. «نتيجة مراجعة الملف»: which version was reviewed, the score out of 100, the cells checked, the items reviewed and every issue the checks found, each with a plain Arabic sentence.
 * It says what the score is (automated checks) and what it is not (proof that the research is true); a score of 100 is never described as proof. Mobile first, accessible, with a loading state and a retry. Read-only: it has no approval, no price and no payment button.
 */
const MISSION = "msn_5851abc92a1e6645a9cd";
const report = (over: Partial<ReviewReportView> = {}): ReviewReportView => ({
  version: 2, reason: "edit", score: 85, cells: 400, rowsReviewed: 40, reviewedAt: "2026-11-04T10:00:00.000Z",
  issues: [
    { code: "empty_cells", sheet: "العملاء", column: "الهاتف", count: 3, textAr: "«الهاتف»: ٣ خانات فارغة دون ذكر السبب." },
    { code: "exact_duplicate", sheet: "العملاء", column: "العملاء", count: 1, textAr: "«العملاء»: عنصر واحد مكرر تمامًا، ولم يُحذف شيء." },
  ],
  ...over,
});
const render = (props: Partial<Parameters<typeof ReviewReportBody>[0]> = {}) => renderToStaticMarkup(createElement(ReviewReportBody, { reported: [2], selected: 2, status: "ready", report: report(), onSelect: () => {}, ...props }));
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const buttonsOf = (html: string) => [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) => m[1].replace(/<[^>]+>/g, "").trim());

describe("the Arabic words", () => {
  it("the heading and the honest statements, exactly", () => {
    expect(REPORT_HEADING_AR).toBe("نتيجة مراجعة الملف");
    expect(REPORT_SCOPE_AR).toBe("هذه الدرجة تقيس الفحوصات الآلية فقط: الخانات الفارغة، وشكل الإيميل والهاتف والرابط والتاريخ، والتكرار. ولا تقيس صحة المعلومات ولا دقة البحث نفسه.");
    expect(REPORT_FULL_SCORE_AR).toBe("الدرجة ١٠٠ تعني أن الفحوصات الآلية لم تجد مشكلة، ولا تعني أن كل البيانات صحيحة.");
    expect(REPORT_NO_ISSUES_AR).toBe("لم تجد الفحوصات الآلية أي مشكلة.");
    expect(REPORT_FREE_AR).toBe("التقرير محفوظ، وعرضه مجاني ولن يُخصم منك شيء.");
  });
  it("the lines: the version, the score out of 100, the cells checked, the items reviewed, the date", () => {
    expect(reviewReportLinesAr(report())).toEqual(["النسخة التي رُوجعت: النسخة ٢ — بعد التعديل", "الدرجة: ٨٥ من ١٠٠", "عدد الخانات التي فُحصت: ٤٠٠", "عدد العناصر التي رُوجعت: ٤٠"]);
    expect(reviewReportLinesAr(report({ version: 1, reason: "delivery", score: 100, cells: 12_000, rowsReviewed: 1 }))).toEqual(["النسخة التي رُوجعت: النسخة ١ — الملف الأصلي", "الدرجة: ١٠٠ من ١٠٠", "عدد الخانات التي فُحصت: ١٢٬٠٠٠", "عدد العناصر التي رُوجعت: ١"]);
    expect(reviewReportLinesAr(report({ version: 3, reason: "review_fix" }))[0]).toBe("النسخة التي رُوجعت: النسخة ٣ — بعد تصحيح المراجعة");
  });
  it("every sentence passes the customer-text rules: Arabic only, Arabic-Indic numerals, no emoji, no provider, no USD, no spreadsheet word", () => {
    const all: string[] = [REPORT_HEADING_AR, REPORT_SCOPE_AR, REPORT_FULL_SCORE_AR, REPORT_NO_ISSUES_AR, REPORT_FREE_AR, REPORT_LOADING_AR, REPORT_RETRY_AR, REPORT_PICK_AR, ...Object.values(REPORT_ERRORS_AR)];
    for (const reason of ["delivery", "edit", "review_fix"] as const) for (const score of [0, 7, 85, 99, 100]) for (const cells of [1, 2, 400, 12_000]) all.push(...reviewReportLinesAr(report({ reason, score, cells, rowsReviewed: cells })));
    for (const s of all) {
      expect(checkCustomerText(s).issues, s).toEqual([]); expect(checkCustomerLabel(s).issues, s).toEqual([]);
      expect(s, s).not.toMatch(/[0-9]/); expect(s, s).not.toMatch(/\p{Extended_Pictographic}/u); expect(s, s).not.toMatch(/USD|\$|openai|anthropic|claude|supabase|plan_ready|storage/i);
    }
  });
  it("the score is never described as the truth of the research: the scope sentence says what it measures, and the full-score sentence says what 100 does not mean", () => {
    expect(REPORT_SCOPE_AR).toMatch(/الفحوصات الآلية فقط/);
    expect(REPORT_SCOPE_AR).toMatch(/ولا تقيس صحة المعلومات/);
    expect(REPORT_FULL_SCORE_AR).toMatch(/لا تعني أن كل البيانات صحيحة/);
    for (const s of [REPORT_SCOPE_AR, REPORT_FULL_SCORE_AR, REPORT_NO_ISSUES_AR, ...reviewReportLinesAr(report({ score: 100, issues: [] }))]) expect(s, s).not.toMatch(/(?:بيانات|نتائج|معلومات) (?:سليمة|صحيحة|دقيقة|موثوقة) (?:تمامًا|بالكامل|١٠٠)|مضمون|مؤكد|تم التحقق من (?:صحة|دقة)/);
  });
});

describe("the report on the page", () => {
  it("shows the heading, the lines, the score, every issue and the scope statement; the issues are a list", () => {
    const html = render();
    const t = text(html);
    expect(t).toContain("نتيجة مراجعة الملف");
    for (const line of reviewReportLinesAr(report())) expect(t).toContain(line);
    for (const i of report().issues) expect(t).toContain(i.textAr);
    expect(t).toContain(REPORT_SCOPE_AR);
    expect(t).toContain(REPORT_FREE_AR);
    expect(html.match(/<li[ >]/g)).toHaveLength(2);
    expect(html).toMatch(/<ul[^>]*>/);
    expect(html).toContain('data-testid="review-report"');
  });
  it("a score of 100 with no issue: the caution sentence and «no issue» are both there, and nothing says the data is proven", () => {
    const t = text(render({ report: report({ score: 100, issues: [] }) }));
    expect(t).toContain(REPORT_FULL_SCORE_AR);
    expect(t).toContain(REPORT_NO_ISSUES_AR);
    expect(t).toContain("الدرجة: ١٠٠ من ١٠٠");
  });
  it("a score below 100 does not show the full-score sentence; a score of 100 with only stated gaps still carries the caution", () => {
    expect(text(render())).not.toContain(REPORT_FULL_SCORE_AR);
    const gap = { code: "stated_gap" as const, sheet: "ورقة", column: "الاسم", count: 1, textAr: "«الاسم»: خانة واحدة ذُكر فيها أن القيمة غير متاحة أو لم يكتمل البحث عنها." };
    const t = text(render({ report: report({ score: 100, issues: [gap] }) }));
    expect(t).toContain(REPORT_FULL_SCORE_AR); expect(t).toContain(gap.textAr); expect(t).not.toContain(REPORT_NO_ISSUES_AR);
  });
  it("exposes no digit, no id, no path and no payment or approval control", () => {
    const html = render();
    expect(text(html)).not.toMatch(/[0-9]/);
    expect(html).not.toMatch(/msn_|reviews\/|versions\/|addons\/|digest|https?:\/\//i);
    expect(text(html)).not.toMatch(/اعتماد|ادفع|اشتر|نقطة|نقاط|خصم من رصيدك مرة/);
    expect(buttonsOf(html)).toEqual([]);
  });
  it("accessibility: a labelled region with the heading, a live status for loading, an alert for an error, a retry that is a real button", () => {
    const ready = render();
    expect(ready).toMatch(/<section[^>]*aria-labelledby="review-report-heading"/);
    expect(ready).toMatch(/<h2[^>]*id="review-report-heading"[^>]*>نتيجة مراجعة الملف<\/h2>/);
    const loading = render({ status: "loading", report: null });
    expect(loading).toMatch(/role="status"/); expect(loading).toMatch(/aria-busy="true"/); expect(text(loading)).toContain(REPORT_LOADING_AR); expect(loading).not.toContain("الدرجة");
    const failed = render({ status: "error", report: null, error: REPORT_ERRORS_AR.unavailable, onRetry: () => {} });
    expect(failed).toMatch(/role="alert"/); expect(text(failed)).toContain(REPORT_ERRORS_AR.unavailable); expect(buttonsOf(failed)).toEqual([REPORT_RETRY_AR]);
    expect(failed).toMatch(/<button[^>]*type="button"/);
    expect(failed).not.toContain("الدرجة:");
  });
  it("an error with no retry handler has no button; a failure never shows a score", () => {
    const html = render({ status: "error", report: null, error: REPORT_ERRORS_AR.damaged });
    expect(buttonsOf(html)).toEqual([]); expect(text(html)).not.toMatch(/[٠-٩]+ من ١٠٠/);
  });
  it("mobile first: one column, touch-sized controls (at least 44 px), full width on a phone, wrapping text, no fixed pixel width", () => {
    const html = render({ reported: [1, 2], selected: 2 });
    expect(html).toMatch(/<select[^>]*class="[^"]*\bmin-h-11\b[^"]*\bw-full\b[^"]*\bsm:w-auto\b/);
    const failed = render({ status: "error", report: null, error: "x", onRetry: () => {} });
    expect(failed).toMatch(/<button[^>]*class="[^"]*\bmin-h-11\b[^"]*\bw-full\b[^"]*\bsm:w-auto\b/);
    expect(html).toMatch(/\bbreak-words\b/);
    expect(html).not.toMatch(/\bw-\[\d{3,}px\]|\bmin-w-\[\d{3,}px\]|\bgrid-cols-[2-9]\b(?![^"]*\b(?:sm|md|lg):)/);
    expect(html).toMatch(/dir="rtl"|<section/);
  });
  it("a picker only when more than one version has a report; it lists those versions", () => {
    expect(render({ reported: [2] })).not.toContain("<select");
    const two = render({ reported: [1, 3], selected: 3 });
    expect(two).toContain("<select");
    expect(text(two)).toContain(REPORT_PICK_AR);
    expect([...two.matchAll(/<option[^>]*>([^<]*)<\/option>/g)].map((m) => m[1])).toEqual(["النسخة ١", "النسخة ٣"]);
  });
  it("draws NOTHING when no version has a report (the flag off, no review yet) and nothing is loading", () => {
    expect(render({ reported: [], status: "idle", report: null })).toBe("");
    expect(renderToStaticMarkup(createElement(ReviewReport, { missionId: MISSION }))).toBe("");
  });
});

describe("the browser's side: it reads, validates and shows; it sends nothing", () => {
  const headers = async () => ({ Authorization: "Bearer t" });
  const ok = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body } as unknown as Response);
  const wire = (r: ReviewReportView) => ({ success: true, report: r });

  it("urls: the list and one version, the mission id encoded", () => {
    expect(reviewReportUrl(MISSION)).toBe(`/api/missions/${MISSION}/review-report`);
    expect(reviewReportUrl(MISSION, 2)).toBe(`/api/missions/${MISSION}/review-report?version=2`);
    expect(reviewReportUrl("a/b")).toBe("/api/missions/a%2Fb/review-report");
  });
  it("the list: GET only, no body, no cache; the versions the server named; 404 means the feature is off or nothing is reviewed (hidden); 5xx and a lost connection are errors the page can retry", async () => {
    const f = vi.fn(async () => ok({ success: true, versions: [3, 1, 3, 2] }));
    expect(await fetchReviewedVersions({ missionId: MISSION, fetchFn: f as any, headers })).toEqual({ state: "ok", versions: [1, 2, 3] });
    expect(f).toHaveBeenCalledWith(reviewReportUrl(MISSION), { cache: "no-store", headers: { Authorization: "Bearer t" } });
    expect(await fetchReviewedVersions({ missionId: MISSION, fetchFn: (async () => ok({ success: false, error: "not_found" }, 404)) as any, headers })).toEqual({ state: "off" });
    expect(await fetchReviewedVersions({ missionId: MISSION, fetchFn: (async () => ok({}, 401)) as any, headers })).toEqual({ state: "off" });
    expect(await fetchReviewedVersions({ missionId: MISSION, fetchFn: (async () => ok({}, 503)) as any, headers })).toEqual({ state: "error", message: REPORT_ERRORS_AR.unavailable });
    expect(await fetchReviewedVersions({ missionId: MISSION, fetchFn: (async () => { throw new Error("offline"); }) as any, headers })).toEqual({ state: "error", message: REPORT_ERRORS_AR.network });
    for (const bad of [{ success: true, versions: "1" }, { success: true, versions: [0] }, { success: true, versions: [1.5] }, { success: true }, null]) expect(await fetchReviewedVersions({ missionId: MISSION, fetchFn: (async () => ok(bad)) as any, headers }), JSON.stringify(bad)).toEqual({ state: "error", message: REPORT_ERRORS_AR.unavailable });
  });
  it("one report: exactly the fields of the view, nothing the server might add", async () => {
    const r = await fetchReviewReport({ missionId: MISSION, version: 2, fetchFn: (async () => ok({ success: true, report: { ...report(), addonId: "msn_0123456789abcdef0123", rowIds: ["a"], path: "reviews/r0002.json" } })) as any, headers });
    expect(r).toEqual({ ok: true, report: report() });
    expect(JSON.stringify(r)).not.toMatch(/addonId|rowIds|reviews\//);
  });
  it("an answer that is not a report is not shown: wrong types, a score out of range, a bad reason, an issue with no sentence", async () => {
    const bads: unknown[] = [
      { success: true }, { success: false, report: report() }, { success: true, report: null }, { success: true, report: "x" },
      wire({ ...report(), score: 101 }), wire({ ...report(), score: -1 }), wire({ ...report(), score: 80.5 }), wire({ ...report(), score: "85" as any }),
      wire({ ...report(), version: 0 }), wire({ ...report(), reason: "free" as any }), wire({ ...report(), cells: -1 }), wire({ ...report(), rowsReviewed: 1.5 }), wire({ ...report(), reviewedAt: "" }),
      wire({ ...report(), issues: "none" as any }), wire({ ...report(), issues: [{ code: "x", sheet: "s", column: "c", count: 1, textAr: "t" } as any] }), wire({ ...report(), issues: [{ code: "empty_cells", sheet: "s", column: "c", count: 0, textAr: "t" }] }), wire({ ...report(), issues: [{ code: "empty_cells", sheet: "s", column: "c", count: 1, textAr: "" }] }),
    ];
    for (const b of bads) expect(await fetchReviewReport({ missionId: MISSION, version: 2, fetchFn: (async () => ok(b)) as any, headers }), JSON.stringify(b)).toEqual({ ok: false, message: REPORT_ERRORS_AR.unavailable, retryable: true });
  });
  it("the failures have their own sentence, and only a temporary one can be retried", async () => {
    const run = async (status: number) => fetchReviewReport({ missionId: MISSION, version: 2, fetchFn: (async () => ok({ success: false }, status)) as any, headers });
    expect(await run(404)).toEqual({ ok: false, message: REPORT_ERRORS_AR.not_found, retryable: false });
    expect(await run(401)).toEqual({ ok: false, message: REPORT_ERRORS_AR.unauthorized, retryable: false });
    expect(await run(500)).toEqual({ ok: false, message: REPORT_ERRORS_AR.damaged, retryable: false });
    expect(await run(503)).toEqual({ ok: false, message: REPORT_ERRORS_AR.unavailable, retryable: true });
    expect(await run(429)).toEqual({ ok: false, message: REPORT_ERRORS_AR.unavailable, retryable: true });
    expect(await fetchReviewReport({ missionId: MISSION, version: 2, fetchFn: (async () => { throw new Error("offline"); }) as any, headers })).toEqual({ ok: false, message: REPORT_ERRORS_AR.network, retryable: true });
    expect(await fetchReviewReport({ missionId: MISSION, version: 0, fetchFn: (async () => { throw new Error("must not be called"); }) as any, headers })).toEqual({ ok: false, message: REPORT_ERRORS_AR.not_found, retryable: false });
  });
  it("it asks for the very version it was told, with GET and no body", async () => {
    const f = vi.fn(async () => ok(wire(report())));
    await fetchReviewReport({ missionId: MISSION, version: 2, fetchFn: f as any, headers });
    expect(f).toHaveBeenCalledTimes(1);
    expect(f).toHaveBeenCalledWith(reviewReportUrl(MISSION, 2), { cache: "no-store", headers: { Authorization: "Bearer t" } });
  });
});

describe("the sources: client-safe, no money, no price, no server module", () => {
  const code = (f: string) => readFileSync(path.join(__dirname, "..", f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  it("the labels and the client import nothing of the money side, the card, the quotes or the server", () => {
    for (const f of ["src/lib/agentMission/stage4/reviewReportLabels.ts", "src/lib/agentMission/stage4/reviewReportClient.ts", "src/components/mission/ReviewReport.tsx"]) {
      const src = code(f);
      expect(src, f).not.toMatch(/from\s+["'][^"']*(?:addonSettlement|addonQuote|quotes|addonRow|reviewPreview"|reviewRequest"|lifecycle|price|missionPricing|gateway|supabase\/server|versionFile|reviewReport")/);
      expect(src, f).not.toMatch(/process\.env|DIGER_STAGE4|\.rpc\(|method:\s*"(POST|PUT|PATCH|DELETE)"/);
    }
  });
});
