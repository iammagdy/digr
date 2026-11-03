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
/** ROUND 17: the row carries NO author, so the source cannot say whether it is the named source's: the mark column says it in words (never «مطابق», never blank). Used only when the row truly has no author. */
export const NAMED_UNAVAILABLE_MARK_AR = "غير متاح من المصدر";
export const NAMED_MARK_TITLE_AR = "المصدر المسمّى";

/** The question, in the customer's words: how many posts of the named page were found among what was read, against how many they asked for. */
export function namedShortfallQuestionAr(source: string, found: number, asked: number, digits: (n: number) => string, topic?: string | null): string {
  // with a topic, what is counted is the page's posts that talk about it (live round 10: the page's other posts do not answer «posts about X from page Y»)
  const what = topic ? `منشورًا فقط من صفحة «${source}» يتحدث نصه عن «${topic}» ويمكن تسليمه مع تعليقاته` : `منشورًا فقط من صفحة «${source}» يمكن تسليمه مع تعليقاته`;
  return `وجدنا في ما قرأناه ${digits(found)} ${what}، وطلبت ${digits(asked)} منشورًا. كيف تريد أن نكمل؟`;
}

/** ROUND 17: a named Facebook page with no topic whose name no read post's author matched: said before any plan, nothing held. */
export const pageNotFoundAr = (name: string | null | undefined): string => `لم نجد صفحة باسم «${String(name ?? "").trim()}» على فيسبوك بين ما قرأناه، فلم نجهّز خطة ولم يُخصم منك شيء. أرسل رابط الصفحة أو اكتب اسمها كما هو على فيسبوك.`;
