import type { Ask } from "./ask";
import { AGENT_MAX_DELIVERED_ROWS } from "../constants";

/**
 * ROUND 14, PART B: THE COUNT AND THE BUDGET. A request that names no number of top-level items (videos, posts, tweets) is asked «تحب كام؟» BEFORE anything is read: one tap on ١٠, ٥٠ or ١٠٠, a number typed, or «حدد ميزانية بالنقاط». Comments asked with no number per parent (and not «كل التعليقات») are asked once:
 * «كل التعليقات» or a number. A BUDGET (said in the request, «بميزانية ٣٠٠٠ نقطة», or chosen here) is a hard CEILING on the HOLD, exactly like the over-limit path: the compiler builds the largest version whose hold is at most the budget, priced by the same price function, and the card says what it holds before approval.
 * Charges are unchanged: only what is delivered. At most three question cards per request (`AGENT_MAX_QUESTIONS`); a question that would be the fourth is not asked (today's defaults apply). A request that already has a count and no budget behaves exactly as today. Pure: no I/O, no model.
 */
export const AGENT_MAX_QUESTIONS = 3;

export const COUNT_OPTIONS_AR = { ten: "١٠", fifty: "٥٠", hundred: "١٠٠", budget: "حدد ميزانية بالنقاط" } as const;
export const COUNT_QUESTION_AR = (noun: string): string => `تحب كام ${noun}؟ اختر رقمًا أو اكتب العدد الذي تريده، أو حدد ميزانية بالنقاط.`;
export const BUDGET_QUESTION_AR = "كم نقطة ميزانيتك لهذا الطلب؟ اكتب الرقم، والحجز المؤقت لن يتجاوزه.";
export const BUDGET_TOO_SMALL_AR = "ميزانيتك لا تكفي لأصغر نسخة من هذا الطلب (الحد الأدنى للطلب ٢٠٠ نقطة). زد الميزانية أو عدّل الطلب، ولم يُخصم شيء.";
export const PER_PARENT_OPTIONS_AR = { all: "كل التعليقات", ten: "١٠", fifty: "٥٠", hundred: "١٠٠" } as const;
export const PER_PARENT_QUESTION_AR = (noun: string): string => `كم تعليقًا تريد من كل ${noun}؟ اختر «كل التعليقات» أو رقمًا.`;

export type PendingChoice = "count" | "budget" | "per_parent";
export interface Choices { count?: number; perParent?: number | "all"; budget?: number }
export type ChoiceAnswer = { kind: "count"; n: number } | { kind: "ask_budget" } | { kind: "budget"; points: number } | { kind: "per_parent"; n: number | "all" };

const digits = (s: string): string => s.replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d))).replace(/[٬,]/g, "");
const norm = (v: unknown): string => digits(String(v ?? "")).replace(/\s+/g, " ").trim();
const wholeNumber = (t: string): number | null => (/^\d{1,6}$/.test(t) ? Number(t) : null);

/** The customer's answer to the question that is open (`pending`), or null when the words are something else (an amendment of the request). */
export function choiceAnswerOf(answer: unknown, pending: PendingChoice | null | undefined): ChoiceAnswer | null {
  const t = norm(answer);
  if (t === "") return null;
  if (pending === "count" || pending === undefined || pending === null) { if (t === norm(COUNT_OPTIONS_AR.budget)) return { kind: "ask_budget" }; }
  if (pending === "count") { const n = wholeNumber(t); return n !== null && n >= 1 && n <= AGENT_MAX_DELIVERED_ROWS ? { kind: "count", n } : null; }
  if (pending === "budget") { const n = wholeNumber(t.replace(/\s*نقط[ةه]|\s*نقاط/g, "").trim()); return n !== null && n >= 1 ? { kind: "budget", points: n } : null; }
  if (pending === "per_parent") { if (t === norm(PER_PARENT_OPTIONS_AR.all)) return { kind: "per_parent", n: "all" }; const n = wholeNumber(t); return n !== null && n >= 1 && n <= 5000 ? { kind: "per_parent", n } : null; }
  return null;
}

/** A budget said in the request: «بميزانية ٣٠٠٠ نقطة», «ميزانيتي ٣٠٠٠ نقطة», «بحد أقصى ٣٠٠٠ نقطة», «لا تتجاوز ٣٠٠٠ نقطة», «في حدود ٣٠٠٠ نقطة». Points only (a number with no «نقطة» is never a budget). Null when none. */
export function budgetOfWords(request: unknown): number | null {
  const t = norm(request);
  const m = /(?:ميزاني\S*|حد\s+أقصى|حد\s+اقصى|لا\s+تتجاوز|ما\s+يزيد\s+عن|في\s+حدود|بحدود|لا\s+يزيد\s+عن)\s*(?:قدرها|مقدارها|بـ|ب)?\s*(\d{2,7})\s*نقط/.exec(t) ?? /(\d{2,7})\s*نقط[ةه]?\s*(?:ميزاني[ةه]|كحد\s+أقصى|كحد\s+اقصى)/.exec(t);
  const n = m ? Number(m[1]) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** The nouns a question uses for the parents of each platform. */
export const PARENT_WORD_AR: Record<string, { plural: string; each: string }> = {
  videos: { plural: "فيديو", each: "فيديو" }, posts: { plural: "منشور", each: "منشور" }, tweets: { plural: "تغريدة", each: "تغريدة" },
};

/** Which question, if any, the Ask needs BEFORE any read. `asked` is how many question cards the request has had; the cap is three. The count comes first, then the comments per parent. */
export function questionNeeded(ask: Pick<Ask, "count" | "parentKind" | "comments" | "commentsPerParent" | "edits">, choices: Choices, asked: number): { why: "count" | "per_parent"; question: string; options: string[] } | null {
  if (asked >= AGENT_MAX_QUESTIONS || !ask.parentKind) return null;
  const word = PARENT_WORD_AR[ask.parentKind];
  const hasBudget = choices.budget !== undefined || ask.edits.budget !== undefined;
  if (ask.count === null && choices.count === undefined && !hasBudget) {
    return { why: "count", question: COUNT_QUESTION_AR(word.plural), options: [COUNT_OPTIONS_AR.ten, COUNT_OPTIONS_AR.fifty, COUNT_OPTIONS_AR.hundred, COUNT_OPTIONS_AR.budget] };
  }
  // comments asked with no number per parent, and not «all the comments»: «كل التعليقات» or a number (the budget case decides the number by itself)
  // ROUND 19: a number of comments the words made a TOTAL («١٠٠ تعليق في المجموع», `edits.comments`) needs no question either
  if (ask.comments === "some" && ask.commentsPerParent === null && ask.edits.comments === undefined && choices.perParent === undefined && !hasBudget) {
    return { why: "per_parent", question: PER_PARENT_QUESTION_AR(word.each), options: [PER_PARENT_OPTIONS_AR.all, PER_PARENT_OPTIONS_AR.ten, PER_PARENT_OPTIONS_AR.fifty, PER_PARENT_OPTIONS_AR.hundred] };
  }
  return null;
}
