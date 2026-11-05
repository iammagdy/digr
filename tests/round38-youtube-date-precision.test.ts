import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { createMemoryStore } from "../agent/src/memoryStore";
import { ItemStore } from "../agent/src/items/itemStore";
import { ingestRows } from "../agent/src/items/ingest";
import { csvExportFromWorkbook } from "../src/lib/server/csvFromExcel";
import type { PricedPlan, PricedStage } from "../src/lib/agentMission/plan";
import { APPROX_DATES_KEY, derivedRelativeDay, parseRelativeAge } from "../src/lib/agentMission/relativeDates";
import { approxInstantOfRelative } from "../src/lib/agentMission/foundation/occurrence";
import { fieldNotesAr, recoverFields } from "../src/lib/agentMission/foundation/discovery/fieldRecovery";
import { discoverCards } from "../src/lib/agentMission/foundation/discovery/deriveCards";
import { samplesView } from "../src/lib/agentMission/customerView";
import { publicPlanOf } from "../src/lib/agentMission/overLimit";
import { NO_SENSITIVE_ACCESS } from "../src/lib/treg/dataPolicy";
import { catalog, catalogPage, deliver, discoveryWorld } from "./helpers/discoveryWorld";

/**
 * ROUND 38: THE PRE-APPROVAL PLAN AND THE FILE MUST AGREE ABOUT DATES (live mission msn_f6caeacd55819c639f6f, YouTube, 5 videos, 200 points).
 * EVIDENCE (REAL, read-only SELECTs of the mission row): the request named «تاريخ النشر»; the approved plan said «طلبت التواريخ، لكن المصدر المختار لا يعيدها في ما قرأناه … غير متاح»
 * (`plan.compiled.fields`: posted_at = unavailable), while the SAME plan's five pinned rows carried `published` = a relative text from the source («2 weeks ago», «1 month ago», «1 year ago»,
 * «3 years ago», «16 hours ago») and `posted_at` = an INSTANT the planner itself had computed from that text at the moment of planning (…T08:58:53.271Z minus 14 days, 30 days, 365 days, 1,095 days, 16 hours).
 * The delivered files then held dates, some «تقريبي» and some «دقيق».
 * CAUSES (reproduced below on those five stored rows): (1) the field check looked for a date KEY in the page and never for the relative text, so a source that dates items only relatively was called «unavailable»;
 * (2) the planner converted «N months/years ago» with 30-day months and 365-day years, the ingest recognised a computed date with 30.4375-day months and 365.25-day years within 10 minutes, so «1 month», «1 year» and
 * «3 years» fell outside and a COMPUTED instant was delivered as an exact date; (3) even with equal units the recognition depended on the gap between planning and execution (an approval an hour later makes every day-unit row «exact»).
 * The five items and the plan time are REAL (stored); the page envelope is the catalog's own documented shape, so the PAGE is SIMULATED around the real items.
 */
const REQUEST = "اجمع ٥ فيديوهات عامة من يوتيوب عن artificial intelligence، مع النصوص والروابط وتاريخ النشر واسم القناة وعدد المشاهدات إن كانت متاحة.";
const ENDPOINT = "tikhub.youtube.search.videos";
// the five REAL stored items (id, title, author, views, relative text) and the REAL plan moment
const REAL = [
  { video_id: "xjjkBczuYwM", title: "Artificial Intelligence: Complete Path to 2035", author: "Future Business Tech", view_count: "47,086 views", published_time: "2 weeks ago", planned: "2026-10-22T08:58:53.271Z" },
  { video_id: "ws_9ettrtSg", title: "Artificial Intelligence from an Evolutionary Perspective", author: "World Knowledge Forum│세계지식포럼", view_count: "497,127 views", published_time: "1 month ago", planned: "2026-10-06T08:58:53.271Z" },
  { video_id: "m8o2GrbR3d8", title: "SIMPLEST Explanation of How Artificial Intelligence Works? No Jargon | What is AI? How AI works?", author: "Science Simplified 4 All", view_count: "2,231,882 views", published_time: "1 year ago", planned: "2025-11-05T08:58:53.271Z" },
  { video_id: "tFx_UNW9I1U", title: "The 10 Stages of Artificial Intelligence", author: "Future Business Tech", view_count: "1,770,767 views", published_time: "3 years ago", planned: "2023-11-06T08:58:53.271Z" },
  { video_id: "dU-RPRMOVDw", title: "Ex-AI Insider WARNS: It's Already Too Late To Stop What's Coming", author: "Neural Nutshell", view_count: "75,020 views", published_time: "16 hours ago", planned: "2026-11-04T16:58:53.271Z" },
];
const PLAN_NOW = Date.parse("2026-11-05T08:58:53.271Z");
const DAY = 86_400_000;
const pageItem = (r: (typeof REAL)[number]) => ({ video_id: r.video_id, title: r.title, duration: "10:00", view_count: r.view_count, published_time: r.published_time, author: r.author, channel_id: "", thumbnails: [], description_snippet: r.title, url: `https://www.youtube.com/watch?v=${r.video_id}` });

