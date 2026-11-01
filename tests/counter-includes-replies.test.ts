import { describe, expect, it } from "vitest";
import { createMemoryStore } from "../agent/src/memoryStore";
import { ItemStore } from "../agent/src/items/itemStore";
import { runEngine } from "../agent/src/engine/run";
import { RAW_PATH, type Gateway } from "../agent/src/gateway";
import { priceMissionByCode } from "../src/lib/agentMission/price";
import { stagePriceInputs, type PricedPlan } from "../src/lib/agentMission/plan";
import { withCompleteCount, type Candidate } from "../src/lib/agentMission/completeCount";
import { checkCustomerText } from "../src/lib/agentMission/text";

/**
 * COMPLETE COUNT, item 2 (owner decision after #332 review): on TikTok, Instagram, Facebook and YouTube a video's own counter counts its comments AND its replies. When the customer asked for comments and replies, the promise and the delivery are counted on the same
 * basis (comments + replies together). When only comments are asked, the promise is NOT taken from a counter that includes replies.
 * The world: video v0 counter 100 = 70 comments + 30 replies, video v1 counter 60 = 42 comments + 18 replies (the share of top-level comments is 0.7).
 */
const TOP = { v0: 70, v1: 42 } as Record<string, number>;
const REPLIED = { v0: 30, v1: 18 } as Record<string, number>; // comments c0..c(k-1) of the video have one reply each
const COUNTERS = { v0: 100, v1: 60 } as Record<string, number>;
const cands: Candidate[] = Object.entries(COUNTERS).map(([id, counter]) => ({ id, counter }));

const stage = (over: Record<string, unknown>) => ({ endpoint_id: "e", expected_rows: 1, planned_rows: 1, parent_key: null, deliver: true, sample_rows: [], measured_by: [], measured_from_calls: [], measured_cost_per_row_usd: 0.0005, ...over }) as unknown as PricedPlan["stages"][number];
const map = "return inputs.page";
function planOf(withReplies: boolean): PricedPlan {
  const videos = stage({ key: "videos", title_ar: "الفيديوهات", endpoint_id: "v.videos", planned_rows: 2, expected_rows: 2, columns: [{ key: "caption", title_ar: "الوصف" }, { key: "comments", title_ar: "التعليقات" }], engine: { endpoint_id: "v.videos", params: {}, cursor_param: null, map_code: map, map_file_id: "page", parent_binding: null } });
  const comments = stage({ key: "comments", title_ar: "التعليقات", endpoint_id: "v.comments", parent_key: "videos", per_parent_rows: 500, planned_rows: 130, expected_rows: 130, columns: [{ key: "text", title_ar: "نص التعليق" }], engine: { endpoint_id: "v.comments", params: {}, cursor_param: "cursor", map_code: map, map_file_id: "page", parent_binding: { param: "videoId", from: "id" } } });
  const replies = stage({ key: "comments_replies", title_ar: "الردود", endpoint_id: "v.replies", parent_key: "comments", replies_of: "comments", per_parent_rows: 10, planned_rows: 13, expected_rows: 13, columns: [{ key: "text", title_ar: "نص الرد" }], engine: { endpoint_id: "v.replies", params: {}, cursor_param: "cursor", map_code: map, map_file_id: "page", parent_binding: { param: "commentId", from: "id" } } });
  const stages = withReplies ? [videos, comments, replies] : [videos, comments];
  return { summary_ar: "x", stages, price: priceMissionByCode(stagePriceInputs(stages, undefined), {}) } as unknown as PricedPlan;
}
const plan = (withReplies: boolean, share: number | null, request: string) => withCompleteCount(planOf(withReplies), { request, candidatesOf: async () => cands, basisOf: async () => (share === null ? null : { share }) });

