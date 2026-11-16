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
