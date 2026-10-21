import { describe, expect, it } from "vitest";
import {
  estimateOffTopic, PAGE_REJECT_ABOVE, PAGE_REJECT_MIN_REVIEWED, pageRejectedEventAr, reviewSocialPage,
} from "../src/lib/server/sampledReview";
import { ADVISORY_TIMEOUT_MS, SOCIAL_REVIEW_ROWS_PER_CALL, applyStrictAdvisory, reviewSocialRows, type AdvisoryVerdict, type RowAdvisorFn } from "../src/lib/server/rowReviewAdvisor";
import { regionNameAr } from "../src/lib/regionNames";
import { evaluateResearchRowRelevance } from "../src/lib/server/researchRelevanceGate";
import { getSocialCapability } from "../src/lib/socialSources";
import { runSocialChunk, type SocialCall } from "../src/lib/server/socialAdapter";

const verdict = (v: AdvisoryVerdict["verdict"], reasonAr = "سبب"): AdvisoryVerdict => ({ verdict: v, reasonAr });
const usage = (costUsd: number) => ({ inputTokens: 1500, outputTokens: 400, costUsd, model: "claude-haiku-5-5", latencyMs: 10 });

/** Football in Egypt, as a real page looks: a few on-topic comments, a club of another country, comments about nothing. */
const FIXTURE = {
  onTopic: ["الأهلي أحسن فريق في مصر", "ماتش المنتخب المصري كان جامد", "الزمالك محتاج مدرب جديد", "هدف صلاح في الماتش ده تحفة"],
  realMadrid: ["When Madrid was Madrid", "هلا مدريد", "ريال مدريد بطل أوروبا", "Hala Madrid y nada mas"],
  unrelated: ["افتح التنزيل عليك الله", "سوي العراق ضد اليابان", "شاركوا الفيديو من فضلكم"],
  reaction: ["اتفقت"],
};
const isEgyptFootball = (text: string) => /الأهلي|المنتخب المصري|الزمالك|صلاح/.test(text);

const rowsOf = (texts: string[], start = 0) => texts.map((text, i) => ({ index: start + i, row: { text: text, video_title: "فيديو" } }));
const advisorByText = (calls: Array<{ rows: number }> = []): RowAdvisorFn => async (input) => {
  calls.push({ rows: input.rows.length });
  return {
    verdicts: new Map(input.rows.map(({ index, row }) => [index, isEgyptFootball(String(row.text)) ? verdict("match") : verdict("no_match", "لا يتعلق بكرة القدم في مصر")])),
    usage: usage(0.004), failure: null,
  };
};
const REQUEST = "كرة القدم الدولة المطلوبة: مصر";

describe("the page review", () => {
  it("the estimate counts a «no match» and a doubt as off topic, and ignores rows nobody reviewed", () => {
    const verdicts = new Map<number, AdvisoryVerdict>([[0, verdict("match")], [1, verdict("no_match")], [2, verdict("uncertain")], [3, verdict("match")]]);
    expect(estimateOffTopic([0, 1, 2, 3, 4], verdicts)).toEqual({ size: 5, reviewed: 4, off: 2, rate: 0.5 });
    expect(estimateOffTopic([9], verdicts)).toEqual({ size: 1, reviewed: 0, off: 0, rate: null });
  });

  it("the limit is 60 percent: 15 of 25 is not above it, 16 of 25 is; at least eight rows must have been read", () => {
    expect(PAGE_REJECT_ABOVE).toBe(0.6);
    expect(15 / 25 > PAGE_REJECT_ABOVE).toBe(false);
    expect(16 / 25 > PAGE_REJECT_ABOVE).toBe(true);
    expect(PAGE_REJECT_MIN_REVIEWED).toBe(8);
  });

  it("the sentence for a rejected page is Arabic-only with Arabic-Indic digits", () => {
    expect(pageRejectedEventAr(0.64, 15)).toBe("نسبة المحتوى غير المرتبط بموضوعك في هذه الصفحة مرتفعة جداً (نحو ٦٤٪ من السجلات المراجَعة)، لذلك استُبعدت بقية سجلاتها (١٥ سجل) دون مراجعة فردية ولم تُحتسب.");
  });
});

