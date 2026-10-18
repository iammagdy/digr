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
const MIN_TIME_FOR_ANOTHER_CALL_MS = 9_000;
const MAX_CALLS_PER_CHUNK = SOCIAL_MAX_CALLS_PER_CHUNK;
const MAX_VIDEOS = 20;
const MAX_COMMENTS_PER_VIDEO = 500;

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
  remainingMs(): number {
    return SOCIAL_CHUNK_BUDGET_MS - (this.now() - this.startedAt);
  }
  canCallAgain(): boolean {
    return this.calls < MAX_CALLS_PER_CHUNK && this.remainingMs() >= MIN_TIME_FOR_ANOTHER_CALL_MS;
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
    const outcome = await deps.call(source, params, {
      idempotencyKey: `${keyPrefix}_c${n}_${source.endpointId}`.slice(0, 120),
      timeoutMs: Math.max(5_000, Math.min(25_000, clock.remainingMs() - 4_000)),
    });
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

function annotateComment(row: Record<string, any>, ref: SocialRef | undefined): Record<string, any> {
  if (!ref) return row;
  return {
    ...row,
    ...(ref.url ? { video_url: ref.url } : {}),
    ...(ref.title ? { video_title: ref.title } : {}),
  };
}

function discoveryRequest(mode: Exclude<SocialMode, "url">, params: Record<string, any>, limit: number, cursor: string | null): SocialSourceRequest {
  return {
    limit,
    cursor,
    ...(mode === "query" ? { query: String(params.query || "").trim() } : {}),
    ...(mode === "channel" ? { channel: String(params.channel || "").trim() } : {}),
    ...(mode === "trending" ? { region: String(params.region || "").trim() } : {}),
  };
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
    const sources = cap.discover[mode] || [];
    const chain = await runChain(sources, discoveryRequest(mode, params, wanted, state?.dc ?? null), state ? state.si ?? null : null, resolved, clock, keyPrefix);
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

  while (rows.length < wanted && clock.canCallAgain()) {
    if (state.ph === "d") {
      if (mode === "url") break;
      const askedVideos = Number(params.videoCount) > 0 ? Math.floor(Number(params.videoCount)) : 0;
      const videoCount = Math.min(MAX_VIDEOS, askedVideos || Math.ceil(target / perVideo) + 2);
      const sources = cap.discover[mode] || [];
      const chain = await runChain(sources, discoveryRequest(mode, params, videoCount, state.dc ?? null), null, deps, clock, `${keyPrefix}_d`);
      absorb(chain);
      if (!chain.ok) return failure({ ...totals, httpStatus: chain.httpStatus, errorCode: chain.errorCode, errorMessageAr: chain.errorMessageAr });
      const refs: SocialRef[] = [];
      const seenRefs = new Set<string>();
      for (const row of chain.rows) {
        const ref = extractSocialRef(cap.platform, row);
        const key = ref?.id || ref?.url;
        if (!ref || !key || seenRefs.has(key)) continue;
        seenRefs.add(key);
        refs.push(ref);
        if (refs.length >= videoCount) break;
      }
      if (chain.rows.length > 0 && refs.length === 0) {
        return failure(totals, "تعذر تحديد روابط الفيديوهات من نتائج البحث؛ لم يُحتسب أي خصم.");
      }
      if (refs.length === 0) return success([], null, totals);
      state = { ph: "c", refs, i: 0, cc: null, n: 0, si: null };
      continue;
    }

    const refs = state.refs || [];
    const index: number = state.i ?? 0;
    if (index >= refs.length) {
      return success(rows, null, totals);
    }
    const ref = refs[index];
    const need = Math.max(1, Math.min(perVideo - (state.n ?? 0), wanted - rows.length));
    const chain = await runChain(commentSources, { ref, limit: need, cursor: state.cc ?? null }, state.cc ? state.si ?? null : null, deps, clock, `${keyPrefix}_v${index}`, mode === "url");
    absorb(chain);

    if (!chain.ok) {
      lastError = chain;
      if (mode === "url") {
        return rows.length > 0 ? success(rows, null, totals) : failure({ ...totals, httpStatus: chain.httpStatus, errorCode: chain.errorCode, errorMessageAr: chain.errorMessageAr });
      }
      // One video that cannot be read is skipped; the others are still collected.
      state = { ...state, i: index + 1, cc: null, n: 0, si: null };
      continue;
    }

    commentsAnswered = true;
    const fresh = dedupe(chain.rows, seen).slice(0, Math.max(0, Math.min(need, wanted - rows.length)));
    for (const row of fresh) rows.push(annotateComment(row, ref));
    const taken: number = (state.n ?? 0) + fresh.length;
    const moreOnThisVideo: boolean = Boolean(chain.nextCursor) && taken < perVideo && fresh.length > 0;
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
  const reachedTarget = rows.length >= Math.max(1, input.remainingNeeded || wanted);
  return success(rows, finished || reachedTarget ? null : encodeState(state), totals);
}
