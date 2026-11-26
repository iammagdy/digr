import { normalizeReleaseWording } from "./releaseWording";
import { isArabicComma, trimEdges } from "./arabicNormalize";

/**
 * The title and the body of a notification as the bell shows them. A body that starts with its own title («اكتمل طلبك جزئيًا: تم تسليم …») would
 * read the title twice, so the repeated start is removed (old stored rows carry it); the old refund wording is read as «رجع لمحفظتك».
 * Nothing stored is rewritten.
 */
/** A blank, a colon, a full stop, the Arabic comma, a hyphen, an en dash or an em dash. */
const isTitleSeparator = (c: string): boolean => /\s/.test(c) || ":.-–—".includes(c) || isArabicComma(c);

export function notificationDisplay(title: unknown, body: unknown): { title: string; body: string } {
  const shownTitle = normalizeReleaseWording(title);
  let shownBody = normalizeReleaseWording(body);
  const titleCore = trimEdges(shownTitle, isTitleSeparator, "end");
  if (titleCore && shownBody.startsWith(titleCore)) {
    shownBody = trimEdges(shownBody.slice(titleCore.length), isTitleSeparator, "start");
  }
  return { title: shownTitle, body: shownBody };
}
