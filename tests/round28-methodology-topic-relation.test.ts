import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { buildMissionFiles } from "../agent/src/workbook";
import { countWorkbookItems, countWorkbookSheets } from "../agent/src/finalize";
import { buildMethodology, topicRelationLinesOf, type MissionFacts, type StageRecord } from "../agent/src/methodology";
import { TOPIC_RELATION_KEY, TOPIC_RELATION_TITLE_AR, topicRelationAr } from "../src/lib/agentMission/foundation/topicChoice";
import { checkCustomerText } from "../src/lib/agentMission/text";
import type { PricedPlan } from "../src/lib/agentMission/plan";

/**
 * ROUND 28: the methodology says, from the delivered rows themselves, how many deliver a text that is about the topic and how many name it only in the hashtags (the mark column «علاقة النص بالموضوع» the plan already wrote). Information only: no row, column,
 * count or price changes, the marks never removed a row, and the line «لا قيود سُجّلت» keeps meaning that no execution limit was recorded.
 */
const ABOUT = topicRelationAr(2), TAGS = topicRelationAr(1), NONE = topicRelationAr(0);
const NO_LIMITS = "لا قيود سُجّلت على هذا التسليم";
const LABEL = "صلة النتائج بالموضوع";

const videosStage = (withMark: boolean) => ({
  key: "videos", title_ar: "الفيديوهات", endpoint_id: "anyapi.tiktok.search.videos", expected_rows: 10, planned_rows: 10, parent_key: null, deliver: true, sample_rows: [], measured_by: [], measured_from_calls: [], measured_cost_per_row_usd: 0.0001,
  columns: [{ key: "text", title_ar: "وصف الفيديو" }, { key: "link", title_ar: "رابط الفيديو" }, ...(withMark ? [{ key: TOPIC_RELATION_KEY, title_ar: TOPIC_RELATION_TITLE_AR }] : [])],
  engine: { endpoint_id: "anyapi.tiktok.search.videos", params: { query: "الذكاء الاصطناعي" }, cursor_param: null, map_code: "return []", map_file_id: "call_0001", parent_binding: null },
});
const planOf = (withMark = true, over: Record<string, unknown> = {}): PricedPlan => ({
  summary_ar: "ستحصل على فيديوهات عن الذكاء الاصطناعي.", stages: [videosStage(withMark)] as any,
  price: { totalCostUsd: 0, deliveredRows: 10, costPerFinalRowUsd: 0.0001, unitPricePoints: 1, reservePoints: 20, maxChargePoints: 10, overCap: false } as any,
  quantity: { requested: 10, stage_key: "videos", target: 10, source: "request" }, ...over,
});
const rowsOf = (marks: Array<string | undefined>) => marks.map((m, i) => ({ id: `v${i + 1}`, text: `فيديو رقم ${i + 1}`, link: `https://www.tiktok.com/@a/video/${i + 1}`, ...(m === undefined ? {} : { [TOPIC_RELATION_KEY]: m }) }));
const record = (over: Partial<StageRecord> = {}): StageRecord => ({ found: 14, duplicates: 0, accepted: 10, excluded: 0, pending: 0, unchecked: 0, acceptedByRule: 10, acceptedByModel: 0, excludedByReason: {}, stop: "target_reached", ...over });
const FACTS: MissionFacts = { requestText: "أريد ١٠ فيديوهات عن الذكاء الاصطناعي من تيك توك", deliveredAt: new Date("2026-11-04T12:00:00Z"), stages: { videos: record() }, reviewStop: null };

const modelOf = (plan: PricedPlan, marks: Array<string | undefined>, facts = FACTS) => buildMethodology({ plan, layouts: [], rowsByStage: { videos: rowsOf(marks) }, facts });
const itemOf = (m: ReturnType<typeof buildMethodology>, label: string) => m.items.find((i) => i.label === label);
const repeat = (v: string | undefined, n: number) => Array.from({ length: n }, () => v);

