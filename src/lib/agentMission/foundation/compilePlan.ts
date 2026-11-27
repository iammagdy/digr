import { AGENT_REPLIES_PER_COMMENT_MAX } from "../constants";
import { operatorStampUtc } from "../cairoTime";
import { toArabicDigits } from "../../arabicDigits";
import { countAr, itemNounOf } from "../itemNoun";
import { priceMissionByCode } from "../price";
import { stagePriceInputs, type PricedPlan, type PricedStage } from "../plan";
import type { StageFilter } from "../filters";
import type { MissionPricingSettings } from "../../missionPricing";
import type { Ask } from "./ask";
import { rankPool, factsOf, namedAuthorVerdict, topicTierOf, type PoolRow } from "./pool";
import { approxInstantOfRelative } from "./occurrence";
import { APPROX_DATES_KEY, approxColumnsOf } from "../relativeDates";
import { cairoMomentAr } from "./cairoText";
import { NAMED_MARK_KEY, NAMED_MARK_TITLE_AR, NAMED_MISMATCH_MARK_AR, NAMED_UNAVAILABLE_MARK_AR } from "./namedShortfall";
import type { RelevanceSpec } from "../relevance";
import { priorDeliverySampleAr } from "../priorDelivery";
import { childPromise, perParentPromise, promiseLineAr, type StagePromise } from "./promise";
import { OPEN_REPLIES_FLOOR } from "./openReplies";
import { ALTERNATIVE_LINE_AR, catalogOnlyPagesOf, commentsAlternativesOf, quoteCostPerRowOf } from "./alternatives";
import { youtubeChannelNoteAr } from "./youtubeChannel";
import { TOPIC_RELATION_KEY, TOPIC_RELATION_TITLE_AR, topicRelationAr } from "./topicChoice";
import { COLUMN_OF, sheetWantsOf, suppliedWants } from "./discovery/fieldRecovery";
import { catalogOrderOf } from "./toolCards/catalogOrder";
import { cardMapCode, cardsFor, CATALOG_ONLY_CAP_USD, CATALOG_ONLY_PRICE_MARGIN, CHILD_COLUMNS, COUNTRY_AR, mapPage, type CardRole, type ToolCard } from "./toolCards";
import type { SocialPlatform } from "../redesignFlagTypes";
import { rowIsBy, sourceCarryOf, sourceIdOf, sourceOperatorNoteAr, type SourceCarry } from "./sourceScope";
import { alternativesAr } from "./topicAlternatives";

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
export const PARENT_ROLES: Record<SocialPlatform, ReadonlyArray<CardRole>> = {
  // ROUND 33 (discovery): YouTube also reads parents by a keyword search (`videos.search`) and Instagram by a keyword or hashtag search (`posts.search`); only a card DERIVED from the catalog has those roles today (a verified card of them does not exist), so a mission without the discovery switch sees no change
  tiktok: ["videos.search"], x: ["tweets.search"], facebook: ["posts.search", "posts.page"], instagram: ["posts.account", "posts.search"], youtube: ["videos.channel", "videos.search"],
};
export const COMMENT_ROLE: Record<SocialPlatform, CardRole | null> = { tiktok: "video.comments", x: null, facebook: "post.comments", instagram: "post.comments", youtube: "video.comments" };
export const REPLY_ROLE: Record<SocialPlatform, CardRole> = { tiktok: "comment.replies", x: "tweet.replies", facebook: "comment.replies", instagram: "comment.replies", youtube: "comment.replies" };
export const ROLES_OF = (role: StageRole, p: SocialPlatform): ReadonlyArray<CardRole> => (role === "parents" ? PARENT_ROLES[p] : role === "comments" ? (COMMENT_ROLE[p] ? [COMMENT_ROLE[p]!] : []) : [REPLY_ROLE[p]]);
/** The key of the stage that holds a platform's parents. */
const PARENT_KEY: Record<SocialPlatform, string> = { tiktok: "videos", x: "tweets", facebook: "posts", instagram: "posts", youtube: "videos" };
/**
 * ROUND 27 (item 4): THE COLUMNS OF A PARENT SHEET, the same for the same platform and type. TikTok's video search has three verified tools (tikhub, anyapi, crawl4ai) that each give a different field set (the language only the first, the country the first two):
 * two orders of the same kind gave files of 19 and 18 columns. The columns are the union, in the order of the fullest tool; a field the chosen tool does not give is a column that says «غير متاح» on every row (and the summary says which).
 * Another platform's parent sheet follows its one verified tool (X, YouTube) or its own role (Facebook search or page, Instagram account): nothing changes for them.
 */
export const SAME_PARENT_COLUMNS: Partial<Record<SocialPlatform, ReadonlyArray<string>>> = {
  tiktok: ["id", "text", "author", "username", "posted_at", "link", "country", "language", "likes", "comments", "shares", "views", "saves"],
};
export function sameParentColumnsOf(platform: SocialPlatform, cardKeys: ReadonlyArray<string>): string[] {
  const canonical = SAME_PARENT_COLUMNS[platform];
  if (!canonical) return [...cardKeys];
  return [...canonical, ...cardKeys.filter((k) => !canonical.includes(k))];
}

/** ROUND 36: the parent sheet of a request for REELS whose media type is proven is «الريلز» (its noun is the one the summary, the methodology and the file's name count by); an unproven one keeps «المنشورات». */
export const REELS_TITLE_AR = "الريلز";
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

/**
 * P0 (14 Nov 2026), THE GENERAL SOURCE RULE (sourceScope.ts): how a card carries the Ask's source, or null. A named source is carried by the card's own source input, by an evidence lookup (a channel), or by the query's source operator
 * with the identifier; an official source only by a lookup. Read from the card's data, the same for every platform.
 */
export function carryOf(card: ToolCard, ask: Pick<Ask, "source">): SourceCarry | null {
  if (ask.source.kind === "named") return sourceCarryOf(card, ask.source.text, sourceInputOf(card, ask as Ask) !== null);
  if (ask.source.kind === "official") return card.inputs.source?.kind === "channel_id" ? "lookup" : null;
  return null;
}
/** The identifier a search carries by its operator (every row of it is then checked by its own author), or null. */
export const operatorIdOf = (card: ToolCard, ask: Pick<Ask, "source">): string | null => (carryOf(card, ask) === "operator" ? sourceIdOf(ask.source.text) : null);
/** True when the Ask names a source (or asks for the official ones) that the card does not carry: such a plan is never priced. */
export const sourceUnenforced = (card: ToolCard, ask: Pick<Ask, "source">): boolean => (ask.source.kind === "named" || ask.source.kind === "official") && carryOf(card, ask) === null;

/** A card the Ask can use at all: a keyword search needs a topic; a card that takes the source by an input (not a channel id, which the pool resolves) needs a source that can be written there. */
const eligible = (card: ToolCard, ask: Ask): boolean => {
  if (card.inputs.query?.required && !ask.topic.text) return false;
  // a hashtag takes a short name, not the description of an event: more than three words is not a hashtag (the plan would search for a tag nobody wrote)
  if (card.inputs.query?.format === "hashtag" && (!ask.topic.text || ask.topic.text.trim().split(/\s+/).length > 3)) return false;
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
  // P0: a search also carries the named source when its query takes the source's operator and the Ask holds the identifier (sourceScope.ts)
  if (ask.source.kind === "named") add("source", Boolean(card.inputs.source && card.inputs.source.kind !== "channel_id") || operatorIdOf(card, ask) !== null);
  add("order", Boolean(card.inputs.order && card.inputs.order[ask.order] !== undefined));
  return { asked, carried };
}

/** The cards of a stage role that may build it, BEST FIRST: most conditions carried, then a hand-verified card before one derived from the catalog, then pageable, then a counter, then the cheapest page. */
export function rankedCards(ask: Ask, role: StageRole, options: { cards?: ReadonlyArray<ToolCard>; catalogOnly?: boolean; /** The replies cards that may follow (a comments card that gives each comment what such a card needs is chosen first). */ repliesCards?: ReadonlyArray<ToolCard> } = {}): ToolCard[] {
  if (!ask.platform) return [];
  const cards = ROLES_OF(role, ask.platform).flatMap((r) => cardsFor(ask.platform!, r, options)).filter((c) => role !== "parents" || eligible(c, ask));
  // a comments card that feeds the replies step: the replies card's parent input is the comment's id, or a token the comments card keeps on each row
  const feeds = (c: ToolCard): number => (role === "comments" && (options.repliesCards ?? []).some((rc) => rc.inputs.parent && (rc.inputs.parent.from === "id" || (c.mapping.kind === "replies" && (c.mapping.tokens ?? []).some((t) => t.key === rc.inputs.parent!.from)))) ? 1 : 0);
  // ROUND 36: a source that supplies MORE of the fields the customer named (dates, the account, views, likes) ranks first, whatever else it carries; with no field named the term is 0 for every card and the order is what it was
  const score = (c: ToolCard): number[] => [feeds(c), role === "parents" ? suppliedWants(c, ask.wants) : 0, role === "parents" ? carriedBy(c, ask).carried.filter((x) => x === "topic" || x === "period").length : 0, role === "parents" ? carriedBy(c, ask).carried.length : 0, c.derived ? 0 : 1, c.inputs.cursor ? 1 : 0, c.counter ? 1 : 0, -c.costUsdPerPage];
  return [...cards].sort((a, b) => { const x = score(a); const y = score(b); for (let i = 0; i < x.length; i += 1) if (x[i] !== y[i]) return y[i] - x[i]; return catalogOrderOf(a, b); });
}

