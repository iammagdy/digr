import { describe, expect, it } from "vitest";
import { createMemoryStore } from "../agent/src/memoryStore";
import { ItemStore } from "../agent/src/items/itemStore";
import { runEngine } from "../agent/src/engine/run";
import { RAW_PATH, type Gateway } from "../agent/src/gateway";
import { priceMissionByCode } from "../src/lib/agentMission/price";
import { stagePriceInputs, type PricedPlan } from "../src/lib/agentMission/plan";
import { completeCountEstimate, completeCountNotesAr, supplyOf, withCompleteCount, type Candidate } from "../src/lib/agentMission/completeCount";
import { checkCustomerText } from "../src/lib/agentMission/text";

/**
 * THE COMPLETE COUNT (S1 live findings, the owner's top rule): the count on the approved plan is the count delivered. The promised number comes from the REAL counters of the parents that will be read; parents that cannot supply the request are replaced by
 * other candidates of the same listing; the chosen parents are pinned so that a post published between planning and execution changes nothing; every existing comment is read page by page to the end of its parent; a shortfall is stated BEFORE approval.
 */
const cands = (...counters: Array<number | null>): Candidate[] => counters.map((c, i) => ({ id: `p${i}`, counter: c }));
const ALL = { perParent: Number.POSITIVE_INFINITY, requested: null, pageCap: null, fallback: 10 };

describe("the estimate: promised = what the chosen parents can really supply", () => {
  it("low-comment parents, «all»: the first parents that have any comment, 0 is never counted", () => {
    const e = completeCountEstimate(cands(0, 1, 3, 2, 5), { parents: 2, ...ALL });
    expect(e.chosen.map((c) => c.id)).toEqual(["p1", "p2"]);
    expect(e.total).toBe(4);
    expect(e.requested).toBeNull();
  });
  it("high-comment parents, «all»: the sum of the counters", () => {
    expect(completeCountEstimate(cands(250, 130), { parents: 2, ...ALL }).total).toBe(380);
  });
  it("a numbered request the first parents cannot supply: other candidates of the listing take their place, the largest counters first", () => {
    const e = completeCountEstimate(cands(3, 2, 50, 40), { parents: 2, perParent: 10, requested: 20, pageCap: null, fallback: 10 });
    expect(e.chosen.map((c) => c.id).sort()).toEqual(["p2", "p3"]);
    expect(e.total).toBe(20);
    expect(e.replaced).toBe(2);
  });
  it("with no shortfall the parents stay in the source's order (nothing is chosen by engagement)", () => {
    const e = completeCountEstimate(cands(12, 11, 90, 80), { parents: 2, perParent: 10, requested: 20, pageCap: null, fallback: 10 });
    expect(e.chosen.map((c) => c.id)).toEqual(["p0", "p1"]);
    expect(e.total).toBe(20);
    expect(e.replaced).toBe(0);
  });
  it("when even the best parents are short, the real number is the promise and the shortfall is told", () => {
    const e = completeCountEstimate(cands(3, 2), { parents: 2, perParent: 10, requested: 20, pageCap: null, fallback: 10 });
    expect(e.total).toBe(5);
    const notes = completeCountNotesAr(e, "المنشورات").join(" ");
    expect(notes).toContain("٥");
    expect(notes).toContain("٢٠");
    expect(checkCustomerText(notes).issues).toEqual([]);
  });
  it("a source with no next page gives at most one call: the promise never counts rows it cannot return, and the card says so", () => {
    const e = completeCountEstimate(cands(171, 11), { parents: 2, ...ALL, pageCap: 120 });
    expect(e.total).toBe(131);
    expect(e.capped).toBe(true);
    expect(completeCountNotesAr(e, "الفيديوهات").join(" ")).toContain("المصدر يعطي");
  });
  it("a parent with no counter is estimated at the fallback share", () => {
    expect(supplyOf(null, Number.POSITIVE_INFINITY, null, 10)).toBe(10);
    expect(supplyOf(7, 5, null, 10)).toBe(5);
    expect(supplyOf(171, Number.POSITIVE_INFINITY, 120, 10)).toBe(120);
  });
});