describe("a page of a topic search through the page review: ONE call covers every row", () => {
  it("a mostly on-topic page of 20 rows: one call, every row has a verdict, a sampled-style off-topic row is not delivered", async () => {
    const texts = [...FIXTURE.unrelated, "كلام عن السياسة", ...Array.from({ length: 16 }, (_, i) => `${FIXTURE.onTopic[i % 4]} ${i}`)].slice(0, 20);
    const calls: Array<{ rows: number }> = [];
    const outcome = await reviewSocialPage({ advisor: advisorByText(calls), customerRequest: REQUEST, kind: "social-tiktok-comments", rows: rowsOf(texts), budgetUsd: 0.05 });
    expect(calls).toEqual([{ rows: 20 }]);
    expect(outcome.firstCall).toMatchObject({ size: 20, reviewed: 20, off: 4, pageRejected: false });
    expect(outcome.firstCall!.rate).toBeCloseTo(4 / 20, 5);
    expect(outcome.verdicts.size).toBe(20);
    expect(outcome.unreviewed).toEqual([]);
    expect(outcome.rejected).toEqual([]);
  });

  it("a page longer than one call is split in calls of 25 rows, and every row still gets a verdict when the first call is clean", async () => {
    const texts = Array.from({ length: 40 }, (_, i) => `${FIXTURE.onTopic[i % 4]} ${i}`);
    const calls: Array<{ rows: number }> = [];
    const outcome = await reviewSocialPage({ advisor: advisorByText(calls), customerRequest: REQUEST, kind: "social-x-posts", rows: rowsOf(texts), budgetUsd: 0.05 });
    expect(calls).toEqual([{ rows: SOCIAL_REVIEW_ROWS_PER_CALL }, { rows: 15 }]);
    expect(outcome.verdicts.size).toBe(40);
    expect(outcome.rejected).toEqual([]);
    expect(outcome.unreviewed).toEqual([]);
  });

  it("a mostly off-topic page of 22 rows: still one call; every row has its own verdict and only what the review confirms can be delivered", async () => {
    const texts = [...FIXTURE.realMadrid, ...FIXTURE.unrelated, ...FIXTURE.onTopic, ...FIXTURE.realMadrid, ...FIXTURE.unrelated, ...FIXTURE.realMadrid.slice(0, 4)];
    expect(texts).toHaveLength(22);
    const calls: Array<{ rows: number }> = [];
    const outcome = await reviewSocialPage({ advisor: advisorByText(calls), customerRequest: REQUEST, kind: "social-tiktok-comments", rows: rowsOf(texts), budgetUsd: 0.05 });
    expect(calls.map((c) => c.rows)).toEqual([22]);
    expect(outcome.firstCall).toMatchObject({ size: 22, reviewed: 22, pageRejected: false });
    expect(outcome.rejected).toEqual([]);
    expect(outcome.verdicts.size).toBe(22);
    const confirmed = [...outcome.verdicts].filter(([, v]) => v.verdict === "match").map(([i]) => i);
    expect(confirmed.map((i) => texts[i]).every(isEgyptFootball)).toBe(true);
    expect(outcome.unreviewed).toEqual([]);
  });

  it("a doubtful row is reviewed like every other row, in the same one call", async () => {
    const calls: Array<{ rows: number }> = [];
    const outcome = await reviewSocialPage({
      advisor: advisorByText(calls), customerRequest: REQUEST, kind: "social-tiktok-comments",
      rows: rowsOf([...FIXTURE.reaction, ...FIXTURE.onTopic]), budgetUsd: 0.05,
    });
    expect(calls).toEqual([{ rows: 5 }]);
    expect(outcome.verdicts.get(0)?.verdict).toBe("no_match");
  });

  it("a page whose review could not be read fails closed: every row is unreviewed (none of them by budget), and the review is tried once more", async () => {
    let calls = 0;
    const failing: RowAdvisorFn = async () => { calls += 1; return { verdicts: new Map(), usage: usage(0.001), failure: "bad_reply", stopReason: "max_tokens" }; };
    const texts = [...FIXTURE.reaction, ...FIXTURE.onTopic];
    const outcome = await reviewSocialPage({ advisor: failing, customerRequest: REQUEST, kind: "social-tiktok-comments", rows: rowsOf(texts), budgetUsd: 0.05 });
    expect(calls).toBe(2);
    expect(outcome.firstCall).toMatchObject({ reviewed: 0, rate: null, pageRejected: false });
    expect([...outcome.unreviewed].sort()).toEqual(texts.map((_, i) => i));
    expect(outcome.unreviewedByBudget).toEqual([]);
    expect(outcome.verdicts.size).toBe(0);
  });

  describe("a review that times out never delivers a row", () => {
    const timedOut: RowAdvisorFn = async () => ({ verdicts: new Map(), usage: null, failure: "timeout" });
    const pageOf = (n: number) => Array.from({ length: n }, (_, i) => `${FIXTURE.onTopic[i % FIXTURE.onTopic.length]} ${i}`);

    it("a page of 20 rows: nothing is delivered, all 20 are unreviewed", async () => {
      const texts = pageOf(20);
      const outcome = await reviewSocialPage({ advisor: timedOut, customerRequest: REQUEST, kind: "social-x-posts", rows: rowsOf(texts), budgetUsd: 0.05 });
      const reviews = texts.map((_, index) => ({ index, decision: "match" as const, reasonAr: "يتضمن نص السجل موضوع البحث" }));
      const applied = applyStrictAdvisory(reviews, outcome.verdicts);
      expect(applied.reviews.filter((rev) => rev.decision === "match")).toHaveLength(0);
      expect(applied.unreviewed).toBe(20);
      expect(outcome.firstCall?.reviewed).toBe(0);
    });

    it("the call is tried twice and never a third time, and a timeout that cost nothing adds nothing", async () => {
      let calls = 0;
      const counting: RowAdvisorFn = async (input) => { calls += 1; return timedOut(input); };
      const outcome = await reviewSocialPage({ advisor: counting, customerRequest: REQUEST, kind: "social-x-posts", rows: rowsOf(pageOf(20)), budgetUsd: 0.05 });
      expect(calls).toBe(2);
      expect(outcome.costUsd).toBe(0);
      expect(outcome.attempts).toHaveLength(2);
      expect(outcome.attempts.every((attempt) => attempt.failure === "timeout")).toBe(true);
    });

    it("a timeout on the first try and a good answer on the second: the page is judged normally and an on-topic page is delivered", async () => {
      let calls = 0;
      const flaky: RowAdvisorFn = async (input) => { calls += 1; return calls === 1 ? timedOut(input) : advisorByText()(input); };
      const texts = pageOf(20);
      const outcome = await reviewSocialPage({ advisor: flaky, customerRequest: REQUEST, kind: "social-x-posts", rows: rowsOf(texts), budgetUsd: 0.05 });
      expect(calls).toBe(2);
      expect(outcome.firstCall).toMatchObject({ reviewed: 20, off: 0, pageRejected: false });
      expect(outcome.unreviewed).toEqual([]);
      expect(outcome.attempts.map((attempt) => attempt.failure)).toEqual(["timeout", null]);
    });

    it("a missing key or a disabled reviewer is not tried again, and still fails closed", async () => {
      for (const failure of ["no_key", "disabled"] as const) {
        let calls = 0;
        const unavailable: RowAdvisorFn = async () => { calls += 1; return { verdicts: new Map(), usage: null, failure }; };
        const outcome = await reviewSocialPage({ advisor: unavailable, customerRequest: REQUEST, kind: "social-x-posts", rows: rowsOf(pageOf(20)), budgetUsd: 0.05 });
        expect(calls, failure).toBe(1);
        expect(outcome.firstCall?.reviewed, failure).toBe(0);
        expect(outcome.unreviewed, failure).toHaveLength(20);
        expect(outcome.unreviewedByBudget, failure).toEqual([]);
      }
    });

    it("a review that never ran because the budget was used up is not a failure, and its rows are NOT delivered: all 20 are unreviewed by budget", async () => {
      let calls = 0;
      const never: RowAdvisorFn = async (input) => { calls += 1; return advisorByText()(input); };
      const outcome = await reviewSocialPage({ advisor: never, customerRequest: REQUEST, kind: "social-x-posts", rows: rowsOf(pageOf(20)), budgetUsd: 0 });
      expect(calls).toBe(0);
      expect(outcome.stoppedBy).toBe("cap");
      expect(outcome.firstCall).toMatchObject({ reviewed: 0, rate: null, pageRejected: false });
      expect(outcome.unreviewed).toHaveLength(20);
      expect(outcome.unreviewedByBudget).toHaveLength(20);
      expect(outcome.verdicts.size).toBe(0);
    });
  });

  it("the budget of the job holds: a long page whose second call would exceed it leaves the rest unreviewed by budget, not delivered", async () => {
    // 40 rows; the first 25 hold 10 unrelated rows (40 percent, not above the rejection limit)
    const texts = [...FIXTURE.realMadrid, ...FIXTURE.unrelated, "Hala Madrid 2", "Hala Madrid 3", "Hala Madrid 4", ...Array.from({ length: 15 }, (_, i) => `${FIXTURE.onTopic[i % 4]} ${i}`), ...Array.from({ length: 15 }, (_, i) => `${FIXTURE.onTopic[i % 4]} ${i + 15}`)];
    expect(texts).toHaveLength(40);
    const costly: RowAdvisorFn = async (input) => ({ verdicts: new Map(input.rows.map(({ index, row }) => [index, isEgyptFootball(String(row.text)) ? verdict("match") : verdict("no_match")])), usage: usage(0.06), failure: null });
    const outcome = await reviewSocialPage({ advisor: costly, customerRequest: REQUEST, kind: "social-tiktok-comments", rows: rowsOf(texts), budgetUsd: 0.05 });
    expect(outcome.firstCall).toMatchObject({ size: 25, reviewed: 25, off: 10, pageRejected: false });
    expect(outcome.stoppedBy).toBe("cap");
    expect(outcome.unreviewed.length).toBe(15);
    expect(outcome.unreviewedByBudget.length).toBe(15);
    expect(outcome.costUsd).toBeCloseTo(0.06, 6);
  });

  it("an empty page asks for nothing", async () => {
    const calls: Array<{ rows: number }> = [];
    const outcome = await reviewSocialPage({ advisor: advisorByText(calls), customerRequest: REQUEST, kind: "social-tiktok-comments", rows: [], budgetUsd: 0.05 });
    expect(calls).toEqual([]);
    expect(outcome.firstCall).toBeNull();
    expect(outcome.unreviewedByBudget).toEqual([]);
  });
});

