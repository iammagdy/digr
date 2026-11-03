import { AGENT_REPLIES_PER_COMMENT_MAX } from "../constants";
import { operatorStampUtc } from "../cairoTime";
import { toArabicDigits } from "../../arabicDigits";
import { priceMissionByCode } from "../price";
import { stagePriceInputs, type PricedPlan, type PricedStage } from "../plan";
import type { StageFilter } from "../filters";
import type { MissionPricingSettings } from "../../missionPricing";
import type { Ask } from "./ask";
import { rankPool, factsOf, type PoolRow } from "./pool";
import { approxInstantOfRelative } from "./occurrence";
import { cairoMomentAr } from "./cairoText";
import { NAMED_MARK_KEY, NAMED_MARK_TITLE_AR, NAMED_MISMATCH_MARK_AR } from "./namedShortfall";
import { childPromise, perParentPromise, promiseLineAr, type StagePromise } from "./promise";
import { OPEN_REPLIES_FLOOR } from "./openReplies";
import { TOPIC_RELATION_KEY, TOPIC_RELATION_TITLE_AR, topicRelationAr } from "./topicChoice";
import { cardMapCode, cardsFor, CATALOG_ONLY_CAP_USD, CATALOG_ONLY_PRICE_MARGIN, CHILD_COLUMNS, COUNTRY_AR, mapPage, type CardRole, type ToolCard } from "./toolCards";
import type { SocialPlatform } from "../redesignFlagTypes";

/**
 * F3, THE PLAN COMPILER (docs/FOUNDATION-PLAN.md section 3.1). One pass, by code: the stage SHAPE comes from the Ask (parents, then comments when asked, then replies when asked
 * and a reply card exists); each stage's TOOL is the card whose inputs carry the most of the Ask's conditions (then pageable, then a counter, then price; D7: a tool that can carry
 * a condition beats a cheaper one that cannot); its INPUTS are written by code from the card; its MAPPING is generated from the card; its NUMBER has one promise type (F5).
 * A stage no card can build is a «not included» line on the card (F6), never a model recipe. No model, no I/O: the pages the pool and the exposure check read are given
 * (agent/src/compiled.ts reads them through the gateway, within every cap of the gateway).
 */
export const COMPILED_PLATFORMS: ReadonlyArray<SocialPlatform> = ["tiktok", "x", "facebook", "instagram", "youtube"];
export type StageRole = "parents" | "comments" | "replies";

/** The stages the Ask asks for, in order (from the Ask alone: no model, no catalog). */
export function stageShapeOf(ask: Pick<Ask, "comments" | "replies" | "platform">): StageRole[] {
  const shape: StageRole[] = ["parents"];
  if (ask.comments !== "none") shape.push("comments");
  if (ask.replies !== "none") shape.push("replies");
  return shape;
}

/** The roles whose cards can read a platform's parents (Facebook: a keyword search with dates or a page listing; YouTube: the channel's own search), its comments and its replies. */
const PARENT_ROLES: Record<SocialPlatform, ReadonlyArray<CardRole>> = {
  tiktok: ["videos.search"], x: ["tweets.search"], facebook: ["posts.search", "posts.page"], instagram: ["posts.account"], youtube: ["videos.channel"],
};
const COMMENT_ROLE: Record<SocialPlatform, CardRole | null> = { tiktok: "video.comments", x: null, facebook: "post.comments", instagram: "post.comments", youtube: "video.comments" };
const REPLY_ROLE: Record<SocialPlatform, CardRole> = { tiktok: "comment.replies", x: "tweet.replies", facebook: "comment.replies", instagram: "comment.replies", youtube: "comment.replies" };
const ROLES_OF = (role: StageRole, p: SocialPlatform): ReadonlyArray<CardRole> => (role === "parents" ? PARENT_ROLES[p] : role === "comments" ? (COMMENT_ROLE[p] ? [COMMENT_ROLE[p]!] : []) : [REPLY_ROLE[p]]);
/** The key of the stage that holds a platform's parents. */
const PARENT_KEY: Record<SocialPlatform, string> = { tiktok: "videos", x: "tweets", facebook: "posts", instagram: "posts", youtube: "videos" };
const PARENT_TITLE: Record<SocialPlatform, string> = { tiktok: "الفيديوهات", x: "التغريدات", facebook: "المنشورات", instagram: "المنشورات", youtube: "الفيديوهات" };

/**
 * THE VALUE A NAMED SOURCE TAKES IN A CARD'S INPUT, or null when the customer's words cannot be written there: an Instagram handle (`alhadath`, `@alhadath`, an account link), a Facebook page link (a page link, or a Latin handle written as one).
 * An Arabic name is not a handle or a link: code cannot know it, so a card whose only way to carry the source is that input is not eligible (the plan says so honestly, never a guess).
 */
export function sourceInputOf(card: ToolCard, ask: Pick<Ask, "source">): string | null {
  const src = card.inputs.source;
  const text = (ask.source.text ?? "").trim();
  if (!src || ask.source.kind !== "named" || text === "") return null;
  const url = /^https?:\/\/(?:www\.|m\.)?(?:instagram|facebook)\.com\/([A-Za-z0-9._-]+)\/?/i.exec(text);
  const handle = url ? url[1] : /^@?([A-Za-z0-9._]{1,30})$/.exec(text)?.[1] ?? null;
  if (src.kind === "handle") return handle;
  if (src.kind === "page_url") return url ? `https://www.facebook.com/${url[1]}` : handle ? `https://www.facebook.com/${handle}` : null;
  return null;
}

/** A card the Ask can use at all: a keyword search needs a topic; a card that takes the source by an input (not a channel id, which the pool resolves) needs a source that can be written there. */
const eligible = (card: ToolCard, ask: Ask): boolean => {
  if (card.inputs.query?.required && !ask.topic.text) return false;
  if (card.inputs.source && card.inputs.source.kind !== "channel_id" && sourceInputOf(card, ask) === null) return false;
  return true;
};

/** What the Ask asks that a parent card can carry in an input, and which of them this card carries. */
export function carriedBy(card: ToolCard, ask: Ask): { asked: string[]; carried: string[] } {
  const asked: string[] = [];
  const carried: string[] = [];
  const add = (what: string, ok: boolean) => { asked.push(what); if (ok) carried.push(what); };
  if (ask.topic.text) add("topic", Boolean(card.inputs.query));
  if (ask.country) add("country", Boolean(card.inputs.country));
  if (ask.language) add("language", Boolean(card.inputs.query?.operators));
  if (ask.period) add("period", Boolean(card.inputs.query?.operators || card.inputs.period));
  if (ask.source.kind === "named") add("source", Boolean(card.inputs.source && card.inputs.source.kind !== "channel_id"));
  add("order", Boolean(card.inputs.order && card.inputs.order[ask.order] !== undefined));
  return { asked, carried };
}

