import { AGENT_MAX_DELIVERED_ROWS, AGENT_REPLIES_PER_COMMENT_MAX } from "../constants";
import { cairoDayEndExclusiveMs, cairoDayOf, cairoDayStartMs } from "../cairoTime";
import { countAr, knownItemNoun } from "../itemNoun";
import { toArabicDigits } from "../../arabicDigits";
import { pointsAr } from "../../pointsFormat";
import type { Ask } from "../foundation/ask";
import { compilePlan, type CompileInput, type CompileResult } from "../foundation/compilePlan";
import { fitToBudget } from "../foundation/budgetFit";
import { PARENT_WORD_AR } from "../foundation/countChoice";
import { COUNTRY_AR, type ToolCard } from "../foundation/toolCards";

/**
 * STAGE 2, THE «فهمنا طلبك» CARD (docs/STAGE-2.md, FOUNDATION-PLAN PR 4). The Ask the compiler reads (F1) shown to the customer BEFORE approval as typed fields, each with its Arabic label
 * and value; the fields the customer may edit; an edit CHECKED BY CODE (a refusal is a reason code from a fixed list, with one fixed Arabic sentence, never free text); and the plan
 * RECOMPILED BY CODE from the edited Ask with the same compiler and the same pages already read (no model, no new read, no new cost). An edit that changes what must be READ (the topic,
 * the period, the source, the country, the language, or the order of a tool that takes an order) is not compiled from the old pages: the edited Ask is returned for a new planning.
 *
 * Pure: no I/O, no model, no money. The price shown after an edit is the compiler's own price function (`priceMissionByCode` inside `compilePlan`); a budget is a hard ceiling on the hold
 * through the same `fitToBudget` the planning uses. Not wired to any screen or route in this branch: the flag `DIGER_STAGE2_ASK_CARD` (flags.ts) gates the wiring.
 */

export type AskFieldKey = "platform" | "count" | "topic" | "source" | "period" | "country" | "language" | "order" | "comments" | "commentsPerParent" | "replies" | "repliesPerComment" | "budget";
export const ASK_FIELD_ORDER: ReadonlyArray<AskFieldKey> = ["platform", "count", "topic", "source", "period", "country", "language", "order", "comments", "commentsPerParent", "replies", "repliesPerComment", "budget"];
/** The fields the customer may edit on the card. The platform is not one of them: a different platform is a different request (cancel and ask again). */
export const ASK_EDITABLE_FIELDS: ReadonlyArray<Exclude<AskFieldKey, "platform">> = ["count", "topic", "source", "period", "country", "language", "order", "comments", "commentsPerParent", "replies", "repliesPerComment", "budget"];

export type ChoiceOption = { value: string; labelAr: string };
export type AskFieldInput =
  | { kind: "number"; min: number; max: number }
  | { kind: "choice"; options: ChoiceOption[] }
  | { kind: "period" }
  | { kind: "text"; maxChars: number }
  | { kind: "none" };
export type EditScope = "recompile" | "new_read";

export interface AskCardField {
  key: AskFieldKey;
  labelAr: string;
  /** What the card shows. Code's own words follow the customer-text rules; the customer's own words (`customerWords`) are shown as they typed them. */
  valueAr: string;
  customerWords: boolean;
  editable: boolean;
  input: AskFieldInput;
  /** What an edit of this field needs: a recompile from the pages already read, or a new read (a new planning). */
  scope: EditScope;
}
export interface AskCardView { v: 1; titleAr: "فهمنا طلبك"; fields: AskCardField[] }

/** One edit of one field. Values are the Ask's own: numbers as numbers, Cairo days as YYYY-MM-DD, a country as its ISO code; null clears a field where clearing means something. */
export type AskEdit =
  | { field: "count"; value: number }
  | { field: "topic"; value: string }
  | { field: "source"; value: string | null }
  | { field: "period"; value: { from: string; to: string } | null }
  | { field: "country"; value: string | null }
  | { field: "language"; value: "ar" | "en" | null }
  | { field: "order"; value: "most_commented" | "newest" }
  | { field: "comments"; value: "none" | "some" | "all" }
  | { field: "commentsPerParent"; value: number }
  | { field: "replies"; value: "none" | "some" | "all" }
  | { field: "repliesPerComment"; value: number }
  | { field: "budget"; value: number | null };

