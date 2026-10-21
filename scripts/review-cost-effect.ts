/**
 * What the review cost cut does to review calls, review spend and what is delivered. FAKE DATA ONLY: no provider, no model, no database, no network.
 *
 * "after" runs the REAL functions of this branch (evaluateResearchRowRelevance, reviewSocialPage, judgeVideos, reviewStopForLowYield,
 * applyStrictAdvisory, evaluateProviderCallCap, socialReviewCapUsd) page by page and replays the worker's rules: one call per page, verdict-only
 * replies, early rejection of a long page, the low-yield stop, and a row the budget did not reach goes to the «غير مراجَع» sheet (never delivered).
 * "before" replays main (6e707da): the old gate (every row of a topic search presumed on topic), a sample of 15 rows, the whole page reviewed when
 * more than 40% of the sample is off topic, replies with an Arabic reason per row, and presumed rows delivered unreviewed once the budget is used up.
 *
 * The fake reviewer answers by the row's label (it never errs). A call is priced by tokens at the real prices (0.80 USD per million in, 4 USD per
 * million out; fitted to the live calls of 21 Oct 2026, where a call of 2,021 in and 1,381 out cost 0.007141 USD): about 450 prompt tokens plus 105 per
 * row in; out is 92 tokens per row with a reason (main) and 20 per row plus 15 with the verdict alone (after). It is a model, not a measurement.
 * Row mix (assumed): A = on topic and Egyptian (the reviewer says match), B = names the topic but is not what was asked (no match), C = names neither
 * the topic nor the country (no match; the pre-filter excludes it by code).
 * Run: npx tsx scripts/review-cost-effect.ts
 */
import { chargeForUnits } from "../src/lib/recordPricing";
import { evaluateProviderCallCap } from "../src/lib/server/providerCallCaps";
import { evaluateResearchRowRelevance } from "../src/lib/server/researchRelevanceGate";
import {
  applyAdvisoryToReviews, applyStrictAdvisory, REVIEW_CALL_COST_ESTIMATE_USD, reviewSocialRows, reviewStopForLowYield, socialReviewCapUsd,
  type AdvisoryVerdict, type RowAdvisorFn,
} from "../src/lib/server/rowReviewAdvisor";
import { isRetryableFailure, reviewSocialPage } from "../src/lib/server/sampledReview";
import { hasTopicEvidence, topicStems } from "../src/lib/server/topicMatch";
import { judgeVideos, type VideoEntry } from "../src/lib/server/videoRelevance";

const TOPIC = "الطاقة الشمسية";
const REQUEST = { query: TOPIC, region: "EG" };
const PAGE_ROWS = 20;
const PRICE_IN = 0.8e-6;
const PRICE_OUT = 4e-6;
const callCost = (rows: number, verdictOnly: boolean, inPerRow = 105) =>
  (450 + inPerRow * rows) * PRICE_IN + (verdictOnly ? 20 * rows + 15 : 92 * rows) * PRICE_OUT;

type Label = "A" | "B" | "C";
const seeded = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const textOf = (label: Label, i: number): string =>
  label === "A" ? `منشور مطابق عن الطاقة الشمسية في مصر رقم ${i}`
  : label === "B" ? `منشور عن الطاقة الشمسية في بلد آخر رقم ${i}`
  : i % 2 ? `الحياة رحلة طويلة والإنسان يبحث دائماً عن معنى ${i}` : `صباح الخير يا جماعة ${i}`;

const advisor = (counters: { calls: number }, verdictOnly: boolean): RowAdvisorFn => async (input) => {
  counters.calls += 1;
  return {
    verdicts: new Map(input.rows.map(({ index, row }) => [index, String(row.text).startsWith("منشور مطابق") ? { verdict: "match" as const, reasonAr: "x" } : { verdict: "no_match" as const, reasonAr: "x" }])),
    usage: { inputTokens: 0, outputTokens: 0, costUsd: callCost(input.rows.length, verdictOnly), model: "fake", latencyMs: 0 },
    failure: null,
  };
};

/** The gate as it was on main: every row of a topic search is presumed on topic; a long text with no word of the topic is flagged for the review. */
function oldGate(text: string) {
  const words = text.split(/\s+/u).filter(Boolean);
  return { decision: "match" as const, suspicious: words.length >= 6 && !hasTopicEvidence(topicStems(TOPIC), text) };
}

