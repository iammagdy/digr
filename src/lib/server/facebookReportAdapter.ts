/**
 * Runs one worker chunk of the Facebook topic report (`facebook-topic-report`, see lib/facebookReport). The job is chunked and resumable: the whole state lives in a
 * stored record (one per chunk), the chunk cursor only says which chunk comes next, and a restarted chunk re-reads the record of the chunk before it.
 *
 * Phases, in order:
 *  1. browse  : the vetted Pages of the registry, ROUND-ROBIN (a few pages of each Page in turn, never one Page to exhaustion). A Page is validated by its first call and skipped
 *               when it answers «not found» or returns no post. Posts are filtered by the EXACT date window, de-duplicated, and each Page is held to its share of the posts.
 *  2. search  : keyword search, ONLY to fill what the Pages could not, a few calls, a cost ceiling, a cap on its share of the posts, and every post must show it belongs to the country.
 *  3. classify: the kept posts are balanced across publishers (per-publisher cap), placed on health axes by rules, and the posts the rules cannot place go to ONE model call
 *               per 50 posts inside the job's model budget (20% of its revenue); a post beyond the budget is «general» and flagged. The model never decides money.
 *  4. comments: the comments of the delivered posts, highest engagement first, up to 3 pages for a high-engagement post and 1 otherwise, stopping at the comment target.
 *               Comments are NEVER judged: only empty, exact-duplicate and link-only comments are removed. The stall guard stops a source that returns nothing.
 *
 * The network call and the model call are injected, so every path is covered by tests with fake providers. Nothing here knows a price: the charge is
 * ceil(delivered comments x the capability's unit price), decided by the worker's settlement, and never above the reserve.
 */
import { postsForVolume, getSocialCapability, type SocialRef, type SocialSource } from "../socialSources";
import { FACEBOOK_TOPIC_POSTS } from "../facebookTopicSources";
import { recordUnitPricePoints, chargeForUnits } from "../recordPricing";
import { DEFAULT_PRICING_SETTINGS } from "../../functions/shared/quotes";
import { timeNeededForAnotherCallMs } from "./chunkSizing";
import { SOCIAL_CHUNK_BUDGET_MS, runChain, type CallClock, type ChainResult, type SocialCall } from "./socialAdapter";
import { detectCountryFromText } from "../planParameters";
import { isoCountryCodeFromName } from "../planParameters";
import type { ProviderAdapterCallInput, ProviderAdapterCallOutput } from "./tregAdapter";
import {
  AXIS_MODEL_BATCH_POSTS, AXIS_MODEL_BUDGET_SHARE, AXIS_MODEL_TEXT_CHARS, COMMENTS_PER_PAGE, COMMENT_PAGES_HIGH_ENGAGEMENT, COMMENT_PAGES_LOW_ENGAGEMENT, COMMENT_REPEAT_PAGES, COMMENT_STALL_POSTS,
  FACEBOOK_REPORT_SLUG, HIGH_ENGAGEMENT_MIN_COMMENTS, HIGH_ENGAGEMENT_TOP_SHARE, MAX_BROWSE_CALLS_PER_JOB, MAX_POST_PAGES_PER_PAGE, PER_PUBLISHER_MAX_SHARE, POST_PAGES_PER_PAGE_PER_ROUND,
  REPORT_MAX_COMMENTS, REPORT_MAX_POSTS, SEARCH_CALLS_PER_CHUNK, SEARCH_POSTS_PER_CALL, SEARCH_SUPPLEMENT_MAX_CALLS, SEARCH_SUPPLEMENT_MAX_COST_USD, SEARCH_SUPPLEMENT_MAX_SHARE,
} from "../facebookReport/constants";
import { FACEBOOK_PAGE_REGISTRY, selectPages, type FacebookPageEntry } from "../facebookReport/registry";
import { GENERAL_AXIS_ID, HEALTH_AXES, placeByRules } from "../facebookReport/axes";
import { balancedSelection, effectiveShare, publisherCap } from "../facebookReport/publishers";
import { emptyWindowStats, filterPostsByWindow, isOlderThanWindow } from "../facebookReport/window";
import { cleanComments } from "../facebookReport/comments";
import { readComment, readPost } from "../facebookReport/read";
import type { ReportComment, ReportPost, WindowStats } from "../facebookReport/types";

