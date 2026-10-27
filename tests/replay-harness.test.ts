import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { world, loadFixture, type ReplayFixture } from "./helpers/replayWorld";

vi.mock("../src/lib/supabase/server", async () => (await import("./helpers/replayWorld")).world.supabaseServerMock());
vi.mock("../src/lib/server/sendPlatformEmail", () => ({ sendPlatformEmail: vi.fn(async () => undefined), getRecipient: vi.fn(async () => null) }));
vi.mock("../src/functions/shared/catalogClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/functions/shared/catalogClient")>()),
  getEndpointDetails: vi.fn(async () => null),
  searchCatalog: vi.fn(async () => []),
}));

import { setProviderAdapterForTesting, defaultTregAdapter } from "../src/lib/server/tregAdapter";
import { ChatHandler } from "../src/functions/shared/chatHandler";
import { clearBriefCacheForTesting } from "../src/functions/shared/briefManager";
import { resetProviderBalanceCacheForTesting, setProviderBalanceForTesting } from "../src/functions/shared/providerSpend";
import { createChatDb, withPeopleSettlement } from "./helpers/chatSession";
import { chargeForUnits, reserveForUnits } from "../src/lib/recordPricing";

/**
 * Full requests, replayed: the customer's sentence goes through chat planning (no model: it must not be asked), the plan's own item (service, parameters, unit price,
 * hold) seeds the job, and the worker runs it on stored fixtures through the real adapter and the real gateway client. The network is replaced: every test asserts
 * ZERO requests reached it, how many were served from fixtures, the delivered count, the price the plan computed and the charge.
 *
 * Fixtures are «real rows» (read from a live job) or «catalog example» (the catalog's trimmed example answer; types can differ from live, one row).
 */

let seq = 0;
async function plan(request: string, answers: Array<{ id: string; question: string; value: string }> = [], people = false) {
  const db: any = people ? withPeopleSettlement(createChatDb()) : createChatDb();
  const handler = new ChatHandler(db);
  (handler as any).llm.executeTurn = vi.fn(async () => { throw new Error("the model must not be asked in a replay"); });
  const conversationId = `conv_replay_${++seq}`;
  await db.createRow({ tableId: "conversations", rowId: conversationId, data: { userId: "user_replay", title: "محادثة جديدة", status: "active", totalTokens: 0 } });
  clearBriefCacheForTesting();
  const send = (message: string): Promise<any> => handler.handleUserMessage({ userId: "user_replay", conversationId, message, userBalance: 40_000 }) as Promise<any>;
  let r = await send(request);
  for (const a of answers) r = await send(JSON.stringify({ type: "clarification_answers", answers: [{ questionId: a.id, question: a.question, value: a.value }] }));
  return r;
}

