/**
 * What the review cost cut does to review calls and review spend. FAKE DATA ONLY: no provider, no model, no database, no network.
 * It runs the REAL functions (evaluateResearchRowRelevance, reviewSocialPage, judgeVideos, reviewStopForLowYield, evaluateProviderCallCap,
 * socialReviewCapUsd) page by page and replays the worker's own rules; "before" switches the three new rules off (no pre-filter, no page
 * rejection, no low-yield stop), "after" has them on.
 *
 * The fake reviewer answers by the row's label (it never errs) and a call costs 0.0040 + 0.0003 x rows USD: an ASSUMED model fitted to the
 * three calls of the live job of 21 Oct 2026 (0.007514, 0.010298, 0.007141 USD for pages of about 12 to 20 rows). It is a model, not a measurement.
 * Row mix (assumed): A = on topic and Egyptian (the reviewer says match), B = names the topic but is not what was asked (the reviewer says
 * no match), C = names neither the topic nor the country (the reviewer says no match; the new pre-filter excludes it by code).
 * Run: npx tsx scripts/review-cost-effect.ts
 */
import { chargeForUnits } from "../src/lib/recordPricing";
import { evaluateProviderCallCap } from "../src/lib/server/providerCallCaps";
import { evaluateResearchRowRelevance } from "../src/lib/server/researchRelevanceGate";
import {
  applyAdvisoryToReviews, applyStrictAdvisory, REVIEW_CALL_COST_ESTIMATE_USD, reviewStopForLowYield, socialReviewCapUsd, type RowAdvisorFn,
} from "../src/lib/server/rowReviewAdvisor";
import { reviewSocialPage } from "../src/lib/server/sampledReview";
import { hasTopicEvidence, topicStems } from "../src/lib/server/topicMatch";
import { judgeVideos, type VideoEntry } from "../src/lib/server/videoRelevance";

const TOPIC = "الطاقة الشمسية";
const REQUEST = { query: TOPIC, region: "EG" };
const PAGE_ROWS = 20;
const callCost = (rows: number) => 0.004 + 0.0003 * rows;

type Label = "A" | "B" | "C";
const seeded = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

const textOf = (label: Label, i: number): string =>
  label === "A" ? `منشور مطابق عن الطاقة الشمسية في مصر رقم ${i}`
  : label === "B" ? `منشور عن الطاقة الشمسية في بلد آخر رقم ${i}`
  : i % 2 ? `الحياة رحلة طويلة والإنسان يبحث دائماً عن معنى ${i}` : `صباح الخير يا جماعة ${i}`;

const advisor = (counters: { calls: number }): RowAdvisorFn => async (input) => {
  counters.calls += 1;
  return {
    verdicts: new Map(input.rows.map(({ index, row }) => [index, String(row.text).startsWith("منشور مطابق") ? { verdict: "match" as const, reasonAr: "x" } : { verdict: "no_match" as const, reasonAr: "x" }])),
    usage: { inputTokens: 0, outputTokens: 0, costUsd: callCost(input.rows.length), model: "fake", latencyMs: 0 },
    failure: null,
  };
};

/** The gate as it was before this change: every row of a topic search is presumed on topic; a long text with no word of the topic is flagged for the review. */
function oldGate(text: string) {
  const stems = topicStems(TOPIC);
  const words = text.split(/\s+/u).filter(Boolean);
  return { decision: "match" as const, suspicious: words.length >= 6 && !hasTopicEvidence(stems, text) };
}

