import type { CatalogEndpoint, TregCatalog } from "../treg/catalog";
import { rankedHelpers } from "./contactFinders";
import type { StatsMap } from "./sourceRanking";
import { AGENT_MAX_DELIVERED_ROWS, AGENT_REPLIES_PER_COMMENT_DEFAULT, AGENT_REPLIES_PER_COMMENT_MAX, AGENT_REPLIES_ROWS_PER_CALL_ASSUMED, AGENT_REPLIES_UNKNOWN_PER_COMMENT } from "./constants";
import { childCountOf } from "./childCount";
import { isPeopleStage } from "./people";
import { stagePriceInputs, type PricedPlan, type PricedStage } from "./plan";
import { priceMissionByCode } from "./price";

/**
 * THE REPLIES OF A COMMENTS DELIVERY (the replies PR; owner decision recorded in the HANDOFF: child items are delivered raw, researchers analyse FULL threads). Live G4 (msn_3da66037878465ffbfd5, TikTok): a video whose own counter shows 25 delivered ONE comment, because replies were
 * never fetched. A comments task now delivers the top-level comments AND their replies. This module is the pure part, by code and with no model:
 *   - which reply endpoint of the catalog serves a comments source (the cheapest ranked one whose every required input a comment row or its video gives);
 *   - how many replies each comment is read for (none for a comment whose own reply counter is 0, never above the approved number in all);
 *   - the mapping code of a reply page (the replies are not measured by the model, so their mapping is written here).
 * The customer's number counts the top-level comments only; the replies come in addition, priced by code (price.ts / plan.ts), and the card says so.
 */
type Row = Record<string, unknown>;

const COMMENT_ID_INPUT = /^(comment_?id|root_?comment_?id|rpid)$/i;
const VIDEO_ID_INPUT = /^(item_?id|aweme_?id|video_?id|media_?id|post_?id|photo_?id|bv_?id|note_?id|object_?id)$/i;
const URL_INPUT = /^(url|post_?url|video_?url|code_or_url)$/i;
const LIMIT_INPUT = /^(limit|count|page_size|pagesize|per_page|perpage|size|num|max_results|maxresults|max_items|maxitems|n)$/i;
/** An endpoint that lists the REPLIES to a comment (not a user's own replies, not live replays). */
const REPLY_ENDPOINT = /(comment[._-]?repl(y|ies)|repl(y|ies)[._-]?comment|sub[._-]?comments?|comment_replies|comment-reply)/i;
const NOT_REPLY_ENDPOINT = /(user|live|danmu|danmaku|keyword|translate|reaction)/i;

/** A reply source of the catalog and how to call it for one comment. */
export interface ReplySource {
  id: string;
  /** The price of one call (USD). */
  usd: number;
  /** The input that takes the comment's id. */
  commentParam: string;
  /** The input that takes the video's (post's) platform id, when the source needs it. */
  videoIdParam: string | null;
  /** The input that takes the video's link, when the source needs it. */
  urlParam: string | null;
  /** The input that sets the page size, when the source has one. */
  pageSizeParam: string | null;
  /** The paging input (the next page of replies of the same comment), or null. */
  cursorParam: string | null;
  /** True when the provider bills only a call that answered. */
  billsOnSuccess: boolean;
}

export interface ReplySourceOptions {
  isAllowed: (endpointId: string) => boolean;
  /** The comment's video (post) has a platform id that the reply source takes (the comments stage reads its parents by that id). */
  videoIdAvailable: boolean;
  /** The comment's video (post) has a link column. */
  urlAvailable: boolean;
  stats?: StatsMap;
  now?: number;
}