/** main's page review (6e707da), replayed: a sample of 15, the whole page when more than 40% of the sample is off topic, doubtful rows always reviewed. */
async function mainReviewPage(input: { advisor: RowAdvisorFn; rows: Array<{ index: number; row: Record<string, any> }>; suspicious: Set<number>; budgetUsd: number; random: () => number }) {
  const presumed = input.rows.map((e) => e.index).filter((i) => !input.suspicious.has(i));
  const pool = [...presumed];
  const sample: number[] = [];
  while (sample.length < 15 && pool.length > 0) sample.push(pool.splice(Math.min(pool.length - 1, Math.floor(input.random() * pool.length)), 1)[0]);
  const byIndex = new Map(input.rows.map((e) => [e.index, e]));
  const firstRows = [...input.rows.filter((e) => input.suspicious.has(e.index)), ...sample.map((i) => byIndex.get(i)!)];
  const out = { verdicts: new Map<number, AdvisoryVerdict>(), costUsd: 0, unreviewed: [] as number[], mustConfirm: new Set(input.suspicious), sampleOnly: new Set(sample) };
  if (firstRows.length === 0) return out;
  const review = (rows: typeof firstRows, budgetUsd: number) => reviewSocialRows({ advisor: input.advisor, customerRequest: "x", kind: "social-x-posts", rows, budgetUsd, callCostEstimateUsd: REVIEW_CALL_COST_ESTIMATE_USD });
  let first = await review(firstRows, input.budgetUsd);
  let cost = first.costUsd;
  if (first.verdicts.size === 0 && first.stoppedBy === "failed" && first.attempts.some((a) => isRetryableFailure(a.failure))) { const retry = await review(firstRows, Math.max(0, input.budgetUsd - first.costUsd)); cost += retry.costUsd; first = retry; }
  for (const [i, v] of first.verdicts) out.verdicts.set(i, v);
  out.costUsd = cost;
  out.unreviewed.push(...first.unreviewed.filter((i) => input.suspicious.has(i)));
  let off = 0, reviewed = 0;
  for (const i of sample) { const v = first.verdicts.get(i); if (v) { reviewed += 1; if (v.verdict !== "match") off += 1; } }
  if (reviewed > 0 && off / reviewed > 0.4) {
    const rest = presumed.filter((i) => !sample.includes(i));
    for (const i of presumed) out.mustConfirm.add(i);
    if (rest.length > 0) {
      const second = await review(rest.map((i) => byIndex.get(i)!), Math.max(0, input.budgetUsd - first.costUsd));
      for (const [i, v] of second.verdicts) out.verdicts.set(i, v);
      out.costUsd += second.costUsd;
      out.unreviewed.push(...second.unreviewed);
    }
    for (const i of sample) if (!out.verdicts.has(i)) out.unreviewed.push(i);
    out.sampleOnly.clear();
  }
  return out;
}

interface Result { budget: number; calls: number; spent: number; pages: number; seen: number; delivered: number; offTopicDelivered: number; deliveredWithoutVerdict: number; heldReview: number; unreviewedSheet: number; excludedByCode: number; charge: number }

