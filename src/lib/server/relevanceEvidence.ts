/**
 * Positive evidence of the requested ACTIVITY in a company row's own text.
 *
 * A source label ("Utilities", "Electrical/Electronic Manufacturing") is what WE ask the source for, so it can never be
 * the reason a row is delivered and charged. Evidence is a keyword of the request (the planner's English activity
 * words) found in the row's own name, description, specialties or keywords, never in its industry label. The keywords
 * come from the request, so there is no per-sector word list to grow. Deterministic and offline.
 */

/** Fields that describe what the company does. `industry` (the source label) is deliberately NOT here. */
export const EVIDENCE_FIELDS = ["company_name", "name", "description", "specialties", "keywords", "tagline", "summary", "industry_description"] as const;

const KEYWORD_STOP_WORDS = new Set(["and", "or", "of", "the", "for", "in", "to", "a", "an", "services", "service", "company", "companies"]);

const SUFFIXES = ["ically", "ical", "icity", "ities", "ity", "ics", "ic", "ing", "ions", "ion", "ors", "or", "ers", "er", "ies", "es", "s"];

/** Light English stem: "electrical", "electricity" and "electric" meet at "electr"; "contracting" and "contractor" at "contract". */
export function stemEnglish(word: string): string {
  const token = word.toLowerCase().replace(/[^a-z]/g, "");
  for (const suffix of SUFFIXES) {
    if (token.length - suffix.length >= 4 && token.endsWith(suffix)) return token.slice(0, token.length - suffix.length);
  }
  return token;
}

function fieldText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.filter((item) => typeof item === "string").join(" ");
  return "";
}

/** The row's own descriptive text (never the industry label), as one string. */
export function evidenceText(row: Record<string, any>): string {
  return EVIDENCE_FIELDS.map((field) => fieldText(row?.[field])).filter(Boolean).join(" ");
}

/** The request's English activity keywords, one phrase each, as lists of stems. A phrase needs ALL its words to count. */
export function keywordPhrases(keywords: unknown[]): string[][] {
  const phrases: string[][] = [];
  for (const keyword of keywords || []) {
    if (typeof keyword !== "string") continue;
    const tokens = keyword.toLowerCase().split(/[^a-z]+/).filter((token) => token.length > 2 && !KEYWORD_STOP_WORDS.has(token));
    const stems = [...new Set(tokens.map(stemEnglish).filter((stem) => stem.length >= 3))];
    if (stems.length > 0) phrases.push(stems);
  }
  return phrases;
}

/** True when at least one keyword phrase of the request appears (every word of it) in the row's own text. */
export function hasActivityEvidence(row: Record<string, any>, keywords: unknown[]): boolean {
  const phrases = keywordPhrases(keywords);
  if (phrases.length === 0) return false;
  const rowStems = evidenceText(row).toLowerCase().split(/[^a-z]+/).filter((token) => token.length > 2).map(stemEnglish);
  if (rowStems.length === 0) return false;
  const has = (stem: string): boolean => rowStems.some((token) => token === stem || (stem.length >= 5 && token.startsWith(stem)));
  return phrases.some((phrase) => phrase.every(has));
}

/**
 * The activity keywords of a company request: the planner's `query.keyword.include`, plus `activityKeywords` when the
 * caller passes the detected sector's English words. Latin words only (the source's data is English).
 */
export function companyActivityKeywords(params: Record<string, any> | undefined | null): string[] {
  const out: string[] = [];
  const add = (value: unknown) => {
    if (typeof value === "string" && /[a-z]/i.test(value)) out.push(value);
    else if (Array.isArray(value)) value.forEach(add);
  };
  const query = params?.query;
  if (query && typeof query === "object") add((query as any).keyword?.include);
  add(params?.activityKeywords);
  return [...new Set(out.map((keyword) => keyword.trim()).filter(Boolean))];
}
