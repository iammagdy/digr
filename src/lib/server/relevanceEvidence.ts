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

const ARABIC_LETTERS = /[\u0621-\u064A]/;
const ARABIC_DIACRITICS = /[\u064B-\u065F\u0670\u0640]/g;

/** Words that name a kind of business, not the activity: dropped from the customer's Arabic activity words. */
const ARABIC_STOP_STEMS = new Set(["شرك", "مؤسس", "خدم", "قطاع", "مجال", "صناع", "اعمال", "نشاط", "منشا"]);

/** Letters folded so the usual spelling variants meet: alef forms, ya/alef-maqsura, ta marbuta, no diacritics or tatweel. */
export function normalizeArabic(text: string): string {
  return String(text || "")
    .replace(ARABIC_DIACRITICS, "")
    .replace(/[\u0623\u0625\u0622\u0671]/g, "\u0627")
    .replace(/\u0649/g, "\u064A")
    .replace(/\u0629/g, "\u0647");
}

/**
 * Light Arabic stem, applied the same way to the customer's word and to the row's word: without the definite article or a
 * one-letter prefix, without the common plural/feminine/relative endings, and without the agent/noun prefix م/ت
 * («تطوير», «مطوّر», «مطورين» meet at «طور»; «عقار», «عقارات», «العقارية» at «عقار»).
 */
export function stemArabic(word: string): string {
  let token = normalizeArabic(word).replace(/[^\u0621-\u064A]/g, "");
  token = token.replace(/^(?:وال|بال|كال|فال|لل|ال)/, "");
  if (token.length > 4) token = token.replace(/^[وبلف]/, "");
  // up to two endings: «عقاريون» is «عقاري» + «ون», and «عقاري» is «عقار» + «ي»
  for (let pass = 0; pass < 2; pass += 1) {
    const suffix = ["ات", "ون", "ين", "ان", "يه", "ها", "ه", "ي"].find((ending) => token.length - ending.length >= 3 && token.endsWith(ending));
    if (!suffix) break;
    token = token.slice(0, token.length - suffix.length);
  }
  if (token.length >= 4) token = token.replace(/^[مت]/, "");
  if (token.length === 4) token = token.replace(/^(.{2})\u064A(.)$/, "$1$2");
  return token;
}

function arabicTokens(text: string): string[] {
  return normalizeArabic(text).split(/[^\u0621-\u064A]+/).filter((token) => token.length > 1);
}

/** The customer's Arabic activity words, one phrase each (a phrase breaks at a «و» conjunction), as lists of stems. */
export function arabicKeywordPhrases(keywords: unknown[]): string[][] {
  const phrases: string[][] = [];
  for (const keyword of keywords || []) {
    if (typeof keyword !== "string" || !ARABIC_LETTERS.test(keyword)) continue;
    let current: string[] = [];
    const flush = () => { if (current.length > 0) phrases.push([...new Set(current)]); current = []; };
    for (const token of arabicTokens(keyword)) {
      if (/^و.{3,}/.test(token) && !/^وال?$/.test(token)) flush();
      const stem = stemArabic(token);
      if (stem.length >= 3 && !ARABIC_STOP_STEMS.has(stem)) current.push(stem);
    }
    flush();
  }
  return phrases;
}

/** True when at least one keyword phrase of the request appears (every word of it) in the row's own text. */
export function hasActivityEvidence(row: Record<string, any>, keywords: unknown[]): boolean {
  const text = evidenceText(row);
  const english = keywordPhrases(keywords);
  if (english.length > 0) {
    const rowStems = text.toLowerCase().split(/[^a-z]+/).filter((token) => token.length > 2).map(stemEnglish);
    const has = (stem: string): boolean => rowStems.some((token) => token === stem || (stem.length >= 5 && token.startsWith(stem)));
    if (rowStems.length > 0 && english.some((phrase) => phrase.every(has))) return true;
  }
  const arabic = arabicKeywordPhrases(keywords);
  if (arabic.length > 0) {
    const rowArabic = new Set(arabicTokens(text).map(stemArabic));
    if (rowArabic.size > 0 && arabic.some((phrase) => phrase.every((stem) => rowArabic.has(stem)))) return true;
  }
  return false;
}

/**
 * The activity keywords of a company request: the planner's `query.keyword.include`, plus `activityKeywords` when the
 * caller passes the detected sector's English words, plus the customer's own Arabic activity words (the plan's `industry`
 * label, taken from the structured intent): the source's rows are written in English or Arabic, and a company that says
 * «شركة تطوير عقاري» does what a request for «التطوير العقاري» asks for.
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
  const arabicIndustry = params?.industry;
  if (typeof arabicIndustry === "string" && ARABIC_LETTERS.test(arabicIndustry) && arabicKeywordPhrases([arabicIndustry]).length > 0) out.push(arabicIndustry);
  return [...new Set(out.map((keyword) => keyword.trim()).filter(Boolean))];
}
