import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { createMemoryStore } from "../agent/src/memoryStore";
import { ItemStore } from "../agent/src/items/itemStore";
import { runEngine } from "../agent/src/engine/run";
import { runInSandbox } from "../agent/src/sandbox";
import { redesignStagesOf } from "../agent/src/redesign";
import { RAW_PATH, type Gateway } from "../agent/src/gateway";
import { buildShapeDigest } from "../src/lib/modelPlanner/digest";
import { buildAsk } from "../src/lib/agentMission/foundation/ask";
import { chooseCard, compilePlan, parentInputs } from "../src/lib/agentMission/foundation/compilePlan";
import { cardOf, cardsFor, mapPage, CATALOG_ONLY_CAP_USD, CATALOG_ONLY_PRICE_MARGIN } from "../src/lib/agentMission/foundation/toolCards";
import { checkCardOnPage } from "../src/lib/agentMission/foundation/toolCards/verify";
import { withPromiseCaps } from "../src/lib/agentMission/repliesCard";
import type { RedesignFlags } from "../src/lib/agentMission/redesignFlags";

/**
 * LIVE ROUND 8 (3 Nov 2026, msn_50e3b83c44e7ebd7f577, test account, X = test, Heroku on 14a2fd4): the first run of the X replies tool WITH `requireFields: ["nextCursor"]` (PR #354).
 * The delivered file: 20 original tweets, 31 replies, «٥١ من ٥٤»; 23 → 19, 5 → 4, 3 → 2, 1 → 2 (three tweets). The 14 replies calls (read-only SELECT on mission_calls) cost 0.00054 USD each, 0.00756 USD in all.
 *
 * WHAT THE REAL PAGES SAY (the pages are the owner's admin raw-pages ZIP of that mission, anonymised with tests/fixtures/live/anonymise.py: ids, `conversationId`, counters, dates and cursors are real, texts and handles are placeholders):
 *   - EVERY page that has rows carries a non-null `output.data.nextCursor` (in round 7, before the flag, every page had null), and the call that followed it asked for exactly that token (the call index: the `cursor` input of the next call);
 *   - each tweet's chain ends on an EMPTY page whose `nextCursor` is null: that is the source's own end, not our stop;
 *   - the tweet whose counter is 23 gave 16, then 3 (19, up from 16 in round 7); another gave 1, then 1.
 * So the route pages, the page shape is the card's, and the card is VERIFIED on these pages. Not proven here: any page beyond these 14 (a tweet with more than two data pages).
 */
const catalog = loadTregCatalog();
void catalog;
const M8 = "msn_50e3b83c44e7ebd7f577";
const M14 = "msn_b060d3347ed7660f972e";
const AT = Date.parse("2026-11-03T10:18:35Z");
const REQUEST = "هات ٢٠ تغريدة على X فيها «العاصمة الإدارية» بالعربي في شهر أكتوبر ٢٠٢٦، مع الردود";
const REPLIES_ID = "anyapi.x.post.comments";
const read = (m: string, rel: string) => JSON.parse(readFileSync(new URL(`./fixtures/live/missions/${m}/${rel}.json`, import.meta.url), "utf8"));
const index = JSON.parse(readFileSync(new URL("./fixtures/live/call-index.json", import.meta.url), "utf8")) as { missions: Record<string, Array<[string, string, string, string, number, Record<string, unknown>]>> };
const CALLS = Array.from({ length: 14 }, (_, i) => `call_${String(i + 3).padStart(4, "0")}`);
type Page = { output: { found: boolean; data: { items: Array<Record<string, any>>; nextCursor: string | null } } };
const pages = CALLS.map((call) => ({ call, page: read(M8, `raw/${call}`) as Page, log: index.missions[M8]!.find((c) => c[0] === call)! }));
const card = cardOf(REPLIES_ID)!;
const pool = read(M14, "raw/call_0003");
const searchCard = cardOf("anyapi.x.search.posts")!;
const capabilityOf = (id: string) => catalog.byId.get(id)?.capability ?? null;
const compile = (options: { catalogOnly?: boolean } = {}, poolPage: unknown = pool) => {
  const ask = buildAsk(REQUEST, null, AT);
  const r = compilePlan({ ask, pool: { card: searchCard, params: parentInputs(searchCard, ask), pages: [{ callId: "call_0001", page: poolPage }] }, exposure: () => undefined, capabilityOf, ...options });
  if (!r.ok) throw new Error(r.reason);
  return r;
};

