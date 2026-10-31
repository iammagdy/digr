import ExcelJS from "exceljs";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildMissionFiles } from "../agent/src/workbook";
import { countWorkbookItems, countWorkbookSheets } from "../agent/src/finalize";
import { METHODOLOGY_TITLE_AR, type MissionFacts, type StageRecord } from "../agent/src/methodology";
import { plainSearchAr } from "../src/lib/agentMission/plainSearchAr";
import { EXCEL_SHEET_NAME_MAX, wordBoundarySheetName } from "../src/lib/agentMission/fileNames";
import { checkCustomerText } from "../src/lib/agentMission/text";
import { generateExcelReport, REVIEW_SHEET_NAME_AR, REVIEW_SHEET_NOTICE_AR, UNREVIEWED_SHEET_NOTICE_AR } from "../src/functions/shared/fileGenerators";
import { setScaleOverridesForTesting } from "../src/lib/scaleConfig";
import type { PricedPlan } from "../src/lib/agentMission/plan";

/**
 * Small fixes to the «المنهجية» section and to wording of the files:
 * 1. «ما بُحث عنه» tells the search string in plain Arabic (never «lang:ar since:…»);
 * 2. «حدود هذا التسليم» says, by code and from the recorded dates, when the results cover much less than the period asked for (information only);
 * 3. sheet names never end on «آخر / خلال / حول / بين»;
 * 4. the sheet of results that need review says «نتائج», never «سجلات».
 */
const QUERY = '"محمد صلاح" lang:ar since:2026-10-24';

const stage = (filters: unknown[], query: string = QUERY, planned = 50) => ({
  key: "tweets", title_ar: "التغريدات", endpoint_id: "anyapi.x.search.posts", expected_rows: planned, planned_rows: planned, parent_key: null, deliver: true, sample_rows: [], measured_by: [], measured_from_calls: [], measured_cost_per_row_usd: 0.0001,
  columns: [{ key: "text", title_ar: "نص التغريدة" }, { key: "created_at", title_ar: "تاريخ النشر" }],
  relevance: { subject_ar: "محمد صلاح لاعب كرة القدم", terms: ["محمد صلاح"], text_columns: ["text"], review: true },
  filters,
  engine: { endpoint_id: "anyapi.x.search.posts", params: { query, max_results: 100 }, cursor_param: null, map_code: "return []", map_file_id: "call_0001", parent_binding: null },
});
const planOf = (filters: unknown[], query: string = QUERY, planned = 50): PricedPlan => ({
  summary_ar: "ستحصل على تغريدات عن محمد صلاح.", stages: [stage(filters, query, planned)] as any,
  price: { totalCostUsd: 0, deliveredRows: planned, costPerFinalRowUsd: 0.0001, unitPricePoints: 1, reservePoints: planned * 2, maxChargePoints: planned, overCap: false } as any,
  quantity: { requested: planned, stage_key: "tweets", target: planned, source: "request" },
});
const record = (over: Partial<StageRecord> = {}): StageRecord => ({ found: 70, duplicates: 6, accepted: 50, excluded: 14, pending: 0, unchecked: 0, acceptedByRule: 44, acceptedByModel: 6, excludedByReason: { no_term: 5 }, stop: "target_reached", ...over });
const factsOf = (over: Partial<StageRecord> = {}): MissionFacts => ({ requestText: "أريد ٥٠ تغريدة عن محمد صلاح", deliveredAt: new Date("2026-10-31T12:00:00Z"), stages: { tweets: record(over) }, reviewStop: null });
/** `n` tweets spread evenly over `spanMs`, the newest at 2026-10-31 09:00 UTC (a moment, with a time). */
const spread = (n: number, spanMs: number) => Array.from({ length: n }, (_, i) => ({ id: `t${i + 1}`, text: `تغريدة ${i + 1} عن محمد صلاح`, created_at: new Date(Date.UTC(2026, 9, 31, 9, 0) - spanMs + Math.round((spanMs * i) / Math.max(1, n - 1))).toISOString() }));

