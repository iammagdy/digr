import { toArabicDigits } from "./arabicDigits";
import { extractUrls } from "./socialTasks";

/**
 * Channel names, handles and links as a customer writes them: «@aljazeera», «aljazeera», «الجزيرة مباشر», a profile link, in one
 * message or several, separated by «و», commas or new lines. Pure code: no model, no network.
 */

/** The most channels one answer may add up to (the plan itself keeps what a job can hold, see MAX_CHANNELS_PER_JOB). */
export const MAX_CHANNELS_READ = 30;

/** Replies that mean «no answer», never a channel name. */
const NOT_A_NAME = new Set([
  "لا", "لأ", "لاء", "مفيش", "معرفش", "ماعرفش", "مش", "تخطي", "تجاهل", "skip", "none", "no", "نعم", "اه", "أه", "ايوه", "أيوه", "ok", "تمام", "كمل", "ابدأ", "ابدا",
]);
const NAME_LEAD_WORDS = new Set(["قناة", "قناه", "قنوات", "حساب", "حسابات", "صفحة", "صفحه", "صفحات", "اسم", "اسمها", "اسمه", "القناة", "القنوات", "الحساب", "الصفحة", "channel", "account"]);
const MAX_NAME_WORDS = 5;

const HANDLE_CHARS = "[\\p{L}\\p{N}_.]";
const LATIN_HANDLE_RE = /^[A-Za-z0-9_.]{2,30}$/;
const AT_HANDLE_RE = new RegExp(`^@(${HANDLE_CHARS}{2,30})$`, "u");

/** A channel in one comparable spelling: no «@», no «قناة», lower case. */
export function channelKey(name: string): string {
  return String(name || "")
    .trim()
    .replace(/^@+/, "")
    .replace(/^(?:قناة|قناه|حساب|صفحة)\s+/u, "")
    .toLowerCase();
}

function unwrap(raw: string): string {
  return raw
    .replace(/[«»"'“”‘’()\[\]{}]/g, " ")
    .replace(/^[\s\-–—•*:]+|[\s.\-–—•*:؟?!]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function channelFromUrl(url: string): string | null {
  const [parsed] = extractUrls(url);
  if (!parsed || parsed.kind !== "channel") return null;
  if (parsed.platform === "tiktok" && parsed.id) return `@${parsed.id}`;
  if (parsed.platform === "youtube" && parsed.id) return /^UC[\w-]{20,}$/.test(parsed.id) ? parsed.url : parsed.id.startsWith("@") ? parsed.id : parsed.url;
  return parsed.url;
}

/** One piece of an answer as a channel: a handle, a plain Latin handle, or a name; null when it is no channel at all. */
function pieceToChannel(piece: string): string | null {
  let text = unwrap(piece);
  if (!text) return null;
  // «قناة الجزيرة», «حساب @aljazeera»
  for (let i = 0; i < 3; i++) {
    const [first, ...rest] = text.split(" ");
    if (rest.length > 0 && NAME_LEAD_WORDS.has(first.toLowerCase())) text = rest.join(" ");
    else break;
  }
  text = unwrap(text);
  if (!text || /^[0-9٠-٩]+$/.test(text) || NAME_LEAD_WORDS.has(text.toLowerCase())) return null;
  if (NOT_A_NAME.has(text.toLowerCase())) return null;
  const at = AT_HANDLE_RE.exec(text);
  if (at) return `@${at[1]}`;
  if (LATIN_HANDLE_RE.test(text) && /[A-Za-z]/.test(text)) return `@${text}`;
  const words = text.split(" ");
  if (words.length > MAX_NAME_WORDS || text.length < 2 || text.length > 60) return null;
  if (words.every((word) => NOT_A_NAME.has(word.toLowerCase()))) return null;
  // a sentence is not a channel name
  if (/[,،؛;:!؟?]/.test(text)) return null;
  return text;
}

/**
 * The channels an answer names, in the order written. Links (profile, @handle, channel id) are read first; the rest is split at
 * «و», commas, semicolons and new lines, and each piece is a handle or a name.
 */
export function parseChannelAnswer(answer: string): string[] {
  const found: string[] = [];
  const add = (value: string | null) => {
    if (!value) return;
    const key = channelKey(value);
    if (!key || found.some((existing) => channelKey(existing) === key)) return;
    found.push(value);
  };
  let rest = String(answer || "").replace(/[​-‏⁦-⁩]/g, "");
  for (const url of extractUrls(rest)) {
    add(channelFromUrl(url.url));
    rest = rest.replace(url.url, " , ");
  }
  const pieces = rest
    .split(/[,،؛;|\n\r]+|\s+(?:و|and|&)\s+|\s+و(?=ال)|\s+و(?=[@A-Za-z0-9])|(?<=\S)و(?=@)|\s+(?=@)/u)
    .map((piece) => piece.trim())
    .filter(Boolean);
  for (const piece of pieces) {
    add(pieceToChannel(piece));
    if (found.length >= MAX_CHANNELS_READ) break;
  }
  return found;
}

/** Channels written as handles or profile links anywhere in a request, not as an answer to the channel question. */
export function handlesInText(text: string): string[] {
  const found: string[] = [];
  const add = (value: string | null) => {
    if (!value) return;
    const key = channelKey(value);
    if (!key || found.some((existing) => channelKey(existing) === key)) return;
    found.push(value);
  };
  for (const url of extractUrls(text)) add(channelFromUrl(url.url));
  const withoutUrls = String(text || "").replace(/https?:\/\/[^\s<>"')\]]+/giu, " ");
  // «و@القناة»: the Arabic «and» sticks to the handle; any other letter before «@» makes it an e-mail address, not a handle.
  for (const m of withoutUrls.matchAll(new RegExp(`(?:^|(?<=[^\\p{L}\\p{N}_@])|(?<=و))@(${HANDLE_CHARS}{2,30})`, "gu"))) add(`@${m[1].replace(/\.+$/, "")}`);
  return found;
}

/** «قناة واحدة», «قناتين», «٣ قنوات», «١١ قناة»: a count of channels in correct Arabic. */
export function channelsCountAr(count: number): string {
  if (count === 1) return "قناة واحدة";
  if (count === 2) return "قناتين";
  return `${toArabicDigits(count)} ${count >= 3 && count <= 10 ? "قنوات" : "قناة"}`;
}
