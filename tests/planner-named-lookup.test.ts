import { describe, expect, it } from "vitest";
import { bindLookups, isLookupStep, pickNamedItem } from "../agent/src/llmPlanner/planner";

/**
 * LIVE, 16 Nov 2026 (msn_4aed6b99…): «عايز ١٠٠ تقييم لتطبيق InstaPay على جوجل بلاي». The planner found the app with a search step and the reviews read its first result: Google Play answered Fawry first, and 100 reviews of
 * com.fawry.myfawry were delivered as InstaPay's. The result that IS the named thing is now picked by the model, and the reviews are bound to it directly (execution never searches again and takes the first result).
 */
const step = (over: Record<string, unknown>) => ({ key: "k", title_ar: "x", platform: "google-play", capability: "google-play.search.apps", parent: null, deliver: true, count: { total: null, per_parent: null, all: false }, search_terms: [], ...over }) as never;
const FIND = step({ key: "find_app", deliver: false, count: { total: 1, per_parent: null, all: false }, topic: "InstaPay" });
const REVIEWS = step({ key: "reviews", capability: "google-play.reviews", parent: "find_app", count: { total: 100, per_parent: null, all: false } });
const ROWS = [{ id: "com.fawry.myfawry", text: "All of your bills and payments made easy" }, { id: "com.egyptianbanks.instapay", text: "InstaPay Egypt" }];

describe("the lookup step", () => {
  it("is a hidden one-item step with a name that a later step reads", () => {
    expect(isLookupStep(FIND, [FIND, REVIEWS])).toBe(true);
    expect(isLookupStep(FIND, [FIND])).toBe(false);
    expect(isLookupStep(REVIEWS, [FIND, REVIEWS])).toBe(false);
  });
  it("takes the result the model names, never blindly the first; none or a bad answer is -1", async () => {
    expect(await pickNamedItem(FIND, ROWS, async () => ({ index: 1 }))).toBe(1);
    expect(await pickNamedItem(FIND, ROWS, async () => ({ index: -1 }))).toBe(-1);
    expect(await pickNamedItem(FIND, ROWS, async () => ({ index: 7 }))).toBe(-1);
    expect(await pickNamedItem(FIND, ROWS, async () => null)).toBe(-1);
    expect(await pickNamedItem(FIND, [], async () => ({ index: 0 }))).toBe(-1);
  });
  it("binds the child to the picked thing's value and drops the lookup stage", () => {
    const option = (parent: { param: string; from: string } | null, params: Record<string, unknown> = {}) => ({ endpoint: { id: "e" } as never, params, cursor: null, parent, more: [{ sort: 1 }], notCarried: [] });
    const built = [
      { step: FIND, option: option(null), mapCode: "", columns: [], carryKeys: [], sampleRows: [ROWS[1]], rowsPerPage: 2, callIds: [], hasMore: false, lookup: true as const },
      { step: REVIEWS, option: option({ param: "product_id", from: "id" }, { num: 100 }), mapCode: "", columns: [], carryKeys: [], sampleRows: [], rowsPerPage: 100, callIds: [], hasMore: true },
    ];
    const out = bindLookups(built as never);
    expect(out).toHaveLength(1);
    expect(out[0]!.step.parent).toBeNull();
    expect(out[0]!.option.parent).toBeNull();
    expect(out[0]!.option.params).toEqual({ num: 100, product_id: "com.egyptianbanks.instapay" });
    expect(out[0]!.option.more).toEqual([{ sort: 1, product_id: "com.egyptianbanks.instapay" }]);
  });
});

