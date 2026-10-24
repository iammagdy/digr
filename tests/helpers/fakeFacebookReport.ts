import type { SocialCall, SocialCallOutcome } from "../../src/lib/server/socialAdapter";
import type { ProviderAdapterCallInput } from "../../src/lib/server/tregAdapter";
import { runFacebookReportChunk, type AxisModelCall, type ReportAdapterDeps, type ReportState, type ReportStateStore } from "../../src/lib/server/facebookReportAdapter";
import type { FacebookPageEntry } from "../../src/lib/facebookReport/registry";

/**
 * FIXTURES of the Facebook topic report, for tests only: a fake Page-posts source, a fake keyword search, a fake comments source and an in-memory record store. Nothing here was
 * read from a provider. The prices are the OWNER'S MEASURED figures of its run (0.0012 USD per Page call, 0.00188 per comments call) and the catalog's search price, in millionths
 * of a dollar, as a call outcome carries them. The shape of a row (`url`, `message`, `author`, `createdUtc`, `reaction_count`...) is the shape the reader understands, not a copy of
 * a real answer. Dates are built from the reference run's numbers by the callers.
 */
export const PAGE_CALL_MICRO = 1_200;
export const SEARCH_CALL_MICRO = 20_000;
export const COMMENTS_CALL_MICRO = 1_880;
export const DAY_MS = 86_400_000;

export interface WorldPost {
  n: number;
  dateMs: number;
  text?: string;
  /** The page name the row carries (a search result carries its own; Page posts get the Page's name from the registry). */
  author?: string;
  reactions?: number;
  comments?: number;
  shares?: number;
  video?: boolean;
  /** Extra fields of the row (a country field, say). */
  extra?: Record<string, unknown>;
}

export interface WorldPage {
  url: string;
  /** Posts newest first. */
  posts: WorldPost[];
  perCall?: number;
  /** «not_found»: the source answers 404 (a Page id it does not know). «empty»: it answers with no post (a personal profile). «down»: a server error. */
  mode?: "ok" | "not_found" | "empty" | "down";
  /** The Page keeps answering the posts of its first call with a new cursor each time. */
  repeats?: boolean;
}

export interface ReportWorld {
  pages: WorldPage[];
  search?: { posts: WorldPost[]; perCall?: number };
  /** The comments of a post by its URL (default: `defaultComments` of the count the post claims, capped at 25). */
  commentsOf?: (url: string, post: WorldPost | undefined) => Array<Record<string, any>>;
  /** Posts whose comments call returns nothing. */
  noComments?: (url: string) => boolean;
}

export const postUrl = (slug: string, n: number) => `https://www.facebook.com/${slug}/posts/${n}`;

const iso = (ms: number) => new Date(ms).toISOString();

export function postRow(post: WorldPost, slug: string): Record<string, any> {
  return {
    post_id: `${slug}_${post.n}`,
    url: postUrl(slug, post.n),
    message: post.text ?? `منشور ${post.n} عن موضوع صحي عام`,
    ...(post.author ? { author: post.author } : {}),
    createdUtc: iso(post.dateMs),
    reaction_count: post.reactions ?? 10,
    comment_count: post.comments ?? 5,
    share_count: post.shares ?? 1,
    ...(post.video ? { type: "video" } : {}),
    ...(post.extra ?? {}),
  };
}

export const defaultComments = (url: string, count: number): Array<Record<string, any>> =>
  Array.from({ length: count }, (_, i) => ({ comment_id: `c_${url.slice(-18)}_${i}`, text: `تعليق رقم ${i} على المنشور`, author: `قارئ ${i}`, created_time: "2026-10-12T10:00:00Z", reactions: i % 4, reply_count: i % 3 }));

