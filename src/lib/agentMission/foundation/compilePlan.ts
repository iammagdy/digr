import { AGENT_REPLIES_PER_COMMENT_MAX } from "../constants";
import { operatorStampUtc } from "../cairoTime";
import { toArabicDigits } from "../../arabicDigits";
import { priceMissionByCode } from "../price";
import { stagePriceInputs, type PricedPlan, type PricedStage } from "../plan";
import type { StageFilter } from "../filters";
import type { MissionPricingSettings } from "../../missionPricing";
import type { Ask } from "./ask";
import { rankPool, factsOf, type PoolRow } from "./pool";
import { childPromise, promiseLineAr, type StagePromise } from "./promise";
import { cardMapCode, cardsFor, CHILD_COLUMNS, COUNTRY_AR, mapPage, type CardRole, type ToolCard } from "./toolCards";
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
  replies: () => "comment.replies",
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
}

export type CompileResult =
  | { ok: true; plan: PricedPlan; promises: Record<string, StagePromise>; chosen: string[]; spares: string[] }
  | { ok: false; reason: "no_platform_card" | "no_parent_card" | "no_rows" | "no_parent_with_children" };

const TITLE: Record<string, string> = {
  text: "النص", author: "صاحب الحساب", username: "اسم المستخدم", posted_at: "تاريخ ووقت النشر", link: "الرابط", country: "الدولة", language: "اللغة", likes: "الإعجابات",
  comments: "عدد التعليقات", shares: "المشاركات", views: "المشاهدات", saves: "الحفظ", followers: "المتابعون", is_reply: "رد على تغريدة", replies_count: "عدد الردود",
};
const NOUN: Record<SocialPlatform, { one: string; two: string; many: string; where: string }> = {
  tiktok: { one: "فيديو", two: "فيديوهان", many: "فيديو", where: "من تيك توك" },
  x: { one: "تغريدة", two: "تغريدتان", many: "تغريدة", where: "من إكس" },
  instagram: { one: "منشور", two: "منشوران", many: "منشور", where: "من إنستجرام" },
  facebook: { one: "منشور", two: "منشوران", many: "منشور", where: "من فيسبوك" },
  youtube: { one: "فيديو", two: "فيديوهان", many: "فيديو", where: "من يوتيوب" },
};
const DEFAULT_COUNT = 10;
/** The least share of replies a comment is assumed to have when the exposure pages show none: it sizes the reserve's maximum only, never a promise. */
const OPEN_REPLIES_FLOOR = 0.1;

