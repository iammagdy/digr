/**
 * Runs one worker chunk of a verified social capability (see lib/socialSources).
 *
 * A chunk is one slice of the job: it tries the first source and falls through to the next when a
 * source fails, answers in an unrecognized shape, or finds nothing on the first page. A request for
 * "the videos and their comments" runs in two stages inside the same job: the videos are found once,
 * then their comments are collected video by video, and where the job stands travels in the chunk
 * cursor so each chunk is independent and a restarted chunk resumes exactly where the last ended.
 *
 * The network call is injected, so every path here is covered by tests without a provider.
 */

import { extractAndFlattenRows } from "../../functions/shared/multiStepWorker";
import {
  DISCOVER_VIDEOS_PER_CHANNEL,
  MAX_TOP_PER_CHANNEL,
  channelsOf,
  MAX_PER_VIDEO,
  MAX_VIDEOS_PER_JOB,
  SOCIAL_COMMENTS_PER_VIDEO,
  SOCIAL_MAX_CALLS_PER_CHUNK,
  extractSocialRef,
  getSocialCapability,
  refFromUrl,
  resolveSocialMode,
  type SocialCapabilityDef,
  type SocialMode,
  type SocialRef,
  type SocialSource,
  type SocialSourceRequest,
} from "../socialSources";
import { timeNeededForAnotherCallMs } from "./chunkSizing";
import { classifyRowsByDate, DATE_BASIS_KEY, rowDateMs, VIDEO_PUBLISHED_AT_KEY } from "./dateRangeFilter";
import { youtubeRecencyFor } from "../youtubeRecency";
import { videoEvidence } from "./videoRelevance";
import { COMMENT_LANGUAGE_LABEL_AR, commentLanguageOf, commentTextOf, isGenericComment, isPureWellWish, isUsableComment, repeatKey, requestWantsArabicComments } from "./commentQuality";
import { maxPagesForJob } from "./providerCallCaps";
import { VIDEO_ADOPTED_KEY } from "./videoAdoption";
import { findProviderNextCursor, hasRecognizedProviderResultShape } from "./providerRows";
import type { ProviderAdapterCallInput, ProviderAdapterCallOutput } from "./tregAdapter";

export interface SocialCallOutcome {
  ok: boolean;
  httpStatus: number;
  data: any;
  costMicro: number;
  tregCallId: string;
  errorCode?: string;
  errorMessageAr?: string;
}

export interface SocialCallContext {
  /** Unique per call inside the job so a retry of the same call replays, and two different calls never collide. */
  idempotencyKey: string;
  /** Milliseconds this call may take before it is abandoned. */
  timeoutMs: number;
}

export type SocialCall = (
  source: SocialSource,
  params: Record<string, any>,
  context: SocialCallContext,
) => Promise<SocialCallOutcome>;

/** The videos of a topic search that are really about the topic, chosen from the discovery list before any comment is read. */
export interface VideoSelection {
  adopted: SocialRef[];
  /** Videos with no text of their own to judge (no title, no description): read after the adopted ones and judged by the worker with a few of their comments. */
  deferred?: SocialRef[];
  /** The job's review budget ran out while this list was judged: videos left unreviewed are not adopted, and a paged topic search stops searching (nothing more could be reviewed). */
  budgetStop?: boolean;
}
export type VideoSelector = (refs: SocialRef[]) => Promise<VideoSelection | null>;

export interface SocialAdapterDeps {
  call: SocialCall;
  now?: () => number;
  /** Set by the worker for a topic search: the videos are judged first, so comments are read (and paid for) only under adopted videos. */
  videoSelector?: VideoSelector;
}

type ResolvedDeps = { call: SocialCall; now: () => number; videoSelector?: VideoSelector };

/** The worker is cut off at 60 s; a chunk stops starting new calls well before that. */
export const SOCIAL_CHUNK_BUDGET_MS = 40_000;
const MAX_CALLS_PER_CHUNK = SOCIAL_MAX_CALLS_PER_CHUNK;
const MAX_VIDEOS = MAX_VIDEOS_PER_JOB;
const MAX_COMMENTS_PER_VIDEO = MAX_PER_VIDEO;
/** Rows a mission chunk may return: whole videos are finished inside a chunk where possible, so a source that cannot page is never truncated. */
const MISSION_ROWS_PER_CHUNK = 500;
/**
 * A paged topic search (Facebook) never reads more than this many pages of search results in one job, never stops looking before this many pages in a row brought no adopted post,
 * and keeps the identity of this many latest posts in the chunk cursor. 150 pages is 300 posts at one adopted post in three pages of 6: the most a 300-post job can need, and the
 * bound on what the search can cost (150 calls at 0.02952 USD = 4.43 USD, against the 35 USD the full job is charged).
 */
const PAGED_MAX_DISCOVERY_PAGES = 150;
/**
 * The posts of a paged search are judged in LISTS, not page by page: a search page lists about 6 posts, and one review call costs about the same for 6 posts as for 50 (the model
 * is paid for its instructions as much as for the titles), so judging page by page would pay for 100 calls where 12 do. Pages are collected until this many posts wait (fewer when
 * fewer are still wanted: twice the posts missing), then the whole list goes to the judge once.
 */
const PAGED_JUDGE_BATCH = 50;
const PAGED_MIN_JUDGE_BATCH = 6;
/** What a waiting post keeps in the chunk cursor: its link, a shortened text, nothing else. */
const compactPending = (ref: SocialRef): SocialRef => ({ ...(ref.url ? { url: ref.url } : {}), ...(ref.id ? { id: ref.id } : {}), ...(ref.title ? { title: ref.title.slice(0, 120) } : {}), ...(typeof ref.publishedAtMs === "number" ? { publishedAtMs: ref.publishedAtMs } : {}) });
/**
 * A search that finds no post about the topic stops by itself. Posts are counted, not pages: the first list judged is a short probe (12 posts, two pages), and the search ends after
 * 36 listed posts without one adopted (6 pages, 0.18 USD at the first source's price); once a post has been adopted the search ends after 50 more in a row without one (one full list,
 * 9 pages). Nothing is charged to the customer for a search that found nothing: these bounds are what such a job costs the platform.
 */
const PAGED_PROBE_POSTS = 12;
const PAGED_BARREN_POSTS_BEFORE_FIRST = 36;
const PAGED_BARREN_POSTS_AFTER_FIRST = 50;
const PAGED_MAX_REPEAT_PAGES = 2;
const PAGED_SEEN_POSTS_KEPT = 300;

