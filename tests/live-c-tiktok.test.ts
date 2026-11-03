import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { buildShapeDigest } from "../src/lib/modelPlanner/digest";
import { buildAsk } from "../src/lib/agentMission/foundation/ask";
import { compilePlan, parentInputs, repliesSizing } from "../src/lib/agentMission/foundation/compilePlan";
import { cardOf, mapPage } from "../src/lib/agentMission/foundation/toolCards";
import { customerPlanView, type PricedPlan } from "../src/lib/agentMission/plan";
import { priceFactsOf, stagesView } from "../src/lib/agentMission/customerView";
import { withPromiseCaps } from "../src/lib/agentMission/repliesCard";
import { AGENT_MAX_DELIVERED_ROWS, AGENT_REPLIES_PER_COMMENT_MAX } from "../src/lib/agentMission/constants";
import { checkCustomerText } from "../src/lib/agentMission/text";
import { pointsAr } from "../src/lib/pointsFormat";
import { formatAr } from "../src/lib/arabicDigits";
import { createMemoryStore } from "../agent/src/memoryStore";
import { ItemStore } from "../agent/src/items/itemStore";
import { runEngine } from "../agent/src/engine/run";
import { runInSandbox } from "../agent/src/sandbox";
import { redesignStagesOf } from "../agent/src/redesign";
import { RAW_PATH, type Gateway } from "../agent/src/gateway";
import type { RedesignFlags } from "../src/lib/agentMission/redesignFlags";

/**
 * LIVE FINDING C (3 Nov 2026, test account, msn_b9eb261694fa611013d4, plan_ready, never approved): «عايز فيديوهين من تيك توك من مصر بالعربي عن الذكاء الاصطناعي، أكتر فيديوهات عليها تعليقات،
 * و١٠٠ تعليق من كل فيديو مع ردود». The card said «٢٠٢ عنصر» and «السعر حتى ٩٬٥٣٦ نقطة», hold 10,966.
 *   - the items of the card (stagesView) leave out the replies stage (it promises no number); the price (priceMissionByCode over the plan's stages) counts its 1,875 rows: 2 + 200 + 1,875 = 2,077
 *     rows x 4.590925 = 9,536. So the price described 2,077 rows and the card 202.
 *   - 1,875 = ceil(200 x 375 / 40): the MEAN reply counter of the 40 comments read at planning (375 / 40), applied to all 200 comments chosen, then cut by a flat per-comment cap of 50.
 *   - the engine read each comment for at most that cap (replyShares at 50) and stopped the stage at the 1,875 (planned_rows): a comment with 120 replies gave 50.
 */