describe("round 8: the real replies pages of the pageable route", () => {
  it("14 pages, six tweets, each page's call is in the call index as the replies tool with requireFields", () => {
    expect(pages).toHaveLength(14);
    expect(new Set(pages.map((p) => p.page.output.data.items[0]?.conversationId ?? "")).size).toBe(6 + 1);
    for (const p of pages) {
      expect(p.log[2]).toBe(REPLIES_ID);
      expect(p.log[5].requireFields).toEqual(["nextCursor"]);
      expect(p.page.output.data.items.length).toBe(p.log[4]);
    }
  });

  it("every page with rows carries a next-page token, and the call after it asked for exactly that token (the token was followed)", () => {
    for (let i = 0; i < pages.length; i++) {
      const { page, log } = pages[i];
      if (page.output.data.items.length > 0) {
        expect(typeof page.output.data.nextCursor, log[0]).toBe("string");
        const next = pages[i + 1];
        expect(next, `a page after ${log[0]}`).toBeDefined();
        expect(next.log[5].cursor, `the call after ${log[0]}`).toBe(page.output.data.nextCursor);
      }
    }
    // the first call of a tweet carries no cursor
    expect(pages.filter((p) => p.log[5].cursor === undefined)).toHaveLength(6);
  });

  it("each tweet's chain ends on an EMPTY page whose token is null: the source's own end", () => {
    const empties = pages.filter((p) => p.page.output.data.items.length === 0);
    expect(empties).toHaveLength(6);
    for (const e of empties) { expect(e.page.output.data.nextCursor).toBeNull(); expect(e.log[3]).toBe("empty"); }
    // and the tweets that gave more than one page with rows: the counter-23 tweet (16 then 3) and another (1 then 1)
    const multi = pages.filter((p) => p.log[5].cursor !== undefined && p.page.output.data.items.length > 0);
    expect(multi.map((p) => p.page.output.data.items.length).sort()).toEqual([1, 3]);
  });

  it("the delivered rows are exactly the pages' rows, under their tweets; counters against delivered: 5→4, 1→2, 1→2, 23→19, 1→2, 3→2", () => {
    const delivered = read(M8, "rows/replies") as Array<Record<string, any>>;
    const tweets = read(M8, "rows/tweets") as Array<Record<string, any>>;
    expect(delivered).toHaveLength(31);
    const byConv = new Map<string, string[]>();
    for (const p of pages) for (const i of p.page.output.data.items) byConv.set(String(i.conversationId), [...(byConv.get(String(i.conversationId)) ?? []), String(i.id)]);
    expect(byConv.size).toBe(6);
    for (const [parent, ids] of byConv) expect(delivered.filter((r) => String(r.parent_id) === parent).map((r) => String(r.id)).sort(), parent).toEqual([...ids].sort());
    const gap = [...byConv].map(([parent, ids]) => [Number(tweets.find((t) => String(t.id) === parent)!.replies_count), ids.length]).sort((a, b) => b[0] - a[0]);
    expect(gap).toEqual([[23, 19], [5, 4], [3, 2], [1, 2], [1, 2], [1, 2]]);
  });
});

describe("the X replies card is VERIFIED on those pages, for every account", () => {
  it("status verified, verifiedOn is the 14 calls of the round-8 mission, requireFields stays on the route, the price is still the catalog's", () => {
    expect(card.status).toBe("verified");
    expect(card.verifiedOn).toEqual([{ mission: M8, calls: CALLS }]);
    expect(card.inputs.fixed).toEqual({ requireFields: ["nextCursor"] });
    expect(card.costUsdPerPage).toBe(0.0005);
    expect(card.inputs.parent).toEqual({ param: "url", from: "link" });
    expect(card.counter).toBeNull();
  });

  it("the card maps every one of the 14 real pages (one row per item, an id each, the next-page field present)", () => {
    for (const { call, page, log } of pages) {
      const check = checkCardOnPage(card, page);
      expect(check.issues, call).toEqual([]);
      expect(check.rows.length).toBe(log[4]);
    }
    expect(mapPage(card, pages[6].page)).toHaveLength(16);
  });

  it("the compiler offers it to any account: no catalogOnly needed, and it is the replies card of X", () => {
    expect(cardsFor("x", "tweet.replies").map((c) => c.endpointId)).toEqual([REPLIES_ID]);
    expect(chooseCard(buildAsk(REQUEST, null, AT), "replies")!.endpointId).toBe(REPLIES_ID);
    expect(chooseCard(buildAsk(REQUEST, null, AT), "replies", { catalogOnly: false })!.endpointId).toBe(REPLIES_ID);
  });

  it("an account that is NOT a test account gets the replies step: tweets, then the replies stage with requireFields and the page cap, and no «not included» line", () => {
    const r = compile();
    expect(r.plan.stages.map((s) => s.key)).toEqual(["tweets", "replies"]);
    expect(r.plan.unserved_steps).toBeUndefined();
    const replies = r.plan.stages.find((s) => s.key === "replies")!;
    expect(replies.endpoint_id).toBe(REPLIES_ID);
    expect(replies.engine!.params).toEqual({ requireFields: ["nextCursor"] });
    expect(replies.max_pages).toBe(Math.floor(CATALOG_ONLY_CAP_USD / (card.costUsdPerPage * CATALOG_ONLY_PRICE_MARGIN) + 1e-9));
    expect(replies.max_pages).toBe(200);
    // the same plan a test account gets
    expect(JSON.stringify(compile().plan)).toBe(JSON.stringify(compile({ catalogOnly: true }).plan));
  });
});

