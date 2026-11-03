import { AGENT_REPLIES_PER_COMMENT_MAX } from "../constants";
import { operatorStampUtc } from "../cairoTime";
import { toArabicDigits } from "../../arabicDigits";
import { priceMissionByCode } from "../price";
import { stagePriceInputs, type PricedPlan, type PricedStage } from "../plan";
import type { StageFilter } from "../filters";
import type { MissionPricingSettings } from "../../missionPricing";
import type { Ask } from "./ask";
import { rankPool, factsOf, type PoolRow } from "./pool";
import { childPromise, perParentPromise, promiseLineAr, type StagePromise } from "./promise";
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
export const COMPILED_PLATFORMS: ReadonlyArray<SocialPlatform> = ["tiktok", "x"];
export type StageRole = "parents" | "comments" | "replies";

/** The stages the Ask asks for, in order (from the Ask alone: no model, no catalog). */
export function stageShapeOf(ask: Pick<Ask, "comments" | "replies" | "platform">): StageRole[] {
  const shape: StageRole[] = ["parents"];
  if (ask.comments !== "none") shape.push("comments");
  if (ask.replies !== "none") shape.push("replies");
  return shape;
}

const PARENT_ROLE: Partial<Record<SocialPlatform, CardRole>> = { tiktok: "videos.search", x: "tweets.search" };
const ROLE_OF: Record<StageRole, (p: SocialPlatform) => CardRole | null> = {
  parents: (p) => PARENT_ROLE[p] ?? null,
  comments: (p) => (p === "x" ? null : "video.comments"),
  replies: (p) => (p === "x" ? "tweet.replies" : "comment.replies"),
};

/** What the Ask asks that a parent card can carry in an input, and which of them this card carries. */
export function carriedBy(card: ToolCard, ask: Ask): { asked: string[]; carried: string[] } {
  const asked: string[] = [];
  const carried: string[] = [];
  const add = (what: string, ok: boolean) => { asked.push(what); if (ok) carried.push(what); };
  if (ask.topic.text) add("topic", Boolean(card.inputs.query));
  if (ask.country) add("country", Boolean(card.inputs.country));
  if (ask.language) add("language", Boolean(card.inputs.query?.operators));
  if (ask.period) add("period", Boolean(card.inputs.query?.operators));
  add("order", Boolean(card.inputs.order && card.inputs.order[ask.order] !== undefined));
  return { asked, carried };
}

/** The card of a stage role: most conditions carried, then pageable, then a counter, then the cheapest page. Null: no usable card (the stage is not included). */
export function chooseCard(ask: Ask, role: StageRole, options: { cards?: ReadonlyArray<ToolCard>; catalogOnly?: boolean } = {}): ToolCard | null {
  if (!ask.platform) return null;
  const r = ROLE_OF[role](ask.platform);
  if (!r) return null;
  const cards = cardsFor(ask.platform, r, options);
  const score = (c: ToolCard): number[] => [role === "parents" ? carriedBy(c, ask).carried.length : 0, c.inputs.cursor ? 1 : 0, c.counter ? 1 : 0, -c.costUsdPerPage];
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
    p[q.field] = query;
  }
  if (card.inputs.country && ask.country) p[card.inputs.country.field] = ask.country;
  const order = card.inputs.order?.[ask.order];
  if (card.inputs.order && order !== undefined) p[card.inputs.order.field] = order;
  if (card.inputs.pageSize) p[card.inputs.pageSize.field] = card.inputs.pageSize.value;
  return p;
}

export interface CompileInput {
  ask: Ask;
  /** The parent card's pages read at planning, in order (their call ids and bodies). */
  pool: { card: ToolCard; params: Record<string, unknown>; pages: ReadonlyArray<{ callId: string; page: unknown }> };
  /** The exposure check (decision 7.3): the first comments page of a parent, read before the card (undefined: not read). */
  exposure: (parentId: string) => { callId: string | null; page: unknown | null; failed: boolean } | undefined;
  capabilityOf: (endpointId: string) => string | null;
  pricingSettings?: MissionPricingSettings;
  /** Owner decision 7.4: a `catalog_only` card may build a stage, for a TEST account only (the caller says so); never for another account. */
  catalogOnly?: boolean;
}

export type CompileResult =
  | { ok: true; plan: PricedPlan; promises: Record<string, StagePromise>; chosen: string[]; spares: string[] }
  | { ok: false; reason: "no_platform_card" | "no_parent_card" | "no_rows" | "no_parent_with_children" };