interface Rec { card: { itemsShown: number; priceMaxShown: number; holdShown: number }; price: { deliveredRows: number; reservePoints: number; maxChargePoints: number; unitPricePoints: number }; exposure: { comments_read: number; replies_counter_sum: number }; compiled: { promises: Record<string, { n: number; type: string }> } }
const LIVE = JSON.parse(readFileSync(new URL("./fixtures/live/plans/msn_b9eb261694fa611013d4.json", import.meta.url), "utf8")) as Rec;
const catalog = loadTregCatalog();
const M12 = "msn_5851abc92a1e6645a9cd";
const page = (call: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/live/missions/${M12}/raw/${call}.json`, import.meta.url), "utf8"));
const CAP = AGENT_REPLIES_PER_COMMENT_MAX;

describe("C, the formula of the live card (stored record read by SELECT, anonymised)", () => {
  it("the price counted 2,077 rows, the card 202: the difference is the replies the card does not count", () => {
    const rows = LIVE.compiled.promises;
    expect(LIVE.card.itemsShown).toBe(rows.videos.n + rows.comments.n);
    expect(LIVE.price.deliveredRows).toBe(rows.videos.n + rows.comments.n + rows.comments_replies.n);
    expect(LIVE.price.maxChargePoints).toBe(Math.ceil(LIVE.price.deliveredRows * LIVE.price.unitPricePoints));
    expect(LIVE.card.priceMaxShown).toBe(LIVE.price.maxChargePoints);
    expect(Math.round(LIVE.price.maxChargePoints * 1.15)).toBe(LIVE.price.reservePoints);
  });
  it("the replies' 1,875 = the mean counter of the 40 comments read at planning x the 200 comments chosen", () => {
    expect(LIVE.compiled.promises.comments_replies).toEqual({ n: 1875, type: "open" });
    expect(Math.ceil(200 * (LIVE.exposure.replies_counter_sum / LIVE.exposure.comments_read))).toBe(1875);
  });
});

describe("C2, the replies are sized from the REAL counters of the chosen comments; the cap of 50 sizes only what is not counted", () => {
  it("the comments read at planning count with their own reply counters (a comment with 120 replies counts 120, not 50)", () => {
    const known = [120, 33, 24, ...Array.from({ length: 37 }, () => 6)];
    const s = repliesSizing({ comments: 200, known, perComment: CAP });
    expect(s.counted).toBe(120 + 33 + 24 + 37 * 6);
    expect(s.countedComments).toBe(40);
  });
  it("the comments not read yet are sized by the mean of the counters read, each cut at the cap, and never above the cap each; the total is counted + that", () => {
    const known = [120, 33, 24, ...Array.from({ length: 37 }, () => 6)];
    const s = repliesSizing({ comments: 200, known, perComment: CAP });
    const mean = (50 + 33 + 24 + 37 * 6) / 40;
    expect(s.open).toBe(Math.ceil(160 * mean));
    expect(s.open).toBeLessThanOrEqual(160 * CAP);
    expect(s.total).toBe(s.counted + s.open);
  });
  it("every comment counted: the total is exactly the counters (nothing estimated); none counted: only an estimate bounded by the cap", () => {
    const all = repliesSizing({ comments: 4, known: [0, 3, 80, 7], perComment: CAP });
    expect(all).toMatchObject({ counted: 90, open: 0, total: 90, countedComments: 4 });
    const none = repliesSizing({ comments: 10, known: [], perComment: CAP });
    expect(none.counted).toBe(0);
    expect(none.open).toBeGreaterThan(0);
    expect(none.open).toBeLessThanOrEqual(10 * CAP);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------ the plan and its card
const REQUEST = "عايز فيديوهين من تيك توك من مصر بالعربي عن الذكاء الاصطناعي، أكتر فيديوهات عليها تعليقات، و١٠٠ تعليق من كل فيديو مع ردود";
const CREATED = Date.parse("2026-11-03T06:04:49Z");
/** The real comment pages of M12 (20 comments each), their reply counters set to the live shape: the first page's first comment has 120 replies, the rest as the live samples (33, 24 ...). */
function exposurePage(call: string, counters: number[]): unknown {
  const p = JSON.parse(JSON.stringify(page(call))) as { output: { data: { comments: Array<Record<string, unknown>> } } };
  p.output.data.comments.forEach((c, i) => { c.replies = counters[i] ?? 0; });
  return p;
}
const C1 = [120, 33, 24, 0, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6];
const C2 = [20, 0, 9, 14, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5];
const SUM = [...C1, ...C2].reduce((a, b) => a + b, 0);

function compiled(request = REQUEST, counters: [number[], number[]] = [C1, C2]) {
  const ask = buildAsk(request, null, CREATED);
  const card = cardOf("tikhub.tiktok.search.videos")!;
  const pages = [exposurePage("call_0008", counters[0]), exposurePage("call_0019", counters[1])];
  let next = 0;
  const given = new Map<string, unknown>();
  const result = compilePlan({
    ask, pool: { card, params: parentInputs(card, ask), pages: [{ callId: "call_0007", page: page("call_0007") }] },
    exposure: (id) => { if (!given.has(id) && next < pages.length) given.set(id, pages[next++]); return given.has(id) ? { callId: `call_${id.slice(-4)}`, page: given.get(id), failed: false } : undefined; },
    capabilityOf: (id) => catalog.byId.get(id)?.capability ?? null,
  });
  if (!result.ok) throw new Error(`no plan: ${result.reason}`);
  return { ask, result, plan: result.plan as PricedPlan };
}
const replies = (plan: PricedPlan) => plan.stages.find((s) => s.key === "comments_replies")!;
const comments = (plan: PricedPlan) => plan.stages.find((s) => s.key === "comments")!;

describe("C2, the compiled plan: the replies stage is sized from the counters of the chosen comments read at planning", () => {
  const { plan, result } = compiled();
  const known = [...C1, ...C2];
  it("the comments the exposure check read are the first comments of the chosen videos: their counters are the real ones, counted as such", () => {
    const p = result.promises.comments_replies as { type: string; n: number; counted?: number; counted_comments?: number };
    const planned = comments(plan).planned_rows;
    const s = repliesSizing({ comments: planned, known, perComment: CAP });
    expect(p.type).toBe("open");
    expect(p.counted).toBe(SUM);
    expect(p.counted_comments).toBe(40);
    expect(p.n).toBe(s.total);
    expect(replies(plan).planned_rows).toBe(s.total);
    expect(plan.compiled!.promises.comments_replies).toMatchObject({ counted: SUM, counted_comments: 40 });
  });
  it("replies were asked with no number per comment: every reply the source shows is read (the cap of 50 only sizes the hold)", () => {
    expect(replies(plan).replies_uncapped).toBe(true);
    expect(replies(plan).per_parent_rows).toBe(CAP);
  });
  it("a number per comment from the customer stays a number: not read-all", () => {
    const { plan: p3 } = compiled(`${REQUEST.replace("مع ردود", "مع ٣ ردود على كل تعليق")}`);
    expect(replies(p3).replies_uncapped).toBeUndefined();
    expect(replies(p3).per_parent_rows).toBe(3);
  });
});

describe("C1, the card: the items and the price maximum describe the same thing; the replies not counted yet are their own «حتى» line", () => {
  const { plan } = compiled();
  const pub = customerPlanView(plan, { now: CREATED });
  const view = stagesView(pub);
  const unit = pub.price.unit_price_points;
  const max = pub.price.max_charge_points;
  const counted = 2 + comments(plan).planned_rows + SUM;
  const open = pub.price.delivered_rows - counted;
  const facts = priceFactsOf(pub).facts;

  it("the total of the card counts the videos, the comments and the replies counted by the counters read", () => {
    expect(view.total).toBe(counted);
    expect(view.total + open).toBe(pub.price.delivered_rows);
  });
  it("«السعر حتى» is the price of exactly those items; a separate line gives the replies not yet counted, with their rows and their own price; the two add up to the maximum", () => {
    const priceCounted = Math.min(max, Math.ceil(view.total * unit));
    expect(facts.find((f) => f.labelAr === "السعر حتى")!.valueAr).toBe(pointsAr(priceCounted));
    const line = facts.find((f) => /ردود/.test(f.labelAr) && /حتى/.test(f.labelAr));
    expect(line, JSON.stringify(facts)).toBeDefined();
    expect(line!.valueAr).toContain(pointsAr(max - priceCounted));
    expect(line!.valueAr).toContain(formatAr(open));
  });
  it("the hold is unchanged, and the stage line of the replies says what is counted and what is not", () => {
    expect(facts.find((f) => f.labelAr === "حجز مؤقت")!.valueAr).toBe(pointsAr(pub.price.reserve_points));
    const stage = view.stages.find((s) => s.titleAr.includes("الردود"))!;
    expect(stage.rowsAr).toMatch(/حتى/);
    expect(stage.rowsAr).not.toBe("كل الردود على التعليقات المختارة");
  });
  it("Arabic only: Arabic-Indic numerals, no provider, no dollar, no emoji", () => {
    for (const line of [...(pub.notes_ar ?? []), ...facts.map((f) => `${f.labelAr} ${f.valueAr}`), ...view.stages.map((s) => s.rowsAr)]) {
      expect(checkCustomerText(line, { maxChars: 600 }).issues, line).toEqual([]);
      expect(line).not.toMatch(/[0-9]/);
    }
  });
  it("a plan with no replies asked is unchanged: no extra line", () => {
    const { plan: noReplies } = compiled(REQUEST.replace("مع ردود", ""));
    const p = customerPlanView(noReplies, { now: CREATED });
    expect(priceFactsOf(p).facts.some((f) => /ردود/.test(f.labelAr))).toBe(false);
    expect(stagesView(p).total).toBe(p.price.delivered_rows);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------ the engine: no truncation
const catalogOf = catalog;
const idOf = (url: unknown): string => String(url ?? "").match(/\d{15,}/g)?.pop() ?? "";
/** A source world over the REAL page shapes of M12: the comments pages are the exposure pages (one page per video), the reply pages are 20 a page with a cursor, `givenOf` replies per comment. */
function world(givenOf: (commentId: string) => number, videoPages: Map<string, unknown>, options: { trailingCursor?: boolean } = {}) {
  const store = createMemoryStore();
  let seq = 0;
  const replyCalls = new Map<string, number>();
  const replyPage = (commentId: string, cursor: unknown, videoId: string) => {
    const total = givenOf(commentId);
    const from = Number(cursor ?? 0) || 0;
    const n = Math.max(0, Math.min(20, total - from));
    return { output: { data: { comments: Array.from({ length: n }, (_, i) => ({ id: `${commentId}${String(from + i).padStart(4, "0")}`, text: `نص_رد`, author: `a${from + i}`, authorName: `n${from + i}`, authorUserId: `u${from + i}`, createdUtc: 1790000000 + from + i, likes: i, videoId })), nextCursor: from + n < total || (options.trailingCursor === true && n > 0) ? String(from + n) : null } } };
  };
  const gateway = {
    async tregCall(input: { endpoint_id?: unknown; params?: unknown }) {
      const endpointId = String(input.endpoint_id);
      const params = (input.params ?? {}) as Record<string, unknown>;
      const callId = `call_${String((seq += 1)).padStart(4, "0")}`;
      let body: unknown = null;
      if (endpointId === "anyapi.tiktok.video.comments") body = videoPages.get(idOf(params.url)) ?? null;
      if (endpointId === "anyapi.tiktok.comment_replies") { const c = String(params.commentId); replyCalls.set(c, (replyCalls.get(c) ?? 0) + 1); body = replyPage(c, params.cursor, idOf(params.url)); }
      const endpoint = catalogOf.byId.get(endpointId);
      if (body === null || !endpoint) return { ok: false as const, call_id: callId, failed: true as const, http_status: 0, message: "not served" };
      await store.putFile("msn_c_test", RAW_PATH(callId), JSON.stringify(body), "application/json");
      const { reading } = buildShapeDigest(body, endpoint);
      return { ok: true as const, call_id: callId, http_status: 200, rows_in_page: reading.rows.length, has_more: reading.hasMore ?? null, next_cursor: reading.nextCursor ?? null, shape: null, first_rows: [], warnings: [], saved: callId };
    },
  };
  return { store, gateway: gateway as unknown as Gateway, replyCalls };
}

describe("C3, the cap of 50 never truncates a delivery: a comment with 120 replies gives all 120, and the stage is not stopped at the estimate", () => {
  const FLAGS = { social_posts: "test", social_account: "test", social_comments: "test", companies: "off", people: "off", places: "off" } as RedesignFlags;
  // «٢٠ تعليق من كل فيديو مع ردود»: the first page of each video is the whole of what is asked
  const request = "عايز فيديوهين من تيك توك من مصر بالعربي عن الذكاء الاصطناعي، أكتر فيديوهات عليها تعليقات، و٢٠ تعليق من كل فيديو مع ردود";
  async function run(extra: (commentId: string, counted: number) => number) {
    const c = compiled(request);
    const commentRows = [exposurePage("call_0008", C1), exposurePage("call_0019", C2)];
    const chosen = (c.result.plan.stages[0].pinned_rows ?? []).map((r) => String(r.id));
    const videoPages = new Map<string, unknown>(chosen.map((id, i) => [id, commentRows[i]]));
    const ids = new Map<string, number>();
    commentRows.forEach((p) => mapPage(cardOf("anyapi.tiktok.video.comments")!, p).forEach((r) => ids.set(String(r.id), Number(r.replies_count))));
    const w = world((id) => extra(id, ids.get(id) ?? 0), videoPages);
    const items = await ItemStore.open(w.store, "msn_c_test");
    const plan = withPromiseCaps(c.plan);
    await runEngine({ items, store: w.store, plan, missionId: "msn_c_test", gateway: w.gateway, sandbox: (code, inputs) => runInSandbox(code, inputs), addEvent: async () => undefined, deadlineMs: Date.now() + 3_600_000, sleep: async () => undefined, redesignStages: redesignStagesOf(c.plan, FLAGS, true, { tiktok: "test" }) });
    return { c, items, w, plan, ids };
  }

  it("the plan of this request is sized from the exact counters (every chosen comment was read at planning)", async () => {
    const c = compiled(request);
    expect(comments(c.plan).planned_rows).toBe(40);
    expect(replies(c.plan).planned_rows).toBe(SUM);
  });
  it("the comment with a counter of 120 delivers 120 replies, not 50; every comment gives all its replies; the total is the sum of what the source showed", async () => {
    const { items, ids } = await run((_id, counted) => counted);
    const delivered = items.acceptedRows("comments_replies");
    const big = [...ids.entries()].find(([, n]) => n === 120)![0];
    expect(delivered.filter((r) => String(r.parent_id) === big)).toHaveLength(120);
    expect(delivered).toHaveLength(SUM);
    for (const [id, n] of ids) expect(delivered.filter((r) => String(r.parent_id) === id), id).toHaveLength(n);
  });
  it("the source shows MORE than the counter said (counter 3, 70 shown; counter 120, 130 shown): all of them are read, past the estimate of the stage", async () => {
    const { items, ids } = await run((id, counted) => (counted === 120 ? 130 : counted === 24 ? 70 : counted));
    const delivered = items.acceptedRows("comments_replies");
    const big = [...ids.entries()].find(([, n]) => n === 120)![0];
    const mid = [...ids.entries()].find(([, n]) => n === 24)![0];
    expect(delivered.filter((r) => String(r.parent_id) === big)).toHaveLength(130);
    expect(delivered.filter((r) => String(r.parent_id) === mid)).toHaveLength(70);
    expect(delivered.length).toBeGreaterThan(SUM);
  });
  it("a comment that says it has no replies is not read (no paid call); the pages of the 120 are read 20 at a time", async () => {
    const { w, ids } = await run((_id, counted) => counted);
    const zero = [...ids.entries()].filter(([, n]) => n === 0).map(([id]) => id);
    expect(zero.length).toBeGreaterThan(0);
    for (const id of zero) expect(w.replyCalls.get(id) ?? 0).toBe(0);
    const big = [...ids.entries()].find(([, n]) => n === 120)![0];
    expect(w.replyCalls.get(big)).toBe(6);
  });
  it("the real quirk: a page keeps a next-page value after its last row (M12 page 30: 3 rows, counter 3). A comment whose replies reached its counter on a short page is done: no paid page for nothing; an understated counter is still read to the end", async () => {
    const c = compiled(request);
    const commentRows = [exposurePage("call_0008", C1), exposurePage("call_0019", C2)];
    const chosen = (c.result.plan.stages[0].pinned_rows ?? []).map((r) => String(r.id));
    const ids = new Map<string, number>();
    commentRows.forEach((p) => mapPage(cardOf("anyapi.tiktok.video.comments")!, p).forEach((r) => ids.set(String(r.id), Number(r.replies_count))));
    // the counters of 24 and 0..6 are right; the counter of 33 is understated (the source shows 75)
    const shown = (id: string) => { const n = ids.get(id) ?? 0; return n === 33 ? 75 : n; };
    const w = world(shown, new Map(chosen.map((id, i) => [id, commentRows[i]])), { trailingCursor: true });
    const items = await ItemStore.open(w.store, "msn_c_test");
    await runEngine({ items, store: w.store, plan: withPromiseCaps(c.plan), missionId: "msn_c_test", gateway: w.gateway, sandbox: (code, inputs) => runInSandbox(code, inputs), addEvent: async () => undefined, deadlineMs: Date.now() + 3_600_000, sleep: async () => undefined, redesignStages: redesignStagesOf(c.plan, FLAGS, true, { tiktok: "test" }) });
    const delivered = items.acceptedRows("comments_replies");
    for (const [id] of ids) expect(delivered.filter((r) => String(r.parent_id) === id), id).toHaveLength(shown(id));
    // a comment with 6 replies is read once (its page had 6 rows, under a full page); the understated one past its counter, to the source's end
    const six = [...ids.entries()].find(([, n]) => n === 6)![0];
    expect(w.replyCalls.get(six)).toBe(1);
    const understated = [...ids.entries()].find(([, n]) => n === 33)![0];
    expect(w.replyCalls.get(understated)!).toBeGreaterThanOrEqual(4);
  });
  it("a customer's own total of replies (the card edit) stays a limit: the stage is not lifted", () => {
    const c = compiled(request);
    const edited = { ...c.plan, stages: c.plan.stages.map((s) => (s.key === "comments_replies" ? { ...s, replies_uncapped: undefined } : s)) } as PricedPlan;
    expect(replies(withPromiseCaps(edited)).planned_rows).toBe(replies(edited).planned_rows);
  });
  it("the ceiling of the stage while it runs is the job's own limit (the price's maximum protects the customer), never the estimate", async () => {
    const c = compiled(request);
    const plan = withPromiseCaps(c.plan);
    expect(replies(plan).planned_rows).toBeGreaterThan(replies(c.plan).planned_rows);
    expect(replies(plan).planned_rows + plan.stages.filter((s) => s.replies_of === undefined).reduce((n, s) => n + s.planned_rows, 0)).toBeLessThanOrEqual(AGENT_MAX_DELIVERED_ROWS);
  });
  it("a customer's own number per comment is still honoured: three replies a comment gives three", async () => {
    const asked = request.replace("مع ردود", "مع ٣ ردود على كل تعليق");
    const c = compiled(asked);
    const commentRows = [exposurePage("call_0008", C1), exposurePage("call_0019", C2)];
    const chosen = (c.result.plan.stages[0].pinned_rows ?? []).map((r) => String(r.id));
    const w = world((_id) => 40, new Map(chosen.map((id, i) => [id, commentRows[i]])));
    const items = await ItemStore.open(w.store, "msn_c_test");
    await runEngine({ items, store: w.store, plan: withPromiseCaps(c.plan), missionId: "msn_c_test", gateway: w.gateway, sandbox: (code, inputs) => runInSandbox(code, inputs), addEvent: async () => undefined, deadlineMs: Date.now() + 3_600_000, sleep: async () => undefined, redesignStages: redesignStagesOf(c.plan, FLAGS, true, { tiktok: "test" }) });
    const delivered = items.acceptedRows("comments_replies");
    const perComment = new Map<string, number>();
    for (const r of delivered) perComment.set(String(r.parent_id), (perComment.get(String(r.parent_id)) ?? 0) + 1);
    expect(Math.max(...perComment.values())).toBeLessThanOrEqual(3);
  });
});
