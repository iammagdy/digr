import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiState = vi.hoisted(() => ({ rows: [] as any[] }));
vi.mock("../src/lib/supabase/server", () => ({ createAdminClient: () => ({}) }));
vi.mock("../src/lib/server/liveDailyCap", () => ({ liveDailyCapPoints: async () => undefined }));

import PlanQuoteCard, { type PlanQuoteData } from "../src/app/dashboard/chat/components/PlanQuoteCard";
import { POST as estimatePost } from "../src/app/api/calculator/estimate/route";
import { ChatHandler } from "../src/functions/shared/chatHandler";
import { formatStructuredClarificationAnswers } from "../src/functions/shared/clarification";
import { createChatDb } from "./helpers/chatSession";
import {
  CHUNK_BUDGET_SECONDS,
  DEFAULT_TIMINGS,
  DURATION_LABEL_AR,
  DURATION_PROMISE_AR,
  MIN_MEASURED_CHUNKS,
  UNMEASURED_WIDENING,
  durationRangeAr,
  durationStepsFromPlanItems,
  estimateMissionDuration,
  missionDurationForPlan,
  phraseDuration,
  type DurationPhrasingInput,
  type MeasuredTimings,
} from "../src/lib/missionDuration";
import { canClosePage, longJobDriverMode } from "../src/lib/driverMode";
import { IDLE_GAP_SECONDS, aggregateChunkTimings, loadMeasuredTimings, resetMeasuredTimingsCache } from "../src/lib/server/jobTimings";

/**
 * The duration of a mission before approval: computed by code from the real numbers of the worker, a range (optimistic to
 * pessimistic) in friendly Arabic labelled «تقديري», widening with volume and dependent steps, honest about days, and never carrying
 * a money value. The price shown with it comes from the unchanged pricing function.
 */
const comments = (n: number, extra: Record<string, any> = {}) => [{ capabilitySlug: "social-youtube-comments", targetVolumeMax: n, params: { query: "منتخب مصر", videoCount: 20, perVideo: Math.ceil(n / 20), ...extra } }];
const posts = (n: number) => [{ capabilitySlug: "social-x-posts", targetVolumeMax: n, params: { query: "الغلاء" } }];
const channels = (n: number, count = 3) => [{ capabilitySlug: "social-tiktok-comments", targetVolumeMax: n, params: { channels: Array.from({ length: count }, (_, i) => `@c${i + 1}`), topPerChannel: 10, rankBy: "views" } }];
const companiesThenPeople = (n: number) => [
  { capabilitySlug: "icypeas-companies-search", targetVolumeMax: n, params: {} },
  { capabilitySlug: "professional-people-search", targetVolumeMax: n, params: {} },
];

const view = (items: any[], driver: "tab" | "cron" = "tab", measured?: MeasuredTimings) => missionDurationForPlan(items, driver, measured)!;
const duration = (items: any[], driver: "tab" | "cron" = "tab", measured?: MeasuredTimings) =>
  estimateMissionDuration({ steps: durationStepsFromPlanItems(items).filter((s) => s.records > 0), driver, measured });