/** The inputs of an endpoint classified, or null when a REQUIRED input is none of: the comment's id, the video's id, the video's link, a page size. A source with no comment id input is not a reply source for one comment. */
function classify(e: CatalogEndpoint, o: Pick<ReplySourceOptions, "videoIdAvailable" | "urlAvailable">): Omit<ReplySource, "id" | "usd" | "billsOnSuccess"> | null {
  let commentParam: string | null = null;
  let videoIdParam: string | null = null;
  let urlParam: string | null = null;
  let pageSizeParam: string | null = null;
  for (const i of e.inputs) {
    if (COMMENT_ID_INPUT.test(i.name)) commentParam = i.name;
    else if (VIDEO_ID_INPUT.test(i.name)) { if (o.videoIdAvailable) videoIdParam = i.name; else if (i.required) return null; }
    else if (URL_INPUT.test(i.name)) { if (o.urlAvailable) urlParam = i.name; else if (i.required) return null; }
    else if (LIMIT_INPUT.test(i.name)) pageSizeParam = i.name;
    else if (i.required && !(e.pagination ?? []).includes(i.name)) return null;
    else if (i.required) return null; // a required PAGING input (a cursor it cannot start without) is a token only an earlier page carries
  }
  if (!commentParam) return null;
  const cursorParam = (e.pagination ?? []).find((p) => !LIMIT_INPUT.test(p)) ?? null;
  return { commentParam, videoIdParam, urlParam, pageSizeParam, cursorParam };
}

/** True for an endpoint that lists the replies to one comment. */
export const isReplyEndpoint = (e: Pick<CatalogEndpoint, "id" | "capability">): boolean => /comment\.replies$/i.test(e.capability ?? "") || (REPLY_ENDPOINT.test(e.id) && !NOT_REPLY_ENDPOINT.test(e.id));

/**
 * THE REPLY SOURCES FOR A COMMENTS SOURCE, cheapest first (the same ranking as every helper of the catalog: the price of one call over its measured success rate): endpoints of the same platform that list the replies to one comment, direct and synchronous, with a known price, that the account may
 * buy, and whose every required input a comment row (its id) and its video (the platform id, the link) can give. At most three (the chain length of every helper). Empty when the platform has none the plan can feed (Facebook and YouTube need a token that only the comment's own page carries).
 */