async function load(xlsx: Buffer) { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(xlsx as unknown as ArrayBuffer); return wb; }
function sheetText(sheet: ExcelJS.Worksheet): string[] {
  const lines: string[] = [];
  sheet.eachRow({ includeEmpty: true }, (row) => {
    const cells: string[] = [];
    row.eachCell({ includeEmpty: false }, (cell) => { if (!cell.isMerged || cell.address === (cell.master?.address ?? cell.address)) cells.push(String(typeof cell.value === "object" && cell.value && "text" in (cell.value as any) ? (cell.value as any).text : cell.value ?? "")); });
    lines.push(cells.join(" | "));
  });
  return lines;
}
const firstSheetOf = async (plan: PricedPlan, rows: unknown[], facts: MissionFacts) => {
  const built = await buildMissionFiles(plan, { tweets: rows as any }, facts);
  const wb = await load(built.xlsx);
  return { built, lines: sheetText(wb.worksheets[0]) };
};
const limitsOf = (lines: string[]): string => lines.find((l) => l.startsWith("حدود هذا التسليم")) ?? "";

describe("«ما بُحث عنه» is the search told in plain Arabic", () => {
  it("the exact query of the real file: the words in «…», then the language and the start date in words", () => {
    expect(plainSearchAr(QUERY)).toEqual({ text: "«محمد صلاح»، باللغة العربية، من ٢٤ أكتوبر ٢٠٢٦", operators: true });
  });

  it("the whole first sheet of a delivered workbook says it that way and holds no operator code", async () => {
    const { lines } = await firstSheetOf(planOf([{ kind: "language", lang: "ar" }]), spread(50, 5 * 86_400_000), factsOf());
    const text = lines.join("\n");
    expect(text).toContain("ما بُحث عنه | كلمات أو عبارات البحث: «محمد صلاح»، باللغة العربية، من ٢٤ أكتوبر ٢٠٢٦");
    expect(text).not.toMatch(/lang:|since:|until:|filter:|from:/);
    // the section (not the older summary table above it, whose count cells are numbers) holds no Latin digit
    expect(lines.slice(lines.indexOf(METHODOLOGY_TITLE_AR)).join("\n")).not.toMatch(/[0-9]/);
  });

  it("until, from:, -filter:replies, min_faves, a group of alternatives and a negated word are each said in Arabic", () => {
    expect(plainSearchAr("كأس العالم until:2026-11-05").text).toBe("«كأس العالم»، حتى ٥ نوفمبر ٢٠٢٦");
    expect(plainSearchAr("from:mosalah OR from:@lfc -filter:replies").text).toBe("من حساب «mosalah» أو «lfc»، دون الردود");
    expect(plainSearchAr("محمد صلاح -filter:retweets -filter:replies lang:en").text).toBe("«محمد صلاح»، دون إعادة النشر، دون الردود، باللغة الإنجليزية");
    expect(plainSearchAr("هدف min_faves:100").text).toBe("«هدف»، لا يقل عدد الإعجابات عن ١٠٠");
    expect(plainSearchAr("محمد صلاح (مصر OR مصري)").text).toBe("«محمد صلاح»، مع إحدى الكلمات: «مصر» أو «مصري»");
    expect(plainSearchAr("محمد صلاح -إصابة").text).toBe("«محمد صلاح»، دون «إصابة»");
    expect(plainSearchAr('"كأس 2026" filter:media').text).toBe("«كأس ٢٠٢٦»، ما فيه صور أو فيديو");
  });

  it("an operator it does not know is dropped (never shown as code); a string of only unknown operators says nothing", () => {
    expect(plainSearchAr("محمد صلاح lang:ar near:cairo within:15km conversation_id:123 since:2026-10-24").text).toBe("«محمد صلاح»، باللغة العربية، من ٢٤ أكتوبر ٢٠٢٦");
    expect(plainSearchAr("near:cairo within:15km").text).toBe("");
    expect(plainSearchAr("محمد صلاح since:not-a-date lang:xx").text).toBe("«محمد صلاح»");
    expect(plainSearchAr("").text).toBe("");
  });

  it("a plain topic is shown exactly as before: only the words in «…» (no operator)", () => {
    expect(plainSearchAr("محمد صلاح")).toEqual({ text: "«محمد صلاح»", operators: false });
    expect(plainSearchAr("  محمد   صلاح  ").text).toBe("«محمد صلاح»");
  });

  it("every plain line passes the Arabic customer-text check (no Latin digit, nothing forbidden)", () => {
    for (const q of [QUERY, "كأس العالم until:2026-11-05", "from:a OR from:b -filter:replies min_retweets:50"]) {
      const text = plainSearchAr(q).text;
      expect(checkCustomerText(text, { maxChars: 500 }).issues, text).toEqual([]);
      expect(text).not.toMatch(/[0-9]/);
    }
  });
});