/** A short stable identity of a post for the list of posts already seen (FNV-1a, 8 hex digits): small enough to travel in the chunk cursor. */
function shortIdentity(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

interface SocialState {
  /** Stage: d = discovering videos, c = collecting comments. */
  ph: "d" | "c";
  refs?: SocialRef[];
  /** Index of the video being collected. */
  i?: number;
  /** Cursor for the next page of the discovery stage. */
  dc?: string | null;
  /** Cursor for the next page of the current video's comments. */
  cc?: string | null;
  /** Comments already taken from the current video. */
  n?: number;
  /** Index of the source whose paging the cursors belong to. */
  si?: number | null;
  /** Mission over several channels: the channel being read (discovery stage) and how many could not be read. */
  ci?: number;
  fc?: number;
  /** Rows of the answer at `cc` (or of the first answer) that earlier chunks already took: a chunk stops at its share and the next one starts after them. */
  po?: number;
  /** Comments read from each adopted video (topic search): sized from the videos adopted so the first ones can fill the job. */
  pv?: number;
  /** Paged topic search: usable comments already kept from the post being read when a chunk ended inside it (its share is `pv`, never more across chunks). */
  pu?: number;
  /** How many of the first `refs` were adopted before their comments were read; the comments of the rest are judged by the worker. */
  ad?: number;
  /** Non-Arabic comments kept aside for an Arabic request: delivered only if the volume cannot be filled otherwise. */
  sp?: Record<string, any>[];
  /** Paged topic search (a service with `pagedDiscovery`): the source that gave `dc`, discovery pages read, posts adopted so far, pages in a row with no adopted post, pages in a row that only repeated posts already seen, and a short identity of the latest posts seen. */
  ds?: number | null;
  pg?: number;
  pp?: number;
  np?: number;
  rp?: number;
  sk?: string[];
  /** Paged topic search: the posts listed by earlier pages that wait to be judged as one list. */
  pq?: SocialRef[];
}

function encodeState(state: SocialState): string {
  return JSON.stringify(state);
}

function decodeState(cursor: string | null): SocialState | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(cursor);
    return parsed && (parsed.ph === "d" || parsed.ph === "c") ? (parsed as SocialState) : null;
  } catch {
    return null;
  }
}

function rowKey(row: Record<string, any>): string | null {
  for (const key of ["comment_id", "cid", "id", "video_id", "aweme_id", "post_id", "url"]) {
    const value = String(row?.[key] ?? "").trim();
    if (value) return `${key}:${value}`;
  }
  return null;
}

interface ChainResult {
  ok: boolean;
  rows: Record<string, any>[];
  nextCursor: string | null;
  sourceIndex: number;
  costMicro: number;
  calls: number;
  callIds: string[];
  httpStatus: number;
  errorCode?: string;
  errorMessageAr?: string;
}

class ChunkClock {
  private calls = 0;
  private slowestCallMs = 0;
  readonly startedAt: number;
  constructor(private readonly now: () => number) {
    this.startedAt = now();
  }
  get callsMade(): number {
    return this.calls;
  }
  nextCall(): number {
    return ++this.calls;
  }
  /** The duration of a call of this chunk, so the next call is started only if the time left covers a call as slow as the slowest so far. */
  noteCallMs(ms: number): void {
    if (Number.isFinite(ms) && ms > this.slowestCallMs) this.slowestCallMs = ms;
  }
  remainingMs(): number {
    return SOCIAL_CHUNK_BUDGET_MS - (this.now() - this.startedAt);
  }
  canCallAgain(): boolean {
    return this.calls < MAX_CALLS_PER_CHUNK && this.remainingMs() >= timeNeededForAnotherCallMs(this.slowestCallMs);
  }
}

/**
 * Tries the sources in order until one answers with a usable list. When `stickyIndex` is given the
 * cursor belongs to that source, so only it is used (a page cursor means nothing to another source).
 * An empty first page is checked with the next source unless `fallThroughOnEmpty` is off (a video among
 * many that simply has no comments is skipped, not re-asked).
 */
async function runChain(
  sources: SocialSource[],
  request: SocialSourceRequest,
  stickyIndex: number | null,
  deps: ResolvedDeps,
  clock: ChunkClock,
  keyPrefix: string,
  fallThroughOnEmpty = true,
): Promise<ChainResult> {
  const result: ChainResult = {
    ok: false,
    rows: [],
    nextCursor: null,
    sourceIndex: stickyIndex ?? 0,
    costMicro: 0,
    calls: 0,
    callIds: [],
    httpStatus: 0,
  };
  const firstPage = !request.cursor;
  const indexes = stickyIndex !== null && stickyIndex >= 0 ? [stickyIndex] : sources.map((_, i) => i);
  let emptyAnswer: ChainResult | null = null;

  for (const index of indexes) {
    const source = sources[index];
    if (!source) continue;
    const params = source.build(request);
    if (!params) continue;
    if (!clock.canCallAgain() && result.calls > 0) break;

    const n = clock.nextCall();
    const callStartedAt = deps.now();
    const outcome = await deps.call(source, params, {
      idempotencyKey: `${keyPrefix}_c${n}_${source.endpointId}`.slice(0, 120),
      timeoutMs: Math.max(5_000, Math.min(25_000, clock.remainingMs() - 4_000)),
    });
    clock.noteCallMs(deps.now() - callStartedAt);
    result.calls += 1;
    result.costMicro += Math.max(0, Number(outcome.costMicro) || 0);
    if (outcome.tregCallId) result.callIds.push(outcome.tregCallId);
    result.httpStatus = outcome.httpStatus;

    if (!outcome.ok) {
      result.errorCode = outcome.errorCode;
      result.errorMessageAr = outcome.errorMessageAr;
      continue;
    }
    if (!hasRecognizedProviderResultShape(outcome.data)) {
      result.errorCode = "invalid_provider_payload";
      result.errorMessageAr = "استجاب المصدر ببيانات غير متوافقة مع نوع البحث.";
      continue;
    }

    const rows = extractAndFlattenRows(outcome.data);
    const next =
      source.paging === "none"
        ? null
        : source.nextCursor
        ? source.nextCursor(rows.length, request)
        : findProviderNextCursor(outcome.data);

    if (rows.length === 0 && firstPage && indexes.length > 1 && fallThroughOnEmpty) {
      // A valid empty answer on the first page: another source may still know the target.
      emptyAnswer = { ...result, ok: true, rows: [], nextCursor: null, sourceIndex: index };
      continue;
    }

    return {
      ...result,
      ok: true,
      rows,
      nextCursor: next && next !== String(request.cursor ?? "") ? next : null,
      sourceIndex: index,
      errorCode: undefined,
      errorMessageAr: undefined,
    };
  }

  if (emptyAnswer) return { ...emptyAnswer, costMicro: result.costMicro, calls: result.calls, callIds: result.callIds };
  return result;
}

function failure(chain: { costMicro: number; callIds: string[]; httpStatus?: number; errorCode?: string; errorMessageAr?: string }, messageAr?: string): ProviderAdapterCallOutput {
  return {
    ok: false,
    httpStatus: chain.httpStatus || 502,
    rows: [],
    nextCursor: null,
    costUsd: Number((chain.costMicro / 1_000_000).toFixed(6)),
    costMicro: chain.costMicro,
    tregCallId: chain.callIds.join(","),
    errorCode: chain.errorCode || "provider_failure",
    errorMessageAr: messageAr || chain.errorMessageAr || "تعذر استخراج البيانات من المصدر بعد عدة محاولات.",
  };
}

