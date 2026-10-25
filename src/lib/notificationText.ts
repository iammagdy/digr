import { normalizeReleaseWording } from "./releaseWording";

/**
 * The title and the body of a notification as the bell shows them. A body that starts with its own title («اكتمل طلبك جزئيًا: تم تسليم …») would
 * read the title twice, so the repeated start is removed (old stored rows carry it); the old refund wording is read as «حجز مؤقت مُحرَّر».
 * Nothing stored is rewritten.
 */
export function notificationDisplay(title: unknown, body: unknown): { title: string; body: string } {
  const shownTitle = normalizeReleaseWording(title);
  let shownBody = normalizeReleaseWording(body);
  const titleCore = shownTitle.replace(/[\s:،.\-–—]+$/u, "");
  if (titleCore && shownBody.startsWith(titleCore)) {
    shownBody = shownBody.slice(titleCore.length).replace(/^[\s:،.\-–—]+/u, "");
  }
  return { title: shownTitle, body: shownBody };
}
