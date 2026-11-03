import { readFileSync } from "node:fs";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { createMemoryStore } from "../agent/src/memoryStore";
import { ItemStore } from "../agent/src/items/itemStore";
import { ingestRows } from "../agent/src/items/ingest";
import { buildMissionFiles } from "../agent/src/workbook";
import { buildMethodology } from "../agent/src/methodology";
import type { PricedPlan, PricedStage } from "../src/lib/agentMission/plan";
import { APPROX_DATES_KEY, DATE_PRECISION_APPROX_AR, DATE_PRECISION_EXACT_AR, DATE_PRECISION_TITLE_AR, derivedRelativeDay } from "../src/lib/agentMission/relativeDates";
import { cardOf, mapPage } from "../src/lib/agentMission/foundation/toolCards";

/**
 * ROUND 14 (3 Nov 2026), item 1: EVERY APPROXIMATE DATE SAYS SO IN THE FILE.
 * What the live file of msn_5d5a9b2a933aeaa47d81 showed (reconstructed from the code and the real pages of the same videos, msn_41a73a6b2c0b4a76ef0a; the live file itself was not read: Storage): the comments' dates are the approximate DAY computed from «N months ago» (a date-only cell whose «تقريبًا» lived ONLY
 * in the cell's number format, which a reader of values, a pandas or openpyxl read, a filter or a copy never sees: it showed «2025-12-03 00:00:00»), and the replies' dates are INSTANTS the provider itself computed from the same relative text (`createdUtc` = the minute of the call minus 11 calendar months, shown as «2025-12-03 17:52:00»):
 * the existing computed-date check used 30.4375-day months, so it never recognised a calendar month, and the replies' mapping did not carry the relative text beside the instant at all.
 */
const REAL = "msn_41a73a6b2c0b4a76ef0a";
const raw = (n: number) => JSON.parse(readFileSync(new URL(`./fixtures/live/missions/${REAL}/raw/call_${String(n).padStart(4, "0")}.json`, import.meta.url), "utf8"));

describe("a date the source computed from a relative text, with CALENDAR months and years", () => {
  // the real reply page 14: createdUtc 1764769197 (2025-12-03T13:39:57Z) beside publishedTime «11 months ago», read at 2026-11-03T13:39:57Z
  it("an instant that is the moment of the read minus 11 calendar months is the computed day, not an exact moment (real values of the real replies page)", () => {
    const read = Date.parse("2026-11-03T13:39:59Z");
    expect(derivedRelativeDay(new Date(1764769197 * 1000).toISOString(), "11 months ago", read)).toBe("2025-12-03");
  });
  it("the same for years, and a real instant that is merely near is never touched", () => {
    const read = Date.parse("2026-11-03T13:39:59Z");
    expect(derivedRelativeDay("2025-11-03T13:39:50Z", "1 year ago", read)).toBe("2025-11-03");
    expect(derivedRelativeDay("2025-12-03T09:10:00Z", "11 months ago", read)).toBeNull();
  });
});

describe("the replies card keeps the relative text beside the instant, and ingest marks the instant approximate (the real replies pages)", () => {
  const replies = cardOf("anyapi.youtube.comment_replies")!;
  it("the card says its dates are computed from a relative text, and the mapping carries it", () => {
    expect(replies.mapping).toMatchObject({ kind: "replies", relativeDates: true });
    const rows = mapPage(replies, raw(14));
    expect(rows).toHaveLength(1);
    expect(rows[0].date_text).toBe("11 months ago");
    expect(String(rows[0].posted_at)).toMatch(/^2025-12-03T13:39:57/);
  });
  it("ingest writes the approximate day and the mark", async () => {
    const stage = { key: "comments_replies", title_ar: "الردود", endpoint_id: "e", expected_rows: 4, planned_rows: 4, parent_key: "comments", deliver: true, relative_dates: true,
      columns: [{ key: "text", title_ar: "نص التعليق" }, { key: "posted_at", title_ar: "تاريخ ووقت التعليق" }], sample_rows: [], measured_by: [] } as unknown as PricedStage;
    const parent = { key: "comments", title_ar: "التعليقات", endpoint_id: "e", expected_rows: 1, planned_rows: 1, parent_key: null, deliver: true, columns: [{ key: "text", title_ar: "نص" }], sample_rows: [], measured_by: [] } as unknown as PricedStage;
    const plan = { summary_ar: "x", stages: [parent, stage], price: { deliveredRows: 5 } } as unknown as PricedPlan;
    const store = createMemoryStore();
    const items = await ItemStore.open(store, "msn_r14_dates");
    const deps = { items, plan, addEvent: async () => undefined };
    const rows = mapPage(replies, raw(14));
    const parentId = String(rows[0].id).split(".")[0];
    await ingestRows(deps, parent, [{ id: parentId, text: "تعليق" }], { silent: true, idField: null, now: Date.parse("2026-11-03T13:39:59Z") });
    await ingestRows(deps, stage, rows.map((r) => ({ ...r, parent_id: parentId })), { silent: true, idField: null, now: Date.parse("2026-11-03T13:39:59Z") });
    const saved = items.acceptedRows("comments_replies");
    expect(saved).toHaveLength(1);
    expect(saved[0].posted_at).toBe("2025-12-03");
    expect(saved[0][APPROX_DATES_KEY]).toEqual(["posted_at"]);
  });
});

