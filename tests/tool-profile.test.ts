import { describe, expect, it } from "vitest";
import { loadTregCatalog, type CatalogEndpoint } from "../src/lib/treg/catalog";
import { toolProfile } from "../src/lib/agentMission/toolProfile";

/**
 * S1 item 1.4: THE TOOL INPUT PROFILE (pure, catalog-driven). For an endpoint: which condition classes its OWN inputs can express (date range or preset, language, country, account, count, sort, replies, cursor), with the exact field
 * names, read from `inputs[]`, `enum` and `pagination`. A name the profile does not recognise is reported as unknown, never guessed.
 */
const catalog = loadTregCatalog();
const profileOf = (id: string) => { const e = catalog.byId.get(id); if (!e) throw new Error(`catalog has no ${id}`); return toolProfile(e); };

describe("real catalog endpoints", () => {
  it("TikTok video search: a date PRESET with its values, a sort, a region that does not filter, no language", () => {
    const p = profileOf("scrapecreators.tiktok.search.videos");
    expect(p.date).toMatchObject({ preset: { field: "date_posted" }, from: null, to: null });
    expect(p.date!.preset!.values).toEqual(["yesterday", "this-week", "this-month", "last-3-months", "last-6-months", "all-time"]);
    expect(p.sort).toMatchObject({ field: "sort_by", values: ["relevance", "most-liked", "date-posted"] });
    expect(p.country).toMatchObject({ field: "region", enforces: false });
    expect(p.language).toBeNull();
    expect(p.cursor).toMatchObject({ field: "cursor" });
    expect(p.query).toMatchObject({ field: "query" });
  });
  it("Facebook post search: a date RANGE as yyyy-MM-dd", () => {
    const p = profileOf("justoneapi.x.facebook-search-post-v1");
    expect(p.date).toMatchObject({ from: "startDate", to: "endDate", format: "yyyy-MM-dd", preset: null });
    expect(p.language).toBeNull();
    expect(p.country).toBeNull();
  });
  it("X search by query operators: nothing but the query carries a condition; page size, cursor and ranking are inputs", () => {
    const p = profileOf("anyapi.x.search.posts");
    expect(p.date).toBeNull();
    expect(p.language).toBeNull();
    expect(p.country).toBeNull();
    expect(p.queryOperators).toBe(true);
    expect(p.count).toMatchObject({ field: "limit" });
    expect(p.cursor).toMatchObject({ field: "cursor" });
    expect(p.sort).toMatchObject({ field: "queryType" });
  });
  it("X recent search: a time range and a cursor input that `pagination` does not list", () => {
    const e = catalog.byId.get("x.x.search-posts-recent")!;
    expect(e.pagination).toEqual([]);
    const p = toolProfile(e);
    expect(p.date).toMatchObject({ from: "start_time", to: "end_time", format: "iso" });
    expect(["next_token", "pagination_token"]).toContain(p.cursor!.field);
    expect(p.count).toMatchObject({ field: "max_results" });
  });
  it("YouTube comments: page token as cursor, page size, order as sort", () => {
    const p = profileOf("youtube.youtube.video.comments");
    expect(p.cursor).toMatchObject({ field: "pageToken" });
    expect(p.count).toMatchObject({ field: "maxResults" });
    expect(p.sort).toMatchObject({ field: "order" });
  });
});

describe("an input the profile does not recognise is reported, never guessed", () => {
  const endpoint = (inputs: Array<Partial<CatalogEndpoint["inputs"][number]> & { name: string }>): CatalogEndpoint => ({ id: "t.t", provider: "t", platform: "x", pagination: [], inputs: inputs.map((i) => ({ in: null, type: "string", required: false, enum: null, minimum: null, maximum: null, default: null, example: null, note: null, ...i })) } as unknown as CatalogEndpoint);
  it("lists unknown names and invents no field", () => {
    const p = toolProfile(endpoint([{ name: "query", required: true }, { name: "zorp" }, { name: "frobnicate" }]));
    expect(p.unknown).toEqual(["zorp", "frobnicate"]);
    expect(p.date).toBeNull();
    expect(p.language).toBeNull();
    expect(p.cursor).toBeNull();
  });
  it("a plain `url` input is not an account (it may name one post)", () => {
    expect(toolProfile(endpoint([{ name: "url", required: true }])).account).toBeNull();
  });
});