describe("the relation of the delivered items to the topic, in the methodology", () => {
  it("3 rows about the topic and 7 naming it only in the hashtags: both real counts, nothing filtered, and no execution limit invented", () => {
    const m = modelOf(planOf(), [...repeat(ABOUT, 3), ...repeat(TAGS, 7)]);
    const it = itemOf(m, LABEL)!;
    expect(it.values).toEqual([
      "النص يتحدث عن الموضوع: ٣ فيديوهات",
      "الموضوع مذكور في الوسوم فقط: ٧ فيديوهات",
      "هذه علامات في عمود «علاقة النص بالموضوع» فقط؛ لم يُحذف بها شيء من النتائج، وسُلّمت كلها.",
    ]);
    // the relation is its own item, before the limits, and the limits keep saying no limit was recorded
    expect(m.items.findIndex((x) => x.label === LABEL)).toBeLessThan(m.items.findIndex((x) => x.label === "حدود هذا التسليم"));
    expect(itemOf(m, "حدود هذا التسليم")!.values).toEqual([NO_LIMITS]);
    expect(it.values.join(" ")).not.toMatch(/استُبعد|أُزيل|قيود|لم يُسلَّم/);
  });

  it("the numbers follow the delivered rows, never a fixed pair (5 and 5, then 1 and 9)", () => {
    expect(itemOf(modelOf(planOf(), [...repeat(ABOUT, 5), ...repeat(TAGS, 5)]), LABEL)!.values.slice(0, 2)).toEqual(["النص يتحدث عن الموضوع: ٥ فيديوهات", "الموضوع مذكور في الوسوم فقط: ٥ فيديوهات"]);
    expect(itemOf(modelOf(planOf(), [...repeat(ABOUT, 1), ...repeat(TAGS, 9)]), LABEL)!.values.slice(0, 2)).toEqual(["النص يتحدث عن الموضوع: فيديو واحد", "الموضوع مذكور في الوسوم فقط: ٩ فيديوهات"]);
  });

  it("all rows about the topic: the hashtag count is stated as zero, not left out", () => {
    const v = itemOf(modelOf(planOf(), repeat(ABOUT, 10)), LABEL)!.values;
    expect(v[0]).toBe("النص يتحدث عن الموضوع: ١٠ فيديوهات");
    expect(v[1]).toBe("الموضوع مذكور في الوسوم فقط: ٠ فيديو");
    expect(v.join(" ")).not.toContain("غير متاح");
  });

  it("all rows naming the topic only in the hashtags: said plainly, still not a filter", () => {
    const v = itemOf(modelOf(planOf(), repeat(TAGS, 10)), LABEL)!.values;
    expect(v[0]).toBe("النص يتحدث عن الموضوع: ٠ فيديو");
    expect(v[1]).toBe("الموضوع مذكور في الوسوم فقط: ١٠ فيديوهات");
    expect(v[v.length - 1]).toContain("لم يُحذف بها شيء");
  });

  it("rows that do not name the topic at all are counted on their own line", () => {
    const v = itemOf(modelOf(planOf(), [...repeat(ABOUT, 4), ...repeat(TAGS, 4), ...repeat(NONE, 2)]), LABEL)!.values;
    expect(v).toContain("لا يذكر الموضوع: فيديوهين");
  });

  it("a row with no recorded classification (or any other text) is counted as unavailable, and nothing is inferred for it", () => {
    const v = itemOf(modelOf(planOf(), [...repeat(ABOUT, 3), ...repeat(TAGS, 5), undefined, "نص غير معروف"]), LABEL)!.values;
    expect(v).toContain("النص يتحدث عن الموضوع: ٣ فيديوهات");
    expect(v).toContain("الموضوع مذكور في الوسوم فقط: ٥ فيديوهات");
    expect(v).toContain("تصنيف غير متاح: فيديوهين");
  });

  it("every row unclassified: no breakdown is made up, only a statement that none was recorded", () => {
    const v = itemOf(modelOf(planOf(), repeat(undefined, 10)), LABEL)!.values;
    expect(v).toHaveLength(1);
    expect(v[0]).toBe("لم يُسجَّل تصنيف لعلاقة النص بالموضوع لـ١٠ فيديوهات سُلّمت، فلا نذكر توزيعًا لها.");
    expect(v[0]).not.toMatch(/النص يتحدث عن الموضوع:|الوسوم فقط:/);
  });

  it("no delivered rows: no line at all", () => {
    const m = buildMethodology({ plan: planOf(), layouts: [], rowsByStage: { videos: [] }, facts: FACTS });
    expect(itemOf(m, LABEL)).toBeUndefined();
    expect(itemOf(m, "حدود هذا التسليم")).toBeDefined();
  });

  it("a stage without the mark column (a request with no topic, every non-social stage) gets no line, and the methodology is exactly what it was", () => {
    const withoutMark = modelOf(planOf(false), [...repeat(ABOUT, 3), ...repeat(TAGS, 7)]);
    expect(itemOf(withoutMark, LABEL)).toBeUndefined();
    // the same methodology with the column present differs ONLY by the one new item
    const withMark = modelOf(planOf(true), [...repeat(ABOUT, 3), ...repeat(TAGS, 7)]);
    expect(withMark.items.filter((x) => x.label !== LABEL)).toEqual(withoutMark.items);
    expect(withMark.table).toEqual(withoutMark.table);
    expect(withMark.reasons).toEqual(withoutMark.reasons);
  });

  it("it does not hide a real execution limit: a shortfall is still stated in its own item", () => {
    const plan = planOf(true, { quantity: { requested: 20, stage_key: "videos", target: 10, source: "request", reason_ar: "هذا أقصى ما تسمح به الخطة" } });
    const m = modelOf(plan, [...repeat(ABOUT, 3), ...repeat(TAGS, 7)]);
    expect(itemOf(m, "حدود هذا التسليم")!.values[0]).toContain("العدد المعتمد في الخطة أقل مما طلبت");
    expect(itemOf(m, LABEL)).toBeDefined();
  });

  it("two delivered stages with the mark: each line is led by its stage title", () => {
    const second = { ...videosStage(true), key: "videos2", title_ar: "فيديوهات أخرى" };
    const lines = topicRelationLinesOf([videosStage(true), second] as any, { videos: rowsOf([ABOUT, TAGS]), videos2: rowsOf([TAGS]) });
    expect(lines.filter((l) => l.startsWith("«الفيديوهات»: ")).length).toBeGreaterThan(0);
    expect(lines.filter((l) => l.startsWith("«فيديوهات أخرى»: ")).length).toBeGreaterThan(0);
  });

  it("the text is plain Arabic for a customer: no provider name, no endpoint id, no English", () => {
    for (const marks of [[...repeat(ABOUT, 3), ...repeat(TAGS, 7)], repeat(undefined, 4), repeat(TAGS, 10)]) {
      for (const line of itemOf(modelOf(planOf(), marks), LABEL)!.values) expect(checkCustomerText(line).issues, line).toEqual([]);
    }
  });
});