/** Why an edit is refused: a fixed list of codes. The screen shows the fixed sentence of the code (ASK_EDIT_REJECTION_AR), never a text made at run time. */
export const ASK_EDIT_REJECTIONS = [
  "unknown_field", "field_locked", "not_whole_number", "out_of_range", "unknown_choice", "period_reversed", "period_in_future", "period_bad_day", "country_unknown", "topic_empty", "topic_too_long", "source_too_long",
  "comments_not_asked", "replies_not_asked", "not_offered", "budget_too_small", "cannot_compile",
] as const;
export type AskEditRejection = (typeof ASK_EDIT_REJECTIONS)[number];
export const ASK_EDIT_REJECTION_AR: Readonly<Record<AskEditRejection, string>> = {
  unknown_field: "لا يمكن تعديل هذا الجزء من الطلب.",
  field_locked: "لا يمكن تغيير المنصة من هنا. ألغِ الطلب واكتب طلبًا جديدًا للمنصة التي تريدها.",
  not_whole_number: "اكتب رقمًا صحيحًا بدون كسور.",
  out_of_range: "الرقم خارج الحدود المسموح بها لهذا الجزء من الطلب.",
  unknown_choice: "اختر واحدًا من الاختيارات المعروضة.",
  period_reversed: "بداية الفترة يجب أن تكون قبل نهايتها أو في يومها.",
  period_in_future: "نهاية الفترة لا يمكن أن تكون بعد اليوم بتوقيت القاهرة.",
  period_bad_day: "اكتب الأيام بصيغة سنة-شهر-يوم ليوم موجود في التقويم.",
  country_unknown: "هذه الدولة غير متاحة في الاختيارات. اختر دولة من القائمة.",
  topic_empty: "اكتب الموضوع الذي تريده.",
  topic_too_long: "الموضوع أطول من المسموح. اختصره في كلمات قليلة.",
  source_too_long: "اسم المصدر أطول من المسموح. اكتب الاسم أو الرابط فقط.",
  comments_not_asked: "طلبك بدون تعليقات. اختر التعليقات أولًا ثم حدد عددها.",
  replies_not_asked: "طلبك بدون ردود. اختر الردود أولًا ثم حدد عددها.",
  not_offered: "هذا الجزء غير متاح على هذه المنصة.",
  budget_too_small: "ميزانيتك لا تكفي لأصغر نسخة من هذا الطلب. زد الميزانية أو عدّل الطلب، ولم يُخصم شيء.",
  cannot_compile: "تعذّر تجهيز خطة بهذا التعديل من النتائج التي قرأناها. ارجع للقيمة السابقة أو عدّل جزءًا آخر، ولم يُخصم شيء.",
};

const PLATFORM_AR: Record<string, string> = { tiktok: "تيك توك", x: "إكس", facebook: "فيسبوك", instagram: "إنستغرام", youtube: "يوتيوب" };
const TOPIC_MAX_CHARS = 200;
const SOURCE_MAX_CHARS = 200;
const COMMENTS_PER_PARENT_MAX = 5000;
const BUDGET_MAX_POINTS = 10_000_000;
/** The count the compiler plans when the request gives none (compilePlan's DEFAULT_COUNT): the budget fit starts from it. */
const DEFAULT_COUNT = 10;

const ORDER_OPTIONS: ChoiceOption[] = [{ value: "most_commented", labelAr: "الأكثر تعليقًا" }, { value: "newest", labelAr: "الأحدث" }];
const COMMENTS_OPTIONS: ChoiceOption[] = [{ value: "none", labelAr: "بدون تعليقات" }, { value: "some", labelAr: "عدد محدد من التعليقات" }, { value: "all", labelAr: "كل التعليقات" }];
const REPLIES_OPTIONS: ChoiceOption[] = [{ value: "none", labelAr: "بدون ردود" }, { value: "some", labelAr: "عدد محدد من الردود" }, { value: "all", labelAr: "كل الردود" }];
const LANGUAGE_OPTIONS: ChoiceOption[] = [{ value: "ar", labelAr: "العربية" }, { value: "en", labelAr: "الإنجليزية" }, { value: "any", labelAr: "أي لغة" }];
const COUNTRY_OPTIONS: ChoiceOption[] = [...Object.entries(COUNTRY_AR).map(([value, labelAr]) => ({ value, labelAr })), { value: "any", labelAr: "أي دولة" }];