describe("«حدود هذا التسليم» says when the results cover much less than the period asked for", () => {
  it("asked for the last 7 days, 50 items spanning 16 hours: the honest line, with the reason the stop recorded", async () => {
    const { lines } = await firstSheetOf(planOf([{ kind: "period", days: 7 }]), spread(50, 16 * 3_600_000), factsOf());
    expect(limitsOf(lines)).toBe("حدود هذا التسليم | طلبت آخر ٧ أيام، وغطّت النتائج نحو ١٦ ساعة فقط لأن العدد المطلوب اكتمل من أحدث النتائج.");
    expect(checkCustomerText("طلبت آخر ٧ أيام، وغطّت النتائج نحو ١٦ ساعة فقط لأن العدد المطلوب اكتمل من أحدث النتائج.", { maxChars: 500 }).issues).toEqual([]);
  });

  it("it is information only: the delivery, the counts and the sheets the settlement reads are identical with a short and with a full coverage", async () => {
    const short = await firstSheetOf(planOf([{ kind: "period", days: 7 }]), spread(50, 16 * 3_600_000), factsOf());
    const full = await firstSheetOf(planOf([{ kind: "period", days: 7 }]), spread(50, 6 * 86_400_000), factsOf());
    expect(limitsOf(short.lines)).toContain("طلبت آخر ٧ أيام");
    expect(limitsOf(full.lines)).toBe("حدود هذا التسليم | لا قيود سُجّلت على هذا التسليم");
    for (const b of [short.built, full.built]) {
      expect(await countWorkbookItems(b.xlsx)).toBe(50);
      expect(await countWorkbookSheets(b.xlsx)).toEqual([50]);
      expect((await load(b.xlsx)).worksheets.map((w) => w.name)).toEqual(["ملخص المهمة", "التغريدات"]);
    }
    expect(short.lines[3]).toBe(full.lines[3]); // «تم تسليم ٥٠ من ٥٠ تغريدة.»
  });

  it("no line when the coverage is at least half of the period (exactly half is not «less than half»), none without a period, none for approximate dates", async () => {
    const half = await firstSheetOf(planOf([{ kind: "period", days: 10 }]), spread(50, 5 * 86_400_000), factsOf());
    expect(limitsOf(half.lines)).toBe("حدود هذا التسليم | لا قيود سُجّلت على هذا التسليم");
    const justUnder = await firstSheetOf(planOf([{ kind: "period", days: 10 }]), spread(50, 5 * 86_400_000 - 3_600_000), factsOf());
    expect(limitsOf(justUnder.lines)).toContain("طلبت آخر ١٠ أيام، وغطّت النتائج نحو ٥ أيام فقط");
    const none = await firstSheetOf(planOf([{ kind: "language", lang: "ar" }]), spread(50, 16 * 3_600_000), factsOf());
    expect(limitsOf(none.lines)).toBe("حدود هذا التسليم | لا قيود سُجّلت على هذا التسليم");
    const off = await firstSheetOf(planOf([{ kind: "period", days: 7, enabled: false }]), spread(50, 16 * 3_600_000), factsOf());
    expect(limitsOf(off.lines)).toBe("حدود هذا التسليم | لا قيود سُجّلت على هذا التسليم");
  });

  it("the reason is only given when the recorded stop is «target_reached»; another stop gets no invented reason", async () => {
    const { lines } = await firstSheetOf(planOf([{ kind: "period", days: 7 }]), spread(50, 16 * 3_600_000), factsOf({ stop: "source_exhausted" }));
    const line = limitsOf(lines);
    expect(line).toContain("طلبت آخر ٧ أيام، وغطّت النتائج نحو ١٦ ساعة فقط.");
    expect(line).not.toContain("لأن العدد المطلوب اكتمل");
  });

  it("a range asked for and dates with no time are counted in whole days; a period shorter than an hour says so", async () => {
    const dayRows = Array.from({ length: 50 }, (_, i) => ({ id: `d${i}`, text: `تغريدة ${i} عن محمد صلاح`, created_at: i % 2 ? "2026-10-30" : "2026-10-31" }));
    const days = await firstSheetOf(planOf([{ kind: "period", from: "2026-10-01", to: "2026-10-31" }]), dayRows, factsOf());
    expect(limitsOf(days.lines)).toContain("طلبت الفترة من ٢٠٢٦-١٠-٠١ إلى ٢٠٢٦-١٠-٣١، وغطّت النتائج يومين فقط لأن العدد المطلوب اكتمل من أحدث النتائج.");
    const minutes = await firstSheetOf(planOf([{ kind: "period", days: 7 }]), spread(50, 20 * 60_000), factsOf());
    expect(limitsOf(minutes.lines)).toContain("وغطّت النتائج أقل من ساعة فقط");
  });

  it("it sits beside the other limits (a shortfall) without replacing them", async () => {
    const plan = planOf([{ kind: "period", days: 7 }]);
    const { lines } = await firstSheetOf(plan, spread(40, 16 * 3_600_000), factsOf({ accepted: 40, stop: "source_exhausted" }));
    const text = limitsOf(lines);
    expect(text).toContain("سُلّم ٤٠ من ٥٠ لأن المصدر لم يعد يعطي نتائج أخرى لهذا الطلب.");
    expect(text).toContain("طلبت آخر ٧ أيام، وغطّت النتائج نحو ١٦ ساعة فقط.");
  });

  it("the section is still inside the first sheet and no sheet was added", async () => {
    const built = await buildMissionFiles(planOf([{ kind: "period", days: 7 }]), { tweets: spread(50, 16 * 3_600_000) as any }, factsOf());
    const wb = await load(built.xlsx);
    expect(wb.getWorksheet(METHODOLOGY_TITLE_AR)).toBeUndefined();
    expect(wb.worksheets).toHaveLength(2);
  });
});

