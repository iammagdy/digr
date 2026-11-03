import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { createMemoryStore, newMission } from "../agent/src/memoryStore";
import { ItemStore } from "../agent/src/items/itemStore";
import { runEngine } from "../agent/src/engine/run";
import { runInSandbox } from "../agent/src/sandbox";
import { redesignStagesOf } from "../agent/src/redesign";
import { createGateway, estimateCallUsd, RAW_PATH, type Gateway } from "../agent/src/gateway";
import ExcelJS from "exceljs";
import { buildMissionFiles } from "../agent/src/workbook";
import { threadCounterLinesOfPlan } from "../agent/src/threadCounters";
import { createJobCallBudget } from "../src/lib/server/callBudget";
import { buildShapeDigest } from "../src/lib/modelPlanner/digest";
import { buildAsk } from "../src/lib/agentMission/foundation/ask";
import { chooseCard, compilePlan, parentInputs } from "../src/lib/agentMission/foundation/compilePlan";
import { cardOf, mapPage, CATALOG_ONLY_CAP_USD, CATALOG_ONLY_PRICE_MARGIN } from "../src/lib/agentMission/foundation/toolCards";
import { withPromiseCaps } from "../src/lib/agentMission/repliesCard";
import type { PricedPlan } from "../src/lib/agentMission/plan";
import type { RedesignFlags } from "../src/lib/agentMission/redesignFlags";
import { fakeRecorder, NOT_ADMIN, USER_ID } from "./helpers/agentHarness";
import { tregResult } from "./helpers/agentFakeWorld";

/**
 * ROUND 8 (3 Nov 2026): THE PAGEABLE ROUTE OF THE X REPLIES TOOL, FOR TEST ACCOUNTS ONLY. The first real replies pages (round 7, msn_9fa5ba384c05a25247e1) carried `nextCursor: null` and the provider's own words said the source that served them cannot page and
 * that the call should be re-run with `requireFields: ["nextCursor"]` to be served by a source that can. The owner approved trying it on TEST accounts only. This is what is tested here, and what is NOT:
 *   - TESTED (made-up pages in the real shape, plus the real anonymised 16-row and 4-row pages of round 7 with a next-page token written on them): the plan of a test account asks for `requireFields`; the catalog entry declares the input so the gateway keeps it; the engine follows `nextCursor`
 *     until it is null or the page cap is reached; the file says, per tweet, that the cap stopped the reading.
 *   - NOT TESTED (it needs a paid call, which this PR never makes): what the provider answers to `requireFields: ["nextCursor"]` — whether it serves the call, what it charges, and whether the token it returns continues the replies.
 */
const catalog = loadTregCatalog();
const M14 = "msn_b060d3347ed7660f972e";
const R7 = "msn_9fa5ba384c05a25247e1";
const AT = Date.parse("2026-11-03T07:13:38Z");
const REQUEST = "هات ٢٠ تغريدة على X فيها «العاصمة الإدارية» بالعربي في شهر أكتوبر ٢٠٢٦، مع الردود";
const REPLIES_ID = "anyapi.x.post.comments";
const read = (m: string, rel: string) => JSON.parse(readFileSync(new URL(`./fixtures/live/missions/${m}/${rel}.json`, import.meta.url), "utf8"));
const pool = read(M14, "raw/call_0003");
const searchCard = cardOf("anyapi.x.search.posts")!;
const repliesCard = cardOf(REPLIES_ID)!;
const capabilityOf = (id: string) => catalog.byId.get(id)?.capability ?? null;
const compile = (request: string, options: { catalogOnly?: boolean } = {}) => {
  const ask = buildAsk(request, null, AT);
  const r = compilePlan({ ask, pool: { card: searchCard, params: parentInputs(searchCard, ask), pages: [{ callId: "call_0001", page: pool }] }, exposure: () => undefined, capabilityOf, ...options });
  if (!r.ok) throw new Error(r.reason);
  return r;
};