const noun = (word: string) => knownItemNoun(word);
const commentNoun = noun("تعليق")!;
const replyNoun = noun("رد")!;
const parentEach = (ask: Pick<Ask, "parentKind">): string => (ask.parentKind ? PARENT_WORD_AR[ask.parentKind]?.each ?? "عنصر" : "عنصر");

function sourceValue(ask: Ask): { valueAr: string; customerWords: boolean } {
  if (ask.source.kind === "named" && ask.source.text) return { valueAr: ask.source.text, customerWords: true };
  if (ask.source.kind === "official") return { valueAr: "القنوات الرسمية", customerWords: false };
  return { valueAr: "بدون مصدر محدد", customerWords: false };
}
function commentsValue(ask: Ask): string {
  if (ask.comments === "none") return "بدون تعليقات";
  if (ask.edits.comments !== undefined) return `${countAr(ask.edits.comments, commentNoun)} في المجموع`;
  if (ask.commentsPerParent !== null) return `${countAr(ask.commentsPerParent, commentNoun)} من كل ${parentEach(ask)}`;
  return ask.comments === "all" ? "كل التعليقات" : "عدد من التعليقات لم يُحدد بعد";
}
function repliesValue(ask: Ask): string {
  if (ask.replies === "none") return "بدون ردود";
  if (ask.edits.replies !== undefined) return `${countAr(ask.edits.replies, replyNoun)} في المجموع`;
  if (ask.repliesPerComment !== null) return `${countAr(ask.repliesPerComment, replyNoun)} على كل تعليق`;
  return ask.replies === "all" ? "كل الردود" : "عدد من الردود لم يُحدد بعد";
}

