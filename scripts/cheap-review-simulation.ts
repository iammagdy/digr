/**
 * Simulation of the CHEAP REVIEW scheme against the review of main (docs/CHEAP_REVIEW_DESIGN.md). FAKE DATA ONLY: no provider, no model, no database,
 * no network. Every row is a record with a ground truth; the "model" is a coin that is right with an assumed probability. What is MEASURED and what is
 * ASSUMED is marked in the output (M = measured on production, A = assumed). Run: npx tsx scripts/cheap-review-simulation.ts
 *
 * MEASURED (M): price per token (0.80 / 4 USD per million in / out); today's 20-row call: 3,325 tokens in, 1,000 out, 0.00666 USD; the review budget
 * (20% of the job's revenue, floor 0.0083 USD) of the code; the revenue per delivered record (X 0.11715 points, comments 0.275 points, at 0.10 EGP a
 * point and 55 EGP a dollar); the page cap of main (3 times the pages the target needs).
 * ASSUMED (A): everything else: the mix of rows, the false-accept rate of the code, the error rate of the model, the cheap call's tokens, duplicates,
 * repeat publishers, the misalignment rate of a digit reply and the audit rate. Change them at the top of this file.
 */
import { chargeForUnits } from "../src/lib/recordPricing";
import { socialReviewCapUsd } from "../src/lib/server/rowReviewAdvisor";
import {
  AuditWindow, CHEAP_BATCH_ROWS, cheapCallCostUsd, TODAY_CALL, TODAY_CALL_LEAN, todayCallCostUsd, TrustedPublishers,
} from "./cheapReview/prototype";

/* ------------------------------------------------ assumptions (A) ------------------------------------------------ */
const SEEDS = 40;
const MODEL_ERROR_MAIN = 0.03;       // A: a verdict of today's one-page call is wrong
const MODEL_ERROR_BATCH = 0.04;      // A: a verdict of a 50-row number-only call is wrong (a little worse than the small call)
const MISALIGN_PER_CALL = 0.02;      // A: a digit reply is shifted by a row
const MISALIGN_DETECTED = 0.9;       // A: the canaries catch a shifted reply (then it is asked again in calls of 10); the rest is read as it is (50% right)
const CANARIES_PER_CALL = 2;         // A: rows with a known answer added to every cheap call
const MIN_LAST_CALL = 8;             // A: the last call, sized to the budget left, is made only for at least this many rows
const AUDIT_RATE = 0.07;             // A: share of the rows accepted without the model that is also sent to the model
const AUDIT_FIRST = 12;              // A: the first rows accepted without the model in a job are all audited, so the false-accept rate is known early (a job is small: 7% alone gives 2 to 4 audits)
const DUP_SHARE = 0.15;              // A: share of candidate rows that are near-copies of an earlier candidate
const DUP_TRUTH_AGREES = 0.95;       // A: a near-copy has the truth of the row it copies
const REPEAT_PUBLISHER_SHARE = 0.4;  // A: share of candidate rows written by a publisher who writes often
const PUBLISHER_CONSISTENT = 0.8;    // A: share of the repeat publishers' rows that come from publishers who are nearly always right or always wrong
const PUBLISHER_IMPURITY = 0.05;     // A: a consistent publisher is the other way on 5% of rows
const PAGE_CAP_FACTOR = 3;           // M: main's page cap is 3 times the pages the target would need if every row matched
const COMMENTS_PER_VIDEO = 10;       // A: comments read under an adopted video
const PROVIDER_USD_PER_PAGE = 0.0006; // M: provider_costs of the X jobs of 21 Oct 2026 (one call of 20 rows). Not modelled for comments (their provider calls are not measured here).

/** Knobs the sensitivity tables turn: the input tokens of one row of the cheap call, and a budget that does not stop the job. */
const KNOBS: { inPerRow: number; unlimitedBudget: boolean; strongBoost: number } = { inPerRow: 110, unlimitedBudget: false, strongBoost: 0 };
const budgetFor = (p: CaseParams) => (KNOBS.unlimitedBudget ? 1000 : socialReviewCapUsd(p.target, p.unitPricePoints));

type Features = { strong: boolean; cluster: boolean; trusted: boolean; audit: boolean };
const ALL: Features = { strong: true, cluster: true, trusted: true, audit: true };
const BATCH_ONLY: Features = { strong: false, cluster: false, trusted: false, audit: false };