describe("a sheet name cut at 31 characters never ends on a dangling word", () => {
  const cut = (title: string) => wordBoundarySheetName(title, new Set(), "مرحلة 1");
  it.each(["خلال", "آخر", "حول", "بين"])("«%s» at the cut is taken off the end", (word) => {
    const title = `تغريدات عن محمد صلاح لاعب ${word} الفريقين الكبيرين`;
    // without the rule the cut would keep the word: the 31 characters fit it
    expect([..."تغريدات عن محمد صلاح لاعب " + word].length).toBeLessThanOrEqual(EXCEL_SHEET_NAME_MAX);
    const name = cut(title);
    expect(name).toBe("تغريدات عن محمد صلاح لاعب");
    expect([...name].length).toBeLessThanOrEqual(EXCEL_SHEET_NAME_MAX);
  });

  it("the earlier words still work, a title that fits is left alone, and a single word is never emptied", () => {
    expect(cut("تغريدات عن محمد صلاح لاعب في المنتخب المصري")).toBe("تغريدات عن محمد صلاح لاعب");
    expect(cut("تغريدات آخر شهر")).toBe("تغريدات آخر شهر");
    expect(cut("آخر")).toBe("آخر");
    expect(cut("تغريدات عن محمد صلاح لاعب حول")).toBe("تغريدات عن محمد صلاح لاعب حول");
  });
});