describe("the estimate for the missions the owner named", () => {
  it.each([500, 2000, 10000, 50000])("%i YouTube comments: an optimistic and a pessimistic value, in a range", (n) => {
    const d = duration(comments(n));
    expect(d.optimisticSeconds).toBeGreaterThan(0);
    expect(d.pessimisticSeconds).toBeGreaterThan(d.optimisticSeconds);
    expect(d.stages.some((s) => s.kind === "collect")).toBe(true);
    expect(d.stages.some((s) => s.kind === "assembly")).toBe(true);
    expect(view(comments(n)).rangeAr).toMatch(/^(?:أقل من دقيقة|من .+ إلى .+|أكثر من أسبوعين)$/u);
  });

  it("37,500 X posts and a channels mission and 100 companies then decision makers all have a range", () => {
    for (const items of [posts(37500), channels(1000), companiesThenPeople(100)]) {
      const d = duration(items);
      expect(d.optimisticSeconds).toBeGreaterThan(0);
      expect(d.pessimisticSeconds).toBeGreaterThan(d.optimisticSeconds);
    }
    // 37,500 posts at 50 a call is 750 calls and 750 chunks of 50: the pages of a day, said honestly
    const big = duration(posts(37500));
    expect(big.chunks).toBe(750);
    expect(big.exceedsDay).toBe(true);
    expect(view(posts(37500)).longNoteAr).toContain("أكثر من يوم");
  });

  it("is monotonic in volume: more records never mean a shorter estimate", () => {
    let last = { o: 0, p: 0 };
    for (const n of [1, 10, 57, 200, 500, 1000, 2000, 5000, 10000, 25000, 50000]) {
      const d = duration(comments(n));
      expect(d.optimisticSeconds).toBeGreaterThanOrEqual(last.o);
      expect(d.pessimisticSeconds).toBeGreaterThanOrEqual(last.p);
      last = { o: d.optimisticSeconds, p: d.pessimisticSeconds };
    }
    let lastPosts = 0;
    for (const n of [10, 100, 1000, 10000, 37500]) {
      const d = duration(posts(n));
      expect(d.pessimisticSeconds).toBeGreaterThanOrEqual(lastPosts);
      lastPosts = d.pessimisticSeconds;
    }
  });

  it("widens with dependent steps: a channels mission is longer than the same comments with no discovery, and decision makers add to companies", () => {
    const plain = duration([{ capabilitySlug: "social-tiktok-comments", targetVolumeMax: 1000, params: { url: "https://www.tiktok.com/@a/video/1234567890123" } }]);
    const mission = duration(channels(1000));
    expect(mission.pessimisticSeconds).toBeGreaterThan(plain.pessimisticSeconds);
    expect(mission.calls).toBeGreaterThan(plain.calls);
    expect(mission.dependentSteps).toBeGreaterThan(0);
    const companies = duration([{ capabilitySlug: "icypeas-companies-search", targetVolumeMax: 100, params: {} }]);
    const both = duration(companiesThenPeople(100));
    expect(both.pessimisticSeconds).toBeGreaterThan(companies.pessimisticSeconds);
    expect(both.optimisticSeconds).toBeGreaterThan(companies.optimisticSeconds);
    expect(both.dependentSteps).toBe(1);
    expect(view(channels(1000)).driversAr).toContain("القنوات ثم الفيديوهات ثم التعليقات");
    expect(view(companiesThenPeople(100)).driversAr).toContain("الشركات ثم صنّاع القرار");
  });

  it("more channels (and so more videos, each read at least once), more calls and more time", () => {
    const five = duration(channels(5 * 10 * 50, 5));
    const two = duration(channels(2 * 10 * 50, 2));
    expect(five.calls).toBeGreaterThan(two.calls);
    expect(five.pessimisticSeconds).toBeGreaterThan(two.pessimisticSeconds);
  });

  it("decision makers take more chunks than the same number of companies (two calls per person, one after another)", () => {
    const people = duration([{ capabilitySlug: "professional-people-search", targetVolumeMax: 100, params: {} }]);
    const companies = duration([{ capabilitySlug: "icypeas-companies-search", targetVolumeMax: 100, params: {} }]);
    expect(people.chunks).toBeGreaterThan(companies.chunks);
  });

  it("a chunk's work fits its time budget: no more calls per chunk than the budget allows", () => {
    expect(CHUNK_BUDGET_SECONDS).toBeLessThan(45);
    const people = durationStepsFromPlanItems([{ capabilitySlug: "professional-people-search", targetVolumeMax: 100, params: {} }])[0];
    expect(people.callsPerRecord).toBe(2);
  });
});

describe("the driver's cadence", () => {
  it("the same plan has the same optimistic value and a longer pessimistic one when only a once-a-minute driver resumes it", () => {
    const tab = duration(comments(10000), "tab");
    const cron = duration(comments(10000), "cron");
    expect(cron.optimisticSeconds).toBe(tab.optimisticSeconds);
    expect(cron.pessimisticSeconds).toBeGreaterThan(tab.pessimisticSeconds);
    expect(DEFAULT_TIMINGS.gapSeconds.cron.pessimistic).toBeGreaterThan(DEFAULT_TIMINGS.gapSeconds.tab.pessimistic);
  });
});