interface CaseParams {
  name: string;
  unit: "post" | "video";
  target: number;                // records wanted
  unitPricePoints: number;       // M
  pageSize: number;              // M for posts (20), A for videos (25)
  relevantShare: number;         // A: share of all rows that are truly relevant
  strongShare: number;           // A: share the code accepts without a model (before the false accepts)
  strongShareMain: number;       // the part of it main already accepts without a model (video evidence)
  rejectShare: number;           // A: share the code rejects (ads, spam, foreign script, no topic and no country word)
  commentsPerUnit: number;
}
const CASES: CaseParams[] = [
  { name: "X 300 posts, narrow topic (25% truly relevant)", unit: "post", target: 300, unitPricePoints: 0.11715, pageSize: 20, relevantShare: 0.25, strongShare: 0.12, strongShareMain: 0, rejectShare: 0.45, commentsPerUnit: 1 },
  { name: "X 300 posts, broad topic (80% truly relevant)", unit: "post", target: 300, unitPricePoints: 0.11715, pageSize: 20, relevantShare: 0.8, strongShare: 0.3, strongShareMain: 0, rejectShare: 0.1, commentsPerUnit: 1 },
  { name: "Comments 300 (judged by video; 10 comments per adopted video)", unit: "video", target: 300, unitPricePoints: 0.275, pageSize: 25, relevantShare: 0.4, strongShare: 0.25, strongShareMain: 0.15, rejectShare: 0.2, commentsPerUnit: COMMENTS_PER_VIDEO },
];

/* ------------------------------------------------ the fake world ------------------------------------------------ */
const rng = (seed: number) => { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };

interface SimRow { id: number; kind: "reject" | "strong" | "candidate"; truth: boolean; publisher: string; dupOf: number | null; mainEvidence: boolean }

function makeRows(p: CaseParams, falseAccept: number, count: number, random: () => number): SimRow[] {
  const rows: SimRow[] = [];
  const candidateShare = 1 - p.strongShare - p.rejectShare;
  const relevantInCandidates = Math.min(1, Math.max(0, (p.relevantShare - p.strongShare * (1 - falseAccept)) / candidateShare));
  const candidates: SimRow[] = [];
  const pools = { yes: 15, no: 15, mixed: 8 };
  for (let id = 0; id < count; id += 1) {
    const r = random();
    if (r < p.rejectShare) { rows.push({ id, kind: "reject", truth: false, publisher: `u${id}`, dupOf: null, mainEvidence: false }); continue; }
    if (r < p.rejectShare + p.strongShare) {
      // the code sees a strong signal; `falseAccept` of such rows are in fact not relevant
      const row: SimRow = { id, kind: "strong", truth: random() >= falseAccept, publisher: `u${id}`, dupOf: null, mainEvidence: random() < p.strongShareMain / p.strongShare };
      rows.push(row);
      continue;
    }
    let truth = random() < relevantInCandidates;
    let dupOf: number | null = null;
    if (candidates.length > 0 && random() < DUP_SHARE) {
      const original = candidates[Math.floor(random() * Math.min(candidates.length, 200)) + Math.max(0, candidates.length - 200)] ?? candidates[0];
      dupOf = original.id;
      truth = random() < DUP_TRUTH_AGREES ? original.truth : !original.truth;
    }
    let publisher = `u${id}`;
    if (random() < REPEAT_PUBLISHER_SHARE) {
      if (random() < PUBLISHER_CONSISTENT) {
        const own = random() >= PUBLISHER_IMPURITY ? truth : !truth;
        publisher = own ? `y${Math.floor(random() * pools.yes)}` : `n${Math.floor(random() * pools.no)}`;
      } else publisher = `m${Math.floor(random() * pools.mixed)}`;
    }
    const row: SimRow = { id, kind: "candidate", truth, publisher, dupOf, mainEvidence: false };
    rows.push(row);
    candidates.push(row);
  }
  return rows;
}

interface Result { delivered: number; wrong: number; calls: number; modelRows: number; usd: number; pages: number; budget: number; unreviewed: number; codeAccepted: number; clusterApplied: number; trustedAccepted: number; auditRows: number; auditFalseAccepts: number; strictPages: number; ceiling: number; stopped: string }

