import { rowIdentity } from "./retryReuse";

/**
 * Identity of a row for de-duplication across pages and chunks. A repeated row must be neither delivered twice nor
 * billed twice, whichever page or chunk repeats it.
 *  - company: the website domain first (a provider can give the same company a different record id), then the record id,
 *    then the normalised name;
 *  - person: the professional profile link, else name + company, else the record id;
 *  - a comment under a known video with a known author: the video, the author and the text (a word-for-word repeat is one comment);
 *  - a post (X): its normalised text, so the same tweet text under different ids and links is one post (see `postDedupeIdentity`);
 *  - everything else (videos): the source's own id, as before.
 */
export type DedupeKind = "company" | "person" | "social" | "social_post";

const compact = (value: unknown) => String(value ?? "").normalize("NFKC").toLocaleLowerCase().replace(/[\p{P}\p{S}\s]+/gu, "").trim();

function domainOf(row: any): string | null {
  const website = String(row?.website || row?.website_url || row?.domain || row?.company_website || "").trim().toLowerCase();
  if (!website || /linkedin\.com/.test(website)) return null;
  try {
    const host = new URL(/^https?:\/\//i.test(website) ? website : `https://${website}`).hostname.replace(/^www\./, "");
    return host || null;
  } catch {
    return null;
  }
}

export function companyDedupeIdentity(row: any): string | null {
  const domain = domainOf(row);
  if (domain) return `domain:${domain}`;
  return rowIdentity(row);
}

export function personDedupeIdentity(row: any): string | null {
  const profile = String(row?.linkedin_url || row?.linkedin || row?.profile_url || "").trim().toLowerCase().replace(/\/+$/, "");
  if (profile) return `profile:${profile}`;
  const name = compact(row?.full_name || row?.contact_name || row?.name);
  const company = compact(row?.company_name || row?.company);
  if (name.length >= 3 && company.length >= 2) return `person:${name}@${company}`;
  return rowIdentity(row);
}

const COMMENT_AUTHOR_KEYS = ["author", "author_name", "user_nickname", "user_unique_id", "user_name", "username", "nickname"];

/**
 * A comment re-posted word for word by the same author under the same video is one comment: the first is kept. A row that is not a
 * comment with a known video, author and text keeps the source's own id as before.
 */
export function socialDedupeIdentity(row: any): string | null {
  const text = compact(row?.text ?? row?.comment_text);
  const video = String(row?.video_url ?? "").trim().toLowerCase();
  const author = compact(COMMENT_AUTHOR_KEYS.map((key) => row?.[key]).find((value) => typeof value === "string" && value.trim()));
  if (text.length > 0 && video && author) return `comment:${video}|${author}|${text}`;
  return rowIdentity(row);
}

const URL_IN_TEXT_RE = /(?:https?:\/\/|www\.)\S+/giu;
/** Fewer letters than this say too little to call two posts the same («Wow»): such a post keeps the source's own id. */
const MIN_POST_TEXT_LETTERS = 8;

/** The text of a post as one comparable string: no links (each copy carries its own short link), marks, spaces, punctuation or emoji; Arabic letter variants unified. */
export function normalizedPostText(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(URL_IN_TEXT_RE, " ")
    .toLocaleLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "")
    .replace(/[أإآٱ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/** A short stable hash (cyrb53), so the running record keeps a few characters per post and not its whole text. */
function hashText(text: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/**
 * Posts (X): the same text under another id or link is the same post, whatever account or time it came from, so it is delivered and charged
 * once, the first time it appears. A post with too little text keeps the source's own id.
 */
export function postDedupeIdentity(row: any): string | null {
  const text = normalizedPostText(row?.text ?? row?.full_text ?? row?.post_text ?? row?.tweet_text);
  if ([...text].filter((ch) => /\p{L}/u.test(ch)).length >= MIN_POST_TEXT_LETTERS) return `post:${text.length}:${hashText(text)}`;
  return rowIdentity(row);
}

export function dedupeIdentityFor(kind: DedupeKind): (row: any) => string | null {
  return kind === "company" ? companyDedupeIdentity : kind === "person" ? personDedupeIdentity : kind === "social_post" ? postDedupeIdentity : socialDedupeIdentity;
}

/** Keeps the first occurrence of each identity; `seen` is shared across pages so later pages drop earlier rows. */
export function dedupeRows<T>(rows: T[], identityOf: (row: T) => string | null, seen: Set<string>): { rows: T[]; duplicates: number } {
  let duplicates = 0;
  const kept = rows.filter((row) => {
    const identity = identityOf(row);
    if (!identity) return true;
    if (seen.has(identity)) { duplicates += 1; return false; }
    seen.add(identity);
    return true;
  });
  return { rows: kept, duplicates };
}
