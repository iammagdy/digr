import { rowIdentity } from "./retryReuse";

/**
 * Identity of a row for de-duplication across pages and chunks. A repeated row must be neither delivered twice nor
 * billed twice, whichever page or chunk repeats it.
 *  - company: the website domain first (a provider can give the same company a different record id), then the record id,
 *    then the normalised name;
 *  - person: the professional profile link, else name + company, else the record id;
 *  - a comment under a known video with a known author: the video, the author and the text (a word-for-word repeat is one comment);
 *  - everything else (posts, videos): the source's own id, as before.
 */
export type DedupeKind = "company" | "person" | "social";

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

export function dedupeIdentityFor(kind: DedupeKind): (row: any) => string | null {
  return kind === "company" ? companyDedupeIdentity : kind === "person" ? personDedupeIdentity : socialDedupeIdentity;
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