describe("the sheet of results that need review says «نتائج», never «سجلات»", () => {
  afterEach(() => setScaleOverridesForTesting(null as any));
  const post = (id: string, text: string) => ({ id, tweet_id: id, text, author: "حساب", _relevance_reason: "لم نتأكد من الصلة" });
  const payload = (rows: any[], uncertain: any[], unreviewed: any[]) => ({
    metadata: { platform: "x", socialKind: "posts", title: "منشورات إكس", jobId: "job_x", collectedAt: "2026-10-21T10:00:00.000Z", rowsCount: rows.length, targetRequested: 50, reportContext: { scope: {}, collection: { methodLabel: "x", pagesFetched: 2, paginationStrategy: "cursor", stopReason: "call_cap" }, counts: { rawRows: 40, acceptedRows: rows.length, baselineExclusions: 0, relevanceExclusions: 0, uncertainRows: uncertain.length, unreviewedRows: unreviewed.length } } },
    rows, uncertainRows: uncertain, unreviewedRows: unreviewed, profile: null,
  });

  it.each([["in memory", 1_000_000], ["streamed", 0]])("name, notice and headers (%s)", async (_l, streamAbove) => {
    setScaleOverridesForTesting({ streamXlsxAboveRows: streamAbove });
    const wb = await load(await generateExcelReport(payload([post("a", "منشور")], [post("r", "قيد المراجعة")], [post("u", "لم يُراجَع")])));
    expect(REVIEW_SHEET_NAME_AR).toBe("نتائج تحتاج مراجعة");
    expect(wb.worksheets.map((s) => s.name)).toEqual(["المنشورات", "نتائج تحتاج مراجعة", "غير مراجَع"]);
    for (const name of ["نتائج تحتاج مراجعة", "غير مراجَع"]) {
      const sheet = wb.getWorksheet(name)!;
      expect(sheet.getRow(2).values).toEqual([undefined, "معرّف النتيجة", "ما ورد في النتيجة", "الرابط", name === "غير مراجَع" ? "سبب عدم المراجعة" : "سبب المراجعة"]);
      expect(sheetText(sheet).join("\n")).not.toMatch(/(?<![ء-ي])(?:سجل|السجل|سجلات|السجلات)(?![ء-ي])/);
    }
    expect(REVIEW_SHEET_NOTICE_AR.startsWith("هذه النتائج لم تُحتسب عليك ولم تُخصم نقاطها")).toBe(true);
    expect(UNREVIEWED_SHEET_NOTICE_AR.startsWith("هذه النتائج لم تُراجَع آلياً")).toBe(true);
    expect(REVIEW_SHEET_NOTICE_AR).not.toMatch(/سجل/);
    expect(UNREVIEWED_SHEET_NOTICE_AR).not.toMatch(/سجل/);
  });

  it("nothing in the production code reads that sheet by name or still spells the old one: only tests look it up", () => {
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? (f === "node_modules" ? [] : walk(p)) : /\.(ts|tsx)$/.test(f) ? [p] : []; });
    const files = [...walk("src"), ...walk("agent/src"), ...walk("supabase"), ...walk("scripts")];
    expect(files.filter((p) => readFileSync(p, "utf8").includes("سجلات تحتاج مراجعة"))).toEqual([]);
    expect(files.filter((p) => /getWorksheet\([^)]*REVIEW_SHEET_NAME_AR|getWorksheet\("نتائج تحتاج مراجعة"/.test(readFileSync(p, "utf8")))).toEqual([]);
  });
});