/** The card's fields, in a fixed order. `poolCard` (the parent tool already chosen) decides whether an order edit needs a new read; without it, it is said to need one. */
export function askCardView(ask: Ask, poolCard?: ToolCard): AskCardView {
  const src = sourceValue(ask);
  const commentsOn = ask.comments !== "none";
  const repliesOn = ask.replies !== "none";
  const scope = (_field: Exclude<AskFieldKey, "platform">, sample: AskEdit): EditScope => editScopeOf(sample, ask, poolCard);
  const fields: AskCardField[] = [
    { key: "platform", labelAr: "المنصة", valueAr: ask.platform ? PLATFORM_AR[ask.platform] ?? "غير محددة" : "غير محددة", customerWords: false, editable: false, input: { kind: "none" }, scope: "new_read" },
    { key: "count", labelAr: "العدد", valueAr: ask.count === null ? "لم يُحدد بعد" : toArabicDigits(ask.count), customerWords: false, editable: true, input: { kind: "number", min: 1, max: AGENT_MAX_DELIVERED_ROWS }, scope: scope("count", { field: "count", value: 1 }) },
    { key: "topic", labelAr: "الموضوع", valueAr: ask.topic.text ?? "بدون موضوع محدد", customerWords: ask.topic.text !== null, editable: true, input: { kind: "text", maxChars: TOPIC_MAX_CHARS }, scope: scope("topic", { field: "topic", value: "x" }) },
    { key: "source", labelAr: "المصدر", valueAr: src.valueAr, customerWords: src.customerWords, editable: true, input: { kind: "text", maxChars: SOURCE_MAX_CHARS }, scope: scope("source", { field: "source", value: null }) },
    { key: "period", labelAr: "الفترة", valueAr: ask.period ? `من ${toArabicDigits(ask.period.from)} إلى ${toArabicDigits(ask.period.to)}` : "بدون فترة محددة", customerWords: false, editable: true, input: { kind: "period" }, scope: scope("period", { field: "period", value: null }) },
    { key: "country", labelAr: "الدولة", valueAr: ask.country ? COUNTRY_AR[ask.country] ?? "دولة غير معروفة" : "أي دولة", customerWords: false, editable: true, input: { kind: "choice", options: COUNTRY_OPTIONS }, scope: scope("country", { field: "country", value: null }) },
    { key: "language", labelAr: "اللغة", valueAr: ask.language === "ar" ? "العربية" : ask.language === "en" ? "الإنجليزية" : "أي لغة", customerWords: false, editable: true, input: { kind: "choice", options: LANGUAGE_OPTIONS }, scope: scope("language", { field: "language", value: null }) },
    { key: "order", labelAr: "الترتيب", valueAr: ask.order === "newest" ? "الأحدث" : "الأكثر تعليقًا", customerWords: false, editable: true, input: { kind: "choice", options: ORDER_OPTIONS }, scope: scope("order", { field: "order", value: ask.order }) },
    { key: "comments", labelAr: "التعليقات", valueAr: commentsValue(ask), customerWords: false, editable: ask.platform !== "x", input: { kind: "choice", options: COMMENTS_OPTIONS }, scope: "recompile" },
    { key: "commentsPerParent", labelAr: `التعليقات من كل ${parentEach(ask)}`, valueAr: ask.commentsPerParent !== null ? toArabicDigits(ask.commentsPerParent) : "غير محدد", customerWords: false, editable: commentsOn, input: { kind: "number", min: 1, max: COMMENTS_PER_PARENT_MAX }, scope: "recompile" },
    { key: "replies", labelAr: "الردود", valueAr: repliesValue(ask), customerWords: false, editable: true, input: { kind: "choice", options: REPLIES_OPTIONS }, scope: "recompile" },
    { key: "repliesPerComment", labelAr: "الردود على كل تعليق", valueAr: ask.repliesPerComment !== null ? toArabicDigits(ask.repliesPerComment) : "غير محدد", customerWords: false, editable: repliesOn, input: { kind: "number", min: 1, max: AGENT_REPLIES_PER_COMMENT_MAX }, scope: "recompile" },
    { key: "budget", labelAr: "الميزانية", valueAr: ask.edits.budget !== undefined ? pointsAr(ask.edits.budget) : "بدون ميزانية", customerWords: false, editable: true, input: { kind: "number", min: 1, max: BUDGET_MAX_POINTS }, scope: "recompile" },
  ];
  return { v: 1, titleAr: "فهمنا طلبك", fields };
}

/** Reads an edit sent by a screen (JSON). Only the field NAME is checked here; every value is checked by `applyAskEdit`. */
export function parseAskEdit(raw: unknown): { ok: true; edit: AskEdit } | { ok: false; reason: AskEditRejection } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "unknown_field" };
  const field = (raw as { field?: unknown }).field;
  if (field === "platform") return { ok: false, reason: "field_locked" };
  if (typeof field !== "string" || !(ASK_EDITABLE_FIELDS as ReadonlyArray<string>).includes(field) || !("value" in (raw as object))) return { ok: false, reason: "unknown_field" };
  return { ok: true, edit: { field, value: (raw as { value: unknown }).value } as AskEdit };
}

const isWhole = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const realDay = (d: unknown): d is string => {
  if (typeof d !== "string") return false;
  const m = DAY.exec(d);
  if (!m) return false;
  const t = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return t.getUTCFullYear() === Number(m[1]) && t.getUTCMonth() === Number(m[2]) - 1 && t.getUTCDate() === Number(m[3]);
};

type Applied = { ok: true; ask: Ask } | { ok: false; reason: AskEditRejection };
const reject = (reason: AskEditRejection): Applied => ({ ok: false, reason });

