import { describe, expect, it } from "vitest";
import {
  estimateOffTopic, highOffTopicEventAr, OFF_TOPIC_STRICT_ABOVE, pickReviewSample, REVIEW_SAMPLE_ROWS, reviewSocialPage,
} from "../src/lib/server/sampledReview";
import { SOCIAL_REVIEW_ROWS_PER_CALL, type AdvisoryVerdict, type RowAdvisorFn } from "../src/lib/server/rowReviewAdvisor";
import { regionNameAr } from "../src/lib/regionNames";
import { evaluateResearchRowRelevance } from "../src/lib/server/researchRelevanceGate";
import { getSocialCapability } from "../src/lib/socialSources";
import { runSocialChunk, type SocialCall } from "../src/lib/server/socialAdapter";

const verdict = (v: AdvisoryVerdict["verdict"], reasonAr = "سبب"): AdvisoryVerdict => ({ verdict: v, reasonAr });
const firstOf = () => 0; // always the first of what is left
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

describe("the sample", () => {
  it("is at most fifteen distinct rows, from the presumed ones only, and deterministic for a given random source", () => {
    const indexes = Array.from({ length: 40 }, (_, i) => i);
    const sample = pickReviewSample(indexes, REVIEW_SAMPLE_ROWS, firstOf);
    expect(sample).toEqual(Array.from({ length: 15 }, (_, i) => i));
    let seed = 3;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const random = pickReviewSample(indexes, 15, next);
    expect(new Set(random).size).toBe(15);
    expect(random.every((i) => i >= 0 && i < 40)).toBe(true);
    expect(pickReviewSample([1, 2, 3], 15, firstOf)).toEqual([1, 2, 3]);
    expect(pickReviewSample([], 15, firstOf)).toEqual([]);
  });

  it("the estimate counts a «no match» and a doubt as off topic, and ignores rows nobody reviewed", () => {
    const verdicts = new Map<number, AdvisoryVerdict>([[0, verdict("match")], [1, verdict("no_match")], [2, verdict("uncertain")], [3, verdict("match")]]);
    expect(estimateOffTopic([0, 1, 2, 3, 4], verdicts)).toEqual({ size: 5, reviewed: 4, off: 2, rate: 0.5 });
    expect(estimateOffTopic([9], verdicts)).toEqual({ size: 1, reviewed: 0, off: 0, rate: null });
  });

  it("the limit is 40 percent: 6 of 15 is not above it, 7 of 15 is", () => {
    expect(OFF_TOPIC_STRICT_ABOVE).toBe(0.4);
    expect(6 / 15 > OFF_TOPIC_STRICT_ABOVE).toBe(false);
    expect(7 / 15 > OFF_TOPIC_STRICT_ABOVE).toBe(true);
  });

  it("the sentence for a strict page is Arabic-only with Arabic-Indic digits", () => {
    expect(highOffTopicEventAr(0.6)).toBe("نسبة المحتوى غير المرتبط بموضوعك في هذه الصفحة مرتفعة (نحو ٦٠٪ من العيّنة)، لذلك راجعنا كل سجلاتها قبل التسليم.");
  });
});