const stage = (over: Record<string, unknown>) => ({ endpoint_id: "e", expected_rows: 1, planned_rows: 1, parent_key: null, deliver: true, sample_rows: [], measured_by: [], measured_from_calls: [], measured_cost_per_row_usd: 0.0005, ...over }) as unknown as PricedPlan["stages"][number];
function planOf(parents: number, perParent: number, requestedTotal = parents * perParent): PricedPlan {
  const videos = stage({ key: "videos", title_ar: "المنشورات", endpoint_id: "v.videos", planned_rows: parents, expected_rows: parents, columns: [{ key: "caption", title_ar: "الوصف" }, { key: "comments", title_ar: "التعليقات" }], engine: { endpoint_id: "v.videos", params: {}, cursor_param: null, map_code: "return inputs.page", map_file_id: "page", parent_binding: null } });
  const comments = stage({ key: "comments", title_ar: "التعليقات", endpoint_id: "v.comments", parent_key: "videos", per_parent_rows: perParent, planned_rows: requestedTotal, expected_rows: requestedTotal, columns: [{ key: "text", title_ar: "نص التعليق" }], engine: { endpoint_id: "v.comments", params: {}, cursor_param: "cursor", map_code: "return inputs.page", map_file_id: "page", parent_binding: { param: "videoId", from: "id" } } });
  const stages = [videos, comments];
  return { summary_ar: "ستحصل على منشورات وتعليقاتها.", stages, price: priceMissionByCode(stagePriceInputs(stages, undefined), {}) } as unknown as PricedPlan;
}

describe("the plan promises the real count, pins the parents and states the number", () => {
  it("«all» on 2 posts of 150 and 40 comments: 190 promised, both posts pinned, the card says 190 in Arabic digits, the price follows", async () => {
    const before = planOf(2, 10);
    const after = await withCompleteCount(before, { request: "هات منشورين ومع كل منشور كل التعليقات", candidatesOf: async () => cands(150, 40, 9) });
    const c = after.stages.find((s) => s.key === "comments")!;
    expect(c.planned_rows).toBe(190);
    expect(c.all_children).toBe(true);
    expect((c as { parent_pins?: string[] }).parent_pins).toEqual(["p0", "p1"]);
    expect(after.price.deliveredRows).toBe(2 + 190);
    expect((after.notes_ar ?? []).join(" ")).toContain("١٩٠");
  });
  it("a numbered request (10 a post) is also computed from the counters: 2 posts of 3 and 2 comments promise 5, not 20", async () => {
    const after = await withCompleteCount(planOf(2, 10), { request: "هات منشورين ومن كل منشور ١٠ تعليقات", candidatesOf: async () => cands(3, 2) });
    const c = after.stages.find((s) => s.key === "comments")!;
    expect(c.planned_rows).toBe(5);
    expect((after.notes_ar ?? []).join(" ")).toContain("٥ تعليقًا فقط من ٢٠");
  });
  it("no counter known for any candidate: the plan is returned as it was (nothing real can be promised)", async () => {
    const before = planOf(2, 10);
    expect(await withCompleteCount(before, { request: "كل التعليقات", candidatesOf: async () => cands(null, null) })).toBe(before);
  });
});

// ---- replay worlds: the promise equals the delivery ------------------------------------------------------------------------------------------------------------------------
interface World { planning: Candidate[]; executionListing: Array<{ id: string; comments: number }>; pageCap?: number | null; request: string; parents: number; perParent: number }
async function runWorld(w: World) {
  const total = new Map<string, number>(w.executionListing.map((r) => [r.id, r.comments]));
  const store = createMemoryStore();
  let seq = 0;
  const gateway = {
    async tregCall(input: { endpoint_id?: unknown; params?: unknown }) {
      const params = (input.params ?? {}) as Record<string, unknown>;
      let rows: Array<Record<string, unknown>>; let next: string | null = null;
      if (String(input.endpoint_id) === "v.videos") rows = w.executionListing.map((r) => ({ id: r.id, caption: `منشور ${r.id}`, comments: r.comments }));
      else {
        const all = total.get(String(params.videoId)) ?? 0;
        const from = Number(params.cursor ?? 0);
        const size = w.pageCap ?? 20;
        const n = Math.max(0, Math.min(size, all - from));
        rows = Array.from({ length: n }, (_, k) => ({ id: `${params.videoId}-c${from + k}`, text: `تعليق ${from + k}` }));
        next = w.pageCap ? null : from + n < all ? String(from + n) : null;
      }
      const callId = `call_${String((seq += 1)).padStart(4, "0")}`;
      await store.putFile("msn_cc", RAW_PATH(callId), JSON.stringify(rows), "application/json");
      return { ok: true as const, call_id: callId, http_status: 200, rows_in_page: rows.length, has_more: next !== null, next_cursor: next, shape: null, first_rows: [], warnings: [], saved: "" };
    },
  } as unknown as Gateway;
  const plan = await withCompleteCount(planOf(w.parents, w.perParent), { request: w.request, candidatesOf: async () => w.planning, pageCapOf: async () => w.pageCap ?? null });
  if (w.pageCap) plan.stages.find((s) => s.key === "comments")!.engine!.cursor_param = null;
  const items = await ItemStore.open(store, "msn_cc");
  await runEngine({ items, store, plan, missionId: "msn_cc", gateway, sandbox: async (_c, inputs) => ({ ok: true, resultJson: JSON.stringify(Object.values(inputs)[0]), logs: [] }), addEvent: async () => undefined, deadlineMs: Date.now() + 3_600_000, sleep: async () => undefined, redesignStages: new Set(["videos", "comments"]) });
  const promised = plan.stages.find((s) => s.key === "comments")!.planned_rows;
  const delivered = items.acceptedRows("comments");
  return { promised, delivered: delivered.length, parentsRead: [...new Set(delivered.map((r) => String(r.parent_id)))].sort(), plan };
}
const listing = (...counters: number[]) => counters.map((c, i) => ({ id: `p${i}`, comments: c }));
const asCands = (l: Array<{ id: string; comments: number }>): Candidate[] => l.map((r) => ({ id: r.id, counter: r.comments }));

