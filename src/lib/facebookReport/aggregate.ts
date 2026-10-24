import { GENERAL_AXIS_ID, GENERAL_AXIS_NAME_AR, HEALTH_AXES, axisNameAr } from "./axes";
import { concentrationOf, type ConcentrationRow } from "./publishers";
import { coveredPeriod } from "./window";
import type { ReportPost } from "./types";

/**
 * What the report files are built from, and nothing else: the delivered posts and comments and the counts of the collection. Saved in the job's data
 * (`metadata.facebookReport`); every number of the Excel and of the PDF is computed from it by the functions below, never typed.
 */
export interface ReportCollectionFacts {
  /** Pages of the registry that match the request's country and topic (usable or not). */
  pagesMatching: number;
  pagesUsable: number;
  /** Pages browsed: those that answered with at least one post. */
  pagesBrowsed: number;
  /** Pages that matched the request but were not used: invalid or not public in the registry, or «not found» / no post at their first call. */
  pagesSkipped: number;
  postsFound: number;
  postsOutsideWindow: number;
  postsUndated: number;
  duplicates: number;
  searchCalls: number;
  searchPosts: number;
  searchRejectedCountry: number;
  selectionDropped: number;
  shareConfigured: number;
  shareEffective: number;
  modelCalls: number;
  modelBudgetStopped: number;
  modelFailed: number;
  commentsEmpty: number;
  commentsDuplicates: number;
  commentsLinkOnly: number;
  commentsNotReturned: number;
  stopped: string | null;
}

export interface ReportPayload {
  v: 1;
  request: { topic: string; region: string; from: string; to: string; postsTarget: number; perPost: number; commentsTarget: number };
  collection: ReportCollectionFacts;
  /** Delivered posts, newest first, each with its axis and the comments delivered for it. */
  posts: ReportPost[];
  /** Per Page: what it returned, kept and dropped (display names only). */
  pages: Array<{ nameAr: string; seen: number; kept: number; outside: number; undated: number; end: string | null }>;
}

export interface AxisRow { rank: number; axisId: string; nameAr: string; posts: number; comments: number; reactions: number; shares: number; share: number }
export interface TopPost { rank: number; post: ReportPost; interactions: number }

export interface ReportModel {
  posts: ReportPost[];
  numberOf: Map<string, number>;
  kpis: { posts: number; comments: number; reactions: number; shares: number };
  axes: AxisRow[];
  top: TopPost[];
  concentration: ConcentrationRow[];
  covered: { from: string | null; to: string | null; days: number };
}

export const engagement = (post: ReportPost): number => post.reactions + post.comments + post.shares;

/** The numbered posts, the KPIs, the axes table (rank by posts, then comments), the top posts by interactions and the publisher concentration: all computed from the data. */
export function buildReportModel(payload: ReportPayload, topN = 10): ReportModel {
  const posts = [...payload.posts].sort((a, b) => (b.publishedAtMs ?? 0) - (a.publishedAtMs ?? 0) || a.key.localeCompare(b.key));
  const numberOf = new Map(posts.map((post, index) => [post.key, index + 1] as const));
  const comments = posts.reduce((sum, post) => sum + (post.commentsDelivered ?? 0), 0);
  const byAxis = new Map<string, { posts: number; comments: number; reactions: number; shares: number }>();
  for (const post of posts) {
    const id = post.axis || GENERAL_AXIS_ID;
    const row = byAxis.get(id) ?? { posts: 0, comments: 0, reactions: 0, shares: 0 };
    row.posts += 1;
    row.comments += post.commentsDelivered ?? 0;
    row.reactions += post.reactions;
    row.shares += post.shares;
    byAxis.set(id, row);
  }
  const total = posts.length || 1;
  const axes = [...byAxis.entries()]
    .map(([axisId, row]) => ({ axisId, nameAr: axisNameAr(axisId, HEALTH_AXES), ...row, share: row.posts / total }))
    .sort((a, b) => b.posts - a.posts || b.comments - a.comments || a.nameAr.localeCompare(b.nameAr, "ar"))
    .map((row, index) => ({ rank: index + 1, ...row }));
  const top = [...posts]
    .sort((a, b) => engagement(b) - engagement(a) || (b.publishedAtMs ?? 0) - (a.publishedAtMs ?? 0))
    .slice(0, topN)
    .map((post, index) => ({ rank: index + 1, post, interactions: engagement(post) }));
  return {
    posts,
    numberOf,
    kpis: { posts: posts.length, comments, reactions: posts.reduce((sum, post) => sum + post.reactions, 0), shares: posts.reduce((sum, post) => sum + post.shares, 0) },
    axes,
    top,
    concentration: concentrationOf(posts),
    covered: coveredPeriod(posts),
  };
}

/** A sheet name for an axis: at most 31 characters (Excel's limit), none of the characters Excel forbids, unique within the workbook. */
export function sheetNameFor(nameAr: string, taken: Set<string>): string {
  const base = nameAr.replace(/[\\/?*[\]:]/g, " ").replace(/\s+/g, " ").trim().slice(0, 31).trim() || GENERAL_AXIS_NAME_AR.slice(0, 31);
  let name = base;
  let n = 2;
  while (taken.has(name.toLowerCase())) {
    const suffix = ` ${n}`;
    name = `${base.slice(0, 31 - suffix.length).trim()}${suffix}`;
    n += 1;
  }
  taken.add(name.toLowerCase());
  return name;
}