const zero = (budget: number): Result => ({ delivered: 0, wrong: 0, calls: 0, modelRows: 0, usd: 0, pages: 0, budget, unreviewed: 0, codeAccepted: 0, clusterApplied: 0, trustedAccepted: 0, auditRows: 0, auditFalseAccepts: 0, strictPages: 0, ceiling: 0, stopped: "" });

/** main (da8a825): the gate rejects ads and rows with no topic or country word; every other row goes to the model, one call per page, until the budget is used up. */
function runMain(p: CaseParams, rows: SimRow[], random: () => number, tokens: { overheadIn: number; inPerRow: number; outPerRow: number }): Result {
  const budget = budgetFor(p);
  const result = zero(budget);
  const maxPages = Math.min(300, Math.ceil(p.target / (p.commentsPerUnit > 1 ? Math.max(1, p.commentsPerUnit) : p.pageSize)) * PAGE_CAP_FACTOR);
  const delivered: SimRow[] = [];
  for (let page = 0; page * p.pageSize < rows.length && page < maxPages; page += 1) {
    result.pages = page + 1;
    const pageRows = rows.slice(page * p.pageSize, (page + 1) * p.pageSize);
    result.ceiling += pageRows.filter((row) => row.kind !== "reject" && row.truth).length;
    // video evidence is the only thing main accepts without the model
    const accepted = p.unit === "video" ? pageRows.filter((row) => row.kind === "strong" && row.mainEvidence) : [];
    for (const row of accepted) delivered.push(row);
    result.codeAccepted += accepted.length;
    const toModel = pageRows.filter((row) => row.kind !== "reject" && !accepted.includes(row));
    if (toModel.length > 0) {
      const cost = todayCallCostUsd(toModel.length, tokens);
      if (result.usd + cost > budget) { result.unreviewed += toModel.length; result.stopped = "budget"; break; }
      result.usd += cost; result.calls += 1; result.modelRows += toModel.length;
      for (const row of toModel) if ((random() < MODEL_ERROR_MAIN) ? !row.truth : row.truth) delivered.push(row);
    }
    if (delivered.length * p.commentsPerUnit >= p.target) { result.stopped = "target"; break; }
  }
  return finish(p, result, delivered);
}

function finish(p: CaseParams, result: Result, delivered: SimRow[]): Result {
  const units = Math.min(delivered.length, Math.ceil(p.target / p.commentsPerUnit));
  const kept = delivered.slice(0, units);
  result.delivered = kept.length * p.commentsPerUnit;
  result.wrong = kept.filter((row) => !row.truth).length * p.commentsPerUnit;
  result.delivered = Math.min(result.delivered, p.target);
  return result;
}