async function simulatePosts(target: number, unit: number, mix: { A: number; B: number }, after: boolean, unlimitedBudget = false) {
  const budget = unlimitedBudget ? 1_000 : socialReviewCapUsd(target, unit);
  const random = seeded(7);
  const counters = { calls: 0 };
  let spent = 0, seen = 0, accepted = 0, offTopicDelivered = 0, pages = 0, held = 0, excludedByCode = 0, stopped = false;
  const batchUnits: number[] = [];
  const maxPages = 45; // maxPagesForJob(300, 20, "feed")
  while (accepted < target && pages < maxPages) {
    const labels: Label[] = Array.from({ length: PAGE_ROWS }, () => { const r = random(); return r < mix.A ? "A" : r < mix.A + mix.B ? "B" : "C"; });
    const rows = labels.map((label, i) => ({ index: i, row: { text: textOf(label, pages * PAGE_ROWS + i) } }));
    const reviews = rows.map(({ index, row }) => ({ index, ...(after ? evaluateResearchRowRelevance(row, { capabilitySlug: "social-x-posts", endpointId: "anyapi.x.search.posts", params: REQUEST }) : oldGate(row.text)) } as { index: number; decision: "match" | "no_match" | "uncertain"; suspicious?: boolean; reasonAr?: string }));
    excludedByCode += reviews.filter((r) => r.decision === "no_match").length;
    seen += rows.length;
    const matched = reviews.filter((r) => r.decision === "match").map((r) => ({ index: r.index, row: rows[r.index].row }));
    let delivered: number[] = [];
    let deliverableWithoutReview = 0;
    let unreviewed = 0;
    const stop = after && reviewStopForLowYield({ spentUsd: spent, budgetUsd: budget, rowsSeen: pages === 0 ? undefined : seen - rows.length, accepted });
    if (stop) {
      held += matched.length;
      stopped = true;
      pages += 1;
      break;
    }
    if (matched.length > 0) {
      const suspicious = new Set(reviews.filter((r) => r.decision === "match" && r.suspicious).map((r) => r.index));
      const outcome = await reviewSocialPage({
        advisor: advisor(counters), customerRequest: "x", kind: "social-x-posts", rows: matched, suspicious,
        budgetUsd: Math.max(0, budget - spent), callCostEstimateUsd: REVIEW_CALL_COST_ESTIMATE_USD, random, rejectPageAbove: after ? undefined : Infinity,
      });
      spent += outcome.costUsd;
      deliverableWithoutReview = reviews.filter((r) => r.decision === "match" && !outcome.mustConfirm.has(r.index)).length;
      const rejected = new Set(outcome.rejected);
      let next = reviews.map((r) => (rejected.has(r.index) && r.decision === "match" ? { ...r, decision: "no_match" as const } : r));
      const applied = applyStrictAdvisory(next as any, outcome.verdicts, { only: (rev: any) => outcome.mustConfirm.has(rev.index) });
      unreviewed = applied.unreviewed;
      next = applied.reviews as any;
      next = applyAdvisoryToReviews(next as any, new Map([...outcome.verdicts].filter(([i]) => outcome.sampleOnly.has(i)))).reviews as any;
      delivered = next.filter((r) => r.decision === "match").map((r) => r.index);
      held += next.filter((r) => r.decision === "uncertain").length;
    }
    for (const index of delivered) if (!String(rows[index].row.text).startsWith("منشور مطابق")) offTopicDelivered += 1;
    accepted += delivered.length;
    batchUnits.push(delivered.length);
    pages += 1;
    if (unreviewed > 0 && deliverableWithoutReview === 0) { stopped = true; break; }
    if (evaluateProviderCallCap({ pagesDone: pages, acceptedThisPage: delivered.length, priorBatchUnits: batchUnits.slice(0, -1), targetMax: target, pageSize: PAGE_ROWS, kind: "feed" })) break;
  }
  accepted = Math.min(accepted, target);
  return { budget, calls: counters.calls, spent, pages, seen, delivered: accepted, offTopicDelivered, held, excludedByCode, stopped, charge: chargeForUnits(accepted, unit) };
}