describe("the delivered file: only the methodology gets a new item, no row, column or count changes", () => {
  async function load(xlsx: Buffer) { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(xlsx as unknown as ArrayBuffer); return wb; }
  const sheetText = (sheet: ExcelJS.Worksheet): string[] => { const lines: string[] = []; sheet.eachRow({ includeEmpty: true }, (row) => { const cells: string[] = []; row.eachCell({ includeEmpty: false }, (cell) => cells.push(String(typeof cell.value === "object" && cell.value && "text" in (cell.value as any) ? (cell.value as any).text : cell.value ?? ""))); lines.push(cells.join(" | ")); }); return lines; };

  it("the real workbook: the line is in the first sheet, the videos sheet and the settlement counts are the same with and without it", async () => {
    const marks = [...repeat(ABOUT, 3), ...repeat(TAGS, 7)];
    const rows = { videos: rowsOf(marks) };
    const withLine = (await buildMissionFiles(planOf(true), rows, FACTS)).xlsx;
    const wb = await load(withLine);
    const first = sheetText(wb.worksheets[0]).join("\n");
    expect(first).toContain(LABEL);
    expect(first).toContain("النص يتحدث عن الموضوع: ٣ فيديوهات");
    expect(first).toContain("الموضوع مذكور في الوسوم فقط: ٧ فيديوهات");
    expect(first).toContain(NO_LIMITS);
    // delivered rows and columns: ten rows, the same three columns, the mark column keeps the values of each row
    expect(await countWorkbookItems(withLine)).toBe(10);
    expect(await countWorkbookSheets(withLine)).toEqual([10]);
    const sheet = wb.worksheets[1];
    const head = sheet.getRow(1).values as unknown[];
    expect(head.slice(1)).toEqual(["وصف الفيديو", "رابط الفيديو", TOPIC_RELATION_TITLE_AR, "المعرّف"]);
    expect(sheet.rowCount).toBe(11);
    const markAt = 3; // the mark column is the third (the writer appends the id column after it)
    const col = Array.from({ length: 10 }, (_, i) => String(sheet.getRow(i + 2).getCell(markAt).value ?? ""));
    expect(col.filter((v) => v === ABOUT)).toHaveLength(3);
    expect(col.filter((v) => v === TAGS)).toHaveLength(7);
    // the same plan without the new item (no mark column): the videos sheet is the same except for the mark column itself
    const noMark = await load((await buildMissionFiles(planOf(false), { videos: rowsOf(repeat(undefined, 10)) }, FACTS)).xlsx);
    expect(sheetText(noMark.worksheets[0]).join("\n")).not.toContain(LABEL);
    expect(noMark.worksheets[1].rowCount).toBe(sheet.rowCount);
  });

  it("the money lines are untouched by this round: the methodology file imports no pricing or ledger code", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("agent/src/methodology.ts", "utf8");
    expect(src).not.toMatch(/from "\.\/(gateway|price|jobPointsCap|ledger)"/);
    expect(src).not.toMatch(/from "\.\.\/\.\.\/src\/functions/);
  });
});
