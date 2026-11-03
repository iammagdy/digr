import { readFileSync } from "node:fs";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { createMemoryStore } from "../agent/src/memoryStore";
import { ItemStore } from "../agent/src/items/itemStore";
import { runEngine } from "../agent/src/engine/run";
import { runInSandbox } from "../agent/src/sandbox";
import { redesignStagesOf } from "../agent/src/redesign";
import { planByCompiler } from "../agent/src/compiled";
import { RAW_PATH, type Gateway } from "../agent/src/gateway";
import { buildMissionFiles } from "../agent/src/workbook";
import { buildShapeDigest } from "../src/lib/modelPlanner/digest";
import { buildAsk } from "../src/lib/agentMission/foundation/ask";
import { chooseCard, compilePlan, parentInputs } from "../src/lib/agentMission/foundation/compilePlan";
import { rankPool } from "../src/lib/agentMission/foundation/pool";
import { cardOf, mapPage, CATALOG_ONLY_CAP_USD, CATALOG_ONLY_PRICE_MARGIN } from "../src/lib/agentMission/foundation/toolCards";
import { customerPlanView, type PricedPlan } from "../src/lib/agentMission/plan";
import { withPromiseCaps } from "../src/lib/agentMission/repliesCard";
import { checkCustomerText } from "../src/lib/agentMission/text";
import type { RedesignFlags } from "../src/lib/agentMission/redesignFlags";

/**
 * LIVE FINDING D5 (3 Nov 2026, msn_e7612c1fe8697ca03439: «هات ٢٠ تغريدة على X فيها «العاصمة الإدارية» بالعربي في شهر أكتوبر ٢٠٢٦، مع الردود»).
 * The stage asked the source for tweets with no word about replies, so 10 of the 20 chosen tweets were themselves replies to other people, and the replies step was «لم يُنفَّذ: لا توجد بعد أداة موثّقة».
 *   - When the customer asks for tweets WITH their replies, the parents must be original tweets: the stage requests originals only (the query's `-filter:replies`, as the old path did for «دون الردود»);
 *     a tweet that is itself a reply is ranked below the originals in the pool (ranking, never a drop) and keeps its «رد أم أصلي» mark.
 *   - The replies are a child stage on those tweets. Owner decision 7.4: a `catalog_only` card is allowed for TEST accounts only, capped (round 8: 0.20 USD at twice the catalog price) of such calls a mission; every other
 *     account keeps the honest «not included» line.
 *
 * THE DATA. The pool page is the REAL anonymised page of the same search (M14, call_0003: 20 tweets, about half of them replies: `isReply`, counters, dates, languages are real). The replies tool has NO real stored page
 * (that is what «catalog_only» means): its pages in the engine test are MADE UP in the shape the catalog documents for it (`item_fields`, `list_path`), and its cursor field name is the one the catalog's input note
 * names; none of it was seen on a real response. NOT PROVEN until the first live run captures a real page.
 */
const catalog = loadTregCatalog();
const M14 = "msn_b060d3347ed7660f972e";
const AT = Date.parse("2026-11-03T07:13:38Z");
const REQUEST = "هات ٢٠ تغريدة على X فيها «العاصمة الإدارية» بالعربي في شهر أكتوبر ٢٠٢٦، مع الردود";
const REQUEST_NO_REPLIES = "هات ٢٠ تغريدة على X فيها «العاصمة الإدارية» بالعربي في شهر أكتوبر ٢٠٢٦";
const page = JSON.parse(readFileSync(new URL(`./fixtures/live/missions/${M14}/raw/call_0003.json`, import.meta.url), "utf8")) as { output: { data: { items: Array<{ id: string; isReply: boolean; replyCount: number }> } } };
const searchCard = cardOf("anyapi.x.search.posts")!;
const repliesCardOf = () => cardOf("anyapi.x.post.comments");
const capabilityOf = (id: string) => catalog.byId.get(id)?.capability ?? null;
const compile = (request: string, options: { catalogOnly?: boolean } = {}) => {
  const ask = buildAsk(request, null, AT);
  return compilePlan({ ask, pool: { card: searchCard, params: parentInputs(searchCard, ask), pages: [{ callId: "call_0001", page }] }, exposure: () => undefined, capabilityOf, ...options });
};