/** Comments of a topic search are judged by their video: the review is one call on the list of videos, never per comment. */
async function simulateComments(target: number, unit: number, after: boolean, unlimitedBudget = false) {
  const budget = unlimitedBudget ? 1_000 : socialReviewCapUsd(target, unit);
  const random = seeded(11);
  const counters = { calls: 0 };
  let spent = 0, delivered = 0, pages = 0, seenComments = 0, offTopicDelivered = 0, stopped = false;
  const batchUnits: number[] = [];
  const COMMENTS_PER_VIDEO = 10;
  while (delivered < target && pages < 45) {
    // 25 candidate videos: 15% say topic AND country in their title (settled by evidence), 25% are on topic but say no country (the review), 60% are not
    const videos: Array<VideoEntry & { label: string }> = Array.from({ length: 25 }, (_, i) => {
      const r = random();
      const label = r < 0.15 ? "evidence" : r < 0.4 ? "review_match" : "off";
      const title = label === "evidence" ? `الطاقة الشمسية في مصر ${pages}-${i}` : label === "review_match" ? `منشور مطابق عن الطاقة الشمسية ${pages}-${i}` : `فيديو عن موضوع آخر ${pages}-${i}`;
      return { key: `v${pages}-${i}`, title, channel: "", rowIndexes: [], sampleComments: [], label };
    });
    const outcome = await judgeVideos({
      advisor: async (input) => { counters.calls += 1; return { verdicts: new Map(input.rows.map(({ index, row }) => [index, String(row.title).startsWith("منشور مطابق") ? { verdict: "match" as const, reasonAr: "x" } : { verdict: "no_match" as const, reasonAr: "x" }])), usage: { inputTokens: 0, outputTokens: 0, costUsd: callCost(input.rows.length), model: "fake", latencyMs: 0 }, failure: null }; },
      customerRequest: "x", kind: "social-tiktok-comments-video-list", videos, request: REQUEST, budgetUsd: Math.max(0, budget - spent), callCostEstimateUsd: REVIEW_CALL_COST_ESTIMATE_USD,
    });
    spent += outcome.costUsd;
    const adopted = videos.filter((v) => outcome.judgements.get(v.key)?.decision === "match");
    const comments = adopted.length * COMMENTS_PER_VIDEO;
    seenComments += comments;
    delivered += comments;
    for (const v of adopted) if (v.label === "off") offTopicDelivered += COMMENTS_PER_VIDEO;
    batchUnits.push(comments);
    pages += 1;
    // the low-yield stop looks at comments seen against comments accepted: every comment read belongs to an adopted video, so it never fires here
    if (after && reviewStopForLowYield({ spentUsd: spent, budgetUsd: budget, rowsSeen: seenComments, accepted: delivered })) { stopped = true; break; }
    if (evaluateProviderCallCap({ pagesDone: pages, acceptedThisPage: comments, priorBatchUnits: batchUnits.slice(0, -1), targetMax: target, pageSize: 30, kind: "feed" })) break;
  }
  delivered = Math.min(delivered, target);
  return { budget, calls: counters.calls, spent, pages, seen: seenComments, delivered, offTopicDelivered, held: 0, excludedByCode: 0, stopped, charge: chargeForUnits(delivered, unit) };
}

const row = (label: string, r: Awaited<ReturnType<typeof simulatePosts>>) =>
  `| ${label} | ${r.calls} | ${r.spent.toFixed(4)} | ${r.budget.toFixed(4)} | ${r.pages} | ${r.seen} | ${r.delivered} | ${r.offTopicDelivered} | ${r.held} | ${r.excludedByCode} | ${r.stopped ? "yes" : "no"} |`;

async function main() {
  const cases: Array<{ name: string; run: (after: boolean, unlimited: boolean) => ReturnType<typeof simulatePosts> }> = [
    { name: "X 300 posts, narrow topic (25% of rows on topic)", run: (after, u) => simulatePosts(300, 0.11715, { A: 0.25, B: 0.45 }, after, u) },
    { name: "X 300 posts, broad topic (80% of rows on topic)", run: (after, u) => simulatePosts(300, 0.11715, { A: 0.8, B: 0.15 }, after, u) },
    { name: "Comments 300 (videos judged, 10 comments per adopted video)", run: (after, u) => simulateComments(300, 0.275, after, u) },
  ];
  console.log("| case | review calls | review USD | budget USD | pages | rows seen | delivered | off-topic delivered | held | excluded by code | stopped early |");
  console.log("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const unlimited of [false, true]) {
    for (const c of cases) {
      const tag = unlimited ? "budget not binding" : "real budget";
      const before = await c.run(false, unlimited);
      const after = await c.run(true, unlimited);
      console.log(row(`${c.name} [${tag}] — before`, before));
      console.log(row(`${c.name} [${tag}] — after`, after));
      const cut = before.spent > 0 ? Math.round((1 - after.spent / before.spent) * 100) : 0;
      const callCut = before.calls > 0 ? Math.round((1 - after.calls / before.calls) * 100) : 0;
      console.log(`| ${c.name} [${tag}] — change | ${callCut}% fewer calls | ${cut}% less | | | | | | | | |`);
    }
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
