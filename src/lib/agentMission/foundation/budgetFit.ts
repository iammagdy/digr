import { AGENT_JOB_POINTS_CAP } from "../constants";
import { countAr, knownItemNoun } from "../itemNoun";
import { formatAr } from "../../arabicDigits";
import { pointsAr } from "../../pointsFormat";
import type { PricedPlan } from "../plan";
import type { Ask } from "./ask";
import type { CompileResult } from "./compilePlan";

/**
 * THE BUDGET AS A HARD CEILING (round 14, Part B). A budget in points (said in the request or chosen at the count question) is treated exactly like the over-limit path treats the job cap: the compiler builds the LARGEST version whose HOLD is at most the budget (and never above the job cap), priced by the same
 * price function (`priceMissionByCode`, read only: it is the compiler's own pricing of every candidate). First the version the Ask asks for (its count, or the default count when it gives none); when its hold is above the budget, one comment per parent is tried for every number of parents from the asked count down to one,
 * and the first number that fits gets the most comments per parent that still fit (binary search). A request with no comments stage reduces the number of parents only. The card says what the budget holds before approval; the charge is unchanged (only what is delivered). Pure: `compileWith` is the compiler's own function.
 */
export type CompileOk = Extract<CompileResult, { ok: true }>;
export type FitResult = { ok: true; plan: PricedPlan; ask: Ask; result: CompileOk; parents: number; commentsPerParent: number | null; hold: number } | { ok: false; reason: "budget_too_small"; minimumHold: number | null };

const holdOf = (r: CompileResult): number => (r.ok ? r.plan.price.reservePoints : Number.POSITIVE_INFINITY);
const MAX_PER_PARENT = 5000;

export function fitToBudget(compileWith: (ask: Ask) => CompileResult, ask: Ask, budget: number, defaultCount: number, parentWord: string): FitResult {
  const ceiling = Math.min(Math.floor(budget), AGENT_JOB_POINTS_CAP);
  const withComments = ask.comments !== "none";
  const baseCount = Math.max(1, ask.count ?? defaultCount);
  const baseAsk: Ask = { ...ask, count: baseCount };
  const done = (a: Ask, r: CompileOk, parents: number, per: number | null): FitResult => {
    const noun = knownItemNoun(parentWord);
    const parentsAr = noun ? countAr(parents, noun) : `${formatAr(parents)} ${parentWord}`;
    const line = `ميزانيتك ${pointsAr(Math.floor(budget))}؛ تكفي تقريبًا لـ ${parentsAr}${per !== null ? ` مع حتى ${formatAr(per)} تعليق من كل ${parentWord}` : ""}، والحجز المؤقت المطلوب ${pointsAr(r.plan.price.reservePoints)} ولا يتجاوز ميزانيتك؛ ولا يُخصم إلا ما يُسلَّم.`;
    const plan: PricedPlan = { ...r.plan, notes_ar: [line, ...(r.plan.notes_ar ?? [])] };
    return { ok: true, plan, ask: a, result: { ...r, plan }, parents, commentsPerParent: per, hold: plan.price.reservePoints };
  };
  const first = compileWith(baseAsk);
  if (first.ok && holdOf(first) <= ceiling) {
    // the asked version fits: with a number of comments per parent asked, that is it; with none (every comment), it is the version the Ask gave
    return done(baseAsk, first, first.plan.stages.find((s) => s.parent_key === null && s.deliver)?.planned_rows ?? baseCount, ask.commentsPerParent);
  }
  let minimum: number | null = null;
  for (let n = baseCount; n >= 1; n -= 1) {
    const smallest: Ask = { ...baseAsk, count: n, ...(withComments ? { commentsPerParent: 1, comments: ask.comments === "all" ? "some" : ask.comments } : {}) };
    const r = compileWith(smallest);
    if (n === 1 && r.ok) minimum = r.plan.price.reservePoints;
    if (!(r.ok && holdOf(r) <= ceiling)) continue;
    if (!withComments) return done(smallest, r, n, null);
    let lo = 1;
    let hi = Math.max(1, Math.min(MAX_PER_PARENT, ask.commentsPerParent ?? MAX_PER_PARENT));
    let best: { a: Ask; r: CompileOk } = { a: smallest, r };
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      const a: Ask = { ...smallest, commentsPerParent: mid };
      const rr = compileWith(a);
      if (rr.ok && holdOf(rr) <= ceiling) { lo = mid; best = { a, r: rr }; } else hi = mid - 1;
    }
    return done(best.a, best.r, n, lo);
  }
  return { ok: false, reason: "budget_too_small", minimumHold: minimum };
}