const TITLE: Record<string, string> = {
  text: "النص", author: "صاحب الحساب", username: "اسم المستخدم", posted_at: "تاريخ ووقت النشر", link: "الرابط", country: "الدولة", language: "اللغة", likes: "الإعجابات",
  comments: "عدد التعليقات", shares: "المشاركات", views: "المشاهدات", saves: "الحفظ", followers: "المتابعون", is_reply: "رد على تغريدة", replies_count: "عدد الردود",
};
const NOUN: Record<SocialPlatform, { one: string; two: string; many: string; where: string; talks: string }> = {
  tiktok: { one: "فيديو", two: "فيديوهان", many: "فيديو", where: "من تيك توك", talks: "يتحدث نصه" },
  x: { one: "تغريدة", two: "تغريدتان", many: "تغريدة", where: "من إكس", talks: "يتحدث نصها" },
  instagram: { one: "منشور", two: "منشوران", many: "منشور", where: "من إنستجرام", talks: "يتحدث نصه" },
  facebook: { one: "منشور", two: "منشوران", many: "منشور", where: "من فيسبوك", talks: "يتحدث نصه" },
  youtube: { one: "فيديو", two: "فيديوهان", many: "فيديو", where: "من يوتيوب", talks: "يتحدث نصه" },
};
const DEFAULT_COUNT = 10;
/** The least share of replies a comment is assumed to have when the exposure pages show none: it sizes the reserve's maximum only, never a promise. */
const OPEN_REPLIES_FLOOR = 0.1;

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