describe("the items of one found thing are measured before the plan", () => {
  it("10 reviews and no next page for a request of 20: the customer is asked before any plan (live: planned silently as 20, 10 delivered)", async () => {
    const { planWithLlm } = await import("../agent/src/llmPlanner/planner");
    const { loadTregCatalog } = await import("../src/lib/treg/catalog");
    const answers: Record<string, unknown[]> = {
      request_plan: [{ decision: "plan", understanding_ar: "عشرون تقييمًا لسماعة سوني من أمازون.", assumptions_ar: [], accepts_available: false, steps: [
        { key: "find_product", title_ar: "المنتجات", platform: "amazon", capability: "amazon.search.products", parent: null, deliver: false, count: { total: 1, all: false }, topic: "Sony WH-1000XM5", search_terms: ["Sony WH-1000XM5"] },
        { key: "reviews", title_ar: "التقييمات", platform: "amazon", capability: "amazon.product.reviews", parent: "find_product", deliver: true, count: { total: 20, all: false }, search_terms: [] },
      ] }],
      tool_choice: [
        { options: [{ endpoint_id: "treg.amazon.search.products", params_json: JSON.stringify({ q: "Sony WH-1000XM5" }) }] },
        { options: [{ endpoint_id: "justoneapi.x.amazon-get-product-top-reviews-v1", params_json: "{}", parent_input: { param: "asin", from_field: "id" } }] },
      ],
      field_map: [{ fields: { id: ["asin"], text: ["title"] }, extra: [] }, { fields: { id: ["rid"], text: ["body"] }, extra: [] }],
      pick_item: [{ index: 0 }],
    };
    let n = 0;
    const pages = new Map<string, unknown>();
    const r = await planWithLlm({ words: ["عايز ٢٠ ريفيو لسماعة Sony WH-1000XM5 من أمازون"], request: "" }, {
      model: async ({ tool }) => { const next = (answers[tool.name] ?? []).shift(); return next === undefined ? null : { input: next, costUsd: 0.001 }; },
      catalog: loadTregCatalog(), access: null, today: "2026-11-16",
      probe: async (id) => {
        n += 1; const call_id = `call_${n}`;
        const reviews = id.includes("reviews");
        pages.set(call_id, reviews ? { data: { reviews: Array.from({ length: 10 }, (_, k) => ({ rid: `R${k}`, body: `review ${k}` })) } } : { data: { products: [{ asin: "B09XS7JWHH", title: "Sony WH-1000XM5" }, { asin: "B0OTHER", title: "Other" }] } });
        return { ok: true, call_id, http_status: 200, rows_in_page: reviews ? 10 : 2, has_more: false, next_cursor: null, shape: null, first_rows: [], warnings: [], saved: call_id };
      },
      readPage: async (id) => pages.get(id) ?? null,
    });
    expect(r.kind).toBe("question");
    if (r.kind !== "question") return;
    expect(r.scout).toBe(true);
    expect(r.question_ar).toMatch(/١٠/);
  });
});

describe("after the customer accepts what exists", () => {
  it("the plan targets the 10 that exist and says so (live: after «سلّمني الموجود» it still read «هتستلم ٢٠»)", async () => {
    const { planWithLlm } = await import("../agent/src/llmPlanner/planner");
    const { loadTregCatalog } = await import("../src/lib/treg/catalog");
    const answers: Record<string, unknown[]> = {
      request_plan: [{ decision: "plan", understanding_ar: "عشرون تقييمًا لسماعة سوني من أمازون.", assumptions_ar: [], accepts_available: true, steps: [
        { key: "find_product", title_ar: "المنتجات", platform: "amazon", capability: "amazon.search.products", parent: null, deliver: false, count: { total: 1, all: false }, topic: "Sony WH-1000XM5", search_terms: ["Sony WH-1000XM5"] },
        { key: "reviews", title_ar: "التقييمات", platform: "amazon", capability: "amazon.product.reviews", parent: "find_product", deliver: true, count: { total: 20, all: false }, search_terms: [] },
      ] }],
      tool_choice: [
        { options: [{ endpoint_id: "treg.amazon.search.products", params_json: JSON.stringify({ q: "Sony WH-1000XM5" }) }] },
        { options: [{ endpoint_id: "justoneapi.x.amazon-get-product-top-reviews-v1", params_json: "{}", parent_input: { param: "asin", from_field: "id" } }] },
      ],
      field_map: [{ fields: { id: ["asin"], text: ["title"] }, extra: [] }, { fields: { id: ["rid"], text: ["body"] }, extra: [] }],
      pick_item: [{ index: 0 }],
    };
    let n = 0;
    const pages = new Map<string, unknown>();
    const r = await planWithLlm({ words: ["عايز ٢٠ ريفيو لسماعة Sony WH-1000XM5 من أمازون", "سلّمني الموجود"], request: "" }, {
      model: async ({ tool }) => { const next = (answers[tool.name] ?? []).shift(); return next === undefined ? null : { input: next, costUsd: 0.001 }; },
      catalog: loadTregCatalog(), access: null, today: "2026-11-16",
      probe: async (id) => {
        n += 1; const call_id = `call_${n}`;
        const reviews = id.includes("reviews");
        pages.set(call_id, reviews ? { data: { reviews: Array.from({ length: 10 }, (_, k) => ({ rid: `R${k}`, body: `review ${k}` })) } } : { data: { products: [{ asin: "B09XS7JWHH", title: "Sony WH-1000XM5" }, { asin: "B0OTHER", title: "Other" }] } });
        return { ok: true, call_id, http_status: 200, rows_in_page: reviews ? 10 : 2, has_more: false, next_cursor: null, shape: null, first_rows: [], warnings: [], saved: call_id };
      },
      readPage: async (id) => pages.get(id) ?? null,
    });
    expect(r.kind).toBe("plan");
    if (r.kind !== "plan") return;
    expect(r.plan.stages.map((st) => [st.key, st.planned_rows])).toEqual([["reviews", 10]]);
    expect(r.plan.price.deliveredRows).toBe(10);
    expect(JSON.stringify(r.plan)).toContain("ووافقت على تسليم الموجود");
  });
});