/** Calls one chunk may make (browse, search, comment pages all count): a chunk ends well inside the platform's limit by time first. */
export const REPORT_MAX_CALLS_PER_CHUNK = 14;
/** A chunk returns after delivering this many comments, so the customer sees rows while the rest runs. */
export const REPORT_ROWS_PER_CHUNK = 150;
/** Default comments per post when the plan carries none. */
export const REPORT_DEFAULT_PER_POST = 5;
/** What one model call of a full batch costs at most (measured 21 Oct 2026 on production for a 25-row review: 0.0083 USD; a batch of 50 short texts is priced at twice it, an assumption). */
export const AXIS_CALL_COST_ESTIMATE_USD = 0.0166;
/** A Page that failed to answer for a reason that may pass (a busy source) is tried this many times at validation before it is skipped. */
const VALIDATION_ATTEMPTS = 2;
/** Pages in a row that returned only posts already seen before a Page is left (the source repeating itself). */
const PAGE_REPEAT_LIMIT = 2;
const SEARCH_REPEAT_LIMIT = 2;

export type PageEnd = "not_found" | "empty" | "error" | "cap" | "older" | "exhausted" | "repeats" | "calls";

export interface PageState {
  id: string;
  nameAr: string;
  url: string;
  status: "pending" | "active" | "done" | "skipped";
  /** Why the Page is done or skipped. */
  end?: PageEnd;
  cursor: string | null;
  /** The source of the chain the cursor belongs to. */
  si: number | null;
  calls: number;
  attempts: number;
  repeats: number;
  kept: number;
}

export interface ReportRequest {
  topic: string;
  region: string;
  from: string;
  to: string;
  postsTarget: number;
  perPost: number;
  commentsTarget: number;
}

export interface ReportState {
  v: 1;
  ph: "browse" | "search" | "classify" | "comments" | "done";
  req: ReportRequest;
  /** Pages of the registry that matched the request but were not browsed (invalid or not public): counted and reported. */
  skippedRegistry: Array<{ id: string; nameAr: string; reason: "invalid" | "not_public" }>;
  pages: PageState[];
  turn: number;
  browseCalls: number;
  posts: ReportPost[];
  duplicates: number;
  stats: WindowStats;
  search: { calls: number; costMicro: number; cursor: string | null; si: number | null; kept: number; seen: number; repeats: number; rejectedCountry: number; done: boolean };
  /** After the balanced selection: how many kept posts the per-publisher cap and the target left out. */
  selection: { dropped: number; byPublisher: Record<string, number>; share: number; effective: number } | null;
  classify: { rulesDone: boolean; modelCalls: number; modelUsd: number; budgetUsd: number; ambiguous: string[]; next: number; budgetStopped: number; modelFailed: number };
  comments: {
    order: string[];
    i: number;
    cursor: string | null;
    si: number | null;
    pages: number;
    taken: number;
    seen: string[];
    repeats: number;
    delivered: number;
    stallPosts: number;
    empty: number;
    duplicates: number;
    linkOnly: number;
    notReturned: number;
    stopped: "target" | "stall" | "done" | null;
  };
  /** The most recent failure code of a source, for the owner's diagnosis (never customer text). */
  lastError?: string;
}

export interface ReportStateStore {
  load(step: number): Promise<ReportState | null>;
  save(step: number, state: ReportState): Promise<void>;
}

/** The model that places the posts the rules could not. One call per batch; it never sees a price. */
export interface AxisModelResult {
  ok: boolean;
  /** index in the batch -> axis id */
  axes: Record<number, string>;
  usage?: { inputTokens: number; outputTokens: number; costUsd: number; model: string; latencyMs: number };
  failure?: string;
}
export type AxisModelCall = (input: { posts: Array<{ i: number; text: string; publisher: string }>; axes: Array<{ id: string; nameAr: string }>; timeoutMs: number }) => Promise<AxisModelResult>;

export interface ReportAdapterDeps {
  call: SocialCall;
  store: ReportStateStore;
  axisModel?: AxisModelCall;
  now?: () => number;
  registry?: readonly FacebookPageEntry[];
}

export interface ReportModelUsage { inputTokens: number; outputTokens: number; costUsd: number; model: string; latencyMs: number; failure?: string }

/** Extra fields of the chunk answer the worker reads (see ProviderAdapterCallOutput): progress without rows, the model calls to log, and an end message when nothing was delivered. */
export interface ReportChunkExtras {
  reportProgress?: boolean;
  reportModelUsage?: ReportModelUsage[];
  reportMessageAr?: string;
}

const pageSources = (): SocialSource[] => getSocialCapability("social-facebook-posts")?.discover.channel ?? [];
const commentSources = (): SocialSource[] => getSocialCapability("social-facebook-comments")?.comments ?? [];

/* ---------------------------------------------------------------------------------------------- request and state */

