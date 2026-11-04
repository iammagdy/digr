import { normalizeDigits } from "../../arabicDigits";
import { cairoDayEndExclusiveMs, cairoDayStartMs } from "../cairoTime";
import type { Ask } from "../foundation/ask";
import { AGENT_MAX_QUESTIONS, COUNT_OPTIONS_AR, COUNT_QUESTION_AR, PARENT_WORD_AR, PER_PARENT_OPTIONS_AR, PER_PARENT_QUESTION_AR } from "../foundation/countChoice";
import { isRecurringEvent, OCCURRENCE_OPTIONS_AR, OCCURRENCE_QUESTION_AR } from "../foundation/occurrence";
import type { SocialPlatform } from "../redesignFlagTypes";
import { applyAskEdit, type AskEditRejection } from "./askCard";

/**
 * STAGE 2, THE QUESTION CARDS (docs/STAGE-2.md, FOUNDATION-PLAN PR 4). Before anything is read or held, the Ask's GAPS become question cards, by code, ordered by importance, AT MOST THREE
 * per request in all (the questions already asked count against the three: `AGENT_MAX_QUESTIONS`). A gap that is not asked keeps today's default (the compiler's own). Each card has one-tap
 * options and «شيء آخر» (a typed answer) where a typed answer means something. The count card is «تحب كام؟» with ١٠ / ٥٠ / ١٠٠ and a budget option; a budget answer is the Ask's budget,
 * which the compiler treats as a HARD CEILING on the hold (`fitToBudget`). Pure: no I/O, no model. The flag `DIGER_STAGE2_QUESTION_CARDS` gates the wiring.
 *
 * Importance (fixed): the platform (nothing can be planned without it), the count (the size of the job and of the hold), the occurrence of a recurring event (what is read), the topic's
 * relation when it is ambiguous (which items are chosen), the number of comments for each parent (the size of the children).
 */
export const QUESTION_CODES = ["platform", "count", "occurrence", "topic_relation", "per_parent"] as const;
export type QuestionCode = (typeof QUESTION_CODES)[number];
export const MAX_QUESTION_CARDS = AGENT_MAX_QUESTIONS;

export interface QuestionOption { value: string; labelAr: string }
export interface QuestionCard {
  code: QuestionCode;
  /** 1 is the most important. */
  rank: number;
  questionAr: string;
  options: QuestionOption[];
  /** «شيء آخر»: the customer may type the answer (a number, a year). */
  other: boolean;
  /** The budget option opens a number input in the card (points). */
  budgetInput?: true;
  /** The year option opens a year input in the card. */
  yearInput?: true;
}

const PLATFORM_OPTIONS: QuestionOption[] = [
  { value: "tiktok", labelAr: "تيك توك" }, { value: "x", labelAr: "إكس" }, { value: "facebook", labelAr: "فيسبوك" }, { value: "instagram", labelAr: "إنستغرام" }, { value: "youtube", labelAr: "يوتيوب" },
];
const PLATFORM_QUESTION_AR = "من أي منصة تريد البيانات؟";
const PARENT_KIND_OF: Record<SocialPlatform, Ask["parentKind"]> = { tiktok: "videos", youtube: "videos", x: "tweets", facebook: "posts", instagram: "posts" };
const TOPIC_RELATION_OPTIONS: QuestionOption[] = [{ value: "about", labelAr: "محتوى يتكلم عن الموضوع" }, { value: "made_with", labelAr: "محتوى معمول باستخدامه" }];
const TOPIC_RELATION_QUESTION_AR = (topic: string): string => `تقصد محتوى يتكلم عن «${topic}»، أم محتوى معمول باستخدام «${topic}»؟`;

const wordOf = (ask: Pick<Ask, "parentKind">): { plural: string; each: string } => (ask.parentKind ? PARENT_WORD_AR[ask.parentKind] ?? { plural: "عنصر", each: "عنصر" } : { plural: "عنصر", each: "عنصر" });

