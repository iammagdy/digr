/**
 * PR B (round 18): the legacy complete-count estimate (the share estimate, the page cap, the candidates read from samples, `withCompleteCount`) was used only by the model-planned social pipeline and is deleted. What stays is the split of one promised total into comments and replies, which the plan editor (planEdit.ts) still uses.
 */
import { AGENT_REPLIES_UNKNOWN_SHARE } from "./constants";

/** The split of a total promised for comments AND replies (a video's counter counts both): the replies are the sample's measured share of it (a silent sample: a stated quarter), at least 1 and never the whole total; the comments are the rest (S5, S7). */
export function splitPromise(total: number, sampleCounts: ReadonlyArray<number> | undefined): { comments: number; replies: number } {
  const counts = (sampleCounts ?? []).filter((v) => Number.isFinite(v) && v >= 0);
  const mean = counts.length > 0 ? counts.reduce((a, b) => a + b, 0) / counts.length : 0;
  const share = mean > 0 ? mean / (1 + mean) : AGENT_REPLIES_UNKNOWN_SHARE;
  const t = Math.max(0, Math.floor(total));
  const replies = t >= 2 ? Math.min(t - 1, Math.max(1, Math.round(t * share))) : 0;
  return { comments: t - replies, replies };
}