/** The card of a stage role: most conditions carried, then pageable, then a counter, then the cheapest page. Null: no usable card (the stage is not included). */
export function chooseCard(ask: Ask, role: StageRole, options: { cards?: ReadonlyArray<ToolCard>; catalogOnly?: boolean; /** The replies cards that may follow (a comments card that gives each comment what such a card needs is chosen first). */ repliesCards?: ReadonlyArray<ToolCard> } = {}): ToolCard | null {
  if (!ask.platform) return null;
  const cards = ROLES_OF(role, ask.platform).flatMap((r) => cardsFor(ask.platform!, r, options)).filter((c) => role !== "parents" || eligible(c, ask));
  // a comments card that feeds the replies step: the replies card's parent input is the comment's id, or a token the comments card keeps on each row
  const feeds = (c: ToolCard): number => (role === "comments" && (options.repliesCards ?? []).some((rc) => rc.inputs.parent && (rc.inputs.parent.from === "id" || (c.mapping.kind === "replies" && (c.mapping.tokens ?? []).some((t) => t.key === rc.inputs.parent!.from)))) ? 1 : 0);
  const score = (c: ToolCard): number[] => [feeds(c), role === "parents" ? carriedBy(c, ask).carried.filter((x) => x === "topic" || x === "period").length : 0, role === "parents" ? carriedBy(c, ask).carried.length : 0, c.inputs.cursor ? 1 : 0, c.counter ? 1 : 0, -c.costUsdPerPage];
  return [...cards].sort((a, b) => { const x = score(a); const y = score(b); for (let i = 0; i < x.length; i += 1) if (x[i] !== y[i]) return y[i] - x[i]; return 0; })[0] ?? null;
}

/** The first-page inputs of a parent card, written by code from the Ask (the customer's own topic words; the Cairo period as UTC instants; the country; the owner's order; the page size). */
export function parentInputs(card: ToolCard, ask: Ask): Record<string, unknown> {
  const p: Record<string, unknown> = {};
  const q = card.inputs.query;
  if (q && ask.topic.text) {
    let query = q.quoted ? `"${ask.topic.text}"` : ask.topic.text;
    if (q.operators) {
      if (ask.language) query += ` lang:${ask.language}`;
      if (ask.period) query += ` since:${operatorStampUtc(ask.period.startMs)} until:${operatorStampUtc(ask.period.endExclusiveMs)}`;
      // TWEETS WITH THEIR REPLIES (live D5, msn_e7612c1fe8697ca03439): the parents of a replies stage are ORIGINAL tweets, so the stage asks the source for originals only (10 of the 20 tweets of that run were themselves replies to other people)
      if (ask.replies !== "none") query += " -filter:replies";
    }
    // a keyword search that has no input for the page: the named page's name joins the keyword (the pool is then CHOSEN among the rows by their author)
    if (q.withSource && ask.source.kind === "named" && ask.source.text) query += ` ${/(?:facebook|instagram)\.com\/([^/?#\s]+)/i.exec(ask.source.text)?.[1] ?? ask.source.text}`;
    p[q.field] = query;
  }
  // the period as two Cairo calendar days (Facebook's search takes the day, inclusive, not an instant)
  if (card.inputs.period && ask.period) { p[card.inputs.period.from] = ask.period.from; p[card.inputs.period.to] = ask.period.to; }
  // the named source written in the card's own input (an account's handle, a page's link)
  if (card.inputs.source && card.inputs.source.kind !== "channel_id") { const v = sourceInputOf(card, ask); if (v !== null) p[card.inputs.source.param] = v; }
  if (card.inputs.country && ask.country) p[card.inputs.country.field] = ask.country;
  const order = card.inputs.order?.[ask.order];
  if (card.inputs.order && order !== undefined) p[card.inputs.order.field] = order;
  if (card.inputs.pageSize) p[card.inputs.pageSize.field] = card.inputs.pageSize.value;
  return p;
}

export interface CompileInput {
  ask: Ask;
  /** The parent card's pages read at planning, in order (their call ids and bodies). A page of ANOTHER card of the same role (a second keyword search) carries its own `card`. */
  pool: { card: ToolCard; params: Record<string, unknown>; pages: ReadonlyArray<{ callId: string; page: unknown; card?: ToolCard }> };
  /** YouTube: the counters of the pool's videos from the counter card (id -> comments), when it answered: the promise is then the counters of the chosen videos; absent, it is open. */
  counters?: ReadonlyMap<string, number>;
  /** YouTube: the channels the pool was read from (their ids and titles), said on the card. */
  channels?: ReadonlyArray<{ id: string; title?: string }>;
  /** Decision 7.5, Facebook: the customer's answer to the named-page question; absent, a shortfall asks it. */
  namedChoice?: "only_found" | "fill";
  /** The exposure check (decision 7.3): the first comments page of a parent, read before the card (undefined: not read). */
  exposure: (parentId: string) => { callId: string | null; page: unknown | null; failed: boolean } | undefined;
  capabilityOf: (endpointId: string) => string | null;
  pricingSettings?: MissionPricingSettings;
  /** Owner decision 7.4: a `catalog_only` card may build a stage, for a TEST account only (the caller says so); never for another account. */
  catalogOnly?: boolean;
  /** The moment of planning: a source that says «7 years ago» is placed in time from it (YouTube), to rank by the newest and by the latest occurrence. */
  nowMs?: number;
}

export type CompileResult =
  | { ok: true; plan: PricedPlan; promises: Record<string, StagePromise>; chosen: string[]; spares: string[] }
  | { ok: false; reason: "no_platform_card" | "no_parent_card" | "no_rows" | "no_parent_with_children" }
  /** Decision 7.5: the named page has fewer deliverable posts in the pool than asked and the customer has not answered: the caller asks the question (nothing is priced). */
  | { ok: false; reason: "named_shortfall"; found: number; need: number };

