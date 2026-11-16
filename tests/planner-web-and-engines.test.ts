import { describe, expect, it } from "vitest";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { candidatesFor, directWebEndpoints, SEARCH_ENGINE_PLATFORMS } from "../agent/src/llmPlanner/catalogView";
import { checkOptions, SCOUT_SHORT_SHARE } from "../agent/src/llmPlanner/planner";
import { sourceLabelAr } from "../agent/src/methodology";
import { webRequestOf } from "../agent/src/engine/sourceGateway";
import { checkCustomerText } from "../src/lib/agentMission/text";

/**
 * LIVE, 16 Nov 2026: «آخر ٢٠ خبر عن الذكاء الاصطناعي في السعودية» delivered 15: it was planned on the web news tools only (one answered 402 eight times, the other gave 5 a call and ran dry) while the catalog's Google
 * News tools and our own Firecrawl and Context.dev keys were never offered; «٢٠ ريفيو لسماعة سوني» delivered 10 with no question before approval.
 */
const catalog = loadTregCatalog();

describe("a news or web search may use every engine and our own web tools", () => {
  it("web news also offers the other engines' news tools", () => {
    const c = candidatesFor(catalog, null, "web", "web.search.news", 8);
    expect(c.some((e) => e.platform === "web")).toBe(true);
    expect(c.some((e) => e.platform !== "web" && SEARCH_ENGINE_PLATFORMS.has(e.platform) && /news/.test(String(e.capability)))).toBe(true);
    expect(c.every((e) => /news/.test(String(e.capability)))).toBe(true);
  });
  it("Google News also offers the web's news tools", () => {
    expect(candidatesFor(catalog, null, "google", "google.serp.news", 8).some((e) => e.platform === "web")).toBe(true);
  });
  it("the direct web tools are offered only when their key exists, and only for searches", () => {
    const web = directWebEndpoints({ firecrawl: true, contextdev: true });
    expect(web.map((e) => e.id)).toEqual(["contextdev.search", "firecrawl.search"]);
    expect(directWebEndpoints({ firecrawl: false, contextdev: false })).toEqual([]);
    expect(candidatesFor(catalog, null, "web", "web.search.news", 8, { web }).map((e) => e.id)).toEqual(expect.arrayContaining(["contextdev.search", "firecrawl.search"]));
    expect(candidatesFor(catalog, null, "amazon", "amazon.product.reviews", 8, { web }).some((e) => e.id === "firecrawl.search")).toBe(false);
    expect(candidatesFor(catalog, null, "google", "google.maps.reviews", 8, { web }).some((e) => e.id === "firecrawl.search")).toBe(false);
  });
  it("the model fills a direct web tool like any other, and the engine knows how to call it", () => {
    const web = directWebEndpoints({ firecrawl: true, contextdev: true });
    const opts = checkOptions({ options: [{ endpoint_id: "contextdev.search", params_json: JSON.stringify({ query: "الذكاء الاصطناعي السعودية", limit: 30, country: "SA" }), more_params_json: [JSON.stringify({ query: "سدايا الذكاء الاصطناعي", limit: 30 })] }] }, web, false);
    expect(opts).toHaveLength(1);
    expect(opts[0]!.params).toEqual({ query: "الذكاء الاصطناعي السعودية", limit: 30, country: "SA" });
    expect(webRequestOf("contextdev.search", opts[0]!.params)).toEqual({ method: "webSearch", args: { provider: "contextdev", query: "الذكاء الاصطناعي السعودية", limit: 30, country: "SA" } });
  });
});

describe("the customer never reads our providers' names", () => {
  it("the methodology names the kind of source, never the tool", () => {
    for (const id of ["firecrawl.search", "contextdev.search"]) {
      const label = sourceLabelAr(id)!;
      expect(label).toBe("البحث في صفحات الويب");
      expect(checkCustomerText(label).issues).toEqual([]);
    }
  });
});

describe("a shortfall found while planning is asked before approval", () => {
  it("anything under nine tenths of the number is asked (10 of 20 and 15 of 20 were planned silently)", () => {
    expect(10 < Math.ceil(20 * SCOUT_SHORT_SHARE)).toBe(true);
    expect(15 < Math.ceil(20 * SCOUT_SHORT_SHARE)).toBe(true);
    expect(19 < Math.ceil(20 * SCOUT_SHORT_SHARE)).toBe(false);
  });
});

describe("the planner proves our own web search as the last fallback of a news search that runs dry", () => {
  it("a 5-item news source: the plan reads it first, then our web search on the step's own phrases", async () => {
    const { planWithLlm } = await import("../agent/src/llmPlanner/planner");
    const answers: Record<string, unknown[]> = {
      request_plan: [{ decision: "plan", understanding_ar: "آخر عشرين خبرًا عن الذكاء الاصطناعي في السعودية.", assumptions_ar: [], accepts_available: false,
        steps: [{ key: "news", title_ar: "الأخبار", platform: "web", capability: "web.search.news", parent: null, deliver: true, count: { total: 20, all: false }, topic: "الذكاء الاصطناعي في السعودية", search_terms: ["الذكاء الاصطناعي السعودية", "سدايا"] }] }],
      tool_choice: [{ options: [{ endpoint_id: "octen.web.search.news", params_json: JSON.stringify({ query: "الذكاء الاصطناعي في السعودية" }) }] }],
      field_map: [
        { fields: { id: ["url"], title: ["title"], link: ["url"] }, extra: [] },
        { fields: { id: ["url"], title: ["title"], link: ["url"], text: ["description"] }, extra: [] },
      ],
    };
    const probes: string[] = [];
    const pages = new Map<string, unknown>();
    let n = 0;
    const r = await planWithLlm({ words: ["هات آخر ٢٠ خبر عن الذكاء الاصطناعي في السعودية"], request: "", scoutAllowed: false }, {
      model: async ({ tool }) => { const next = (answers[tool.name] ?? []).shift(); return next === undefined ? null : { input: next, costUsd: 0.001 }; },
      catalog, access: null, today: "2026-11-16", webTools: directWebEndpoints({ contextdev: true, firecrawl: true }),
      probe: async (id) => {
        probes.push(id); n += 1; const call_id = `call_${n}`;
        const web = id === "contextdev.search";
        pages.set(call_id, web ? { rows: Array.from({ length: 30 }, (_, k) => ({ title: `خبر ${k}`, url: `https://news.example/${k}`, description: "الذكاء الاصطناعي في السعودية" })) } : { data: { results: Array.from({ length: 5 }, (_, k) => ({ title: `عنوان ${k}`, url: `https://site.example/${k}` })) } });
        return { ok: true, call_id, http_status: 200, rows_in_page: web ? 30 : 5, has_more: false, next_cursor: null, shape: null, first_rows: [], warnings: [], saved: call_id };
      },
      readPage: async (id) => pages.get(id) ?? null,
    });
    expect(r.kind).toBe("plan");
    if (r.kind !== "plan") return;
    expect(probes).toEqual(["octen.web.search.news", "contextdev.search"]);
    const alts = r.plan.stages[0]!.engine!.alternatives ?? [];
    expect(alts.map((a) => a.endpoint_id)).toEqual(["contextdev.search", "contextdev.search", "contextdev.search"]);
    expect(alts.map((a) => (a.params as { query: string }).query)).toEqual(["الذكاء الاصطناعي في السعودية", "الذكاء الاصطناعي السعودية", "سدايا"]);
    // nothing the customer reads names the tool
    for (const t of [r.plan.summary_ar, ...(r.plan.notes_ar ?? [])]) expect(String(t)).not.toMatch(/contextdev|firecrawl|octen/i);
  });
});
