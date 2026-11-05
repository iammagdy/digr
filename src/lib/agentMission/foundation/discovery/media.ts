import type { ToolCard } from "../toolCards/types";

/**
 * ROUND 35: THE MEDIA-TYPE CONTRACT OF A REQUEST FOR REELS (Instagram). Live (msn_9eea13f7…): «٥ ريلز عن الذكاء الاصطناعي» was read with the hashtag SEARCH of posts, with no media-type input sent, and delivered `/p/` posts under the title «منشورات»:
 * the request's word «ريلز» was parsed as nothing, and the plan said nothing about it. A request for reels is served ONLY by:
 *  - `native`: a tool whose own capability is reels («instagram.search.reels», «instagram.user.reels»); or
 *  - `filter`: a tool whose catalog entry lists a media-type input with a documented reel value; the plan sends it (the value is the catalog's own, never typed here);
 * and every other tool is `unproven`: the plan says so BEFORE approval and does not call the items reels. Nothing is guessed from a link («/reel/» in an address proves nothing) and no delivered row is removed: this is the plan's promise and its disclosure, not a filter.
 * Pure: no I/O.
 */
export type MediaBasis = "native" | "filter" | "unproven";
export interface MediaMark { asked: "reels"; basis: MediaBasis; /** The input the plan sent and its documented value (basis `filter`). */ filter?: { field: string; value: string } }

export const reelsBasisOf = (card: ToolCard): MediaBasis => (card.media?.reels === "native" ? "native" : card.media?.reels ? "filter" : "unproven");

/** The card as the plan will read it for reels: a filter tool carries its media-type input on every call (`fixed`); a native tool and an unproven tool are returned as they are. */
export function forReels(card: ToolCard): ToolCard {
  const r = card.media?.reels;
  return r && r !== "native" ? { ...card, inputs: { ...card.inputs, fixed: { ...(card.inputs.fixed ?? {}), [r.field]: r.value } } } : card;
}

/** The candidates that can PROVE reels, as they will be read, best first; none can: the candidates unchanged (the plan then discloses it). */
export function reelsCandidates(list: ReadonlyArray<ToolCard>): { list: ToolCard[]; proven: boolean } {
  const served = list.filter((c) => reelsBasisOf(c) !== "unproven").map(forReels);
  return served.length > 0 ? { list: served, proven: true } : { list: [...list], proven: false };
}

export function mediaMarkOf(card: ToolCard): MediaMark {
  const r = card.media?.reels;
  return { asked: "reels", basis: reelsBasisOf(card), ...(r && r !== "native" ? { filter: { field: r.field, value: r.value } } : {}) };
}

/** What the customer reads about the media type, before approval (Arabic only; no provider, no tool name). */
export function mediaNotesAr(mark: MediaMark): string[] {
  if (mark.basis === "native") return ["طلبت ريلز: اخترنا مصدرًا مخصصًا للريلز وحدها."];
  if (mark.basis === "filter") return ["طلبت ريلز: طلبنا من المصدر الريلز فقط عبر مرشّح نوع المحتوى الذي يصفه دليل المصادر، ولم نستنتج النوع من شكل الرابط."];
  return ["طلبت ريلز، لكن المصدر المتاح لهذا الطلب لا يثبت نوع المحتوى: ما سنسلّمه منشورات إنستجرام العامة، وقد لا تكون كلها ريلز. لم نصفِّ منها شيئًا ولم نسمّها ريلز."];
}

/** The file's own statement of the media scope (methodology, «حدود التسليم»): what was asked, how the type was served, and that nothing was inferred from a link or removed. */
export function mediaScopeLineAr(mark: MediaMark): string {
  if (mark.basis === "native") return "نوع المحتوى: طُلبت ريلز، والمصدر مخصص للريلز وحدها؛ ما في الملف ريلز إنستجرام العامة التي أعادها هذا المصدر.";
  if (mark.basis === "filter") return "نوع المحتوى: طُلبت ريلز، وطلبنا من المصدر الريلز فقط عبر مرشّح النوع الذي يصفه دليل المصادر؛ لم نستنتج النوع من شكل الرابط ولم نحذف شيئًا مما أعاده.";
  return "نوع المحتوى: طُلبت ريلز، لكن المصدر لا يثبت نوع المحتوى؛ ما في الملف منشورات إنستجرام العامة وقد لا تكون كلها ريلز، ولم نصفِّ منها شيئًا.";
}