/** The job's model budget in USD: the share of the job's revenue (its expected charge at 0.10 EGP a point and the dollar rate of the pricing settings), rounded down to a millionth. No minimum: a job too small to pay for a call makes none. */
export function reportModelBudgetUsd(commentsTarget: number, unitPricePoints: number, share: number = AXIS_MODEL_BUDGET_SHARE): number {
  const points = chargeForUnits(Math.max(1, Math.floor(commentsTarget)), unitPricePoints);
  if (!(points > 0)) return 0;
  const revenueUsd = (points * DEFAULT_PRICING_SETTINGS.creditValueEgp) / DEFAULT_PRICING_SETTINGS.usdToEgp;
  return Math.floor(revenueUsd * share * 1_000_000 + 1e-6) / 1_000_000;
}

export function requestFromInput(input: ProviderAdapterCallInput): ReportRequest {
  const p = input.params || {};
  const commentsTarget = Math.max(1, Math.min(REPORT_MAX_COMMENTS, Math.floor(Number(input.targetVolumeMax) || 1)));
  const perPost = Number(p.perVideo) > 0 ? Math.floor(Number(p.perVideo)) : REPORT_DEFAULT_PER_POST;
  const asked = Number(p.videoCount) > 0 ? Math.floor(Number(p.videoCount)) : Math.ceil(commentsTarget / perPost);
  const postsTarget = Math.max(1, Math.min(REPORT_MAX_POSTS, postsForVolume({ videoCount: asked, perVideo: perPost }, commentsTarget) || asked));
  return {
    topic: String(p.query || p.topic || "").trim(),
    region: String(p.region || "").trim().toUpperCase(),
    from: typeof p.dateFrom === "string" ? p.dateFrom : "",
    to: typeof p.dateTo === "string" ? p.dateTo : "",
    postsTarget,
    perPost,
    commentsTarget,
  };
}

export function initialState(req: ReportRequest, registry: readonly FacebookPageEntry[] = FACEBOOK_PAGE_REGISTRY, unitPricePoints = recordUnitPricePoints(FACEBOOK_REPORT_SLUG) ?? 0): ReportState {
  const selection = selectPages({ country: req.region, topic: req.topic }, registry);
  return {
    v: 1,
    ph: "browse",
    req,
    skippedRegistry: selection.skipped.map((entry) => ({ id: entry.id, nameAr: entry.nameAr, reason: entry.status === "not_public" ? "not_public" : "invalid" })),
    pages: selection.usable.map((entry) => ({ id: entry.id, nameAr: entry.nameAr, url: entry.url, status: "pending", cursor: null, si: null, calls: 0, attempts: 0, repeats: 0, kept: 0 })),
    turn: 0,
    browseCalls: 0,
    posts: [],
    duplicates: 0,
    stats: emptyWindowStats(req.from, req.to),
    search: { calls: 0, costMicro: 0, cursor: null, si: null, kept: 0, seen: 0, repeats: 0, rejectedCountry: 0, done: false },
    selection: null,
    classify: { rulesDone: false, modelCalls: 0, modelUsd: 0, budgetUsd: reportModelBudgetUsd(req.commentsTarget, unitPricePoints), ambiguous: [], next: 0, budgetStopped: 0, modelFailed: 0 },
    comments: { order: [], i: 0, cursor: null, si: null, pages: 0, taken: 0, seen: [], repeats: 0, delivered: 0, stallPosts: 0, empty: 0, duplicates: 0, linkOnly: 0, notReturned: 0, stopped: null },
  };
}

/** The share of the delivered posts one publisher may hold: the configured 20% when there are enough Pages for it to be possible, else an equal split (reported). */
export const sharesFor = (state: ReportState): { configured: number; effective: number } => ({
  configured: PER_PUBLISHER_MAX_SHARE,
  effective: effectiveShare(Math.max(1, state.pages.filter((page) => page.status !== "skipped").length), PER_PUBLISHER_MAX_SHARE),
});

/** The most posts one Page keeps during collection: the cap on the TARGET (a Page that fills it is done), so no Page can fill the target alone. */
export const pageQuota = (state: ReportState): number => publisherCap(state.req.postsTarget, sharesFor(state).effective);

/* ------------------------------------------------------------------------------------------------------- the clock */

class ReportClock implements CallClock {
  private calls = 0;
  private slowest = 0;
  private readonly startedAt: number;
  constructor(private readonly now: () => number) { this.startedAt = now(); }
  get callsMade(): number { return this.calls; }
  nextCall(): number { return ++this.calls; }
  noteCallMs(ms: number): void { if (Number.isFinite(ms) && ms > this.slowest) this.slowest = ms; }
  remainingMs(): number { return SOCIAL_CHUNK_BUDGET_MS - (this.now() - this.startedAt); }
  canCallAgain(): boolean { return this.calls < REPORT_MAX_CALLS_PER_CHUNK && this.remainingMs() >= timeNeededForAnotherCallMs(this.slowest); }
}