describe("the plan of a TEST account asks the replies tool for a source that can page; no other account's plan changes", () => {
  it("a test account: the replies stage's engine params carry requireFields: [nextCursor], and nothing else", () => {
    const r = compile(REQUEST, { catalogOnly: true });
    const replies = r.plan.stages.find((s) => s.key === "replies")!;
    expect(replies.engine!.params).toEqual({ requireFields: ["nextCursor"] });
    expect(replies.engine!.cursor_param).toBe("cursor");
  });

  it("another account (round 8: the card is verified, so every account): the same replies stage with requireFields, the same plan as the test account's, no «not included» line", () => {
    const r = compile(REQUEST);
    expect(r.plan.stages.map((s) => s.key)).toEqual(["tweets", "replies"]);
    expect(r.plan.unserved_steps).toBeUndefined();
    expect(r.plan.stages.find((s) => s.key === "replies")!.engine!.params).toEqual({ requireFields: ["nextCursor"] });
    expect(JSON.stringify(r.plan)).toBe(JSON.stringify(compile(REQUEST, { catalogOnly: true }).plan));
    expect(chooseCard(buildAsk(REQUEST, null, AT), "replies", { catalogOnly: false })!.endpointId).toBe(REPLIES_ID);
  });

  it("the card is verified since the owner's live round 8 (tests/live-g-x-replies-verified.test.ts); the route still asks for a source that can page", () => {
    expect(repliesCard.status).toBe("verified");
    expect(repliesCard.verifiedOn).toHaveLength(1);
    expect(repliesCard.inputs.fixed).toEqual({ requireFields: ["nextCursor"] });
  });

  it("no other card sends fixed inputs (the TikTok and X search plans are what they were)", () => {
    const r = compile(REQUEST, { catalogOnly: true });
    expect(r.plan.stages.find((s) => s.key === "tweets")!.engine!.params).not.toHaveProperty("requireFields");
    const tiktok = buildAsk("هات فيديوهين تيك توك بالعربي عن الذكاء الاصطناعي من مصر، مع كل التعليقات والردود.", null, AT);
    const card = cardOf("tikhub.tiktok.search.videos")!;
    expect(JSON.stringify(parentInputs(card, tiktok))).not.toMatch(/requireFields/);
  });
});

describe("the catalog entry declares the input, so the gateway keeps it and the provider call carries it", () => {
  it("anyapi.x.post.comments has an optional array input requireFields; its price is the same", () => {
    const e = catalog.byId.get(REPLIES_ID)!;
    const input = e.inputs.find((i) => i.name === "requireFields");
    expect(input).toBeDefined();
    expect(input!.required).toBe(false);
    expect(input!.in).toBe("body");
    expect(input!.type).toBe("array");
    expect(e.cost?.usd).toBe(0.0005);
    expect(repliesCard.costUsdPerPage).toBe(e.cost?.usd);
    // the route's own other inputs are untouched
    expect(e.inputs.map((i) => i.name).sort()).toEqual(["cursor", "limit", "requireFields", "url"]);
  });

  it("through the gateway: the call that leaves for the provider keeps requireFields and may use it as an input", async () => {
    const store = createMemoryStore();
    const mission = newMission({ id: "msn_f", user_id: USER_ID, request_text: REQUEST, status: "executing" });
    store.missions.set(mission.id, mission);
    const { recorder, commit } = fakeRecorder({});
    const call = vi.fn(async () => tregResult({ output: { found: true, data: { items: [], nextCursor: null } } }, 0.0005));
    const client: any = { from: () => ({ insert: async () => ({ error: null }), update: () => ({ eq: async () => ({}) }), select: () => ({ eq: () => ({ gte: () => ({ lt: async () => ({ data: [], error: null }) }) }) }) }) };
    const gateway = createGateway({ store, client, missionId: mission.id, userId: USER_ID, jobId: "job_f", phase: "executing", access: NOT_ADMIN, catalog, budget: createJobCallBudget({ ceilingUsd: 1, spentUsd: 0 }), recorder, commit, call: call as any, defaultPurpose: REQUEST, counter: { seq: 0 } } as any);
    await gateway.tregCall({ endpoint_id: REPLIES_ID, params: { url: "https://x.com/i/status/1", requireFields: ["nextCursor"] } });
    expect(call).toHaveBeenCalledTimes(1);
    const sent = (call.mock.calls[0] as unknown as [{ params: Record<string, unknown>; allowedParamKeys: string[] }])[0];
    expect(sent.params).toEqual({ url: "https://x.com/i/status/1", requireFields: ["nextCursor"] });
    expect(sent.allowedParamKeys).toContain("requireFields");
    // the gateway's own estimate of the call is still the catalog's price (the budget check of every call)
    expect(estimateCallUsd(catalog.byId.get(REPLIES_ID)!, { url: "x", requireFields: ["nextCursor"] }, catalog)).toBe(0.0005);
  });
});