function success(
  rows: Record<string, any>[],
  nextCursor: string | null,
  totals: { costMicro: number; callIds: string[] },
): ProviderAdapterCallOutput {
  return {
    ok: true,
    httpStatus: 200,
    rows,
    nextCursor,
    costUsd: Number((totals.costMicro / 1_000_000).toFixed(6)),
    costMicro: totals.costMicro,
    tregCallId: totals.callIds.join(","),
  };
}

/**
 * Comments are judged by their OWN creation time. When the source gives a window's worth of comments of one video and not
 * one of them carries a date of its own, the only date there is, is the video's: those comments are marked so the worker
 * applies the window to the video's publication date (and says so), instead of silently dropping every comment as undated.
 */
function markVideoDateBasis(rows: Record<string, any>[], ref: SocialRef | undefined, params: Record<string, any>): Record<string, any>[] {
  const windowed = typeof params.dateFrom === "string" || typeof params.dateTo === "string";
  if (!windowed || !ref || ref.publishedAtMs === undefined || rows.length === 0) return rows;
  if (rows.some((row) => rowDateMs(row) !== null)) return rows;
  return rows.map((row) => ({ ...row, [DATE_BASIS_KEY]: "video", [VIDEO_PUBLISHED_AT_KEY]: ref.publishedAtMs }));
}

function annotateComment(row: Record<string, any>, ref: SocialRef | undefined): Record<string, any> {
  if (!ref) return row;
  return {
    ...row,
    ...(ref.url ? { video_url: ref.url } : {}),
    ...(ref.title ? { video_title: ref.title } : {}),
    ...(ref.channel ? { channel_name: ref.channel } : {}),
    ...(typeof ref.views === "number" ? { video_views: ref.views } : {}),
    ...(isoDay(ref.publishedAtMs) ? { video_published_at: isoDay(ref.publishedAtMs) } : {}),
  };
}