describe("the engine reads the REAL chains for a non-test account: every page, the token followed, the empty page ends each tweet", () => {
  const TYPES_OFF = { social_posts: "off", social_account: "off", social_comments: "off", companies: "off", people: "off", places: "off" } as RedesignFlags;
  it("the chains of the real pages are served by tweet (in the order the tweets are read) and the file's replies are all the rows of those pages", async () => {
    // the pool's tweets that have replies say 99 (the engine stops a tweet early when the replies read reach the tweet's own counter, which is right for a real tweet but would stop a real chain served to a tweet with a different counter): only the source's own end stops a chain here
    const busy = structuredClone(pool) as { output: { data: { items: Array<Record<string, any>> } } };
    for (const t of busy.output.data.items) if (Number(t.replyCount) > 0) t.replyCount = 99;
    const r = compile({}, busy);
    const store = createMemoryStore();
    const target = "msn_engine_g";
    // the real chains, by the call number of their first page
    const chains = [[3, 4], [5, 6], [7, 8], [9, 10, 11], [12, 13, 14], [15, 16]].map((c) => c.map((n) => pages[n - 3].page));
    const order: string[] = [];
    const calls: Array<Record<string, unknown>> = [];
    let seq = 100;
    const gateway = {
      async tregCall(input: { endpoint_id?: unknown; params?: unknown }) {
        const endpointId = String(input.endpoint_id);
        const params = (input.params ?? {}) as Record<string, unknown>;
        seq += 1;
        const id = `call_${String(seq).padStart(4, "0")}`;
        let body: unknown;
        if (endpointId === "anyapi.x.search.posts") body = busy;
        else {
          calls.push(params);
          const tweet = String(params.url).match(/\d{6,}/g)?.pop() ?? "1";
          if (!order.includes(tweet)) order.push(tweet);
          const k = order.indexOf(tweet);
          // the pool has more tweets with replies than the six of the live run: the six real chains are served round-robin, the reply ids made unique to the tweet (the tokens are opaque and stay)
          const chain = chains[k % 6].map((p) => (k < 6 ? p : { output: { ...p.output, data: { ...p.output.data, items: p.output.data.items.map((i) => ({ ...i, id: `${i.id}_${k}` })) } } }));
          // the next page of a chain is the one whose token the previous page gave
          const at = params.cursor === undefined ? 0 : chain.findIndex((p) => p.output.data.nextCursor === params.cursor) + 1;
          body = chain[at];
        }
        await store.putFile(target, RAW_PATH(id), JSON.stringify(body), "application/json");
        const { reading } = buildShapeDigest(body, catalog.byId.get(endpointId)!);
        return { ok: true as const, call_id: id, http_status: 200, rows_in_page: reading.rows.length, has_more: reading.hasMore ?? null, next_cursor: reading.nextCursor ?? null, shape: null, first_rows: [], warnings: [], saved: id };
      },
    };
    const items = await ItemStore.open(store, target);
    const plan = r.plan;
    await runEngine({ items, store, plan: withPromiseCaps(plan), missionId: target, gateway: gateway as unknown as Gateway, sandbox: (code, inputs) => runInSandbox(code, inputs), addEvent: async () => undefined, deadlineMs: Date.now() + 3_600_000, sleep: async () => undefined, redesignStages: redesignStagesOf(plan, TYPES_OFF, true, { x: "test" }) });
    expect(order.length).toBeGreaterThan(0);
    const served = order.map((_, k) => chains[k % 6]);
    for (const c of calls) expect(c.requireFields).toEqual(["nextCursor"]);
    const wanted = served.flat().reduce((n, p) => n + p.output.data.items.length, 0);
    expect(items.acceptedRows("replies")).toHaveLength(wanted);
    // every tweet read to the source's own end: the calls are exactly the pages of the chains read
    expect(calls).toHaveLength(served.reduce((n, c) => n + c.length, 0));
    expect(items.stopReason("replies")).not.toBe("page_limit");
  });
});