/* ----------------------------------------------------------------------------------------------------------- browse */

const isNotFound = (chain: ChainResult): boolean => chain.httpStatus === 404 || /404|not_found|notfound/i.test(String(chain.errorCode ?? ""));
const isRetryable = (chain: ChainResult): boolean => chain.httpStatus === 429 || (chain.httpStatus >= 500 && chain.httpStatus <= 599) || /timeout|network|rate/i.test(String(chain.errorCode ?? ""));

function allOlderThanWindow(posts: ReportPost[], from: string): boolean {
  const dated = posts.filter((post) => post.publishedAtMs !== null);
  return dated.length > 0 && dated.every((post) => isOlderThanWindow(post, from));
}

/** The next Page to read: the pending or active Page after the one read last, in registry order (round-robin). */
export function nextPageIndex(state: ReportState): number {
  const n = state.pages.length;
  for (let k = 0; k < n; k++) {
    const idx = (state.turn + k) % n;
    if (state.pages[idx].status === "pending" || state.pages[idx].status === "active") return idx;
  }
  return -1;
}

/**
 * A Page that stopped at its share while other Pages were still unchecked may have stopped too soon: once a Page is skipped, the equal split among the Pages that remain is larger, so
 * a Page that stopped at the old (smaller) share and still has posts to read is read on. Nothing changes while every Page is still usable (the share is the configured 20%).
 */
export function reopenCappedPages(state: ReportState): void {
  const quota = pageQuota(state);
  for (const page of state.pages) {
    if (page.status === "done" && page.end === "cap" && page.kept < quota && page.cursor) { page.status = "active"; page.end = undefined; }
  }
}

/** Whether browsing is finished: the target is reached AND every usable Page had its share, or no Page is left to read, or the browse call ceiling is reached. */
export function browseFinished(state: ReportState): boolean {
  const live = state.pages.filter((page) => page.status === "pending" || page.status === "active");
  if (live.length === 0) return true;
  if (state.browseCalls >= MAX_BROWSE_CALLS_PER_JOB) return true;
  if (state.posts.length < state.req.postsTarget) return false;
  // the target is reached: stop only when each usable Page has had its share (done, or at least its equal share of the target)
  const usable = state.pages.filter((page) => page.status !== "skipped");
  const fair = Math.min(pageQuota(state), Math.ceil(state.req.postsTarget / Math.max(1, usable.length)));
  return usable.every((page) => page.status === "done" || page.kept >= fair);
}

async function browseOnce(state: ReportState, page: PageState, deps: ReportAdapterDeps, clock: ReportClock, chunkKey: string): Promise<{ cost: number }> {
  const sources = pageSources();
  const first = page.calls === 0;
  state.browseCalls += 1;
  // validation uses the first, cheap source only; later reads stay on the source the cursor belongs to
  const chain = await runChain(first ? sources.slice(0, 1) : sources, { channel: page.url, limit: 10, cursor: page.cursor }, first ? null : page.si, { call: deps.call, now: deps.now ?? Date.now }, clock, `${chunkKey}_b${state.browseCalls}`, false);
  page.calls += 1;
  const cost = chain.costMicro;
  if (!chain.ok) {
    state.lastError = chain.errorCode || `http_${chain.httpStatus}`;
    if (first && isNotFound(chain)) { page.status = "skipped"; page.end = "not_found"; return { cost }; }
    page.attempts += 1;
    if (first && isRetryable(chain) && page.attempts < VALIDATION_ATTEMPTS) { page.calls = 0; return { cost }; }
    if (first) { page.status = "skipped"; page.end = "error"; return { cost }; }
    page.status = "done";
    page.end = "error";
    return { cost };
  }
  const rawPosts = chain.rows.map((row) => readPost(row, { source: "page", pageId: page.id })).filter((post): post is ReportPost => post !== null);
  if (first) {
    page.si = chain.sourceIndex;
    if (rawPosts.length === 0) { page.status = "skipped"; page.end = "empty"; return { cost }; }
    page.status = "active";
  }
  page.cursor = chain.nextCursor;
  page.si = chain.sourceIndex;
  // de-duplicate against what is kept (a post can reach us twice: two Pages share it, or a source repeats a page)
  const known = new Set(state.posts.map((post) => post.key));
  const fresh: ReportPost[] = [];
  for (const post of rawPosts) {
    if (known.has(post.key)) { state.duplicates += 1; continue; }
    known.add(post.key);
    fresh.push(post);
  }
  if (rawPosts.length > 0 && fresh.length === 0) page.repeats += 1; else page.repeats = 0;
  // Every post of the answer inside the window is kept (a Page may pass its share by the few posts of its last call); the share is held by the Page's STOP rule below and, exactly,
  // by the balanced selection that follows (a post kept now may still be left out then, never the other way round).
  const inside = filterPostsByWindow(fresh, state.req.from, state.req.to, state.stats, page.id);
  state.posts.push(...inside);
  page.kept += inside.length;
  // stop rules of the Page
  if (page.kept >= pageQuota(state)) { page.status = "done"; page.end = "cap"; }
  else if (allOlderThanWindow(rawPosts, state.req.from)) { page.status = "done"; page.end = "older"; }
  else if (!chain.nextCursor) { page.status = "done"; page.end = "exhausted"; }
  else if (page.repeats >= PAGE_REPEAT_LIMIT) { page.status = "done"; page.end = "repeats"; }
  else if (page.calls >= MAX_POST_PAGES_PER_PAGE) { page.status = "done"; page.end = "calls"; }
  return { cost };
}

