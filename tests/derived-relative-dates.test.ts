import { describe, expect, it } from "vitest";
import { createMemoryStore } from "../agent/src/memoryStore";
import { ItemStore } from "../agent/src/items/itemStore";
import { ingestRows } from "../agent/src/items/ingest";
import type { PricedPlan, PricedStage } from "../src/lib/agentMission/plan";
import { APPROX_DATES_KEY, derivedRelativeDay } from "../src/lib/agentMission/relativeDates";

/**
 * LIVE RETEST 2026-10-31 16:48 (B5, YouTube comments): both delivered comments carried the identical timestamp «2020-10-31 18:48» (Cairo; 16:48 UTC is the moment of the read). The source gives each comment BOTH a text «6 years ago» and a field
 * `publishedTime` that it computed itself as (the moment of the call) minus (that age): a made-up moment with a time of day, shown as if it were exact. The sample the planner saw said `2020-10-31T16:42:29.275Z`, which is the minute of its own call.
 * A date that is the moment of the read minus the age the same item states in words is a COMPUTED date: it is written as the approximate day (with «تقريبًا»), like any date the source gives only relatively. A real timestamp is untouched.
 */
const NOW = Date.parse("2026-10-31T16:48:24.000Z");
const DAY = 86_400_000;
const derived = (ageMs: number, offsetMs = 0) => new Date(NOW - ageMs + offsetMs).toISOString();

describe("derivedRelativeDay: the day a computed date stands for", () => {
  it("six years ago, read now: the day, not the second", () => {
    expect(derivedRelativeDay(derived(6 * 365.25 * DAY), "6 years ago", NOW)).toBe("2020-10-31");
  });
  it("the same for the other units and for a source that wrote its own text before the number", () => {
    expect(derivedRelativeDay(derived(3 * DAY), "3 days ago", NOW)).toBe("2026-10-28");
    expect(derivedRelativeDay(derived(2 * 7 * DAY), "Streamed 2 weeks ago", NOW)).toBe("2026-10-17");
    expect(derivedRelativeDay(derived(5 * 3_600_000), "5 hours ago", NOW)).toBe("2026-10-31");
  });
  it("a real timestamp is never touched: «1 day ago» next to a moment hours away from (now - 1 day)", () => {
    expect(derivedRelativeDay("2026-10-30T10:15:00.000Z", "1 day ago", NOW)).toBeNull();
    expect(derivedRelativeDay("2026-10-31T10:00:00.000Z", "", NOW)).toBeNull();
    expect(derivedRelativeDay("2026-10-31T10:00:00.000Z", "Great video", NOW)).toBeNull();
  });
  it("a date a few minutes from the computed one still counts as computed (the call took time); an hour away does not", () => {
    expect(derivedRelativeDay(derived(6 * 365.25 * DAY, -4 * 60_000), "6 years ago", NOW)).toBe("2020-10-31");
    expect(derivedRelativeDay(derived(6 * 365.25 * DAY, -3 * 3_600_000), "6 years ago", NOW)).toBeNull();
  });
});

describe("ingest: the two comments of B5 are two approximate days, not two identical timestamps", () => {
  const stage = (): PricedStage => ({
    key: "comments", title_ar: "التعليقات المنشورة", endpoint_id: "e", expected_rows: 4, planned_rows: 4, parent_key: null, deliver: true,
    columns: [{ key: "text", title_ar: "نص التعليق" }, { key: "author", title_ar: "الكاتب" }, { key: "date", title_ar: "تاريخ التعليق" }], sample_rows: [], measured_by: [],
  } as unknown as PricedStage);
  const plan = (s: PricedStage): PricedPlan => ({ summary_ar: "x", stages: [s], price: { deliveredRows: s.planned_rows } } as unknown as PricedPlan);
  async function ingest(rows: Array<Record<string, unknown>>) {
    const store = createMemoryStore();
    const items = await ItemStore.open(store, "msn_dates01");
    const s = stage();
    await ingestRows({ items, plan: plan(s), addEvent: async () => undefined }, s, rows, { silent: true, idField: null, now: NOW });
    return items.acceptedRows("comments");
  }
  it("a computed date becomes the approximate day and the column is marked; a real timestamp keeps its moment", async () => {
    const rows = await ingest([
      { id: "c1", text: "شكل ميسي زهقان", author: "@a", date: derived(6 * 365.25 * DAY), published_text: "6 years ago" },
      { id: "c2", text: "تركي ال شيخ شخصية محترمة", author: "@b", date: derived(6 * 365.25 * DAY, 1_000), published_text: "6 years ago" },
      { id: "c3", text: "تعليق حديث", author: "@c", date: "2026-10-30T10:15:00.000Z", published_text: "1 day ago" },
      { id: "c4", text: "تعليق بلا نص نسبي", author: "@d", date: "2026-10-31T10:00:00.000Z" },
    ]);
    const byId = new Map(rows.map((r) => [String(r.id), r]));
    expect(byId.get("c1")!.date).toBe("2020-10-31");
    expect(byId.get("c2")!.date).toBe("2020-10-31");
    expect(byId.get("c1")![APPROX_DATES_KEY]).toEqual(["date"]);
    expect(byId.get("c2")![APPROX_DATES_KEY]).toEqual(["date"]);
    expect(byId.get("c3")!.date).toBe("2026-10-30T10:15:00.000Z");
    expect(byId.get("c3")![APPROX_DATES_KEY]).toBeUndefined();
    expect(byId.get("c4")!.date).toBe("2026-10-31T10:00:00.000Z");
    expect(byId.get("c4")![APPROX_DATES_KEY]).toBeUndefined();
  });
});