const norm = (text: string) => String(text || "").toLowerCase().replace(/[ً-ٰٟـ]/g, "").replace(/[أإآ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه");

/** The words a video title must contain (any of them) to count as «about the topic»; none when no topic was asked. */
function topicWords(topic: unknown): string[] {
  return norm(String(topic || ""))
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 3 && !["عن", "في", "من", "على", "الي", "كل", "مع"].includes(word));
}

/**
 * A mission over several channels: for each channel, its latest videos are read, the topic filter (if any) is applied,
 * they are ranked by views and the top N are kept; then the comments of every kept video are collected, video by video,
 * up to the job's volume. The state travels in the chunk cursor, so a restarted chunk resumes where the last ended.
 * A channel that cannot be read is skipped; if none can be read and nothing was delivered, the job fails (and is released).
 */
async function runMissionChunk(
  cap: SocialCapabilityDef,
  input: ProviderAdapterCallInput,
  params: Record<string, any>,
  wanted: number,
  deps: ResolvedDeps,
  clock: ChunkClock,
  keyPrefix: string,
  totals: { costMicro: number; callIds: string[] },
  absorb: (chain: ChainResult) => void,
): Promise<ProviderAdapterCallOutput> {
  const channels = channelsOf(params);
  const sources = cap.discover.channel || [];
  const commentSources = cap.comments || [];
  const topN = Math.max(1, Math.min(MAX_TOP_PER_CHANNEL, Math.floor(Number(params.topPerChannel) || 10)));
  const words = topicWords(params.topic);
  const rankByViews = params.rankBy === "views";
  const askedPerVideo = Number(params.perVideo) > 0 ? Math.floor(Number(params.perVideo)) : MAX_COMMENTS_PER_VIDEO;
  const target = Math.max(1, input.targetVolumeMax || wanted);
  const perVideo = Math.min(MAX_COMMENTS_PER_VIDEO, askedPerVideo, target);
  const rowCap = Math.min(MISSION_ROWS_PER_CHUNK, Math.max(1, input.remainingNeeded || wanted));
  const needAtLeast = Math.max(1, Math.ceil(words.length / 2));

  let state: SocialState = decodeState(input.cursor) || { ph: "d", ci: 0, refs: [], fc: 0 };
  const rows: Record<string, any>[] = [];
  const seen = new Set<string>();
  let lastError: Pick<ChainResult, "httpStatus" | "errorCode" | "errorMessageAr"> | null = null;
  let commentsAnswered = false;

  while (rows.length < rowCap && clock.canCallAgain()) {
    if (state.ph === "d") {
      const ci = state.ci ?? 0;
      if (ci >= channels.length) {
        const refs = state.refs || [];
        if (refs.length === 0) {
          // Nothing to collect: every channel failed (a source failure) or none had a matching video (an empty result).
          if ((state.fc ?? 0) >= channels.length && lastError && (input.deliveredSoFar || 0) === 0) {
            return failure({ ...totals, httpStatus: lastError.httpStatus, errorCode: lastError.errorCode, errorMessageAr: lastError.errorMessageAr });
          }
          return success([], null, totals);
        }
        state = { ph: "c", refs, i: 0, cc: null, n: 0, si: null };
        continue;
      }
      const channel = channels[ci];
      const chain = await runChain(sources, { channel, limit: DISCOVER_VIDEOS_PER_CHANNEL, cursor: null }, null, deps, clock, `${keyPrefix}_m${ci}`);
      absorb(chain);
      if (!chain.ok) {
        lastError = chain;
        state = { ...state, ci: ci + 1, fc: (state.fc ?? 0) + 1 };
        continue;
      }
      const found: SocialRef[] = [];
      const foundKeys = new Set<string>();
      for (const row of chain.rows) {
        const ref = extractSocialRef(cap.platform, row);
        const key = ref?.id || ref?.url;
        if (!ref || !key || foundKeys.has(key)) continue;
        foundKeys.add(key);
        found.push(ref);
      }
      const matching = words.length > 0 ? found.filter((ref) => words.filter((word) => norm(ref.title || "").includes(word)).length >= needAtLeast) : found;
      const ranked = rankByViews
        ? [...matching].sort((a, b) => (b.views ?? -1) - (a.views ?? -1))
        : matching;
      const kept = ranked.slice(0, topN).map((ref) => ({ ...ref, channel, ...(ref.title ? { title: ref.title.slice(0, 80) } : {}) }));
      state = { ...state, ci: ci + 1, refs: [...(state.refs || []), ...kept] };
      continue;
    }

    const refs = state.refs || [];
    const index: number = state.i ?? 0;
    if (index >= refs.length) return success(rows, null, totals);
    const ref = refs[index];
    const wantFromVideo = Math.max(1, Math.min(perVideo - (state.n ?? 0), Math.max(1, (input.remainingNeeded || wanted) - rows.length)));
    const room = rowCap - rows.length;
    // A video is started whole: when this chunk has no room for it, it is read in the next chunk (a source that cannot
    // page would otherwise be cut short and the rest of the video lost).
    if (rows.length > 0 && (state.n ?? 0) === 0 && !state.cc && room < wantFromVideo) break;
    const need = Math.max(1, Math.min(wantFromVideo, room));
    const chain = await runChain(commentSources, { ref, limit: need, cursor: state.cc ?? null }, state.cc || state.po ? state.si ?? null : null, deps, clock, `${keyPrefix}_v${index}`, false);
    absorb(chain);
    if (!chain.ok) {
      lastError = chain;
      state = { ...state, i: index + 1, cc: null, n: 0, si: null };
      continue;
    }
    commentsAnswered = true;
    const fresh = dedupe(chain.rows, seen).slice(0, Math.max(0, Math.min(need, rowCap - rows.length)));
    for (const row of markVideoDateBasis(fresh, ref, params)) rows.push(annotateComment(row, ref));
    const taken: number = (state.n ?? 0) + fresh.length;
    const more: boolean = Boolean(chain.nextCursor) && taken < perVideo && fresh.length > 0;
    state = more ? { ...state, cc: chain.nextCursor, n: taken, si: chain.sourceIndex } : { ...state, i: index + 1, cc: null, n: 0, si: null };
  }

  const finished = state.ph === "c" && (state.i ?? 0) >= (state.refs?.length ?? 0) && state.refs !== undefined;
  if (rows.length === 0 && finished && !commentsAnswered && lastError && (input.deliveredSoFar || 0) === 0) {
    return failure({ ...totals, httpStatus: lastError.httpStatus, errorCode: lastError.errorCode, errorMessageAr: lastError.errorMessageAr });
  }
  const reachedTarget = rows.length >= Math.max(1, input.remainingNeeded || wanted);
  return success(rows, finished || reachedTarget ? null : encodeState(state), totals);
}

function discoveryRequest(mode: Exclude<SocialMode, "url">, params: Record<string, any>, limit: number, cursor: string | null, nowMs: number = Date.now()): SocialSourceRequest {
  const recency = mode === "query" ? youtubeRecencyFor(params.dateFrom, params.dateTo, nowMs) : null;
  return {
    limit,
    cursor,
    ...(recency ? { recency } : {}),
    ...(mode === "query" ? { query: String(params.query || "").trim() } : {}),
    ...(mode === "query" && typeof params.dateFrom === "string" ? { dateFrom: params.dateFrom } : {}),
    ...(mode === "query" && typeof params.dateTo === "string" ? { dateTo: params.dateTo } : {}),
    ...(mode === "query" && typeof params.region === "string" && params.region.trim() ? { region: params.region.trim().toUpperCase() } : {}),
    ...(mode === "channel" ? { channel: String(params.channel || "").trim() } : {}),
    ...(mode === "trending" ? { region: String(params.region || "").trim() } : {}),
  };
}

/** The identity of a video in a discovery list: its id, else its link, else its title. */
const refIdentity = (ref: SocialRef): string => String(ref.id || ref.url || ref.title || "");

/** A second search can differ from the first only by dropping the country word and the recency control, or by asking the other source first. */
function canWiden(request: SocialSourceRequest, sources: SocialSource[]): boolean {
  return Boolean(request.region) || Boolean(request.recency) || sources.length > 1;
}

/** The first search without the country (its name is no longer in the search text) and without the recency control. */
function widerRequest(request: SocialSourceRequest): SocialSourceRequest {
  const { region: _region, recency: _recency, ...rest } = request;
  return rest;
}

/** The sources in the order of the second search: the ones after the source that answered first, then the rest. */
function widerSources(sources: SocialSource[], answeredIndex: number): SocialSource[] {
  const at = Math.max(0, Math.min(sources.length - 1, answeredIndex));
  return [...sources.slice(at + 1), ...sources.slice(0, at + 1)];
}

/**
 * When the window needs a recency control, the sources that take one are asked first (the others cannot find videos of a past
 * period at all); the rest follow as fallbacks. Without a window the catalog order is kept. The order depends only on the
 * request, so a cursor stored by one chunk means the same source in the next.
 */
function orderForRecency(sources: SocialSource[], request: SocialSourceRequest): SocialSource[] {
  if (!request.recency) return sources;
  return [...sources.filter((source) => source.recency), ...sources.filter((source) => !source.recency)];
}

export async function runSocialChunk(
  input: ProviderAdapterCallInput,
  deps: SocialAdapterDeps,
): Promise<ProviderAdapterCallOutput> {
  const cap = getSocialCapability(input.capabilitySlug);
  const resolved: ResolvedDeps = { call: deps.call, now: deps.now || Date.now, videoSelector: deps.videoSelector };
  const clock = new ChunkClock(resolved.now);
  const params = input.params || {};
  const mode = resolveSocialMode(params);

  if (!cap || !mode) {
    return failure({ costMicro: 0, callIds: [], httpStatus: 422, errorCode: "invalid_social_request" }, "تعذر فهم نوع الطلب؛ لم يُنفَّذ أي استخراج.");
  }

  const wanted = Math.max(1, Math.min(input.remainingNeeded || 1, input.pageSize || 50));
  const keyPrefix = `${input.jobId}_s${input.step}`;
  const totals = { costMicro: 0, callIds: [] as string[] };
  const absorb = (chain: ChainResult) => {
    totals.costMicro += chain.costMicro;
    totals.callIds.push(...chain.callIds);
  };

  // Videos or posts as the deliverable: page through the discovery sources.
  if (cap.kind === "videos" || cap.kind === "posts") {
    if (mode === "url") {
      return failure(totals, "هذا النوع من الطلبات يحتاج كلمة بحث أو حساباً محدداً.");
    }
    const state = decodeState(input.cursor);
    const request = discoveryRequest(mode, params, wanted, state?.dc ?? null, resolved.now());
    const sources = orderForRecency(cap.discover[mode] || [], request);
    const chain = await runChain(sources, request, state ? state.si ?? null : null, resolved, clock, keyPrefix);
    absorb(chain);
    if (!chain.ok) return failure({ ...totals, httpStatus: chain.httpStatus, errorCode: chain.errorCode, errorMessageAr: chain.errorMessageAr });
    const rows = dedupe(chain.rows).slice(0, wanted);
    const nextState: SocialState | null = chain.nextCursor ? { ph: "d", dc: chain.nextCursor, si: chain.sourceIndex } : null;
    return success(rows, nextState ? encodeState(nextState) : null, totals);
  }

  // Comments as the deliverable.
  return runCommentsChunk(cap, mode, input, params, wanted, resolved, clock, keyPrefix, totals, absorb);
}

function dedupe(rows: Record<string, any>[], seen: Set<string> = new Set()): Record<string, any>[] {
  const out: Record<string, any>[] = [];
  for (const row of rows) {
    const key = rowKey(row);
    if (key) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(row);
  }
  return out;
}

/** A topic search asks for a full first page of videos (the sources answer up to this many in one call), so a window or a topic filter has a pool to pick from. */
const TOPIC_DISCOVERY_VIDEOS = 20;
/** Comments kept aside (non-Arabic, for an Arabic request) and the smallest read per adopted video. */
const MAX_SPILL_ROWS = 40;
const MIN_READ_PER_VIDEO = 20;
/**
 * A topic search reads comments from at least this many adopted videos when the source has them: with only one or two adopted videos on the first page of
 * results, one video would carry the whole job (33 comments came from 2 videos). One more page of results is judged (never more than one, and only inside
 * the chunk's own call limit) before any comment is read. The relevance judgement of the videos is the same one: nothing is adopted that it did not adopt.
 */
const MIN_DIVERSE_VIDEOS = 5;
const SPILL_KEYS = [
  "comment_id", "cid", "id", "text", "comment", "comment_text", "content", "author", "author_name", "username", "likes", "like_count", "replies", "reply_count",
  "published_date", "published_at", "create_time", "date", "published_time", "publishedTime", "published_time_text", "time_ago", "timeAgo",
  "video_url", "video_title", "video_published_at", "channel_name", "video_views", "comment_language", DATE_BASIS_KEY, VIDEO_PUBLISHED_AT_KEY, VIDEO_ADOPTED_KEY,
];

/** A row small enough to travel in the chunk cursor. */
function compactRow(row: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const key of SPILL_KEYS) {
    const value = row[key];
    if (value === undefined || value === null) continue;
    out[key] = typeof value === "string" ? value.slice(0, 400) : value;
  }
  return out;
}