/** the cheap scheme: strong signals and trusted publishers accepted in code, near-copies reviewed once, 50-row number-only calls, an audit sample, fall-back to strict review. */
function runCheap(p: CaseParams, rows: SimRow[], random: () => number, features: Features): Result {
  const budget = budgetFor(p);
  const result = zero(budget);
  const maxPages = Math.min(300, Math.ceil(p.target / (p.commentsPerUnit > 1 ? Math.max(1, p.commentsPerUnit) : p.pageSize)) * PAGE_CAP_FACTOR);
  const trusted = new TrustedPublishers();
  const audit = new AuditWindow();
  type Item = { row: SimRow; purpose: "review" | "audit" | "strict"; viaTrust?: boolean };
  const buffer: Item[] = [];
  const clusterVerdict = new Map<number, boolean>();
  const clusterWaiting = new Map<number, SimRow[]>();
  const delivered: SimRow[] = [];
  const removed = new Set<number>();
  const rootOf = (row: SimRow): number => (row.dupOf === null ? row.id : rootOfId(row.dupOf));
  const byId = new Map<number, SimRow>();
  const rootOfId = (id: number): number => { const row = byId.get(id); return !row || row.dupOf === null ? id : rootOfId(row.dupOf); };
  let stopped = false;

  const deliverOnce = (row: SimRow) => { delivered.push(row); };
  const modelSays = (row: SimRow, aligned: boolean): boolean => {
    if (!aligned) return random() < 0.5;
    return (random() < MODEL_ERROR_BATCH) ? !row.truth : row.truth;
  };

  /** One call of up to 48 rows plus the canaries. Returns false when the budget cannot pay for it. */
  const flush = (): boolean => {
    if (buffer.length === 0) return true;
    // the last call is sized to the budget that is left (and made only for at least MIN_LAST_CALL rows), so a part of a call is not wasted
    const full = Math.min(buffer.length, CHEAP_BATCH_ROWS - CANARIES_PER_CALL);
    let take = full;
    while (take > 0 && result.usd + cheapCallCostUsd(take + CANARIES_PER_CALL, KNOBS.inPerRow) > budget) take -= 1;
    const budgetLimited = take < full;
    const leaveUnreviewed = () => { result.unreviewed += buffer.filter((item) => item.purpose !== "audit").length; buffer.length = 0; stopped = true; result.stopped = "budget"; };
    if (take === 0 || (budgetLimited && take < MIN_LAST_CALL)) { leaveUnreviewed(); return false; }
    const items = buffer.splice(0, take);
    const cost = cheapCallCostUsd(items.length + CANARIES_PER_CALL, KNOBS.inPerRow);
    // a call that takes the last of the budget is the last call of the job: what is still waiting is not reviewed
    if (budgetLimited) leaveUnreviewed();
    result.usd += cost; result.calls += 1; result.modelRows += items.length;
    let aligned = true;
    if (random() < MISALIGN_PER_CALL) {
      if (random() < MISALIGN_DETECTED) {
        // the canaries show the reply is shifted: the rows are asked again in calls of 10 (2 canaries each), and then read right
        for (let start = 0; start < items.length; start += 10) {
          const n = Math.min(10, items.length - start) + CANARIES_PER_CALL;
          result.usd += cheapCallCostUsd(n, KNOBS.inPerRow); result.calls += 1;
        }
      } else aligned = false;
    }
    for (const item of items) {
      const verdict = modelSays(item.row, aligned);
      if (item.purpose === "audit") {
        result.auditRows += 1;
        audit.add(!verdict);
        if (!verdict) { result.auditFalseAccepts += 1; removed.add(item.row.id); if (item.viaTrust) trusted.revoke(item.row.publisher); }
        continue;
      }
      if (item.purpose === "strict") { audit.add(!verdict); }
      const root = rootOf(item.row);
      clusterVerdict.set(root, verdict);
      trusted.record(item.row.publisher, verdict ? "match" : "other");
      if (verdict) deliverOnce(item.row);
      for (const member of clusterWaiting.get(root) ?? []) { result.clusterApplied += 1; if (verdict) deliverOnce(member); }
      clusterWaiting.delete(root);
    }
    return true;
  };

  for (let page = 0; page * p.pageSize < rows.length && page < maxPages && !stopped; page += 1) {
    result.pages = page + 1;
    const pageRows = rows.slice(page * p.pageSize, (page + 1) * p.pageSize);
    for (const row of pageRows) byId.set(row.id, row);
    result.ceiling += pageRows.filter((row) => row.kind !== "reject" && row.truth).length;
    const strictNow = features.audit && audit.strict;
    if (strictNow) result.strictPages += 1;
    for (const row of pageRows) {
      if (row.kind === "reject") continue;
      if (row.kind === "strong") {
        if (features.strong && !strictNow) {
          deliverOnce(row); result.codeAccepted += 1;
          if (features.audit && (result.codeAccepted <= AUDIT_FIRST || random() < AUDIT_RATE)) buffer.push({ row, purpose: "audit" });
        } else buffer.push({ row, purpose: strictNow ? "strict" : "review" });
        continue;
      }
      const root = rootOf(row);
      if (features.cluster && row.dupOf !== null) {
        if (clusterVerdict.has(root)) { result.clusterApplied += 1; if (clusterVerdict.get(root)) deliverOnce(row); continue; }
        if (clusterWaiting.has(root)) { clusterWaiting.get(root)!.push(row); continue; }
      }
      if (features.trusted && !strictNow && trusted.isTrusted(row.publisher)) {
        result.trustedAccepted += 1; result.codeAccepted += 1; clusterVerdict.set(root, true); deliverOnce(row);
        if (features.audit && (result.codeAccepted <= AUDIT_FIRST || random() < AUDIT_RATE)) buffer.push({ row, purpose: "audit", viaTrust: true });
        continue;
      }
      if (features.cluster) clusterWaiting.set(root, []);
      buffer.push({ row, purpose: strictNow ? "strict" : "review" });
    }
    while (!stopped && buffer.length >= CHEAP_BATCH_ROWS - CANARIES_PER_CALL) flush();
    if (stopped) break;
    if (delivered.length - removed.size >= Math.ceil(p.target / p.commentsPerUnit)) { result.stopped = "target"; break; }
  }
  if (!stopped) flush();
  if (!result.stopped) result.stopped = "pages";
  return finish(p, result, delivered.filter((row) => !removed.has(row.id)));
}

