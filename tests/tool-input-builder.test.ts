import { describe, expect, it } from "vitest";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { buildToolInput, understoodOfStage } from "../src/lib/agentMission/toolInput";

/**
 * S1 item 1.6: THE CODE-BUILT PROVIDER REQUEST (docs/REDESIGN.md section 3). From the understood record and the tool's own profile, CODE writes the conditions into the tool's fields: the period (a preset, a range, or `since:`/`until:` in the query),
 * the language, the country, the account, the page size, the sort and the replies. A field the tool does not have is a reported GAP, never an invented field; an unknown field or an enum value outside the allowed list is REFUSED, never silently deleted.
 */
const catalog = loadTregCatalog();
const ep = (id: string) => catalog.byId.get(id)!;
const NOW = Date.parse("2026-11-01T12:00:00Z");
const dayBefore = (n: number): string => new Date(NOW - n * 86_400_000).toISOString().slice(0, 10);

describe("TikTok video search", () => {
  const tiktok = ep("scrapecreators.tiktok.search.videos");
  it("Arabic + last 7 days: the preset «this-week», the region written, the language reported as a gap, the region as not enforced", () => {
    const r = buildToolInput(tiktok, { period: { days: 7 }, language: "ar", country: ["EG"], count: 50, nowMs: NOW }, { query: "الذكاء الاصطناعي" });
    expect(r.ok).toBe(true);
    expect(r.params).toMatchObject({ query: "الذكاء الاصطناعي", date_posted: "this-week", region: "EG" });
    expect(Object.keys(r.params).some((k) => /^lang/i.test(k))).toBe(false);
    expect(r.gaps).toEqual(expect.arrayContaining([{ cls: "language", reason: "no_field" }, { cls: "country", reason: "not_enforced" }]));
    expect(r.gaps.some((g) => g.cls === "date")).toBe(false);
    expect(r.written).toEqual(expect.arrayContaining(["date", "country"]));
  });
  it("the preset is the smallest one that covers the period (coarser, never narrower)", () => {
    expect(buildToolInput(tiktok, { period: { days: 20 }, nowMs: NOW }, { query: "x" }).params.date_posted).toBe("this-month");
    expect(buildToolInput(tiktok, { period: { days: 90 }, nowMs: NOW }, { query: "x" }).params.date_posted).toBe("last-3-months");
    expect(buildToolInput(tiktok, { period: { days: 1 }, nowMs: NOW }, { query: "x" }).params.date_posted).toBe("yesterday");
  });
  it("an enum value outside the allowed list is refused, nothing is deleted and nothing is built", () => {
    const base = { query: "x", sort_by: "nonsense" };
    const r = buildToolInput(tiktok, { period: { days: 7 }, nowMs: NOW }, base);
    expect(r.ok).toBe(false);
    expect(r.refused).toEqual([{ field: "sort_by", reason: "not_in_enum" }]);
    expect(r.params).toEqual(base);
  });
  it("a field the endpoint does not have is refused (the gateway would delete it silently), the other fields are kept", () => {
    const base = { query: "x", bogus_field: 1 };
    const r = buildToolInput(tiktok, {}, base);
    expect(r.ok).toBe(false);
    expect(r.refused).toEqual([{ field: "bogus_field", reason: "unknown_field" }]);
    expect(r.params).toEqual(base);
  });
});

