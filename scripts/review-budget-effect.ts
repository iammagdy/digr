/**
 * What the review budget (20% of a job's expected charge) does to delivery. Fake data only: no provider, no model, no database, no network.
 * It runs the REAL functions (socialReviewCapUsd, reviewSocialPage) with a fake reviewer whose call costs the measured 0.0083 USD per 25 rows
 * (relevance_review: a verdict-only call of 20 rows cost 0.00666 USD on 21 Oct 2026) and replays the worker's own delivery rule page by page:
 *  - every row of a page is reviewed, in ONE call (a longer page in calls of 25 rows), and delivered only if the review confirms it (here the fake reviewer says match);
 *  - a row the budget did not reach is NOT delivered: it goes to the «غير مراجَع» sheet, and paging stops.
 * The budget is the real rule: 20% of the job's expected charge, never less than one full call (0.0083 USD).
 * Run: npx tsx scripts/review-budget-effect.ts
 */
import { chargeForUnits } from "../src/lib/recordPricing";
import { REVIEW_CALL_COST_ESTIMATE_USD, SOCIAL_REVIEW_ROWS_PER_CALL, socialReviewCapUsd, type RowAdvisorFn } from "../src/lib/server/rowReviewAdvisor";
import { reviewSocialPage } from "../src/lib/server/sampledReview";

const PAGE_ROWS = 50; // socialRowsPerChunk
const COST_PER_ROW = REVIEW_CALL_COST_ESTIMATE_USD / SOCIAL_REVIEW_ROWS_PER_CALL;

const fakeAdvisor = (): RowAdvisorFn => async (input) => ({
  verdicts: new Map(input.rows.map((row) => [row.index, { verdict: "match" as const, reasonAr: "x" }])),
  usage: { inputTokens: 0, outputTokens: 0, costUsd: COST_PER_ROW * input.rows.length, model: "fake", latencyMs: 0 },
  failure: null,
});

/** One job: `target` rows wanted, every returned row passes the gate and the reviewer confirms each one it reaches. */
async function simulate(target: number, unit: number) {
  const budget = socialReviewCapUsd(target, unit);
  let spent = 0;
  let delivered = 0;
  let unreviewedTotal = 0;
  let calls = 0;
  let pages = 0;
  let stoppedEarly = false;
  while (delivered < target && pages < 400) {
    pages += 1;
    const rows = Array.from({ length: PAGE_ROWS }, (_, index) => ({ index, row: { text: `r${index}` } }));
    const outcome = await reviewSocialPage({
      advisor: fakeAdvisor(), customerRequest: "x", kind: "social-x-posts", rows,
      budgetUsd: Math.max(0, budget - spent), callCostEstimateUsd: REVIEW_CALL_COST_ESTIMATE_USD,
    });
    spent += outcome.costUsd;
    calls += outcome.attempts.length;
    unreviewedTotal += outcome.unreviewedByBudget.length;
    delivered = Math.min(target, delivered + (rows.length - outcome.unreviewed.length));
    if (outcome.unreviewedByBudget.length > 0) { stoppedEarly = true; break; }
  }
  return { budget, spent, calls, delivered, unreviewedTotal, stoppedEarly, charge: chargeForUnits(delivered, unit), fullCharge: chargeForUnits(target, unit) };
}

const CASES: Array<{ label: string; unit: number; targets: number[] }> = [
  { label: "X posts (0.11715)", unit: 0.11715, targets: [30, 300, 1000] },
  { label: "TikTok/YouTube comments (0.275)", unit: 0.275, targets: [30, 300, 1000] },
];

async function main() {
  console.log(`review call: ${REVIEW_CALL_COST_ESTIMATE_USD} USD per ${SOCIAL_REVIEW_ROWS_PER_CALL} rows (${COST_PER_ROW.toFixed(6)} per row); a page is ${PAGE_ROWS} rows, reviewed in full`);
  for (const c of CASES) {
    for (const target of c.targets) {
      const budget = socialReviewCapUsd(target, c.unit);
      const fullCalls = Math.floor(budget / REVIEW_CALL_COST_ESTIMATE_USD);
      const rowsReviewable = Math.floor(budget / COST_PER_ROW);
      const r = await simulate(target, c.unit);
      console.log(`\n${c.label}, target ${target}: expected charge ${chargeForUnits(target, c.unit)} points, review budget ${budget} USD = ${fullCalls} full 25-row calls = about ${rowsReviewable} rows reviewable`);
      console.log(`  every row reviewed and confirmed: delivered ${r.delivered} of ${target}, charge ${r.charge} of ${r.fullCharge} points, review spent ${r.spent.toFixed(5)} of ${budget} USD, ${r.calls} calls, ${r.unreviewedTotal} rows to the «غير مراجَع» sheet${r.stoppedEarly ? ", paging stopped by the budget" : ""}`);
    }
  }
  console.log("\ncompanies, target 5: the review of company rows is a separate path (not under this budget, no cap, not strict). The budget this rule would give a 5-company job is " + socialReviewCapUsd(5, 3.168) + " USD; the measured company review cost is 0.000068 USD per record (0.00034 USD for 5).");
}
main();
