import { PER_PUBLISHER_MAX_SHARE } from "./constants";
import type { ReportPost } from "./types";

/**
 * The share the cap can really be held to. With fewer than 1 / share publishers the configured share cannot be met by ANY set (four Pages of equal size are 25% each), so the
 * share is raised to an equal split of the publishers there are and the report says so; with enough publishers it is the configured 20%.
 */
export function effectiveShare(publishers: number, share: number = PER_PUBLISHER_MAX_SHARE): number {
  return Math.max(share, publishers > 0 ? 1 / publishers : 1);
}

/** The most posts one publisher may hold in a set of `total` posts: its share of the total, rounded down, never below one. */
export function publisherCap(total: number, share: number = PER_PUBLISHER_MAX_SHARE): number {
  return Math.max(1, Math.floor(Math.max(0, total) * share + 1e-9));
}

export interface ConcentrationRow {
  key: string;
  name: string;
  posts: number;
  /** Share of the posts, 0 to 1. */
  share: number;
}

/** Posts per publisher, largest first (ties by name): the publisher-concentration table of the report. */
export function concentrationOf(posts: ReportPost[]): ConcentrationRow[] {
  const byKey = new Map<string, { name: string; posts: number }>();
  for (const post of posts) {
    const entry = byKey.get(post.publisherKey) ?? { name: post.publisher, posts: 0 };
    entry.posts += 1;
    byKey.set(post.publisherKey, entry);
  }
  const total = posts.length || 1;
  return [...byKey.entries()]
    .map(([key, { name, posts: count }]) => ({ key, name, posts: count, share: count / total }))
    .sort((a, b) => b.posts - a.posts || a.name.localeCompare(b.name, "ar"));
}

/** Does the set respect the per-publisher cap? `top` is the largest publisher. */
export function checkPublisherShare(posts: ReportPost[], share: number = PER_PUBLISHER_MAX_SHARE): { ok: boolean; top: ConcentrationRow | null; cap: number } {
  const rows = concentrationOf(posts);
  const cap = publisherCap(posts.length, share);
  const top = rows[0] ?? null;
  return { ok: !top || top.posts <= cap, top, cap };
}

/**
 * Brings a set of posts under the per-publisher cap: while a publisher holds more than its share of what REMAINS, its oldest-first surplus is dropped (the cap is
 * re-read on the smaller set until it is stable). A set dominated by one publisher (the 74% case of the owner's run) shrinks to a set where nobody holds more than the
 * share; the posts dropped are counted by publisher. `rankOf` orders a publisher's posts best-first (default: newest first), so what is kept is the best of each.
 */
export function applyPublisherCap(
  posts: ReportPost[],
  share: number = PER_PUBLISHER_MAX_SHARE,
  rankOf: (a: ReportPost, b: ReportPost) => number = (a, b) => (b.publishedAtMs ?? 0) - (a.publishedAtMs ?? 0),
): { kept: ReportPost[]; dropped: number; droppedByPublisher: Record<string, number> } {
  const groups = new Map<string, ReportPost[]>();
  for (const post of posts) groups.set(post.publisherKey, [...(groups.get(post.publisherKey) ?? []), post]);
  for (const list of groups.values()) list.sort(rankOf);
  let counts = new Map([...groups.entries()].map(([key, list]) => [key, list.length] as const));
  for (let guard = 0; guard < 200; guard++) {
    const total = [...counts.values()].reduce((sum, n) => sum + n, 0);
    const cap = publisherCap(total, share);
    let changed = false;
    const next = new Map<string, number>();
    for (const [key, n] of counts) {
      const limited = Math.min(n, cap);
      if (limited !== n) changed = true;
      next.set(key, limited);
    }
    counts = next;
    if (!changed) break;
  }
  const kept: ReportPost[] = [];
  const droppedByPublisher: Record<string, number> = {};
  for (const [key, list] of groups) {
    const n = counts.get(key) ?? 0;
    kept.push(...list.slice(0, n));
    if (list.length > n) droppedByPublisher[key] = list.length - n;
  }
  const dropped = posts.length - kept.length;
  return { kept, dropped, droppedByPublisher };
}

/**
 * Picks up to `target` posts from the Pages' kept posts so that every Page is represented before any Page is represented twice (round-robin by recency), each Page capped by
 * the per-publisher share of the final count. The result is what the customer receives: balanced, capped, and never above the target.
 */
export function balancedSelection(posts: ReportPost[], target: number, share: number = PER_PUBLISHER_MAX_SHARE): ReportPost[] {
  const wanted = Math.max(0, Math.floor(target));
  const groups = new Map<string, ReportPost[]>();
  for (const post of [...posts].sort((a, b) => (b.publishedAtMs ?? 0) - (a.publishedAtMs ?? 0))) groups.set(post.publisherKey, [...(groups.get(post.publisherKey) ?? []), post]);
  // The cap is the share of the final count: of `wanted` posts when the Pages hold that many, else of what they hold (applyPublisherCap settles the latter below).
  const chosen: ReportPost[] = [];
  const taken = new Map<string, number>();
  const cap = publisherCap(wanted, share);
  let progressed = true;
  while (chosen.length < wanted && progressed) {
    progressed = false;
    for (const [key, list] of groups) {
      if (chosen.length >= wanted) break;
      const n = taken.get(key) ?? 0;
      if (n >= list.length || n >= cap) continue;
      chosen.push(list[n]);
      taken.set(key, n + 1);
      progressed = true;
    }
  }
  // When the Pages cannot fill the target, the share is re-read on what was delivered: nobody may hold more than the share of the delivered posts.
  return applyPublisherCap(chosen, share).kept;
}
