import { describe, expect, it } from "vitest";
import { parseCatalog, type CatalogEndpoint } from "../src/lib/treg/catalog";
import { coverageOf, rankByCoverage } from "../src/lib/agentMission/sourceRanking";
import { conditionsOfRequest } from "../src/lib/agentMission/requestConditions";
import { buildTools } from "../agent/src/tools";
import { makeHarness } from "./helpers/agentHarness";
import { normalizeRedesignFlags } from "../src/lib/agentMission/redesignFlags";

/**
 * S1 item 1.5: THE CANDIDATE COMPARISON BY COVERAGE, THEN PRICE (docs/REDESIGN.md section 4; owner decision D7). The sources that can express MORE of the customer's conditions in their own inputs rank first; price decides among equals. When no
 * candidate can express a condition, the cheaper one wins and the condition is reported as a gap (the plan card says so, item 1.7). Schema always read: `treg_call` is refused in the new mode until `describe_endpoint` was called for that endpoint.
 */
const input = (name: string, extra: Record<string, unknown> = {}) => ({ name, in: null, type: "string", required: false, enum: null, minimum: null, maximum: null, default: null, example: null, note: null, ...extra });
const endpoint = (id: string, usd: number, inputs: ReturnType<typeof input>[]): CatalogEndpoint => ({ id, provider: id.split(".")[0], platform: "x", category: null, capability: "x.search.posts", name: id, summary: null, method: "GET", path: "/", kind: "direct", tier: null, async: null, async_config: null, inputs, pagination: [], cost: { unit: "call", usd, type: "per_call", currency: "USD", value: usd, per: 1, billing_note: null, failed_or_empty_billed: null }, observed: null, scope: "public", cost_confidence: null, siblings: [], test_request: null, list_path: null, cursor_path: null, item_fields: null, example_response_trimmed: null }) as unknown as CatalogEndpoint;
const cheap = endpoint("a.cheap.search", 0.001, [input("query", { required: true }), input("limit", { type: "integer", maximum: 20 })]);
const dear = endpoint("b.dear.search", 0.004, [input("query", { required: true }), input("startDate"), input("endDate"), input("limit", { type: "integer", maximum: 20 })]);
const catalog = parseCatalog({ endpoints: [cheap, dear] }, []);

describe("coverage first, then price", () => {
  it("with a date range requested, the dearer tool that has a date field outranks the cheaper one without", () => {
    const r = rankByCoverage([cheap, dear], catalog, new Map(), Date.now(), ["date"]);
    expect(r.ranked.map((x) => x.id)).toEqual(["b.dear.search", "a.cheap.search"]);
    expect(r.ranked[0]).toMatchObject({ covered: ["date"], missing: [] });
    expect(r.ranked[1]).toMatchObject({ covered: [], missing: ["date"] });
  });
  it("with no condition requested, price decides as it always did", () => {
    expect(rankByCoverage([cheap, dear], catalog, new Map(), Date.now(), []).ranked.map((x) => x.id)).toEqual(["a.cheap.search", "b.dear.search"]);
  });
  it("with no tool able to express the condition, the cheaper wins and the gap is reported", () => {
    const r = rankByCoverage([cheap, dear], catalog, new Map(), Date.now(), ["language"]);
    expect(r.ranked.map((x) => x.id)).toEqual(["a.cheap.search", "b.dear.search"]);
    expect(r.gaps).toEqual(["language"]);
  });
  it("a search that takes advanced operators in its query can express a date, a language, an account and replies, but never a country", () => {
    const x = endpoint("c.ops.search", 0.002, [input("query", { required: true, note: "Search query using X advanced-search syntax: since: until: lang:" })]);
    expect(coverageOf(x, ["date", "language", "account", "replies", "country"])).toMatchObject({ covered: ["date", "language", "account", "replies"], missing: ["country"] });
  });
  it("a region input that does not filter does not count as expressing the country", () => {
    const t = endpoint("d.region.search", 0.002, [input("query", { required: true }), input("region", { note: "Does NOT filter results to that region only: it places the proxy there" })]);
    expect(coverageOf(t, ["country"])).toMatchObject({ covered: [], missing: ["country"] });
  });
});

describe("the wanted conditions are read from the customer's words by code", () => {
  it("the owner's benchmark requests", () => {
    expect(conditionsOfRequest("هات ٥٠ تغريدة عن الذكاء الاصطناعي في مصر آخر أسبوع باللغة العربية")).toEqual(["date", "language", "country", "count"]);
    expect(conditionsOfRequest("هات ٢٠ تغريدة فيها «العاصمة الإدارية» بالعربي في أكتوبر ٢٠٢٦، مع الردود")).toEqual(["date", "language", "count", "replies"]);
    expect(conditionsOfRequest("هات منشورات حساب @alhadath على إنستجرام، ومع كل منشور كل التعليقات وكل الردود")).toEqual(["account", "replies"]);
    expect(conditionsOfRequest("هات فيديوهات تيك توك بالعربي عن الذكاء الاصطناعي، من مصر أو المنطقة العربية، ومع كل فيديو كل التعليقات وكل الردود")).toEqual(["language", "country", "replies"]);
  });
});

describe("schema always read: treg_call needs describe_endpoint first, in the new mode only", () => {
  const toolOf = (h: ReturnType<typeof makeHarness>, name: string) => buildTools(h.ctx).find((t) => t.name === name)!;
  const ID = "anyapi.x.search.posts";
  it("new mode: a call before describe_endpoint is refused and makes no provider call", async () => {
    const h = makeHarness({ responses: [] });
    h.ctx.redesign = { flags: normalizeRedesignFlags({ social_posts: "on" }), isTest: false };
    const r = await toolOf(h, "treg_call").handler({ endpoint_id: ID, params: { query: "x" } });
    expect(r).toMatchObject({ ok: false, refused: "describe_first" });
    expect(h.call).not.toHaveBeenCalled();
  });
  it("new mode: after describe_endpoint the call is no longer refused for that reason", async () => {
    const h = makeHarness({ responses: [] });
    h.ctx.redesign = { flags: normalizeRedesignFlags({ social_posts: "on" }), isTest: false };
    await toolOf(h, "describe_endpoint").handler({ id: ID });
    const r = await toolOf(h, "treg_call").handler({ endpoint_id: ID, params: { query: "x" } }).catch(() => ({ ok: false, refused: "provider_called" }));
    expect((r as { refused?: string }).refused).not.toBe("describe_first");
  });
  it("flags off (or no redesign context): the old behaviour, no describe-first refusal", async () => {
    for (const redesign of [undefined, { flags: normalizeRedesignFlags({}), isTest: false }]) {
      const h = makeHarness({ responses: [] });
      if (redesign) h.ctx.redesign = redesign;
      const r = await toolOf(h, "treg_call").handler({ endpoint_id: ID, params: { query: "x" } }).catch(() => ({ ok: false, refused: "provider_called" }));
      expect((r as { refused?: string }).refused).not.toBe("describe_first");
    }
  });
});