async function simulatePosts(target: number, unit: number, mix: { A: number; B: number }, after: boolean, unlimitedBudget = false): Promise<Result> {
  const budget = unlimitedBudget ? 1_000 : socialReviewCapUsd(target, unit);
  const random = seeded(7);
  const counters = { calls: 0 };
  let spent = 0, seen = 0, accepted = 0, offTopicDelivered = 0, deliveredWithoutVerdict = 0, pages = 0, heldReview = 0, unreviewedSheet = 0, excludedByCode = 0;
  const batchUnits: number[] = [];
  while (accepted < target && pages < 45) {
    const labels: Label[] = Array.from({ length: PAGE_ROWS }, () => { const r = random(); return r < mix.A ? "A" : r < mix.A + mix.B ? "B" : "C"; });
    const rows = labels.map((label, i) => ({ index: i, row: { text: textOf(label, pages * PAGE_ROWS + i) } }));
    type Rev = { index: number; decision: "match" | "no_match" | "uncertain"; suspicious?: boolean; reasonAr?: string };
    const reviews: Rev[] = rows.map(({ index, row }) => ({ index, ...(after ? evaluateResearchRowRelevance(row, { capabilitySlug: "social-x-posts", endpointId: "anyapi.x.search.posts", params: REQUEST }) : oldGate(row.text)) } as Rev));
    excludedByCode += reviews.filter((r) => r.decision === "no_match").length;
    const rowsSeenBefore = seen;
    seen += rows.length;
    const matched = reviews.filter((r) => r.decision === "match").map((r) => ({ index: r.index, row: rows[r.index].row }));
    pages += 1;
    let delivered: number[] = [];
    let budgetUsedUp = false;
    let reviewFailedStop = false;
    const verdicts = new Map<number, AdvisoryVerdict>();
    if (after && reviewStopForLowYield({ spentUsd: spent, budgetUsd: budget, rowsSeen: pages === 1 ? undefined : rowsSeenBefore, accepted })) {
      unreviewedSheet += matched.length;
      batchUnits.push(0);
      break;
    }
    if (matched.length > 0) {
      let next: Rev[] = reviews;
      if (after) {
        const outcome = await reviewSocialPage({ advisor: advisor(counters, true), customerRequest: "x", kind: "social-x-posts", rows: matched, budgetUsd: Math.max(0, budget - spent), callCostEstimateUsd: REVIEW_CALL_COST_ESTIMATE_USD });
        spent += outcome.costUsd;
        for (const [i, v] of outcome.verdicts) verdicts.set(i, v);
        const rejected = new Set(outcome.rejected);
        next = reviews.map((r) => (rejected.has(r.index) && r.decision === "match" ? { ...r, decision: "no_match" as const } : r));
        next = applyStrictAdvisory(next as any, outcome.verdicts).reviews as any;
        const byBudget = new Set(outcome.unreviewedByBudget);
        unreviewedSheet += next.filter((r) => byBudget.has(r.index) && r.decision === "uncertain").length;
        budgetUsedUp = byBudget.size > 0;
        const failed = outcome.unreviewed.length - byBudget.size;
        reviewFailedStop = failed > 0 && next.every((r) => r.decision !== "match");
        heldReview += next.filter((r) => r.decision === "uncertain" && !byBudget.has(r.index)).length;
      } else {
        const suspicious = new Set(reviews.filter((r) => r.decision === "match" && r.suspicious).map((r) => r.index));
        const outcome = await mainReviewPage({ advisor: advisor(counters, false), rows: matched, suspicious, budgetUsd: Math.max(0, budget - spent), random });
        spent += outcome.costUsd;
        for (const [i, v] of outcome.verdicts) verdicts.set(i, v);
        const strictApplied = applyStrictAdvisory(reviews as any, outcome.verdicts, { only: (rev: any) => outcome.mustConfirm.has(rev.index) });
        next = applyAdvisoryToReviews(strictApplied.reviews as any, new Map([...outcome.verdicts].filter(([i]) => outcome.sampleOnly.has(i)))).reviews as any;
        heldReview += next.filter((r) => r.decision === "uncertain").length;
        const deliverableWithoutReview = reviews.filter((r) => r.decision === "match" && !outcome.mustConfirm.has(r.index)).length;
        reviewFailedStop = strictApplied.unreviewed > 0 && deliverableWithoutReview === 0;
      }
      delivered = next.filter((r) => r.decision === "match").map((r) => r.index);
    }
    for (const index of delivered) {
      if (!String(rows[index].row.text).startsWith("منشور مطابق")) offTopicDelivered += 1;
      if (!verdicts.has(index)) deliveredWithoutVerdict += 1;
    }
    accepted += delivered.length;
    batchUnits.push(delivered.length);
    if (after && budgetUsedUp) break;
    if (reviewFailedStop) break;
    if (evaluateProviderCallCap({ pagesDone: pages, acceptedThisPage: delivered.length, priorBatchUnits: batchUnits.slice(0, -1), targetMax: target, pageSize: PAGE_ROWS, kind: "feed" })) break;
  }
  const delivered = Math.min(accepted, target);
  return { budget, calls: counters.calls, spent, pages, seen, delivered, offTopicDelivered, deliveredWithoutVerdict, heldReview, unreviewedSheet, excludedByCode, charge: chargeForUnits(delivered, unit) };
}