/** Compiles the plan. Pure: the same Ask and the same pages give the same plan. */
export function compilePlan(input: CompileInput): CompileResult {
  const { ask } = input;
  if (!ask.platform || !(COMPILED_PLATFORMS as ReadonlyArray<string>).includes(ask.platform)) return { ok: false, reason: "no_platform_card" };
  const shape = stageShapeOf(ask);
  const card = input.pool.card;
  const mapped = input.pool.pages.flatMap((p) => mapPage(card, p.page));
  const ranked = rankPool(mapped, ask, card);
  if (ranked.length === 0) return { ok: false, reason: "no_rows" };
  const need = Math.max(1, ask.count ?? DEFAULT_COUNT);
  const commentsCard = shape.includes("comments") ? chooseCard(ask, "comments") : null;
  const repliesCard = shape.includes("replies") ? chooseCard(ask, "replies", { catalogOnly: input.catalogOnly === true }) : null;
  const counter = (r: PoolRow): number | null => { if (!card.counter) return null; const n = Number(r[card.counter.key]); return Number.isFinite(n) ? n : null; };

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
  const spares = ranked.slice(scanned).filter((r) => !commentsCard || counter(r) !== 0).slice(0, 2);

  const promises: Record<string, StagePromise> = {};
  const notes: string[] = [];
  const unserved: Array<{ what_ar: string; reason_ar: string }> = [];
  const capabilityOf = input.capabilityOf;
  const stages: PricedStage[] = [];
  const parentKey = ask.platform === "x" ? "tweets" : "videos";
  // THE TOPIC RELATION MARK (live round 7): when some chosen item's own text is not about the topic the customer named («عن X»), every item of the stage carries how its text relates to it, so the file says which is which (a mark, never a drop)
  const tierOf = (r: PoolRow) => factsOf(r, ask).topicTier;
  const markTopic = ask.platform !== "x" && Boolean(ask.topic.text) && ask.topic.relation !== "made_with" && chosen.some((r) => tierOf(r) !== 2);
  const shown = (r: PoolRow): PoolRow => (markTopic ? { ...r, [TOPIC_RELATION_KEY]: topicRelationAr(tierOf(r)) } : { ...r });
  const columns = [...Object.keys(card.mapping.kind === "fields" ? card.mapping.fields : {}).filter((k) => k !== "id").map((k) => ({ key: k, title_ar: TITLE[k] ?? k })), ...(markTopic ? [{ key: TOPIC_RELATION_KEY, title_ar: TOPIC_RELATION_TITLE_AR }] : [])];
  const pageRows = Math.max(1, card.page.observedRowsPerPage);
  promises[parentKey] = { type: "exact", n: chosen.length };
  stages.push({
    key: parentKey, title_ar: ask.platform === "x" ? "التغريدات" : "الفيديوهات", endpoint_id: card.endpointId, ...(capabilityOf(card.endpointId) ? { capability: capabilityOf(card.endpointId)! } : {}),
    expected_rows: chosen.length, planned_rows: chosen.length, parent_key: null, deliver: true, columns, sample_rows: chosen.slice(0, 3).map(shown),
    measured_by: input.pool.pages.map((p) => p.callId), measured_from_calls: input.pool.pages.map((p) => p.callId), measured_cost_per_row_usd: card.costUsdPerPage / pageRows,
    yield_share: 1, review_share: 0, pinned_rows: chosen.map(shown), ...(spares.length > 0 && commentsCard ? { spare_rows: spares.map(shown) } : {}),
    ...(filtersOf(ask).length > 0 ? { filters: filtersOf(ask) } : {}),
    ...(ask.order === "most_commented" && commentsCard ? { chosen_most_engaged: true } : {}),
    engine: { endpoint_id: card.endpointId, params: input.pool.params, cursor_param: card.inputs.cursor, map_code: cardMapCode(card), map_file_id: "page", parent_binding: null, built_by: "code", ...(card.cannot && card.cannot.length > 0 ? { gaps: card.cannot.filter((c) => (c === "language" && ask.language) || (c === "period" && ask.period) || (c === "country" && ask.country)).map((c) => ({ cls: c === "period" ? "date" : c, reason: "no_field" })) } : {}) },
  } as PricedStage);
  if (chosen.length < need) notes.push(`وجدنا في ما قرأناه ${toArabicDigits(chosen.length)} فقط تناسب طلبك من ${toArabicDigits(need)}.`);
  const unmet = chosen.filter((r) => { const f = factsOf(r, ask); return !f.country || !f.language || !f.named; }).length;
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
    const p = perParent !== null ? perParentPromise(card.counter ? counters : [], perParent, chosen.length) : childPromise(card.counter ? counters : [], cap, Math.max(1, exposureComments));
    promises.comments = p;
    // the rows the stage may read: the number per parent for every parent (a parent with fewer gives what it has), else the promise
    const planned = perParent !== null ? perParent * chosen.length : p.n;
    stages.push({
      key: "comments", title_ar: "التعليقات", endpoint_id: commentsCard.endpointId, ...(capabilityOf(commentsCard.endpointId) ? { capability: capabilityOf(commentsCard.endpointId)! } : {}),
      expected_rows: planned, planned_rows: planned, parent_key: parentKey, ...(perParent !== null ? { per_parent_rows: perParent } : cap !== null ? { per_parent_rows: Math.ceil(p.n / chosen.length) } : {}), deliver: true,
      columns: CHILD_COLUMNS.map((c) => ({ ...c })), sample_rows: (exposurePages[0]?.rows ?? []).slice(0, 3), measured_by: exposurePages.map((e) => e.callId).filter((x): x is string => x !== null),
      measured_from_calls: exposurePages.map((e) => e.callId).filter((x): x is string => x !== null), measured_cost_per_row_usd: commentsCard.costUsdPerPage / Math.max(1, commentsCard.page.observedRowsPerPage),
      yield_share: 1, review_share: 0, parent_pins: chosen.map((r) => r.id), ...(ask.comments === "all" && perParent === null ? { all_children: true } : {}), ...(p.type === "open" ? { children_open: true } : {}),
      engine: { endpoint_id: commentsCard.endpointId, params: {}, cursor_param: commentsCard.inputs.cursor, map_code: cardMapCode(commentsCard), map_file_id: "page", parent_binding: { param: commentsCard.inputs.parent!.param, from: commentsCard.inputs.parent!.from }, built_by: "code" },
    } as PricedStage);
    notes.push(promiseLineAr(p, "comments", card.counter?.counts === "comments_and_replies", perParent));
  }

  if (shape.includes("replies")) {
    if (repliesCard && commentsCard) {
      const seen = exposurePages.flatMap((e) => e.rows);
      const perComment = ask.edits.replies === undefined && ask.repliesPerComment !== null ? Math.min(ask.repliesPerComment, AGENT_REPLIES_PER_COMMENT_MAX) : null;
      const commentsRows = stages.find((x) => x.key === "comments")!.planned_rows;
      // THE REAL COUNTERS of the comments read at planning count as they are; the cap of 50 sizes the hold for the comments not read yet (live finding C)
      const sizing = repliesSizing({ comments: commentsRows, known: seen.map((r) => Number(r.replies_count)), perComment: perComment ?? AGENT_REPLIES_PER_COMMENT_MAX, countedAtCap: perComment !== null });
      // REPLIES ASKED WITH NO NUMBER PER COMMENT: every reply the source shows is read for each chosen comment (the engine reads past the cap; the cap sizes the reserve only)
      const readAll = perComment === null && ask.edits.replies === undefined;
      const p: StagePromise = ask.edits.replies !== undefined ? { type: "open", n: Math.max(1, Math.floor(ask.edits.replies)) } : { type: "open", n: sizing.total, counted: sizing.counted, counted_comments: sizing.countedComments };
      promises.comments_replies = p;
      stages.push({
        key: "comments_replies", title_ar: "الردود", endpoint_id: repliesCard.endpointId, ...(capabilityOf(repliesCard.endpointId) ? { capability: capabilityOf(repliesCard.endpointId)! } : {}),
        expected_rows: p.n, planned_rows: p.n, parent_key: "comments", replies_of: "comments", per_parent_rows: perComment ?? AGENT_REPLIES_PER_COMMENT_MAX, deliver: true,
        columns: CHILD_COLUMNS.map((c) => ({ ...c })), sample_rows: [], measured_by: [], measured_from_calls: [], measured_cost_per_row_usd: repliesCard.costUsdPerPage / Math.max(1, repliesCard.page.observedRowsPerPage),
        yield_share: 1, review_share: 0, replies_open: true, ...(ask.replies === "all" ? { replies_read_all: true } : {}), ...(readAll ? { replies_uncapped: true } : {}), replies_call_usd: repliesCard.costUsdPerPage,
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