const TITLE: Record<string, string> = {
  text: "النص", author: "صاحب الحساب", username: "اسم المستخدم", posted_at: "تاريخ ووقت النشر", link: "الرابط", country: "الدولة", language: "اللغة", likes: "الإعجابات",
  comments: "عدد التعليقات", shares: "المشاركات", views: "المشاهدات", saves: "الحفظ", followers: "المتابعون", is_reply: "رد على تغريدة", replies_count: "عدد الردود",
  author_id: "معرّف الصفحة", author_url: "رابط الصفحة", channel_id: "معرّف القناة", published: "وقت النشر", subscribers: "المشتركون",
};
const NOUN: Record<SocialPlatform, { one: string; two: string; many: string; where: string; talks: string }> = {
  tiktok: { one: "فيديو", two: "فيديوهان", many: "فيديو", where: "من تيك توك", talks: "يتحدث نصه" },
  x: { one: "تغريدة", two: "تغريدتان", many: "تغريدة", where: "من إكس", talks: "يتحدث نصها" },
  instagram: { one: "منشور", two: "منشوران", many: "منشور", where: "من إنستجرام", talks: "يتحدث نصه" },
  facebook: { one: "منشور", two: "منشوران", many: "منشور", where: "من فيسبوك", talks: "يتحدث نصه" },
  youtube: { one: "فيديو", two: "فيديوهان", many: "فيديو", where: "من يوتيوب", talks: "يتحدث نصه" },
};
const DEFAULT_COUNT = 10;
/** An OPEN comments stage (the platform gives no counter before reading: YouTube) reads each chosen item up to this many comments; it sizes the hold's maximum and is the per-item limit the card and the file state (never a promise of a count). */
export const OPEN_COMMENTS_PER_PARENT = 100;
/**
 * THE MAXIMUM OF AN OPEN REPLIES STAGE (F5: an estimate never becomes a promise; it may only size the hold's maximum). It is bounded by the comments ACTUALLY CHOSEN for the
 * stage (`comments`: the comments stage's own planned rows, never a whole-video counter) times the replies read for each comment (`perComment`), and sized inside that bound by
 * the mean replies counter of the comments the exposure check read, each counter cut at `perComment` (a comment is never read for more). Live msn_e32cd467: the 20,541 of the
 * videos' counters times 9.375 gave 192,572 replies for 200 comments asked.
 */
export function openRepliesMax(comments: number, replyCounters: ReadonlyArray<number | null>, perComment: number): number {
  const cap = Math.max(1, Math.floor(perComment));
  const n = Math.max(0, Math.floor(comments));
  const seen = replyCounters.filter((c): c is number => c !== null && Number.isFinite(c)).map((c) => Math.min(cap, Math.max(0, c)));
  const ratio = seen.length > 0 ? seen.reduce((s, c) => s + c, 0) / seen.length : 0;
  return Math.max(1, Math.min(n * cap, Math.ceil(n * Math.max(ratio, OPEN_REPLIES_FLOOR))));
}

/** A counter as a number, or null when the row does not carry one (null, undefined, an empty text, a non-number). Never 0 for an absent value: `Number(null)` is 0 (live round 11, Instagram: 27 comments with no counter were «counted» as 27 comments with no replies). */
export function counterValueOf(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && /^\s*\d+(\.\d+)?\s*$/.test(v)) return Number(v);
  return null;
}

export interface RepliesSizing {
  /** The replies the comments READ AT PLANNING say they have, by their own counters (a comment with 120 counts 120). */
  counted: number;
  /** How many comments those counters belong to. */
  countedComments: number;
  /** The replies of the comments not read yet: an estimate that sizes the hold only (never a promise). */
  open: number;
  /** counted + open: the replies stage's rows in the price. */
  total: number;
}

/**
 * THE REPLIES' SIZE FROM THE REAL COUNTERS (live finding C, msn_b9eb261694fa611013d4: the mean of 40 counters x all 200 comments, cut by a flat cap of 50). The comments read at planning are the first comments of the chosen
 * videos, so their counters are the REAL counters of chosen comments: each counts as it is (`countedAtCap` false: every reply of the comment is read; true: the customer asked for a number per comment, so a comment counts at most that
 * number). The comments not read yet are sized by the mean of the counters read, each cut at the per-comment cap, never above the cap each: the cap SIZES THE HOLD for them and never truncates a delivery (agent/src/engine/run.ts).
 */
export function repliesSizing(input: { comments: number; known: ReadonlyArray<number | null>; perComment: number; countedAtCap?: boolean }): RepliesSizing {
  const cap = Math.max(1, Math.floor(input.perComment));
  const n = Math.max(0, Math.floor(input.comments));
  const seen = input.known.filter((c): c is number => c !== null && Number.isFinite(c)).slice(0, n).map((c) => Math.max(0, Math.floor(c)));
  const counted = seen.reduce((s, c) => s + (input.countedAtCap === true ? Math.min(cap, c) : c), 0);
  const ratio = seen.length > 0 ? seen.reduce((s, c) => s + Math.min(cap, c), 0) / seen.length : 0;
  const unknown = Math.max(0, n - seen.length);
  const open = Math.min(unknown * cap, Math.ceil(unknown * Math.max(ratio, OPEN_REPLIES_FLOOR)));
  const total = Math.max(1, counted + open);
  return { counted, countedComments: seen.length, open: total - counted, total };
}

/** The customer's one sentence for a compiled plan (Arabic, Arabic-Indic digits, no provider, no price). */
export function summaryAr(ask: Ask, n: number, shape: ReadonlyArray<StageRole>, perParent: number | null = null): string {
  const w = NOUN[ask.platform!];
  const count = n === 1 ? w.one : n === 2 ? w.two : `${toArabicDigits(n)} ${w.many}`;
  const parts = [count, w.where];
  if (ask.topic.text) parts.push(`عن «${ask.topic.text}»`);
  if (ask.country) parts.push(`من ${COUNTRY_AR[ask.country] ?? ask.country}`);
  if (ask.language === "ar") parts.push("بالعربية");
  if (ask.period) parts.push(`بين ${toArabicDigits(ask.period.from)} و${toArabicDigits(ask.period.to)}`);
  // a number per parent is said as the customer said it («مع ١٠٠ تعليق من كل فيديو»), never as «all the comments»
  const comments = perParent !== null ? `${toArabicDigits(perParent)} تعليق من كل ${w.one}` : null;
  const children = shape.includes("comments") ? (shape.includes("replies") ? (comments ? `، مع ${comments} وردودها` : "، مع كل تعليقاتها وردودها") : comments ? `، مع ${comments}` : "، مع تعليقاتها") : shape.includes("replies") ? "، مع ردودها" : "";
  return `${parts.join(" ")}${children}.`;
}

const filtersOf = (ask: Ask): StageFilter[] => {
  const f: StageFilter[] = [];
  if (ask.language) f.push({ kind: "language", lang: ask.language, field: "language" } as StageFilter);
  if (ask.country) f.push({ kind: "place", field: "country", fields: ["country"], places: [ask.country], values: [COUNTRY_AR[ask.country] ?? ask.country] } as StageFilter);
  if (ask.period) f.push({ kind: "period", from: ask.period.from, to: ask.period.to, field: "posted_at" } as StageFilter);
  return f;
};

