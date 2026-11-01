import { describe, expect, it } from "vitest";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { buildToolInput } from "../src/lib/agentMission/toolInput";
import { markVerdict } from "../src/lib/agentMission/rawMarks";
import { cairoDayEndExclusiveMs, cairoDayStartMs, cairoRangeOf } from "../src/lib/agentMission/cairoTime";

/**
 * S1 LIVE FINDINGS fix 5 (docs/S1-LIVE-FINDINGS.md section 6, item 9): the dates a customer gives are CAIRO time. R5 asked for October 2026; the query ended at `until:2026-11-01_00:00:00_UTC`, so a tweet of 2026-11-01 00:14 Cairo time (22:14 UTC on the 31st)
 * was inside. Cairo is UTC+3 in summer (Egypt's summer time) and UTC+2 otherwise; the boundaries are converted with the zone's own rules, never a fixed offset.
 */
const iso = (ms: number) => new Date(ms).toISOString();

describe("Cairo day boundaries", () => {
  it("1 October 2026 starts at 21:00 UTC on 30 September (summer time, UTC+3)", () => {
    expect(iso(cairoDayStartMs("2026-10-01"))).toBe("2026-09-30T21:00:00.000Z");
  });
  it("1 November 2026 starts at 22:00 UTC on 31 October (winter time, UTC+2: summer time ended on 29 October)", () => {
    expect(iso(cairoDayStartMs("2026-11-01"))).toBe("2026-10-31T22:00:00.000Z");
  });
  it("the day summer time starts has no 00:00: its first moment is 01:00 local, which is 22:00 UTC the day before", () => {
    expect(iso(cairoDayStartMs("2026-04-24"))).toBe("2026-04-23T22:00:00.000Z");
  });
  it("the end of a day is the start of the next one (exclusive)", () => {
    expect(cairoDayEndExclusiveMs("2026-10-31")).toBe(cairoDayStartMs("2026-11-01"));
  });
  it("October 2026 in Cairo time", () => {
    const r = cairoRangeOf("2026-10-01", "2026-10-31");
    expect(iso(r.startMs)).toBe("2026-09-30T21:00:00.000Z");
    expect(iso(r.endExclusiveMs)).toBe("2026-10-31T22:00:00.000Z");
  });
});

const catalog = loadTregCatalog();
const NOW = Date.parse("2026-11-01T12:00:00Z");

describe("the tool input carries Cairo boundaries", () => {
  it("R5: a search with operators gets since/until at Cairo midnight, written in UTC with the time of day", () => {
    const r = buildToolInput(catalog.byId.get("anyapi.x.search.posts")!, { period: { from: "2026-10-01", to: "2026-10-31" }, language: "ar", sort: "latest", count: 20, nowMs: NOW }, { query: "العاصمة الإدارية" });
    expect(r.ok).toBe(true);
    const q = String(r.params.query);
    expect(q).toContain("since:2026-09-30_21:00:00_UTC");
    expect(q).toContain("until:2026-10-31_22:00:00_UTC");
    expect(q).not.toContain("until:2026-11-01_00:00:00_UTC");
  });
  it("a source that takes only days is asked for the UTC days that COVER the Cairo range (wider, never narrower; the mark states membership)", () => {
    const r = buildToolInput(catalog.byId.get("justoneapi.x.facebook-search-post-v1")!, { period: { from: "2026-10-01", to: "2026-10-31" }, nowMs: NOW }, { keyword: "x" });
    expect(r.ok).toBe(true);
    expect(r.params).toMatchObject({ startDate: "2026-09-30", endDate: "2026-10-31" });
  });
});

describe("the mark «ضمن الفترة المطلوبة» is Cairo time", () => {
  const period = [{ kind: "period", from: "2026-10-01", to: "2026-10-31", field: "posted_at", enabled: true }] as never;
  const at = (iso: string) => markVerdict(period, { posted_at: iso, text: "x" }, { textKey: "text", now: NOW }).inPeriod;
  it("a tweet of 2026-11-01 00:14 Cairo time (22:14 UTC on the 31st) is OUTSIDE October", () => {
    expect(at("2026-10-31T22:14:00Z")).toBe(false);
  });
  it("a tweet of 2026-10-01 00:30 Cairo time (21:30 UTC on 30 September) is INSIDE October", () => {
    expect(at("2026-09-30T21:30:00Z")).toBe(true);
  });
  it("the last minute of October in Cairo (21:59 UTC on the 31st) is inside", () => {
    expect(at("2026-10-31T21:59:00Z")).toBe(true);
  });
});