export function replySourcesFor(commentsEndpointId: string, catalog: TregCatalog, o: ReplySourceOptions): ReplySource[] {
  const platform = catalog.byId.get(commentsEndpointId)?.platform;
  if (!platform) return [];
  const usable = catalog.endpoints.filter((e) => e.platform === platform && isReplyEndpoint(e) && e.kind === "direct" && !e.async && o.isAllowed(e.id) && classify(e, o) !== null);
  const ranked = rankedHelpers(usable, catalog, o.stats ?? new Map(), o.now ?? Date.now());
  const out: ReplySource[] = [];
  for (const r of ranked) {
    const e = catalog.byId.get(r.id)!;
    const c = classify(e, o)!;
    out.push({ id: r.id, usd: r.usd, billsOnSuccess: r.bill === "success", ...c });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ how many replies each comment is read for

/**
 * THE SHARE OF EACH COMMENT, from the comments' own reply counters: a comment that says it has 0 replies gets 0 (no paid read), a comment with no counter is read up to the cap, the others get what they have up to the cap. When all of that is more than the approved number of replies
 * in all, every comment with replies gets an equal part first (the first comment never takes it all) and a small comment's unused part goes to the others, in order. The shares never add up to more than the approved number.
 */
export function replyShares(counts: ReadonlyArray<number | null>, planned: number, cap: number = AGENT_REPLIES_PER_COMMENT_MAX): number[] {
  const limit = Math.max(0, Math.floor(planned));
  const per = Math.max(1, Math.floor(cap));
  const need = counts.map((c) => (c === null ? per : Math.max(0, Math.min(per, Math.floor(c)))));
  const shares = need.map(() => 0);
  let remaining = limit;
  let active = need.map((n, i) => (n > 0 ? i : -1)).filter((i) => i >= 0);
  while (remaining > 0 && active.length > 0) {
    const part = Math.max(1, Math.floor(remaining / active.length));
    for (const i of active) {
      const give = Math.min(part, need[i] - shares[i], remaining);
      shares[i] += give;
      remaining -= give;
      if (remaining <= 0) break;
    }
    active = active.filter((i) => shares[i] < need[i]);
  }
  return shares;
}

// ------------------------------------------------------------------------------------------------ the mapping code of a reply page

/** The keys of the comments stage's columns that a reply row fills (the replies share the comments' columns, so the two sit in one table). A key absent from the comments stage is null. */
export interface ReplyColumnKeys { text: string | null; author: string | null; date: string | null; likes: string | null; replies: string | null; language: string | null }

const KEY = {
  text: /^(text|comment|comment_text|content|body|message)$/i,
  author: /^(author|author_name|username|user_name|nickname|commenter|writer|handle)$/i,
  date: /^(posted_at|created_at|date|time|datetime|comment_time|create_time|published_at)$/i,
  likes: /^(likes?|like_count|likes_count|digg_count|reactions?)$/i,
  replies: /^(replies|replies_count|reply_count|reply_comment_total|reply_total|num_replies)$/i,
  language: /^(lang|language|comment_language)$/i,
};

export function replyColumnKeysOf(columns: ReadonlyArray<{ key: string; title_ar?: string }>): ReplyColumnKeys {
  const find = (re: RegExp): string | null => columns.find((c) => re.test(c.key))?.key ?? null;
  return { text: find(KEY.text), author: find(KEY.author), date: find(KEY.date), likes: find(KEY.likes), replies: find(KEY.replies), language: find(KEY.language) };
}

/**
 * THE MAPPING CODE OF A REPLY PAGE: the body of a function over `inputs.page`, turning one saved page of replies into rows keyed like the comments stage's columns. Providers differ in where the list is (`data.comments`, `output.data.comments`, `comments`, `data.replies`...) and in the field names
 * (`cid` / `id`, nested `user.nickname` / flat `author`, `create_time` / `createdUtc` in seconds, `digg_count` / `likes`); every one of those is read here. A row with no id is not a row (it could not be de-duplicated); a reply with no text keeps an empty text (a sticker).
 */
export function buildReplyMapCode(keys: ReplyColumnKeys): string {
  return `const K = ${JSON.stringify(keys)};
const P = inputs.page;
const at = (o, path) => { let v = o; for (const k of path) { if (v === null || v === undefined || typeof v !== 'object') return undefined; v = v[k]; } return v; };
const lists = [at(P, ['data','comments']), at(P, ['output','data','comments']), at(P, ['comments']), at(P, ['data','replies']), at(P, ['output','data','replies']), at(P, ['replies']), at(P, ['data']), at(P, ['output','data']), at(P, ['items']), at(P, ['rows']), P];
const list = lists.find((x) => Array.isArray(x)) || [];
const pick = (o, names) => { for (const n of names) { const v = o[n]; if (v !== undefined && v !== null && v !== '') return v; } return null; };
const who = (o) => { const u = o.user !== undefined ? o.user : o.author; if (u && typeof u === 'object') return u.nickname || u.unique_id || u.name || u.username || u.display_name || null; return typeof u === 'string' && u !== '' ? u : pick(o, ['authorName','author_name','username','nickname']); };
const iso = (v) => { if (v === null || v === undefined || v === '') return null; if (typeof v === 'number' || /^\\d{9,13}$/.test(String(v))) { const n = Number(v); const d = new Date(n < 1e12 ? n * 1000 : n); return Number.isNaN(d.getTime()) ? null : d.toISOString(); } return String(v); };
const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
return list.filter((r) => r && typeof r === 'object').map((r) => {
  const id = pick(r, ['cid','id','comment_id','commentId','rpid']);
  if (id === null) return null;
  const out = { id: String(id) };
  if (K.text) { const t = pick(r, ['text','content','comment','message','comment_text']); out[K.text] = t === null ? '' : String(t); }
  if (K.author) out[K.author] = who(r);
  if (K.date) out[K.date] = iso(pick(r, ['create_time','createdUtc','created_at','createTime','timestamp','posted_at','time','date']));
  if (K.likes) out[K.likes] = num(pick(r, ['digg_count','likes','like_count','likeCount','likes_count']));
  if (K.replies) out[K.replies] = num(pick(r, ['reply_comment_total','reply_count','replies_count','replyCount','replies']));
  if (K.language) out[K.language] = pick(r, ['comment_language','language','lang']);
  return out;
}).filter((r) => r !== null);`;
}

/** The inputs of a call for the replies to one comment: the page size, when the source has the input. The comment's id, the video's id and link are bound per parent by the engine (EngineSpec.parent_binding). */
export const replyCallParams = (s: ReplySource): Record<string, unknown> => (s.pageSizeParam ? { [s.pageSizeParam]: AGENT_REPLIES_ROWS_PER_CALL_ASSUMED } : {});


// ------------------------------------------------------------------------------------------------ the replies stage of a plan

/** The key of a stage that reads the replies of the comments of `commentsKey`. */
export const repliesKeyOf = (commentsKey: string): string => `${commentsKey}_replies`;
/** True for the stage that reads the replies of a comments stage. */
export const isRepliesStage = (s: Pick<PricedStage, "replies_of">): boolean => typeof s.replies_of === "string";
/** The planner's own keys for a video's (post's) link column. */
const LINK_KEY = /^(link|url|video_url|post_url|video_link|post_link|permalink)$/i;

/** A delivered stage of COMMENTS under a parent (a comments source: its capability ends in «comments»), with a proven recipe, that has no stage under it yet. */
function isCommentsStage(plan: PricedPlan, s: PricedStage, catalog: TregCatalog): boolean {
  if (s.parent_key === null || !s.deliver || isPeopleStage(s) || !s.engine?.parent_binding || isRepliesStage(s)) return false;
  if (plan.stages.some((x) => x.parent_key === s.key)) return false;
  const e = catalog.byId.get(s.endpoint_id);
  return /comments?$/i.test(e?.capability ?? "") && !isReplyEndpoint(e!);
}

export interface RepliesDeps {
  catalog: TregCatalog;
  isAllowed: (endpointId: string) => boolean;
  stats?: StatsMap;
  now?: number;
  /** Every row of the page the comments stage was measured on, mapped by the stage's own proven mapping (null: not available; the stage's sample rows are used). */
  sampleRowsOf: (stage: PricedStage) => Promise<Row[] | null>;
}

/** What the sampled comments say about their replies: the mean replies a comment has (capped at `cap`, the number read for each comment) and the calls that takes; not counted when no sampled comment carries a counter. */
export function expectedFromCounts(counts: ReadonlyArray<number>, cap: number = AGENT_REPLIES_PER_COMMENT_DEFAULT): { perComment: number; callsPerComment: number; counted: boolean } {
  if (counts.length === 0) return { perComment: AGENT_REPLIES_UNKNOWN_PER_COMMENT, callsPerComment: Math.ceil(AGENT_REPLIES_UNKNOWN_PER_COMMENT / AGENT_REPLIES_ROWS_PER_CALL_ASSUMED), counted: false };
  const capped = counts.map((n) => Math.min(Math.max(0, n), cap));
  const perComment = capped.reduce((a, b) => a + b, 0) / counts.length;
  const callsPerComment = capped.reduce((a, n) => a + (n > 0 ? Math.ceil(n / AGENT_REPLIES_ROWS_PER_CALL_ASSUMED) : 0), 0) / counts.length;
  return { perComment, callsPerComment, counted: true };
}

/** The reply counters of the sampled comments (null counters are not counters). */
export const replyCountersOf = (sample: ReadonlyArray<Row>): number[] => sample.map(childCountOf).filter((n): n is number => n !== null);

export function expectedRepliesOf(sample: ReadonlyArray<Row>, cap: number = AGENT_REPLIES_PER_COMMENT_DEFAULT): { perComment: number; callsPerComment: number; counted: boolean } {
  return expectedFromCounts(replyCountersOf(sample), cap);
}

/**
 * THE REPLIES OF A COMMENTS STAGE FOR A GIVEN NUMBER PER COMMENT, by code: the replies planned (the expected replies per comment over the comments planned, at most `perComment` for each, at most what the job may deliver) and the cost of one planned row (the calls they take at the price of one call of
 * the source). Used when the plan is built and again when the customer edits the comments' number or the replies per comment, so the one rule prices both. A plan stored without the sampled counters keeps its own expected number per comment (capped at the new number).
 */
export function repliesEstimateFor(r: Pick<PricedStage, "replies_sample_counts" | "replies_per_comment_expected" | "replies_call_usd" | "measured_cost_per_row_usd" | "planned_rows" | "per_parent_rows">, commentsRows: number, perComment: number, deliveredElsewhere: number): { rows: number; perCommentExpected: number; costPerRowUsd: number } {
  const counts = r.replies_sample_counts && r.replies_sample_counts.length > 0 ? r.replies_sample_counts : [r.replies_per_comment_expected ?? 0];
  const now = expectedFromCounts(counts, perComment);
  const rows = Math.max(1, plannedRepliesFor(commentsRows, now.perComment, deliveredElsewhere, perComment));
  // the price of one call: stored by code when the stage was built; an older stored stage gives it back from its own cost over the calls it was planned with
  let callUsd = r.replies_call_usd;
  if (callUsd === undefined) {
    const before = expectedFromCounts(counts, Math.max(1, r.per_parent_rows ?? perComment));
    callUsd = (Math.max(0, r.measured_cost_per_row_usd) * Math.max(1, r.planned_rows)) / Math.max(1, commentsRows * before.callsPerComment);
  }
  return { rows, perCommentExpected: now.perComment, costPerRowUsd: (callUsd * Math.max(1, commentsRows * now.callsPerComment)) / rows };
}

/** The planned replies of a comments stage of `commentsRows` comments: the expected replies per comment over all of them, at least 1, never above the cap per comment, never above what the job may deliver in all. */
export function plannedRepliesFor(commentsRows: number, perComment: number, deliveredElsewhere: number, cap: number = AGENT_REPLIES_PER_COMMENT_MAX): number {
  const wanted = Math.ceil(Math.max(0, commentsRows) * Math.max(0, perComment));
  const room = Math.max(0, AGENT_MAX_DELIVERED_ROWS - Math.max(0, deliveredElsewhere));
  return Math.max(0, Math.min(Math.max(wanted, wanted > 0 ? 1 : 0), Math.max(0, commentsRows) * cap, room));
}

/**
 * THE REPLIES STAGE OF EVERY COMMENTS STAGE, BY CODE, with the plan priced again. The planner never plans replies (and never states their price): code finds the cheapest ranked reply source the comments' rows and their videos can feed, estimates the replies from the sampled comments' own reply counters
 * (`replies_count`), and adds a stage under the comments, delivered and counted like any stage, so the price, the hold, the settlement and the file all follow the same rule. The customer's number stays the number of TOP-LEVEL comments; the replies are in addition. When the plan cannot have the replies (no source,
 * no sampled comment has a reply, the volume limit), `replies_status` says why and the card says so. Returns the plan as given when it has no comments stage.
 */
export async function withRepliesStages(planIn: PricedPlan, deps: RepliesDeps): Promise<PricedPlan> {
  let plan: PricedPlan = planIn;
  for (const comments of planIn.stages.filter((s) => isCommentsStage(planIn, s, deps.catalog))) {
    const spec = comments.engine!;
    const videos = plan.stages.find((s) => s.key === comments.parent_key);
    const linkKey = videos?.columns.find((c) => LINK_KEY.test(c.key))?.key ?? null;
    const videoIdAvailable = VIDEO_ID_INPUT.test(spec.parent_binding!.param) && spec.parent_binding!.from === "id";
    const sources = replySourcesFor(comments.endpoint_id, deps.catalog, { isAllowed: deps.isAllowed, videoIdAvailable, urlAvailable: linkKey !== null, ...(deps.stats ? { stats: deps.stats } : {}), ...(deps.now !== undefined ? { now: deps.now } : {}) });
    const status = (replies_status: NonNullable<PricedPlan["replies_status"]>): PricedPlan => ({ ...plan, replies_status });
    if (sources.length === 0) { plan = status("no_source"); continue; }
    const source = sources[0];
    const sample = (await deps.sampleRowsOf(comments)) ?? comments.sample_rows;
    // THE DEFAULT NUMBER PER COMMENT (owner decision): ten, whatever the sample's counters say; the customer may raise it to the cap or lower it in the plan editor
    const perComment = AGENT_REPLIES_PER_COMMENT_DEFAULT;
    const counters = replyCountersOf(sample);
    const expected = expectedFromCounts(counters, perComment);
    // NEVER A BLIND PAID READ: without the comments' own reply counter nothing says which comment has replies, so every comment would be read for them. No counter in the sample: no replies stage (the card says so)
    if (!expected.counted) { plan = status("no_counter"); continue; }
    if (expected.perComment <= 0) { plan = status("none_found"); continue; }
    const delivered = plan.stages.filter((s) => s.deliver).reduce((n, s) => n + s.planned_rows, 0);
    let planned = plannedRepliesFor(comments.planned_rows, expected.perComment, delivered, perComment);
    if (planned < 1) { plan = status("no_room"); continue; }
    // the price of the stage: the calls the replies take (at the price of one call of the chosen source) over the replies planned; never below one call's price over the rows one call gives
    const stageOf = (rows: number): PricedStage => {
      const calls = Math.max(1, comments.planned_rows * expected.callsPerComment);
      return {
        key: repliesKeyOf(comments.key), title_ar: `ردود ${comments.title_ar}`, endpoint_id: source.id, expected_rows: rows, parent_key: comments.key, per_parent_rows: perComment, deliver: true,
        columns: comments.columns.map((c) => ({ ...c })), sample_rows: [], measured_by: [], planned_rows: rows, measured_cost_per_row_usd: (source.usd * calls) / rows, measured_from_calls: [],
        replies_of: comments.key, replies_per_comment_expected: expected.perComment, replies_sample_counts: counters.slice(0, 100).map((n) => Math.min(Math.max(0, Math.floor(n)), AGENT_REPLIES_PER_COMMENT_MAX)), replies_call_usd: source.usd,
        engine: {
          endpoint_id: source.id, params: replyCallParams(source), cursor_param: source.cursorParam, map_code: buildReplyMapCode(replyColumnKeysOf(comments.columns)), map_file_id: "page",
          parent_binding: { param: source.commentParam, from: "id", also: [...(source.videoIdParam ? [{ param: source.videoIdParam, from: "id", grand: true as const }] : []), ...(source.urlParam && linkKey ? [{ param: source.urlParam, from: linkKey, grand: true as const }] : [])] },
        },
      };
    };
    const priced = (rows: number): { stages: PricedStage[]; price: ReturnType<typeof priceMissionByCode> } => {
      const at = plan.stages.findIndex((s) => s.key === comments.key);
      const stages = [...plan.stages.slice(0, at + 1), stageOf(rows), ...plan.stages.slice(at + 1)];
      return { stages, price: priceMissionByCode(stagePriceInputs(stages, plan.contact_steps), { settings: plan.price.settings }) };
    };
    let built = priced(planned);
    // the hold must fit the job limit: fewer replies are planned before the replies are dropped (the comments the customer asked for are never reduced for them)
    while (built.price.overCap && planned > 1) { planned = Math.floor(planned / 2); built = priced(planned); }
    if (built.price.overCap) { plan = status("no_room"); continue; }
    const { replies_status: _unused, ...rest } = plan;
    void _unused;
    plan = { ...rest, stages: built.stages, price: built.price };
  }
  return plan;
}