describe("ONE conversion of a relative text to a moment (the planner and the file used two)", () => {
  it("the planner's instant is the very instant the file's reader computes, for every unit of the real rows", () => {
    for (const r of REAL) {
      const age = parseRelativeAge(r.published_time, PLAN_NOW)!;
      expect(approxInstantOfRelative(r.published_time, PLAN_NOW), r.published_time).toBe(age.approxMs);
    }
    // a month is 30.4375 days and a year 365.25 days (the file's units), not 30 and 365
    expect(approxInstantOfRelative("1 month ago", PLAN_NOW)).toBe(PLAN_NOW - 30.4375 * DAY);
    expect(approxInstantOfRelative("1 year ago", PLAN_NOW)).toBe(PLAN_NOW - 365.25 * DAY);
  });
  it("a text that is no relative age gives no moment (nothing is invented)", () => {
    expect(approxInstantOfRelative("لا شيء", PLAN_NOW)).toBeNull();
    expect(approxInstantOfRelative("", PLAN_NOW)).toBeNull();
    expect(approxInstantOfRelative(undefined, PLAN_NOW)).toBeNull();
  });
  it("a plan stored BEFORE this fix (instants computed with 30-day months and 365-day years) is still recognised as computed, not exact", () => {
    const EXEC = Date.parse("2026-11-05T08:59:20.085Z");
    for (const r of REAL) expect(derivedRelativeDay(r.planned, r.published_time, EXEC), r.published_time).not.toBeNull();
    // a REAL timestamp of a video is untouched
    expect(derivedRelativeDay("2026-10-12T14:03:11.000Z", "3 weeks ago", EXEC)).toBeNull();
  });
});

describe("INGEST of the five real stored rows: no computed date is delivered as exact", () => {
  const columns = [
    { key: "text", title_ar: "النص" }, { key: "author", title_ar: "صاحب الحساب" }, { key: "published", title_ar: "وقت النشر" }, { key: "link", title_ar: "الرابط" },
    { key: "views", title_ar: "المشاهدات" }, { key: "posted_at", title_ar: "تاريخ ووقت النشر" },
  ];
  const stage = (): PricedStage => ({ key: "videos", title_ar: "الفيديوهات", endpoint_id: ENDPOINT, expected_rows: 5, planned_rows: 5, parent_key: null, deliver: true, columns, sample_rows: [], measured_by: [] } as unknown as PricedStage);
  const stored = (marked: boolean) => REAL.map((r) => ({ id: r.video_id, text: r.title, author: r.author, published: r.published_time, link: `https://www.youtube.com/watch?v=${r.video_id}`, views: r.view_count, posted_at: r.planned, ...(marked ? { [APPROX_DATES_KEY]: ["posted_at"] } : {}) }));
  async function ingest(rows: Array<Record<string, unknown>>, now: number) {
    const items = await ItemStore.open(createMemoryStore(), "msn_r38_ingest");
    const s = stage();
    await ingestRows({ items, plan: { summary_ar: "x", stages: [s], price: { deliveredRows: 5 } } as unknown as PricedPlan, addEvent: async () => undefined }, s, rows, { silent: true, idField: null, now });
    return items.acceptedRows("videos");
  }
  it("rows stored without the mark, read 27 seconds after planning (what happened live): all five dates are approximate days", async () => {
    const rows = await ingest(stored(false), Date.parse("2026-11-05T08:59:20.085Z"));
    expect(rows).toHaveLength(5);
    const days = Object.fromEntries(rows.map((r) => [String(r.id), r.posted_at]));
    expect(days).toEqual({ xjjkBczuYwM: "2026-10-22", ws_9ettrtSg: "2026-10-06", m8o2GrbR3d8: "2025-11-05", tFx_UNW9I1U: "2023-11-05", "dU-RPRMOVDw": "2026-11-04" });
    for (const r of rows) { expect(r[APPROX_DATES_KEY], String(r.id)).toEqual(expect.arrayContaining(["posted_at", "published"])); expect(String(r.posted_at)).toMatch(/^\d{4}-\d{2}-\d{2}$/); }
  });
  it("rows carrying the planner's mark stay approximate whatever the gap between planning and execution (here two hours)", async () => {
    const rows = await ingest(stored(true), PLAN_NOW + 2 * 3_600_000);
    for (const r of rows) { expect(r[APPROX_DATES_KEY], String(r.id)).toEqual(expect.arrayContaining(["posted_at"])); expect(String(r.posted_at), String(r.id)).toMatch(/^\d{4}-\d{2}-\d{2}$/); }
  });
  it("a REAL date a source gave is exact: untouched and unmarked", async () => {
    const rows = await ingest([{ id: "real1", text: "t", author: "a", published: "", link: "https://www.youtube.com/watch?v=real1", views: "1", posted_at: "2026-10-12T14:03:11.000Z" }], PLAN_NOW);
    expect(rows[0].posted_at).toBe("2026-10-12T14:03:11.000Z");
    expect(rows[0][APPROX_DATES_KEY]).toBeUndefined();
  });
});

