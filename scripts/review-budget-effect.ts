/**
 * What the review budget (20% of a job's expected charge) does to delivery. Fake data only: no provider, no model, no database, no network.
 * It runs the REAL functions (socialReviewCapUsd, reviewSocialPage) with a fake reviewer whose call costs the measured 0.0047 USD per 25 rows
 * (relevance_review, 9 calls in llm_usage) and replays the worker's own delivery rule page by page:
 *  - a doubtful (flagged) row is delivered only if the review confirms it; an unreviewed one goes to the review sheet (not delivered, not charged);
 *  - a presumed row is delivered without review unless the sample of its page is mostly off topic (never here: the fake reviewer says match);
 *  - paging stops when a page had unreviewed rows and nothing on it could be delivered without the review.
 * Run: npx tsx scripts/review-budget-effect.ts
 */
import { chargeForUnits } from "../src/lib/recordPricing";
import { REVIEW_CALL_COST_ESTIMATE_USD, SOCIAL_REVIEW_ROWS_PER_CALL, socialReviewCapUsd, type RowAdvisorFn } from "../src/lib/server/rowReviewAdvisor";
import { REVIEW_SAMPLE_ROWS, reviewSocialPage } from "../src/lib/server/sampledReview";

const PAGE_ROWS = 50; // socialRowsPerChunk
const COST_PER_ROW = 0.0047 / SOCIAL_REVIEW_ROWS_PER_CALL;

const fakeAdvisor = (): RowAdvisorFn => async (input) => ({
  verdicts: new Map(input.rows.map((row) => [row.index, { verdict: "match" as const, reasonAr: "x" }])),
  usage: { inputTokens: 0, outputTokens: 0, costUsd: COST_PER_ROW * input.rows.length, model: "fake", latencyMs: 0 },
  failure: null,
});

/** One job: `target` rows wanted, every returned row passes the gate, `flaggedShare` of them are doubtful (the first ones of each page). */
interface Variant { floorUsd: number; sampleShare: number }
const CURRENT: Variant = { floorUsd: 0, sampleShare: 1 };
async function simulate(target: number, unit: number, flaggedShare: number, variant: Variant = CURRENT) {
  const budget = Math.max(variant.floorUsd, socialReviewCapUsd(target, unit));
  let sampleSpent = 0;
  let spent = 0;
  let delivered = 0;
  let unreviewedTotal = 0;
  let calls = 0;
  let pages = 0;
  let stoppedEarly = false;
  const seeded = (() => { let s = 12345; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); })();
  while (delivered < target && pages < 400) {
    pages += 1;
    const rows = Array.from({ length: PAGE_ROWS }, (_, index) => ({ index, row: { text: `r${index}` } }));
    const flagged = Math.round(PAGE_ROWS * flaggedShare);
    const suspicious = new Set(Array.from({ length: flagged }, (_, i) => i));
    const outcome = await reviewSocialPage({
      advisor: fakeAdvisor(), customerRequest: "x", kind: "social-x-posts", rows, suspicious,
      budgetUsd: Math.max(0, budget - spent), callCostEstimateUsd: REVIEW_CALL_COST_ESTIMATE_USD, random: seeded,
      // the proposed variant only: the sample of a page may use up to `sampleShare` of the budget, the rest is kept for doubtful rows
      sampleSize: sampleSpent + COST_PER_ROW * REVIEW_SAMPLE_ROWS <= variant.sampleShare * budget ? REVIEW_SAMPLE_ROWS : 0,
    });
    if (outcome.attempts.length > 0) sampleSpent += Math.min(outcome.costUsd, COST_PER_ROW * REVIEW_SAMPLE_ROWS);
    spent += outcome.costUsd;
    calls += outcome.attempts.length;
    const unreviewed = new Set(outcome.unreviewed.filter((i) => outcome.mustConfirm.has(i)));
    const deliverableWithoutReview = rows.filter((r) => !outcome.mustConfirm.has(r.index)).length;
    const deliveredHere = rows.length - unreviewed.size;
    unreviewedTotal += unreviewed.size;
    delivered = Math.min(target, delivered + deliveredHere);
    if (unreviewed.size > 0 && deliverableWithoutReview === 0) { stoppedEarly = true; break; }
  }
  return { budget, spent, calls, delivered, unreviewedTotal, stoppedEarly, charge: chargeForUnits(delivered, unit), fullCharge: chargeForUnits(target, unit) };
}