async function browsePhase(state: ReportState, deps: ReportAdapterDeps, clock: ReportClock, chunkKey: string, tally: { cost: number }): Promise<void> {
  reopenCappedPages(state);
  while (!browseFinished(state) && clock.canCallAgain()) {
    reopenCappedPages(state);
    const idx = nextPageIndex(state);
    if (idx < 0) break;
    const page = state.pages[idx];
    // a Page is read a few pages in a row, then the next Page has its turn
    for (let k = 0; k < POST_PAGES_PER_PAGE_PER_ROUND && (page.status === "pending" || page.status === "active") && clock.canCallAgain(); k++) {
      const { cost } = await browseOnce(state, page, deps, clock, chunkKey);
      tally.cost += cost;
      if (browseFinished(state)) break;
    }
    state.turn = idx + 1;
  }
  if (browseFinished(state)) state.ph = "search";
}

/* ----------------------------------------------------------------------------------------------------------- search */

/** A search post counts only when it shows it belongs to the requested country: its own words or its publisher's name name that country (never another one). */
export function postShowsCountry(post: ReportPost, region: string): boolean {
  const found = detectCountryFromText(`${post.publisher} ${post.text}`);
  if (!found) return false;
  return isoCountryCodeFromName(found.canonicalEnglish) === region;
}

export function searchBudget(state: ReportState): { maxPosts: number; wanted: number } {
  const maxPosts = Math.floor(state.req.postsTarget * SEARCH_SUPPLEMENT_MAX_SHARE + 1e-9);
  const wanted = Math.max(0, Math.min(maxPosts - state.search.kept, state.req.postsTarget - state.posts.length));
  return { maxPosts, wanted };
}

async function searchPhase(state: ReportState, deps: ReportAdapterDeps, clock: ReportClock, chunkKey: string, tally: { cost: number }): Promise<void> {
  const s = state.search;
  const registry = deps.registry ?? FACEBOOK_PAGE_REGISTRY;
  const selection = selectPages({ country: state.req.region, topic: state.req.topic }, registry);
  const ownPages = new Set([...selection.usable, ...selection.skipped].map((entry) => `page:${entry.id}`));
  const limitsReached = (): boolean => searchBudget(state).wanted <= 0 || s.calls >= SEARCH_SUPPLEMENT_MAX_CALLS || s.costMicro / 1e6 >= SEARCH_SUPPLEMENT_MAX_COST_USD || s.repeats >= SEARCH_REPEAT_LIMIT;
  // the search only fills what the Pages could not: a full target needs no search at all; a chunk makes at most SEARCH_CALLS_PER_CHUNK search calls (its cost stays bounded)
  let searchedThisChunk = 0;
  while (!s.done && state.req.topic && !limitsReached() && clock.canCallAgain() && searchedThisChunk < SEARCH_CALLS_PER_CHUNK) {
    searchedThisChunk += 1;
    const chain = await runChain(FACEBOOK_TOPIC_POSTS, { query: state.req.topic, region: state.req.region, limit: SEARCH_POSTS_PER_CALL, cursor: s.cursor, dateFrom: state.req.from, dateTo: state.req.to }, s.calls === 0 ? null : s.si, { call: deps.call, now: deps.now ?? Date.now }, clock, `${chunkKey}_q${s.calls + 1}`, false);
    s.calls += 1;
    s.costMicro += chain.costMicro;
    tally.cost += chain.costMicro;
    if (!chain.ok) { state.lastError = chain.errorCode || `http_${chain.httpStatus}`; s.done = true; break; }
    s.si = chain.sourceIndex;
    s.cursor = chain.nextCursor;
    const raw = chain.rows.map((row) => readPost(row, { source: "search" })).filter((post): post is ReportPost => post !== null);
    s.seen += raw.length;
    const known = new Set(state.posts.map((post) => post.key));
    const fresh = raw.filter((post) => { if (known.has(post.key)) { state.duplicates += 1; return false; } known.add(post.key); return true; });
    s.repeats = raw.length > 0 && fresh.length === 0 ? s.repeats + 1 : 0;
    const inside = filterPostsByWindow(fresh, state.req.from, state.req.to, state.stats);
    // a post of one of the registry's Pages of this country is Egyptian by the registry; any other must show its country in its own words
    const verified = inside.filter((post) => ownPages.has(post.publisherKey) || postShowsCountry(post, state.req.region));
    s.rejectedCountry += inside.length - verified.length;
    const taken = verified.slice(0, searchBudget(state).wanted);
    state.posts.push(...taken);
    s.kept += taken.length;
    if (!chain.nextCursor) s.done = true;
  }
  if (s.done || !state.req.topic || limitsReached()) { s.done = true; state.ph = "classify"; }
}