describe("replay worlds: the promised count equals the delivered count", () => {
  it("LOW-comment parents (0, 1, 3, 2, 5): «all» on 2 posts promises 4 and delivers 4", async () => {
    const l = listing(0, 1, 3, 2, 5);
    const r = await runWorld({ planning: asCands(l), executionListing: l, request: "هات منشورين ومع كل منشور كل التعليقات", parents: 2, perParent: 10 });
    expect(r.promised).toBe(4);
    expect(r.delivered).toBe(r.promised);
  });
  it("HIGH-comment parents (250, 130): promises 380 and delivers 380", async () => {
    const l = listing(250, 130);
    const r = await runWorld({ planning: asCands(l), executionListing: l, request: "هات منشورين ومع كل منشور كل التعليقات", parents: 2, perParent: 10 });
    expect(r.promised).toBe(380);
    expect(r.delivered).toBe(r.promised);
  });
  it("MULTI-page comments (45 and 61 over pages of 20): every comment to the end of each parent, 106 promised and delivered", async () => {
    const l = listing(45, 61);
    const r = await runWorld({ planning: asCands(l), executionListing: l, request: "كل التعليقات على منشورين", parents: 2, perParent: 10 });
    expect(r.promised).toBe(106);
    expect(r.delivered).toBe(106);
  });
  it("uneven parents with a numbered request: 100 and 2 comments, 100 a post asked: nothing is cut to an equal share", async () => {
    const l = listing(100, 2);
    const r = await runWorld({ planning: asCands(l), executionListing: l, request: "منشورين ومن كل منشور ١٠٠ تعليق", parents: 2, perParent: 100 });
    expect(r.promised).toBe(102);
    expect(r.delivered).toBe(102);
  });
  it("the listing DRIFTS between planning and execution (two new posts with 0 and 1 comments appear first): the pinned posts are read, promise = delivery", async () => {
    const planning = listing(40, 25, 7);
    const executionListing = [{ id: "n0", comments: 0 }, { id: "n1", comments: 1 }, ...planning];
    const r = await runWorld({ planning: asCands(planning), executionListing, request: "هات منشورين ومع كل منشور كل التعليقات", parents: 2, perParent: 10 });
    expect(r.promised).toBe(65);
    expect(r.parentsRead).toEqual(["p0", "p1"]);
    expect(r.delivered).toBe(65);
  });
  it("parents that cannot supply the request are replaced by other posts of the same listing: 20 asked, 20 promised, 20 delivered", async () => {
    const l = listing(3, 2, 50, 40);
    const r = await runWorld({ planning: asCands(l), executionListing: l, request: "منشورين ومن كل منشور ١٠ تعليقات", parents: 2, perParent: 10 });
    expect(r.promised).toBe(20);
    expect(r.parentsRead).toEqual(["p2", "p3"]);
    expect(r.delivered).toBe(20);
  });
  it("a source with no next page (one call gives 120): the promise is what the source gives, 131, delivered 131", async () => {
    const l = listing(171, 11);
    const r = await runWorld({ planning: asCands(l), executionListing: l, pageCap: 120, request: "كل التعليقات على منشورين", parents: 2, perParent: 10 });
    expect(r.promised).toBe(131);
    expect(r.delivered).toBe(131);
  });
  it("a pinned post the execution does not find: the live parents are read and what exists is delivered (never a crash, never more than promised)", async () => {
    const planning = listing(40, 25);
    const executionListing = listing(33, 20);
    const r = await runWorld({ planning: asCands(planning), executionListing: executionListing.map((x) => ({ ...x, id: `z${x.id}` })), request: "هات منشورين ومع كل منشور كل التعليقات", parents: 2, perParent: 10 });
    expect(r.delivered).toBeGreaterThan(0);
    expect(r.delivered).toBeLessThanOrEqual(r.promised);
  });
});