const CASES: Array<{ label: string; unit: number; targets: number[] }> = [
  { label: "X posts (0.11715)", unit: 0.11715, targets: [30, 300, 1000] },
  { label: "TikTok/YouTube comments (0.275)", unit: 0.275, targets: [30, 300, 1000] },
];

async function main() {
  console.log(`review call: ${REVIEW_CALL_COST_ESTIMATE_USD} USD per ${SOCIAL_REVIEW_ROWS_PER_CALL} rows (${COST_PER_ROW.toFixed(6)} per row); a page is ${PAGE_ROWS} rows; the per-page sample is ${REVIEW_SAMPLE_ROWS} rows`);
  for (const c of CASES) {
    for (const target of c.targets) {
      const budget = socialReviewCapUsd(target, c.unit);
      const fullCalls = Math.floor(budget / REVIEW_CALL_COST_ESTIMATE_USD);
      const rowsReviewable = Math.floor(budget / COST_PER_ROW);
      console.log(`\n${c.label}, target ${target}: expected charge ${chargeForUnits(target, c.unit)} points, review budget ${budget} USD = ${fullCalls} full 25-row calls = about ${rowsReviewable} rows reviewable`);
      for (const [name, share] of [["worst: every row needs review", 1], ["realistic A: 25% of rows doubtful", 0.25], ["realistic B: 10% doubtful", 0.1], ["no row doubtful (sample only)", 0]] as const) {
        const r = await simulate(target, c.unit, share);
        console.log(`  ${name}: delivered ${r.delivered} of ${target}, charge ${r.charge} of ${r.fullCharge} points, review spent ${r.spent.toFixed(5)} of ${budget} USD, ${r.calls} calls, ${r.unreviewedTotal} rows to the review sheet${r.stoppedEarly ? ", paging stopped by the budget" : ""}`);
      }
    }
  }
  const PROPOSED: Variant = { floorUsd: REVIEW_CALL_COST_ESTIMATE_USD, sampleShare: 0.25 };
  console.log("\nPROPOSAL (not applied): a floor of one full review call (0.0047 USD) on the budget, and the sample of a page may use at most 25% of the budget:");
  for (const [label, unit, target] of [["X 30", 0.11715, 30], ["X 300", 0.11715, 300], ["X 1000", 0.11715, 1000], ["comments 30", 0.275, 30], ["comments 300", 0.275, 300], ["comments 1000", 0.275, 1000]] as Array<[string, number, number]>) {
    for (const [name, share] of [["worst", 1], ["25% doubtful", 0.25]] as const) {
      const now = await simulate(target, unit, share);
      const fixed = await simulate(target, unit, share, PROPOSED);
      console.log(`  ${label}, ${name}: now delivered ${now.delivered} of ${target} (review budget ${now.budget} USD); with the proposal ${fixed.delivered} of ${target} (budget ${fixed.budget} USD, spent ${fixed.spent.toFixed(5)}), charge ${fixed.charge} of ${fixed.fullCharge} points; review spend / revenue = ${(100 * fixed.spent * 55 / (fixed.fullCharge * 0.1)).toFixed(1)}% of the full expected charge`);
    }
  }
  console.log("\ncompanies, target 5: the review of company rows is a separate path (not under this budget, no cap, not strict). The budget this rule would give a 5-company job is " + socialReviewCapUsd(5, 3.168) + " USD; the measured company review cost is 0.000068 USD per record (0.00034 USD for 5).");
}
main();
