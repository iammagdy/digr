/**
 * THE SOURCE'S OWN COUNT OF A ROW'S CHILDREN: a video's comments, a place's reviews, and (replies PR) a comment's replies. Read from the mapped row's own numeric field. Shared by the engine (no paid read for a parent that says it has none) and by the plan (what the replies of the sampled comments suggest).
 * Pure.
 */
type Row = Record<string, unknown>;

/** The keys that count a row's children: comments, replies, reviews (the comment's own `replies_count` / `reply_count`, as the planner's mappings write it). */
export const CHILD_COUNT_KEY = /^(comments?|comments?_?count|comment_?num|num_?comments|replies|replies_?count|reply_?count|reply_?comment_?total|reply_?total|num_?replies|reviews?|reviews?_?count)$/i;

const numberOf = (v: unknown): number => (typeof v === "number" ? v : typeof v === "string" && /^\s*\d+\s*$/.test(v) ? Number(v) : NaN);

/** The parent's own count of its children, when its row carries a number for it (a numeric text counts); null when the row has none. */
export function childCountOf(row: Row): number | null {
  for (const [k, v] of Object.entries(row)) {
    if (!CHILD_COUNT_KEY.test(k)) continue;
    const n = numberOf(v);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return null;
}

/** The same count, but only a finite NUMBER counts (used to rank spare parents: a text count is not trusted for ordering). */
export function childCountNumber(row: Row): number {
  for (const [k, v] of Object.entries(row)) if (CHILD_COUNT_KEY.test(k) && typeof v === "number" && Number.isFinite(v)) return v;
  return -1;
}