const atPath = (o: unknown, path: ReadonlyArray<string> | null): unknown => { if (!path) return undefined; let v: unknown = o; for (const k of path) { if (v === null || v === undefined || typeof v !== "object") return undefined; v = (v as Record<string, unknown>)[k]; } return v; };
const postsCountAr = (n: number): string => (n === 1 ? "منشورًا واحدًا" : n === 2 ? "منشورين" : n >= 3 && n <= 10 ? `${toArabicDigits(n)} منشورات` : `${toArabicDigits(n)} منشورًا`);
const pagesCountAr = (n: number): string => (n === 1 ? "صفحة واحدة" : n === 2 ? "صفحتين" : `${toArabicDigits(n)} صفحات`);

/** The channels take turns inside each level of the topic relation (the about-the-topic rows first, then the hashtag-only ones, then the rest); a row with no channel keeps its place. */
function interleaveByChannel(rows: PoolRow[], ask: Ask): PoolRow[] {
  const tiers = [2, 1, 0] as const;
  const out: PoolRow[] = [];
  for (const tier of tiers) {
    const level = rows.filter((r) => factsOf(r, ask, true).topicTier === tier);
    const groups = new Map<string, PoolRow[]>();
    for (const r of level) { const k = String(r.channel_id ?? ""); const g = groups.get(k); if (g) g.push(r); else groups.set(k, [r]); }
    const lists = [...groups.values()];
    for (let i = 0; out.length < rows.length && lists.some((l) => l[i]); i += 1) for (const l of lists) if (l[i]) out.push(l[i]);
  }
  return out.length === rows.length ? out : rows;
}

/**
 * THE POOL IN THE OWNER'S ORDER (shared by the compiler and by the exposure check, which reads the first comments page of the parents in exactly this order): every distinct row of the pages read, with the counters of the free counter card merged by id, a video dated by its relative words
 * placed in time, ranked by named source, country and language, own text about the topic, the latest occurrence (decision 7), the most commented or the newest; the official channels take turns inside each level (live round 10: both videos were the first channel's).
 */
/** The platforms whose sources take the period as a REQUEST and do not keep to it (live round 11, Facebook: a search sent `startDate` and `endDate` answered posts of January and of last October): their pool is checked row by row. TikTok and X keep what they do. */
export const PERIOD_CHECKED_PLATFORMS: ReadonlyArray<SocialPlatform> = ["facebook", "instagram", "youtube"];
/** True when the row is inside the Ask's period (Cairo days, inclusive: from the first moment of the first day to the end of the last). A row with no readable date is not proven inside. */
export function insidePeriod(row: Record<string, unknown>, ask: Pick<Ask, "period">): boolean {
  if (!ask.period) return true;
  const t = Date.parse(String(row.posted_at ?? ""));
  return Number.isFinite(t) && t >= ask.period.startMs && t < ask.period.endExclusiveMs;
}
const periodIsChecked = (ask: Pick<Ask, "period" | "platform">): boolean => ask.period !== null && ask.platform !== null && PERIOD_CHECKED_PLATFORMS.includes(ask.platform);

export function rankedPoolOf(input: { ask: Ask; poolCard: ToolCard; pages: ReadonlyArray<{ page: unknown; card?: ToolCard }>; counters?: ReadonlyMap<string, number>; channels?: ReadonlyArray<{ id: string; title?: string }>; nowMs?: number; /** Count every row read, inside the period or not (the card says how many were read and how many were left out). */ keepOutsidePeriod?: boolean }): PoolRow[] {
  const { ask, poolCard } = input;
  const card: ToolCard = poolCard.counter || !input.counters ? poolCard : { ...poolCard, counter: { key: "comments", counts: "comments" } };
  const mapped = input.pages.flatMap((p) => mapPage(p.card ?? poolCard, p.page)).map((r) => (input.counters && input.counters.has(String(r.id)) ? { ...r, comments: input.counters.get(String(r.id)) } : r))
    // a source that dates a video only by «7 years ago» (YouTube): placed in time from the moment of planning, for the order «newest» and for the latest occurrence of a recurring event
    .map((r) => { if ((r.posted_at === undefined || r.posted_at === null) && input.nowMs !== undefined) { const t = approxInstantOfRelative(r.published, input.nowMs); if (t !== null) return { ...r, posted_at: new Date(t).toISOString() }; } return r; });
  // WHEN THE ASK HAS A PERIOD every parent of the pool is inside it, whichever search read it (live round 11): the chosen parents, the spares and the exposure check all come from this one list
  const inPeriod = input.keepOutsidePeriod !== true && periodIsChecked(ask) ? mapped.filter((r) => insidePeriod(r, ask)) : mapped;
  const rankedAll = rankPool(inPeriod, ask, card, { occurrence: ask.occurrence });
  return ask.source.kind === "official" && (input.channels?.length ?? 0) > 1 ? interleaveByChannel(rankedAll, ask) : rankedAll;
}

