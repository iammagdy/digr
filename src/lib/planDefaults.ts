import { pointsAr } from "./pointsFormat";
import { toArabicDigits } from "./arabicDigits";

/**
 * What a plan uses when the customer left a quantity open (a skipped or unanswered cap). It is never silent: the plan states the value and
 * that the customer can edit it. The price is still set by the quote from the count the plan holds; no price or cap changes here.
 */
export const DEFAULT_COMMENTS_CAP = 500;
export const DEFAULT_RECORDS_CAP = 500;

/** What a default count counts: comments, posts or other records, or videos. */
export type DefaultNoun = "comments" | "records" | "videos";
const NOUN_WORD_AR: Record<DefaultNoun, string> = { comments: "تعليق", records: "سجل", videos: "فيديو" };

export function defaultCapFor(noun: DefaultNoun): number {
  return noun === "comments" ? DEFAULT_COMMENTS_CAP : DEFAULT_RECORDS_CAP;
}

/** The plan line that says the count is a default and can be edited. */
export function defaultCapLineAr(noun: DefaultNoun, units: number, wordAr?: string): string {
  const word = wordAr || NOUN_WORD_AR[noun];
  return `العدد المطلوب: ${toArabicDigits(units)} ${word} (قيمة افتراضية لأنك لم تحدد عددًا)، وتقدر تعدّله من الخطة.`;
}

/** When the default count does not fit one job: what the plan holds instead, in plain words (the numbers come from the quote). */
export function defaultCapFittedLineAr(input: { noun: DefaultNoun; fittedUnits: number; quotedPoints: number; pointsCap: number; wordAr?: string }): string {
  const word = input.wordAr || NOUN_WORD_AR[input.noun];
  return `لكن الطلب الواحد يتسع الآن لـ${toArabicDigits(input.fittedUnits)} ${word} بحجز ${pointsAr(input.quotedPoints, toArabicDigits)} ضمن سقف ${pointsAr(input.pointsCap, toArabicDigits)}، ويمكنك طلب الباقي في طلب منفصل.`;
}

/**
 * The whole sentence the plan card shows when the count is a default: the default and that it can be edited, and, when one job holds
 * fewer, what it holds instead. It is never «طلبت ...»: the customer did not ask for the default.
 */
export function defaultVolumeStatementAr(input: { noun: DefaultNoun; defaultUnits: number; fittedUnits: number; quotedPoints: number; pointsCap: number; wordAr?: string }): string {
  const first = defaultCapLineAr(input.noun, input.defaultUnits, input.wordAr);
  return input.fittedUnits < input.defaultUnits
    ? `${first} ${defaultCapFittedLineAr({ noun: input.noun, fittedUnits: input.fittedUnits, quotedPoints: input.quotedPoints, pointsCap: input.pointsCap, wordAr: input.wordAr })}`
    : first;
}