describe("measurements and no measurements", () => {
  const measured = (p50: number, p90: number, chunks = MIN_MEASURED_CHUNKS): MeasuredTimings => ({ social_comments: { p50, p90, chunks } });

  it("with no measurements the basis says so and the pessimistic end is widened (the data does not support a tight range)", () => {
    const d = duration(comments(2000));
    expect(d.basis).toBe("default");
    const v = view(comments(2000));
    expect(v.driversAr).toContain("لا توجد قياسات كافية بعد لهذا النوع");
    const sameWithoutWidening = d.pessimisticSeconds / UNMEASURED_WIDENING;
    expect(d.pessimisticSeconds).toBeGreaterThan(sameWithoutWidening);
  });

  it("enough measured chunks replace the defaults; too few do not", () => {
    const fewMeasured = duration(comments(2000), "tab", measured(30, 60, MIN_MEASURED_CHUNKS - 1));
    expect(fewMeasured.basis).toBe("default");
    const enough = duration(comments(2000), "tab", measured(10, 20));
    expect(enough.basis).toBe("measured");
    expect(enough.pessimisticSeconds).toBeLessThan(duration(comments(2000)).pessimisticSeconds);
    expect(view(comments(2000), "tab", measured(10, 20)).driversAr).not.toContain("قياسات");
  });

  it("slower measured chunks give a longer estimate", () => {
    expect(duration(comments(2000), "tab", measured(60, 120)).pessimisticSeconds).toBeGreaterThan(duration(comments(2000), "tab", measured(20, 40)).pessimisticSeconds);
  });

  it("a plan with one measured family and one that is not is «mixed»", () => {
    const d = duration(companiesThenPeople(50), "tab", { companies: { p50: 8, p90: 15, chunks: 20 } });
    expect(d.basis).toBe("mixed");
  });
});

describe("the Arabic phrasing (golden)", () => {
  it.each([
    [900, 1800, "من ١٥ إلى ٣٠ دقيقة"],
    [300, 600, "من ٥ إلى ١٠ دقائق"],
    [60, 120, "من دقيقة إلى دقيقتين"],
    [120, 250, "من دقيقتين إلى ٥ دقائق"],
    [20, 50, "أقل من دقيقة"],
    [7200, 14400, "من ساعتين إلى ٤ ساعات"],
    [3600, 7200, "من ساعة إلى ساعتين"],
    [360, 6480, "من ٦ دقائق إلى ساعتين"],
    [93600, 241200, "من يوم إلى ٣ أيام"],
    [29000, 310000, "من ٨ ساعات إلى ٤ أيام"],
    [900000, 1500000, "أكثر من أسبوعين"],
  ])("%i to %i seconds: «%s»", (optimistic, pessimistic, expected) => {
    expect(durationRangeAr(optimistic, pessimistic)).toBe(expected);
  });

  it("never gives a range of one value, never reads backwards, always Arabic digits", () => {
    for (const [o, p] of [[600, 600], [3600, 3600], [86400, 86400], [0, 0], [100, 30]]) {
      const text = durationRangeAr(o, p);
      expect(text).not.toMatch(/[0-9]|NaN|undefined|null/);
      const m = /من (.+) إلى (.+)/u.exec(text);
      if (m) expect(m[1]).not.toBe(m[2]);
    }
  });

  it("the block says «تقديري», one line about what drives it, the notification promise, and a long-mission note only past a day", () => {
    const phrased = view(comments(10000));
    expect(phrased.labelAr).toBe(DURATION_LABEL_AR);
    expect(DURATION_LABEL_AR).toBe("تقديري");
    expect(phrased.promiseAr).toBe("سنبلغك عند الاكتمال.");
    expect(DURATION_PROMISE_AR).toBe(phrased.promiseAr);
    expect(phrased.driversAr).toMatch(/^تتأثر المدة بعدد الطلبات إلى المصدر \(حوالي [٠-٩]+\) وسرعة استجابته/u);
    expect(phrased.longNoteAr).toBeUndefined();
    expect(view(comments(50000)).longNoteAr).toContain("أكثر من يوم");
  });

  it("customer text is Arabic only: Arabic digits, no Latin letters, no money word, no provider or internal name", () => {
    for (const items of [comments(500), comments(50000), posts(37500), channels(1000), companiesThenPeople(100)]) {
      const v = view(items, "cron");
      const text = [v.rangeAr, v.labelAr, v.driversAr, v.promiseAr, v.longNoteAr || ""].join(" ");
      expect(text).not.toMatch(/[0-9A-Za-z]|NaN|undefined|null|USD|\$|نقطة|نقاط|جنيه|ج\.م|treg|tikhub|scrapecreators|crawl4ai|endpoint/i);
    }
  });
});

