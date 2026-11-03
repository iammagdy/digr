import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { createMemoryStore } from "../agent/src/memoryStore";
import { ItemStore } from "../agent/src/items/itemStore";
import { ingestRows } from "../agent/src/items/ingest";
import { buildMissionFiles } from "../agent/src/workbook";
import { MARK_COLUMNS_AR, markCellAr, markVerdict } from "../src/lib/agentMission/rawMarks";
import { NAMED_MARK_KEY, NAMED_MARK_TITLE_AR, NAMED_MISMATCH_MARK_AR } from "../src/lib/agentMission/foundation/namedShortfall";
import type { PricedPlan, PricedStage } from "../src/lib/agentMission/plan";

/**
 * ROUND 14, item 2: THE NAMED-SOURCE MARK OF A FACEBOOK FILE. Live (msn_236f4af6fe4cb890abee): the customer chose «fill from other pages»; the file's «المصدر المسمّى» said «غير محدد» on all 3 posts, because the compiler put its verdict in a plan column (`named_source`: «» for the named page, «المصدر المسمّى: غير مطابق» for a fill)
 * and the raw delivery's own mark column (`__marks.named`) is computed from an `account` filter that a compiled Facebook plan never has. The named page's post must read «مطابق», the fills «غير مطابق», and the same words on every platform when a source is named.
 */
const NOW = Date.parse("2026-11-03T15:45:00Z");
describe("the mark of a row that carries the compiler's own verdict", () => {
  it("«» is the named page, the mismatch text is a fill; a row with no verdict (no source named) is «غير محدد»", () => {
    const ctx = { textKey: "text", now: NOW };
    expect(markVerdict(undefined, { id: "1", text: "x", [NAMED_MARK_KEY]: "" }, ctx).named).toBe(true);
    expect(markVerdict(undefined, { id: "2", text: "x", [NAMED_MARK_KEY]: NAMED_MISMATCH_MARK_AR }, ctx).named).toBe(false);
    expect(markVerdict(undefined, { id: "3", text: "x" }, ctx).named).toBeNull();
  });
  it("the words: «مطابق», «غير مطابق», «غير محدد» (the other yes-or-no marks keep «نعم» / «لا»)", () => {
    expect(markCellAr("named", { named: true })).toBe("مطابق");
    expect(markCellAr("named", { named: false })).toBe("غير مطابق");
    expect(markCellAr("named", { named: null })).toBe("غير محدد");
    expect(markCellAr("repost", { repost: true })).toBe("نعم");
    expect(MARK_COLUMNS_AR.named).toBe(NAMED_MARK_TITLE_AR);
  });
  it("an `account` filter (TikTok, X, Instagram) still decides by the row's author, and now says the same words", () => {
    const filters = [{ kind: "account", field: "author", values: ["alarabiya"], enabled: true }] as never;
    expect(markVerdict(filters, { id: "1", text: "x", author: "alarabiya" }, { textKey: "text", now: NOW }).named).toBe(true);
    expect(markVerdict(filters, { id: "2", text: "x", author: "someone_else" }, { textKey: "text", now: NOW }).named).toBe(false);
  });
});

describe("the file of the live request: the page's post «مطابق», the two fills «غير مطابق», one column", () => {
  const stage = { key: "posts", title_ar: "المنشورات", endpoint_id: "e", expected_rows: 3, planned_rows: 3, parent_key: null, deliver: true,
    columns: [{ key: "text", title_ar: "نص المنشور" }, { key: "author", title_ar: "الناشر" }, { key: NAMED_MARK_KEY, title_ar: NAMED_MARK_TITLE_AR }], sample_rows: [], measured_by: [] } as unknown as PricedStage;
  const plan = { summary_ar: "x", stages: [stage], price: { deliveredRows: 3 } } as unknown as PricedPlan;
  it("through ingest (raw delivery) and the workbook", async () => {
    const store = createMemoryStore();
    const items = await ItemStore.open(store, "msn_r14_named");
    const incoming = [
      { id: "p1", text: "منشور عن الذكاء الاصطناعي", author: "قناة العربية  Al Arabiya", [NAMED_MARK_KEY]: "" },
      { id: "p2", text: "منشور آخر", author: "صباح العربية - Sabah Al Arabiya", [NAMED_MARK_KEY]: NAMED_MISMATCH_MARK_AR },
      { id: "p3", text: "منشور ثالث", author: "HandsomeHeron8119", [NAMED_MARK_KEY]: NAMED_MISMATCH_MARK_AR },
    ];
    await ingestRows({ items, plan, addEvent: async () => undefined }, stage, incoming, { silent: true, idField: null, raw: true, now: NOW });
    const rows = items.acceptedRows("posts");
    expect(rows).toHaveLength(3);
    const files = await buildMissionFiles(plan, { posts: rows });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(files.xlsx as never);
    const sheet = wb.worksheets.find((w) => { const h: string[] = []; w.getRow(1).eachCell((c) => h.push(String(c.value ?? ""))); return h.includes("نص المنشور"); })!;
    const headers: string[] = [];
    sheet.getRow(1).eachCell((c) => headers.push(String(c.value ?? "")));
    expect(headers.filter((h) => h === NAMED_MARK_TITLE_AR)).toHaveLength(1);
    const col = headers.indexOf(NAMED_MARK_TITLE_AR) + 1;
    const byAuthor = new Map<string, string>();
    const authorCol = headers.indexOf("الناشر") + 1;
    for (let r = 2; r <= 4; r += 1) byAuthor.set(String(sheet.getRow(r).getCell(authorCol).value), String(sheet.getRow(r).getCell(col).value));
    expect(byAuthor.get("قناة العربية  Al Arabiya")).toBe("مطابق");
    expect(byAuthor.get("صباح العربية - Sabah Al Arabiya")).toBe("غير مطابق");
    expect(byAuthor.get("HandsomeHeron8119")).toBe("غير مطابق");
  });
});
