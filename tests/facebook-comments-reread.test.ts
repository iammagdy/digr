import { describe, expect, it } from "vitest";
import { createMemoryStore } from "../agent/src/memoryStore";
import { ItemStore } from "../agent/src/items/itemStore";
import { runEngine } from "../agent/src/engine/run";
import { RAW_PATH, type Gateway } from "../agent/src/gateway";
import { priceMissionByCode } from "../src/lib/agentMission/price";
import { stagePriceInputs, type PricedPlan } from "../src/lib/agentMission/plan";

/**
 * COMPLETE COUNT, item 3 (S1 live findings, R1): the first read of a Facebook post's comments answered 200 with 0 rows, the engine then re-read the POST LINK AS A BARE DOMAIN («facebook.com», meant for a company website), which the source refused (HTTP 500, twice), and the
 * post's comments were never delivered. Now: a post link is never turned into a bare domain; an empty or failed read is retried with the correct post URL, then the next suitable comments tool; every selected post is read.
 */
const stage = (over: Record<string, unknown>) => ({ endpoint_id: "e", expected_rows: 1, planned_rows: 1, parent_key: null, deliver: true, sample_rows: [], measured_by: [], measured_from_calls: [], measured_cost_per_row_usd: 0.0005, ...over }) as unknown as PricedPlan["stages"][number];
const POSTS = [{ id: "pA", link: "https://www.facebook.com/AlArabiya/posts/pfbidA", comments: 3 }, { id: "pB", link: "https://www.facebook.com/AlArabiya/posts/pfbidB", comments: 4 }];
const binding = { param: "url", from: "link" };

function planOf(alternatives?: unknown[]): PricedPlan {
  const posts = stage({ key: "posts", title_ar: "المنشورات", endpoint_id: "f.posts", planned_rows: 2, expected_rows: 2, columns: [{ key: "link", title_ar: "الرابط" }, { key: "comments", title_ar: "التعليقات" }], engine: { endpoint_id: "f.posts", params: {}, cursor_param: null, map_code: "return inputs.page", map_file_id: "page", parent_binding: null } });
  const comments = stage({ key: "comments", title_ar: "التعليقات", endpoint_id: "f.commentsA", parent_key: "posts", per_parent_rows: 1000, planned_rows: 7, expected_rows: 7, all_children: true, columns: [{ key: "text", title_ar: "نص التعليق" }], engine: { endpoint_id: "f.commentsA", params: {}, cursor_param: "cursor", map_code: "return inputs.page", map_file_id: "page", parent_binding: binding, ...(alternatives ? { alternatives } : {}) } });
  const stages = [posts, comments];
  return { summary_ar: "x", stages, price: priceMissionByCode(stagePriceInputs(stages, undefined), {}) } as unknown as PricedPlan;
}
interface Behaviour { /** The first read of post A through source A answers 200 with 0 rows (the live answer). */ emptyFirst: boolean; /** Source A gives nothing at all for post A. */ aAlwaysEmpty?: boolean }
async function run(plan: PricedPlan, b: Behaviour) {
  const store = createMemoryStore();
  const calls: Array<{ endpoint: string; url: string }> = [];
  const seenA = new Set<string>();
  let seq = 0;
  const gateway = {
    async tregCall(input: { endpoint_id?: unknown; params?: unknown }) {
      const endpoint = String(input.endpoint_id);
      const params = (input.params ?? {}) as Record<string, unknown>;
      const url = String(params.url ?? "");
      calls.push({ endpoint, url });
      // a bare domain is not a post: the source refuses it (live: HTTP 500 «The URL (facebook.com) couldn't be parsed»)
      if (!/\/posts\//.test(url) && endpoint !== "f.posts") return { ok: false as const, failed: true, http_status: 500, message: "The URL couldn't be parsed" };
      let rows: Array<Record<string, unknown>>;
      if (endpoint === "f.posts") rows = POSTS;
      else {
        const post = POSTS.find((p) => p.link === url)!;
        const first = !seenA.has(`${endpoint}:${post.id}`);
        seenA.add(`${endpoint}:${post.id}`);
        const empty = endpoint === "f.commentsA" && post.id === "pA" && (b.aAlwaysEmpty || (b.emptyFirst && first));
        rows = empty ? [] : Array.from({ length: post.comments }, (_, k) => ({ id: `${endpoint}-${post.id}-c${k}`, text: `تعليق ${k}` }));
      }
      const callId = `call_${String((seq += 1)).padStart(4, "0")}`;
      await store.putFile("msn_fb", RAW_PATH(callId), JSON.stringify(rows), "application/json");
      return { ok: true as const, call_id: callId, http_status: 200, rows_in_page: rows.length, has_more: false, next_cursor: null, shape: null, first_rows: [], warnings: [], saved: "" };
    },
  } as unknown as Gateway;
  const items = await ItemStore.open(store, "msn_fb");
  await runEngine({ items, store, plan, missionId: "msn_fb", gateway, sandbox: async (_c, inputs) => ({ ok: true, resultJson: JSON.stringify(Object.values(inputs)[0]), logs: [] }), addEvent: async () => undefined, deadlineMs: Date.now() + 3_600_000, sleep: async () => undefined, redesignStages: new Set(["posts", "comments"]) });
  const byParent = (id: string) => items.acceptedRows("comments").filter((r) => r.parent_id === id).length;
  return { calls, a: byParent("pA"), b: byParent("pB"), delivered: items.acceptedRows("comments").length };
}

describe("R1: a Facebook post's comments are read with the post's own URL, never a bare domain", () => {
  it("the first read of post A answers 200 with 0 rows: the engine never asks for «facebook.com»", async () => {
    const r = await run(planOf(), { emptyFirst: true });
    expect(r.calls.some((c) => !/\/posts\//.test(c.url) && c.endpoint !== "f.posts")).toBe(false);
  });
  it("an empty first read is retried with the correct post URL: post A gives its 3 comments, post B its 4, promised 7 = delivered 7", async () => {
    const r = await run(planOf(), { emptyFirst: true });
    expect([r.a, r.b]).toEqual([3, 4]);
    expect(r.delivered).toBe(7);
  });
  it("every selected post is read (post B is called even though post A failed to answer)", async () => {
    const r = await run(planOf(), { emptyFirst: true, aAlwaysEmpty: true });
    expect(r.calls.filter((c) => c.endpoint === "f.commentsA" && c.url === POSTS[1].link).length).toBeGreaterThan(0);
    expect(r.b).toBe(4);
  });
  it("source A gives nothing for post A: the next suitable comments tool reads it (promised 7, delivered 7)", async () => {
    const alt = { endpoint_id: "f.commentsB", params: {}, cursor_param: "cursor", map_code: "return inputs.page", map_file_id: "page", parent_binding: binding };
    const r = await run(planOf([alt]), { emptyFirst: true, aAlwaysEmpty: true });
    expect(r.calls.some((c) => c.endpoint === "f.commentsB" && c.url === POSTS[0].link)).toBe(true);
    expect([r.a, r.b, r.delivered]).toEqual([3, 4, 7]);
  });
  it("with no empty read every selected post gives all its comments (7 delivered)", async () => {
    const r = await run(planOf(), { emptyFirst: false });
    expect(r.delivered).toBe(7);
  });
});