/** Applies one edit to the Ask: a NEW Ask (the old one is never changed), or a reason code. Persistable numbers are also kept in `edits` so a later planning rebuilds the same Ask. */
export function applyAskEdit(ask: Ask, edit: AskEdit, ctx: { nowMs: number }): Applied {
  const next: Ask = structuredClone(ask);
  const whole = (v: unknown, min: number, max: number): AskEditRejection | null => (!isWhole(v) ? "not_whole_number" : v < min || v > max ? "out_of_range" : null);
  switch ((edit as { field: unknown }).field) {
    case "count": {
      const bad = whole(edit.value, 1, AGENT_MAX_DELIVERED_ROWS);
      if (bad) return reject(bad);
      next.count = edit.value as number;
      next.edits = { ...next.edits, count: edit.value as number };
      return { ok: true, ask: next };
    }
    case "topic": {
      const t = typeof edit.value === "string" ? edit.value.replace(/\s+/g, " ").trim() : "";
      if (t === "") return reject("topic_empty");
      if (t.length > TOPIC_MAX_CHARS) return reject("topic_too_long");
      next.topic = { text: t, relation: ask.topic.relation === "none" ? "about" : ask.topic.relation };
      return { ok: true, ask: next };
    }
    case "source": {
      if (edit.value === null) { next.source = { kind: "none", text: null }; return { ok: true, ask: next }; }
      const t = typeof edit.value === "string" ? edit.value.replace(/\s+/g, " ").trim() : "";
      if (t === "") { next.source = { kind: "none", text: null }; return { ok: true, ask: next }; }
      if (t.length > SOURCE_MAX_CHARS) return reject("source_too_long");
      next.source = { kind: "named", text: t };
      return { ok: true, ask: next };
    }
    case "period": {
      if (edit.value === null) { next.period = null; return { ok: true, ask: next }; }
      const v = edit.value as { from?: unknown; to?: unknown } | undefined;
      if (!v || typeof v !== "object" || !realDay(v.from) || !realDay(v.to)) return reject("period_bad_day");
      if (v.from > v.to) return reject("period_reversed");
      if (v.to > cairoDayOf(ctx.nowMs)) return reject("period_in_future");
      next.period = { from: v.from, to: v.to, startMs: cairoDayStartMs(v.from), endExclusiveMs: cairoDayEndExclusiveMs(v.to) };
      return { ok: true, ask: next };
    }
    case "country": {
      if (edit.value === null || edit.value === "any") { next.country = null; return { ok: true, ask: next }; }
      if (typeof edit.value !== "string" || !(edit.value in COUNTRY_AR)) return reject("country_unknown");
      next.country = edit.value;
      return { ok: true, ask: next };
    }
    case "language": {
      const v = edit.value as unknown;
      if (v === null || v === "any") { next.language = null; return { ok: true, ask: next }; }
      if (v !== "ar" && v !== "en") return reject("unknown_choice");
      next.language = v;
      return { ok: true, ask: next };
    }
    case "order": {
      if (edit.value !== "most_commented" && edit.value !== "newest") return reject("unknown_choice");
      next.order = edit.value;
      return { ok: true, ask: next };
    }
    case "comments": {
      const v = edit.value as unknown;
      if (v !== "none" && v !== "some" && v !== "all") return reject("unknown_choice");
      if (v !== "none" && ask.platform === "x") return reject("not_offered");
      next.comments = v;
      if (v !== "some") { next.commentsPerParent = null; next.commentsBare = null; }
      const { comments: _total, ...rest } = next.edits;
      void _total;
      next.edits = rest;
      // the replies of a platform's comments hang on the comments: no comments, no replies (X's replies hang on the tweets and stay)
      if (v === "none" && ask.platform !== "x") { next.replies = "none"; next.repliesPerComment = null; const { replies: _r, ...r2 } = next.edits; void _r; next.edits = r2; }
      return { ok: true, ask: next };
    }
    case "commentsPerParent": {
      if (ask.comments === "none") return reject("comments_not_asked");
      const bad = whole(edit.value, 1, COMMENTS_PER_PARENT_MAX);
      if (bad) return reject(bad);
      next.comments = "some";
      next.commentsPerParent = edit.value as number;
      next.commentsBare = null;
      const { comments: _total, ...rest } = next.edits;
      void _total;
      next.edits = rest;
      return { ok: true, ask: next };
    }
    case "replies": {
      const v = edit.value as unknown;
      if (v !== "none" && v !== "some" && v !== "all") return reject("unknown_choice");
      if (v !== "none" && ask.comments === "none" && ask.platform !== "x") return reject("comments_not_asked");
      next.replies = v;
      if (v !== "some") next.repliesPerComment = null;
      const { replies: _r, ...rest } = next.edits;
      void _r;
      next.edits = rest;
      return { ok: true, ask: next };
    }
    case "repliesPerComment": {
      if (ask.replies === "none") return reject("replies_not_asked");
      const bad = whole(edit.value, 1, AGENT_REPLIES_PER_COMMENT_MAX);
      if (bad) return reject(bad);
      next.replies = "some";
      next.repliesPerComment = edit.value as number;
      const { replies: _r, ...rest } = next.edits;
      void _r;
      next.edits = rest;
      return { ok: true, ask: next };
    }
    case "budget": {
      if (edit.value === null) { const { budget: _b, ...rest } = next.edits; void _b; next.edits = rest; return { ok: true, ask: next }; }
      const bad = whole(edit.value, 1, BUDGET_MAX_POINTS);
      if (bad) return reject(bad);
      next.edits = { ...next.edits, budget: edit.value as number };
      return { ok: true, ask: next };
    }
    default:
      return reject((edit as { field: unknown }).field === "platform" ? "field_locked" : "unknown_field");
  }
}