describe("a range of dates", () => {
  it("Facebook post search: startDate and endDate as yyyy-MM-dd; a language it has no field for is a gap and no field is invented", () => {
    const fb = ep("justoneapi.x.facebook-search-post-v1");
    const r = buildToolInput(fb, { period: { days: 90 }, language: "ar", nowMs: NOW }, { keyword: "الذكاء الاصطناعي" });
    expect(r.params).toMatchObject({ keyword: "الذكاء الاصطناعي", startDate: dayBefore(90), endDate: dayBefore(0) });
    expect(r.gaps).toEqual([{ cls: "language", reason: "no_field" }]);
    expect(Object.keys(r.params).sort()).toEqual(["endDate", "keyword", "startDate"]);
  });
  it("X recent search: ISO times", () => {
    const x = ep("x.x.search-posts-recent");
    const r = buildToolInput(x, { period: { from: "2026-10-30", to: "2026-10-31" }, count: 20, nowMs: NOW }, { query: "العاصمة الإدارية" });
    // CHANGED (S1 live findings fix 5): the days are Cairo days; 30 October starts at 22:00 UTC on the 29th (UTC+2 after summer time ended), 31 October ends at 21:59:59 UTC (was UTC midnight)
    expect(r.params).toMatchObject({ start_time: "2026-10-29T22:00:00Z", end_time: "2026-10-31T21:59:59Z", max_results: 20 });
  });
});

describe("X search with operators: the conditions go INTO the query", () => {
  const x = ep("anyapi.x.search.posts");
  it("a range, Arabic, replies not wanted, Latest, 20 a page", () => {
    const r = buildToolInput(x, { period: { from: "2026-10-01", to: "2026-10-31" }, language: "ar", replies: "exclude", sort: "latest", count: 20, nowMs: NOW }, { query: "العاصمة الإدارية" });
    expect(r.ok).toBe(true);
    const q = String(r.params.query);
    expect(q.startsWith("العاصمة الإدارية")).toBe(true);
    // CHANGED (S1 live findings fix 5): October in Cairo time is 21:00 UTC on 30 September to 22:00 UTC on 31 October (was the UTC days 2026-10-01 and 2026-11-01)
    expect(q).toContain("since:2026-09-30_21:00:00_UTC");
    expect(q).toContain("until:2026-10-31_22:00:00_UTC");
    expect(q).toContain("lang:ar");
    expect(q).toContain("-filter:replies");
    expect(r.params).toMatchObject({ queryType: "Latest", limit: 20 });
    expect(r.gaps).toEqual([]);
  });
  it("an operator already in the query is not written twice; a country is a gap (never written into a query)", () => {
    const r = buildToolInput(x, { period: { days: 7 }, language: "ar", country: ["EG"], nowMs: NOW }, { query: "x lang:ar" });
    expect(String(r.params.query).match(/lang:/g)).toHaveLength(1);
    expect(r.gaps).toEqual([{ cls: "country", reason: "no_field" }]);
  });
  it("a page size above the endpoint's maximum is lowered to it", () => {
    const yt = ep("youtube.youtube.video.comments");
    expect(buildToolInput(yt, { count: 500, nowMs: NOW }, { part: "snippet", videoId: "v" }).params.maxResults).toBe(100);
  });
  it("the base is never mutated", () => {
    const base = { query: "x" };
    buildToolInput(x, { period: { days: 7 }, nowMs: NOW }, base);
    expect(base).toEqual({ query: "x" });
  });
});

describe("the understood record of a stage is read from its typed filters", () => {
  it("period, language, country, account, replies and the count", () => {
    const u = understoodOfStage({ planned_rows: 50, filters: [{ kind: "period", field: "date", days: 7 }, { kind: "language", lang: "ar" }, { kind: "place", places: ["EG", "EG:cairo"], values: ["مصر"] }, { kind: "account", values: ["@alhadath"] }, { kind: "exclude_replies" }], parent_key: null } as never, NOW);
    expect(u).toEqual({ period: { days: 7 }, language: "ar", country: ["EG"], account: ["alhadath"], replies: "exclude", count: 50, nowMs: NOW });
  });
  it("a disabled filter is not asked for; a child stage asks for nothing but its own count", () => {
    expect(understoodOfStage({ planned_rows: 10, filters: [{ kind: "language", lang: "ar", enabled: false }], parent_key: null } as never, NOW)).toEqual({ count: 10, nowMs: NOW });
    expect(understoodOfStage({ planned_rows: 50, filters: [{ kind: "language", lang: "ar" }], parent_key: "posts" } as never, NOW)).toEqual({ nowMs: NOW });
  });
});