/* ------------------------------------------------ running and printing ------------------------------------------------ */
const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);
function average(results: Result[]): Result {
  const keys = Object.keys(results[0]).filter((key) => key !== "stopped") as Array<Exclude<keyof Result, "stopped">>;
  const out = { ...results[0] };
  for (const key of keys) (out as any)[key] = mean(results.map((result) => result[key] as number));
  const reasons = results.map((result) => result.stopped);
  out.stopped = ["target", "budget", "pages"].map((reason) => `${reason} ${reasons.filter((r) => r === reason).length}/${results.length}`).join(", ");
  return out;
}

const REVENUE_PER_ROW: Record<string, number> = {};
const revenuePerRow = (p: CaseParams) => REVENUE_PER_ROW[p.name] ??= (chargeForUnits(1000, p.unitPricePoints) * 0.1) / 55 / 1000;

function simulate(p0: CaseParams, falseAccept: number, scheme: "main" | "main-lean" | "cheap", features: Features = ALL): Result {
  // a "stronger signals" lever moves rows from the candidates to the strong rows (a bigger vocabulary); the relevant share stays what it is
  const p: CaseParams = KNOBS.strongBoost > 0 ? { ...p0, strongShare: p0.strongShare + KNOBS.strongBoost } : p0;
  const results: Result[] = [];
  for (let seed = 1; seed <= SEEDS; seed += 1) {
    const random = rng(seed * 7919 + Math.round(falseAccept * 1000));
    const rows = makeRows(p, falseAccept, Math.min(300, Math.ceil(p.target / (p.commentsPerUnit > 1 ? p.commentsPerUnit : p.pageSize)) * PAGE_CAP_FACTOR) * p.pageSize, random);
    results.push(scheme === "cheap" ? runCheap(p, rows, random, features) : runMain(p, rows, random, scheme === "main" ? TODAY_CALL : TODAY_CALL_LEAN));
  }
  return average(results);
}

const f0 = (n: number) => n.toFixed(0);
const f1 = (n: number) => n.toFixed(1);
const usd = (n: number) => n.toFixed(4);
const ratio = (r: Result, p: CaseParams) => (r.delivered > 0 ? (r.usd / r.delivered / revenuePerRow(p)).toFixed(2) : "n/a");
const allIn = (r: Result, p: CaseParams) => (p.unit === "post" && r.delivered > 0 ? ((r.usd + r.pages * PROVIDER_USD_PER_PAGE) / r.delivered / revenuePerRow(p)).toFixed(2) : "n/a");
const perRow = (r: Result) => (r.delivered > 0 ? (r.usd / r.delivered).toFixed(6) : "n/a");