/* ------------------------------------------------------------------------------------------------------- classify */

const engagementOf = (post: ReportPost): number => post.reactions + post.comments + post.shares;

export function isHighEngagement(post: ReportPost, ranked: ReportPost[]): boolean {
  if (post.comments >= HIGH_ENGAGEMENT_MIN_COMMENTS) return true;
  const cut = Math.max(1, Math.ceil(ranked.length * HIGH_ENGAGEMENT_TOP_SHARE));
  return ranked.slice(0, cut).some((other) => other.key === post.key);
}

function selectAndPlace(state: ReportState): void {
  const share = sharesFor(state);
  const before = state.posts.length;
  const chosen = balancedSelection(state.posts, state.req.postsTarget, share.effective);
  const droppedByPublisher: Record<string, number> = {};
  const keptKeys = new Set(chosen.map((post) => post.key));
  for (const post of state.posts) if (!keptKeys.has(post.key)) droppedByPublisher[post.publisherKey] = (droppedByPublisher[post.publisherKey] ?? 0) + 1;
  state.selection = { dropped: before - chosen.length, byPublisher: droppedByPublisher, share: share.configured, effective: share.effective };
  state.posts = [...chosen].sort((a, b) => (b.publishedAtMs ?? 0) - (a.publishedAtMs ?? 0));
  const ambiguous: string[] = [];
  for (const post of state.posts) {
    const placed = placeByRules(post.text, HEALTH_AXES);
    post.axis = placed.axis;
    post.axisBy = "rules";
    if (placed.ambiguous) { post.axisBy = "ambiguous"; ambiguous.push(post.key); }
  }
  state.classify.ambiguous = ambiguous;
  state.classify.rulesDone = true;
}

async function classifyPhase(state: ReportState, deps: ReportAdapterDeps, clock: ReportClock, usages: ReportModelUsage[]): Promise<void> {
  if (!state.classify.rulesDone) selectAndPlace(state);
  const c = state.classify;
  const byKey = new Map(state.posts.map((post) => [post.key, post] as const));
  while (c.next < c.ambiguous.length) {
    const batchKeys = c.ambiguous.slice(c.next, c.next + AXIS_MODEL_BATCH_POSTS);
    const affordable = deps.axisModel && c.modelUsd + AXIS_CALL_COST_ESTIMATE_USD <= c.budgetUsd && clock.remainingMs() > timeNeededForAnotherCallMs(0) + 15_000;
    if (!affordable) {
      // beyond the budget (or no model): the posts are «general» and flagged (a time shortage only postpones the call to the next chunk)
      if (deps.axisModel && c.modelUsd + AXIS_CALL_COST_ESTIMATE_USD <= c.budgetUsd) return;
      for (const key of c.ambiguous.slice(c.next)) {
        const post = byKey.get(key);
        if (post) { post.axis = GENERAL_AXIS_ID; post.axisBy = "budget"; c.budgetStopped += 1; }
      }
      c.next = c.ambiguous.length;
      break;
    }
    const posts = batchKeys.map((key, i) => ({ i, text: (byKey.get(key)?.text ?? "").slice(0, AXIS_MODEL_TEXT_CHARS), publisher: byKey.get(key)?.publisher ?? "" }));
    const result = await deps.axisModel!({ posts, axes: HEALTH_AXES.map((axis) => ({ id: axis.id, nameAr: axis.nameAr })), timeoutMs: Math.max(5_000, Math.min(25_000, clock.remainingMs() - 4_000)) });
    c.modelCalls += 1;
    if (result.usage) { c.modelUsd += result.usage.costUsd; usages.push({ ...result.usage, ...(result.failure ? { failure: result.failure } : {}) }); }
    else { c.modelUsd += AXIS_CALL_COST_ESTIMATE_USD; if (result.failure) usages.push({ inputTokens: 0, outputTokens: 0, costUsd: 0, model: "", latencyMs: 0, failure: result.failure }); }
    batchKeys.forEach((key, i) => {
      const post = byKey.get(key);
      if (!post) return;
      const axis = result.ok ? result.axes[i] : undefined;
      if (axis && (axis === GENERAL_AXIS_ID || HEALTH_AXES.some((a) => a.id === axis))) { post.axis = axis; post.axisBy = "model"; }
      else { post.axis = post.axis || GENERAL_AXIS_ID; post.axisBy = "ambiguous"; c.modelFailed += 1; }
    });
    c.next += batchKeys.length;
  }
  if (c.next >= c.ambiguous.length) {
    // what the model left unplaced stays on the rules' best guess (or «general»), flagged as ambiguous
    const ranked = [...state.posts].sort((a, b) => engagementOf(b) - engagementOf(a) || (b.publishedAtMs ?? 0) - (a.publishedAtMs ?? 0));
    state.comments.order = ranked.map((post) => post.key);
    state.ph = "comments";
  }
}

