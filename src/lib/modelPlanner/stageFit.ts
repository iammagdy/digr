import type { StoredStage } from "./types";

/**
 * ONE SOURCE OF TRUTH FOR COUNTS. Every number a customer sees about a mission (the card's stage lines and its total, the panel's «من», the summary, the hold) is computed by code from the stages
 * of the stored plan; the model writes words, never a count. When something other than the plan cuts the size of the job (the live extraction capacity, the points cap) the stages are FITTED to
 * the new total here, so the stages still add up to it: a card that says «حتى ٢٠» beside «السعة المتاحة ١» is impossible.
 */
export const deliveredTotalOf = (stages: ReadonlyArray<Pick<StoredStage, "effVolume" | "deliver">>): number => stages.reduce((n, s) => n + (s.deliver ? Math.max(0, Math.floor(s.effVolume)) : 0), 0);

export interface FittedStages { stages: StoredStage[]; /** What the fitted stages deliver in all: never more than asked, and the figure the quote must carry. */ total: number }

/**
 * The stages of a plan fitted to at most `total` delivered rows: every stage scaled by the same ratio (a stage run once per parent row never above its parent's rows x rows per parent), then the
 * rows left over by rounding are given back, last delivered stage first, while the rules allow. Pure.
 */
export function fitStagesToTotal(stages: ReadonlyArray<StoredStage>, total: number): FittedStages {
  const current = deliveredTotalOf(stages);
  const want = Math.max(1, Math.floor(total));
  if (current <= want) return { stages: stages.map((s) => ({ ...s })), total: current };
  const ratio = want / current;
  const out: StoredStage[] = stages.map((s) => ({ ...s }));
  const capOf = (i: number) => (out[i].parent === null ? Number.POSITIVE_INFINITY : Math.max(1, Math.floor(out[out[i].parent!].effVolume * Math.max(1, out[i].perParent))));
  out.forEach((s, i) => { s.effVolume = Math.max(1, Math.min(Math.floor(s.effVolume * ratio), s.parent === null ? Number.POSITIVE_INFINITY : capOf(i))); });
  // never above the total: take rows off the last delivered stages first
  let sum = deliveredTotalOf(out);
  for (let i = out.length - 1; i >= 0 && sum > want; i -= 1) {
    if (!out[i].deliver) continue;
    const cut = Math.min(sum - want, out[i].effVolume - 1);
    out[i].effVolume -= cut; sum -= cut;
  }
  // give the rounding back, last delivered stage first, inside what each stage's parent allows
  for (let i = out.length - 1; i >= 0 && sum < want; i -= 1) {
    if (!out[i].deliver) continue;
    const room = Math.max(0, capOf(i) - out[i].effVolume);
    const give = Math.min(room, want - sum);
    out[i].effVolume += give; sum += give;
  }
  // a feeder (a stage whose rows are not delivered) never collects more than its children need
  for (let i = out.length - 1; i >= 0; i -= 1) {
    if (out[i].deliver) continue;
    const kids = out.map((k, j) => (k.parent === i ? j : -1)).filter((j) => j >= 0);
    if (kids.length > 0) out[i].effVolume = Math.max(1, Math.min(out[i].effVolume, Math.max(...kids.map((j) => Math.ceil(out[j].effVolume / Math.max(1, out[j].perParent))))));
  }
  return { stages: out, total: deliveredTotalOf(out) };
}
