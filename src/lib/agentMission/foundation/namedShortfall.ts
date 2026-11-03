/**
 * OWNER DECISION 7.5 (docs/FOUNDATION-PLAN.md), Facebook: a named page + a topic + a period, and the posts read hold FEWER from that page than the customer asked for (and than can be delivered with their comments):
 * a question card is shown BEFORE approval, nothing priced or held. The three answers are read by their exact words (the same way topicChoice.ts reads its own): only the ones found (the default, the first),
 * fill from other pages with the mark «المصدر المسمّى: غير مطابق» (a mark, never a drop), or cancel. Pure: no I/O, no model.
 */
export const NAMED_SHORTFALL_OPTIONS_AR = {
  onlyFound: "أكمل بالمنشورات التي وجدناها من الصفحة فقط",
  fill: "أكمل واستكمل من صفحات أخرى مع علامة «المصدر المسمّى: غير مطابق»",
  cancel: "ألغِ المهمة",
} as const;

export type NamedShortfallChoice = "only_found" | "fill" | "cancel";
const norm = (v: unknown): string => String(v ?? "").replace(/\s+/g, " ").trim();
export function namedShortfallChoiceOf(answer: unknown): NamedShortfallChoice | null {
  const t = norm(answer);
  if (t === norm(NAMED_SHORTFALL_OPTIONS_AR.onlyFound)) return "only_found";
  if (t === norm(NAMED_SHORTFALL_OPTIONS_AR.fill)) return "fill";
  if (t === norm(NAMED_SHORTFALL_OPTIONS_AR.cancel)) return "cancel";
  return null;
}
/** The answer is one of the three ready answers: the planning reads the request without it (their words must not be read as part of the request). */
export const isNamedShortfallAnswer = (answer: unknown): boolean => namedShortfallChoiceOf(answer) !== null;

/** The mark column a delivery carries when the posts of other pages fill the number: the value for a post that is not the named page's, and the column's key and title. */
export const NAMED_MISMATCH_MARK_AR = "المصدر المسمّى: غير مطابق";
export const NAMED_MARK_KEY = "named_source";
export const NAMED_MARK_TITLE_AR = "المصدر المسمّى";

/** The question, in the customer's words: how many posts of the named page were found among what was read, against how many they asked for. */
export function namedShortfallQuestionAr(source: string, found: number, asked: number, digits: (n: number) => string): string {
  return `وجدنا في ما قرأناه ${digits(found)} منشورًا فقط من صفحة «${source}» يمكن تسليمه مع تعليقاته، وطلبت ${digits(asked)} منشورًا. كيف تريد أن نكمل؟`;
}
