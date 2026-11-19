import { describe, expect, it } from "vitest";
import { parseRange, rangeStart, summarizeVisits, type VisitEventRow } from "../src/lib/analytics/summary";

/** DT-20261118-06 phase 1A: «الزيارات · آخر ١٤ يومًا» on the overview. One bucket per Cairo day (the owner's day), oldest first, a day without visits is present with 0. Pure. */
const row = (over: Partial<VisitEventRow>): VisitEventRow => ({ visitor_id: "v1", session_id: "s1", kind: "view", path: "/", country: "EG", device_class: "mobile", started_at: "2026-11-18T10:00:00Z", duration_seconds: null, user_id: null, ...over });
// 14:00 in Cairo on 18 November (UTC+2 in winter)
const NOW = new Date("2026-11-18T12:00:00Z");

describe("summarizeVisits daily", () => {
  it("has the last 14 Cairo days, oldest first, each present with 0 when nothing happened", () => {
    const s = summarizeVisits([], { range: "14d", since: null, now: NOW });
    expect(s.daily).toHaveLength(14);
    expect(s.daily[0]).toEqual({ day: "2026-11-05", visits: 0, uniqueVisitors: 0 });
    expect(s.daily[13]).toEqual({ day: "2026-11-18", visits: 0, uniqueVisitors: 0 });
    expect(s.daily.map((d) => d.day)).toEqual([...s.daily.map((d) => d.day)].sort());
  });

  it("puts a visit on the Cairo day of its first view (not the UTC day), counts unique visitors per day, ignores leave rows and days older than 14", () => {
    const rows = [
      row({ session_id: "s1", visitor_id: "v1", started_at: "2026-11-17T22:30:00Z" }), // 00:30 on 18 Nov in Cairo, 17 Nov in UTC
      row({ session_id: "s2", visitor_id: "v2", started_at: "2026-11-17T21:30:00Z" }), // 23:30 on 17 Nov in Cairo
      row({ session_id: "s2", visitor_id: "v2", started_at: "2026-11-17T22:10:00Z", path: "/pricing" }), // same visit after midnight: still one visit, on the 17th
      row({ session_id: "s3", visitor_id: "v1", started_at: "2026-11-18T08:00:00Z" }), // v1 again on the 18th: two visits, one visitor
      row({ session_id: "s4", visitor_id: "v3", started_at: "2026-11-10T09:00:00Z" }),
      row({ session_id: "s4", visitor_id: "v3", kind: "leave", duration_seconds: 30, started_at: "2026-11-16T09:00:00Z" }),
      row({ session_id: "s5", visitor_id: "v4", started_at: "2026-11-01T09:00:00Z" }), // older than the 14 days
    ];
    const s = summarizeVisits(rows, { range: "all", since: null, now: NOW });
    const byDay = new Map(s.daily.map((d) => [d.day, d]));
    expect(byDay.get("2026-11-18")).toEqual({ day: "2026-11-18", visits: 2, uniqueVisitors: 2 }); // s1, s3; v1 and v2 (v2's view after midnight)
    expect(byDay.get("2026-11-17")).toEqual({ day: "2026-11-17", visits: 1, uniqueVisitors: 1 });
    expect(byDay.get("2026-11-10")).toEqual({ day: "2026-11-10", visits: 1, uniqueVisitors: 1 });
    expect(byDay.get("2026-11-16")).toEqual({ day: "2026-11-16", visits: 0, uniqueVisitors: 0 });
    expect(byDay.has("2026-11-01")).toBe(false);
    // the existing totals are unchanged by the new field
    expect(s).toMatchObject({ visits: 5, pageViews: 6, uniqueVisitors: 4, range: "all" });
  });

  it("in summer Cairo is UTC+3: 21:30 UTC is already the next Cairo day", () => {
    const s = summarizeVisits([row({ started_at: "2026-07-14T21:30:00Z" })], { range: "14d", since: null, now: new Date("2026-07-15T12:00:00Z") });
    expect(s.daily[13]).toEqual({ day: "2026-07-15", visits: 1, uniqueVisitors: 1 });
    expect(s.daily[12]).toEqual({ day: "2026-07-14", visits: 0, uniqueVisitors: 0 });
  });

  it("the «14d» range starts at Cairo midnight 13 days before today and is accepted from the address", () => {
    expect(rangeStart("14d", NOW)!.toISOString()).toBe("2026-11-04T22:00:00.000Z");
    expect(parseRange("14d")).toBe("14d");
  });
});