function header() {
  console.log("| scheme | delivered of 300 | wrong delivered | wrong share | model calls | model rows | review USD | budget USD | USD per delivered row | review cost / revenue per row | all-in cost / revenue per row (posts) | pages | rows left unreviewed | ceiling (relevant rows seen) | stopped by |");
  console.log("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
}
function line(label: string, r: Result, p: CaseParams) {
  console.log(`| ${label} | ${f0(r.delivered)} | ${f1(r.wrong)} | ${r.delivered > 0 ? ((r.wrong / r.delivered) * 100).toFixed(1) : "0.0"}% | ${f1(r.calls)} | ${f0(r.modelRows)} | ${usd(r.usd)} | ${usd(r.budget)} | ${perRow(r)} | ${ratio(r, p)} | ${allIn(r, p)} | ${f0(r.pages)} | ${f0(r.unreviewed)} | ${f0(r.ceiling)} | ${r.stopped} |`);
}

function main() {
  console.log(`Averages of ${SEEDS} random worlds per line. Revenue per delivered row: X ${revenuePerRow(CASES[0]).toFixed(6)} USD, comments ${revenuePerRow(CASES[2]).toFixed(6)} USD (M). Review budget = 20% of the job's revenue (floor 0.0083 USD) (M).`);
  console.log(`Cost per call (M for today, A for cheap): today 20 rows ${todayCallCostUsd(20).toFixed(5)} USD (measured 0.00666), lean-reply sensitivity ${todayCallCostUsd(20, TODAY_CALL_LEAN).toFixed(5)}; cheap 50 rows ${cheapCallCostUsd(50).toFixed(5)} (A).`);
  for (const p of CASES) {
    console.log(`\n### ${p.name}\n`);
    header();
    line("main (da8a825), 20-row calls, measured cost", simulate(p, 0.15, "main"), p);
    line("main, if its reply were only 20 tokens a row (sensitivity)", simulate(p, 0.15, "main-lean"), p);
    for (const fa of [0.05, 0.15, 0.3]) line(`cheap scheme, code false-accept ${Math.round(fa * 100)}% (A)`, simulate(p, fa, "cheap"), p);
  }
  console.log("\n### What each piece adds (code false-accept 15%, A)\n");
  header();
  for (const p of CASES.slice(0, 2)) {
    const steps: Array<[string, Features]> = [
      ["50-row number-only calls only", BATCH_ONLY],
      ["+ strong signals accepted in code", { ...BATCH_ONLY, strong: true }],
      ["+ near-duplicate clusters", { strong: true, cluster: true, trusted: false, audit: false }],
      ["+ trusted publishers", { strong: true, cluster: true, trusted: true, audit: false }],
      ["+ audit sample and strict fall-back (full scheme)", ALL],
    ];
    console.log(`| **${p.name}** | | | | | | | | | | | | | | | | |`);
    for (const [label, features] of steps) line(label, simulate(p, 0.15, "cheap", features), p);
  }
  console.log("\n### The audit at the size of these jobs (code false-accept 15%, A)\n");
  console.log("| case | rows audited in the whole job | false accepts found | pages run in strict review | rows removed by the audit |");
  console.log("|---|---|---|---|---|");
  for (const p of CASES) {
    const r = simulate(p, 0.15, "cheap");
    console.log(`| ${p.name} | ${f1(r.auditRows)} | ${f1(r.auditFalseAccepts)} | ${f1(r.strictPages)} | ${f1(r.auditFalseAccepts)} |`);
  }
  console.log("\n### If the budget did not stop the job (to size the budget it would need; the real budget stays 20% of revenue)\n");
  KNOBS.unlimitedBudget = true;
  header();
  for (const p of CASES.slice(0, 2)) {
    console.log(`| **${p.name}** | | | | | | | | | | | | | | | | |`);
    line("main, measured cost", simulate(p, 0.15, "main"), p);
    line("cheap scheme, code false-accept 15% (A)", simulate(p, 0.15, "cheap"), p);
  }
  KNOBS.unlimitedBudget = false;
  console.log("\n### Levers inside the real budget (code false-accept 15%, A): shorter text per row, a bigger vocabulary\n");
  header();
  for (const p of CASES.slice(0, 2)) {
    console.log(`| **${p.name}** | | | | | | | | | | | | | | | | |`);
    line("cheap scheme as designed (110 tokens a row, text of 160 characters)", simulate(p, 0.15, "cheap"), p);
    KNOBS.inPerRow = 70;
    line("text trimmed to 100 characters (70 tokens a row)", simulate(p, 0.15, "cheap"), p);
    KNOBS.inPerRow = 50;
    line("text trimmed to 70 characters (50 tokens a row)", simulate(p, 0.15, "cheap"), p);
    KNOBS.inPerRow = 110;
    KNOBS.strongBoost = 0.1;
    line("vocabulary 10 points bigger (more rows accepted in code, at the same false-accept rate)", simulate(p, 0.15, "cheap"), p);
    KNOBS.strongBoost = 0;
  }
  const tokens = (rows: number) => `${rows} rows: ${cheapCallCostUsd(rows).toFixed(5)} USD`;
  console.log(`\nCheap call cost by size (A): ${[10, 25, 50].map(tokens).join("; ")}.`);
}

main();
