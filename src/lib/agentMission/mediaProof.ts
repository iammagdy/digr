/**
 * A CARD NEVER PROMISES A KIND OF ITEM THE SAMPLES DID NOT PROVE (live, 2026-10-30: «هات ٥ فيديوهات من فيسبوك عن منتخب مصر»). The plan searched the posts of Facebook by keyword and promised «posts that carry a video»; the card was approved (hold 466) and the run ended
 * with «search results do not prove a video», nothing delivered. The post search's own items DO say it (a `video` field, a video file, a thumbnail; the catalog's example item shows them), so the proof is a rule of the stage, checked in code on the measured page
 * before the card and on every item when the plan runs.
 *
 * An item PROVES a video when a mapped field that says so holds a value (a video field, a video link, a reel address) or its own link is a reel / video address, or a type field says «video», «reel», «short» or «clip». An item proves an IMAGE the same way (an
 * image or photo field). Nothing is guessed from the text of a post. A source whose own kind IS the media (a video search, a channel's videos, a page's reels) needs no proof. Pure: no I/O.
 */
export type MediaKind = "video" | "image";

const VIDEO_FIELD = /(^|_)(video|videos|video_?link|video_?url|video_?files?|video_?id|shared_?video\w*|attached_?video\w*|reel|reels|reel_?link|reel_?url|is_?video|has_?video|play_?url|playable_?url)$/i;
const IMAGE_FIELD = /(^|_)(image|images|image_?url|photo|photos|photo_?url|picture|pictures|display_?url|img|has_?image|has_?photo)$/i;
const TYPE_FIELD = /(^|_)(type|media_?type|post_?type|content_?type|kind|attachment_?type)$/i;
const LINK_FIELD = /(^|_)(url|link|post_?url|post_?link|permalink)$/i;
const VIDEO_WORD = /^(?:video|videos|reel|reels|short|shorts|clip|clips|watch|فيديو|ريل|ريلز|مقطع)$/i;
const IMAGE_WORD = /^(?:photo|photos|image|images|picture|pictures|صورة|صور)$/i;
const VIDEO_URL = /(?:\/(?:reels?|videos?|watch|shorts)\b|[?&]v=|youtu\.be\/|\.(?:mp4|mov|m3u8)(?:$|[?#]))/i;
const IMAGE_URL = /\.(?:jpe?g|png|webp|gif)(?:$|[?#])/i;
const EMPTY = /^(?:|null|none|undefined|false|0|no|\[\]|\{\})$/i;

const fieldOf = (kind: MediaKind): RegExp => (kind === "video" ? VIDEO_FIELD : IMAGE_FIELD);

/** The mapped fields that can prove the kind of item (found by code from the keys the mapping gives): the fields that say it, the type fields and the link fields. */
export function mediaFieldsOf(keys: ReadonlyArray<string>, kind: MediaKind): string[] {
  return keys.filter((k) => fieldOf(kind).test(k) || TYPE_FIELD.test(k) || LINK_FIELD.test(k));
}

/** True when the item (a MAPPED item) proves the kind of media from any of the fields. */
export function itemProvesMedia(kind: MediaKind, mapped: Record<string, unknown>, fields: ReadonlyArray<string>): boolean {
  for (const key of fields) {
    const v = mapped[key];
    if (v === null || v === undefined) continue;
    const text = typeof v === "string" ? v.trim() : typeof v === "number" || typeof v === "boolean" ? String(v) : Array.isArray(v) ? (v.length > 0 ? "[x]" : "[]") : typeof v === "object" ? (Object.keys(v as object).length > 0 ? "{x}" : "{}") : "";
    if (EMPTY.test(text)) continue;
    if (TYPE_FIELD.test(key)) { if ((kind === "video" ? VIDEO_WORD : IMAGE_WORD).test(text.split(/[\s_:/-]+/).pop() ?? "") || (kind === "video" ? VIDEO_WORD : IMAGE_WORD).test(text)) return true; continue; }
    if (LINK_FIELD.test(key) && !fieldOf(kind).test(key)) { if ((kind === "video" ? VIDEO_URL : IMAGE_URL).test(text)) return true; continue; }
    // a field that says it (a video field, a video link, an image): a value is the proof; a link must be an address (not a sentence)
    if (fieldOf(kind).test(key)) { if (typeof v === "string" && /^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return true; if (typeof v !== "string" || !/\s/.test(text)) return true; }
  }
  return false;
}

/** The kind of item a request counts («٥ فيديوهات», «١٠ ريلز», «٢٠ صورة»), or null. */
export function requestedMedia(request: string | null | undefined): MediaKind | null {
  const t = String(request ?? "");
  const n = "(?:[0-9٠-٩]+|[اأإ]ثنين|اتنين|ثلاث\\S*|تلات\\S*|[اأإ]ربع\\S*|خمس\\S*|ست\\S*|سبع\\S*|ثمان\\S*|تمان\\S*|تسع\\S*|عشر\\S*)";
  if (new RegExp(`${n}\\s+(?:فيديو(?:هات|ات)?|مقاطع\\s+فيديو|مقطع\\s+فيديو|ريل(?:ز)?|ريلز|reels?|videos?)`, "i").test(t)) return "video";
  if (new RegExp(`${n}\\s+(?:صور(?:ة)?|images?|photos?|pictures?)(?![\\u0621-\\u064A])`, "i").test(t)) return "image";
  return null;
}

/** The catalog source IS the media («a video search», «a channel's videos», «a page's reels», «photos of a page»): its items need no proof. */
export function isMediaCapability(capability: string | null | undefined, kind: MediaKind): boolean {
  const c = String(capability ?? "");
  return kind === "video" ? /\.(?:videos|reels|shorts|video)$/.test(c) : /\.(?:photos|images|image|photo)$/.test(c);
}

export const mediaLineAr = (kind: MediaKind): string => (kind === "video" ? "المنشورات التي تحمل فيديو فقط." : "المنشورات التي تحمل صورة فقط.");
export const mediaLabelAr = (kind: MediaKind): string => (kind === "video" ? "الفيديو فقط" : "الصور فقط");
export const mediaWordAr = (kind: MediaKind): string => (kind === "video" ? "فيديو" : "صورة");

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The items of a saved provider page: the largest list of objects found within four levels (the same page the mapping reads). */
export function rawItemsOfPage(parsed: unknown): Array<Record<string, unknown>> {
  let best: Array<Record<string, unknown>> = [];
  const walk = (v: unknown, depth: number): void => {
    if (Array.isArray(v)) { if (v.length > best.length && v.every(isObj)) best = v as Array<Record<string, unknown>>; if (depth < 4) for (const x of v.slice(0, 3)) walk(x, depth + 1); return; }
    if (isObj(v) && depth < 4) for (const x of Object.values(v)) walk(x, depth + 1);
  };
  walk(parsed, 0);
  return best;
}

/** How many items of the saved pages PROVE the kind of media from their own fields, of how many were examined (the measured pages of the stage, before any mapping). */
export function rawMediaProof(kind: MediaKind, pageTexts: ReadonlyArray<string | null>): { examined: number; proven: number } {
  let examined = 0;
  let proven = 0;
  for (const text of pageTexts) {
    if (!text) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { continue; }
    for (const item of rawItemsOfPage(parsed)) { examined += 1; if (itemProvesMedia(kind, item, mediaFieldsOf(Object.keys(item), kind))) proven += 1; }
  }
  return { examined, proven };
}

/** Does a mapped key SAY it (a video, reel, image or photo field), as opposed to a link or a type field that can only support it? */
export const keySaysMedia = (kind: MediaKind, key: string): boolean => fieldOf(kind).test(key);