/** The question cards of an Ask, most important first, at most `3 - alreadyAsked`. `requestText` is the customer's words (a recurring event is read from them). */
export function questionCardsFor(ask: Ask, ctx: { requestText: string; alreadyAsked: number }): QuestionCard[] {
  const room = Math.max(0, Math.min(MAX_QUESTION_CARDS, AGENT_MAX_QUESTIONS - Math.max(0, Math.floor(ctx.alreadyAsked))));
  if (room === 0) return [];
  const word = wordOf(ask);
  const cards: QuestionCard[] = [];
  const hasBudget = ask.edits.budget !== undefined;
  if (ask.platform === null) cards.push({ code: "platform", rank: 0, questionAr: PLATFORM_QUESTION_AR, options: PLATFORM_OPTIONS, other: false });
  if (ask.count === null && !hasBudget) {
    cards.push({
      code: "count", rank: 0, questionAr: COUNT_QUESTION_AR(word.plural),
      options: [{ value: "10", labelAr: COUNT_OPTIONS_AR.ten }, { value: "50", labelAr: COUNT_OPTIONS_AR.fifty }, { value: "100", labelAr: COUNT_OPTIONS_AR.hundred }, { value: "budget", labelAr: COUNT_OPTIONS_AR.budget }],
      other: true, budgetInput: true,
    });
  }
  if (!ask.occurrence && isRecurringEvent(ask, ctx.requestText)) {
    cards.push({ code: "occurrence", rank: 0, questionAr: OCCURRENCE_QUESTION_AR(ask.topic.text ?? ""), options: [{ value: "latest", labelAr: OCCURRENCE_OPTIONS_AR.latest }, { value: "all", labelAr: OCCURRENCE_OPTIONS_AR.all }, { value: "year", labelAr: OCCURRENCE_OPTIONS_AR.year }], other: false, yearInput: true });
  }
  if (ask.topic.relation === "ambiguous" && ask.topic.text) cards.push({ code: "topic_relation", rank: 0, questionAr: TOPIC_RELATION_QUESTION_AR(ask.topic.text), options: TOPIC_RELATION_OPTIONS, other: false });
  // comments asked with no number for each parent (and not «all», not a total, no budget to size them): «كل التعليقات» or a number
  if (ask.comments === "some" && ask.commentsPerParent === null && ask.edits.comments === undefined && !hasBudget) {
    cards.push({
      code: "per_parent", rank: 0, questionAr: PER_PARENT_QUESTION_AR(word.each),
      options: [{ value: "all", labelAr: PER_PARENT_OPTIONS_AR.all }, { value: "10", labelAr: PER_PARENT_OPTIONS_AR.ten }, { value: "50", labelAr: PER_PARENT_OPTIONS_AR.fifty }, { value: "100", labelAr: PER_PARENT_OPTIONS_AR.hundred }],
      other: true,
    });
  }
  cards.sort((a, b) => QUESTION_CODES.indexOf(a.code) - QUESTION_CODES.indexOf(b.code));
  return cards.slice(0, room).map((c, i) => ({ ...c, rank: i + 1 }));
}

/** The customer's answer: a tapped option, plus the number the option opens (the budget, the year), or a typed answer («شيء آخر»). */
export interface QuestionAnswer { option?: string; budget?: number; year?: number; other?: string }
export type AnsweredAsk = { ok: true; ask: Ask } | { ok: false; reason: AskEditRejection };

const typedWhole = (s: string | undefined): number | null => {
  const t = normalizeDigits(String(s ?? "")).replace(/[٬,\s]/g, "");
  return /^\d{1,7}$/.test(t) ? Number(t) : null;
};

/** Turns an answer into the next Ask, by code, through the same checks as a card edit (askCard.ts). */
export function answerQuestionCard(ask: Ask, card: QuestionCard, answer: QuestionAnswer, ctx: { nowMs: number }): AnsweredAsk {
  const typed = answer.other !== undefined ? typedWhole(answer.other) : null;
  const known = (v: string | undefined): boolean => v !== undefined && card.options.some((o) => o.value === v);
  switch (card.code) {
    case "platform": {
      if (!known(answer.option)) return { ok: false, reason: "unknown_choice" };
      const platform = answer.option as SocialPlatform;
      const next: Ask = { ...structuredClone(ask), platform, parentKind: PARENT_KIND_OF[platform] };
      // X has no comments stage: the replies of a tweet are what a customer calls its comments
      if (platform === "x" && next.comments !== "none") { next.replies = next.replies !== "none" ? next.replies : next.comments; next.comments = "none"; next.commentsPerParent = null; }
      return { ok: true, ask: next };
    }
    case "count": {
      if (answer.other !== undefined) return typed === null ? { ok: false, reason: "not_whole_number" } : applyAskEdit(ask, { field: "count", value: typed }, ctx);
      if (answer.option === "budget") return typeof answer.budget === "number" && Number.isInteger(answer.budget) ? applyAskEdit(ask, { field: "budget", value: answer.budget }, ctx) : { ok: false, reason: "not_whole_number" };
      if (!known(answer.option)) return { ok: false, reason: "unknown_choice" };
      return applyAskEdit(ask, { field: "count", value: Number(answer.option) }, ctx);
    }
    case "per_parent": {
      if (answer.other !== undefined) return typed === null ? { ok: false, reason: "not_whole_number" } : applyAskEdit(ask, { field: "commentsPerParent", value: typed }, ctx);
      if (!known(answer.option)) return { ok: false, reason: "unknown_choice" };
      return answer.option === "all" ? applyAskEdit(ask, { field: "comments", value: "all" }, ctx) : applyAskEdit(ask, { field: "commentsPerParent", value: Number(answer.option) }, ctx);
    }
    case "occurrence": {
      if (!known(answer.option)) return { ok: false, reason: "unknown_choice" };
      const next: Ask = structuredClone(ask);
      if (answer.option === "year") {
        const y = answer.year;
        if (typeof y !== "number" || !Number.isInteger(y)) return { ok: false, reason: "not_whole_number" };
        if (y < 1990 || y > Number(new Date(ctx.nowMs).getUTCFullYear())) return { ok: false, reason: "out_of_range" };
        const from = `${y}-01-01`, to = `${y}-12-31`;
        next.occurrence = { kind: "year", year: y };
        next.period = { from, to, startMs: cairoDayStartMs(from), endExclusiveMs: cairoDayEndExclusiveMs(to) };
      } else next.occurrence = { kind: answer.option as "latest" | "all" };
      next.edits = { ...next.edits, occurrence: next.occurrence };
      return { ok: true, ask: next };
    }
    case "topic_relation": {
      if (!known(answer.option)) return { ok: false, reason: "unknown_choice" };
      return { ok: true, ask: { ...structuredClone(ask), topic: { text: ask.topic.text, relation: answer.option as "about" | "made_with" } } };
    }
  }
}