describe("D5: the real pool page has replies among its tweets (the evidence)", () => {
  it("about half of the 20 real tweets of the stored search are themselves replies", () => {
    const items = page.output.data.items;
    expect(items).toHaveLength(20);
    expect(items.filter((t) => t.isReply).length).toBeGreaterThanOrEqual(8);
  });
});

describe("D5: tweets with their replies are requested as ORIGINALS ONLY", () => {
  it("the query carries -filter:replies when the customer asked for the replies", () => {
    const ask = buildAsk(REQUEST, null, AT);
    expect(ask.replies).not.toBe("none");
    expect(parentInputs(searchCard, ask)).toEqual({ query: "\"العاصمة الإدارية\" lang:ar since:2026-09-30_21:00:00_UTC until:2026-10-31_22:00:00_UTC -filter:replies", queryType: "Latest", limit: 20 });
  });
  it("no replies asked: the query is exactly what it was (a tweet that is a reply is a row with a mark, nothing is excluded)", () => {
    const ask = buildAsk(REQUEST_NO_REPLIES, null, AT);
    expect(ask.replies).toBe("none");
    expect(parentInputs(searchCard, ask).query).not.toMatch(/filter:replies/);
  });
  it("TikTok is untouched (its search has no operators)", () => {
    const tt = buildAsk("هات فيديوهين تيك توك بالعربي عن الذكاء الاصطناعي من مصر، مع كل التعليقات والردود.", null, AT);
    expect(JSON.stringify(parentInputs(cardOf("tikhub.tiktok.search.videos")!, tt))).not.toMatch(/filter:replies/);
  });
  it("when the source still gives a reply, it is ranked below every original (never dropped) and keeps its mark", () => {
    const ask = buildAsk(REQUEST, null, AT);
    const rows = mapPage(searchCard, page);
    const ranked = rankPool(rows, ask, searchCard);
    expect(ranked).toHaveLength(rows.length);
    const firstReply = ranked.findIndex((r) => r.is_reply === true);
    expect(firstReply).toBeGreaterThan(0);
    expect(ranked.slice(0, firstReply).every((r) => r.is_reply !== true)).toBe(true);
    expect(ranked.slice(firstReply).every((r) => r.is_reply === true)).toBe(true);
    // asked for tweets only (no replies): the order is what it was, replies and originals alike
    const plain = rankPool(rows, buildAsk(REQUEST_NO_REPLIES, null, AT), searchCard);
    expect(plain.map((r) => r.id)).not.toEqual(ranked.map((r) => r.id));
  });
});