const isoDay = (ms: number | undefined): string | undefined => (typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : undefined);

async function runCommentsChunk(
  cap: SocialCapabilityDef,
  mode: SocialMode,
  input: ProviderAdapterCallInput,
  params: Record<string, any>,
  wanted: number,
  deps: ResolvedDeps,
  clock: ChunkClock,
  keyPrefix: string,
  totals: { costMicro: number; callIds: string[] },
  absorb: (chain: ChainResult) => void,
): Promise<ProviderAdapterCallOutput> {
  if (channelsOf(params).length > 0) {
    return runMissionChunk(cap, input, params, wanted, deps, clock, keyPrefix, totals, absorb);
  }
  const commentSources = cap.comments || [];
  const target = Math.max(1, input.targetVolumeMax || wanted);
  // A topic search (videos found by a keyword): the videos are judged first, the comments of adopted videos are read deeply, and the
  // comments themselves are filtered for usefulness. A named video, a channel or the trending list keep the plain reading.
  const topicSearch = mode === "query" && String(params.query || "").trim() !== "";
  // A service with paged discovery (Facebook posts of a topic) keeps searching page after page until the posts wanted are adopted; the others judge one page of videos.
  const pagedTopic = topicSearch && Boolean(cap.pagedDiscovery);
  const askedPerVideo = Number(params.perVideo) > 0 ? Math.floor(Number(params.perVideo)) : pagedTopic ? cap.minPerVideo ?? SOCIAL_COMMENTS_PER_VIDEO : SOCIAL_COMMENTS_PER_VIDEO;
  const perVideo = mode === "url" ? Math.min(MAX_COMMENTS_PER_VIDEO, target) : Math.min(MAX_COMMENTS_PER_VIDEO, askedPerVideo, target);
  // Posts a paged job may adopt: the number the customer asked for, else twice what the comments wanted need (posts can give fewer comments than asked), never above the service's ceiling.
  const postAllowance = pagedTopic ? Math.min(cap.maxVideos ?? MAX_VIDEOS, Number(params.videoCount) > 0 ? Math.floor(Number(params.videoCount)) : Math.ceil(target / perVideo) * 2) : 0;
  const arabicFirst = topicSearch && requestWantsArabicComments(params);
  const perVideoStated = Number(params.perVideo) > 0;

  let state = decodeState(input.cursor);
  if (!state) {
    if (mode === "url") {
      const ref = refFromUrl(cap.platform, String(params.url || ""));
      if (!ref) return failure(totals, "تعذر قراءة الرابط؛ أرسل رابط الفيديو أو المنشور كاملاً.");
      state = { ph: "c", refs: [ref], i: 0, cc: null, n: 0, si: null };
    } else {
      state = { ph: "d", dc: null, si: null };
    }
  }

  const rows: Record<string, any>[] = [];
  const seen = new Set<string>();
  const seenRepeats = new Set<string>();
  const spill: Record<string, any>[] = [...(state.sp || [])];
  let lastError: Pick<ChainResult, "httpStatus" | "errorCode" | "errorMessageAr"> | null = null;
  let commentsAnswered = false;
  let windowHint: "recency_applied" | "recency_unsupported" | undefined;
  const windowed = typeof params.dateFrom === "string" || typeof params.dateTo === "string";
  // With a window, only the comments inside it count toward what was asked: the worker drops the others, so counting them
  // would end the job after one old video that was entirely outside the window.
  // A topic search also counts only comments that say something: the others still travel to the worker (which rejects them with its
  // own reason) but never fill the volume.
  // A paged topic search (the Facebook keyword service) also leaves out pure well-wishes («بالتوفيق والنجاح»): they never fill the volume or a post's share, and the gate rejects them.
  const countsAsComment = (row: Record<string, any>) => isUsableComment(row) && !isGenericComment(commentTextOf(row)) && !(pagedTopic && isPureWellWish(commentTextOf(row)));
  const postReads = { read: 0, sourceShort: 0, filteredShort: 0, asked: askedPerVideo };
  const credited = (list: Record<string, any>[]) => countInsideOf(topicSearch ? list.filter(countsAsComment) : list, params);
  const countedRows = () => credited(rows);
  const withHint = (out: ProviderAdapterCallOutput): ProviderAdapterCallOutput => ({
    ...out,
    ...(windowHint ? { discoveryWindow: windowHint } : {}),
    ...(pagedTopic && postReads.read > 0 ? { postReads } : {}),
  });

  while (countedRows() < wanted && clock.canCallAgain()) {
    if (state.ph === "d") {
      if (mode === "url") break;
      if (pagedTopic) {
        const postsSoFar: number = state.pp ?? 0;
        const pageNumber: number = state.pg ?? 0;
        // The posts wanted are adopted (or the pages allowed are read): the job ends here with what its posts gave.
        if (postsSoFar >= postAllowance || pageNumber >= PAGED_MAX_DISCOVERY_PAGES) return withHint(success(flushSpill(), null, totals));
        const sources = cap.discover[mode] || [];
        // The page asks for twice the posts still wanted (about half of the posts found are about the topic), at most one page of the widest source.
        const request = discoveryRequest(mode, params, Math.min(20, Math.max(1, (postAllowance - postsSoFar) * 2)), state.dc ?? null, deps.now());
        const chain = await runChain(sources, request, state.dc ? state.ds ?? null : null, deps, clock, `${keyPrefix}_d`);
        absorb(chain);
        if (!chain.ok) {
          // The comments this chunk already read are kept; the next chunk asks for this page again. With none, the failure ends the job (the worker keeps what earlier chunks delivered).
          if (rows.length > 0) return withHint(success(rows, encodeState(state), totals));
          return failure({ ...totals, httpStatus: chain.httpStatus, errorCode: chain.errorCode, errorMessageAr: chain.errorMessageAr });
        }
        if (pageNumber === 0 && chain.rows.length === 0) return { ...success([], null, totals), emptyReason: "no_videos" };
        const pageRefs = videosInWindowFirst(refsOfPage(cap.platform, chain.rows, 20), params);
        if (pageNumber === 0 && chain.rows.length > 0 && pageRefs.length === 0) {
          return failure(totals, "تعذر تحديد روابط المنشورات من نتائج البحث؛ لم يُحتسب أي خصم.");
        }
        const known: Set<string> = new Set(state.sk || []);
        const fresh: SocialRef[] = pageRefs.filter((ref: SocialRef) => !known.has(shortIdentity(refIdentity(ref))));
        const seenNow: string[] = [...(state.sk || []), ...fresh.map((ref: SocialRef) => shortIdentity(refIdentity(ref)))].slice(-PAGED_SEEN_POSTS_KEPT);
        // A page made only of posts already seen: the source repeats itself. Two such pages in a row (or a page with no way to go on) end the search.
        const repeats: number = pageRefs.length > 0 && fresh.length === 0 ? (state.rp ?? 0) + 1 : 0;
        const goOn = Boolean(chain.nextCursor) && chain.rows.length > 0 && repeats < PAGED_MAX_REPEAT_PAGES && pageNumber + 1 < PAGED_MAX_DISCOVERY_PAGES;
        const pending: SocialRef[] = [...(state.pq || []), ...fresh.map(compactPending)];
        // Posts are judged as a list: another page is read first while fewer posts wait than one review list holds (and more pages exist).
        const listWanted = Math.min(postsSoFar === 0 ? PAGED_PROBE_POSTS : PAGED_JUDGE_BATCH, Math.max(PAGED_MIN_JUDGE_BATCH, (postAllowance - postsSoFar) * 2));
        if (goOn && pending.length < listWanted) {
          state = { ph: "d", dc: chain.nextCursor, ds: chain.sourceIndex, pg: pageNumber + 1, pp: postsSoFar, np: state.np ?? 0, rp: repeats, sk: seenNow, ...(pending.length ? { pq: pending } : {}), ...(spill.length ? { sp: spill } : {}) };
          continue;
        }
        // The posts about the topic are chosen BEFORE any comment is read; only adopted posts are read (a post the review could not settle is not read, and a failed selection adopts nothing).
        // While the search goes on the list is exactly one review list of posts (the posts of the last page that do not fit wait for the next list: two calls of 25 are cheaper than three of 25, 25 and 4).
        const judged: SocialRef[] = goOn ? pending.slice(0, listWanted) : pending;
        const carried: SocialRef[] = goOn ? pending.slice(listWanted) : [];
        let adopted: SocialRef[] = judged;
        let adoptedCount = 0;
        let budgetStop = false;
        if (deps.videoSelector && judged.length > 0) {
          const selection = await deps.videoSelector(judged).catch(() => null);
          adopted = selection ? selection.adopted : [];
          budgetStop = Boolean(selection?.budgetStop);
        }
        adopted = adopted.slice(0, Math.max(0, postAllowance - postsSoFar));
        if (deps.videoSelector) adoptedCount = adopted.length;
        const searchOn = goOn && !budgetStop;
        if (adopted.length === 0) {
          // posts judged in a row without one adopted (not pages: a list is several pages)
          const barren: number = (state.np ?? 0) + judged.length;
          if (!searchOn || barren >= (postsSoFar === 0 ? PAGED_BARREN_POSTS_BEFORE_FIRST : PAGED_BARREN_POSTS_AFTER_FIRST)) {
            if (postsSoFar === 0 && rows.length === 0 && (input.deliveredSoFar || 0) === 0) return withHint({ ...success([], null, totals), emptyReason: "no_relevant_videos" });
            return withHint(success(flushSpill(), null, totals));
          }
          state = { ph: "d", dc: chain.nextCursor, ds: chain.sourceIndex, pg: pageNumber + 1, pp: postsSoFar, np: barren, rp: repeats, sk: seenNow, ...(carried.length ? { pq: carried } : {}), ...(spill.length ? { sp: spill } : {}) };
          continue;
        }
        state = {
          ph: "c", refs: adopted, i: 0, cc: null, n: 0, si: null, pv: perVideo,
          ...(adoptedCount ? { ad: adoptedCount } : {}),
          dc: searchOn ? chain.nextCursor : null, ds: chain.sourceIndex, pg: pageNumber + 1, pp: postsSoFar + adopted.length, np: 0, rp: repeats, sk: seenNow,
          ...(carried.length && searchOn ? { pq: carried } : {}),
          ...(spill.length ? { sp: spill } : {}),
        };
        continue;
      }
      const askedVideos = Number(params.videoCount) > 0 ? Math.floor(Number(params.videoCount)) : 0;
      const wantedVideos = Math.ceil(target / perVideo) + 2;
      const videoCount = Math.min(MAX_VIDEOS, askedVideos || (topicSearch ? Math.max(TOPIC_DISCOVERY_VIDEOS, wantedVideos) : wantedVideos));
      const request = discoveryRequest(mode, params, videoCount, state.dc ?? null, deps.now());
      const sources = orderForRecency(cap.discover[mode] || [], request);
      let chain = await runChain(sources, request, null, deps, clock, `${keyPrefix}_d`);
      absorb(chain);
      if (!chain.ok) return failure({ ...totals, httpStatus: chain.httpStatus, errorCode: chain.errorCode, errorMessageAr: chain.errorMessageAr });
      let refs = refsOfPage(cap.platform, chain.rows, videoCount);
      let recencyApplied = Boolean(request.recency) && Boolean(sources[chain.sourceIndex]?.recency);
      // The page came from a source that does not take the recency control (the one that does failed or had nothing) and every
      // video whose date is known is outside the window: ONE more attempt with the recency control before reading any comment.
      if (request.recency && !recencyApplied && sources[0]?.recency && refs.length > 0 && videosAllOutsideWindow(refs, params) && clock.canCallAgain()) {
        const again = await runChain([sources[0]], request, null, deps, clock, `${keyPrefix}_d2`);
        absorb(again);
        const againRefs = again.ok ? refsOfPage(cap.platform, again.rows, videoCount) : [];
        if (againRefs.length > 0) {
          chain = again;
          refs = againRefs;
          recencyApplied = true;
        }
      }
      if (cap.platform === "youtube" && (typeof params.dateFrom === "string" || typeof params.dateTo === "string")) {
        windowHint = recencyApplied ? "recency_applied" : "recency_unsupported";
      }
      refs = videosInWindowFirst(refs, params);
      if (chain.rows.length > 0 && refs.length === 0) {
        return failure(totals, "تعذر تحديد روابط الفيديوهات من نتائج البحث؛ لم يُحتسب أي خصم.");
      }
      if (refs.length === 0) return { ...success([], null, totals), emptyReason: "no_videos" };
      // The videos about the topic are chosen BEFORE any comment is read: nothing is spent on a video that would be dropped, and the
      // comments of the adopted ones can be read deeply. A selector that cannot decide adopts nothing (fail closed).
      let pv: number | undefined = state.pv;
      let adoptedCount = 0;
      if (topicSearch && deps.videoSelector) {
        const judgedIdentities = new Set(refs.map(refIdentity));
        let selection = await deps.videoSelector(refs).catch(() => null);
        // No video to read after the first search: ONE wider search before the job stops (the country word and the recency control are dropped
        // and the other source answers first), inside this chunk's call limit. Videos the first search showed are not judged again.
        if (selection && selection.adopted.length + (selection.deferred?.length ?? 0) === 0 && canWiden(request, sources) && clock.canCallAgain()) {
          const again = await runChain(widerSources(sources, chain.sourceIndex), widerRequest(request), null, deps, clock, `${keyPrefix}_d3`);
          absorb(again);
          if (again.ok) {
            const fresh = videosInWindowFirst(refsOfPage(cap.platform, again.rows, videoCount).filter((ref) => !judgedIdentities.has(refIdentity(ref))), params);
            if (fresh.length > 0) {
              const second = await deps.videoSelector(fresh).catch(() => null);
              if (second) {
                selection = second;
                if (cap.platform === "youtube" && windowed) windowHint = "recency_unsupported";
              }
            }
          }
        }
        // Too few videos to spread the job over: ONE more page of results is judged, by the same video review, before any comment is read.
        if (selection && selection.adopted.length > 0) {
          const wantVideos = Math.min(MIN_DIVERSE_VIDEOS, askedVideos || MIN_DIVERSE_VIDEOS);
          const haveVideos = () => selection!.adopted.length + (selection!.deferred?.length ?? 0);
          if (haveVideos() < wantVideos && chain.nextCursor && clock.canCallAgain()) {
            const more = await runChain(sources, { ...request, cursor: chain.nextCursor }, chain.sourceIndex, deps, clock, `${keyPrefix}_d4`);
            absorb(more);
            if (more.ok) {
              const fresh = videosInWindowFirst(refsOfPage(cap.platform, more.rows, videoCount).filter((ref) => !judgedIdentities.has(refIdentity(ref))), params);
              if (fresh.length > 0) {
                const extra = await deps.videoSelector(fresh).catch(() => null);
                if (extra) {
                  selection = {
                    adopted: [...selection.adopted, ...extra.adopted],
                    deferred: [...(selection.deferred || []), ...(extra.deferred || [])],
                  };
                }
              }
            }
          }
        }
        if (selection) {
          adoptedCount = selection.adopted.length;
          refs = [...selection.adopted, ...(selection.deferred || [])];
          if (refs.length === 0) return withHint({ ...success([], null, totals), emptyReason: "no_relevant_videos" });
        }
      }
      if (topicSearch) {
        pv = perVideoStated
          ? Math.min(MAX_COMMENTS_PER_VIDEO, askedPerVideo)
          : Math.min(MAX_COMMENTS_PER_VIDEO, Math.max(MIN_READ_PER_VIDEO, Math.ceil((target * 2) / Math.max(1, refs.length))));
      }
      state = { ph: "c", refs, i: 0, cc: null, n: 0, si: null, ...(pv ? { pv } : {}), ...(adoptedCount ? { ad: adoptedCount } : {}), ...(spill.length ? { sp: spill } : {}) };
      continue;
    }

    const refs: SocialRef[] = state.refs || [];
    const index: number = state.i ?? 0;
    if (index >= refs.length) {
      // The adopted posts of this page are read: a paged search asks for the next page while posts are still wanted.
      if (pagedTopic && state.dc && (state.pp ?? 0) < postAllowance) {
        state = { ph: "d", dc: state.dc, ds: state.ds, pg: state.pg, pp: state.pp, np: state.np, rp: state.rp, sk: state.sk, ...(state.pq?.length ? { pq: state.pq } : {}), ...(spill.length ? { sp: spill } : {}) };
        continue;
      }
      return withHint(success(flushSpill(), null, totals));
    }
    const ref: SocialRef = refs[index];
    const readPerVideo: number = topicSearch && state.pv ? state.pv : perVideo;
    // A topic search reads the video's whole share in one call (the price is per call, not per comment) and skips what an earlier chunk
    // already took; the other modes read what is still needed.
    const startAt: number = topicSearch ? state.po ?? 0 : 0;
    const need = topicSearch ? Math.max(1, readPerVideo) : Math.max(1, Math.min(perVideo - (state.n ?? 0), wanted - countedRows()));
    const chain = await runChain(commentSources, { ref, limit: need, cursor: state.cc ?? null }, state.cc ? state.si ?? null : null, deps, clock, `${keyPrefix}_v${index}`, mode === "url");
    absorb(chain);

    if (!chain.ok) {
      lastError = chain;
      if (mode === "url") {
        return rows.length > 0 ? withHint(success(rows, null, totals)) : failure({ ...totals, httpStatus: chain.httpStatus, errorCode: chain.errorCode, errorMessageAr: chain.errorMessageAr });
      }
      // One video that cannot be read is skipped; the others are still collected.
      state = { ...state, i: index + 1, cc: null, n: 0, po: 0, si: null };
      continue;
    }

    commentsAnswered = true;
    // A topic search walks the answer position by position (the offset is a position in the answer); the other modes drop repeats first.
    if (pagedTopic && startAt === 0) {
      postReads.read += 1;
      if (chain.rows.length < readPerVideo) postReads.sourceShort += 1;
      else if (chain.rows.filter(countsAsComment).length < readPerVideo) postReads.filteredShort += 1;
    }
    const listed = topicSearch ? chain.rows.slice(startAt) : chain.rows;
    const fresh = topicSearch ? listed : dedupe(listed, seen);
    const taking = topicSearch ? fresh : fresh.slice(0, Math.max(0, Math.min(need, wanted - countedRows())));
    const dated: Record<string, any>[] = markVideoDateBasis(taking, ref, params).map((row) => annotateComment(row, ref));
    const pageRows: Record<string, any>[] = [];
    let consumed = 0;
    let uniqueConsumed = 0;
    // A paged topic search takes at most `readPerVideo` usable comments from a post (the price is built on that many) and reads a post with ONE call.
    let postUsable: number = pagedTopic && startAt > 0 ? (state.pu ?? 0) : 0;
    let postQuotaReached = false;
    for (const row of dated) {
      // The post's own share is checked first: a chunk that ends exactly when the share is complete moves on to the next post (it never reads the same post again).
      if (pagedTopic && postUsable >= readPerVideo) { postQuotaReached = true; break; }
      // A topic search stops at the chunk's share: the rest of the list stays for the next chunk (read again from where this one stopped).
      if (topicSearch && countedRows() + credited(pageRows) >= wanted) break;
      consumed += 1;
      if (!topicSearch) { pageRows.push(row); continue; }
      const identity = rowKey(row);
      if (identity) {
        if (seen.has(identity)) continue;
        seen.add(identity);
      }
      uniqueConsumed += 1;
      if (!countsAsComment(row)) { pageRows.push(row); continue; }
      const repeat = repeatKey(row);
      if (seenRepeats.has(repeat)) continue;
      seenRepeats.add(repeat);
      const tagged = { ...row, comment_language: COMMENT_LANGUAGE_LABEL_AR[commentLanguageOf(commentTextOf(row))], ...(index < (state.ad ?? 0) ? { [VIDEO_ADOPTED_KEY]: true } : {}) };
      if (arabicFirst && commentLanguageOf(commentTextOf(row)) !== "ar") {
        if (spill.length < MAX_SPILL_ROWS) spill.push(compactRow(tagged));
        continue;
      }
      pageRows.push(tagged);
      postUsable += 1;
    }
    for (const row of pageRows) rows.push(row);
    const stoppedEarly = topicSearch && consumed < dated.length && !postQuotaReached;
    const taken: number = (state.n ?? 0) + (topicSearch ? uniqueConsumed : fresh.length);
    // A video whose comments are all outside the window is not read further: its other pages would be outside too.
    const pageOutsideWindow: boolean = windowed && pageRows.length > 0 && insideWindowCount(pageRows, params) === 0;
    const moreOnThisVideo: boolean = !pagedTopic && Boolean(chain.nextCursor) && taken < readPerVideo && dated.length > 0 && !pageOutsideWindow;
    state = stoppedEarly
      ? { ...state, cc: state.cc ?? null, n: taken, po: startAt + consumed, si: chain.sourceIndex, ...(pagedTopic ? { pu: postUsable } : {}) }
      : moreOnThisVideo
        ? { ...state, cc: chain.nextCursor, n: taken, po: 0, si: chain.sourceIndex }
        : { ...state, i: index + 1, cc: null, n: 0, po: 0, si: null, pu: 0 };
  }

  const moreToDiscover = pagedTopic && Boolean(state.dc) && (state.pp ?? 0) < postAllowance;
  const finished = state.ph === "c" && (state.i ?? 0) >= (state.refs?.length ?? 0) && state.refs !== undefined && !moreToDiscover;

  /** Non-Arabic comments set aside for an Arabic request come last, and only to fill what the Arabic ones could not. */
  function flushSpill(): Record<string, any>[] {
    if (!arabicFirst || spill.length === 0) return rows;
    const remaining = Math.max(1, input.remainingNeeded || wanted) - countedRows();
    if (remaining <= 0) return rows;
    const inside = windowed ? spill.filter((row) => insideWindowCount([row], params) === 1) : spill;
    return [...rows, ...inside.slice(0, remaining)];
  }

  // Nothing was readable anywhere and the job has delivered nothing before: that is a source failure (a refund with the
  // reason), not an empty result. Rows delivered by earlier chunks are never thrown away by a late failure.
  if (rows.length === 0 && finished && !commentsAnswered && lastError && (input.deliveredSoFar || 0) === 0) {
    return failure({ ...totals, httpStatus: lastError.httpStatus, errorCode: lastError.errorCode, errorMessageAr: lastError.errorMessageAr });
  }
  // The job stops by itself once it has what it asked for; a cursor would only be stored and never used.
  const reachedTarget = countedRows() >= Math.max(1, input.remainingNeeded || wanted);
  // The last chance to fill the volume: no more videos, or the job's page allowance ends with this chunk.
  const lastChunk = finished || (input.step + 1 >= maxPagesForJob(target, input.pageSize, "feed"));
  const delivered = lastChunk && !reachedTarget ? flushSpill() : rows;
  const keepState: SocialState = spill.length ? { ...state, sp: spill } : { ...state, sp: undefined };
  return withHint(success(delivered, finished || reachedTarget ? null : encodeState(keepState), totals));
}