/** The customer's one sentence for a compiled plan (Arabic, Arabic-Indic digits, no provider, no price). */
export function summaryAr(ask: Ask, n: number, shape: ReadonlyArray<StageRole>): string {
  const w = NOUN[ask.platform!];
  const count = n === 1 ? w.one : n === 2 ? w.two : `${toArabicDigits(n)} ${w.many}`;
  const parts = [count, w.where];
  if (ask.topic.text) parts.push(`عن «${ask.topic.text}»`);
  if (ask.country) parts.push(`من ${COUNTRY_AR[ask.country] ?? ask.country}`);
  if (ask.language === "ar") parts.push("بالعربية");
  if (ask.period) parts.push(`بين ${toArabicDigits(ask.period.from)} و${toArabicDigits(ask.period.to)}`);
  const children = shape.includes("comments") ? (shape.includes("replies") ? "، مع كل تعليقاتها وردودها" : "، مع تعليقاتها") : "";
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
  const repliesCard = shape.includes("replies") ? chooseCard(ask, "replies") : null;
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
  const columns = Object.keys(card.mapping.kind === "fields" ? card.mapping.fields : {}).filter((k) => k !== "id").map((k) => ({ key: k, title_ar: TITLE[k] ?? k }));
  const pageRows = Math.max(1, card.page.observedRowsPerPage);
  promises[parentKey] = { type: "exact", n: chosen.length };
  stages.push({
    key: parentKey, title_ar: ask.platform === "x" ? "التغريدات" : "الفيديوهات", endpoint_id: card.endpointId, ...(capabilityOf(card.endpointId) ? { capability: capabilityOf(card.endpointId)! } : {}),
    expected_rows: chosen.length, planned_rows: chosen.length, parent_key: null, deliver: true, columns, sample_rows: chosen.slice(0, 3).map((r) => ({ ...r })),
    measured_by: input.pool.pages.map((p) => p.callId), measured_from_calls: input.pool.pages.map((p) => p.callId), measured_cost_per_row_usd: card.costUsdPerPage / pageRows,
    yield_share: 1, review_share: 0, pinned_rows: chosen.map((r) => ({ ...r })), ...(spares.length > 0 && commentsCard ? { spare_rows: spares.map((r) => ({ ...r })) } : {}),
    ...(filtersOf(ask).length > 0 ? { filters: filtersOf(ask) } : {}),
    ...(ask.order === "most_commented" && commentsCard ? { chosen_most_engaged: true } : {}),
    engine: { endpoint_id: card.endpointId, params: input.pool.params, cursor_param: card.inputs.cursor, map_code: cardMapCode(card), map_file_id: "page", parent_binding: null, built_by: "code", ...(card.cannot && card.cannot.length > 0 ? { gaps: card.cannot.filter((c) => (c === "language" && ask.language) || (c === "period" && ask.period) || (c === "country" && ask.country)).map((c) => ({ cls: c === "period" ? "date" : c, reason: "no_field" })) } : {}) },
  } as PricedStage);
  if (chosen.length < need) notes.push(`وجدنا في ما قرأناه ${toArabicDigits(chosen.length)} فقط تناسب طلبك من ${toArabicDigits(need)}.`);
  const unmet = chosen.filter((r) => { const f = factsOf(r, ask); return !f.country || !f.language || !f.named; }).length;
  if (unmet > 0) notes.push(`لم نجد في ما قرأناه ما يكفي مما يطابق المصدر أو الدولة أو اللغة المطلوبة؛ ${toArabicDigits(unmet)} من العناصر المختارة لا تطابق ذلك، وعليها علامة في الملف.`);
  if (ask.language && card.cannot?.includes("language")) notes.push("اللغة: اخترنا من بين النتائج ما كتب باللغة المطلوبة، وفي الملف عمود للغة كل صف.");

  if (commentsCard) {
    const cap = ask.edits.comments ?? null;
    const counters = chosen.map((r) => counter(r));
    const exposureComments = exposurePages.reduce((s, e) => s + e.rows.length, 0);
    const p = childPromise(card.counter ? counters : [], cap, Math.max(1, exposureComments));
    promises.comments = p;
    stages.push({
      key: "comments", title_ar: "التعليقات", endpoint_id: commentsCard.endpointId, ...(capabilityOf(commentsCard.endpointId) ? { capability: capabilityOf(commentsCard.endpointId)! } : {}),
      expected_rows: p.n, planned_rows: p.n, parent_key: parentKey, ...(cap !== null ? { per_parent_rows: Math.ceil(p.n / chosen.length) } : {}), deliver: true,
      columns: CHILD_COLUMNS.map((c) => ({ ...c })), sample_rows: (exposurePages[0]?.rows ?? []).slice(0, 3), measured_by: exposurePages.map((e) => e.callId).filter((x): x is string => x !== null),
      measured_from_calls: exposurePages.map((e) => e.callId).filter((x): x is string => x !== null), measured_cost_per_row_usd: commentsCard.costUsdPerPage / Math.max(1, commentsCard.page.observedRowsPerPage),
      yield_share: 1, review_share: 0, parent_pins: chosen.map((r) => r.id), ...(ask.comments === "all" ? { all_children: true } : {}), ...(p.type === "open" ? { children_open: true } : {}),
      engine: { endpoint_id: commentsCard.endpointId, params: {}, cursor_param: commentsCard.inputs.cursor, map_code: cardMapCode(commentsCard), map_file_id: "page", parent_binding: { param: commentsCard.inputs.parent!.param, from: commentsCard.inputs.parent!.from }, built_by: "code" },
    } as PricedStage);
    notes.push(promiseLineAr(p, "comments", card.counter?.counts === "comments_and_replies"));
  }

  if (shape.includes("replies")) {
    if (repliesCard && commentsCard) {
      const seen = exposurePages.flatMap((e) => e.rows);
      const withCounter = seen.map((r) => Number(r.replies_count)).filter((n) => Number.isFinite(n));
      const ratio = withCounter.length > 0 ? withCounter.reduce((s, n) => s + n, 0) / withCounter.length : 0;
      const openMax = Math.ceil(promises.comments.n * Math.max(ratio, OPEN_REPLIES_FLOOR));
      const p: StagePromise = { type: "open", n: Math.max(1, Math.floor(ask.edits.replies ?? openMax)) };
      promises.comments_replies = p;
      stages.push({
        key: "comments_replies", title_ar: "الردود", endpoint_id: repliesCard.endpointId, ...(capabilityOf(repliesCard.endpointId) ? { capability: capabilityOf(repliesCard.endpointId)! } : {}),
        expected_rows: p.n, planned_rows: p.n, parent_key: "comments", replies_of: "comments", per_parent_rows: AGENT_REPLIES_PER_COMMENT_MAX, deliver: true,
        columns: CHILD_COLUMNS.map((c) => ({ ...c })), sample_rows: [], measured_by: [], measured_from_calls: [], measured_cost_per_row_usd: repliesCard.costUsdPerPage / Math.max(1, repliesCard.page.observedRowsPerPage),
        yield_share: 1, review_share: 0, replies_open: true, ...(ask.replies === "all" ? { replies_read_all: true } : {}), replies_call_usd: repliesCard.costUsdPerPage,
        engine: { endpoint_id: repliesCard.endpointId, params: {}, cursor_param: repliesCard.inputs.cursor, map_code: cardMapCode(repliesCard), map_file_id: "page", parent_binding: { param: repliesCard.inputs.parent!.param, from: repliesCard.inputs.parent!.from, ...(repliesCard.inputs.parent!.also ? { also: repliesCard.inputs.parent!.also.map((a) => ({ ...a })) } : {}) }, built_by: "code" },
      } as PricedStage);
      notes.push(promiseLineAr(p, "replies", false));
    } else {
      // F6: no verified card reads the replies on this platform: the step is NOT included, said before approval (never a model recipe, never the old pipeline)
      unserved.push({ what_ar: "الردود", reason_ar: "لا توجد بعد أداة موثّقة لقراءة الردود على هذه المنصة، فلن تُضاف هذه الخطوة." });
    }
  }

  const price = priceMissionByCode(stagePriceInputs(stages), { settings: input.pricingSettings });
  const plan: PricedPlan = {
    summary_ar: summaryAr(ask, chosen.length, shape.filter((s) => s !== "replies" || stages.some((x) => x.replies_of !== undefined))),
    ...(notes.length > 0 ? { notes_ar: notes } : {}),
    ...(ask.count === null ? { assumptions_ar: [`لم تحدد عددًا، فاخترنا ${toArabicDigits(DEFAULT_COUNT)}؛ يمكنك تعديله قبل الموافقة.`] } : {}),
    stages,
    price,
    ...(unserved.length > 0 ? { unserved_steps: unserved } : {}),
    compiled: { by: "compiler", platform: ask.platform, promises: Object.fromEntries(Object.entries(promises).map(([k, v]) => [k, { ...v }])) },
  };
  return { ok: true, plan, promises, chosen: chosen.map((r) => r.id), spares: spares.map((r) => r.id) };
}