describe("the per-mission cap for catalog_only calls", () => {
  it("is at most 0.20 USD and is sized so that it holds even if a page costs twice the catalog's price", () => {
    expect(CATALOG_ONLY_CAP_USD).toBe(0.2);
    expect(CATALOG_ONLY_PRICE_MARGIN).toBe(2);
    const replies = compile(REQUEST, { catalogOnly: true }).plan.stages.find((s) => s.key === "replies")!;
    expect(replies.max_pages).toBe(Math.floor(CATALOG_ONLY_CAP_USD / (repliesCard.costUsdPerPage * CATALOG_ONLY_PRICE_MARGIN) + 1e-9));
    expect(replies.max_pages).toBe(200);
    // at the catalog's price the 200 pages cost 0.10 USD; at twice that price, 0.20 USD: never above the cap
    expect(replies.max_pages! * repliesCard.costUsdPerPage * CATALOG_ONLY_PRICE_MARGIN).toBeLessThanOrEqual(0.2 + 1e-9);
  });
});

/** A made-up page of the shape the route returns; `token` is its nextCursor (null: the last page). */
const pageOf = (items: Array<Record<string, any>>, token: string | null) => ({ output: { found: true, data: { items, nextCursor: token } } });
/** The real anonymised round-7 page, its ids made unique to one tweet (the engine keeps a reply id once), with a next-page token written on it. */
const realPage = (call: string, tweet: string, token: string | null) => {
  const page = structuredClone(read(R7, `raw/${call}`)) as { output: { data: { items: Array<Record<string, any>>; nextCursor: unknown } } };
  for (const it of page.output.data.items) it.id = `${it.id}_${tweet.slice(-6)}`;
  page.output.data.nextCursor = token;
  return page;
};