/** How many of these rows stand inside the window (all of them when the job has none). */
function countInsideOf(rows: Record<string, any>[], params: Record<string, any>): number {
  return typeof params.dateFrom === "string" || typeof params.dateTo === "string" ? insideWindowCount(rows, params) : rows.length;
}

/** Rows that stand inside the customer's window by the one rule the worker's filter uses (own date, or the video's). */
function insideWindowCount(rows: Record<string, any>[], params: Record<string, any>): number {
  if (rows.length === 0) return 0;
  const from = typeof params.dateFrom === "string" ? params.dateFrom : undefined;
  const to = typeof params.dateTo === "string" ? params.dateTo : undefined;
  return classifyRowsByDate(rows, from, to).verdicts.filter((verdict) => verdict === "inside").length;
}

/** The videos of one discovery page, unique and capped, as references. */
function refsOfPage(platform: SocialCapabilityDef["platform"], pageRows: Record<string, any>[], limit: number): SocialRef[] {
  const refs: SocialRef[] = [];
  const seenRefs = new Set<string>();
  for (const row of pageRows) {
    const ref = extractSocialRef(platform, row);
    const key = ref?.id || ref?.url;
    if (!ref || !key || seenRefs.has(key)) continue;
    seenRefs.add(key);
    refs.push(ref);
    if (refs.length >= limit) break;
  }
  return refs;
}