describe("D5: the X replies card is catalog_only, for test accounts only, within 0.10 USD of such calls", () => {
  it("the card is in the catalog's own terms (data/treg/treg_catalog_sellable.json) and is NOT verified", () => {
    const c = repliesCardOf()!;
    expect(c).not.toBeNull();
    expect(c.status).toBe("catalog_only");
    expect(c.verifiedOn).toEqual([]);
    const e = catalog.byId.get(c.endpointId)!;
    expect(e.capability).toBe("x.post.comments");
    expect(c.costUsdPerPage).toBe(e.cost?.usd);
    expect(c.inputs.parent).toEqual({ param: "url", from: "link" });
    expect(CATALOG_ONLY_CAP_USD).toBe(0.2);
    expect(CATALOG_ONLY_PRICE_MARGIN).toBe(2);
  });
  it("another account never gets it: chooseCard returns no X replies card unless the caller allows catalog_only cards", () => {
    const ask = buildAsk(REQUEST, null, AT);
    expect(chooseCard(ask, "replies")).toBeNull();
    expect(chooseCard(ask, "replies", { catalogOnly: false })).toBeNull();
    expect(chooseCard(ask, "replies", { catalogOnly: true })!.endpointId).toBe("anyapi.x.post.comments");
  });

  it("NOT a test account: the plan is the tweets only and the honest «not included» line, word for word as before", () => {
    const r = compile(REQUEST);
    if (!r.ok) throw new Error(r.reason);
    expect(r.plan.stages.map((s) => s.key)).toEqual(["tweets"]);
    expect(r.plan.unserved_steps).toEqual([{ what_ar: "الردود", reason_ar: "لا توجد بعد أداة موثّقة لقراءة الردود على هذه المنصة، فلن تُضاف هذه الخطوة." }]);
    expect(r.plan.stages[0].engine!.params.query).toMatch(/-filter:replies/);
  });

  it("a TEST account: tweets, then the replies as a child stage on those tweets, read by that card, no «not included» line", () => {
    const r = compile(REQUEST, { catalogOnly: true });
    if (!r.ok) throw new Error(r.reason);
    expect(r.plan.stages.map((s) => s.key)).toEqual(["tweets", "replies"]);
    expect(r.plan.unserved_steps).toBeUndefined();
    const [tweets, replies] = r.plan.stages;
    expect(replies.endpoint_id).toBe("anyapi.x.post.comments");
    expect(replies.parent_key).toBe("tweets");
    expect(replies.replies_of).toBe("tweets");
    expect(replies.engine!.parent_binding).toEqual({ param: "url", from: "link" });
    expect(replies.engine!.built_by).toBe("code");
    expect(replies.deliver).toBe(true);
    expect(replies.columns.map((c) => c.title_ar)).toContain("لغة النص");
    // the promise: the platform counters of the chosen tweets (what the pool page says), typed «open» (an estimate is never a promise), exactly their sum
    const chosen = new Set(r.chosen);
    const counters = mapPage(searchCard, page).filter((t) => chosen.has(String(t.id))).reduce((n, t) => n + (Number(t.replies_count) || 0), 0);
    expect(counters).toBeGreaterThan(0);
    expect(r.promises.replies).toMatchObject({ type: "open", n: counters, counted: counters, counted_comments: 20 });
    expect(tweets.planned_rows).toBe(20);
    // the hold: the replies are priced as rows (each read costs the catalog's price of one call)
    expect(r.plan.price.deliveredRows).toBe(20 + counters);
  });

  it("the cap: the replies stage may read at most as many pages as 0.20 USD of catalog_only calls buys at twice the catalog price (round 8; 0.10 USD at the catalog price)", () => {
    const r = compile(REQUEST, { catalogOnly: true });
    if (!r.ok) throw new Error(r.reason);
    const replies = r.plan.stages.find((s) => s.key === "replies")!;
    const card = repliesCardOf()!;
    expect(replies.max_pages).toBe(Math.floor(CATALOG_ONLY_CAP_USD / (card.costUsdPerPage * CATALOG_ONLY_PRICE_MARGIN)));
    expect(replies.max_pages! * card.costUsdPerPage * CATALOG_ONLY_PRICE_MARGIN).toBeLessThanOrEqual(CATALOG_ONLY_CAP_USD + 1e-9);
  });

  it("no chosen tweet says it has a reply: no replies stage is built, and the card says so before approval", () => {
    const flat = JSON.parse(JSON.stringify(page)) as typeof page;
    for (const t of flat.output.data.items) t.replyCount = 0;
    const ask = buildAsk(REQUEST, null, AT);
    const r = compilePlan({ ask, pool: { card: searchCard, params: parentInputs(searchCard, ask), pages: [{ callId: "call_0001", page: flat }] }, exposure: () => undefined, capabilityOf, catalogOnly: true });
    if (!r.ok) throw new Error(r.reason);
    expect(r.plan.stages.map((s) => s.key)).toEqual(["tweets"]);
    expect(r.plan.unserved_steps?.map((u) => u.what_ar)).toEqual(["الردود"]);
    expect(r.plan.unserved_steps![0].reason_ar).toMatch(/عدّاد المنصة/);
  });

  it("the customer's card: Arabic only, Arabic-Indic digits, no provider, no endpoint, no USD, and it says the replies come in addition", () => {
    const r = compile(REQUEST, { catalogOnly: true });
    if (!r.ok) throw new Error(r.reason);
    const view = customerPlanView(r.plan);
    const lines = [view.summary_ar, ...(view.notes_ar ?? [])];
    for (const l of lines) { expect(checkCustomerText(l, { maxChars: 600 }).issues, l).toEqual([]); expect(l).not.toMatch(/[0-9]|anyapi|justone|usd|\$/i); }
    expect(view.summary_ar).toMatch(/مع ردودها/);
    // (the pool page's captions are the anonymiser's placeholders, so a topic note may be among the notes: it says «تغريدة», never «فيديو»)
    const notes = (view.notes_ar ?? []).join("\n");
    expect(notes).toMatch(/الردود على التغريدات المختارة/);
    expect(notes).not.toMatch(/التعليقات|فيديو/);
    expect(JSON.stringify(view)).not.toMatch(/anyapi|justoneapi|tikhub|usd/i);
  });
});

