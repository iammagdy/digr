import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/supabase/server", async () => (await import("./helpers/scaleHarness")).supabaseServerMock());
vi.mock("../src/lib/server/sendPlatformEmail", async () => (await import("./helpers/scaleHarness")).sendPlatformEmailMock());
vi.mock("../src/functions/shared/catalogClient", () => ({
  searchCatalog: vi.fn(async () => []),
  getCachedCatalogEndpoints: vi.fn(() => []),
  getEndpointDetails: vi.fn(async (id: string) => ({ id, catalogPriceUsd: 0.005, pointsPerUnit: 28 })),
}));

import { ChatHandler } from "../src/functions/shared/chatHandler";
import { MISSION_TEMPLATES } from "../src/lib/missionTemplates";
import { createChatDb } from "./helpers/chatSession";
import { db, driveToTheEnd, finalRows, jobRow, nowMs, setupEnv } from "./helpers/scaleHarness";
import { runSocialChunk, type SocialCall, type SocialCallOutcome } from "../src/lib/server/socialAdapter";
import { setProviderAdapterForTesting } from "../src/lib/server/tregAdapter";
import { jobIdForQuote } from "../src/lib/server/retryReuse";

const byId = (id: string) => MISSION_TEMPLATES.find((t) => t.id === id)!;
/** The customer edits the bracketed parts: each [x] becomes what he typed (or the template's own value without the brackets). */
const fill = (prompt: string, edits: Record<string, string> = {}) => prompt.replace(/\[([^\]]+)\]/g, (_m, inner: string) => edits[inner] ?? inner);

async function plan(message: string) {
  const chatDb: any = createChatDb();
  // the people plan checks that the people settlement function exists (a «job not found» answer proves it does)
  chatDb.rpc = async (name: string, args: any) => (name === "settle_people_job_atomic" ? { data: null, error: { code: "P0001", message: `Job ${args.p_job_id} not found` } } : { data: null, error: { code: "PGRST202", message: `function ${name} not found` } });
  const handler = new ChatHandler(chatDb);
  (handler as any).llm.executeTurn = vi.fn(async () => { throw new Error("the model must not be called"); });
  await chatDb.createRow({ tableId: "conversations", rowId: "conv_show", data: { userId: "user_show", title: "محادثة جديدة", status: "active", totalTokens: 0 } });
  return (await handler.handleUserMessage({ userId: "user_show", conversationId: "conv_show", message, userBalance: 5000 })) as any;
}