describe("replay of full requests on stored fixtures (no real provider call)", () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = { CRON_SECRET: process.env.CRON_SECRET, ENABLE_MOCK_PROVIDER: process.env.ENABLE_MOCK_PROVIDER, NODE_ENV: process.env.NODE_ENV, VERCEL_ENV: process.env.VERCEL_ENV, TREG_LIVE: process.env.TREG_LIVE, TREG_TOKEN: process.env.TREG_TOKEN };
    process.env.CRON_SECRET = "replay-test-secret";
    process.env.ENABLE_MOCK_PROVIDER = "true";
    (process.env as any).NODE_ENV = "test";
    process.env.VERCEL_ENV = "development";
    process.env.TREG_LIVE = "true";
    process.env.TREG_TOKEN = "replay-not-a-real-token";
    vi.stubEnv("JOB_MAX_POINTS_CAP", "");
    // «now» is pinned (only the clock, no timer): the windows «last month» and the dates of the fixtures must not depend on the day the suite runs
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-27T12:00:00Z"));
    resetProviderBalanceCacheForTesting();
    setProviderBalanceForTesting(50);
    setProviderAdapterForTesting(defaultTregAdapter);
  });
  afterEach(() => {
    vi.useRealTimers();
    setProviderAdapterForTesting(null);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    resetProviderBalanceCacheForTesting();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete (process.env as any)[k]; else (process.env as any)[k] = v; }
  });

  /** Plans the request, seeds the job from the plan's own first item, replays it. Returns what the assertions need. */
  async function replay(request: string, fixtures: ReplayFixture[], options: { answers?: Array<{ id: string; question: string; value: string }>; costMicroOverride?: number } = {}) {
    const r = await plan(request, options.answers);
    expect(r.outputType, `the plan of «${request}»`).toBe("propose_plan");
    const item = r.planQuote.items[0];
    world.resetJob({ slug: item.capabilitySlug, endpointId: item.endpointId, params: item.params, target: item.targetVolumeMax, unitPrice: item.unitPricePoints, unitCostUsd: item.unitCostUsd });
    world.installFetch(fixtures, { costMicroOverride: options.costMicroOverride });
    const last = await world.runWorker();
    return { r, item, ...last, settle: world.db.rpcCalls.find((c) => c.name === "settle_job_atomic"), release: world.db.rpcCalls.find((c) => c.name === "release_job_atomic") };
  }

  it("X account, REAL rows (the live job's ten rows): 3 own posts delivered, 1 point charged, 1 request served, 0 to the network", async () => {
    const out = await replay("أريد ١٠ منشورات من حساب @elonmusk على منصة X", [loadFixture("real-rows_anyapi.x.user.posts")]);
    expect(world.stats.realCalls).toBe(0);
    expect(world.stats.served.map((s) => s.endpointId)).toEqual(["anyapi.x.user.posts"]);
    expect(out.item.capabilitySlug).toBe("social-x-posts");
    expect(out.item.params.channel).toBe("@elonmusk");
    expect(out.json.deliveredUnits).toBe(3);
    // the price the plan computed (from the shared function, never from the model), the hold, and the charge: ceil(delivered x unit), never above the hold
    expect(out.item.unitPricePoints).toBe(0.11715);
    expect(out.r.planQuote.quotedPoints).toBe(reserveForUnits(10, 0.11715));
    expect(out.settle!.args).toBeDefined();
    expect(out.json.settle.charged_credits).toBe(chargeForUnits(3, 0.11715));
    expect(out.json.settle.charged_credits).toBe(1);
    expect(out.json.settle.charged_credits).toBeLessThanOrEqual(out.r.planQuote.quotedPoints);
    });

  it("X account, CATALOG EXAMPLE (the example row has no author field, as the live rows do): the row is held, not delivered; two pages with nothing add nothing, so the job stops and the whole hold is released", async () => {
    const out = await replay("أريد ١٠ منشورات من حساب @elonmusk على منصة X", [loadFixture("catalog-example_anyapi.x.user.posts")]);
    expect(world.stats.realCalls).toBe(0);
    expect(world.stats.served.map((s) => [s.endpointId, s.page])).toEqual([["anyapi.x.user.posts", 1], ["anyapi.x.user.posts", 2]]);
    expect(out.json.deliveredUnits ?? 0).toBe(0);
    expect(out.release).toBeDefined();
    expect(world.db.rpcCalls.some((c) => c.name === "settle_job_atomic")).toBe(false);
    expect(String(out.release!.args.p_error_message)).toContain("حجز مؤقت مُحرَّر كاملًا ولم يُخصم أي رصيد");
    expect(world.lines().some((l) => l.includes("قيد المراجعة ١"))).toBe(true);
  });

  it("X topic search inside a window that holds the example's date (CATALOG EXAMPLE): 1 delivered of 5, charged ceil(1 x 0.11715) = 1 point, the window is sent to the source and the next page (the example has a cursor) adds nothing", async () => {
    const out = await replay("أريد ٥ تغريدات عن AI trenches على منصة X من ١ سبتمبر ٢٠٢٦ إلى ٣٠ سبتمبر ٢٠٢٦", [loadFixture("catalog-example_anyapi.x.search.posts")]);
    expect(world.stats.realCalls).toBe(0);
    expect(out.item.capabilitySlug).toBe("social-x-posts");
    expect(out.item.params).toMatchObject({ query: "ai trenches", dateFrom: "2026-09-01", dateTo: "2026-09-30" });
    expect(world.stats.served[0].body.query).toBe("ai trenches since:2026-09-01 until:2026-10-01");
    expect(out.item.unitPricePoints).toBe(0.11715);
    expect(out.json.deliveredUnits).toBe(1);
    expect(out.json.settle.charged_credits).toBe(chargeForUnits(1, 0.11715));
    expect(out.json.settle.charged_credits).toBeLessThanOrEqual(out.r.planQuote.quotedPoints);
  });

  it("the same X topic search in the LAST MONTH: the catalog example is dated 2026-09-19, outside the window, so nothing is delivered and the hold is released (the example's date is the snapshot's, not today's)", async () => {
    const out = await replay("أريد ٥ تغريدات عن AI trenches على منصة X آخر شهر", [loadFixture("catalog-example_anyapi.x.search.posts")]);
    expect(world.stats.realCalls).toBe(0);
    expect(out.json.deliveredUnits ?? 0).toBe(0);
    expect(out.release).toBeDefined();
    expect(world.lines().some((l) => l.includes("خارج الفترة المطلوبة"))).toBe(true);
  });

  it("TikTok comments of a link, CATALOG EXAMPLE: 1 delivered of 3 asked, charged ceil(1 x 0.275) = 1 point of the 1-point hold, one request served", async () => {
    const out = await replay("أريد ٣ تعليقات من فيديو تيك توك https://www.tiktok.com/@user/video/7606449212716305678", [loadFixture("catalog-example_crawl4ai.tiktok.video.comments"), loadFixture("catalog-example_tikhub.tiktok.video.comments")]);
    expect(world.stats.realCalls).toBe(0);
    expect(world.stats.served.map((s) => s.endpointId)).toEqual(["tikhub.tiktok.video.comments"]);
    expect(out.item.capabilitySlug).toBe("social-tiktok-comments");
    expect(out.item.unitPricePoints).toBe(0.275);
    expect(out.json.deliveredUnits).toBe(1);
    expect(out.json.settle.charged_credits).toBe(chargeForUnits(1, 0.275));
    expect(out.json.settle.charged_credits).toBeLessThanOrEqual(out.r.planQuote.quotedPoints);
    expect(world.lines().some((l) => l.includes("المسلَّم ١ من ٣ مطلوب"))).toBe(true);
  });

  it("Facebook post comments of a link, CATALOG EXAMPLE: 1 delivered of 3, 2 requests served (the example says there is a next page), charged ceil(1 x 1.034) = 2 points of the 4-point hold", async () => {
    const out = await replay("أريد ٣ تعليقات من منشور فيسبوك https://www.facebook.com/youm7/posts/1234567890123", [loadFixture("catalog-example_scrapecreators.x.v1-facebook-post-comments")]);
    expect(world.stats.realCalls).toBe(0);
    expect(world.stats.served.map((s) => s.endpointId)).toEqual(["scrapecreators.x.v1-facebook-post-comments", "scrapecreators.x.v1-facebook-post-comments"]);
    expect(out.item.unitPricePoints).toBe(1.034);
    expect(out.r.planQuote.quotedPoints).toBe(reserveForUnits(3, 1.034));
    expect(out.json.deliveredUnits).toBe(1);
    expect(out.json.settle.charged_credits).toBe(chargeForUnits(1, 1.034));
    expect(out.json.settle.charged_credits).toBe(2);
    expect(out.json.settle.charged_credits).toBeLessThanOrEqual(out.r.planQuote.quotedPoints);
  });

  it("companies, CATALOG EXAMPLE (the example company is not in the requested country): nothing delivered, nothing charged, the hold released, in Arabic, with the reason", async () => {
    const out = await replay("أريد ١٠ شركات تقنية في مصر", [loadFixture("catalog-example_icypeas.companies.search")]);
    expect(world.stats.realCalls).toBe(0);
    expect(world.stats.served.every((s) => s.endpointId === "icypeas.companies.search")).toBe(true);
    expect(out.item.capabilitySlug).toBe("icypeas-companies-search");
    expect(out.item.unitPricePoints).toBe(3.168);
    expect(out.json.deliveredUnits ?? 0).toBe(0);
    expect(out.release).toBeDefined();
    expect(world.db.rpcCalls.some((c) => c.name === "settle_job_atomic")).toBe(false);
    expect(world.lines().some((l) => l.includes("خارج النطاق الجغرافي المطلوب"))).toBe(true);
  });

  it("decision makers: the plan is priced from the live catalog's record cost and contact fields; the replay world serves no catalog, so the chat refuses to price (a plain Error today, which the route turns into the generic failure) and nothing is planned", async () => {
    await expect(plan("أريد ٣ مديرين تنفيذيين في شركات التقنية في مصر", [], true)).rejects.toThrow("تعذر التحقق من أسعار السجل وحقول التواصل في كتالوج المصادر");
    expect(world.stats.realCalls).toBe(0);
  });

  it("the runaway of 22 Oct 2026 (a jobs source answering full pages that never pass a topic gate), CATALOG EXAMPLE rows cloned: 2 requests instead of 175, nothing charged, the hold released", async () => {
    world.resetJob({ slug: "blitzapi-jobs-search", endpointId: "blitzapi.jobs.search", params: { query: "مقاولات في مصر" }, target: 50, unitPrice: 3.168, unitCostUsd: 0.000495, pricingUnit: "item" });
    world.installFetch([loadFixture("catalog-example_blitzapi.jobs.search")]);
    const { json } = await world.runWorker(30);
    expect(world.stats.realCalls).toBe(0);
    expect(world.stats.served.length).toBe(2);
    expect(world.stats.served.every((s) => s.endpointId === "blitzapi.jobs.search")).toBe(true);
    expect(json.released).toBe(true);
    expect(json.deliveredUnits ?? 0).toBe(0);
    expect(world.db.rpcCalls.some((c) => c.name === "settle_job_atomic")).toBe(false);
    expect(world.db.rpcCalls.filter((c) => c.name === "release_job_atomic")).toHaveLength(1);
    // what the provider billed: two calls, not 175 (0.866 USD)
    const spent = world.db.costs.reduce((sum, c) => sum + c.cost_usd, 0);
    expect(spent).toBeLessThan(0.02);
    expect(String(world.db.rpcCalls.find((c) => c.name === "release_job_atomic")!.args.p_error_message)).toContain("حجز مؤقت مُحرَّر كاملًا ولم يُخصم أي رصيد");
  });

  it("the job's call budget, at the worker: the first page is bought and delivers 3 posts; the second would pass the value of the 2-point hold, so it is NOT requested and the job settles on what it has", async () => {
    // each call bills 0.0033 USD in this replay; the hold of 2 points is worth 0.0036 USD, so one call fits and a second does not
    world.resetJob({ slug: "social-x-posts", endpointId: "anyapi.x.user.posts", params: { channel: "@elonmusk" }, target: 10, unitPrice: 0.11715 });
    world.installFetch([loadFixture("real-rows_anyapi.x.user.posts")], { costMicroOverride: 3300 });
    const { json } = await world.runWorker();
    expect(world.stats.realCalls).toBe(0);
    expect(world.stats.served).toHaveLength(1);
    expect(json.done).toBe(true);
    expect(json.deliveredUnits).toBe(3);
    expect(json.settle.charged_credits).toBe(chargeForUnits(3, 0.11715));
    expect(world.db.rpcCalls.some((c) => c.name === "release_job_atomic")).toBe(false);
  });

  it("a plan whose service is a WRITE ACTION never reaches the network, whatever the plan says: the job is released", async () => {
    world.resetJob({ slug: "openmart-deny-rules-create", endpointId: "openmart.deny-rules.create", params: { query: "x" }, target: 5, unitPrice: 2, unitCostUsd: 0.001, pricingUnit: "item" });
    world.installFetch([]);
    const { json } = await world.runWorker();
    expect(world.stats.realCalls).toBe(0);
    expect(world.stats.served).toEqual([]);
    expect(world.stats.unserved).toEqual([]);
    expect(json.deliveredUnits ?? 0).toBe(0);
    expect(world.db.rpcCalls.some((c) => c.name === "settle_job_atomic")).toBe(false);
  });

  it("raw first-page capture: OFF by default (nothing stored); ON stores the first raw page of the job once, masked", async () => {
    world.resetJob({ slug: "social-x-posts", endpointId: "anyapi.x.user.posts", params: { channel: "@elonmusk" }, target: 10, unitPrice: 0.11715 });
    world.installFetch([loadFixture("real-rows_anyapi.x.user.posts")]);
    await world.runWorker();
    expect([...world.db.partials.keys()].some((k) => k.endsWith("raw_first_page.json"))).toBe(false);

    world.resetJob({ slug: "social-x-posts", endpointId: "anyapi.x.user.posts", params: { channel: "@elonmusk" }, target: 10, unitPrice: 0.11715 });
    world.installFetch([loadFixture("real-rows_anyapi.x.user.posts")]);
    vi.stubEnv("RAW_FIRST_PAGE_CAPTURE", "on");
    await world.runWorker();
    const key = `${world.JOB}/raw_first_page.json`;
    expect(world.db.partials.has(key)).toBe(true);
    const stored = JSON.parse(world.db.partials.get(key)!.toString("utf-8"));
    expect(stored.endpointId).toBe("anyapi.x.user.posts");
    expect(stored.page).toBe(1);
    // the answer exactly as the source sent it: the replay fixture's page (an envelope with the ten rows), not the flattened and gated rows
    expect(stored.body.rows).toHaveLength(10);
    expect(stored.body.rows[0].authorHandle).toBe("elonmusk");
    expect(stored.body.rows[0].isReply).toBe("False");
    expect(world.db.rpcCalls.filter((c) => c.name === "complete_chunk").length).toBeGreaterThan(0);
  });
});