describe("a page of a topic search through the sampled review", () => {
  it("a mostly on-topic page: one call on a sample; the page is delivered, a sampled off-topic row is not", async () => {
    // 16 on-topic rows and 4 unrelated rows placed first, so the first-fifteen sample catches 4 of them: 4/15 = 27 percent, below the limit
    const texts = [...FIXTURE.unrelated, "كلام عن السياسة", ...Array.from({ length: 16 }, (_, i) => `${FIXTURE.onTopic[i % 4]} ${i}`)].slice(0, 20);
    const calls: Array<{ rows: number }> = [];
    const outcome = await reviewSocialPage({ advisor: advisorByText(calls), customerRequest: REQUEST, kind: "social-tiktok-comments", rows: rowsOf(texts), suspicious: new Set(), budgetUsd: 0.05, random: firstOf });
    expect(calls).toEqual([{ rows: 15 }]);
    expect(outcome.sample).toMatchObject({ size: 15, reviewed: 15, off: 4, strictPage: false });
    expect(outcome.sample!.rate).toBeCloseTo(4 / 15, 5);
    expect(outcome.mustConfirm.size).toBe(0);
    expect([...outcome.sampleOnly]).toHaveLength(15);
  });

  it("a mostly off-topic page: the whole page goes through the review, and only what the review confirms can be delivered", async () => {
    const texts = [...FIXTURE.realMadrid, ...FIXTURE.unrelated, ...FIXTURE.onTopic, ...FIXTURE.realMadrid, ...FIXTURE.unrelated, ...FIXTURE.realMadrid.slice(0, 4)];
    expect(texts).toHaveLength(22);
    const calls: Array<{ rows: number }> = [];
    const outcome = await reviewSocialPage({ advisor: advisorByText(calls), customerRequest: REQUEST, kind: "social-tiktok-comments", rows: rowsOf(texts), suspicious: new Set(), budgetUsd: 0.05, random: firstOf });
    expect(outcome.sample?.strictPage).toBe(true);
    expect(calls.map((c) => c.rows)).toEqual([15, 7]);
    expect(outcome.mustConfirm.size).toBe(22);
    expect(outcome.sampleOnly.size).toBe(0);
    expect(outcome.verdicts.size).toBe(22);
    const confirmed = [...outcome.verdicts].filter(([, v]) => v.verdict === "match").map(([i]) => i);
    expect(confirmed.map((i) => texts[i]).every(isEgyptFootball)).toBe(true);
    expect(outcome.unreviewed).toEqual([]);
  });

  it("the doubtful rows are always reviewed, together with the sample, in one call", async () => {
    const calls: Array<{ rows: number }> = [];
    const outcome = await reviewSocialPage({
      advisor: advisorByText(calls), customerRequest: REQUEST, kind: "social-tiktok-comments",
      rows: rowsOf([...FIXTURE.reaction, ...FIXTURE.onTopic]), suspicious: new Set([0]), budgetUsd: 0.05, random: firstOf,
    });
    expect(calls).toEqual([{ rows: 5 }]);
    expect(outcome.mustConfirm).toEqual(new Set([0]));
    expect(outcome.verdicts.get(0)?.verdict).toBe("no_match");
  });

  it("a sample that could not be reviewed gives no estimate: the page is not held back for it, and the doubtful rows stay unreviewed", async () => {
    const failing: RowAdvisorFn = async () => ({ verdicts: new Map(), usage: usage(0.001), failure: "bad_reply", stopReason: "max_tokens" });
    const outcome = await reviewSocialPage({ advisor: failing, customerRequest: REQUEST, kind: "social-tiktok-comments", rows: rowsOf([...FIXTURE.reaction, ...FIXTURE.onTopic]), suspicious: new Set([0]), budgetUsd: 0.05, random: firstOf });
    expect(outcome.sample).toMatchObject({ reviewed: 0, rate: null, strictPage: false });
    expect(outcome.unreviewed).toEqual([0]);
    expect(outcome.mustConfirm).toEqual(new Set([0]));
  });

  it("the budget of the job holds: a strict page whose second call would exceed it leaves the rest unreviewed, not delivered", async () => {
    const texts = [...FIXTURE.realMadrid, ...FIXTURE.unrelated, ...FIXTURE.realMadrid, ...FIXTURE.unrelated, ...FIXTURE.realMadrid, ...FIXTURE.onTopic];
    const costly: RowAdvisorFn = async (input) => ({ verdicts: new Map(input.rows.map(({ index }) => [index, verdict("no_match")])), usage: usage(0.06), failure: null });
    const outcome = await reviewSocialPage({ advisor: costly, customerRequest: REQUEST, kind: "social-tiktok-comments", rows: rowsOf(texts), suspicious: new Set(), budgetUsd: 0.05, random: firstOf });
    expect(outcome.sample?.strictPage).toBe(true);
    expect(outcome.stoppedBy).toBe("cap");
    expect(outcome.unreviewed.length).toBe(texts.length - 15);
    expect(outcome.costUsd).toBeCloseTo(0.06, 6);
  });

  it("an empty page asks for nothing", async () => {
    const calls: Array<{ rows: number }> = [];
    const outcome = await reviewSocialPage({ advisor: advisorByText(calls), customerRequest: REQUEST, kind: "social-tiktok-comments", rows: [], suspicious: new Set(), budgetUsd: 0.05 });
    expect(calls).toEqual([]);
    expect(outcome.sample).toBeNull();
    expect(SOCIAL_REVIEW_ROWS_PER_CALL).toBeGreaterThanOrEqual(REVIEW_SAMPLE_ROWS);
  });
});

describe("the fixtures through the deterministic gate: all of them are presumed, which is why the sample exists", () => {
  const context = { capabilitySlug: "social-tiktok-comments", endpointId: "tikhub.tiktok.video.comments", params: { query: "كرة القدم", region: "EG" } };
  it("on-topic, Real Madrid and unrelated comments are presumed; the bare «اتفقت» is flagged; emoji is dropped", () => {
    for (const text of [...FIXTURE.onTopic, ...FIXTURE.realMadrid, ...FIXTURE.unrelated]) expect(evaluateResearchRowRelevance({ text: text, video_title: "فيديو" }, context).decision, text).toBe("match");
    expect(evaluateResearchRowRelevance({ text: "اتفقت" }, context)).toMatchObject({ decision: "match", suspicious: true });
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