describe("THE FIELD CHECK on the real first page: a relative-only source is «approximate», never «unavailable»", () => {
  const card = discoverCards(catalog, "youtube", NO_SENSITIVE_ACCESS).cards.find((c) => c.endpointId === ENDPOINT)!;
  it("the derived card maps the relative text and no date (the live shape)", () => {
    const fields = Object.keys((card.mapping as { fields: object }).fields);
    expect(fields).toContain("published");
    expect(fields).not.toContain("posted_at");
  });
  it("items that carry only «N units ago»: posted_at is approximate (said as such), views come from the card", () => {
    const page = catalogPage(ENDPOINT, REAL.map(pageItem), null);
    const r = recoverFields(card, page, ["posted_at", "views"], PLAN_NOW);
    expect(r.report.find((x) => x.key === "posted_at")).toMatchObject({ status: "approximate" });
    expect(r.report.find((x) => x.key === "views")).toMatchObject({ status: "card" });
    const notes = fieldNotesAr(r.report).join(" ");
    expect(notes).toContain("تقريبي");
    expect(notes).not.toContain("لا يعيدها");
    expect(notes).not.toContain("غير متاح");
    expect(notes).not.toMatch(/tikhub|published_time|endpoint/i);
  });
  it("items that carry neither a date nor a readable relative text: unavailable, nothing invented", () => {
    const page = catalogPage(ENDPOINT, REAL.map((r) => ({ ...pageItem(r), published_time: "" })), null);
    const r = recoverFields(card, page, ["posted_at"], PLAN_NOW);
    expect(r.report[0].status).toBe("unavailable");
    expect(fieldNotesAr(r.report).join(" ")).toContain("لا يعيدها");
    const foreign = catalogPage(ENDPOINT, REAL.map((x) => ({ ...pageItem(x), published_time: "11个月前" })), null);
    expect(recoverFields(card, foreign, ["posted_at"], PLAN_NOW).report[0].status).toBe("unavailable");
  });
  it("a relative text on too few items is not enough (80% rule, as for every recovered field)", () => {
    const page = catalogPage(ENDPOINT, REAL.map((r, i) => ({ ...pageItem(r), published_time: i < 2 ? r.published_time : "" })), null);
    expect(recoverFields(card, page, ["posted_at"], PLAN_NOW).report[0].status).toBe("unavailable");
  });
  it("a REAL date under the provider's own key is still «recovered» (exact), never «approximate»", () => {
    const page = catalogPage(ENDPOINT, REAL.map((r) => ({ ...pageItem(r), published_at: "2026-10-12T14:03:11.000Z" })), null);
    expect(recoverFields(card, page, ["posted_at"], PLAN_NOW).report[0]).toMatchObject({ status: "recovered", path: "published_at" });
  });
});