describe("the phrasing never receives money", () => {
  it("its input type has no price, points or money field, and the module imports no pricing code", () => {
    const source = readFileSync("src/lib/missionDuration.ts", "utf8");
    expect(source).not.toMatch(/from "\.\.?\/(?:\.\.\/)?(?:functions\/shared\/(?:quotes|decisionMakerPricing|providerSpend|ledger)|calculatorPricing|pointsCap|jobSizing|pricing|missionEstimate|volumePricing)"/);
    const phrasingType = source.slice(source.indexOf("export interface DurationPhrasingInput"), source.indexOf("export interface DurationPhrasing {"));
    expect(phrasingType).not.toMatch(/price|points|money|egp|cost|usd|credit|reserve/i);
  });

  it("extra fields passed to it are ignored: a price in the input cannot reach the sentence", () => {
    const input: DurationPhrasingInput = { optimisticSeconds: 900, pessimisticSeconds: 1800, calls: 40, chunks: 4, dependentSteps: 0, basis: "measured", driver: "tab" };
    const clean = phraseDuration(input);
    const dirty = phraseDuration({ ...input, quotedPoints: 590, unitPricePoints: 9, priceEgp: 59 } as any);
    expect(dirty).toEqual(clean);
    expect(JSON.stringify(clean)).not.toMatch(/590|٥٩٠|نقطة/);
  });

  it("the duration of a plan does not move when its price is different", () => {
    const base = missionDurationForPlan([{ capabilitySlug: "social-youtube-comments", targetVolumeMax: 500, params: { query: "x" }, unitPricePoints: 9, quotedPoints: 5175 } as any], "tab");
    const other = missionDurationForPlan([{ capabilitySlug: "social-youtube-comments", targetVolumeMax: 500, params: { query: "x" }, unitPricePoints: 90, quotedPoints: 51750 } as any], "tab");
    expect(other).toEqual(base);
  });
});