describe("the engine follows nextCursor until it is null or the cap is reached", () => {
  const TYPES_OFF = { social_posts: "off", social_account: "off", social_comments: "off", companies: "off", people: "off", places: "off" } as RedesignFlags;
  async function run(answer: (tweet: string, params: Record<string, unknown>, n: number) => unknown) {
    const r = compile(REQUEST, { catalogOnly: true });
    const store = createMemoryStore();
    const target = "msn_engine_f";
    let seq = 100;
    const replyCalls: Array<Record<string, unknown>> = [];
    const perTweet = new Map<string, number>();
    const gateway = {
      async tregCall(input: { endpoint_id?: unknown; params?: unknown }) {
        const endpointId = String(input.endpoint_id);
        const params = (input.params ?? {}) as Record<string, unknown>;
        seq += 1;
        const id = `call_${String(seq).padStart(4, "0")}`;
        let body: unknown;
        if (endpointId === "anyapi.x.search.posts") body = pool;
        else {
          replyCalls.push(params);
          const tweet = String(params.url).match(/\d{6,}/g)?.pop() ?? "1";
          perTweet.set(tweet, (perTweet.get(tweet) ?? 0) + 1);
          body = answer(tweet, params, perTweet.get(tweet)!);
        }
        await store.putFile(target, RAW_PATH(id), JSON.stringify(body), "application/json");
        const { reading } = buildShapeDigest(body, catalog.byId.get(endpointId)!);
        return { ok: true as const, call_id: id, http_status: 200, rows_in_page: reading.rows.length, has_more: reading.hasMore ?? null, next_cursor: reading.nextCursor ?? null, shape: null, first_rows: [], warnings: [], saved: id };
      },
    };
    const items = await ItemStore.open(store, target);
    const plan = r.plan;
    await runEngine({ items, store, plan: withPromiseCaps(plan), missionId: target, gateway: gateway as unknown as Gateway, sandbox: (code, inputs) => runInSandbox(code, inputs), addEvent: async () => undefined, deadlineMs: Date.now() + 3_600_000, sleep: async () => undefined, redesignStages: redesignStagesOf(plan, TYPES_OFF, true, { x: "test" }) });
    const counterOf = new Map(mapPage(searchCard, pool).map((t) => [String(t.id), Number(t.replies_count) || 0] as const));
    const withReplies = r.chosen.filter((id) => (counterOf.get(id) ?? 0) > 0);
    return { items, replyCalls, plan, withReplies, perTweet };
  }

  it("a two-page response (the first with a next-page token, the second with null) delivers BOTH pages for every tweet, and each call asks for requireFields", async () => {
    // page one: the real 16-row page of round 7 (the tweet whose counter was 23) with a token on it; page two: the real 4-row page, null token
    const { items, replyCalls, withReplies, perTweet } = await run((tweet, params) => (params.cursor === undefined ? realPage("call_0006", tweet, "tok_page_2") : realPage("call_0003", tweet, null)));
    expect(withReplies.length).toBeGreaterThan(0);
    for (const t of withReplies) expect(perTweet.get(t), t).toBe(2);
    expect(replyCalls).toHaveLength(withReplies.length * 2);
    // the second call of a tweet carries the token the first page gave, the first carries none
    expect(replyCalls.filter((c) => c.cursor === undefined)).toHaveLength(withReplies.length);
    expect(replyCalls.filter((c) => c.cursor === "tok_page_2")).toHaveLength(withReplies.length);
    for (const c of replyCalls) expect(c.requireFields).toEqual(["nextCursor"]);
    const delivered = items.acceptedRows("replies");
    expect(delivered.length).toBe(withReplies.length * 20);
    expect(new Set(delivered.map((r) => String(r.parent_id)))).toEqual(new Set(withReplies));
  });

  it("a page whose nextCursor is null stops the read: one call for the tweet, nothing asked after it", async () => {
    const { replyCalls, withReplies, items } = await run((tweet) => realPage("call_0006", tweet, null));
    expect(replyCalls).toHaveLength(withReplies.length);
    for (const c of replyCalls) { expect(c.cursor).toBeUndefined(); expect(c.requireFields).toEqual(["nextCursor"]); }
    expect(items.acceptedRows("replies").length).toBe(withReplies.length * 16);
  });

  it("a source that never ends (two rows a page, so the job's row limit is not what stops it) is read for at most the cap (200 pages, 0.10 USD at the catalog's price), then the stage stops with the page limit as its recorded reason", async () => {
    const { items, replyCalls, plan } = await run((tweet, params) => pageOf(Array.from({ length: 2 }, (_, i) => ({ id: `${tweet}_${String(params.cursor ?? "c0")}_${i}`, authorHandle: `h${i}`, authorName: `n${i}`, createdUtc: 1790000000 + i, likeCount: 0, replyCount: 0, repostCount: 0, viewCount: 1, text: `رد ${i}`, url: `https://x.com/i/web/status/${i}` })), `${String(params.cursor ?? "c0")}x`));
    const max = plan.stages.find((s) => s.key === "replies")!.max_pages!;
    expect(max).toBe(200);
    expect(replyCalls.length).toBe(max);
    expect(items.counts("replies").pages).toBe(max);
    expect(items.stopReason("replies")).toBe("page_limit");
    expect(replyCalls.length * repliesCard.costUsdPerPage * CATALOG_ONLY_PRICE_MARGIN).toBeLessThanOrEqual(CATALOG_ONLY_CAP_USD + 1e-9);
  });
});