export function facebookReportWorld(world: ReportWorld) {
  const asked: Array<{ endpoint: string; params: Record<string, any> }> = [];
  let calls = 0;
  const outcome = (rows: Array<Record<string, any>>, costMicro: number, next?: string | null): SocialCallOutcome => ({
    ok: true, httpStatus: 200, data: { ok: true, rows, ...(next ? { next_cursor: next } : {}) }, costMicro, tregCallId: `call_${++calls}`,
  });
  const pageOf = (url: string) => world.pages.find((page) => page.url === url);
  const slugOf = (url: string) => /facebook\.com\/([^/?#]+)/.exec(url)?.[1] ?? "x";
  const call: SocialCall = async (source, params) => {
    asked.push({ endpoint: source.endpointId, params });
    if (source.endpointId === "anyapi.facebook.user.posts") {
      const page = pageOf(String(params.url));
      if (!page || page.mode === "not_found") return { ok: false, httpStatus: 404, data: null, costMicro: 0, tregCallId: `call_${++calls}`, errorCode: "not_found", errorMessageAr: "الهدف غير موجود." };
      if (page.mode === "down") return { ok: false, httpStatus: 503, data: null, costMicro: 0, tregCallId: `call_${++calls}`, errorCode: "provider_down", errorMessageAr: "المصدر لا يستجيب." };
      if (page.mode === "empty") return outcome([], 0);
      const perCall = page.perCall ?? 3;
      const offset = page.repeats ? 0 : Number(params.cursor ?? 0);
      const slice = page.posts.slice(offset, offset + perCall);
      const next = offset + perCall < page.posts.length || page.repeats ? String(offset + perCall + (page.repeats ? calls : 0)) : null;
      return outcome(slice.map((post) => postRow(post, slugOf(page.url))), PAGE_CALL_MICRO, next);
    }
    if (source.endpointId === "justoneapi.x.facebook-search-post-v1") {
      const search = world.search ?? { posts: [] };
      const perCall = search.perCall ?? 6;
      const offset = Number(params.cursor ?? 0);
      const slice = search.posts.slice(offset, offset + perCall);
      const next = offset + perCall < search.posts.length ? String(offset + perCall) : null;
      return outcome(slice.map((post) => postRow(post, "searchpage")), SEARCH_CALL_MICRO, next);
    }
    if (source.endpointId === "scrapecreators.x.v1-facebook-post-comments") {
      const url = String(params.url);
      if (world.noComments?.(url)) return outcome([], 0);
      const post = [...world.pages.flatMap((page) => page.posts.map((p) => ({ p, url: postUrl(slugOf(page.url), p.n) }))), ...(world.search?.posts ?? []).map((p) => ({ p, url: postUrl("searchpage", p.n) }))].find((entry) => entry.url === url)?.p;
      const all = world.commentsOf ? world.commentsOf(url, post) : defaultComments(url, Math.min(25, post?.comments ?? 5));
      const offset = Number(params.cursor ?? 0);
      const slice = all.slice(offset, offset + 10);
      const next = offset + 10 < all.length ? String(offset + 10) : null;
      return outcome(slice, slice.length > 0 ? COMMENTS_CALL_MICRO : 0, next);
    }
    return { ok: false, httpStatus: 404, data: null, costMicro: 0, tregCallId: `call_${++calls}`, errorCode: "not_served", errorMessageAr: "غير متاح." };
  };
  return { call, asked, count: (endpoint: string) => asked.filter((entry) => entry.endpoint === endpoint).length };
}

export function memoryStore(): ReportStateStore & { states: Map<number, ReportState> } {
  const states = new Map<number, ReportState>();
  return {
    states,
    load: async (step) => { const s = states.get(step); return s ? (JSON.parse(JSON.stringify(s)) as ReportState) : null; },
    save: async (step, state) => { states.set(step, JSON.parse(JSON.stringify(state)) as ReportState); },
  };
}

export const REPORT_PARAMS = { query: "الترندات الصحية", region: "EG", dateFrom: "2026-07-24", dateTo: "2026-10-24", videoCount: 20, perVideo: 5 };

export function chunkInput(step: number, cursor: string | null, params: Record<string, any>, target: number): ProviderAdapterCallInput {
  return {
    jobId: "job_report_test", userId: "user_1", step, endpointId: "facebook-topic-report", capabilitySlug: "facebook-topic-report", method: "POST", params,
    paginationStrategy: "cursor", cursor, pageSize: 50, remainingNeeded: target, targetVolumeMax: target, deliveredSoFar: 0,
  };
}

export interface RunResult {
  rows: Array<Record<string, any>>;
  chunks: number;
  cost: number;
  final: ReportState;
  states: Map<number, ReportState>;
  progressChunks: number;
  usages: number;
  failed?: string;
}

/** Runs the whole job chunk by chunk (each chunk reads the record of the one before it), with the clock fixed so only the calls-per-chunk limit ends a chunk. */
export async function runReportJob(options: { world: ReturnType<typeof facebookReportWorld>; params?: Record<string, any>; target?: number; registry?: readonly FacebookPageEntry[]; axisModel?: AxisModelCall; maxChunks?: number }): Promise<RunResult> {
  const params = options.params ?? REPORT_PARAMS;
  const target = options.target ?? Number(params.videoCount) * Number(params.perVideo);
  const store = memoryStore();
  const deps: ReportAdapterDeps = { call: options.world.call, store, now: () => 0, axisModel: options.axisModel, ...(options.registry ? { registry: options.registry } : {}) };
  const rows: Array<Record<string, any>> = [];
  let cursor: string | null = null;
  let chunks = 0;
  let cost = 0;
  let progressChunks = 0;
  let usages = 0;
  for (; chunks < (options.maxChunks ?? 200); ) {
    const out = await runFacebookReportChunk(chunkInput(chunks, cursor, params, target), deps);
    chunks += 1;
    if (!out.ok) return { rows, chunks, cost, final: store.states.get(chunks - 2) as ReportState, states: store.states, progressChunks, usages, failed: out.errorCode };
    rows.push(...out.rows);
    cost += out.costMicro;
    if ((out as any).reportProgress) progressChunks += 1;
    usages += ((out as any).reportModelUsage ?? []).length;
    cursor = out.nextCursor;
    if (!cursor) break;
  }
  return { rows, chunks, cost, final: store.states.get(chunks - 1) as ReportState, states: store.states, progressChunks, usages };
}