describe("D5: the compiled path hands the account's test status to the compiler", () => {
  it("planByCompiler with catalogOnly builds the replies stage from a real-shaped pool page; without it, never", async () => {
    const mk = () => {
      const store = createMemoryStore();
      let n = 0;
      const gateway = { async tregCall(input: { endpoint_id?: unknown }) { n += 1; const id = `call_${String(n).padStart(4, "0")}`; await store.putFile("msn_x", RAW_PATH(id), JSON.stringify(page), "application/json"); const { reading } = buildShapeDigest(page, catalog.byId.get(String(input.endpoint_id))!); return { ok: true as const, call_id: id, http_status: 200, rows_in_page: reading.rows.length, has_more: null, next_cursor: null }; } };
      return { store, gateway };
    };
    const a = mk();
    const withCard = await planByCompiler({ mission: { id: "msn_x", request_text: REQUEST, answer_text: null, created_at: "2026-11-03T07:13:38Z" }, gateway: a.gateway as never, store: a.store, catalog, nowMs: AT, catalogOnly: true });
    if (withCard.kind !== "plan") throw new Error(withCard.kind);
    expect(withCard.plan.stages.map((s) => s.key)).toEqual(["tweets", "replies"]);
    const b = mk();
    const without = await planByCompiler({ mission: { id: "msn_x", request_text: REQUEST, answer_text: null, created_at: "2026-11-03T07:13:38Z" }, gateway: b.gateway as never, store: b.store, catalog, nowMs: AT });
    if (without.kind !== "plan") throw new Error(without.kind);
    expect(without.plan.stages.map((s) => s.key)).toEqual(["tweets"]);
  });
});

/** A made-up replies page in the shape the catalog documents (item_fields, list_path output.data.items); the cursor name is the catalog's input note's «nextCursor». NOT a real response. */
const repliesPageOf = (tweetId: string, n: number, from: number, more: boolean) => ({ output: { found: true, data: { items: Array.from({ length: n }, (_, i) => ({ id: `9${tweetId.slice(-6)}${String(from + i).padStart(4, "0")}`, authorHandle: `h_${from + i}`, authorName: `n_${from + i}`, createdUtc: 1790000000 + from + i, likeCount: i, replyCount: 0, repostCount: 0, quoteCount: 0, viewCount: 10, media: [], text: `رد ${from + i}`, url: `https://x.com/i/web/status/9${from + i}` })), ...(more ? { nextCursor: `c${from + n}` } : {}) } } });

