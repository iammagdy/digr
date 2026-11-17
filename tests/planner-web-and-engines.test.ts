import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
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
    const modelCalls: Record<string, number> = {};
    const probes: string[] = [];
    const probeCalls: Array<{ id: string; params: unknown }> = [];
    const pages = new Map<string, unknown>();
    let n = 0;
    const r = await planWithLlm({ words: ["هات آخر ٢٠ خبر عن الذكاء الاصطناعي في السعودية"], request: "", scoutAllowed: false }, {
      model: async ({ tool }) => {
        modelCalls[tool.name] = (modelCalls[tool.name] ?? 0) + 1;
        const next = (answers[tool.name] ?? []).shift();
        return next === undefined ? null : { input: next, costUsd: 0.001 };
      },
      catalog, access: null, today: "2026-11-16", webTools: directWebEndpoints({ contextdev: true, firecrawl: true }),
      probe: async (id, params) => {
        probeCalls.push({ id, params });
        probes.push(id); n += 1; const call_id = `call_${n}`;
        const web = id === "contextdev.search" || id === "firecrawl.search";
        pages.set(call_id, web ? { rows: Array.from({ length: 30 }, (_, k) => ({ title: `خبر ${k}`, url: `https://news.example/${k}`, description: "الذكاء الاصطناعي في السعودية" })) } : { data: { results: Array.from({ length: 5 }, (_, k) => ({ title: `عنوان ${k}`, url: `https://site.example/${k}` })) } });
        return { ok: true, call_id, http_status: 200, rows_in_page: web ? 30 : 5, has_more: false, next_cursor: null, shape: null, first_rows: [], warnings: [], saved: call_id };
      },
      readPage: async (id) => pages.get(id) ?? null,
    });
    expect(r.kind).toBe("plan");
    if (r.kind !== "plan") return;
    expect(probes).toEqual(["octen.web.search.news", "contextdev.search"]);
    // DT-20261117-03: Firecrawl derived, not probed
    expect(modelCalls.field_map).toBe(2);
    const alts = r.plan.stages[0]!.engine!.alternatives ?? [];
    expect(alts.map((a) => a.endpoint_id)).toEqual(["contextdev.search", "contextdev.search", "contextdev.search", "firecrawl.search", "firecrawl.search", "firecrawl.search"]);
    expect(alts.map((a) => (a.params as { query: string }).query)).toEqual(["الذكاء الاصطناعي في السعودية", "الذكاء الاصطناعي السعودية", "سدايا", "الذكاء الاصطناعي في السعودية", "الذكاء الاصطناعي السعودية", "سدايا"]);
    expect(alts.slice(3).map((a) => a.map_code)).toEqual(alts.slice(0, 3).map((a) => a.map_code));
    // nothing the customer reads names the tool
    for (const t of [r.plan.summary_ar, ...(r.plan.notes_ar ?? [])]) expect(String(t)).not.toMatch(/contextdev|firecrawl|octen/i);
  });

  it("P-1 Context.dev as primary: probes primary only, reuses options for Firecrawl", async () => {
    const { planWithLlm } = await import("../agent/src/llmPlanner/planner");
    const answers: Record<string, unknown[]> = {
      request_plan: [{
        decision: "plan", understanding_ar: "آخر عشرين خبرًا عن الذكاء الاصطناعي في السعودية.", assumptions_ar: [], accepts_available: false,
        steps: [{ key: "news", title_ar: "الأخبار", platform: "web", capability: "web.search.news", parent: null, deliver: true, count: { total: 20, all: false }, topic: "الذكاء الاصطناعي في السعودية", search_terms: ["سدايا"] }],
      }],
      tool_choice: [{
        options: [{
          endpoint_id: "contextdev.search",
          params_json: JSON.stringify({ query: "الذكاء الاصطناعي في السعودية" }),
          more_params: [{ query: "سدايا" }],
        }],
      }],
      field_map: [
        { fields: { id: ["url"], title: ["title"], link: ["url"] }, extra: [] },
      ],
    };
    const modelCalls: Record<string, number> = {};
    const probes: string[] = [];
    const pages = new Map<string, unknown>();
    let n = 0;
    const r = await planWithLlm({ words: ["هات آخر ٢٠ خبر"], request: "", scoutAllowed: false }, {
      model: async ({ tool }) => {
        modelCalls[tool.name] = (modelCalls[tool.name] ?? 0) + 1;
        const next = (answers[tool.name] ?? []).shift();
        return next === undefined ? null : { input: next, costUsd: 0.001 };
      },
      catalog, access: null, today: "2026-11-16", webTools: directWebEndpoints({ contextdev: true, firecrawl: true }),
      probe: async (id) => {
        probes.push(id); n += 1; const call_id = `call_${n}`;
        pages.set(call_id, { rows: Array.from({ length: 5 }, (_, k) => ({ title: `خبر ${k}`, url: `https://news.example/${k}` })) });
        return { ok: true, call_id, http_status: 200, rows_in_page: 5, has_more: false, next_cursor: null, shape: null, first_rows: [], warnings: [], saved: call_id };
      },
      readPage: async (id) => pages.get(id) ?? null,
    });
    expect(r.kind).toBe("plan");
    if (r.kind !== "plan") return;
    expect(probes).toEqual(["contextdev.search"]);
    expect(modelCalls.field_map).toBe(1);
    const alts = r.plan.stages[0]!.engine!.alternatives ?? [];
    expect(alts.map((a) => a.endpoint_id)).toEqual(["contextdev.search", "firecrawl.search", "firecrawl.search"]);
    expect(alts.map((a) => (a.params as { query: string }).query)).toEqual(["سدايا", "الذكاء الاصطناعي في السعودية", "سدايا"]);
  });

  it("P-2 Context.dev as second option: probes octen then contextdev, derives firecrawl", async () => {
    const { planWithLlm } = await import("../agent/src/llmPlanner/planner");
    const answers: Record<string, unknown[]> = {
      request_plan: [{
        decision: "plan", understanding_ar: "آخر عشرين خبرًا عن الذكاء الاصطناعي في السعودية.", assumptions_ar: [], accepts_available: false,
        steps: [{ key: "news", title_ar: "الأخبار", platform: "web", capability: "web.search.news", parent: null, deliver: true, count: { total: 20, all: false }, topic: "الذكاء الاصطناعي في السعودية", search_terms: [] }],
      }],
      tool_choice: [{
        options: [
          { endpoint_id: "octen.web.search.news", params_json: JSON.stringify({ query: "الذكاء الاصطناعي في السعودية" }) },
          { endpoint_id: "contextdev.search", params_json: JSON.stringify({ query: "الذكاء الاصطناعي السعودية" }) },
        ],
      }],
      field_map: [
        { fields: { id: ["url"], title: ["title"], link: ["url"] }, extra: [] },
        { fields: { id: ["url"], title: ["title"], link: ["url"], text: ["description"] }, extra: [] },
      ],
    };
    const modelCalls: Record<string, number> = {};
    const probes: string[] = [];
    const pages = new Map<string, unknown>();
    let n = 0;
    const r = await planWithLlm({ words: ["هات آخر ٢٠ خبر"], request: "", scoutAllowed: false }, {
      model: async ({ tool }) => {
        modelCalls[tool.name] = (modelCalls[tool.name] ?? 0) + 1;
        const next = (answers[tool.name] ?? []).shift();
        return next === undefined ? null : { input: next, costUsd: 0.001 };
      },
      catalog, access: null, today: "2026-11-16", webTools: directWebEndpoints({ contextdev: true, firecrawl: true }),
      probe: async (id) => {
        probes.push(id); n += 1; const call_id = `call_${n}`;
        pages.set(call_id, { rows: Array.from({ length: 5 }, (_, k) => ({ title: `خبر ${k}`, url: `https://news.example/${k}` })) });
        return { ok: true, call_id, http_status: 200, rows_in_page: 5, has_more: false, next_cursor: null, shape: null, first_rows: [], warnings: [], saved: call_id };
      },
      readPage: async (id) => pages.get(id) ?? null,
    });
    expect(r.kind).toBe("plan");
    if (r.kind !== "plan") return;
    expect(probes).toEqual(["octen.web.search.news", "contextdev.search"]);
    expect(modelCalls.field_map).toBe(2);
    const alts = r.plan.stages[0]!.engine!.alternatives ?? [];
    expect(alts.map((a) => a.endpoint_id)).toEqual(["contextdev.search", "firecrawl.search"]);
  });

  it("P-3 Firecrawl as primary mirrors: probes only firecrawl, derives contextdev; and both used -> none derived", async () => {
    const { planWithLlm } = await import("../agent/src/llmPlanner/planner");
    const answers: Record<string, unknown[]> = {
      request_plan: [{
        decision: "plan", understanding_ar: "آخر عشرين خبرًا عن الذكاء الاصطناعي في السعودية.", assumptions_ar: [], accepts_available: false,
        steps: [{ key: "news", title_ar: "الأخبار", platform: "web", capability: "web.search.news", parent: null, deliver: true, count: { total: 20, all: false }, topic: "الذكاء الاصطناعي في السعودية", search_terms: [] }],
      }],
      tool_choice: [{
        options: [{
          endpoint_id: "firecrawl.search",
          params_json: JSON.stringify({ query: "الذكاء الاصطناعي في السعودية" }),
          more_params: [{ query: "سدايا" }],
        }],
      }],
      field_map: [
        { fields: { id: ["url"], title: ["title"], link: ["url"] }, extra: [] },
      ],
    };
    const modelCalls: Record<string, number> = {};
    const probes: string[] = [];
    const pages = new Map<string, unknown>();
    let n = 0;
    const r = await planWithLlm({ words: ["هات آخر ٢٠ خبر"], request: "", scoutAllowed: false }, {
      model: async ({ tool }) => {
        modelCalls[tool.name] = (modelCalls[tool.name] ?? 0) + 1;
        const next = (answers[tool.name] ?? []).shift();
        return next === undefined ? null : { input: next, costUsd: 0.001 };
      },
      catalog, access: null, today: "2026-11-16", webTools: directWebEndpoints({ contextdev: true, firecrawl: true }),
      probe: async (id) => {
        probes.push(id); n += 1; const call_id = `call_${n}`;
        pages.set(call_id, { rows: Array.from({ length: 5 }, (_, k) => ({ title: `خبر ${k}`, url: `https://news.example/${k}` })) });
        return { ok: true, call_id, http_status: 200, rows_in_page: 5, has_more: false, next_cursor: null, shape: null, first_rows: [], warnings: [], saved: call_id };
      },
      readPage: async (id) => pages.get(id) ?? null,
    });
    expect(r.kind).toBe("plan");
    if (r.kind !== "plan") return;
    expect(probes).toEqual(["firecrawl.search"]);
    expect(modelCalls.field_map).toBe(1);
    const alts = r.plan.stages[0]!.engine!.alternatives ?? [];
    expect(alts.map((a) => a.endpoint_id)).toEqual(["firecrawl.search", "contextdev.search", "contextdev.search"]);
    expect(alts.map((a) => (a.params as { query: string }).query)).toEqual(["سدايا", "الذكاء الاصطناعي في السعودية", "سدايا"]);

    // Both web tools used: primary and second -> no derived alternative is added
    const answersBoth: Record<string, unknown[]> = {
      request_plan: [{
        decision: "plan", understanding_ar: "آخر عشرين خبرًا عن الذكاء الاصطناعي في السعودية.", assumptions_ar: [], accepts_available: false,
        steps: [{ key: "news", title_ar: "الأخبار", platform: "web", capability: "web.search.news", parent: null, deliver: true, count: { total: 20, all: false }, topic: "الذكاء الاصطناعي في السعودية", search_terms: [] }],
      }],
      tool_choice: [{
        options: [
          { endpoint_id: "firecrawl.search", params_json: JSON.stringify({ query: "الذكاء الاصطناعي في السعودية" }) },
          { endpoint_id: "contextdev.search", params_json: JSON.stringify({ query: "الذكاء الاصطناعي السعودية" }) },
        ],
      }],
      field_map: [
        { fields: { id: ["url"], title: ["title"], link: ["url"] }, extra: [] },
        { fields: { id: ["url"], title: ["title"], link: ["url"], text: ["description"] }, extra: [] },
      ],
    };
    const probesBoth: string[] = [];
    const rBoth = await planWithLlm({ words: ["هات آخر ٢٠ خبر"], request: "", scoutAllowed: false }, {
      model: async ({ tool }) => {
        const next = (answersBoth[tool.name] ?? []).shift();
        return next === undefined ? null : { input: next, costUsd: 0.001 };
      },
      catalog, access: null, today: "2026-11-16", webTools: directWebEndpoints({ contextdev: true, firecrawl: true }),
      probe: async (id) => {
        probesBoth.push(id); n += 1; const call_id = `call_${n}`;
        pages.set(call_id, { rows: Array.from({ length: 5 }, (_, k) => ({ title: `خبر ${k}`, url: `https://news.example/${k}` })) });
        return { ok: true, call_id, http_status: 200, rows_in_page: 5, has_more: false, next_cursor: null, shape: null, first_rows: [], warnings: [], saved: call_id };
      },
      readPage: async (id) => pages.get(id) ?? null,
    });
    expect(rBoth.kind).toBe("plan");
    if (rBoth.kind !== "plan") return;
    expect(probesBoth).toEqual(["firecrawl.search", "contextdev.search"]);
    const altsBoth = rBoth.plan.stages[0]!.engine!.alternatives ?? [];
    expect(altsBoth.map((a) => a.endpoint_id)).toEqual(["contextdev.search"]);
  });

  it("P-4 case B and scout counts: primary octen returns 5 rows, step count 20, contextdev empty, firecrawl returns 30", async () => {
    const { planWithLlm } = await import("../agent/src/llmPlanner/planner");
    const phrases = ["الذكاء الاصطناعي في السعودية", "سدايا", "تقنية", "رؤية 2030", "حوسبة"];
    const answers: Record<string, unknown[]> = {
      request_plan: [{
        decision: "plan", understanding_ar: "آخر عشرين خبرًا عن الذكاء الاصطناعي في السعودية.", assumptions_ar: [], accepts_available: false,
        steps: [{ key: "news", title_ar: "الأخبار", platform: "web", capability: "web.search.news", parent: null, deliver: true, count: { total: 20, all: false }, topic: phrases[0], search_terms: phrases.slice(1) }],
      }],
      tool_choice: [{
        options: [{ endpoint_id: "octen.web.search.news", params_json: JSON.stringify({ query: phrases[0] }) }],
      }],
      field_map: [
        { fields: { id: ["url"], title: ["title"], link: ["url"] }, extra: [] },
        { fields: { id: ["url"], title: ["title"], link: ["url"], text: ["description"] }, extra: [] },
      ],
    };
    const modelCalls: Record<string, number> = {};
    const probes: string[] = [];
    const probeCalls: Array<{ id: string; params: unknown }> = [];
    const pages = new Map<string, unknown>();
    let n = 0;
    const r = await planWithLlm({ words: ["هات آخر ٢٠ خبر"], request: "", scoutAllowed: true }, {
      model: async ({ tool }) => {
        modelCalls[tool.name] = (modelCalls[tool.name] ?? 0) + 1;
        const next = (answers[tool.name] ?? []).shift();
        return next === undefined ? null : { input: next, costUsd: 0.001 };
      },
      catalog, access: null, today: "2026-11-16", webTools: directWebEndpoints({ contextdev: true, firecrawl: true }),
      probe: async (id, params) => {
        probeCalls.push({ id, params });
        probes.push(id); n += 1; const call_id = `call_${n}`;
        if (id === "octen.web.search.news") {
          pages.set(call_id, { data: { results: Array.from({ length: 5 }, (_, k) => ({ title: `عنوان ${k}`, url: `https://site.example/${k}` })) } });
          return { ok: true, call_id, http_status: 200, rows_in_page: 5, has_more: false, next_cursor: null, shape: null, first_rows: [], warnings: [], saved: call_id };
        }
        if (id === "contextdev.search") {
          pages.set(call_id, { rows: [] });
          return { ok: true, call_id, http_status: 200, rows_in_page: 0, has_more: false, next_cursor: null, shape: null, first_rows: [], warnings: [], saved: call_id };
        }
        // firecrawl.search
        pages.set(call_id, { rows: Array.from({ length: 30 }, (_, k) => ({ title: `خبر ${k}`, url: `https://fc.example/${k}`, description: "وصف" })) });
        return { ok: true, call_id, http_status: 200, rows_in_page: 30, has_more: false, next_cursor: null, shape: null, first_rows: [], warnings: [], saved: call_id };
      },
      readPage: async (id) => pages.get(id) ?? null,
    });
    expect(r.kind).toBe("plan");
    const fcProbes = probeCalls.filter((c) => c.id === "firecrawl.search");
    expect(fcProbes).toHaveLength(1);
    expect((fcProbes[0]!.params as { query: string }).query).toBe(phrases[0]);
    expect(modelCalls.field_map).toBe(2);

    // COUNTERFACTUAL in the same test: firecrawl probe returns 0 rows -> kind: "question" with scout: true
    const answersCounter: Record<string, unknown[]> = {
      request_plan: [{
        decision: "plan", understanding_ar: "آخر عشرين خبرًا عن الذكاء الاصطناعي في السعودية.", assumptions_ar: [], accepts_available: false,
        steps: [{ key: "news", title_ar: "الأخبار", platform: "web", capability: "web.search.news", parent: null, deliver: true, count: { total: 20, all: false }, topic: phrases[0], search_terms: phrases.slice(1) }],
      }],
      tool_choice: [{
        options: [{ endpoint_id: "octen.web.search.news", params_json: JSON.stringify({ query: phrases[0] }) }],
      }],
      field_map: [
        { fields: { id: ["url"], title: ["title"], link: ["url"] }, extra: [] },
      ],
    };
    const rCounter = await planWithLlm({ words: ["هات آخر ٢٠ خبر"], request: "", scoutAllowed: true }, {
      model: async ({ tool }) => {
        const next = (answersCounter[tool.name] ?? []).shift();
        return next === undefined ? null : { input: next, costUsd: 0.001 };
      },
      catalog, access: null, today: "2026-11-16", webTools: directWebEndpoints({ contextdev: true, firecrawl: true }),
      probe: async (id) => {
        n += 1; const call_id = `call_${n}`;
        if (id === "octen.web.search.news") {
          pages.set(call_id, { data: { results: Array.from({ length: 5 }, (_, k) => ({ title: `عنوان ${k}`, url: `https://site.example/${k}` })) } });
          return { ok: true, call_id, http_status: 200, rows_in_page: 5, has_more: false, next_cursor: null, shape: null, first_rows: [], warnings: [], saved: call_id };
        }
        // contextdev and firecrawl return 0 rows
        pages.set(call_id, { rows: [] });
        return { ok: true, call_id, http_status: 200, rows_in_page: 0, has_more: false, next_cursor: null, shape: null, first_rows: [], warnings: [], saved: call_id };
      },
      readPage: async (id) => pages.get(id) ?? null,
    });
    expect(rCounter.kind).toBe("question");
    if (rCounter.kind === "question") {
      expect(rCounter.scout).toBe(true);
      expect(rCounter.question_ar).toContain("٥");
    }
  });

  it("P-5 failure and refusal bounds: firecrawl probe failure/refusal -> 1 probe, no retry, no extra model call, plan ok", async () => {
    const { planWithLlm } = await import("../agent/src/llmPlanner/planner");
    const phrases = ["الذكاء الاصطناعي في السعودية", "سدايا"];
    const baseAnswers: Record<string, unknown[]> = {
      request_plan: [{
        decision: "plan", understanding_ar: "آخر عشرين خبرًا عن الذكاء الاصطناعي في السعودية.", assumptions_ar: [], accepts_available: false,
        steps: [{ key: "news", title_ar: "الأخبار", platform: "web", capability: "web.search.news", parent: null, deliver: true, count: { total: 20, all: false }, topic: phrases[0], search_terms: phrases.slice(1) }],
      }],
      tool_choice: [{
        options: [{ endpoint_id: "octen.web.search.news", params_json: JSON.stringify({ query: phrases[0] }) }],
      }],
      field_map: [
        { fields: { id: ["url"], title: ["title"], link: ["url"] }, extra: [] },
      ],
    };

    // Case 1: firecrawl probe returns ok: false, http_status: 500
    const answers1 = JSON.parse(JSON.stringify(baseAnswers));
    const modelCalls1: Record<string, number> = {};
    const fcProbes1: string[] = [];
    const pages1 = new Map<string, unknown>();
    let n1 = 0;
    const r1 = await planWithLlm({ words: ["هات آخر ٢٠ خبر"], request: "", scoutAllowed: false }, {
      model: async ({ tool }) => {
        modelCalls1[tool.name] = (modelCalls1[tool.name] ?? 0) + 1;
        const next = (answers1[tool.name] ?? []).shift();
        return next === undefined ? null : { input: next, costUsd: 0.001 };
      },
      catalog, access: null, today: "2026-11-16", webTools: directWebEndpoints({ contextdev: true, firecrawl: true }),
      probe: async (id) => {
        n1 += 1; const call_id = `call_${n1}`;
        if (id === "octen.web.search.news") {
          pages1.set(call_id, { data: { results: Array.from({ length: 5 }, (_, k) => ({ title: `عنوان ${k}`, url: `https://site.example/${k}` })) } });
          return { ok: true, call_id, http_status: 200, rows_in_page: 5, has_more: false, next_cursor: null, shape: null, first_rows: [], warnings: [], saved: call_id };
        }
        if (id === "contextdev.search") {
          pages1.set(call_id, { rows: [] });
          return { ok: true, call_id, http_status: 200, rows_in_page: 0, has_more: false, next_cursor: null, shape: null, first_rows: [], warnings: [], saved: call_id };
        }
        fcProbes1.push(id);
        return { ok: false, call_id, http_status: 500, rows_in_page: 0, has_more: false, next_cursor: null, shape: null, first_rows: [], warnings: [], saved: call_id } as any;
      },
      readPage: async (id) => pages1.get(id) ?? null,
    });
    expect(r1.kind).toBe("plan");
    expect(fcProbes1).toEqual(["firecrawl.search"]);
    expect(modelCalls1.field_map).toBe(1);
    if (r1.kind === "plan") {
      const alts1 = r1.plan.stages[0]!.engine!.alternatives ?? [];
      expect(alts1.some((a) => a.endpoint_id === "firecrawl.search")).toBe(false);
    }

    // Case 2: firecrawl probe returns refused
    const answers2 = JSON.parse(JSON.stringify(baseAnswers));
    const modelCalls2: Record<string, number> = {};
    const fcProbes2: string[] = [];
    const pages2 = new Map<string, unknown>();
    let n2 = 0;
    const r2 = await planWithLlm({ words: ["هات آخر ٢٠ خبر"], request: "", scoutAllowed: false }, {
      model: async ({ tool }) => {
        modelCalls2[tool.name] = (modelCalls2[tool.name] ?? 0) + 1;
        const next = (answers2[tool.name] ?? []).shift();
        return next === undefined ? null : { input: next, costUsd: 0.001 };
      },
      catalog, access: null, today: "2026-11-16", webTools: directWebEndpoints({ contextdev: true, firecrawl: true }),
      probe: async (id) => {
        n2 += 1; const call_id = `call_${n2}`;
        if (id === "octen.web.search.news") {
          pages2.set(call_id, { data: { results: Array.from({ length: 5 }, (_, k) => ({ title: `عنوان ${k}`, url: `https://site.example/${k}` })) } });
          return { ok: true, call_id, http_status: 200, rows_in_page: 5, has_more: false, next_cursor: null, shape: null, first_rows: [], warnings: [], saved: call_id };
        }
        if (id === "contextdev.search") {
          pages2.set(call_id, { rows: [] });
          return { ok: true, call_id, http_status: 200, rows_in_page: 0, has_more: false, next_cursor: null, shape: null, first_rows: [], warnings: [], saved: call_id };
        }
        fcProbes2.push(id);
        return { ok: false, refused: "rate_limit", call_id, rows_in_page: 0, has_more: false, next_cursor: null, shape: null, first_rows: [], warnings: [], saved: call_id } as any;
      },
      readPage: async (id) => pages2.get(id) ?? null,
    });
    expect(r2.kind).toBe("plan");
    expect(fcProbes2).toEqual(["firecrawl.search"]);
    expect(modelCalls2.field_map).toBe(1);
    if (r2.kind === "plan") {
      const alts2 = r2.plan.stages[0]!.engine!.alternatives ?? [];
      expect(alts2.some((a) => a.endpoint_id === "firecrawl.search")).toBe(false);
    }
  });

  it("P-6 several steps: two news steps both contextdev-empty -> fc probes 2, extra model 2; both proven -> fc probes 0", async () => {
    const { planWithLlm } = await import("../agent/src/llmPlanner/planner");
    const twoSteps = [
      { key: "news1", title_ar: "الأخبار الأولى", platform: "web", capability: "web.search.news", parent: null, deliver: true, count: { total: 20, all: false }, topic: "الذكاء الاصطناعي", search_terms: ["تقنية"] },
      { key: "news2", title_ar: "الأخبار الثانية", platform: "web", capability: "web.search.news", parent: null, deliver: true, count: { total: 20, all: false }, topic: "رؤية 2030", search_terms: ["مشاريع"] },
    ];
    const twoToolChoices = [
      { options: [{ endpoint_id: "octen.web.search.news", params_json: JSON.stringify({ query: "الذكاء الاصطناعي" }) }] },
      { options: [{ endpoint_id: "octen.web.search.news", params_json: JSON.stringify({ query: "رؤية 2030" }) }] },
    ];

    // Case 1: both contextdev-empty -> firecrawl probes === 2, extra model calls === 2
    const modelCalls1: Record<string, number> = {};
    const fcProbes1: string[] = [];
    const pages1 = new Map<string, unknown>();
    let n1 = 0;
    const answers1: Record<string, unknown[]> = {
      request_plan: [{
        decision: "plan", understanding_ar: "أخبار.", assumptions_ar: [], accepts_available: false,
        steps: twoSteps,
      }],
      tool_choice: [...twoToolChoices],
      field_map: [
        { fields: { id: ["url"], title: ["title"], link: ["url"] }, extra: [] }, // step 1 octen
        { fields: { id: ["url"], title: ["title"], link: ["url"] }, extra: [] }, // step 1 firecrawl
        { fields: { id: ["url"], title: ["title"], link: ["url"] }, extra: [] }, // step 2 octen
        { fields: { id: ["url"], title: ["title"], link: ["url"] }, extra: [] }, // step 2 firecrawl
      ],
    };
    const r1 = await planWithLlm({ words: ["هات أخبار"], request: "", scoutAllowed: false }, {
      model: async ({ tool }) => {
        modelCalls1[tool.name] = (modelCalls1[tool.name] ?? 0) + 1;
        const next = (answers1[tool.name] ?? []).shift();
        return next === undefined ? null : { input: next, costUsd: 0.001 };
      },
      catalog, access: null, today: "2026-11-16", webTools: directWebEndpoints({ contextdev: true, firecrawl: true }),
      probe: async (id) => {
        n1 += 1; const call_id = `call_${n1}`;
        if (id === "octen.web.search.news") {
          pages1.set(call_id, { data: { results: Array.from({ length: 5 }, (_, k) => ({ title: `عنوان ${k}`, url: `https://site.example/${k}` })) } });
          return { ok: true, call_id, http_status: 200, rows_in_page: 5, has_more: false, next_cursor: null, shape: null, first_rows: [], warnings: [], saved: call_id };
        }
        if (id === "contextdev.search") {
          pages1.set(call_id, { rows: [] });
          return { ok: true, call_id, http_status: 200, rows_in_page: 0, has_more: false, next_cursor: null, shape: null, first_rows: [], warnings: [], saved: call_id };
        }
        fcProbes1.push(id);
        pages1.set(call_id, { rows: Array.from({ length: 30 }, (_, k) => ({ title: `خبر ${k}`, url: `https://fc.example/${k}`, description: "وصف" })) });
        return { ok: true, call_id, http_status: 200, rows_in_page: 30, has_more: false, next_cursor: null, shape: null, first_rows: [], warnings: [], saved: call_id };
      },
      readPage: async (id) => pages1.get(id) ?? null,
    });
    expect(r1.kind).toBe("plan");
    expect(fcProbes1).toHaveLength(2);
    expect(modelCalls1.field_map).toBe(4); // 2 primary + 2 extra firecrawl

    // Case 2: both contextdev-proven -> 0 firecrawl probes, 0 extra model calls
    const modelCalls2: Record<string, number> = {};
    const fcProbes2: string[] = [];
    const pages2 = new Map<string, unknown>();
    let n2 = 0;
    const answers2: Record<string, unknown[]> = {
      request_plan: [{
        decision: "plan", understanding_ar: "أخبار.", assumptions_ar: [], accepts_available: false,
        steps: twoSteps,
      }],
      tool_choice: [...twoToolChoices],
      field_map: [
        { fields: { id: ["url"], title: ["title"], link: ["url"] }, extra: [] }, // step 1 octen
        { fields: { id: ["url"], title: ["title"], link: ["url"] }, extra: [] }, // step 1 contextdev
        { fields: { id: ["url"], title: ["title"], link: ["url"] }, extra: [] }, // step 2 octen
        { fields: { id: ["url"], title: ["title"], link: ["url"] }, extra: [] }, // step 2 contextdev
      ],
    };
    const r2 = await planWithLlm({ words: ["هات أخبار"], request: "", scoutAllowed: false }, {
      model: async ({ tool }) => {
        modelCalls2[tool.name] = (modelCalls2[tool.name] ?? 0) + 1;
        const next = (answers2[tool.name] ?? []).shift();
        return next === undefined ? null : { input: next, costUsd: 0.001 };
      },
      catalog, access: null, today: "2026-11-16", webTools: directWebEndpoints({ contextdev: true, firecrawl: true }),
      probe: async (id) => {
        n2 += 1; const call_id = `call_${n2}`;
        if (id === "octen.web.search.news") {
          pages2.set(call_id, { data: { results: Array.from({ length: 5 }, (_, k) => ({ title: `عنوان ${k}`, url: `https://site.example/${k}` })) } });
          return { ok: true, call_id, http_status: 200, rows_in_page: 5, has_more: false, next_cursor: null, shape: null, first_rows: [], warnings: [], saved: call_id };
        }
        if (id === "contextdev.search") {
          pages2.set(call_id, { rows: Array.from({ length: 30 }, (_, k) => ({ title: `خبر ${k}`, url: `https://context.example/${k}`, description: "وصف" })) });
          return { ok: true, call_id, http_status: 200, rows_in_page: 30, has_more: false, next_cursor: null, shape: null, first_rows: [], warnings: [], saved: call_id };
        }
        fcProbes2.push(id);
        return { ok: true, call_id, http_status: 200, rows_in_page: 30, has_more: false, next_cursor: null, shape: null, first_rows: [], warnings: [], saved: call_id };
      },
      readPage: async (id) => pages2.get(id) ?? null,
    });
    expect(r2.kind).toBe("plan");
    expect(fcProbes2).toHaveLength(0);
    expect(modelCalls2.field_map).toBe(4); // 2 primary + 2 contextdev, 0 firecrawl
  });

  it("P-7 one web tool and empty phrases: single web tool -> identical to today; empty phrases -> no web block, no throw", async () => {
    const { planWithLlm } = await import("../agent/src/llmPlanner/planner");

    // Case 1: only one web tool configured (contextdev only)
    const answers1: Record<string, unknown[]> = {
      request_plan: [{
        decision: "plan", understanding_ar: "أخبار.", assumptions_ar: [], accepts_available: false,
        steps: [{ key: "news", title_ar: "الأخبار", platform: "web", capability: "web.search.news", parent: null, deliver: true, count: { total: 20, all: false }, topic: "الذكاء الاصطناعي", search_terms: [] }],
      }],
      tool_choice: [{
        options: [{ endpoint_id: "octen.web.search.news", params_json: JSON.stringify({ query: "الذكاء الاصطناعي" }) }],
      }],
      field_map: [
        { fields: { id: ["url"], title: ["title"], link: ["url"] }, extra: [] }, // octen
        { fields: { id: ["url"], title: ["title"], link: ["url"] }, extra: [] }, // contextdev
      ],
    };
    const probes1: string[] = [];
    const pages1 = new Map<string, unknown>();
    let n1 = 0;
    const r1 = await planWithLlm({ words: ["هات أخبار"], request: "", scoutAllowed: false }, {
      model: async ({ tool }) => {
        const next = (answers1[tool.name] ?? []).shift();
        return next === undefined ? null : { input: next, costUsd: 0.001 };
      },
      catalog, access: null, today: "2026-11-16", webTools: directWebEndpoints({ contextdev: true, firecrawl: false }),
      probe: async (id) => {
        probes1.push(id); n1 += 1; const call_id = `call_${n1}`;
        if (id === "octen.web.search.news") {
          pages1.set(call_id, { data: { results: Array.from({ length: 5 }, (_, k) => ({ title: `عنوان ${k}`, url: `https://site.example/${k}` })) } });
          return { ok: true, call_id, http_status: 200, rows_in_page: 5, has_more: false, next_cursor: null, shape: null, first_rows: [], warnings: [], saved: call_id };
        }
        pages1.set(call_id, { rows: Array.from({ length: 30 }, (_, k) => ({ title: `خبر ${k}`, url: `https://context.example/${k}` })) });
        return { ok: true, call_id, http_status: 200, rows_in_page: 30, has_more: false, next_cursor: null, shape: null, first_rows: [], warnings: [], saved: call_id };
      },
      readPage: async (id) => pages1.get(id) ?? null,
    });
    expect(r1.kind).toBe("plan");
    expect(probes1).toEqual(["octen.web.search.news", "contextdev.search"]);
    if (r1.kind === "plan") {
      const alts1 = r1.plan.stages[0]!.engine!.alternatives ?? [];
      expect(alts1.map((a) => a.endpoint_id)).toEqual(["contextdev.search"]);
    }

    // Case 2: empty phrases (< 2 chars) -> no web block, no extra call, no throw
    const answers2: Record<string, unknown[]> = {
      request_plan: [{
        decision: "plan", understanding_ar: "أخبار.", assumptions_ar: [], accepts_available: false,
        steps: [{ key: "news", title_ar: "الأخبار", platform: "web", capability: "web.search.news", parent: null, deliver: true, count: { total: 20, all: false }, topic: "x", search_terms: ["y", ""] }],
      }],
      tool_choice: [{
        options: [{ endpoint_id: "octen.web.search.news", params_json: JSON.stringify({ query: "x" }) }],
      }],
      field_map: [
        { fields: { id: ["url"], title: ["title"], link: ["url"] }, extra: [] },
      ],
    };
    const probes2: string[] = [];
    const pages2 = new Map<string, unknown>();
    let n2 = 0;
    const r2 = await planWithLlm({ words: ["هات أخبار"], request: "", scoutAllowed: false }, {
      model: async ({ tool }) => {
        const next = (answers2[tool.name] ?? []).shift();
        return next === undefined ? null : { input: next, costUsd: 0.001 };
      },
      catalog, access: null, today: "2026-11-16", webTools: directWebEndpoints({ contextdev: true, firecrawl: true }),
      probe: async (id) => {
        probes2.push(id); n2 += 1; const call_id = `call_${n2}`;
        pages2.set(call_id, { data: { results: Array.from({ length: 5 }, (_, k) => ({ title: `عنوان ${k}`, url: `https://site.example/${k}` })) } });
        return { ok: true, call_id, http_status: 200, rows_in_page: 5, has_more: false, next_cursor: null, shape: null, first_rows: [], warnings: [], saved: call_id };
      },
      readPage: async (id) => pages2.get(id) ?? null,
    });
    expect(r2.kind).toBe("plan");
    expect(probes2).toEqual(["octen.web.search.news"]);
    if (r2.kind === "plan") {
      const alts2 = r2.plan.stages[0]!.engine!.alternatives ?? [];
      expect(alts2).toEqual([]);
    }
  });

  it("P-8 no singular webFallback remains in planner.ts", () => {
    const src = readFileSync("agent/src/llmPlanner/planner.ts", "utf8");
    expect(/\bwebFallback\b(?!s)/.test(src)).toBe(false);
  });

  it("P-9 non-news web step, no change: web.extract and not-short sample -> no derived web alternative", async () => {
    const { planWithLlm } = await import("../agent/src/llmPlanner/planner");

    // Case 1: capability is "web.page.read" (not search/news) -> searchOrNews is false
    const answers1: Record<string, unknown[]> = {
      request_plan: [{
        decision: "plan", understanding_ar: "قراءة صفحة.", assumptions_ar: [], accepts_available: false,
        steps: [{ key: "read_step", title_ar: "قراءة", platform: "web", capability: "web.extract", parent: null, deliver: true, count: { total: 20, all: false }, topic: "صفحة الذكاء", search_terms: [] }],
      }],
      tool_choice: [{
        options: [{
          endpoint_id: "linkup.web.fetch",
          params_json: JSON.stringify({ url: "https://site.example/page" }),
        }],
      }],
      field_map: [
        { fields: { id: ["url"], title: ["title"], link: ["url"] }, extra: [] },
      ],
    };
    const probes1: string[] = [];
    const pages1 = new Map<string, unknown>();
    let n1 = 0;
    const r1 = await planWithLlm({ words: ["اقرأ"], request: "", scoutAllowed: false }, {
      model: async ({ tool }) => {
        const next = (answers1[tool.name] ?? []).shift();
        return next === undefined ? null : { input: next, costUsd: 0.001 };
      },
      catalog, access: null, today: "2026-11-16", webTools: directWebEndpoints({ contextdev: true, firecrawl: true }),
      probe: async (id) => {
        probes1.push(id); n1 += 1; const call_id = `call_${n1}`;
        pages1.set(call_id, { rows: Array.from({ length: 5 }, (_, k) => ({ title: `صفحة ${k}`, url: `https://site.example/${k}` })) });
        return { ok: true, call_id, http_status: 200, rows_in_page: 5, has_more: false, next_cursor: null, shape: null, first_rows: [], warnings: [], saved: call_id };
      },
      readPage: async (id) => pages1.get(id) ?? null,
    });
    expect(r1.kind).toBe("plan");
    expect(probes1).not.toContain("firecrawl.search");
    if (r1.kind === "plan") {
      const alts1 = r1.plan.stages[0]!.engine!.alternatives ?? [];
      // A non-search capability never gets the DERIVED (R3-A) web alternative: no firecrawl alternative
      expect(alts1.some((a) => a.endpoint_id === "firecrawl.search")).toBe(false);
    }

    // Case 2: eligible step whose sample is NOT short (30 rows vs count 20) -> webEligible is false
    const answers2: Record<string, unknown[]> = {
      request_plan: [{
        decision: "plan", understanding_ar: "أخبار.", assumptions_ar: [], accepts_available: false,
        steps: [{ key: "news", title_ar: "الأخبار", platform: "web", capability: "web.search.news", parent: null, deliver: true, count: { total: 20, all: false }, topic: "الذكاء الاصطناعي", search_terms: ["سدايا"] }],
      }],
      tool_choice: [{
        options: [{
          endpoint_id: "contextdev.search",
          params_json: JSON.stringify({ query: "الذكاء الاصطناعي" }),
          more_params: [{ query: "سدايا" }],
        }],
      }],
      field_map: [
        { fields: { id: ["url"], title: ["title"], link: ["url"] }, extra: [] },
      ],
    };
    const probes2: string[] = [];
    const pages2 = new Map<string, unknown>();
    let n2 = 0;
    const r2 = await planWithLlm({ words: ["هات أخبار"], request: "", scoutAllowed: false }, {
      model: async ({ tool }) => {
        const next = (answers2[tool.name] ?? []).shift();
        return next === undefined ? null : { input: next, costUsd: 0.001 };
      },
      catalog, access: null, today: "2026-11-16", webTools: directWebEndpoints({ contextdev: true, firecrawl: true }),
      probe: async (id) => {
        probes2.push(id); n2 += 1; const call_id = `call_${n2}`;
        // 30 rows returned: 30 >= 20 -> sample is not short!
        pages2.set(call_id, { rows: Array.from({ length: 30 }, (_, k) => ({ title: `خبر ${k}`, url: `https://site.example/${k}` })) });
        return { ok: true, call_id, http_status: 200, rows_in_page: 30, has_more: false, next_cursor: null, shape: null, first_rows: [], warnings: [], saved: call_id };
      },
      readPage: async (id) => pages2.get(id) ?? null,
    });
    expect(r2.kind).toBe("plan");
    expect(probes2).toEqual(["contextdev.search"]);
    if (r2.kind === "plan") {
      const alts2 = r2.plan.stages[0]!.engine!.alternatives ?? [];
      // Only primary's own more sets: no firecrawl alternative
      expect(alts2.map((a) => a.endpoint_id)).toEqual(["contextdev.search"]);
      expect((alts2[0]!.params as { query: string }).query).toBe("سدايا");
    }
  });

  it("P-10 distinct existing alternative mappings preserved: primary more and second keep cursor_param and map_code, derived last", async () => {
    const { planWithLlm, assemblePlan } = await import("../agent/src/llmPlanner/planner");
    const answers: Record<string, unknown[]> = {
      request_plan: [{
        decision: "plan", understanding_ar: "أخبار.", assumptions_ar: [], accepts_available: false,
        steps: [{ key: "news", title_ar: "الأخبار", platform: "web", capability: "web.search.news", parent: null, deliver: true, count: { total: 20, all: false }, topic: "الذكاء الاصطناعي في السعودية", search_terms: ["سدايا"] }],
      }],
      tool_choice: [{
        options: [
          { endpoint_id: "octen.web.search.news", cursor_input: "count", params_json: JSON.stringify({ query: "الذكاء الاصطناعي في السعودية" }), more_params: [{ query: "سدايا" }] },
          { endpoint_id: "tinyfish.web.search.news", cursor_input: "page", params_json: JSON.stringify({ query: "سدايا التقنية", domain_type: "news" }) },
        ],
      }],
      field_map: [
        { fields: { id: ["url"], title: ["title"], link: ["url"] }, extra: [] }, // octen
        { fields: { id: ["url"], title: ["title"], link: ["url"] }, extra: [] }, // tinyfish
        { fields: { id: ["url"], title: ["title"], link: ["url"] }, extra: [] }, // contextdev
      ],
    };
    const probes: string[] = [];
    const pages = new Map<string, unknown>();
    let n = 0;
    const r = await planWithLlm({ words: ["هات أخبار"], request: "", scoutAllowed: false }, {
      model: async ({ tool }) => {
        const next = (answers[tool.name] ?? []).shift();
        return next === undefined ? null : { input: next, costUsd: 0.001 };
      },
      catalog, access: null, today: "2026-11-16", webTools: directWebEndpoints({ contextdev: true, firecrawl: true }),
      probe: async (id) => {
        probes.push(id); n += 1; const call_id = `call_${n}`;
        if (id === "octen.web.search.news" || id === "tinyfish.web.search.news") {
          pages.set(call_id, { data: { results: Array.from({ length: 5 }, (_, k) => ({ title: `عنوان ${k}`, url: `https://site.example/${k}` })) } });
          return { ok: true, call_id, http_status: 200, rows_in_page: 5, has_more: false, next_cursor: null, shape: null, first_rows: [], warnings: [], saved: call_id };
        }
        pages.set(call_id, { rows: Array.from({ length: 30 }, (_, k) => ({ title: `خبر ${k}`, url: `https://context.example/${k}` })) });
        return { ok: true, call_id, http_status: 200, rows_in_page: 30, has_more: false, next_cursor: null, shape: null, first_rows: [], warnings: [], saved: call_id };
      },
      readPage: async (id) => pages.get(id) ?? null,
    });
    expect(r.kind).toBe("plan");
    if (r.kind !== "plan") return;
    const alts = r.plan.stages[0]!.engine!.alternatives ?? [];
    expect(alts.length).toBeGreaterThanOrEqual(3);

    // First alternative is primary's more: cursor_param is count
    expect(alts[0]).toMatchObject({
      endpoint_id: "octen.web.search.news",
      params: { query: "سدايا" },
      cursor_param: "count",
      map_file_id: "page",
    });
    expect(typeof alts[0]!.map_code).toBe("string");

    // Second alternative is second option: cursor_param is page
    expect(alts[1]).toMatchObject({
      endpoint_id: "tinyfish.web.search.news",
      params: { query: "سدايا التقنية" },
      cursor_param: "page",
      map_file_id: "page",
    });
    expect(typeof alts[1]!.map_code).toBe("string");

    // Derived entries come last
    const derived = alts.slice(2);
    expect(derived.length).toBeGreaterThan(0);
    expect(derived.every((a) => a.endpoint_id === "contextdev.search" || a.endpoint_id === "firecrawl.search")).toBe(true);

    // Two existing alternatives with equal endpoint_id and params but different cursor_param/map_code: BOTH kept
    const uFake: any = { understanding_ar: "فهم", assumptions_ar: [], steps: [] };
    const builtStepFake: any = {
      step: { key: "step1", title_ar: "خطوة", platform: "web", capability: "web.search.news", parent: null, deliver: true, count: { total: 20, all: false } },
      option: {
        endpoint: { id: "octen.web.search.news", platform: "web", cost: { usd: 0.01 } },
        params: { query: "أ" },
        cursor: "cursor_a",
        more: [{ query: "ب" }],
        notCarried: [],
      },
      mapCode: "code_a",
      second: {
        option: {
          endpoint: { id: "octen.web.search.news", platform: "web", cost: { usd: 0.01 } },
          params: { query: "ب" },
          cursor: "cursor_b",
          more: [],
          notCarried: [],
        },
        mapCode: "code_b",
      },
      sampleRows: [{ url: "https://a.com" }],
      callIds: ["c1"],
      rowsPerPage: 10,
      columns: [{ key: "url", title_ar: "رابط" }],
      carryKeys: [],
    };
    const planPriced = assemblePlan(uFake, [builtStepFake], []);
    const stageAlts = planPriced.stages[0]!.engine!.alternatives ?? [];
    // Both entries with params { query: "ب" } are kept because one has cursor_a/code_a and the other has cursor_b/code_b
    expect(stageAlts).toHaveLength(2);
    expect(stageAlts[0]).toMatchObject({ endpoint_id: "octen.web.search.news", params: { query: "ب" }, cursor_param: "cursor_a", map_code: "code_a" });
    expect(stageAlts[1]).toMatchObject({ endpoint_id: "octen.web.search.news", params: { query: "ب" }, cursor_param: "cursor_b", map_code: "code_b" });
  });

  it("P-11 de-duplication only among the new alternatives: proven option more with duplicate sets -> firecrawl carries each once", async () => {
    const { planWithLlm } = await import("../agent/src/llmPlanner/planner");
    const answers: Record<string, unknown[]> = {
      request_plan: [{
        decision: "plan", understanding_ar: "أخبار.", assumptions_ar: [], accepts_available: false,
        steps: [{ key: "news", title_ar: "الأخبار", platform: "web", capability: "web.search.news", parent: null, deliver: true, count: { total: 20, all: false }, topic: "الذكاء الاصطناعي", search_terms: [] }],
      }],
      tool_choice: [{
        options: [{
          endpoint_id: "contextdev.search",
          params_json: JSON.stringify({ query: "الذكاء الاصطناعي" }),
          more_params: [{ query: "سدايا" }, { query: "سدايا" }],
        }],
      }],
      field_map: [
        { fields: { id: ["url"], title: ["title"], link: ["url"] }, extra: [] },
      ],
    };
    const pages = new Map<string, unknown>();
    let n = 0;
    const r = await planWithLlm({ words: ["هات أخبار"], request: "", scoutAllowed: false }, {
      model: async ({ tool }) => {
        const next = (answers[tool.name] ?? []).shift();
        return next === undefined ? null : { input: next, costUsd: 0.001 };
      },
      catalog, access: null, today: "2026-11-16", webTools: directWebEndpoints({ contextdev: true, firecrawl: true }),
      probe: async (id) => {
        n += 1; const call_id = `call_${n}`;
        pages.set(call_id, { rows: Array.from({ length: 5 }, (_, k) => ({ title: `خبر ${k}`, url: `https://site.example/${k}` })) });
        return { ok: true, call_id, http_status: 200, rows_in_page: 5, has_more: false, next_cursor: null, shape: null, first_rows: [], warnings: [], saved: call_id };
      },
      readPage: async (id) => pages.get(id) ?? null,
    });
    expect(r.kind).toBe("plan");
    if (r.kind !== "plan") return;
    const alts = r.plan.stages[0]!.engine!.alternatives ?? [];
    const fcAlts = alts.filter((a) => a.endpoint_id === "firecrawl.search");
    // Firecrawl derived options carry each distinct param set once: ["الذكاء الاصطناعي", "سدايا"]
    expect(fcAlts).toHaveLength(2);
    expect(fcAlts.map((a) => (a.params as { query: string }).query)).toEqual(["الذكاء الاصطناعي", "سدايا"]);
  });
});