/** Comments of a topic search are judged by their video: the review is one call on the list of videos, never per comment. */
async function simulateComments(target: number, unit: number, after: boolean, unlimitedBudget = false): Promise<Result> {
  const budget = unlimitedBudget ? 1_000 : socialReviewCapUsd(target, unit);
  const random = seeded(11);
  const counters = { calls: 0 };
  let spent = 0, delivered = 0, pages = 0, seenComments = 0, offTopicDelivered = 0, unreviewedSheet = 0;
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
    const advisorFn: RowAdvisorFn = async (input) => {
      counters.calls += 1;
      return { verdicts: new Map(input.rows.map(({ index, row }) => [index, String(row.title).startsWith("منشور مطابق") ? { verdict: "match" as const, reasonAr: "x" } : { verdict: "no_match" as const, reasonAr: "x" }])), usage: { inputTokens: 0, outputTokens: 0, costUsd: callCost(input.rows.length, after, 150), model: "fake", latencyMs: 0 }, failure: null };
    };
    const outcome = await judgeVideos({ advisor: advisorFn, customerRequest: "x", kind: "social-tiktok-comments-video-list", videos, request: REQUEST, budgetUsd: Math.max(0, budget - spent), callCostEstimateUsd: REVIEW_CALL_COST_ESTIMATE_USD });
    spent += outcome.costUsd;
    unreviewedSheet += [...outcome.judgements.values()].filter((j) => j.budget).length * COMMENTS_PER_VIDEO;
    const adopted = videos.filter((v) => outcome.judgements.get(v.key)?.decision === "match");
    const comments = adopted.length * COMMENTS_PER_VIDEO;
    seenComments += comments;
    delivered += comments;
    for (const v of adopted) if (v.label === "off") offTopicDelivered += COMMENTS_PER_VIDEO;
    batchUnits.push(comments);
    pages += 1;
    if (after && reviewStopForLowYield({ spentUsd: spent, budgetUsd: budget, rowsSeen: seenComments, accepted: delivered })) break;
    if (after && [...outcome.judgements.values()].some((j) => j.budget)) break;
    if (evaluateProviderCallCap({ pagesDone: pages, acceptedThisPage: comments, priorBatchUnits: batchUnits.slice(0, -1), targetMax: target, pageSize: 30, kind: "feed" })) break;
  }
  const out = Math.min(delivered, target);
  return { budget, calls: counters.calls, spent, pages, seen: seenComments, delivered: out, offTopicDelivered, deliveredWithoutVerdict: 0, heldReview: 0, unreviewedSheet, excludedByCode: 0, charge: chargeForUnits(out, unit) };
}

const row = (label: string, r: Result) =>
  `| ${label} | ${r.calls} | ${r.spent.toFixed(4)} | ${r.budget.toFixed(4)} | ${r.pages} | ${r.seen} | ${r.delivered} | ${r.deliveredWithoutVerdict} | ${r.offTopicDelivered} | ${r.heldReview} | ${r.unreviewedSheet} | ${r.excludedByCode} |`;

async function main() {
  const cases: Array<{ name: string; run: (after: boolean, unlimited: boolean) => Promise<Result> }> = [
    { name: "X 300 posts, narrow topic (25% of rows on topic)", run: (after, u) => simulatePosts(300, 0.11715, { A: 0.25, B: 0.45 }, after, u) },
    { name: "X 300 posts, broad topic (80% of rows on topic)", run: (after, u) => simulatePosts(300, 0.11715, { A: 0.8, B: 0.15 }, after, u) },
    { name: "Comments 300 (videos judged, 10 comments per adopted video)", run: (after, u) => simulateComments(300, 0.275, after, u) },
  ];
  console.log("| case | review calls | review USD | budget USD | pages | rows seen | delivered | delivered with no verdict | off-topic delivered | held (review sheet) | «غير مراجَع» sheet | excluded by code |");
  console.log("|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const unlimited of [false, true]) {
    for (const c of cases) {
      const tag = unlimited ? "budget not binding" : "real budget";
      const before = await c.run(false, unlimited);
      const after = await c.run(true, unlimited);
      console.log(row(`${c.name} [${tag}] — before (main)`, before));
      console.log(row(`${c.name} [${tag}] — after`, after));
      const cut = before.spent > 0 ? Math.round((1 - after.spent / before.spent) * 100) : 0;
      const callCut = before.calls > 0 ? Math.round((1 - after.calls / before.calls) * 100) : 0;
      const perRow = (r: Result) => (r.delivered > 0 ? (r.spent / r.delivered).toFixed(5) : "n/a");
      console.log(`| ${c.name} [${tag}] — change | ${callCut}% fewer calls | ${cut}% less | USD per delivered row: ${perRow(before)} → ${perRow(after)} | | | | | | | | |`);
    }
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
