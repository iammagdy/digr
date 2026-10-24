import { commentsAr, pagesAr, postsAr } from "./text";

/** The real counts one Arabic sentence is built from. Every number is a count of what happened in the job. */
export interface ShortfallFacts {
  pagesBrowsed: number;
  pagesSkipped: number;
  postsFound: number;
  postsOutsideWindow: number;
  postsUndated: number;
  postsRequested: number;
  postsDelivered: number;
  commentsRequested: number;
  commentsDelivered: number;
  /** Comments of the kept posts that the source did not return (the posts' own counts, up to the number asked from each, minus what came back). */
  commentsNotReturned: number;
}

/**
 * ONE honest sentence that says what fell short and why, from counts: the Pages browsed and skipped, the posts found, the posts outside the window, the comments the source did
 * not return, and that nothing is charged for what was not delivered. Null when everything asked for was delivered.
 */
export function shortfallSentenceAr(facts: ShortfallFacts): string | null {
  const short = facts.postsDelivered < facts.postsRequested || facts.commentsDelivered < facts.commentsRequested;
  if (!short) return null;
  const parts: string[] = [];
  parts.push(`تصفّحنا ${pagesAr(facts.pagesBrowsed)}${facts.pagesSkipped > 0 ? ` وتخطّينا ${pagesAr(facts.pagesSkipped)} لم تُرجع منشورات أو رابطها غير صالح` : ""}`);
  parts.push(`ووجدنا ${postsAr(facts.postsFound)}`);
  const dropped: string[] = [];
  if (facts.postsOutsideWindow > 0) dropped.push(`${postsAr(facts.postsOutsideWindow)} خارج الفترة المطلوبة`);
  if (facts.postsUndated > 0) dropped.push(`${postsAr(facts.postsUndated)} بلا تاريخ يمكن التحقق منه`);
  if (dropped.length > 0) parts.push(`منها ${dropped.join(" و")}`);
  parts.push(`وسلّمنا ${postsAr(facts.postsDelivered)} من ${postsAr(facts.postsRequested)} مطلوبًا و${commentsAr(facts.commentsDelivered)} من ${commentsAr(facts.commentsRequested)} مطلوبًا`);
  if (facts.commentsNotReturned > 0) parts.push(`ولم يُعد المصدر ${commentsAr(facts.commentsNotReturned)} من منشورات تحمل تعليقات`);
  return `${parts.join("، ")}، ولا يُحتسب عليك إلا ما سُلّم فعلًا، ويُحرَّر الباقي من الحجز المؤقت.`;
}