describe("the file says, per tweet, that the cap stopped the reading", () => {
  const nounsOf = (title: string | undefined): string | null => (/تغريد/.test(title ?? "") ? "تغريدة" : /رد/.test(title ?? "") ? "رد" : null);
  function shape() {
    const r = compile(REQUEST, { catalogOnly: true });
    const chosen = mapPage(searchCard, pool).filter((t) => r.chosen.includes(String(t.id)));
    const tweets = chosen.slice(0, 20).map((t, i): Record<string, any> => ({ ...t, replies_count: [23, 5, 3, 1, 1][i] ?? 0 }));
    const replies = tweets.flatMap((t, i) => Array.from({ length: [16, 4, 1, 2, 2][i] ?? 0 }, (_, k) => ({ id: `r_${i}_${k}`, parent_id: String(t.id), text: "x" })));
    return { plan: r.plan as PricedPlan, tweets, replies };
  }

  it("the replies stage stopped at the page limit: each short tweet's line says the cap stopped the reading, not that the source gave no more", () => {
    const { plan, tweets, replies } = shape();
    const { limitLines } = threadCounterLinesOfPlan(plan, { tweets, replies }, nounsOf, { replies: "page_limit" });
    expect(limitLines).toHaveLength(3);
    for (const l of limitLines) {
      expect(l).toMatch(/الحد الأقصى لعدد الصفحات/);
      expect(l).not.toMatch(/والفرق لم يعطِه المصدر/);
    }
    expect(limitLines[0]).toMatch(/^التغريدة رقم ١: ردودها بحسب عدّاد المنصة ٢٣ ردًا وسُلّم منها ١٦ ردًا؛ /);
  });

  it("the stage ended on its own (the source had no more): the line is exactly what it was", () => {
    const { plan, tweets, replies } = shape();
    const before = threadCounterLinesOfPlan(plan, { tweets, replies }, nounsOf);
    for (const stop of [{ replies: "source_exhausted" }, { replies: null }, {}] as const) {
      expect(threadCounterLinesOfPlan(plan, { tweets, replies }, nounsOf, stop as never)).toEqual(before);
    }
    expect(before.limitLines[0]).toBe("التغريدة رقم ١: ردودها بحسب عدّاد المنصة ٢٣ ردًا وسُلّم منها ١٦ ردًا؛ والفرق لم يعطِه المصدر");
  });

  it("a tweet that met its counter gets no line even when the stage hit the cap", () => {
    const { plan, tweets } = shape();
    const met = tweets.map((t, i): Record<string, any> => ({ ...t, replies_count: i === 0 ? 1 : 0 }));
    const replies = [{ id: "m_0", parent_id: String(met[0].id), text: "x" }];
    expect(threadCounterLinesOfPlan(plan, { tweets: met, replies }, nounsOf, { replies: "page_limit" }).limitLines).toEqual([]);
  });

  it("through the file: the stage's recorded stop (page_limit) reaches «حدود هذا التسليم», and a stage that ended on its own keeps the old line", async () => {
    const { plan, tweets, replies } = shape();
    const rec = (stop: string) => ({ found: 25, duplicates: 0, accepted: 25, excluded: 0, pending: 0, unchecked: 0, acceptedByRule: 25, acceptedByModel: 0, excludedByReason: {}, stop });
    const lines = async (stop: string): Promise<string[]> => {
      const built = await buildMissionFiles(plan, { tweets, replies } as never, { stages: { tweets: rec("target_reached"), replies: rec(stop) } } as never);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(built.xlsx as unknown as ArrayBuffer);
      const out: string[] = [];
      wb.eachSheet((ws) => ws.eachRow((row) => row.eachCell((c) => { const v = c.value; out.push(v === null || v === undefined ? "" : typeof v === "object" && "text" in v ? String((v as { text: unknown }).text) : String(v)); })));
      return out.flatMap((t) => t.split("\n")).filter((l) => /^التغريدة رقم ١: ردودها بحسب عدّاد المنصة ٢٣/.test(l) && /؛ /.test(l));
    };
    const capped = await lines("page_limit");
    expect(capped.some((l) => /الحد الأقصى لعدد الصفحات المسموح لهذه المهمة/.test(l))).toBe(true);
    const natural = await lines("source_exhausted");
    expect(natural.some((l) => l.endsWith("والفرق لم يعطِه المصدر"))).toBe(true);
    expect(natural.some((l) => /الحد الأقصى لعدد الصفحات/.test(l))).toBe(false);
  });
});