describe("D5: the engine reads the replies of the chosen tweets, only those that have some, within the cap", () => {
  const TYPES_OFF = { social_posts: "off", social_account: "off", social_comments: "off", companies: "off", people: "off", places: "off" } as RedesignFlags;
  async function run(opts: { endless: boolean }) {
    const r = compile(REQUEST, { catalogOnly: true });
    if (!r.ok) throw new Error(r.reason);
    const store = createMemoryStore();
    const target = "msn_engine_x";
    let seq = 100;
    const replyCalls: Array<Record<string, unknown>> = [];
    const gateway = {
      async tregCall(input: { endpoint_id?: unknown; params?: unknown }) {
        const endpointId = String(input.endpoint_id);
        const params = (input.params ?? {}) as Record<string, unknown>;
        seq += 1;
        const id = `call_${String(seq).padStart(4, "0")}`;
        let body: unknown;
        if (endpointId === "anyapi.x.search.posts") body = page;
        else {
          replyCalls.push(params);
          const tweet = String(params.url).match(/\d{6,}/g)?.pop() ?? "1";
          const from = params.cursor ? Number(String(params.cursor).slice(1)) : 0;
          body = opts.endless ? repliesPageOf(tweet, 40, from, true) : repliesPageOf(tweet, 3, from, false);
        }
        await store.putFile(target, RAW_PATH(id), JSON.stringify(body), "application/json");
        const { reading } = buildShapeDigest(body, catalog.byId.get(endpointId)!);
        return { ok: true as const, call_id: id, http_status: 200, rows_in_page: reading.rows.length, has_more: reading.hasMore ?? null, next_cursor: reading.nextCursor ?? null, shape: null, first_rows: [], warnings: [], saved: id };
      },
    };
    const items = await ItemStore.open(store, target);
    const plan = r.plan;
    await runEngine({ items, store, plan: withPromiseCaps(plan), missionId: target, gateway: gateway as unknown as Gateway, sandbox: (code, inputs) => runInSandbox(code, inputs), addEvent: async () => undefined, deadlineMs: Date.now() + 3_600_000, sleep: async () => undefined, redesignStages: redesignStagesOf(plan, TYPES_OFF, true, { x: "test" }) });
    return { items, replyCalls, plan, chosen: r.chosen };
  }

  it("a compiled X plan with the replies stage runs the new engine whole (never the old pipeline)", () => {
    const r = compile(REQUEST, { catalogOnly: true });
    if (!r.ok) throw new Error(r.reason);
    expect([...redesignStagesOf(r.plan, TYPES_OFF, false, {})].sort()).toEqual(["replies", "tweets"]);
  });

  it("each chosen tweet that says it has replies is read by its own link, and none that says it has none (no paid read); the replies are rows under their tweet", async () => {
    const { items, replyCalls, chosen } = await run({ endless: false });
    const counterOf = new Map(mapPage(searchCard, page).map((t) => [String(t.id), Number(t.replies_count) || 0] as const));
    const withReplies = chosen.filter((id) => (counterOf.get(id) ?? 0) > 0);
    expect(withReplies.length).toBeGreaterThan(0);
    expect(withReplies.length).toBeLessThan(chosen.length);
    expect(replyCalls).toHaveLength(withReplies.length);
    for (const c of replyCalls) expect(String(c.url)).toMatch(/\d{6,}/);
    const delivered = items.acceptedRows("replies");
    expect(delivered.length).toBe(withReplies.length * 3);
    expect(new Set(delivered.map((r) => String(r.parent_id)))).toEqual(new Set(withReplies));
  });

  it("the cap: a source that never ends is read for at most 200 pages (0.10 USD of catalog_only calls at the catalog price, 0.20 at twice it), then the stage stops", async () => {
    const { items, replyCalls, plan } = await run({ endless: true });
    const max = plan.stages.find((s) => s.key === "replies")!.max_pages!;
    expect(max).toBe(200);
    expect(replyCalls.length).toBeLessThanOrEqual(max);
    expect(replyCalls.length * repliesCardOf()!.costUsdPerPage * CATALOG_ONLY_PRICE_MARGIN).toBeLessThanOrEqual(CATALOG_ONLY_CAP_USD + 1e-9);
    expect(items.counts("replies").pages).toBeLessThanOrEqual(max);
  });
});

describe("D5: the file keeps the tweets and their replies apart (a tweet is not a «تعليق»)", () => {
  it("the replies are their own sheet, with the tweet's text and link beside each reply; the tweets sheet keeps its marks; the first sheet says where the replies are", async () => {
    const r = compile(REQUEST, { catalogOnly: true });
    if (!r.ok) throw new Error(r.reason);
    const tweets = mapPage(searchCard, page).filter((t) => r.chosen.includes(String(t.id))).map((t): Record<string, any> => ({ ...t, __marks: { reply: false, repost: false, lang: "ar", inPeriod: true, named: null } }));
    const withReplies = tweets.filter((t) => Number(t.replies_count) > 0);
    const replies = withReplies.flatMap((t) => [0, 1].map((i) => ({ id: `r_${t.id}_${i}`, parent_id: String(t.id), text: `نص ${i}`, author: "a", posted_at: "2026-10-05T10:00:00.000Z", likes: i, replies_count: 0, language: "" })));
    const built = await buildMissionFiles(r.plan as PricedPlan, { tweets, replies } as never);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(built.xlsx as unknown as ArrayBuffer);
    const names = wb.worksheets.map((w) => w.name);
    expect(names).toHaveLength(3);
    const repliesSheet = wb.worksheets.find((w) => /الردود/.test(w.name) && w.rowCount === replies.length + 1)!;
    expect(repliesSheet, names.join(" | ")).toBeDefined();
    const head = (repliesSheet.getRow(1).values as unknown[]).map((v) => String(v ?? ""));
    expect(head.join("|")).toMatch(/لغة النص/);
    expect(head.join("|")).not.toMatch(/نوع التعليق|معرّف التعليق الأصلي/);
    const tweetsSheet = wb.worksheets.find((w) => w.rowCount === tweets.length + 1 && w !== repliesSheet && /تغريد/.test(w.name))!;
    expect((tweetsSheet.getRow(1).values as unknown[]).map((v) => String(v ?? "")).join("|")).toMatch(/رد أم أصلي/);
  });
});