const SHOWCASE: Array<{ id: string; edits: Record<string, string>; slug: string; maxVolume: number }> = [
  { id: "companies_decision_makers", edits: { "نوع النشاط": "مقاولات", "الدولة": "مصر" }, slug: "professional-people-search", maxVolume: 50 },
  { id: "tiktok_channels_top_videos_comments", edits: { "@الحساب_الأول و@الحساب_الثاني و@الحساب_الثالث": "@ahlytv و@zamalekofficial و@mosalah" }, slug: "social-tiktok-comments", maxVolume: 80 },
  { id: "event_monitoring_x", edits: { "اسم الحدث أو الموضوع": "مباراة مصر والمغرب", "الفترة: من تاريخ إلى تاريخ": "من ١١ يونيو ٢٠٢٦ إلى ١٩ يوليو ٢٠٢٦", "١٠٠٠": "١٠٠" }, slug: "social-x-posts", maxVolume: 100 },
  { id: "youtube_named_videos_comments", edits: { "رابط الفيديو": "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }, slug: "social-youtube-comments", maxVolume: 50 },
  { id: "facebook_page_posts", edits: { "رابط الصفحة العامة": "https://www.facebook.com/cnn" }, slug: "social-facebook-posts", maxVolume: 30 },
];

describe("the showcase missions: the template fills the input, the plan is honest, the duration is a range", () => {
  for (const mission of SHOWCASE) {
    it(`${mission.id}: the filled template is a plan on the right service, no question, a duration range, nothing priced that is not sold`, async () => {
      const message = fill(byId(mission.id).promptAr, mission.edits);
      const r = await plan(message);
      expect(r.outputType).toBe("propose_plan");
      expect(r.planQuote.items[0].capabilitySlug).toBe(mission.slug);
      expect(r.planQuote.targetVolumeMax).toBeGreaterThanOrEqual(1);
      expect(r.planQuote.targetVolumeMax).toBeLessThanOrEqual(mission.maxVolume);
      expect(r.clarificationQuestions ?? []).toHaveLength(0);
      // an honest duration: a range, labelled approximate, computed by code
      expect(String(r.planQuote.duration.rangeAr)).toMatch(/^من .+/u);
      expect(r.planQuote.duration.labelAr).toBe("تقديري");
      // the customer-facing text carries no provider or endpoint word
      expect(String(r.contentAr)).not.toMatch(/tikhub|icypeas|treg|crawl4ai|anyapi|scrapecreators|endpoint|USD|\$/i);
      expect(r.planQuote.partsAr).toBeUndefined();
    });
  }

  it("the plan of a mission that the points cap holds below what was asked says so in plain words and offers the rest as a separate request", async () => {
    const r = await plan(fill(byId("companies_decision_makers").promptAr, { "نوع النشاط": "مقاولات", "الدولة": "مصر" }));
    expect(r.planQuote.targetVolumeMax).toBeLessThan(50);
    expect(String(r.contentAr)).toContain("تقدر تطلب الباقي في طلب منفصل");
  });
});

describe("the social showcase missions through the real worker with a fake provider: delivered, charged only for what was delivered, notified", () => {
  let restore: () => void;
  beforeEach(() => { restore = setupEnv(); });
  afterEach(() => { setProviderAdapterForTesting(null); restore(); });

  const ok = (rows: Array<Record<string, any>>, next?: string): SocialCallOutcome => ({ ok: true, httpStatus: 200, data: { ok: true, rows, ...(next ? { next_cursor: next } : {}) }, costMicro: 600, tregCallId: "c" });

  function seed(opts: { slug: string; endpointId: string; params: Record<string, any>; target: number; unitPrice: number }) {
    const quoteId = "quote_showcase";
    const jobId = jobIdForQuote(quoteId);
    const T = nowMs();
    db.unitPrice = opts.unitPrice;
    db.jobs.push({ id: jobId, user_id: "user_1", status: "running", step: 0, current_cursor: null, delivered_units: 0, target_volume_max: opts.target, lease_until: null, next_attempt_at: null, endpoint_id: opts.endpointId, created_at: new Date(T - 60_000).toISOString(), updated_at: new Date(T - 30_000).toISOString() });
    db.quotes = [{ id: quoteId, user_id: "user_1", output_formats: ["csv", "xlsx"], items: [{ capabilitySlug: opts.slug, endpointId: opts.endpointId, params: opts.params, targetVolumeMax: opts.target, paginationStrategy: "cursor" }] }];
    db.reserved = Math.ceil(opts.target * opts.unitPrice * 1.15);
    return jobId;
  }
  const use = (call: SocialCall) => setProviderAdapterForTesting(async (input) => runSocialChunk(input, { call, now: nowMs, videoSelector: input.videoSelector }));

  function assertDeliveredOnceAndNotified(jobId: string, delivered: number, unitPrice: number) {
    const job = jobRow(jobId);
    expect(job.status).toBe("completed");
    expect(job.delivered_units).toBe(delivered);
    expect(db.rpcCalls.filter((c) => c.name === "settle_job_atomic")).toHaveLength(1);
    expect(db.rpcCalls.filter((c) => c.name === "release_job_atomic")).toHaveLength(0);
    expect(job.charged).toBe(Math.min(Math.ceil(delivered * unitPrice), db.reserved));
    expect(job.charged).toBeLessThanOrEqual(db.reserved);
    const notice = db.notifications.find((n) => String(n.id).startsWith("notif_completed_"));
    expect(notice).toBeDefined();
    expect(String(notice.title)).toBe("اكتمل طلب استخراج البيانات بنجاح");
    expect(`${notice.title} ${notice.body}`).not.toMatch(/[A-Za-z]/);
  }

  it("X posts about an event with the window 2026-06-11 to 2026-07-19: the window reaches the source, the rows inside it are delivered and charged", async () => {
    const jobId = seed({ slug: "social-x-posts", endpointId: "anyapi.x.search.posts", params: { query: "مباراة مصر والمغرب", dateFrom: "2026-06-11", dateTo: "2026-07-19" }, target: 40, unitPrice: 5 });
    const sent: Array<Record<string, any>> = [];
    let page = 0;
    use(async (_source, params) => {
      sent.push(params);
      page += 1;
      const rows = Array.from({ length: 20 }, (_, i) => ({ tweet_id: `p${page}_${i}`, text: `منشور ${page}-${i} عن مباراة مصر والمغرب`, createdUtc: Math.floor(Date.parse("2026-06-20T10:00:00Z") / 1000) + page * 100 + i }));
      return ok(rows, `cursor_${page}`);
    });
    const run = await driveToTheEnd(jobId, { maxTicks: 10 });
    expect(run.finalStatus).toBe("completed");
    expect(String(sent[0].query)).toContain("since:2026-06-11 until:2026-07-20");
    assertDeliveredOnceAndNotified(jobId, 40, 5);
    expect(finalRows(jobId)).toHaveLength(40);
  });

  it("the comments of a named YouTube video: delivered with their video link and date, charged per comment, notified", async () => {
    const url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
    const jobId = seed({ slug: "social-youtube-comments", endpointId: "crawl4ai.youtube.video.comments", params: { url }, target: 30, unitPrice: 9 });
    use(async () => ok(Array.from({ length: 30 }, (_, i) => ({ comment_id: `y${i}`, text: `تعليق رقم ${i} على الفيديو`, author: `قارئ ${i}`, published_date: "2026-10-05", url: `${url}&lc=y${i}` }))));
    const run = await driveToTheEnd(jobId, { maxTicks: 10 });
    expect(run.finalStatus).toBe("completed");
    assertDeliveredOnceAndNotified(jobId, 30, 9);
    const csv = db.results.get(`user_1/${jobId}/result.csv`)!.toString("utf-8");
    expect(csv.split("\n")[0]).toContain("رابط الفيديو أو المنشور");
    expect(csv).toContain("2026-10-05");
  });

  it("the posts of a named Facebook page: the newest posts are delivered, charged per post, notified", async () => {
    const jobId = seed({ slug: "social-facebook-posts", endpointId: "anyapi.facebook.user.posts", params: { channel: "https://www.facebook.com/cnn" }, target: 20, unitPrice: 11 });
    use(async () => ok(Array.from({ length: 20 }, (_, i) => ({ post_id: `f${i}`, text: `منشور الصفحة رقم ${i}`, created_time: "2026-10-10T08:00:00Z", url: `https://www.facebook.com/cnn/posts/${i}`, likes: i }))));
    const run = await driveToTheEnd(jobId, { maxTicks: 10 });
    expect(run.finalStatus).toBe("completed");
    assertDeliveredOnceAndNotified(jobId, 20, 11);
  });
});