/** The card of a stage role: the first of `rankedCards`. Null: no usable card (the stage is not included). */
export function chooseCard(ask: Ask, role: StageRole, options: { cards?: ReadonlyArray<ToolCard>; catalogOnly?: boolean; repliesCards?: ReadonlyArray<ToolCard> } = {}): ToolCard | null {
  return rankedCards(ask, role, options)[0] ?? null;
}

/** The first-page inputs of a parent card, written by code from the Ask (the customer's own topic words; the Cairo period as UTC instants; the country; the owner's order; the page size). */
export function parentInputs(card: ToolCard, ask: Ask): Record<string, unknown> {
  const p: Record<string, unknown> = {};
  const q = card.inputs.query;
  // P0: THE NAMED SOURCE IS PART OF THE QUERY when the card's search takes it by an operator (the card's data); with no topic the source's own items are searched
  const opId = q?.sourceOperator ? operatorIdOf(card, ask) : null;
  if (q && (ask.topic.text || opId)) {
    // ROUND 33: a hashtag input takes the topic as one tag (no «#», words joined by «_», the Arabic hashtag convention); the plan says which tag it searched
    let query = topicQueryOf(card, ask);
    if (opId) query = `${query} ${q.sourceOperator}${opId}`.trim();
    if (q.operators) {
      if (ask.language) query += ` lang:${ask.language}`;
      if (ask.period) query += ` since:${operatorStampUtc(ask.period.startMs)} until:${operatorStampUtc(ask.period.endExclusiveMs)}`;
      // THE PARENTS ON X ARE ORIGINAL POSTS (live D5, msn_e7612c1fe8697ca03439; NOV 6 2026 CAMPAIGN, msn_d31f37958788a24ec46d): the stage asks the source for originals only. It was sent only when the replies were asked, and the replies
      // word «ردين» was not read, so a request for «منشورين» was answered by two tweets that were themselves replies to other people (`isReply: true`), delivered and billed as the posts asked
      query += " -filter:replies";
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
  // inputs the card sends on every call as they are (a derived search that asks the source for videos only); no verified parent card has any, so nothing changes for them
  if (card.inputs.fixed) Object.assign(p, structuredClone(card.inputs.fixed));
  return p;
}

/**
 * THE TOPIC AS THE CARD'S QUERY TAKES IT (P0, 15 Nov 2026). One topic: as before (a hashtag, the exact quoted words, or the words). ALTERNATIVES (topicAlternatives.ts): one group joined by the card's documented disjunction
 * (`query.or`; each phrase of several words quoted when the card quotes), never the customer's sentence with its «أو» as one phrase; a card with no documented disjunction searches the FIRST alternative (the plan says so and every row is still
 * matched against all of them). `words`: the RELAXED form of one topic of several words (every word, in any order: the source's bare terms are ANDed), the second strategy of `relaxedInputsOf`.
 */
export function topicQueryOf(card: ToolCard, ask: Pick<Ask, "topic">, mode: "exact" | "words" = "exact"): string {
  const q = card.inputs.query;
  const topic = ask.topic.text;
  if (!q || !topic) return "";
  const alternatives = ask.topic.alternatives ?? [];
  const phrase = (t: string): string => (q.quoted && /\s/.test(t.trim()) ? `"${t.trim()}"` : t.trim());
  if (q.format === "hashtag") return hashtagOf(alternatives[0] ?? topic);
  if (alternatives.length > 0) return q.or ? `(${alternatives.map(phrase).join(` ${q.or} `)})` : q.quoted ? `"${alternatives[0]}"` : alternatives[0];
  if (mode === "words") return topic.trim();
  return q.quoted ? `"${topic}"` : topic;
}

/** THE MOST STRATEGIES ONE PARENT SEARCH TRIES AT PLANNING: the precise query and, when it answered NO row, one relaxed query (the gateway's two samples of one source: no read is added). */
export const SEARCH_STRATEGIES_MAX = 2;
export type SearchStrategy = "exact" | "words" | "source_items" | "expanded" | "expanded_core";
/**
 * THE SECOND SEARCH STRATEGY (P0, 15 Nov 2026), used only when the precise query's first page holds NO row, in place of following that empty page's cursor (production: an empty page's cursor answered 0 rows again in every recorded case, a paid read
 * each). Only a search that takes operators (the restrictions stay written in the query). It keeps EVERY hard condition: the source's operator, the period, the language, originals only; it never drops the source and never searches all
 * of the platform for a request that named one:
 *  - `words`: one topic of several words, its words unquoted (every word, any order) instead of the exact phrase;
 *  - `source_items`: a source carried by the card's operator (alternatives, or one word): the source's own items in the period, each then checked by code for the topic (a row that names none of the topic's words is never chosen).
 * Null: no safe alternative (the request then ends with the scope that was searched, never «nothing exists»).
 */
export function relaxedInputsOf(card: ToolCard, ask: Ask): { strategy: SearchStrategy; params: Record<string, unknown> } | null {
  const q = card.inputs.query;
  if (!q?.operators || !ask.topic.text || q.format === "hashtag") return null;
  const alternatives = ask.topic.alternatives ?? [];
  if (alternatives.length === 0 && q.quoted && /\s/.test(ask.topic.text.trim())) {
    const exact = parentInputs(card, ask);
    const query = String(exact[q.field] ?? "");
    const quoted = topicQueryOf(card, ask, "exact");
    if (!query.startsWith(quoted)) return null;
    return { strategy: "words", params: { ...exact, [q.field]: `${topicQueryOf(card, ask, "words")}${query.slice(quoted.length)}` } };
  }
  if (operatorIdOf(card, ask)) return { strategy: "source_items", params: parentInputs(card, { ...ask, topic: { text: null, relation: "none" } }) };
  return null;
}

/** The longest query an expanded search sends (X documents 512 characters; the operators and the period are added to the group). */
export const EXPANDED_QUERY_MAX_CHARS = 400;
/**
 * P0 (15 Nov 2026): THE EXPANDED STRATEGY (recall). The customer's alternatives AND the topic's variants (other forms of its words, synonyms: researchJudge.ts `topicVariants`, cleaned by code) as ONE disjunction group, with every hard
 * condition kept exactly as the precise query writes it (the source's operator, the period, originals only). Only a card that documents a disjunction (`query.or`) and takes operators. The variants come FIRST in the group, so the query
 * differs from the precise one from its first word (a recorded page is matched by its first 80 characters). Variants are dropped from the end until the query fits. Null: nothing to add, or the card cannot carry it.
 * The variants widen only what is READ: every row is then judged against the request before it can be chosen, delivered or charged.
 */
export function expandedInputsOf(card: ToolCard, ask: Ask, variants: ReadonlyArray<string>): { strategy: SearchStrategy; params: Record<string, unknown> } | null {
  const q = card.inputs.query;
  if (!q?.operators || !q.or || !ask.topic.text || q.format === "hashtag") return null;
  const own = (ask.topic.alternatives ?? []).length > 0 ? ask.topic.alternatives! : [ask.topic.text];
  const exact = String(parentInputs(card, ask)[q.field] ?? "");
  let extra = [...variants];
  while (extra.length > 0) {
    const params = parentInputs(card, { ...ask, topic: { ...ask.topic, alternatives: [...extra, ...own] } });
    const query = String(params[q.field] ?? "");
    if (query.length <= EXPANDED_QUERY_MAX_CHARS && query !== exact) return { strategy: "expanded", params };
    extra = extra.slice(0, -1);
  }
  return null;
}

/** P0 (15 Nov 2026): the most terms the CORE expanded query carries. */
export const CORE_QUERY_MAX_TERMS = 6;
/**
 * P0 (15 Nov 2026, msn_69cd4879ce77e97d01a1 and msn_5a1cf6c36852566f9e41): THE CORE OF THE EXPANDED QUERY. In production a long expanded query (many alternatives and quoted phrases, within the 400-character cap) answered NO row inside
 * the account, while shorter queries of the same vocabulary over the same account and period answered rows (msn_6d86…: 13). After an empty expanded page, the one more read the gateway allows went to the account's newest posts with no
 * topic at all, and none of them was about the request. The core keeps the SAME hard conditions (the source's operator, the period, originals only) and the topic's shortest, most useful forms: the model's first terms of one or
 * two words and the customer's own alternatives of one or two words, at most CORE_QUERY_MAX_TERMS. Null when nothing short is left, or when it is the expanded query itself. Every row is still judged against the request.
 * The customer's own short alternatives come FIRST (zero-spend audit, 15 Nov 2026, msn_55816a05a6afc274e958 and msn_dae6a9b770b0560709cc, both queries proven by their recorded `__params_sig`): with the model's variants first,
 * six short variants filled the cap and the customer's own «الشائعات» was never searched, while the one relevant tweet production had found (1466135018154205187) matches that word and none of the six.
 */
export function coreExpandedInputsOf(card: ToolCard, ask: Ask, variants: ReadonlyArray<string>, expandedParams: Record<string, unknown> | null): { strategy: SearchStrategy; params: Record<string, unknown> } | null {
  const q = card.inputs.query;
  if (!q?.operators || !q.or || !ask.topic.text || q.format === "hashtag") return null;
  const short = (t: string): boolean => t.trim() !== "" && t.trim().split(/\s+/).length <= 2;
  const own = (ask.topic.alternatives ?? []).filter(short);
  const terms: string[] = [];
  for (const t of [...own, ...variants.filter(short)]) { if (!terms.includes(t.trim())) terms.push(t.trim()); if (terms.length >= CORE_QUERY_MAX_TERMS) break; }
  if (terms.length === 0) return null;
  const params = parentInputs(card, { ...ask, topic: { ...ask.topic, alternatives: terms } });
  if (expandedParams && String(params[q.field] ?? "") === String(expandedParams[q.field] ?? "")) return null;
  return { strategy: "expanded_core", params };
}

/** A topic as one hashtag: no «#», words joined by «_». */
export const hashtagOf = (topic: string): string => topic.trim().replace(/^#+/, "").replace(/\s+/g, "_");

export interface CompileInput {
  ask: Ask;
  /** P0 (15 Nov 2026): the research criterion of the mission's research spec (the worker's, from the customer's own words): the relevance subject of the stage, stated on the card as «المقصود». Absent: the subject the code derives. */
  criterion?: string | null;
  /** The parent card's pages read at planning, in order (their call ids and bodies). A page of ANOTHER card of the same role (a second keyword search) carries its own `card`. */
  pool: { card: ToolCard; params: Record<string, unknown>; pages: ReadonlyArray<{ callId: string; page: unknown; card?: ToolCard }> };
  /** YouTube: the counters of the pool's videos from the counter card (id -> comments), when it answered: the promise is then the counters of the chosen videos; absent, it is open. */
  counters?: ReadonlyMap<string, number>;
  /** YouTube: the channels the pool was read from (their ids and titles), said on the card. */
  channels?: ReadonlyArray<{ id: string; title?: string }>;
  /** ROUND 31, YouTube: the channel was given by the customer (not looked up from the topic): the card says it is a search inside that channel. */
  customerChannel?: { display: string | null };
  /** Decision 7.5, Facebook: the customer's answer to the named-page question; absent, a shortfall asks it. */
  namedChoice?: "only_found" | "fill";
  /** ROUND 35: the customer asked for reels and the chosen tool PROVES the media type (reels-only, or its documented media-type filter was sent): the summary says «من نوع ريلز». Never set for an unproven tool. */
  reelsProven?: boolean;
  /** The exposure check (decision 7.3): the first comments page of a parent, read before the card (undefined: not read). */
  exposure: (parentId: string) => { callId: string | null; page: unknown | null; failed: boolean } | undefined;
  capabilityOf: (endpointId: string) => string | null;
  pricingSettings?: MissionPricingSettings;
  /** Owner decision 7.4: a `catalog_only` card may build a stage, for a TEST account only (the caller says so); never for another account. */
  catalogOnly?: boolean;
  /** The moment of planning: a source that says «7 years ago» is placed in time from it (YouTube), to rank by the newest and by the latest occurrence. */
  nowMs?: number;
  /**
   * NOV 6 2026: the customer chose, before approval, to go on with what was found although no row names the topic («أكمل بما وجدتموه كما هو»): unrelated rows may be chosen, each with its mark.
   * P0 (15 Nov 2026): the worker's planning NO LONGER offers or passes it (unrelated rows are never sold as research results), and a row the research judgment (`judged`) rejected is never chosen even with it.
   */
  allowUnrelated?: boolean;
  /** ROUND 33: the cards the plan may be built from (the hand-written ones and the ones derived from the catalog); absent: the hand-written ones, as before. */
  cards?: ReadonlyArray<ToolCard>;
  /**
   * P0 (15 Nov 2026): THE RESEARCH JUDGMENT of the rows read at planning (row id -> about the customer's request), from the same model review that gates execution. A row it decided is chosen or left out by it; a row it could not
   * decide falls back to the word rule. Absent (tests, no model key): the word rule, as before.
   */
  judged?: ReadonlyMap<string, boolean>;
  /**
   * P0 (15 Nov 2026): whether the parent query the plan executes reached ITS END at planning. `true`: what the planning found is the whole of what the source gives for it, and the plan is sized by it. `false` (set by the
   * planning driver only where the engine can read the same query on): a planning sample never sizes the plan; a parent-only plan is sized by the customer's number and the execution reads on until it is reached or the source ends.
   * Absent: unknown, the plan is sized by what was found (as before).
   */
  poolExhausted?: boolean;
  /**
   * P0 (15 Nov 2026, msn_8824508f840f703dee69): the items earlier missions of this conversation delivered, when the customer asked not to receive them again (priorDelivery.ts). A row it matches is never chosen, counted or priced:
   * a parent-only search plan whose sample was all delivered before is still sized by the customer's number (the execution reads past it).
   */
  delivered?: (row: Record<string, unknown>) => boolean;
}

export type CompileResult =
  | { ok: true; plan: PricedPlan; promises: Record<string, StagePromise>; chosen: string[]; spares: string[] }
  | { ok: false; reason: "no_platform_card" | "no_parent_card" | "no_rows" | "no_parent_with_children" }
  /** P0: the request names a source the chosen card does not carry: nothing is priced (the caller asks the customer first). */
  | { ok: false; reason: "source_unenforceable" }
  /** Decision 7.5: the named page has fewer deliverable posts in the pool than asked and the customer has not answered: the caller asks the question (nothing is priced). */
  | { ok: false; reason: "named_shortfall"; found: number; need: number }
  /** NOV 6 2026: rows were read but none names the topic in its text: the caller asks the customer (go on with them marked, change the request, cancel); nothing is priced. */
  | { ok: false; reason: "no_relevant_rows"; read: number; tagOnly: number; /** P0: decided by the research judgment (meaning), not by the words. */ judged?: boolean };

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

/** P0 (15 Nov 2026): the research gate, said on every plan of a research topic. */
export const RESEARCH_GATE_NOTE_AR = "لا نعتمد على ورود الكلمة وحدها: كل عنصر يُفحص قبل التسليم بأنه يتحدث فعلًا عن موضوعك كما كتبته، وما لا يتحدث عنه لا يُسلَّم ولا يُحتسب.";
/** P0 (15 Nov 2026): the card's line of the research criterion (the mission's research spec). */
export const criterionNoteAr = (criterion: string): string => `المقصود بموضوعك كما فهمناه من كلماتك: ${criterion.replace(/[.،؛:\s]+$/u, "")}. راجعه قبل الاعتماد، وإن لم يطابق ما تقصده فعدّل طلبك.`;
/** Every research-gate sentence starts with this (the plan's notes are matched by it). */
export const RESEARCH_GATE_PREFIX_AR = "لا نعتمد على ورود الكلمة وحدها:";
/** The same, for a plan whose comments or replies follow the chosen items: those are delivered as the source gives them (never judged), so the sentence says the check is of the items they belong to, in the platform's own words. */
export function researchGateParentsNoteAr(platform: SocialPlatform): string {
  const item = platform === "x" ? { one: "تغريدة", children: "الردود عليها" } : platform === "tiktok" || platform === "youtube" ? { one: "فيديو", children: "التعليقات والردود عليه" } : { one: "منشور", children: "التعليقات والردود عليه" };
  return `${RESEARCH_GATE_PREFIX_AR} كل ${item.one} يُختار يُفحص قبل التسليم بأنه يتحدث فعلًا عن موضوعك كما كتبته، وما لا يتحدث عنه لا يُسلَّم ولا يُحتسب؛ أما ${item.children} فتُسلَّم كما يعطيها المصدر.`;
}
/** P0 (15 Nov 2026): what a planning sample shows, and that it does not size the source. */
export function sampleNoteAr(input: { read: number; found: number; need: number; judged: boolean }): string {
  const found = input.found === 0 ? "لم نجد فيها بعد" : `وجدنا فيها ${toArabicDigits(input.found)}`;
  return `قرأنا قبل التسعير عينة من ${toArabicDigits(input.read)} عنصرًا، ${found} ما ${input.judged ? "يتحدث فعلًا عن موضوعك" : "يذكر موضوعك"}. العينة لا تبيّن كم يوجد في المصدر: عند التنفيذ نواصل القراءة حتى نصل إلى ${toArabicDigits(input.need)} أو تنتهي نتائج المصدر، وقد يكون العدد النهائي أقل بكثير من المطلوب. لا يُخصم إلا مقابل ما يُسلَّم فعلًا، ولا يتجاوز الخصم المبلغ المحجوز.`;
}

/** ROUND 16: how many of the selected items match the customer's conditions and how many are alternatives marked in the file (all counted on the inspected planning rows; Arabic-Indic digits, no provider, no price). */
export const MATCH_COUNTS_PREFIX_AR = "من العناصر المختارة وعددها";
export function matchCountsLineAr(selected: number, alternatives: number): string {
  const alt = Math.max(0, Math.min(selected, Math.floor(alternatives)));
  return `${MATCH_COUNTS_PREFIX_AR} ${toArabicDigits(selected)}: ${alt === 0 ? "كلها تطابق شروطك، ولا بديل بينها" : `${toArabicDigits(selected - alt)} تطابق شروطك، و${toArabicDigits(alt)} منها بدائل عليها علامة في الملف`}.`;
}

/** The customer's one sentence for a compiled plan (Arabic, Arabic-Indic digits, no provider, no price). */
export function summaryAr(ask: Ask, n: number, shape: ReadonlyArray<StageRole>, perParent: number | null = null, reelsProven = false): string {
  const w = NOUN[ask.platform!];
  // ROUND 26 (item 5): the count takes the Arabic plural rules of the item-noun table (1, 2, 3 to 10, 11 and above); «١٠ تغريدات», never «١٠ تغريدة»
  // ROUND 35: a request for reels whose media type the tool PROVES is said as reels («٥ ريلز»); the noun of the stage and of the file stays the post's
  const count = reelsProven ? (n === 1 ? "ريل واحد" : n === 2 ? "ريلين" : `${toArabicDigits(n)} ريلز`) : countAr(n, itemNounOf(w.one), { subject: true });
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

const filtersOf = (ask: Ask, card: ToolCard): StageFilter[] => {
  const f: StageFilter[] = [];
  if (ask.language) f.push({ kind: "language", lang: ask.language, field: "language" } as StageFilter);
  if (ask.country) f.push({ kind: "place", field: "country", fields: ["country"], places: [ask.country], values: [COUNTRY_AR[ask.country] ?? ask.country] } as StageFilter);
  if (ask.period) f.push({ kind: "period", from: ask.period.from, to: ask.period.to, field: "posted_at" } as StageFilter);
  // P0: a search that carries the source by its operator is checked again on EVERY item the run reads (agent/src/items/ingest.ts): exactly the author's identifier, nothing else; an item of another account is neither delivered nor charged
  const opId = operatorIdOf(card, ask);
  if (opId && card.mapping.kind === "fields" && card.mapping.fields.username) f.push({ kind: "account", field: "username", fields: ["username"], values: [opId], exact: true } as StageFilter);
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
/**
 * P0 (15 Nov 2026): a search that CARRIES a named source by its operator (X `from:`) checks every row by its own date too (as it checks the author and the topic): the source can ignore an operator, and a relaxed strategy reads the source's own
 * posts. An ordinary X search keeps its rule (outside rows marked «لا», never dropped: live round B). The mapping writes every X date as an ISO instant (mapCode.ts `iso`).
 */
const periodGatedFor = (ask: Ask, poolCard: ToolCard): boolean => periodIsChecked(ask) || (ask.period !== null && operatorIdOf(poolCard, ask) !== null);

export function rankedPoolOf(input: { ask: Ask; poolCard: ToolCard; pages: ReadonlyArray<{ page: unknown; card?: ToolCard }>; counters?: ReadonlyMap<string, number>; channels?: ReadonlyArray<{ id: string; title?: string }>; nowMs?: number; /** Count every row read, inside the period or not, eligible or not (the card says how many were read and how many were left out). */ keepOutsidePeriod?: boolean; /** The customer chose to go on with rows that do not name the topic. */ allowUnrelated?: boolean; /** P0: the research judgment of the rows read (id -> about the request), when the planning could ask it. */ judged?: ReadonlyMap<string, boolean> }): PoolRow[] {
  const { ask, poolCard } = input;
  const card: ToolCard = poolCard.counter || !input.counters ? poolCard : { ...poolCard, counter: { key: "comments", counts: "comments" } };
  const mapped = input.pages.flatMap((p) => mapPage(p.card ?? poolCard, p.page)).map((r) => (input.counters && input.counters.has(String(r.id)) ? { ...r, comments: input.counters.get(String(r.id)) } : r))
    // a source that dates a video only by «7 years ago» (YouTube): placed in time from the moment of planning, for the order «newest» and for the latest occurrence of a recurring event
    // ROUND 38: that instant is COMPUTED, never the source's: the row carries the mark (`_approx_dates`), kept in the plan's pinned rows, so the preview and the file call it approximate whatever the gap between planning and the run
    .map((r) => { if ((r.posted_at === undefined || r.posted_at === null) && input.nowMs !== undefined) { const t = approxInstantOfRelative(r.published, input.nowMs); if (t !== null) return { ...r, posted_at: new Date(t).toISOString(), [APPROX_DATES_KEY]: [...approxColumnsOf(r).filter((k) => k !== "posted_at"), "posted_at"] }; } return r; });
  // WHEN THE ASK HAS A PERIOD every parent of the pool is inside it, whichever search read it (live round 11): the chosen parents, the spares and the exposure check all come from this one list
  const inPeriodAll = input.keepOutsidePeriod !== true && periodGatedFor(ask, poolCard) ? mapped.filter((r) => insidePeriod(r, ask)) : mapped;
  // AN X PARENT IS AN ORIGINAL POST (NOV 6 2026 CAMPAIGN): a tweet the source marks as a reply to someone else is never a parent, even when the source ignored `-filter:replies` (one list for the chosen parents, the spares and the exposure check)
  const inPeriod = input.keepOutsidePeriod !== true ? inPeriodAll.filter((r) => parentEligible(r, ask, { allowUnrelated: input.allowUnrelated === true, authorId: operatorIdOf(poolCard, ask), ...(input.judged ? { judged: input.judged } : {}) })) : inPeriodAll;
  const rankedAll = rankPool(inPeriod, ask, card, { occurrence: ask.occurrence });
  return ask.source.kind === "official" && (input.channels?.length ?? 0) > 1 ? interleaveByChannel(rankedAll, ask) : rankedAll;
}

/** True when the source marks the row as a reply to someone else (X: `is_reply`). */
const isReplyRow = (row: Record<string, unknown>): boolean => row.is_reply === true || row.is_reply === "true" || row.is_reply === "True";
/**
 * A row the plan may choose as a PARENT.
 *  - X: never a tweet that is itself a reply (`is_reply: true`, the source's own mark): an original-post request is answered by original posts (NOV 6 2026, msn_d31f37958788a24ec46d).
 *  - THE TOPIC (NOV 6 2026: an Instagram dental clinic advertisement and a Facebook post both marked «لا يذكر الموضوع» were chosen and billed for «عن الذكاء الاصطناعي»): a row whose own text does not name the topic at all
 *    (tier 0) is UNRELATED and is never chosen, unless the customer chose, before approval, to go on with what was found (`allowUnrelated`, the answer «أكمل بما وجدتموه كما هو»). A row that names the topic only in its hashtags (tier 1)
 *    stays eligible and keeps its mark («يذكر الموضوع في الوسوم فقط»); nothing is guessed: the text is read as it is, no synonym or translation is added.
 */
export function parentEligible(row: Record<string, unknown>, ask: Pick<Ask, "platform" | "topic" | "source">, options: { allowUnrelated?: boolean; /** P0: the source a search carried by its operator: a row whose own author is not it is never a parent (sourceScope.ts rowIsBy). */ authorId?: string | null; /** P0 (15 Nov 2026): the research judgment of the row, when the planning asked it. */ judged?: ReadonlyMap<string, boolean> } = {}): boolean {
  if (ask.platform === "x" && isReplyRow(row)) return false;
  if (options.authorId && !rowIsBy(row, options.authorId)) return false;
  // P0 (15 Nov 2026, msn_cd5f32adadefb9bb971f): A JUDGED ROW IS DECIDED BY ITS JUDGMENT, on every platform, whatever the customer answered before. A row judged not about the request is never a research result (three tweets that only shared
  // the word «شائعة» = «common» with «الشائعات» = «rumors» were planned, delivered and charged); a row judged about it is one even when it does not repeat the customer's words.
  const verdict = researchTopicOf(ask) && options.judged ? options.judged.get(String(row.id)) : undefined;
  if (verdict === false) return false;
  if (verdict === true) return true;
  // P0 (15 Nov 2026): a search CARRYING a named source by its operator is a gate for the topic too (the customer asked for the source's items ABOUT the topic; a relaxed search or the source's own items no longer guarantee the words)
  if (options.allowUnrelated !== true && (topicGated(ask) || (Boolean(options.authorId) && Boolean(ask.topic?.text))) && topicTierOf(String(row.text ?? ""), ask) === 0) return false;
  return true;
}
/**
 * WHERE THE TOPIC IS A GATE: a request whose only condition on the items is the topic (no page, account or channel named, no official source), read by the topic's own search. There the topic is the
 * request, and a result whose text never names it is a result the source matched for another reason (an advertisement's tags, a caption's other words). A request that names a source keeps the earlier rule
 * (the source's items are chosen and marked by their relation to the topic): the source is what the customer asked first.
 * SCOPE (the evidence): Facebook's and Instagram's keyword searches, whose results are matched by the source on more than the caption (the dental advertisement, the post marked «لا يذكر الموضوع»). X's search asks the
 * exact quoted words (the source keeps to them) and TikTok asks the customer when no video is about the topic (live round 7): both are unchanged here.
 */
export const TOPIC_GATED_PLATFORMS: ReadonlyArray<SocialPlatform> = ["facebook", "instagram"];
export const topicGated = (ask: Pick<Ask, "topic" | "source"> & { platform?: Ask["platform"] }): boolean =>
  Boolean(ask.topic?.text) && ask.source?.kind === "none" && ask.platform !== undefined && ask.platform !== null && TOPIC_GATED_PLATFORMS.includes(ask.platform);

/** The topic gate of a pool: the request's (`topicGated`) or, P0, a search that carries a named source by its operator and has a topic. */
export const topicGatedFor = (ask: Ask, poolCard: ToolCard): boolean => topicGated(ask) || (Boolean(ask.topic.text) && operatorIdOf(poolCard, ask) !== null);

/**
 * P0 (15 Nov 2026): A RESEARCH TOPIC, the subject the items must be ABOUT («عن الشائعات»). Not a topic the items are made WITH (a sound, a filter: `made_with`), which a word does decide.
 * A research topic is judged by meaning: at planning (the judge the worker passes in `judged`) and at execution (the stage's `relevance` rule with `judge: "model"`, applied by the item store and its review).
 */
export const researchTopicOf = (ask: Pick<Ask, "topic">): boolean => Boolean(ask.topic?.text) && ask.topic.relation !== "made_with";

/** The execution's relevance rule of a research topic: every row with text is judged by the review against the customer's request; the words are only what was searched. */
export function researchRelevanceOf(
  ask: Pick<Ask, "topic"> & Partial<Pick<Ask, "source" | "country">> & { brief?: string; entity?: string },
  textColumns: ReadonlyArray<string>,
  /** P0: the mission's research criterion (the worker's research spec, made from the customer's own words), when there is one: it is the subject every judgment reads and the card states. */
  criterion?: string | { entity?: string; country?: string; topic?: string; brief?: string } | null
): (RelevanceSpec & { criterion: { entity: string; country: string; topic: string; brief?: string } }) | null {
  if (!researchTopicOf(ask) || textColumns.length === 0) return null;
  const alternatives = (ask.topic.alternatives ?? []).filter((a) => a.trim() !== "");
  const terms = (alternatives.length > 0 ? alternatives : [ask.topic.text!]).map((t) => t.trim()).slice(0, 12);
  const own = typeof criterion === "string" ? criterion.replace(/\s+/g, " ").trim().replace(/[.،؛:\s]+$/u, "") : "";

  // DT-20261123-x-account-rumors r7: Derive structured criterion (entity, country, topic, brief) generically from LLM output / ask without hardcoded word lists or defaults
  let entity = "";
  let country = "";
  let topic = "";
  let brief = (ask as any).brief ?? (typeof criterion === "string" ? criterion : "") ?? "";

  if (criterion && typeof criterion === "object") {
    entity = String(criterion.entity ?? "").trim();
    country = String(criterion.country ?? "").trim();
    topic = String(criterion.topic ?? "").trim();
    if (criterion.brief) brief = String(criterion.brief).trim();
  }

  if (!entity && (ask as any).entity) entity = String((ask as any).entity).trim();
  if (!entity && ask.source?.text && !ask.source.text.startsWith("http")) entity = String(ask.source.text).trim();
  if (!country && ask.country) country = String(ask.country).trim();
  if (!topic && ask.topic?.text) topic = String(ask.topic.text).trim();

  const critObj: { entity: string; country: string; topic: string; brief?: string } = {
    entity,
    country,
    topic,
    ...(brief ? { brief } : {}),
  };

  return {
    subject_ar: own !== "" ? own : `محتوى يتحدث فعلًا عن: ${terms.join(" أو ")}`,
    terms,
    text_columns: [...textColumns],
    min_own_words: 0,
    review: true,
    judge: "model",
    criterion: critObj,
  };
}

/** Compiles the plan. Pure: the same Ask and the same pages give the same plan. */
export function compilePlan(input: CompileInput): CompileResult {
  const { ask } = input;
  if (!ask.platform || !(COMPILED_PLATFORMS as ReadonlyArray<string>).includes(ask.platform)) return { ok: false, reason: "no_platform_card" };
  // P0: A SOURCE THE PLAN CANNOT ENFORCE IS NEVER PRICED, on any platform (msn_dd7c2e9c131b8783bf2e: «the Saudi Ministry of Health's account» searched across all of X, 79 tweets of 38 other accounts billed); the caller asks the customer first,
  // and this is the guard if it did not
  // (a listing read by an identifier resolved from the customer's name by evidence, Facebook's page link found by its name: the pool's own inputs carry it)
  const listedBy = input.pool.card.inputs.source && input.pool.card.inputs.source.kind !== "channel_id" ? input.pool.params?.[input.pool.card.inputs.source.param] : undefined;
  if (sourceUnenforced(input.pool.card, ask) && !(typeof listedBy === "string" && listedBy !== "")) return { ok: false, reason: "source_unenforceable" };
  const shape = stageShapeOf(ask);
  const poolCard = input.pool.card;
  // THE COUNTER OF THE POOL: the parent card's own, or (YouTube) the counter card's, merged onto the rows by id
  const counterKey: string | null = poolCard.counter?.key ?? (input.counters ? "comments" : null);
  const card: ToolCard = poolCard.counter || !input.counters ? poolCard : { ...poolCard, counter: { key: "comments", counts: "comments" } };
  const judged = input.judged && researchTopicOf(ask) ? input.judged : undefined;
  const ranked0 = rankedPoolOf({ ask, poolCard, pages: input.pool.pages, ...(input.counters ? { counters: input.counters } : {}), ...(input.channels ? { channels: input.channels } : {}), ...(input.nowMs !== undefined ? { nowMs: input.nowMs } : {}), ...(input.allowUnrelated ? { allowUnrelated: true } : {}), ...(judged ? { judged } : {}) });
  // P0 (15 Nov 2026, msn_8824508f840f703dee69): WHAT WAS DELIVERED BEFORE, never offered again (the customer asked «من دون تكرار»). A parent-only search the engine can read on is planned even when every row read was delivered before
  // or is not about the request: the sample is the earlier mission's own first pages, and the execution reads past them (sized by the customer's number, `sizedByRequest` below)
  const isDelivered = (r: Record<string, unknown>): boolean => input.delivered !== undefined && input.delivered(r);
  const deliveredBefore = input.delivered ? rankedPoolOf({ ask, poolCard, pages: input.pool.pages, keepOutsidePeriod: true, ...(input.nowMs !== undefined ? { nowMs: input.nowMs } : {}) }).filter(isDelivered).length : 0;
  const readsOnPastSample = !shape.includes("comments") && !shape.includes("replies") && /\.search$/.test(poolCard.role) && input.poolExhausted === false && input.namedChoice !== "only_found";
  const continuesPast = deliveredBefore > 0 && readsOnPastSample;
  if (ranked0.length === 0 && !continuesPast) {
    // NOTHING READ NAMES THE TOPIC (and every row is otherwise a candidate): the customer decides before approval (go on with what was found, marked; change the request; cancel). Nothing is priced or held
    const all = rankedPoolOf({ ask, poolCard, pages: input.pool.pages, ...(input.nowMs !== undefined ? { nowMs: input.nowMs } : {}), allowUnrelated: true });
    // P0: rows were read and the research judgment found none about the request: the same honest question, on every platform (never a plan of rows about something else)
    if (all.length > 0 && (topicGatedFor(ask, poolCard) || (judged !== undefined && all.some((r) => judged.get(String(r.id)) === false)))) return { ok: false, reason: "no_relevant_rows", read: all.length, tagOnly: all.filter((r) => topicTierOf(String(r.text ?? ""), ask) === 1).length, ...(judged !== undefined && all.some((r) => judged.has(String(r.id))) ? { judged: true } : {}) };
    return { ok: false, reason: "no_rows" };
  }
  const need = Math.max(1, ask.count ?? DEFAULT_COUNT);
  const catalogOnly = input.catalogOnly === true;
  // WHAT THE SOURCES ANSWERED OUTSIDE THE PERIOD (live round 11): every row read, and how many the period rule left out (said on the card as a count)
  const readAll = rankedPoolOf({ ask, poolCard, pages: input.pool.pages, keepOutsidePeriod: true, ...(input.counters ? { counters: input.counters } : {}), ...(input.channels ? { channels: input.channels } : {}), ...(input.nowMs !== undefined ? { nowMs: input.nowMs } : {}) });
  const notOriginal = ask.platform === "x" ? readAll.filter(isReplyRow).length : 0;
  // P0: a row the research judgment decided is counted by its verdict; an undecided row by the word rule where the topic is a gate
  const notAbout = (r: PoolRow): boolean => { const v = judged?.get(String(r.id)); return v !== undefined ? v === false : topicGatedFor(ask, poolCard) && topicTierOf(String(r.text ?? ""), ask) === 0; };
  const unrelatedLeftOut = input.allowUnrelated && !judged ? 0 : readAll.filter((r) => !(ask.platform === "x" && isReplyRow(r)) && !isDelivered(r) && notAbout(r)).length;
  const leftOutOfPeriod = periodGatedFor(ask, poolCard) ? readAll.filter((r) => parentEligible(r, ask, { allowUnrelated: input.allowUnrelated === true, ...(judged ? { judged } : {}) })).length - ranked0.length : 0;
  const cardsOpt = input.cards ? { cards: input.cards } : {};
  const repliesCards = shape.includes("replies") ? cardsFor(ask.platform, REPLY_ROLE[ask.platform], { catalogOnly, ...cardsOpt }) : [];
  const commentsCard = shape.includes("comments") ? chooseCard(ask, "comments", { catalogOnly, repliesCards, ...cardsOpt }) : null;
  const repliesCard = shape.includes("replies") ? chooseCard(ask, "replies", { catalogOnly, ...cardsOpt }) : null;
  // a counter the row does not carry is UNKNOWN, never 0 (live round 11: `Number(null)` is 0, so a row with no counter was read as a row that has no children)
  const counter = (r: PoolRow): number | null => { if (!counterKey) return null; return counterValueOf(r[counterKey]); };
  // DECISION 7.5 (Facebook): «only the ones found» keeps the named page's posts only; the choice is the customer's, made before approval
  const bySource = Boolean(poolCard.inputs.source);
  const isNamed = (r: Record<string, unknown>): boolean => factsOf(r, ask, bySource).named;
  // A POST THE CUSTOMER ASKED FOR from a named page is the page's AND (when a topic is named) about the topic (live round 10: 4 posts of «the page» with 2 about the topic satisfied 3 asked, and no question was asked)
  const isNamedAbout = (r: Record<string, unknown>): boolean => isNamed(r) && (!ask.topic.text || factsOf(r, ask, bySource).topicTier === 2);
  const rankedAll = input.namedChoice === "only_found" && ask.source.kind === "named" ? ranked0.filter(isNamedAbout) : ranked0;
  if (rankedAll.length === 0 && !continuesPast) return { ok: false, reason: "no_rows" };
  const ranked = deliveredBefore > 0 ? rankedAll.filter((r) => !isDelivered(r)) : rankedAll;
  if (ranked.length === 0 && !continuesPast) return { ok: false, reason: "no_rows" };

  // THE EXPOSURE CHECK (decision 7.3): a parent whose first comments page is empty while its counter says it has comments is replaced by the next one, before the card; a parent that says it has none is never chosen for a comments request
  const chosen: PoolRow[] = [];
  const exposurePages: Array<{ parent: string; callId: string | null; rows: Array<Record<string, unknown>> }> = [];
  let scanned = 0;
  // X WITH ITS REPLIES: a tweet whose own counter says it has replies is chosen before one that says it has none (a parent with nothing to give for the step the customer asked); ordering only, the counters stay the source's
  const xReplies = ask.platform === "x" && shape.includes("replies") && counterKey !== null;
  const candidates = xReplies ? [...ranked.filter((r) => counter(r) !== 0), ...ranked.filter((r) => counter(r) === 0)] : ranked;
  for (const r of candidates) {
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
  if (chosen.length === 0 && !continuesPast) return { ok: false, reason: commentsCard ? "no_parent_with_children" : "no_rows" };
  // DECISION 7.5: a named Facebook page whose deliverable posts in the pool are fewer than asked: the customer decides before approval (the question is asked by the caller; nothing is priced)
  const namedFacebook = ask.platform === "facebook" && ask.source.kind === "named" && poolCard.role === "posts.search";
  if (namedFacebook && input.namedChoice === undefined) {
    const found = chosen.filter(isNamedAbout).length;
    if (found < need) return { ok: false, reason: "named_shortfall", found, need };
  }
  const spares = candidates.slice(scanned).filter((r) => !commentsCard || counter(r) !== 0).slice(0, 2);

  const promises: Record<string, StagePromise> = {};
  const notes: string[] = [];
  const unserved: Array<{ what_ar: string; reason_ar: string }> = [];
  const capabilityOf = input.capabilityOf;
  const stages: PricedStage[] = [];
  const parentKey = PARENT_KEY[ask.platform];
  // THE 0.20 USD CAP (decision 7.4): the stages that use a catalog_only card share it; each gets the pages its share buys at twice the catalog's price (the stage's own page limit)
  // ROUND 16: the comments stage's alternatives, decided here by code (never a planning call): the other cards of the platform that pass every rule of alternatives.ts; a `catalog_only` one (a test account only) shares the same cap
  const alternatives = commentsCard ? commentsAlternativesOf({ platform: ask.platform, primary: commentsCard, parents: chosen, repliesCard: shape.includes("replies") && repliesCard ? repliesCard : null, catalogOnly }) : null;
  const captureAlternatives = (alternatives?.alternatives ?? []).filter((a) => a.capture);
  const catalogOnlyStages = [commentsCard, repliesCard].filter((c): c is ToolCard => c !== null && c.status === "catalog_only").length + (captureAlternatives.length > 0 && commentsCard?.status !== "catalog_only" ? 1 : 0);
  const sharedMaxPages = (c: ToolCard): number | null => (c.status === "catalog_only" && c.costUsdPerPage > 0 ? catalogOnlyPagesOf(c, catalogOnlyStages) : null);
  /** The comments stage's pages: the cap of its own card, and of a `catalog_only` alternative it may continue with (the cap is the stage's: the engine counts the stage's pages whichever tool read them). */
  const commentsMaxPages = (c: ToolCard): number | null => { const own = [sharedMaxPages(c), ...captureAlternatives.map((a) => sharedMaxPages(a.card))].filter((x): x is number => x !== null); return own.length > 0 ? Math.min(...own) : null; };
  // THE TOPIC RELATION MARK (live round 7, always since round 11): every item of the stage carries how its own text relates to the topic the customer named, so the file says which is which (a mark, never a drop)
  // P0: a judged row's relation is its judgment (about the request, or not), never the presence of a word
  const tierOf = (r: PoolRow) => { const v = judged?.get(String(r.id)); return v === true ? 2 : v === false ? 0 : factsOf(r, ask, bySource).topicTier; };
  // LIVE ROUND 11: the column is on the parent sheet WHENEVER the Ask has a topic, on every platform (a file whose items are all about it said nothing, so «all about it» could not be told from «not checked»)
  const markTopic = Boolean(ask.topic.text);
  // THE NAMED-SOURCE MARK (decision 7.5, «fill from other pages»): a post that is not the named page's carries «المصدر المسمّى: غير مطابق», the page's own posts carry nothing (a mark, never a drop)
  // ROUND 17: a named source read BY ITS OWN LISTING (an Instagram account, a Facebook page by its link) carries the mark too: each row says by its own author whether it is the named source's («مطابق» / «غير مطابق»), and «غير متاح من المصدر» ONLY when the row carries no author at all (live round 14, Instagram: both posts of the named account read «غير متاح من المصدر»)
  const namedByListing = ask.source.kind === "named" && (ask.source.text ?? "") !== "" && poolCard.inputs.source !== undefined && poolCard.inputs.source.kind !== "channel_id";
  const markNamed = namedFacebook || namedByListing;
  const namedValue = (r: PoolRow): string => {
    if (namedFacebook) return isNamed(r) ? "" : NAMED_MISMATCH_MARK_AR;
    const v = namedAuthorVerdict(r, ask.platform, ask.source.text);
    return v === null ? NAMED_UNAVAILABLE_MARK_AR : v ? "" : NAMED_MISMATCH_MARK_AR;
  };
  const shown = (r: PoolRow): PoolRow => ({ ...r, ...(markTopic ? { [TOPIC_RELATION_KEY]: topicRelationAr(tierOf(r)) } : {}), ...(markNamed ? { [NAMED_MARK_KEY]: namedValue(r) } : {}) });
  const cardFieldKeys = [...Object.keys(card.mapping.kind === "fields" ? card.mapping.fields : {}), ...(card.mapping.kind === "fields" && card.mapping.linkTemplate ? ["link"] : []), ...(input.counters && !poolCard.counter ? ["comments"] : [])];
  // ROUND 27 (item 4): the parent sheet of a platform whose search has several verified tools has the SAME columns whichever tool read the page; a field the tool does not give stays a column and says «غير متاح» (workbook.ts)
  // ROUND 36: a field the customer NAMED is a column even when the chosen tool cannot give it (its cells say «غير متاح» and the plan said so before approval), never an omission
  // NOV 6 2026: and the platform's standard parent fields (Instagram: the account, the date, the likes); an account given by the handle column is the account
  const wantedKeys = sheetWantsOf(ask).map((k) => COLUMN_OF[k]).filter((k) => !cardFieldKeys.includes(k) && !(k === "author" && cardFieldKeys.includes("username")));
  const fieldKeys = sameParentColumnsOf(ask.platform, [...cardFieldKeys, ...wantedKeys]);
  const columns = [...fieldKeys.filter((k, i) => k !== "id" && fieldKeys.indexOf(k) === i).map((k) => ({ key: k, title_ar: TITLE[k] ?? k })), ...(markTopic ? [{ key: TOPIC_RELATION_KEY, title_ar: TOPIC_RELATION_TITLE_AR }] : []), ...(markNamed ? [{ key: NAMED_MARK_KEY, title_ar: NAMED_MARK_TITLE_AR }] : [])];
  const pageRows = Math.max(1, card.page.observedRowsPerPage);
  // P0 (15 Nov 2026, msn_cd5f32adadefb9bb971f): A PLANNING SAMPLE NEVER SIZES THE PLAN. Two sample pages say what the source returns first, not how much it holds: a request for 400 tweets was planned, priced (66.67 points a tweet,
  // the mission minimum spread over 3) and executed as the 3 rows of the sample, with no read at execution. A plan of parent items only is sized by the customer's number unless the query the plan executes reached its end at planning
  // (then what was found IS what the source gives). The execution reads on (the pinned rows are fewer than the volume, so the engine reads the source afresh) and every row passes the research judgment; the customer is charged per
  // delivered row only, never above the hold. A plan with comments or replies keeps its chosen parents (their children were measured on them).
  const parentOnly = !commentsCard && !shape.includes("comments") && !shape.includes("replies");
  // `poolExhausted === false` is the driver's word that the executed query did NOT end and the engine can read on (unknown: the plan keeps what was found); «only the ones found» on a named page is the customer's own limit
  // Only a SEARCH (its query carries the source, the period and the topic, so reading on stays inside the request); an account's or a page's LISTING has no date input and would be paged back through its whole history: it keeps
  // what the planning walk found, with the customer's number kept (`quantity`) so the delivery is told as partial
  const searchRole = /\.search$/.test(poolCard.role);
  const sizedByRequest = parentOnly && searchRole && input.poolExhausted === false && input.namedChoice !== "only_found" && chosen.length < need;
  const parentRows = sizedByRequest ? need : chosen.length;
  promises[parentKey] = sizedByRequest ? { type: "open", n: need } : { type: "exact", n: chosen.length };
  const textColumns = fieldKeys.includes("text") ? ["text"] : [];
  const relevance = researchRelevanceOf(ask, textColumns, input.criterion);
  stages.push({
    key: parentKey, title_ar: input.reelsProven === true ? REELS_TITLE_AR : PARENT_TITLE[ask.platform], endpoint_id: card.endpointId, ...(capabilityOf(card.endpointId) ? { capability: capabilityOf(card.endpointId)! } : {}),
    expected_rows: parentRows, planned_rows: parentRows, parent_key: null, deliver: true, columns, sample_rows: chosen.slice(0, 3).map(shown), ...(relevance ? { relevance } : {}),
    measured_by: input.pool.pages.map((p) => p.callId), measured_from_calls: input.pool.pages.map((p) => p.callId), measured_cost_per_row_usd: card.costUsdPerPage / pageRows,
    yield_share: 1, review_share: 0, pinned_rows: chosen.map(shown), ...(spares.length > 0 && commentsCard ? { spare_rows: spares.map(shown) } : {}),
    ...(filtersOf(ask, card).length > 0 ? { filters: filtersOf(ask, card) } : {}),
    ...(ask.order === "most_commented" && commentsCard ? { chosen_most_engaged: true } : {}),
    engine: { endpoint_id: card.endpointId, params: input.pool.params, cursor_param: card.inputs.cursor, map_code: cardMapCode(card), map_file_id: "page", parent_binding: null, built_by: "code", ...(card.cannot && card.cannot.length > 0 ? { gaps: card.cannot.filter((c) => (c === "language" && ask.language) || (c === "period" && ask.period) || (c === "country" && ask.country)).map((c) => ({ cls: c === "period" ? "date" : c, reason: "no_field" })) } : {}) },
  } as PricedStage);
  // «يتحدث فعلًا» only when every chosen row was judged (the planning judge has a small cap; rows past it were matched by the words)
  if (sizedByRequest) notes.push(sampleNoteAr({ read: readAll.length, found: chosen.length, need, judged: judged !== undefined && chosen.every((r) => judged.has(String(r.id))) }));
  if (deliveredBefore > 0) notes.push(priorDeliverySampleAr(deliveredBefore));
  else if (chosen.length < need) notes.push(`وجدنا في ما قرأناه ${toArabicDigits(chosen.length)} فقط تناسب طلبك من ${toArabicDigits(need)}${input.poolExhausted === true ? "، وانتهت نتائج المصدر لهذا البحث عند آخر صفحة قرأناها" : ""}.`);
  // P0: a plan whose search carries the source by its operator says so before approval: that source alone, every item checked, and the count may be lower
  if (operatorIdOf(poolCard, ask)) notes.push(sourceOperatorNoteAr(operatorIdOf(poolCard, ask)!));
  // P0 (15 Nov 2026): the alternatives the customer listed, as they were searched and checked
  const topicAlts = ask.topic.alternatives ?? [];
  if (topicAlts.length > 0) notes.push(poolCard.inputs.query?.or ? `بحثنا عن أيٍّ من: ${alternativesAr(topicAlts)}.` : `هذا المصدر يبحث بعبارة واحدة في المرة، فبحثنا بـ«${topicAlts[0]}».`);
  // P0: what decides a research result is said once, truthfully: the meaning, judged on every row, never the presence of a word
  if (relevance) notes.push(parentOnly ? RESEARCH_GATE_NOTE_AR : researchGateParentsNoteAr(ask.platform));
  // P0 (15 Nov 2026): the research criterion every item is judged against (the mission's research spec, made from the customer's own words), stated BEFORE approval so the customer can see whether it is what they meant
  if (relevance && typeof input.criterion === "string" && input.criterion.trim() !== "") notes.push(criterionNoteAr(relevance.subject_ar));
  if (unrelatedLeftOut > 0) notes.push(judged ? `تركنا ${toArabicDigits(unrelatedLeftOut)} مما قرأناه لأنه لا يتحدث عن «${ask.topic.text}» وإن تشابهت بعض كلماته، ولا يدخل في السعر.` : `لم نختر شيئًا لا يذكر «${ask.topic.text}» في نصه؛ تركنا ${toArabicDigits(unrelatedLeftOut)} مما قرأناه لأن نصه لا يذكر الموضوع، ولا يدخل في السعر.`);
  if (ask.preferences && ask.preferences.length > 0) notes.push(`عاملنا ما كتبته بين قوسين أو كشرط إتاحة («${ask.preferences.join("»، «")}») كتفضيل لا كجزء من الموضوع، فلم نضفه إلى كلمات البحث.`);
  if (notOriginal > 0) notes.push(`لم نختر أي تغريدة هي نفسها ردّ على حساب آخر؛ تركنا ${toArabicDigits(notOriginal)} من هذا النوع مما قرأناه، لأنك طلبت منشورات أصلية.`);
  // WHAT THE POOL HELD, from the pages' own numbers (Facebook's keyword search): how many posts were read in how many pages, whether the source had more, how many are from the named page and how many talk about the topic
  if (poolCard.role === "posts.search") {
    const searchPages = input.pool.pages.filter((p) => (p.card ?? poolCard).role === "posts.search");
    const last = searchPages[searchPages.length - 1];
    const more = last ? Boolean(atPath(last.page, (last.card ?? poolCard).page.cursor)) : false;
    const parts = [`قرأنا ${input.reelsProven === true ? (readAll.length === 1 ? "ريلًا واحدًا" : readAll.length === 2 ? "ريلين" : `${toArabicDigits(readAll.length)} ريلز`) : postsCountAr(readAll.length)} من نتائج البحث في ${pagesCountAr(searchPages.length)}${more ? "، وفي المصدر المزيد" : ""}.`];
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
  if (ask.platform === "youtube" && input.customerChannel) {
    notes.push(youtubeChannelNoteAr(input.customerChannel.display));
  } else if (ask.platform === "youtube" && input.channels && input.channels.length > 0) {
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
    // ROUND 17: the highest counter of what was read, said with the choice (a pool of a few minutes of a busy account has small counters: the card shows it before approval, the choice itself is unchanged)
    const counters = ranked0.map((r) => counterValueOf(r[counterKey ?? "comments"])).filter((c): c is number => c !== null);
    notes.push(`اخترنا الأكثر تعليقًا من آخر ${countAr}${times.length > 0 ? `، وهي المنشورات التي نُشرت من ${cairoMomentAr(Math.min(...times))} إلى ${cairoMomentAr(Math.max(...times))} بتوقيت القاهرة` : ""}.${counters.length > 0 ? ` أعلى عدّاد تعليقات بين ما قرأناه ${toArabicDigits(Math.max(...counters))}، ولم نقرأ منشورات أقدم منها.` : ""}`);
  }
  // ROUND 17: A PERIOD A LISTING DID NOT REACH. A listing has no date input, so the period is reached by paging back; when the pages read (within the planning budget and the gateway's own caps) stop inside the period while the source has more, the card says it before approval: the posts read, the period they cover, the period asked
  if ((poolCard.role === "posts.account" || poolCard.role === "posts.page") && ask.period) {
    const dated = readAll.map((r) => Date.parse(String(r.posted_at ?? ""))).filter((t) => Number.isFinite(t));
    const lastPage = input.pool.pages[input.pool.pages.length - 1];
    const more = lastPage ? Boolean(atPath(lastPage.page, (lastPage.card ?? poolCard).page.cursor)) : false;
    if (dated.length > 0 && Math.min(...dated) >= ask.period.startMs && more) {
      notes.push(`لم نصل إلى بداية الفترة المطلوبة (من ${toArabicDigits(ask.period.from)} إلى ${toArabicDigits(ask.period.to)}): قرأنا ${postsCountAr(readAll.length)} من المصدر تغطي من ${cairoMomentAr(Math.min(...dated))} إلى ${cairoMomentAr(Math.max(...dated))} بتوقيت القاهرة، ولا نستطيع قراءة منشورات أقدم منها قبل الاعتماد؛ فقد يكون في الفترة منشورات أخرى لم نقرأها.`);
    }
  }
  const unmet = chosen.filter((r) => { const f = factsOf(r, ask, bySource); return !f.country || !f.language || !f.named; }).length;
  if (unmet > 0) notes.push(`لم نجد في ما قرأناه ما يكفي مما يطابق المصدر أو الدولة أو اللغة المطلوبة؛ ${toArabicDigits(unmet)} من العناصر المختارة لا تطابق ذلك، وعليها علامة في الملف.`);
  // ROUND 16: the card says how many of the selected items match the conditions the customer named (a source, a country, a language) and how many are alternatives marked in the file, counted on the rows read at planning (a mark, never a drop)
  if ((ask.source.kind === "named" || ask.country !== null || ask.language !== null) && chosen.length > 0) notes.push(matchCountsLineAr(chosen.length, unmet));
  // THE TOPIC, SAID HONESTLY BEFORE APPROVAL (live D1): «عن X» means the item's own text talks about X. A video whose caption names X only in its hashtags is made WITH X (the tool), so it ranks below the videos whose caption body is about X;
  // when the pool read has none of the latter the card says so; when some chosen items are below it, it says how many. Ranking only: the items are chosen and delivered either way.
  // (nothing chosen: a continuation past a delivered sample says so in its own sentences, never «what we chose»)
  if (ask.topic.text && ask.topic.relation !== "made_with" && chosen.length > 0) {
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
  // PR-1.3 (flag on only): a REPORT language the customer asked for is not a filter of the data, and the file and its summary stay in Arabic: said before approval, never silently ignored
  if (ask.reportLanguage === "en") notes.push("لغة التقرير: طلبت التقرير بالإنجليزية، وملف النتائج وملخصه بالعربية حاليًا؛ لم نُصفِّ المحتوى حسب لغته بسبب ذلك.");

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
    // ROUND 19 (live Facebook 4 Nov 2026: counters 9 and 6, ١٠ asked per post, the card promised ٢٢ = 2 + 10 + 10): with a number per parent the promise is the sum of min(the number asked, the parent's own counter) (`perParentPromise`, 9 + 6 = 15, so 2 + 15 = 17); only an OPEN stage (no counter before reading) is sized by the number asked for every parent
    const planned = perParent !== null && p.type !== "counter" ? perParent * chosen.length : p.n;
    stages.push({
      key: "comments", title_ar: "التعليقات", endpoint_id: commentsCard.endpointId, ...(capabilityOf(commentsCard.endpointId) ? { capability: capabilityOf(commentsCard.endpointId)! } : {}),
      expected_rows: planned, planned_rows: planned, parent_key: parentKey, ...(openAllowance !== null ? { per_parent_rows: openAllowance, children_cap_per_parent: openAllowance } : perParent !== null ? { per_parent_rows: perParent } : cap !== null ? { per_parent_rows: Math.ceil(p.n / chosen.length) } : {}), deliver: true,
      // THE REPLY TOKENS stay on the stored comment row (the replies stage binds to them): live round 10, the comments stage dropped them and the replies stage made no call
      ...(shape.includes("replies") && repliesCard && commentsCard.mapping.kind === "replies" && (commentsCard.mapping.tokens ?? []).length > 0 ? { carry_keys: (commentsCard.mapping.tokens ?? []).map((t) => t.key) } : {}),
      ...(commentsCard.mapping.kind === "replies" && commentsCard.mapping.relativeDates === true ? { relative_dates: true } : {}),
      columns: CHILD_COLUMNS.map((c) => ({ ...c })), sample_rows: (exposurePages[0]?.rows ?? []).slice(0, 3), measured_by: exposurePages.map((e) => e.callId).filter((x): x is string => x !== null),
      // DECISION A: the quote is the main tool's cost per row, or the dearest compatible alternative's when that costs more than twice as much per expected row (alternatives.ts)
      measured_from_calls: exposurePages.map((e) => e.callId).filter((x): x is string => x !== null), measured_cost_per_row_usd: quoteCostPerRowOf(commentsCard, alternatives?.alternatives ?? []),
      yield_share: 1, review_share: 0, parent_pins: chosen.map((r) => r.id), ...(ask.comments === "all" && perParent === null ? { all_children: true } : {}), ...(p.type === "open" ? { children_open: true, ...(perParent !== null && openAllowance === null ? { per_parent_asked: true } : {}) } : {}),
      ...(commentsMaxPages(commentsCard) !== null ? { max_pages: commentsMaxPages(commentsCard)! } : {}),
      engine: { endpoint_id: commentsCard.endpointId, params: structuredClone(commentsCard.inputs.fixed ?? {}), cursor_param: commentsCard.inputs.cursor, map_code: cardMapCode(commentsCard), map_file_id: "page", parent_binding: { param: commentsCard.inputs.parent!.param, from: commentsCard.inputs.parent!.from }, built_by: "code", ...((alternatives?.alternatives ?? []).length > 0 ? { alternatives: alternatives!.alternatives.map((a) => ({ ...a.entry, params: { ...a.entry.params } })) } : {}) },
    } as PricedStage);
    notes.push(promiseLineAr(p, "comments", card.counter?.counts === "comments_and_replies", perParent, openAllowance));
    // WHAT THE CARD SAYS ABOUT THE NEXT SOURCE (only when the stage really has one)
    if ((alternatives?.alternatives ?? []).length > 0) notes.push(ALTERNATIVE_LINE_AR);
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
      // THE CUSTOMER'S NUMBER FOR EACH TWEET («ردين على كل منشور», NOV 6 2026 CAMPAIGN): each tweet gives at most that many replies, and at most what its own counter says it has
      const perTweet = ask.edits.replies === undefined && ask.repliesPerTweet !== undefined ? Math.min(Math.max(1, Math.floor(ask.repliesPerTweet)), AGENT_REPLIES_PER_COMMENT_MAX) : null;
      const sizing = repliesSizing({ comments: chosen.length, known: counters, perComment: perTweet ?? AGENT_REPLIES_PER_COMMENT_MAX, countedAtCap: perTweet !== null });
      if (counters.every((c) => c !== null) && sizing.counted <= 0) {
        unserved.push({ what_ar: "الردود", reason_ar: "لا يذكر عدّاد المنصة ردودًا على أي من التغريدات المختارة، فلن تُضاف هذه الخطوة." });
      } else {
        const n = Math.max(1, Math.min(ask.edits.replies !== undefined ? Math.floor(ask.edits.replies) : sizing.total, maxPages * perPage));
        const p: StagePromise = { type: "open", n, counted: Math.min(sizing.counted, n), counted_comments: sizing.countedComments };
        promises.replies = p;
        const readAll = ask.edits.replies === undefined && perTweet === null;
        if (perTweet !== null) notes.push(`الردود: حتى ${toArabicDigits(perTweet)} من الردود على كل تغريدة مختارة بحسب العدد الذي طلبته، مما يعرضه المصدر، دون وعد بعدد قبل القراءة؛ والحد الأقصى المحسوب في الحجز ${toArabicDigits(n)} ردّ، ولا ندفع إلا مقابل ما سُلّم.`);
        stages.push({
          key: "replies", title_ar: "الردود", endpoint_id: repliesCard.endpointId, ...(capabilityOf(repliesCard.endpointId) ? { capability: capabilityOf(repliesCard.endpointId)! } : {}),
          expected_rows: n, planned_rows: n, parent_key: parentKey, replies_of: parentKey, per_parent_rows: perTweet ?? AGENT_REPLIES_PER_COMMENT_MAX, deliver: true,
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

  // THE REQUESTED STEP IS CARRIED OR SAID (NOV 6 2026 CAMPAIGN): a request for replies whose plan has no replies stage always says so before approval; the final contract gate of the old planner is not on this path, so the compiler holds it
  if (shape.includes("replies") && !stages.some((x) => x.replies_of !== undefined) && !unserved.some((u) => /الردود/.test(u.what_ar))) {
    unserved.push({ what_ar: "الردود", reason_ar: "لم نجد مصدرًا موثّقًا نقرأ منه هذه الردود، فلن تُضاف هذه الخطوة ولن تُحسب في السعر." });
  }
  const price = priceMissionByCode(stagePriceInputs(stages), { settings: input.pricingSettings });
  const plan: PricedPlan = {
    summary_ar: summaryAr(ask, parentRows, shape.filter((s) => s !== "replies" || stages.some((x) => x.replies_of !== undefined)), perParent, input.reelsProven === true),
    ...(notes.length > 0 ? { notes_ar: notes } : {}),
    ...(ask.count === null ? { assumptions_ar: [`لم تحدد عددًا، فاخترنا ${toArabicDigits(DEFAULT_COUNT)}؛ يمكنك تعديله قبل الموافقة.`] } : {}),
    stages,
    price,
    ...(unserved.length > 0 ? { unserved_steps: unserved } : {}),
    // P0 (15 Nov 2026): a parent-only plan the source could not fill keeps the customer's own number, so a delivery of what exists is told and shown as PARTIAL against the request, never as complete
    ...(parentOnly && !sizedByRequest && ask.count !== null && chosen.length < need ? { quantity: { requested: need, stage_key: parentKey, target: chosen.length, reason_ar: input.poolExhausted === true ? "نتائج المصدر لهذا البحث انتهت عند هذا العدد مما يطابق طلبك" : "ما وجدناه مما يطابق طلبك كان هذا العدد", source: "request" as const } } : {}),
    compiled: { by: "compiler", platform: ask.platform, promises: Object.fromEntries(Object.entries(promises).map(([k, v]) => [k, { ...v }])), conditions: { named: ask.source.kind === "named", period: Boolean(ask.period), language: Boolean(ask.language), country: Boolean(ask.country), topic: Boolean(ask.topic.text) }, ...(ask.source.kind === "named" && ask.source.text ? { source_text: ask.source.text } : {}), ...(periodGatedFor(ask, poolCard) ? { period_gate: true } : {}) },
  };
  return { ok: true, plan, promises, chosen: chosen.map((r) => r.id), spares: spares.map((r) => r.id) };
}