describe("THE PLAN AND THE FILE, end to end on the five real items (planning two hours before the run)", () => {
  async function run(planAt: number) {
    const w = discoveryWorld(REQUEST, { [ENDPOINT]: () => catalogPage(ENDPOINT, REAL.map(pageItem), null) }, { discovery: true, platform: "youtube" });
    const r = await w.plan({ nowMs: planAt, selectCapability: async () => ({ endpointId: ENDPOINT, reason: "youtube search", costUsd: 0 }) });
    if (r.kind !== "plan") throw new Error(`no plan: ${r.kind}:${(r as { reason?: string }).reason}`);
    const out = await deliver(w, r.plan, REQUEST, "youtube");
    return { r, out };
  }
  const read = async (xlsx: Buffer) => { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(xlsx as never); return wb; };
  for (const [label, planAt] of [["planned 9 minutes before the run", Date.parse("2026-11-04T18:00:50Z")], ["planned 2 hours before the run", Date.parse("2026-11-04T16:00:20Z")]] as const) {
    it(`${label}: the plan says approximate, every delivered date is approximate in the Excel AND the CSV, none is «دقيق»`, async () => {
      const { r, out } = await run(planAt);
      const notes = (r.plan.notes_ar ?? []).join("\n");
      expect(r.plan.compiled!.fields).toEqual(expect.arrayContaining([expect.objectContaining({ key: "posted_at", status: "approximate" })]));
      expect(notes).toContain("تقريبي");
      expect(notes).not.toContain("لا يعيدها في ما قرأناه");
      // the customer's preview of the pinned rows: a computed date is shown as a day with «تقريبًا», never with a time of day
      const view = samplesView(publicPlanOf(r.plan));
      const row0 = view!.rows[0].join(" | ");
      expect(row0).toContain("تقريبًا");
      expect(row0).not.toMatch(/\d{1,2}:\d{2}|[٠-٩]{1,2}:[٠-٩]{2}|ص\b|م\b/);
      const wb = await read(out.built.xlsx);
      const sheet = wb.worksheets[1];
      const headers = Array.from({ length: sheet.columnCount }, (_, c) => String(sheet.getCell(1, c + 1).value));
      const precisionCols = headers.map((h, i) => (h.startsWith("دقة التاريخ") ? i + 1 : 0)).filter(Boolean);
      expect(precisionCols.length).toBeGreaterThanOrEqual(1);
      expect(sheet.rowCount - 1).toBe(5);
      for (let rr = 2; rr <= 6; rr += 1) for (const c of precisionCols) expect(sheet.getCell(rr, c).text, `row ${rr} col ${c}`).toBe("تقريبي");
      const dateCols = headers.map((h, i) => (!h.startsWith("دقة") && /النشر/.test(h) ? i + 1 : 0)).filter(Boolean);
      expect(dateCols.length).toBeGreaterThanOrEqual(2);
      for (let rr = 2; rr <= 6; rr += 1) {
        const days = dateCols.map((c) => { const v = sheet.getCell(rr, c).value; expect(v, `row ${rr} col ${c}`).toBeInstanceOf(Date); return (v as Date).toISOString(); });
        // a day, never a made-up time of day, and both date columns of the row name the SAME day
        for (const d of days) expect(d.endsWith("T00:00:00.000Z"), d).toBe(true);
        expect(new Set(days).size, `row ${rr}`).toBe(1);
        for (const c of dateCols) expect(String(sheet.getCell(rr, c).numFmt)).toContain("تقريبًا");
      }
      const csv = (await csvExportFromWorkbook(out.built.xlsx)).stages[0].csv;
      const lines = csv.split(/\r?\n/).filter((l) => l.trim() !== "");
      const header = lines[0].split(",").map((h) => h.replace(/^"|"$/g, ""));
      expect(header.filter((h) => h.startsWith("دقة التاريخ")).length).toBe(precisionCols.length);
      expect(csv).toContain("تقريبي");
      expect(csv).not.toContain("دقيق");
      // the methodology counts the same: 5 of 5, none exact
      const all: string[] = [];
      for (const ws of wb.worksheets) ws.eachRow((row) => row.eachCell((cell) => all.push(String(cell.text))));
      expect(all.join("\n")).toMatch(/٥ من ٥ تاريخًا تقريبيًا/);
    });
  }
});