/** Compiles the plan. Pure: the same Ask and the same pages give the same plan. */
export function compilePlan(input: CompileInput): CompileResult {
  const { ask } = input;
  if (!ask.platform || !(COMPILED_PLATFORMS as ReadonlyArray<string>).includes(ask.platform)) return { ok: false, reason: "no_platform_card" };
  const shape = stageShapeOf(ask);
  const poolCard = input.pool.card;
  // THE COUNTER OF THE POOL: the parent card's own, or (YouTube) the counter card's, merged onto the rows by id
  const counterKey: string | null = poolCard.counter?.key ?? (input.counters ? "comments" : null);
  const card: ToolCard = poolCard.counter || !input.counters ? poolCard : { ...poolCard, counter: { key: "comments", counts: "comments" } };
  const ranked0 = rankedPoolOf({ ask, poolCard, pages: input.pool.pages, ...(input.counters ? { counters: input.counters } : {}), ...(input.channels ? { channels: input.channels } : {}), ...(input.nowMs !== undefined ? { nowMs: input.nowMs } : {}) });
  if (ranked0.length === 0) return { ok: false, reason: "no_rows" };
  const need = Math.max(1, ask.count ?? DEFAULT_COUNT);
  const catalogOnly = input.catalogOnly === true;
  // WHAT THE SOURCES ANSWERED OUTSIDE THE PERIOD (live round 11): every row read, and how many the period rule left out (said on the card as a count)
  const readAll = periodIsChecked(ask) ? rankedPoolOf({ ask, poolCard, pages: input.pool.pages, keepOutsidePeriod: true, ...(input.counters ? { counters: input.counters } : {}), ...(input.channels ? { channels: input.channels } : {}), ...(input.nowMs !== undefined ? { nowMs: input.nowMs } : {}) }) : ranked0;
  const leftOutOfPeriod = readAll.length - ranked0.length;
  const repliesCards = shape.includes("replies") ? cardsFor(ask.platform, REPLY_ROLE[ask.platform], { catalogOnly }) : [];
  const commentsCard = shape.includes("comments") ? chooseCard(ask, "comments", { catalogOnly, repliesCards }) : null;
  const repliesCard = shape.includes("replies") ? chooseCard(ask, "replies", { catalogOnly }) : null;
  // a counter the row does not carry is UNKNOWN, never 0 (live round 11: `Number(null)` is 0, so a row with no counter was read as a row that has no children)
  const counter = (r: PoolRow): number | null => { if (!counterKey) return null; return counterValueOf(r[counterKey]); };
  // DECISION 7.5 (Facebook): «only the ones found» keeps the named page's posts only; the choice is the customer's, made before approval
  const bySource = Boolean(poolCard.inputs.source);
  const isNamed = (r: Record<string, unknown>): boolean => factsOf(r, ask, bySource).named;
  // A POST THE CUSTOMER ASKED FOR from a named page is the page's AND (when a topic is named) about the topic (live round 10: 4 posts of «the page» with 2 about the topic satisfied 3 asked, and no question was asked)
  const isNamedAbout = (r: Record<string, unknown>): boolean => isNamed(r) && (!ask.topic.text || factsOf(r, ask, bySource).topicTier === 2);
  const ranked = input.namedChoice === "only_found" && ask.source.kind === "named" ? ranked0.filter(isNamedAbout) : ranked0;
  if (ranked.length === 0) return { ok: false, reason: "no_rows" };

  // THE EXPOSURE CHECK (decision 7.3): a parent whose first comments page is empty while its counter says it has comments is replaced by the next one, before the card; a parent that says it has none is never chosen for a comments request
  const chosen: PoolRow[] = [];
  const exposurePages: Array<{ parent: string; callId: string | null; rows: Array<Record<string, unknown>> }> = [];
  let scanned = 0;
  for (const r of ranked) {
    if (chosen.length >= need) break;
    scanned += 1;
    if (!commentsCard) { chosen.push(r); continue; }
    if (counter(r) === 0) continue;
    const e = input.exposure(r.id);
    if (e === undefined) continue;
    if (e.failed) { chosen.push(r); exposurePages.push({ parent: r.id, callId: e.callId, rows: [] }); continue; }
    const rows = e.page === null ? [] : mapPage(commentsCard, e.page);
    if (rows.length === 0) continue;
    chosen.push(r);
    exposurePages.push({ parent: r.id, callId: e.callId, rows });
  }
  if (chosen.length === 0) return { ok: false, reason: commentsCard ? "no_parent_with_children" : "no_rows" };
  // DECISION 7.5: a named Facebook page whose deliverable posts in the pool are fewer than asked: the customer decides before approval (the question is asked by the caller; nothing is priced)
  const namedFacebook = ask.platform === "facebook" && ask.source.kind === "named" && poolCard.role === "posts.search";
  if (namedFacebook && input.namedChoice === undefined) {
    const found = chosen.filter(isNamedAbout).length;
    if (found < need) return { ok: false, reason: "named_shortfall", found, need };
  }
  const spares = ranked.slice(scanned).filter((r) => !commentsCard || counter(r) !== 0).slice(0, 2);

  const promises: Record<string, StagePromise> = {};
  const notes: string[] = [];
  const unserved: Array<{ what_ar: string; reason_ar: string }> = [];
  const capabilityOf = input.capabilityOf;
  const stages: PricedStage[] = [];
  const parentKey = PARENT_KEY[ask.platform];
  // THE 0.20 USD CAP (decision 7.4): the stages that use a catalog_only card share it; each gets the pages its share buys at twice the catalog's price (the stage's own page limit)
  const catalogOnlyStages = [commentsCard, repliesCard].filter((c): c is ToolCard => c !== null && c.status === "catalog_only").length;
  const sharedMaxPages = (c: ToolCard): number | null => (c.status === "catalog_only" && c.costUsdPerPage > 0 ? Math.max(1, Math.floor(CATALOG_ONLY_CAP_USD / Math.max(1, catalogOnlyStages) / (c.costUsdPerPage * CATALOG_ONLY_PRICE_MARGIN) + 1e-9)) : null);
  // THE TOPIC RELATION MARK (live round 7, always since round 11): every item of the stage carries how its own text relates to the topic the customer named, so the file says which is which (a mark, never a drop)
  const tierOf = (r: PoolRow) => factsOf(r, ask, bySource).topicTier;
  // LIVE ROUND 11: the column is on the parent sheet WHENEVER the Ask has a topic, on every platform (a file whose items are all about it said nothing, so «all about it» could not be told from «not checked»)
  const markTopic = Boolean(ask.topic.text);
  // THE NAMED-SOURCE MARK (decision 7.5, «fill from other pages»): a post that is not the named page's carries «المصدر المسمّى: غير مطابق», the page's own posts carry nothing (a mark, never a drop)
  const markNamed = namedFacebook;
  const shown = (r: PoolRow): PoolRow => ({ ...r, ...(markTopic ? { [TOPIC_RELATION_KEY]: topicRelationAr(tierOf(r)) } : {}), ...(markNamed ? { [NAMED_MARK_KEY]: isNamed(r) ? "" : NAMED_MISMATCH_MARK_AR } : {}) });
  const fieldKeys = [...Object.keys(card.mapping.kind === "fields" ? card.mapping.fields : {}), ...(card.mapping.kind === "fields" && card.mapping.linkTemplate ? ["link"] : []), ...(input.counters && !poolCard.counter ? ["comments"] : [])];
  const columns = [...fieldKeys.filter((k, i) => k !== "id" && fieldKeys.indexOf(k) === i).map((k) => ({ key: k, title_ar: TITLE[k] ?? k })), ...(markTopic ? [{ key: TOPIC_RELATION_KEY, title_ar: TOPIC_RELATION_TITLE_AR }] : []), ...(markNamed ? [{ key: NAMED_MARK_KEY, title_ar: NAMED_MARK_TITLE_AR }] : [])];
  const pageRows = Math.max(1, card.page.observedRowsPerPage);
  promises[parentKey] = { type: "exact", n: chosen.length };
  stages.push({
    key: parentKey, title_ar: PARENT_TITLE[ask.platform], endpoint_id: card.endpointId, ...(capabilityOf(card.endpointId) ? { capability: capabilityOf(card.endpointId)! } : {}),
    expected_rows: chosen.length, planned_rows: chosen.length, parent_key: null, deliver: true, columns, sample_rows: chosen.slice(0, 3).map(shown),
    measured_by: input.pool.pages.map((p) => p.callId), measured_from_calls: input.pool.pages.map((p) => p.callId), measured_cost_per_row_usd: card.costUsdPerPage / pageRows,
    yield_share: 1, review_share: 0, pinned_rows: chosen.map(shown), ...(spares.length > 0 && commentsCard ? { spare_rows: spares.map(shown) } : {}),
    ...(filtersOf(ask).length > 0 ? { filters: filtersOf(ask) } : {}),
    ...(ask.order === "most_commented" && commentsCard ? { chosen_most_engaged: true } : {}),
    engine: { endpoint_id: card.endpointId, params: input.pool.params, cursor_param: card.inputs.cursor, map_code: cardMapCode(card), map_file_id: "page", parent_binding: null, built_by: "code", ...(card.cannot && card.cannot.length > 0 ? { gaps: card.cannot.filter((c) => (c === "language" && ask.language) || (c === "period" && ask.period) || (c === "country" && ask.country)).map((c) => ({ cls: c === "period" ? "date" : c, reason: "no_field" })) } : {}) },
  } as PricedStage);
  if (chosen.length < need) notes.push(`وجدنا في ما قرأناه ${toArabicDigits(chosen.length)} فقط تناسب طلبك من ${toArabicDigits(need)}.`);
  // WHAT THE POOL HELD, from the pages' own numbers (Facebook's keyword search): how many posts were read in how many pages, whether the source had more, how many are from the named page and how many talk about the topic
  if (poolCard.role === "posts.search") {
    const searchPages = input.pool.pages.filter((p) => (p.card ?? poolCard).role === "posts.search");
    const last = searchPages[searchPages.length - 1];
    const more = last ? Boolean(atPath(last.page, (last.card ?? poolCard).page.cursor)) : false;
    const parts = [`قرأنا ${postsCountAr(readAll.length)} من نتائج البحث في ${pagesCountAr(searchPages.length)}${more ? "، وفي المصدر المزيد" : ""}.`];
    if (ask.source.kind === "named" && ask.source.text) parts.push(`منها من صفحة «${ask.source.text}»: ${toArabicDigits(readAll.filter(isNamed).length)}.`);
    if (ask.topic.text) {
      parts.push(`منها يتحدث نصه عن «${ask.topic.text}»: ${toArabicDigits(readAll.filter((r) => factsOf(r, ask, bySource).topicTier === 2).length)}.`);
      if (ask.source.kind === "named" && ask.source.text) parts.push(`منها من الصفحة ويتحدث نصه عن الموضوع: ${toArabicDigits(readAll.filter((r) => isNamed(r) && factsOf(r, ask, bySource).topicTier === 2).length)}.`);
    }
    notes.push(parts.join(" "));
  }
  // THE PERIOD IS KEPT ON THE ROWS (live round 11): no chosen parent and no spare is outside it; the card says how many read ones were left out
  if (ask.period && leftOutOfPeriod > 0) notes.push(`لم نختر أي ${ask.platform === "youtube" ? "فيديو" : "منشور"} خارج الفترة المطلوبة (من ${toArabicDigits(ask.period.from)} إلى ${toArabicDigits(ask.period.to)})؛ تركنا ${ask.platform === "youtube" ? `${toArabicDigits(leftOutOfPeriod)} فيديو` : postsCountAr(leftOutOfPeriod)} ${leftOutOfPeriod === 1 ? "قرأناه" : leftOutOfPeriod === 2 ? "قرأناهما" : "قرأناها"} خارجها.`);
  // YOUTUBE: the channels the videos were read from (the official channels are looked up by name and each is read inside: the card says how many, never that they are the official ones)
  if (ask.platform === "youtube" && input.channels && input.channels.length > 0) {
    // the channels' names as the customer reads them: the Arabic part of a title («Al Ahly SC - النادي الأهلي» is «النادي الأهلي»); a title with no Arabic part is not listed (Arabic only on the card)
    const arabicPart = (t: unknown): string | null => (typeof t === "string" ? t.split(/\s*[-–—|]\s*/).map((x) => x.trim()).find((x) => /[؀-ۿ]/.test(x) && !/[A-Za-z0-9_]/.test(x)) ?? null : null);
    const titles = input.channels.map((c) => arabicPart(c.title)).filter((t): t is string => t !== null);
    notes.push(`قرأنا فيديوهات القنوات الرسمية التي وجدناها بأسمائها في البحث. عدد القنوات التي قرأنا فيديوهاتها: ${toArabicDigits(input.channels.length)}${titles.length > 0 ? ` (${titles.join("، ")})` : ""}. لا نستطيع أن نتحقق آليًا من أن كل قناة منها هي القناة الرسمية، فراجعها قبل الاعتماد.`);
  }
  // AN ACCOUNT'S OR A PAGE'S LISTING (live round 10: the card must say what the choice was made from): the most commented of the last N posts, and the period those posts cover, in Cairo time
  if ((poolCard.role === "posts.account" || poolCard.role === "posts.page") && ask.order === "most_commented") {
    const times = ranked0.map((r) => Date.parse(String(r.posted_at ?? ""))).filter((t) => Number.isFinite(t));
    const n = ranked0.length;
    const countAr = n === 1 ? "منشور" : n === 2 ? "منشورين" : n >= 3 && n <= 10 ? `${toArabicDigits(n)} منشورات` : `${toArabicDigits(n)} منشورًا`;
    notes.push(`اخترنا الأكثر تعليقًا من آخر ${countAr}${times.length > 0 ? `، وهي المنشورات التي نُشرت من ${cairoMomentAr(Math.min(...times))} إلى ${cairoMomentAr(Math.max(...times))} بتوقيت القاهرة` : ""}.`);
  }
  const unmet = chosen.filter((r) => { const f = factsOf(r, ask, bySource); return !f.country || !f.language || !f.named; }).length;
  if (unmet > 0) notes.push(`لم نجد في ما قرأناه ما يكفي مما يطابق المصدر أو الدولة أو اللغة المطلوبة؛ ${toArabicDigits(unmet)} من العناصر المختارة لا تطابق ذلك، وعليها علامة في الملف.`);
  // THE TOPIC, SAID HONESTLY BEFORE APPROVAL (live D1): «عن X» means the item's own text talks about X. A video whose caption names X only in its hashtags is made WITH X (the tool), so it ranks below the videos whose caption body is about X;
  // when the pool read has none of the latter the card says so; when some chosen items are below it, it says how many. Ranking only: the items are chosen and delivered either way.
  if (ask.topic.text && ask.topic.relation !== "made_with") {
    const topic = `«${ask.topic.text}»`;
    if (!ranked.some((r) => tierOf(r) === 2)) {
      notes.push(`لم نجد في ما قرأناه ${NOUN[ask.platform!].one} ${NOUN[ask.platform!].talks} عن ${topic}؛ ${chosen.some((r) => tierOf(r) === 1) ? `ما اخترناه يذكر الموضوع في الوسوم فقط، وغالبًا يكون الموضوع فيها أداة صُنع بها المحتوى لا موضوعه` : "ما اخترناه لا يذكر الموضوع في نصه"}، فراجع الاختيار قبل الاعتماد أو عدّل طلبك.`);
    } else {
      const tags = chosen.filter((r) => tierOf(r) === 1).length;
      const none = chosen.filter((r) => tierOf(r) === 0).length;
      if (tags > 0) notes.push(`${toArabicDigits(tags)} من العناصر المختارة يذكر الموضوع في الوسوم فقط، أي أنه غالبًا صُنع بالموضوع ولا يتحدث عنه، ولم نجد في ما قرأناه ما يكفي مما يتحدث نصه عن ${topic}.`);
      if (none > 0) notes.push(`${toArabicDigits(none)} من العناصر المختارة لا يذكر ${topic} في نصه، ولم نجد في ما قرأناه ما يكفي مما يذكره.`);
    }
  }
  if (ask.language && card.cannot?.includes("language")) notes.push("اللغة: اخترنا من بين النتائج ما كتب باللغة المطلوبة، وفي الملف عمود للغة كل صف.");

  // THE CUSTOMER'S NUMBER PER PARENT («١٠٠ تعليق من كل فيديو», live msn_e32cd467): each chosen parent gives at most that number of top-level comments; the card's edit (a total) comes later and wins
  const perParent = commentsCard && ask.edits.comments === undefined ? ask.commentsPerParent : null;
  if (commentsCard) {
    const cap = ask.edits.comments ?? null;
    const counters = chosen.map((r) => counter(r));
    const exposureComments = exposurePages.reduce((s, e) => s + e.rows.length, 0);
    const p0 = perParent !== null ? perParentPromise(card.counter ? counters : [], perParent, chosen.length) : childPromise(card.counter ? counters : [], cap, Math.max(1, exposureComments));
    // AN OPEN COMMENTS STAGE (YouTube: no counter before reading) is sized per chosen item, not by the first pages the planning happened to see (live round 10: 40 rows, all of them the first video's, so the second video gave none): each item is read up to the allowance
    const openAllowance = p0.type === "open" && perParent === null && cap === null && ask.platform === "youtube" ? OPEN_COMMENTS_PER_PARENT : null;
    const p: StagePromise = openAllowance !== null ? { type: "open", n: openAllowance * chosen.length } : p0;
    promises.comments = p;
    // the rows the stage may read: the number per parent for every parent (a parent with fewer gives what it has), else the promise
    const planned = perParent !== null ? perParent * chosen.length : p.n;
    stages.push({
      key: "comments", title_ar: "التعليقات", endpoint_id: commentsCard.endpointId, ...(capabilityOf(commentsCard.endpointId) ? { capability: capabilityOf(commentsCard.endpointId)! } : {}),
      expected_rows: planned, planned_rows: planned, parent_key: parentKey, ...(openAllowance !== null ? { per_parent_rows: openAllowance, children_cap_per_parent: openAllowance } : perParent !== null ? { per_parent_rows: perParent } : cap !== null ? { per_parent_rows: Math.ceil(p.n / chosen.length) } : {}), deliver: true,
      // THE REPLY TOKENS stay on the stored comment row (the replies stage binds to them): live round 10, the comments stage dropped them and the replies stage made no call
      ...(shape.includes("replies") && repliesCard && commentsCard.mapping.kind === "replies" && (commentsCard.mapping.tokens ?? []).length > 0 ? { carry_keys: (commentsCard.mapping.tokens ?? []).map((t) => t.key) } : {}),
      ...(commentsCard.mapping.kind === "replies" && commentsCard.mapping.relativeDates === true ? { relative_dates: true } : {}),
      columns: CHILD_COLUMNS.map((c) => ({ ...c })), sample_rows: (exposurePages[0]?.rows ?? []).slice(0, 3), measured_by: exposurePages.map((e) => e.callId).filter((x): x is string => x !== null),
      measured_from_calls: exposurePages.map((e) => e.callId).filter((x): x is string => x !== null), measured_cost_per_row_usd: commentsCard.costUsdPerPage / Math.max(1, commentsCard.page.observedRowsPerPage),
      yield_share: 1, review_share: 0, parent_pins: chosen.map((r) => r.id), ...(ask.comments === "all" && perParent === null ? { all_children: true } : {}), ...(p.type === "open" ? { children_open: true } : {}),
      ...(sharedMaxPages(commentsCard) !== null ? { max_pages: sharedMaxPages(commentsCard)! } : {}),
      engine: { endpoint_id: commentsCard.endpointId, params: structuredClone(commentsCard.inputs.fixed ?? {}), cursor_param: commentsCard.inputs.cursor, map_code: cardMapCode(commentsCard), map_file_id: "page", parent_binding: { param: commentsCard.inputs.parent!.param, from: commentsCard.inputs.parent!.from }, built_by: "code" },
    } as PricedStage);
    notes.push(promiseLineAr(p, "comments", card.counter?.counts === "comments_and_replies", perParent, openAllowance));
  }

  if (shape.includes("replies")) {
    if (repliesCard && commentsCard) {
      const seen = exposurePages.flatMap((e) => e.rows);
      const perComment = ask.edits.replies === undefined && ask.repliesPerComment !== null ? Math.min(ask.repliesPerComment, AGENT_REPLIES_PER_COMMENT_MAX) : null;
      const commentsRows = stages.find((x) => x.key === "comments")!.planned_rows;
      // THE REAL COUNTERS of the comments read at planning count as they are; the cap of 50 sizes the hold for the comments not read yet (live finding C)
      const sizing = repliesSizing({ comments: commentsRows, known: seen.map((r) => counterValueOf(r.replies_count)), perComment: perComment ?? AGENT_REPLIES_PER_COMMENT_MAX, countedAtCap: perComment !== null });
      // REPLIES ASKED WITH NO NUMBER PER COMMENT: every reply the source shows is read for each chosen comment (the engine reads past the cap; the cap sizes the reserve only)
      const readAll = perComment === null && ask.edits.replies === undefined;
      const p: StagePromise = ask.edits.replies !== undefined ? { type: "open", n: Math.max(1, Math.floor(ask.edits.replies)) } : { type: "open", n: sizing.total, counted: sizing.counted, counted_comments: sizing.countedComments };
      promises.comments_replies = p;
      stages.push({
        key: "comments_replies", title_ar: "الردود", endpoint_id: repliesCard.endpointId, ...(capabilityOf(repliesCard.endpointId) ? { capability: capabilityOf(repliesCard.endpointId)! } : {}),
        expected_rows: p.n, planned_rows: p.n, parent_key: "comments", replies_of: "comments", per_parent_rows: perComment ?? AGENT_REPLIES_PER_COMMENT_MAX, deliver: true,
        columns: CHILD_COLUMNS.map((c) => ({ ...c })), sample_rows: [], measured_by: [], measured_from_calls: [], measured_cost_per_row_usd: repliesCard.costUsdPerPage / Math.max(1, repliesCard.page.observedRowsPerPage),
        yield_share: 1, review_share: 0, replies_open: true, ...(ask.replies === "all" ? { replies_read_all: true } : {}), ...(readAll ? { replies_uncapped: true } : {}), replies_call_usd: repliesCard.costUsdPerPage,
        ...(sharedMaxPages(repliesCard) !== null ? { max_pages: sharedMaxPages(repliesCard)! } : {}),
        ...(repliesCard.mapping.kind === "replies" && repliesCard.mapping.relativeDates === true ? { relative_dates: true } : {}),
        engine: { endpoint_id: repliesCard.endpointId, params: {}, cursor_param: repliesCard.inputs.cursor, map_code: cardMapCode(repliesCard), map_file_id: "page", parent_binding: { param: repliesCard.inputs.parent!.param, from: repliesCard.inputs.parent!.from, ...(repliesCard.inputs.parent!.also ? { also: repliesCard.inputs.parent!.also.map((a) => ({ ...a })) } : {}) }, built_by: "code" },
      } as PricedStage);
      notes.push(promiseLineAr(p, "replies", false, perComment));
    } else if (repliesCard && !commentsCard && repliesCard.role === "tweet.replies") {
      // THE REPLIES TO THE CHOSEN TWEETS (live D5; a catalog_only card for test accounts until live round 8, VERIFIED since then and offered to every account; the stage keeps its page cap: CATALOG_ONLY_CAP_USD of calls a mission, sized at twice the catalog price). The replies are a child stage on the tweets: each tweet is read by its own link, and a tweet that
      // says (its own counter) it has no reply is never read. The counters of the chosen tweets size the stage; the page limit is what 0.10 USD of the card's calls buys, so the cap holds however the source answers.
      const perPage = 40;
      const maxPages = Math.max(1, Math.floor(CATALOG_ONLY_CAP_USD / (repliesCard.costUsdPerPage * CATALOG_ONLY_PRICE_MARGIN) + 1e-9));
      const counters = chosen.map((r) => counter(r));
      const sizing = repliesSizing({ comments: chosen.length, known: counters, perComment: AGENT_REPLIES_PER_COMMENT_MAX, countedAtCap: false });
      if (counters.every((c) => c !== null) && sizing.counted <= 0) {
        unserved.push({ what_ar: "الردود", reason_ar: "لا يذكر عدّاد المنصة ردودًا على أي من التغريدات المختارة، فلن تُضاف هذه الخطوة." });
      } else {
        const n = Math.max(1, Math.min(ask.edits.replies !== undefined ? Math.floor(ask.edits.replies) : sizing.total, maxPages * perPage));
        const p: StagePromise = { type: "open", n, counted: Math.min(sizing.counted, n), counted_comments: sizing.countedComments };
        promises.replies = p;
        const readAll = ask.edits.replies === undefined;
        stages.push({
          key: "replies", title_ar: "الردود", endpoint_id: repliesCard.endpointId, ...(capabilityOf(repliesCard.endpointId) ? { capability: capabilityOf(repliesCard.endpointId)! } : {}),
          expected_rows: n, planned_rows: n, parent_key: parentKey, replies_of: parentKey, per_parent_rows: AGENT_REPLIES_PER_COMMENT_MAX, deliver: true,
          columns: CHILD_COLUMNS.map((c) => ({ ...c })), sample_rows: [], measured_by: [], measured_from_calls: [], measured_cost_per_row_usd: repliesCard.costUsdPerPage / Math.max(1, repliesCard.page.observedRowsPerPage),
          yield_share: 1, review_share: 0, replies_open: true, ...(ask.replies === "all" ? { replies_read_all: true } : {}), ...(readAll ? { replies_uncapped: true } : {}), replies_call_usd: repliesCard.costUsdPerPage, max_pages: maxPages,
          engine: { endpoint_id: repliesCard.endpointId, params: structuredClone(repliesCard.inputs.fixed ?? {}), cursor_param: repliesCard.inputs.cursor, map_code: cardMapCode(repliesCard), map_file_id: "page", parent_binding: { param: repliesCard.inputs.parent!.param, from: repliesCard.inputs.parent!.from }, built_by: "code" },
        } as PricedStage);
      }
    } else {
      // F6: no verified card reads the replies on this platform: the step is NOT included, said before approval (never a model recipe, never the old pipeline)
      unserved.push({ what_ar: "الردود", reason_ar: "لا توجد بعد أداة موثّقة لقراءة الردود على هذه المنصة، فلن تُضاف هذه الخطوة." });
    }
  }

  const price = priceMissionByCode(stagePriceInputs(stages), { settings: input.pricingSettings });
  const plan: PricedPlan = {
    summary_ar: summaryAr(ask, chosen.length, shape.filter((s) => s !== "replies" || stages.some((x) => x.replies_of !== undefined)), perParent),
    ...(notes.length > 0 ? { notes_ar: notes } : {}),
    ...(ask.count === null ? { assumptions_ar: [`لم تحدد عددًا، فاخترنا ${toArabicDigits(DEFAULT_COUNT)}؛ يمكنك تعديله قبل الموافقة.`] } : {}),
    stages,
    price,
    ...(unserved.length > 0 ? { unserved_steps: unserved } : {}),
    compiled: { by: "compiler", platform: ask.platform, promises: Object.fromEntries(Object.entries(promises).map(([k, v]) => [k, { ...v }])) },
  };
  return { ok: true, plan, promises, chosen: chosen.map((r) => r.id), spares: spares.map((r) => r.id) };
}
