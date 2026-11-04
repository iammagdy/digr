import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildAsk } from "../src/lib/agentMission/foundation/ask";
import { compilePlan, parentInputs } from "../src/lib/agentMission/foundation/compilePlan";
import { cardOf } from "../src/lib/agentMission/foundation/toolCards";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { layoutOf, COUNTER_UNAVAILABLE_AR, workbookNoteAr } from "../agent/src/workbook";
import type { PricedPlan } from "../src/lib/agentMission/plan";

/**
 * ROUND 27, item 4: THE SAME COLUMNS FOR THE SAME PLATFORM AND TYPE (TikTok videos).
 * Live: two orders of 10 videos on the same topic gave files with 19 and 18 columns, the second without «الحفظ». Two code causes, both fixed here:
 *  1. the TikTok search has three verified tools and each gives a different field set (the language only from one, the country from two; the writer reads the language of the text when the tool gave none): the file's columns followed the tool. Now the parent sheet always has the same columns; a field the tool does not give is «غير متاح» on every row and the summary says so.
 *  2. the workbook merged a column into another when their values were the same on 80% of the rows: videos with no shares and no saves («0» and «0») lost «الحفظ». A counter is never merged into another column.
 */
const catalog = loadTregCatalog();
const capabilityOf = (id: string) => catalog.byId.get(id)?.capability ?? null;
const AT = Date.parse("2026-11-02T12:00:00Z");
const page = (mission: string, call: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/live/missions/${mission}/raw/${call}.json`, import.meta.url), "utf8"));
const REQUEST = "هات فيديوهين تيك توك بالعربي عن الذكاء الاصطناعي من مصر، مع كل التعليقات والردود";
const CASES = [
  { endpoint: "tikhub.tiktok.search.videos", mission: "msn_5851abc92a1e6645a9cd", call: "call_0007" },
  { endpoint: "anyapi.tiktok.search.videos", mission: "msn_5851abc92a1e6645a9cd", call: "call_0002" },
  { endpoint: "crawl4ai.tiktok.search.videos", mission: "msn_c796a6ff13d79f7a973d", call: "call_0001" },
];
const videosColumns = (endpoint: string, mission: string, call: string): string[] => {
  const ask = buildAsk(REQUEST, null, AT);
  const card = cardOf(endpoint)!;
  const r = compilePlan({ ask, pool: { card, params: parentInputs(card, ask), pages: [{ callId: call, page: page(mission, call) }] }, exposure: () => ({ callId: null, page: null, failed: true }), capabilityOf });
  if (!r.ok) throw new Error(r.reason);
  return r.plan.stages.find((s) => s.key === "videos")!.columns.map((c) => c.key);
};

describe("the parent sheet of TikTok videos has the same columns whichever search tool read the page", () => {
  const sets = CASES.map((c) => ({ ...c, columns: videosColumns(c.endpoint, c.mission, c.call) }));
  for (const s of sets) {
    it(`${s.endpoint}: saves, country and language are columns`, () => {
      for (const k of ["text", "author", "username", "posted_at", "link", "country", "language", "likes", "comments", "shares", "views", "saves"]) expect(s.columns, k).toContain(k);
    });
  }
  it("the three tools give the very same column list, in the same order", () => {
    expect(sets[1].columns).toEqual(sets[0].columns);
    expect(sets[2].columns).toEqual(sets[0].columns);
  });
});

const stage = (columns: string[]) => ({
  key: "videos", title_ar: "الفيديوهات", endpoint_id: "anyapi.tiktok.search.videos", expected_rows: 10, planned_rows: 10, parent_key: null, deliver: true,
  columns: columns.map((k) => ({ key: k, title_ar: ({ text: "الوصف", likes: "الإعجابات", comments: "عدد التعليقات", shares: "المشاركات", views: "المشاهدات", saves: "الحفظ", country: "الدولة", language: "اللغة" } as Record<string, string>)[k] ?? k })),
});
const planOf = (columns: string[]): PricedPlan => ({ summary_ar: "x", stages: [stage(columns)], compiled: { by: "compiler" } } as unknown as PricedPlan);
const rows = (n: number, make: (i: number) => Record<string, unknown>) => Array.from({ length: n }, (_, i) => ({ id: `v${i}`, ...make(i) }));
const sheetOf = (columns: string[], data: Array<Record<string, unknown>>) => layoutOf(planOf(columns), { videos: data })[0];

describe("the workbook never merges a counter into another column because their numbers coincide", () => {
  it("ten videos where nine have no shares and no saves: «المشاركات» and «الحفظ» are both columns", () => {
    const data = rows(10, (i) => ({ text: `فيديو ${i}`, likes: 10 + i, comments: 3 + i, shares: i === 0 ? 4 : 0, views: 100 + i, saves: i === 0 ? 2 : 0 }));
    const titles = sheetOf(["text", "likes", "comments", "shares", "views", "saves"], data).columns.map((c) => c.title);
    expect(titles).toContain("المشاركات");
    expect(titles).toContain("الحفظ");
  });
  it("the same ten videos with a value in every row give the same column list (the set does not depend on the numbers)", () => {
    const zeros = rows(10, (i) => ({ text: `فيديو ${i}`, likes: 10 + i, comments: 3 + i, shares: 0, views: 100 + i, saves: 0 }));
    const spread = rows(10, (i) => ({ text: `فيديو ${i}`, likes: 10 + i, comments: 3 + i, shares: 7 + i, views: 100 + i, saves: 20 + i }));
    const cols = ["text", "likes", "comments", "shares", "views", "saves"];
    expect(sheetOf(cols, zeros).columns.map((c) => c.title)).toEqual(sheetOf(cols, spread).columns.map((c) => c.title));
  });
});

describe("a value the tool did not give says so in the cell, never empty", () => {
  it("a field no row carries («الدولة» from a tool that has none) is «غير متاح» on every row, and so is a counter missing on a row; «اللغة» is read from the text by the writer, so it is never empty either", () => {
    const data = rows(10, (i) => ({ text: `فيديو ${i}`, likes: 10 + i, comments: 3 + i, shares: 1 + i, views: 100 + i, ...(i === 3 ? {} : { saves: 5 + i }) }));
    const lay = sheetOf(["text", "country", "language", "likes", "comments", "shares", "views", "saves"], data);
    const cell = (title: string, i: number) => lay.columns.find((c) => c.title === title)!.get(data[i] as never, null);
    for (let i = 0; i < 10; i += 1) expect(cell("الدولة", i)).toBe(COUNTER_UNAVAILABLE_AR);
    expect(cell("الحفظ", 3)).toBe(COUNTER_UNAVAILABLE_AR);
    expect(cell("الحفظ", 4)).toBe(9);
    expect(lay.columns.map((c) => c.title)).toEqual(expect.arrayContaining(["الدولة", "اللغة"]));
  });
  it("the summary note states the gap: which columns the source did not give, and for how many rows", () => {
    const note = workbookNoteAr({ sheets: 3, hasParentColumn: true, parentLinked: true, hasDateColumn: true, unavailable: [{ sheetAr: "الفيديوهات", columnAr: "الدولة", missing: 10, total: 10 }, { sheetAr: "الفيديوهات", columnAr: "الحفظ", missing: 1, total: 10 }] });
    expect(note).toContain("«الدولة»");
    expect(note).toContain("«الحفظ»");
    expect(note).toContain("غير متاح");
    expect(note).toMatch(/١ من ١٠/);
    expect(workbookNoteAr({ sheets: 1, hasParentColumn: false, parentLinked: false, hasDateColumn: false })).not.toContain("غير متاح");
  });
});