describe("measured timings from finished jobs (SELECT only)", () => {
  const t0 = Date.parse("2026-10-20T10:00:00Z");
  const iso = (seconds: number) => new Date(t0 + seconds * 1000).toISOString();
  const job = (id: string, endpoint: string, created = 0, updated = 600, step = 6) => ({ id, endpoint_id: endpoint, step, created_at: iso(created), updated_at: iso(updated) });
  const page = (jobId: string, at: number, n: number) => ({ job_id: jobId, created_at: iso(at), message: `الصفحة ${n}: استلمنا ٥٠ سجل` });

  it("a chunk is the gap between page lines, and between the start and the first page; idle gaps are left out", () => {
    const events = [10, 22, 33, 46, 58, 71, 4000].map((at, i) => page("j1", at, i + 1));
    const timings = aggregateChunkTimings([job("j1", "tikhub.tiktok.video.comments")], events);
    const family = timings.social_comments!;
    expect(family.chunks).toBe(6);
    expect(family.p50).toBeGreaterThan(10);
    expect(family.p50).toBeLessThan(15);
    expect(family.p90).toBeGreaterThanOrEqual(family.p50);
    expect(IDLE_GAP_SECONDS).toBe(1800);
  });

  it("with no page lines a finished job falls back to its own start-to-finish time per step", () => {
    const timings = aggregateChunkTimings(Array.from({ length: 6 }, (_, i) => job(`k${i}`, "icypeas.companies.search", 0, 120, 4)), []);
    expect(timings.companies).toEqual({ p50: 30, p90: 30, chunks: 6 });
  });

  it("a family with fewer chunks than the minimum has no timing", () => {
    expect(aggregateChunkTimings([job("a", "icypeas.people.search", 0, 90, 3)], [])).toEqual({});
  });

  it("unrelated lines and unreadable dates are ignored", () => {
    const timings = aggregateChunkTimings([job("j", "anyapi.x.search.posts")], [{ job_id: "j", created_at: "nope", message: "الصفحة ١" }, { job_id: "j", created_at: iso(5), message: "جاري تجهيز الملفات" }]);
    expect(timings).toEqual({});
  });

  describe("the loader", () => {
    beforeEach(() => resetMeasuredTimingsCache());
    const fake = () => {
      const calls: string[] = [];
      const chain = (table: string): any => {
        const c: any = {};
        for (const m of ["select", "eq", "order", "in", "like"]) c[m] = () => c;
        c.limit = async () => { calls.push(table); return { data: table === "jobs" ? Array.from({ length: 6 }, (_, i) => job(`j${i}`, "icypeas.companies.search", 0, 120, 4)) : [], error: null }; };
        return c;
      };
      return { calls, from: (table: string) => chain(table) };
    };

    it("reads the jobs and the events once and keeps them ten minutes", async () => {
      const admin = fake();
      const first = await loadMeasuredTimings(admin, 1_000);
      expect(first.companies?.chunks).toBe(6);
      await loadMeasuredTimings(admin, 1_000 + 5 * 60_000);
      expect(admin.calls).toEqual(["jobs", "job_events"]);
      await loadMeasuredTimings(admin, 1_000 + 11 * 60_000);
      expect(admin.calls).toHaveLength(4);
    });

    it("an unreadable database means «no data», not an error", async () => {
      expect(await loadMeasuredTimings(null)).toEqual({});
      expect(await loadMeasuredTimings({ from: () => { throw new Error("down"); } })).toEqual({});
    });

    it("never writes: the loader source has no insert, update, upsert, delete or rpc", () => {
      const source = readFileSync("src/lib/server/jobTimings.ts", "utf8");
      expect(source).not.toMatch(/\.(?:insert|update|upsert|delete|rpc)\(/);
    });
  });
});

describe("the driver flag", () => {
  it("is «tab» unless configured «cron»; nothing else turns it on", () => {
    expect(longJobDriverMode({})).toBe("tab");
    expect(longJobDriverMode({ LONG_JOB_DRIVER: "cron" })).toBe("cron");
    expect(longJobDriverMode({ LONG_JOB_DRIVER: " CRON " })).toBe("cron");
    for (const value of ["", "tab", "yes", "true", "1", "on"]) expect(longJobDriverMode({ LONG_JOB_DRIVER: value })).toBe("tab");
    expect(canClosePage("cron")).toBe(true);
    expect(canClosePage("tab")).toBe(false);
  });
});

describe("the plan panel and the calculator show it", () => {
  const baseQuote = (extra: Partial<PlanQuoteData> = {}): PlanQuoteData => ({
    quoteId: "q1", summaryAr: "جمع تعليقات", items: [{ capabilitySlug: "social-youtube-comments", params: { query: "x" }, targetVolumeMin: 1, targetVolumeMax: 57 }],
    targetVolumeMax: 57, unitPricePoints: 9, expectedPoints: 513, quotedPoints: 590, isAffordable: true, userBalance: 5000, outputFormats: ["xlsx"],
    expiresAt: new Date(Date.now() + 3600_000).toISOString(), status: "quoted", ...extra,
  });
  const render = (q: PlanQuoteData) => renderToStaticMarkup(createElement(PlanQuoteCard, { quote: q, onStart: () => {}, onSaveEdit: async () => {}, isStarting: false, available: 5000, creditValue: 0.1, onTopupShort: () => {}, onRefresh: async () => {} } as any));

  it("the plan card shows the range, «تقديري», what drives it and the promise", () => {
    const v = view(comments(2000));
    const html = render(baseQuote({ duration: v }));
    expect(html).toContain('data-testid="plan-duration"');
    expect(html).toContain(v.rangeAr);
    expect(html).toContain("تقديري");
    expect(html).toContain(v.driversAr);
    expect(html).toContain("سنبلغك عند الاكتمال.");
    expect(html).not.toContain('data-testid="plan-duration-long"');
    expect(render(baseQuote({ duration: view(comments(50000)) }))).toContain('data-testid="plan-duration-long"');
    expect(render(baseQuote())).not.toContain('data-testid="plan-duration"');
  });

  it("the calculator endpoint returns the same range logic for one request, and none when there is no price to show", async () => {
    const call = async (body: any) => (await estimatePost({ headers: new Headers(), json: async () => body } as any)).json();
    const ok = await call({ kind: "comments", platform: "youtube", volume: 5000 });
    expect(ok.result.status).toBe("ok");
    expect(ok.duration.labelAr).toBe("تقديري");
    expect(ok.duration.rangeAr).toMatch(/^من .+ إلى .+$/u);
    const people = await call({ kind: "people", volume: 3 });
    expect(people.duration.rangeAr).toBeTruthy();
    const open = await call({ kind: "comments", platform: "youtube", openEnded: true });
    expect(open.duration).toBeNull();
    // the calculator's range for a request equals the plan's range for the same records
    // 5,000 comments do not fit one request (the cap of 600 points holds 1,897 at 0.275 points): the endpoint states the duration of the records ONE request holds
    const same = missionDurationForPlan([{ capabilitySlug: "social-youtube-comments", targetVolumeMax: ok.result.maxVolumeInOneJob, params: {} }], "tab");
    expect(ok.duration.rangeAr).toBe(same!.rangeAr);
  });

  it("the estimator component renders the expected time from the endpoint's answer: the plan card's own function (UI pass 1, item 10), not a second range", () => {
    const source = readFileSync("src/components/calculator/MissionEstimator.tsx", "utf8");
    expect(source).toContain('data-testid="estimate-duration"');
    expect(source).toContain("answer.expectedAr");
    expect(source).not.toContain("answer.duration");
    expect(readFileSync("src/app/api/calculator/estimate/route.ts", "utf8")).toContain("expectedTimeOf(");
  });
});

describe("the chat path: the plan carries the duration and the price is unchanged", () => {
  const answer = (id: string, q: string, value?: string) => formatStructuredClarificationAnswers({ type: "clarification_answers", answers: [value ? { questionId: id, question: q, value } : { questionId: id, question: q, skipped: true }] } as any);

  it("a 2,000-comment YouTube request: the plan has a labelled range, and holds 1,500 comments (3 videos x 500, the most they can give) at 0.275 points, 475 held, cap 600", async () => {
    const db = createChatDb();
    const handler = new ChatHandler(db as any);
    (handler as any).llm.executeTurn = vi.fn(async () => { throw new Error("the model must not be called"); });
    await db.createRow({ tableId: "conversations", rowId: "c1", data: { userId: "u1", title: "x", status: "active", totalTokens: 0 } });
    const send = (message: string) => handler.handleUserMessage({ userId: "u1", conversationId: "c1", message, userBalance: 5000 }) as Promise<any>;
    await send("عايز كل تعليقات ٣ فيديوهات على يوتيوب عن منتخب مصر");
    const plan = await send(answer("volume_cap_required", "ما الحد الأقصى لعدد التعليقات الذي تريده؟", "٢٠٠٠ تعليق"));
    expect(plan.outputType).toBe("propose_plan");
    expect(plan.planQuote.duration.labelAr).toBe("تقديري");
    expect(plan.planQuote.duration.rangeAr).toMatch(/^(?:أقل من دقيقة|من .+ إلى .+)$/u);
    expect(plan.planQuote.duration.promiseAr).toBe("سنبلغك عند الاكتمال.");
    expect(plan.planQuote).toMatchObject({ targetVolumeMax: 1500, unitPricePoints: 0.275, quotedPoints: 475, pointsCap: 600 });
    expect(JSON.stringify(plan.planQuote.duration)).not.toMatch(/نقطة|590|٥٩٠/);
    // the chat sentence itself is unchanged (the range lives in the panel)
    expect(plan.contentAr).not.toContain("المدة المتوقعة");
  });
});