describe("the fixtures through the deterministic gate: all of them are presumed on topic (the review decides)", () => {
  const context = { capabilitySlug: "social-tiktok-comments", endpointId: "tikhub.tiktok.video.comments", params: { query: "كرة القدم", region: "EG" } };
  it("on-topic, Real Madrid and unrelated comments are presumed (the video decides); the bare «اتفقت» is a real comment, not flagged; emoji is dropped", () => {
    for (const text of [...FIXTURE.onTopic, ...FIXTURE.realMadrid, ...FIXTURE.unrelated]) expect(evaluateResearchRowRelevance({ text: text, video_title: "فيديو" }, context).decision, text).toBe("match");
    const reply = evaluateResearchRowRelevance({ text: "اتفقت" }, context);
    expect(reply.decision).toBe("match");
    expect(reply.suspicious).toBeUndefined();
    expect(evaluateResearchRowRelevance({ text: "🔥🔥" }, context).decision).toBe("no_match");
  });
});

describe("the country reaches the source's own filter and the reviewer's brief", () => {
  it("the Arabic name of a region code", () => {
    expect(regionNameAr("EG")).toBe("مصر");
    expect(regionNameAr("sa")).toBe("السعودية");
    expect(regionNameAr("ZZ")).toBeNull();
    expect(regionNameAr(undefined)).toBeNull();
  });

  it("TikTok's topic search is sent the region; a request without a country sends none; the other sources are unchanged", async () => {
    const seen: Array<{ endpoint: string; params: Record<string, any> }> = [];
    const call: SocialCall = async (source, params) => {
      seen.push({ endpoint: source.endpointId, params });
      if (params.aweme_id) return { ok: true, httpStatus: 200, data: { data: { comments: [{ cid: "1", text: "ماتش حلو", create_time: 1760000000 }], cursor: 0, has_more: 0 } }, costMicro: 1000, tregCallId: "c" };
      return { ok: true, httpStatus: 200, data: { aweme_list: [{ aweme_id: "7231337071831321900", desc: "كرة القدم", share_url: "https://www.tiktok.com/@u/video/7231337071831321900" }] }, costMicro: 1000, tregCallId: "s" };
    };
    const input = (params: Record<string, any>) => ({
      jobId: "job_x", userId: "u", step: 0, endpointId: "x", capabilitySlug: "social-tiktok-comments", method: "GET" as const, params,
      paginationStrategy: "cursor" as const, cursor: null, pageSize: 20, remainingNeeded: 20, targetVolumeMax: 20, deliveredSoFar: 0,
    });
    await runSocialChunk(input({ query: "كرة القدم", region: "EG", dateFrom: "2026-09-20", dateTo: "2026-10-20" }), { call });
    expect(seen.find((entry) => entry.endpoint === "tikhub.tiktok.search.videos")!.params).toMatchObject({ keyword: "كرة القدم", offset: 0, region: "EG" });
    seen.length = 0;
    await runSocialChunk(input({ query: "كرة القدم" }), { call });
    const withoutCountry = seen.find((entry) => entry.endpoint === "tikhub.tiktok.search.videos")!.params;
    expect(withoutCountry).toMatchObject({ keyword: "كرة القدم", offset: 0 });
    expect("region" in withoutCountry).toBe(false);
    const source = getSocialCapability("social-tiktok-comments")!.discover.query![0];
    expect(source.build({ query: "x", limit: 5, region: "EG" })).toMatchObject({ region: "EG" });
    // the trending feed and the account sources still take their own region/handle as before
    expect(getSocialCapability("social-tiktok-videos")!.discover.trending![0].build({ region: "EG", limit: 5 })).toBeTruthy();
  });
});