describe("the file: a separate column «دقة التاريخ» says «تقريبي» or «دقيق» for every row, beside the date cell (which stays a real date a researcher can sort and filter)", () => {
  const stage = (): PricedStage => ({ key: "comments", title_ar: "التعليقات", endpoint_id: "e", expected_rows: 3, planned_rows: 3, parent_key: null, deliver: true,
    columns: [{ key: "text", title_ar: "نص التعليق" }, { key: "posted_at", title_ar: "تاريخ ووقت التعليق" }], sample_rows: [], measured_by: [] } as unknown as PricedStage);
  const plan = (s: PricedStage): PricedPlan => ({ summary_ar: "x", stages: [s], price: { deliveredRows: 3 } } as unknown as PricedPlan);
  const rows = [
    { id: "a", text: "تعليق ١", posted_at: "2025-12-03", [APPROX_DATES_KEY]: ["posted_at"] },
    { id: "b", text: "تعليق ٢", posted_at: "2026-10-30T10:15:00.000Z" },
    { id: "c", text: "تعليق ٣", posted_at: "2025-12-04", [APPROX_DATES_KEY]: ["posted_at"] },
  ];
  async function sheetOf(rowsIn: Array<Record<string, unknown>>) {
    const s = stage();
    const files = await buildMissionFiles(plan(s), { comments: rowsIn });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(files.xlsx as never);
    const sheet = wb.worksheets.find((w) => { const h: string[] = []; w.getRow(1).eachCell((c) => h.push(String(c.value ?? ""))); return h.includes("تاريخ ووقت التعليق"); })!;
    const headers: string[] = [];
    sheet.getRow(1).eachCell((c) => headers.push(String(c.value ?? "")));
    return { sheet, headers, csv: files.csv };
  }
  it("the column sits right after the date column; «تقريبي» for the computed days, «دقيق» for a real instant", async () => {
    const { sheet, headers } = await sheetOf(rows);
    const at = headers.indexOf("تاريخ ووقت التعليق");
    expect(headers[at + 1]).toBe(DATE_PRECISION_TITLE_AR);
    expect(DATE_PRECISION_TITLE_AR).toBe("دقة التاريخ");
    const cells = [2, 3, 4].map((r) => String(sheet.getRow(r).getCell(at + 2).value));
    expect(cells).toEqual([DATE_PRECISION_APPROX_AR, DATE_PRECISION_EXACT_AR, DATE_PRECISION_APPROX_AR]);
    expect([DATE_PRECISION_APPROX_AR, DATE_PRECISION_EXACT_AR]).toEqual(["تقريبي", "دقيق"]);
  });
  it("the date cell stays a DATE (sortable), and nothing about the date is only in the number format any more", async () => {
    const { sheet, headers } = await sheetOf(rows);
    const at = headers.indexOf("تاريخ ووقت التعليق") + 1;
    expect(sheet.getRow(2).getCell(at).value).toBeInstanceOf(Date);
    expect(sheet.getRow(3).getCell(at).value).toBeInstanceOf(Date);
  });
  it("a file with no approximate date has no such column (its bytes are what they were)", async () => {
    const { headers } = await sheetOf([rows[1], { id: "d", text: "تعليق ٤", posted_at: "2026-10-31T10:00:00.000Z" }]);
    expect(headers).not.toContain(DATE_PRECISION_TITLE_AR);
  });
  it("«حدود هذا التسليم» says how many dates are approximate (Arabic, Arabic-Indic numerals)", () => {
    const s = stage();
    const m = buildMethodology({ plan: plan(s), layouts: [], rowsByStage: { comments: rows } });
    const limits = m.items.find((i) => i.label === "حدود هذا التسليم")!.values.join("\n");
    expect(limits).toContain("٢ من ٣");
    expect(limits).toContain("تاريخًا تقريبيًا");
    expect(limits).toContain(DATE_PRECISION_TITLE_AR);
    expect(limits).not.toMatch(/[0-9]/);
  });
  it("no approximate date, no line", () => {
    const s = stage();
    const m = buildMethodology({ plan: plan(s), layouts: [], rowsByStage: { comments: [rows[1]] } });
    expect(m.items.find((i) => i.label === "حدود هذا التسليم")!.values.join("\n")).not.toContain("تقريبيًا");
  });
});