type VideoWindowStanding = "inside" | "outside" | "unknown";

function videoStandings(refs: SocialRef[], params: Record<string, any>): VideoWindowStanding[] {
  const from = typeof params.dateFrom === "string" ? params.dateFrom : undefined;
  const to = typeof params.dateTo === "string" ? params.dateTo : undefined;
  const { verdicts } = classifyRowsByDate(refs, from, to, (ref) => (ref.publishedAtMs === undefined ? null : ref.publishedAtMs));
  return verdicts.map((verdict) => (verdict === "missing" ? "unknown" : verdict));
}

/** True when at least one video's date is known and every video whose date is known is outside the window. */
function videosAllOutsideWindow(refs: SocialRef[], params: Record<string, any>): boolean {
  const standings = videoStandings(refs, params);
  return standings.includes("outside") && !standings.includes("inside");
}

/**
 * The order the videos of a topic search are read in: inside the window first, then undated, then outside; inside each group the
 * videos whose own text shows the topic (and the requested country) come before those that need the review (stable otherwise).
 */
function videosInWindowFirst(refs: SocialRef[], params: Record<string, any>): SocialRef[] {
  const windowed = typeof params.dateFrom === "string" || typeof params.dateTo === "string";
  const query = typeof params.query === "string" ? params.query : "";
  const region = typeof params.region === "string" ? params.region : "";
  if (!windowed && !query) return refs;
  const standings = windowed ? videoStandings(refs, params) : refs.map((): VideoWindowStanding => "inside");
  const rank = { inside: 0, unknown: 1, outside: 2 } as const;
  return refs
    .map((ref, index) => ({ ref, index, rank: rank[standings[index]], evidence: query && videoEvidence(ref.title || "", { query, region }) === "match" ? 0 : 1 }))
    .sort((a, b) => a.rank - b.rank || a.evidence - b.evidence || a.index - b.index)
    .map((entry) => entry.ref);
}