/**
 * What an edit needs. A NUMBER (the count, the comments and replies numbers and choices, the budget) only re-chooses and re-prices from the pages already read: recompile. What changes the
 * pages that must be read (the topic, the source, the period, the country, the language: inputs of the parent tool or conditions of the ranking) needs a new read; so does the order when the
 * parent tool takes an order as an input (its pool was read in the other order).
 */
export function editScopeOf(edit: AskEdit, _ask: Ask, poolCard?: ToolCard): EditScope {
  switch (edit.field) {
    case "count": case "comments": case "commentsPerParent": case "replies": case "repliesPerComment": case "budget": return "recompile";
    case "order": return poolCard && !poolCard.inputs.order ? "recompile" : "new_read";
    default: return "new_read";
  }
}

export type CompileBase = Omit<CompileInput, "ask">;
export type CompileOk = Extract<CompileResult, { ok: true }>;
export type RecompileResult =
  | { kind: "plan"; ask: Ask; result: CompileOk }
  | { kind: "new_read"; ask: Ask }
  | { kind: "rejected"; reason: AskEditRejection; compileReason?: string };

/** Compiles an Ask from the pages already read: with a budget, the largest version whose hold fits it (`fitToBudget`, the planning's own); without, the compiler as it is. */
export function compileAsk(base: CompileBase, ask: Ask): RecompileResult {
  const compileWith = (a: Ask): CompileResult => compilePlan({ ...base, ask: a });
  if (ask.edits.budget !== undefined) {
    const word = ask.parentKind ? PARENT_WORD_AR[ask.parentKind]?.plural ?? "عنصر" : "عنصر";
    const fit = fitToBudget(compileWith, ask, ask.edits.budget, DEFAULT_COUNT, word);
    return fit.ok ? { kind: "plan", ask: fit.ask, result: fit.result } : { kind: "rejected", reason: "budget_too_small" };
  }
  const r = compileWith(ask);
  return r.ok ? { kind: "plan", ask, result: r } : { kind: "rejected", reason: "cannot_compile", compileReason: r.reason };
}

/** One edit, end to end: checked, then recompiled by code from the same pages, or returned for a new planning when it changes what must be read. Deterministic: the same inputs give the same result. */
export function recompileWithEdit(base: CompileBase, ask: Ask, edit: AskEdit, ctx: { nowMs: number }): RecompileResult {
  const applied = applyAskEdit(ask, edit, ctx);
  if (!applied.ok) return { kind: "rejected", reason: applied.reason };
  if (editScopeOf(edit, ask, base.pool.card) === "new_read") return { kind: "new_read", ask: applied.ask };
  return compileAsk(base, applied.ask);
}
