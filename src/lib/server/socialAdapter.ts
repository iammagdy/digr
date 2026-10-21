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

export interface SocialAdapterDeps {
  call: SocialCall;
  now?: () => number;
}

/** The worker is cut off at 60 s; a chunk stops starting new calls well before that. */
export const SOCIAL_CHUNK_BUDGET_MS = 40_000;
const MAX_CALLS_PER_CHUNK = SOCIAL_MAX_CALLS_PER_CHUNK;
const MAX_VIDEOS = MAX_VIDEOS_PER_JOB;
const MAX_COMMENTS_PER_VIDEO = MAX_PER_VIDEO;
/** Rows a mission chunk may return: whole videos are finished inside a chunk where possible, so a source that cannot page is never truncated. */
const MISSION_ROWS_PER_CHUNK = 500;

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
  deps: Required<SocialAdapterDeps>,
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
  deps: Required<SocialAdapterDeps>,
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
    const chain = await runChain(commentSources, { ref, limit: need, cursor: state.cc ?? null }, state.cc ? state.si ?? null : null, deps, clock, `${keyPrefix}_v${index}`, false);
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
  const resolved: Required<SocialAdapterDeps> = { call: deps.call, now: deps.now || Date.now };
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

async function runCommentsChunk(
  cap: SocialCapabilityDef,
  mode: SocialMode,
  input: ProviderAdapterCallInput,
  params: Record<string, any>,
  wanted: number,
  deps: Required<SocialAdapterDeps>,
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
  const askedPerVideo = Number(params.perVideo) > 0 ? Math.floor(Number(params.perVideo)) : SOCIAL_COMMENTS_PER_VIDEO;
  const perVideo = mode === "url" ? Math.min(MAX_COMMENTS_PER_VIDEO, target) : Math.min(MAX_COMMENTS_PER_VIDEO, askedPerVideo, target);

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
  let lastError: Pick<ChainResult, "httpStatus" | "errorCode" | "errorMessageAr"> | null = null;
  let commentsAnswered = false;
  let windowHint: "recency_applied" | "recency_unsupported" | undefined;
  const windowed = typeof params.dateFrom === "string" || typeof params.dateTo === "string";
  // With a window, only the comments inside it count toward what was asked: the worker drops the others, so counting them
  // would end the job after one old video that was entirely outside the window.
  const countedRows = () => (windowed ? insideWindowCount(rows, params) : rows.length);
  const withHint = (out: ProviderAdapterCallOutput): ProviderAdapterCallOutput => (windowHint ? { ...out, discoveryWindow: windowHint } : out);

  while (countedRows() < wanted && clock.canCallAgain()) {
    if (state.ph === "d") {
      if (mode === "url") break;
      const askedVideos = Number(params.videoCount) > 0 ? Math.floor(Number(params.videoCount)) : 0;
      const videoCount = Math.min(MAX_VIDEOS, askedVideos || Math.ceil(target / perVideo) + 2);
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
      state = { ph: "c", refs, i: 0, cc: null, n: 0, si: null };
      continue;
    }

    const refs: SocialRef[] = state.refs || [];
    const index: number = state.i ?? 0;
    if (index >= refs.length) {
      return withHint(success(rows, null, totals));
    }
    const ref: SocialRef = refs[index];
    const need = Math.max(1, Math.min(perVideo - (state.n ?? 0), wanted - countedRows()));
    const chain = await runChain(commentSources, { ref, limit: need, cursor: state.cc ?? null }, state.cc ? state.si ?? null : null, deps, clock, `${keyPrefix}_v${index}`, mode === "url");
    absorb(chain);

    if (!chain.ok) {
      lastError = chain;
      if (mode === "url") {
        return rows.length > 0 ? withHint(success(rows, null, totals)) : failure({ ...totals, httpStatus: chain.httpStatus, errorCode: chain.errorCode, errorMessageAr: chain.errorMessageAr });
      }
      // One video that cannot be read is skipped; the others are still collected.
      state = { ...state, i: index + 1, cc: null, n: 0, si: null };
      continue;
    }

    commentsAnswered = true;
    const fresh = dedupe(chain.rows, seen).slice(0, Math.max(0, Math.min(need, wanted - countedRows())));
    const pageRows: Record<string, any>[] = markVideoDateBasis(fresh, ref, params).map((row) => annotateComment(row, ref));
    for (const row of pageRows) rows.push(row);
    const taken: number = (state.n ?? 0) + fresh.length;
    // A video whose comments are all outside the window is not read further: its other pages would be outside too.
    const pageOutsideWindow: boolean = windowed && pageRows.length > 0 && insideWindowCount(pageRows, params) === 0;
    const moreOnThisVideo: boolean = Boolean(chain.nextCursor) && taken < perVideo && fresh.length > 0 && !pageOutsideWindow;
    state = moreOnThisVideo
      ? { ...state, cc: chain.nextCursor, n: taken, si: chain.sourceIndex }
      : { ...state, i: index + 1, cc: null, n: 0, si: null };
  }

  const finished = state.ph === "c" && (state.i ?? 0) >= (state.refs?.length ?? 0) && state.refs !== undefined;
  // Nothing was readable anywhere and the job has delivered nothing before: that is a source failure (a refund with the
  // reason), not an empty result. Rows delivered by earlier chunks are never thrown away by a late failure.
  if (rows.length === 0 && finished && !commentsAnswered && lastError && (input.deliveredSoFar || 0) === 0) {
    return failure({ ...totals, httpStatus: lastError.httpStatus, errorCode: lastError.errorCode, errorMessageAr: lastError.errorMessageAr });
  }
  // The job stops by itself once it has what it asked for; a cursor would only be stored and never used.
  const reachedTarget = countedRows() >= Math.max(1, input.remainingNeeded || wanted);
  return withHint(success(rows, finished || reachedTarget ? null : encodeState(state), totals));
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

/** Videos inside the window are read first, then the ones with no known date, then the ones outside (stable inside each group). */
function videosInWindowFirst(refs: SocialRef[], params: Record<string, any>): SocialRef[] {
  if (typeof params.dateFrom !== "string" && typeof params.dateTo !== "string") return refs;
  const standings = videoStandings(refs, params);
  const rank = { inside: 0, unknown: 1, outside: 2 } as const;
  return refs.map((ref, index) => ({ ref, index, rank: rank[standings[index]] })).sort((a, b) => a.rank - b.rank || a.index - b.index).map((entry) => entry.ref);
}