/* ------------------------------------------------------------------------------------------------------- comments */

function pagesAllowedFor(post: ReportPost, ranked: ReportPost[], perPost: number): number {
  const needed = Math.max(1, Math.ceil(perPost / COMMENTS_PER_PAGE));
  return Math.min(needed, isHighEngagement(post, ranked) ? COMMENT_PAGES_HIGH_ENGAGEMENT : COMMENT_PAGES_LOW_ENGAGEMENT);
}

function finishPost(state: ReportState, post: ReportPost): void {
  const c = state.comments;
  post.commentsDelivered = (post.commentsDelivered ?? 0);
  const expected = Math.min(state.req.perPost, post.comments);
  c.notReturned += Math.max(0, expected - post.commentsDelivered);
  c.stallPosts = post.commentsDelivered === 0 ? c.stallPosts + 1 : 0;
  c.i += 1;
  c.cursor = null;
  c.si = null;
  c.pages = 0;
  c.taken = 0;
  c.seen = [];
  c.repeats = 0;
}

function commentRow(comment: ReportComment, post: ReportPost, n: number): Record<string, any> {
  return {
    comment_id: comment.commentId ?? `fbr_${post.key.slice(-24)}_${n}`,
    text: comment.text,
    author: comment.author,
    ...(comment.publishedAtMs !== null ? { published_at: new Date(comment.publishedAtMs).toISOString() } : {}),
    reactions: comment.reactions,
    replies: comment.replies,
    ...(comment.breakdown ? { reaction_breakdown: comment.breakdown } : {}),
    video_url: post.url,
    video_title: post.text.slice(0, 160),
    post_key: post.key,
  };
}