async function run(p: PricedPlan) {
  const store = createMemoryStore();
  let seq = 0;
  const gateway = {
    async tregCall(input: { endpoint_id?: unknown; params?: unknown }) {
      const endpoint = String(input.endpoint_id);
      const params = (input.params ?? {}) as Record<string, unknown>;
      let rows: Array<Record<string, unknown>>; let next: string | null = null;
      if (endpoint === "v.videos") rows = Object.entries(COUNTERS).map(([id, n]) => ({ id, caption: `فيديو ${id}`, comments: n }));
      else if (endpoint === "v.comments") {
        const v = String(params.videoId);
        const from = Number(params.cursor ?? 0);
        const n = Math.max(0, Math.min(20, TOP[v] - from));
        rows = Array.from({ length: n }, (_, k) => ({ id: `${v}-c${from + k}`, text: `تعليق ${from + k}`, replies_count: from + k < REPLIED[v] ? 1 : 0 }));
        next = from + n < TOP[v] ? String(from + n) : null;
      } else rows = [{ id: `${params.commentId}-r0`, text: "رد" }];
      const callId = `call_${String((seq += 1)).padStart(4, "0")}`;
      await store.putFile("msn_cr", RAW_PATH(callId), JSON.stringify(rows), "application/json");
      return { ok: true as const, call_id: callId, http_status: 200, rows_in_page: rows.length, has_more: next !== null, next_cursor: next, shape: null, first_rows: [], warnings: [], saved: "" };
    },
  } as unknown as Gateway;
  const items = await ItemStore.open(store, "msn_cr");
  await runEngine({ items, store, plan: p, missionId: "msn_cr", gateway, sandbox: async (_c, inputs) => ({ ok: true, resultJson: JSON.stringify(Object.values(inputs)[0]), logs: [] }), addEvent: async () => undefined, deadlineMs: Date.now() + 3_600_000, sleep: async () => undefined, redesignStages: new Set(["videos", "comments", "comments_replies"]) });
  return { comments: items.acceptedRows("comments").length, replies: items.acceptedRows("comments_replies").length };
}
const stageOf = (p: PricedPlan, key: string) => p.stages.find((s) => s.key === key)!;

describe("only comments asked: the promise is not taken from a counter that includes replies", () => {
  it("the counters 100 and 60 give 160 with replies in them; the promise is the 112 top-level comments (share 0.7), delivered 112", async () => {
    const p = await plan(false, 0.7, "كل التعليقات على فيديوهين");
    expect(stageOf(p, "comments").planned_rows).toBe(112);
    expect((await run(p)).comments).toBe(112);
  });
  it("the card says that the platform's counter includes the replies, with the real number", async () => {
    const note = ((await plan(false, 0.7, "كل التعليقات على فيديوهين")).notes_ar ?? []).join(" ");
    expect(note).toContain("يشمل الردود");
    expect(note).toContain("١١٢");
    expect(note).not.toContain("١٦٠");
    expect(checkCustomerText(note).issues).toEqual([]);
  });
});

describe("comments AND replies asked: one basis, the total of comments and replies", () => {
  it("promised total 160 = 112 comments + 48 replies; delivered 112 + 48 = 160", async () => {
    const p = await plan(true, 0.7, "كل التعليقات وكل الردود على فيديوهين");
    expect(stageOf(p, "comments").planned_rows).toBe(112);
    expect(stageOf(p, "comments_replies").planned_rows).toBe(48);
    expect(p.price.deliveredRows).toBe(2 + 112 + 48);
    const r = await run(p);
    expect([r.comments, r.replies, r.comments + r.replies]).toEqual([112, 48, 160]);
  });
  it("the card states the total 160 and its two parts", async () => {
    const note = ((await plan(true, 0.7, "كل التعليقات وكل الردود على فيديوهين")).notes_ar ?? []).join(" ");
    expect(note).toContain("١٦٠");
    expect(note).toContain("١١٢");
    expect(note).toContain("٤٨");
    expect(checkCustomerText(note).issues).toEqual([]);
  });
});

describe("a counter that does not include replies is used as it is", () => {
  it("share 1 (or no evidence): the counters 100 and 60 are the promise, as before", async () => {
    expect(stageOf(await plan(false, 1, "كل التعليقات على فيديوهين"), "comments").planned_rows).toBe(160);
    expect(stageOf(await plan(false, null, "كل التعليقات على فيديوهين"), "comments").planned_rows).toBe(160);
  });
});
