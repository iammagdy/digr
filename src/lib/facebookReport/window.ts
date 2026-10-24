import { classifyRowsByDate } from "../server/dateRangeFilter";
import type { ReportPost, WindowStats } from "./types";

/**
 * EXACT date-window filtering of POSTS. The window is whole days, inclusive at both ends and read in UTC (the same rule as every other feed: `classifyRowsByDate`): a post
 * published at 00:00:00 of the first day and one at 23:59:59.999 of the last day are inside, one millisecond either side is outside. A post whose date cannot be read is
 * NOT kept (it cannot be shown to be inside the window) and is counted as «undated». The owner's hand-made file held 35 posts outside the window it claimed to have verified.
 */
export function windowBoundsMs(from: string, to: string): { startMs: number; endMs: number } {
  return { startMs: Date.parse(`${from}T00:00:00.000Z`), endMs: Date.parse(`${to}T23:59:59.999Z`) };
}

export type PostWindowVerdict = "inside" | "outside" | "undated";

/** Where one post stands against the window. */
export function postVerdict(post: Pick<ReportPost, "publishedAtMs">, from: string, to: string): PostWindowVerdict {
  const { verdicts } = classifyRowsByDate([post], from, to, (row) => row.publishedAtMs);
  return verdicts[0] === "missing" ? "undated" : verdicts[0];
}

/** True when the post is older than the window's first day: a Page's posts come newest first, so the Page has nothing more inside the window. */
export function isOlderThanWindow(post: Pick<ReportPost, "publishedAtMs">, from: string): boolean {
  return post.publishedAtMs !== null && post.publishedAtMs < windowBoundsMs(from, from).startMs;
}

export function emptyWindowStats(from: string, to: string): WindowStats {
  return { from, to, seen: 0, kept: 0, outside: 0, undated: 0, perPage: {}, oldestKeptMs: null, newestKeptMs: null };
}

/** Filters a batch of posts and adds what it did to `stats` (per Page when `pageId` is given). Returns the posts inside the window. */
export function filterPostsByWindow(posts: ReportPost[], from: string, to: string, stats: WindowStats, pageId?: string): ReportPost[] {
  const { verdicts } = classifyRowsByDate(posts, from, to, (row) => row.publishedAtMs);
  const kept: ReportPost[] = [];
  const bucket = pageId ? (stats.perPage[pageId] ??= { seen: 0, kept: 0, outside: 0, undated: 0 }) : null;
  posts.forEach((post, index) => {
    stats.seen += 1;
    if (bucket) bucket.seen += 1;
    const verdict = verdicts[index];
    if (verdict === "inside") {
      kept.push(post);
      stats.kept += 1;
      if (bucket) bucket.kept += 1;
      const at = post.publishedAtMs as number;
      stats.oldestKeptMs = stats.oldestKeptMs === null ? at : Math.min(stats.oldestKeptMs, at);
      stats.newestKeptMs = stats.newestKeptMs === null ? at : Math.max(stats.newestKeptMs, at);
    } else if (verdict === "outside") {
      stats.outside += 1;
      if (bucket) bucket.outside += 1;
    } else {
      stats.undated += 1;
      if (bucket) bucket.undated += 1;
    }
  });
  return kept;
}

/** The oldest and newest publication day (YYYY-MM-DD) among the DELIVERED posts: the period the report really covers. */
export function coveredPeriod(posts: Array<Pick<ReportPost, "publishedAtMs">>): { from: string | null; to: string | null; days: number } {
  const times = posts.map((post) => post.publishedAtMs).filter((value): value is number => typeof value === "number");
  if (times.length === 0) return { from: null, to: null, days: 0 };
  const oldest = Math.min(...times);
  const newest = Math.max(...times);
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const spanDays = Math.floor((Date.parse(`${day(newest)}T00:00:00Z`) - Date.parse(`${day(oldest)}T00:00:00Z`)) / 86_400_000) + 1;
  return { from: day(oldest), to: day(newest), days: spanDays };
}