async function commentsPhase(state: ReportState, deps: ReportAdapterDeps, clock: ReportClock, chunkKey: string, rows: Record<string, any>[], tally: { cost: number }): Promise<void> {
  const c = state.comments;
  const byKey = new Map(state.posts.map((post) => [post.key, post] as const));
  const ranked = c.order.map((key) => byKey.get(key)).filter((post): post is ReportPost => Boolean(post));
  const sources = commentSources();
  while (c.i < c.order.length && rows.length < REPORT_ROWS_PER_CHUNK && clock.canCallAgain()) {
    if (c.delivered >= state.req.commentsTarget) { c.stopped = "target"; break; }
    if (c.stallPosts >= COMMENT_STALL_POSTS) { c.stopped = "stall"; break; }
    const post = byKey.get(c.order[c.i]);
    if (!post) { c.i += 1; continue; }
    const allowed = pagesAllowedFor(post, ranked, state.req.perPost);
    const ref: SocialRef = { url: post.url };
    const chain = await runChain(sources, { ref, limit: COMMENTS_PER_PAGE, cursor: c.cursor }, c.pages === 0 ? null : c.si, { call: deps.call, now: deps.now ?? Date.now }, clock, `${chunkKey}_c${c.i}_${c.pages}`, false);
    c.pages += 1;
    tally.cost += chain.costMicro;
    if (!chain.ok) { state.lastError = chain.errorCode || `http_${chain.httpStatus}`; finishPost(state, post); continue; }
    c.si = chain.sourceIndex;
    c.cursor = chain.nextCursor;
    const seen = new Set(c.seen);
    const cleaned = cleanComments(chain.rows.map((row) => readComment(row, post.key)), seen);
    c.seen = [...seen];
    c.empty += cleaned.empty;
    c.duplicates += cleaned.duplicates;
    c.linkOnly += cleaned.linkOnly;
    const room = Math.max(0, Math.min(state.req.perPost - c.taken, state.req.commentsTarget - c.delivered));
    const taken = cleaned.kept.slice(0, room);
    for (const comment of taken) rows.push(commentRow(comment, post, c.delivered + 1));
    c.taken += taken.length;
    c.delivered += taken.length;
    post.commentsDelivered = (post.commentsDelivered ?? 0) + taken.length;
    c.repeats = chain.rows.length > 0 && cleaned.kept.length === 0 && cleaned.duplicates > 0 ? c.repeats + 1 : 0;
    const postDone = !chain.nextCursor || c.pages >= allowed || c.taken >= state.req.perPost || c.repeats >= COMMENT_REPEAT_PAGES || chain.rows.length === 0 || c.delivered >= state.req.commentsTarget;
    if (postDone) finishPost(state, post);
  }
  if (c.delivered >= state.req.commentsTarget && !c.stopped) c.stopped = "target";
  if (c.i >= c.order.length && !c.stopped) c.stopped = "done";
  if (c.stopped) state.ph = "done";
}

/* --------------------------------------------------------------------------------------------------------- driver */

const encodeCursor = (step: number, ph: ReportState["ph"]): string => JSON.stringify({ r: 1, s: step + 1, ph });

function failure(message: string, code: string, status = 502): ProviderAdapterCallOutput {
  return { ok: false, httpStatus: status, rows: [], nextCursor: null, costUsd: 0, costMicro: 0, tregCallId: "", errorCode: code, errorMessageAr: message };
}

export async function runFacebookReportChunk(input: ProviderAdapterCallInput, deps: ReportAdapterDeps): Promise<ProviderAdapterCallOutput & ReportChunkExtras> {
  const now = deps.now ?? Date.now;
  const clock = new ReportClock(now);
  let state: ReportState | null = null;
  if (input.step === 0 || !input.cursor) {
    const req = requestFromInput(input);
    if (!req.topic || !req.region || !req.from || !req.to) return failure("تعذر فهم نطاق التقرير؛ لم يُنفَّذ أي استخراج.", "invalid_report_request", 422);
    state = initialState(req, deps.registry ?? FACEBOOK_PAGE_REGISTRY);
  } else {
    state = await deps.store.load(input.step - 1);
    if (!state) return failure("تعذر استكمال التقرير لفقد حالة الجمع؛ لم يُخصم أي رصيد.", "report_state_missing", 500);
  }
  const keyPrefix = `${input.jobId}_r${input.step}`;
  const tally = { cost: 0 };
  const rows: Record<string, any>[] = [];
  const usages: ReportModelUsage[] = [];
  const noPages = state.pages.length === 0;

  if (state.ph === "browse") {
    if (noPages) { state.ph = "search"; }
    else await browsePhase(state, deps, clock, keyPrefix, tally);
  }
  if (state.ph === "search") await searchPhase(state, deps, clock, keyPrefix, tally);
  if (state.ph === "classify") {
    if (state.posts.length === 0) { state.ph = "done"; state.comments.stopped = "done"; }
    else await classifyPhase(state, deps, clock, usages);
  }
  if (state.ph === "comments") await commentsPhase(state, deps, clock, keyPrefix, rows, tally);

  await deps.store.save(input.step, state);
  const finished = state.ph === "done";
  const out: ProviderAdapterCallOutput & ReportChunkExtras = {
    ok: true,
    httpStatus: 200,
    rows,
    nextCursor: finished ? null : encodeCursor(input.step, state.ph),
    costUsd: Number((tally.cost / 1_000_000).toFixed(6)),
    costMicro: tally.cost,
    tregCallId: "",
    providerCallCount: clock.callsMade,
    ...(rows.length === 0 && !finished ? { reportProgress: true } : {}),
    ...(usages.length > 0 ? { reportModelUsage: usages } : {}),
  };
  if (finished && state.comments.delivered === 0) out.emptyReason = state.posts.length === 0 ? "no_videos" : undefined;
  return out;
}

/** The final state of a finished job, for the worker's assembly: the record written by the last chunk. */
export const reportStatePath = (jobId: string, step: number): string => `${jobId}/fbreport_state_${step}.json`;
