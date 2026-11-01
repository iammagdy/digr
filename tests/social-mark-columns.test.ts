import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { buildMissionFiles } from "../agent/src/workbook";
import { createMemoryStore } from "../agent/src/memoryStore";
import { ItemStore } from "../agent/src/items/itemStore";
import { ingestRows } from "../agent/src/items/ingest";
import type { PricedPlan, PricedStage } from "../src/lib/agentMission/plan";
import { MARKS_KEY, MARK_COLUMNS_AR, MARK_COLUMN_ORDER, markCellAr, type RowMarks } from "../src/lib/agentMission/rawMarks";
import { checkCustomerLabel } from "../src/lib/agentMission/text";

/**
 * S1 item 1.2: THE MARK COLUMNS AND NO SILENT COLUMN DROP. A raw delivery adds «رد أم أصلي», «إعادة نشر», «لغة النص», «ضمن الفترة المطلوبة» and «المصدر المسمّى» to the first sheet, after the stage's own columns and before the ids; and it stops
 * dropping a column that happens to equal another (the builder merged twins). The values come from the SAME verdict function that stored the marks (rawMarks.ts).
 */
const stage = (over: Record<string, unknown>) => ({ endpoint_id: "e", expected_rows: 2, planned_rows: 2, parent_key: null, deliver: true, sample_rows: [], measured_by: [], measured_from_calls: [], measured_cost_per_row_usd: 0.0001, ...over });
const plan = (stages: unknown[]): PricedPlan => ({ summary_ar: "ستحصل على منشورات وتعليقاتها. وتفاصيل أخرى.", stages: stages as never, price: { totalCostUsd: 0, deliveredRows: 2, costPerFinalRowUsd: 0.0001, unitPricePoints: 1, reservePoints: 2, maxChargePoints: 2, overCap: false } });
const load = async (xlsx: Buffer) => { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(xlsx as unknown as ArrayBuffer); return wb; };
const header = (sheet: ExcelJS.Worksheet) => (sheet.getRow(1).values as unknown[]).slice(1);
const cell = (sheet: ExcelJS.Worksheet, r: number, c: number) => { const v = sheet.getRow(r).getCell(c).value; return v && typeof v === "object" && "text" in v ? (v as { text: string }).text : v; };

const POSTS = stage({ key: "posts", title_ar: "المنشورات", columns: [{ key: "text", title_ar: "نص المنشور" }, { key: "author", title_ar: "الحساب" }, { key: "likes", title_ar: "الإعجابات" }, { key: "likes_copy", title_ar: "عدد الإعجابات" }] });
const marks = (m: Partial<RowMarks>): RowMarks => ({ reply: false, repost: false, lang: "ar", inPeriod: true, named: null, ...m });
const rawRows = [
  { id: "p1", text: "منشور أول", author: "@a", likes: "5", likes_copy: "5", [MARKS_KEY]: marks({}) },
  { id: "p2", text: "منشور ثان", author: "@b", likes: "7", likes_copy: "7", [MARKS_KEY]: marks({ reply: true, lang: "other", inPeriod: false, named: true }) },
];
const plainRows = rawRows.map(({ [MARKS_KEY]: _m, ...r }) => r);

describe("the mark columns of a raw delivery", () => {
  it("the five titles are fixed and plain Arabic", () => {
    expect(MARK_COLUMN_ORDER.map((k) => MARK_COLUMNS_AR[k])).toEqual(["رد أم أصلي", "إعادة نشر", "لغة النص", "ضمن الفترة المطلوبة", "المصدر المسمّى"]);
    for (const k of MARK_COLUMN_ORDER) expect(checkCustomerLabel(MARK_COLUMNS_AR[k]).issues).toEqual([]);
  });
  it("header order: the stage's own columns, then the five marks, then the id", async () => {
    const wb = await load((await buildMissionFiles(plan([POSTS]), { posts: rawRows })).xlsx);
    expect(header(wb.getWorksheet("المنشورات")!)).toEqual(["نص المنشور", "الحساب", "الإعجابات", "عدد الإعجابات", "رد أم أصلي", "إعادة نشر", "لغة النص", "ضمن الفترة المطلوبة", "المصدر المسمّى", "المعرّف"]);
  });
  it("a duplicated column survives in raw mode (the same values under two titles are both delivered)", async () => {
    const wb = await load((await buildMissionFiles(plan([POSTS]), { posts: rawRows })).xlsx);
    const h = header(wb.getWorksheet("المنشورات")!);
    expect(h).toContain("الإعجابات");
    expect(h).toContain("عدد الإعجابات");
  });
  it("the cells are the marks' words, row by row", async () => {
    const sheet = (await load((await buildMissionFiles(plan([POSTS]), { posts: rawRows })).xlsx)).getWorksheet("المنشورات")!;
    expect([5, 6, 7, 8, 9].map((c) => cell(sheet, 2, c))).toEqual(["أصلي", "لا", "العربية", "نعم", "غير محدد"]);
    expect([5, 6, 7, 8, 9].map((c) => cell(sheet, 3, c))).toEqual(["رد", "لا", "لغة أخرى", "لا", "نعم"]);
  });
  it("rows with no marks (every flag off): no mark column, and the twin column is merged as it always was", async () => {
    const sheet = (await load((await buildMissionFiles(plan([POSTS]), { posts: plainRows })).xlsx)).getWorksheet("المنشورات")!;
    expect(header(sheet)).toEqual(["نص المنشور", "الحساب", "الإعجابات", "المعرّف"]);
  });
  it("the comments sheet of a raw delivery gets no mark columns (its rows carry none)", async () => {
    const COMMENTS = stage({ key: "comments", title_ar: "التعليقات", parent_key: "posts", per_parent_rows: 2, columns: [{ key: "text", title_ar: "نص التعليق" }, { key: "who", title_ar: "الكاتب" }] });
    const wb = await load((await buildMissionFiles(plan([POSTS, COMMENTS]), { posts: rawRows, comments: [{ id: "c1", parent_id: "p1", text: "تعليق", who: "@z" }] })).xlsx);
    expect(header(wb.getWorksheet("التعليقات")!).some((h) => String(h).includes("رد أم أصلي"))).toBe(false);
  });
});

describe("the values come from the same verdict function as the ingest", () => {
  it("rows stored by the raw ingest and written to the file: each mark cell equals markCellAr of the stored marks", async () => {
    const s = { ...POSTS, columns: [{ key: "text", title_ar: "نص المنشور" }, { key: "lang", title_ar: "رمز اللغة" }], filters: [{ kind: "language", field: "lang", lang: "ar" }], planned_rows: 5 } as unknown as PricedStage;
    const p = plan([s]);
    const store = createMemoryStore();
    const items = await ItemStore.open(store, "msn_marks01");
    await ingestRows({ items, plan: p, addEvent: async () => undefined }, s, [{ id: "1", text: "نص عربي طويل هنا", lang: "ar" }, { id: "2", text: "English words only here", lang: "en" }], { silent: true, idField: null, raw: true, now: Date.now() });
    const stored = items.acceptedRows("posts");
    const sheet = (await load((await buildMissionFiles(p, { posts: stored })).xlsx)).getWorksheet("المنشورات")!;
    const h = header(sheet);
    const at = h.indexOf(MARK_COLUMNS_AR.lang) + 1;
    expect(at).toBeGreaterThan(0);
    stored.forEach((r, i) => expect(cell(sheet, i + 2, at)).toBe(markCellAr("lang", r[MARKS_KEY] as RowMarks)));
    expect([cell(sheet, 2, at), cell(sheet, 3, at)]).toEqual(["العربية", "لغة أخرى"]);
  });
});