describe("the review call's own time limit", () => {
  it("is 20 seconds (it was 8, and 2 of 8 production calls were cut by it)", () => {
    expect(ADVISORY_TIMEOUT_MS).toBe(20_000);
  });

  it("is shortened near the caller's deadline (never below 3 seconds, never above the limit) and left alone when there is no deadline", async () => {
    const seen: Array<number | undefined> = [];
    const spy: RowAdvisorFn = async (input) => { seen.push(input.timeoutMs); return advisorByText()(input); };
    const row = { index: 0, row: { text: "الأهلي أحسن فريق في مصر" } };
    let now = 1_000_000;
    await reviewSocialRows({ advisor: spy, customerRequest: REQUEST, kind: "social-x-posts", rows: [row], budgetUsd: 1, deadlineMs: now + 60_000, now: () => now });
    await reviewSocialRows({ advisor: spy, customerRequest: REQUEST, kind: "social-x-posts", rows: [row], budgetUsd: 1, deadlineMs: now + 10_000, now: () => now });
    await reviewSocialRows({ advisor: spy, customerRequest: REQUEST, kind: "social-x-posts", rows: [row], budgetUsd: 1, deadlineMs: now + 1, now: () => now });
    await reviewSocialRows({ advisor: spy, customerRequest: REQUEST, kind: "social-x-posts", rows: [row], budgetUsd: 1 });
    expect(seen).toEqual([20_000, 16_000, 6_001, undefined]);
  });
});
