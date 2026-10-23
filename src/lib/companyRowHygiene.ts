import { normalizeEasternArabicDigits } from "./arabicNumbers";

/**
 * What a company row must look like before it is delivered. Pure (no network, no model): the same rules clean the rows of every source, so a page
 * title, a markdown fragment, a list article or a stray link never reaches the customer as company data.
 *
 *  - names: «Utopia Pharmaceutical: Home» is «Utopia Pharmaceutical»; markdown symbols are removed;
 *  - descriptions: headings, bold, links and images of a scraped page become plain text;
 *  - pages that are a LIST, a ranking, a directory or an article («Top 40 Pharmaceutical Companies…», a blog post, a news item) are not companies;
 *  - a website column holds a website: an e-mail address or a map link is not one (an e-mail moves to the e-mail column when that is empty);
 *  - a founding year is a plausible year or nothing («-1», «0», a future year are removed);
 *  - a phone with an international prefix that is not the requested country's is not delivered as that company's phone.
 */

/** Page words that end a title but are not part of a company's name. */
const GENERIC_TITLE_PART = /^(?:home|homepage|home page|welcome|welcome to|official(?:\s+(?:site|website|web\s*site))?|website|web\s*site|main|index|contact(?:\s+us)?|about(?:\s+us)?|الرئيسية|الصفحة الرئيسية|مرحبا(?:\s+بكم)?|أهلا(?:\s+بكم)?|الموقع الرسمي|الموقع|من نحن|اتصل بنا)$/iu;

/** Plain text from a scraped fragment: headings, emphasis, links, images, code, quotes, bullets and tags are removed; the words stay. */
export function cleanMarkdownText(value: unknown, options: { keepPipes?: boolean } = {}): string {
  let text = String(value ?? "");
  if (!text) return "";
  text = text
    .replace(/<[^>]{1,200}>/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s*/gm, "")
    .replace(/^\s*(?:[-*+•]|\d+[.)])\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(?=\S)(.*?\S)\1/g, "$2")
    .replace(/`+([^`]*)`+/g, "$1")
    .replace(options.keepPipes ? /[#*_`~]+/g : /[#*_`~|]+/g, " ")
    .replace(/&nbsp;|&amp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text;
}

/** A company's name from a page title or a heading: markdown removed, the page words after a separator («: Home», « | Welcome») dropped. */
export function cleanCompanyName(raw: unknown, host = ""): string {
  const text = cleanMarkdownText(raw, { keepPipes: true });
  if (!text) return host ? labelFromHost(host) : "";
  const parts = text.split(/\s*(?:[|•·»«–—]|\s-\s|\s:\s|:\s|:$)\s*/u).map((part) => part.trim()).filter(Boolean);
  const firstReal = parts.find((part) => !GENERIC_TITLE_PART.test(part));
  const name = (firstReal ?? "").replace(/^(?:welcome to|مرحبا بكم في|أهلا بكم في)\s+/iu, "").trim();
  return (name || (host ? labelFromHost(host) : text)).slice(0, 120);
}

function labelFromHost(host: string): string {
  const label = host.replace(/^www\./i, "").split(".")[0] || host;
  return label.replace(/[-_]+/g, " ").replace(/\b\p{L}/gu, (c) => c.toUpperCase());
}

/* ------------------------------------------------------------------ list, ranking, directory and article pages */

const LIST_TITLE = [
  /(?:^|\b)(?:top|best|leading|biggest|largest|major|famous|popular)\s+(?:\d{1,3}\s+)?(?:\w+\s+){0,4}(?:companies|company|firms|manufacturers|suppliers|brands|players|vendors|startups|businesses|contractors|agencies|distributors)\b/i,
  /\b\d{1,3}\s+(?:best|top|leading|biggest|largest|major|most)\b/i,
  /\b(?:list of|directory of|ranking of|rankings|league table|who's who|companies in|companies list|company list|business directory|yellow pages)\b/i,
  /\b(?:top|best)\s+\d{1,3}\b/i,
  /^\s*(?:the\s+)?\d{1,3}\s+(?:\w+\s+){0,3}(?:companies|firms|manufacturers|suppliers|brands)\b/i,
  /(?:^|\s)(?:أفضل|أكبر|أهم|أشهر|أبرز)\s+(?:\d+\s+)?(?:\S+\s+){0,3}(?:شركات|شركة|مصانع|مؤسسات|موردين|علامات)/u,
  /(?:^|\s)(?:قائمة|دليل|ترتيب|تصنيف)\s+(?:\S+\s+){0,3}(?:شركات|الشركات|المصانع|المؤسسات)/u,
  /\d+\s+(?:شركات|شركة)\s+(?:رائدة|كبرى|الأفضل|الأكبر)/u,
];
const ARTICLE_TITLE = /\b(?:how to|what is|what are|why |guide to|ultimate guide|step[- ]by[- ]step|market (?:size|report|share|analysis|outlook|forecast|trends?)|industry (?:report|analysis|trends?|outlook)|forecast|case study|white ?paper|press release|news|blog|article|opinion|podcast|webinar|interview|vs\.?|versus|review(?:s)?|salary|salaries|jobs?|careers?|hiring)\b/i;
const ARTICLE_TITLE_AR = /(?:كيف|ما هي|ما هو|لماذا|دليل شامل|تقرير(?:\s+السوق)?|حجم السوق|تحليل السوق|توقعات|دراسة حالة|خبر|أخبار|مقال|رأي|مراجعة|وظائف|رواتب)/u;

export function isListOrArticleTitle(title: unknown): boolean {
  const text = cleanMarkdownText(title);
  if (!text) return false;
  return LIST_TITLE.some((re) => re.test(text)) || ARTICLE_TITLE.test(text) || ARTICLE_TITLE_AR.test(text);
}

/** A path that belongs to an article, a list or a directory, not to a company's own pages. */
const ARTICLE_PATH = /(?:^|\/)(?:blog|blogs|news|newsroom|press|press-?releases?|article|articles|post|posts|story|stories|insights?|resources?|magazine|knowledge|learn|wiki|topics?|tag|tags|category|categories|directory|directories|listing|listings|list|lists|ranking|rankings|top-[a-z0-9-]+|best-[a-z0-9-]+|companies|company-list|reports?|research|whitepapers?|webinars?|events?|jobs|careers)(?:\/|$|\.)/i;

export function isListOrArticleUrl(url: unknown): boolean {
  let parsed: URL;
  try { parsed = new URL(/^https?:\/\//i.test(String(url)) ? String(url) : `https://${String(url)}`); } catch { return false; }
  const path = decodeURIComponent(parsed.pathname).toLowerCase();
  if (ARTICLE_PATH.test(path)) return true;
  const segments = path.split("/").filter(Boolean);
  // a long hyphenated slug at any depth is the headline of an article (a company's own pages are «about», «contact», «products»)
  return segments.some((segment) => segment.split("-").length >= 5);
}

/** Why a search hit or a record is not a company, in plain Arabic; null when nothing says so. */
export function nonCompanyReasonAr(row: { title?: unknown; company_name?: unknown; name?: unknown; url?: unknown; website?: unknown; page_url?: unknown }): string | null {
  const title = row.company_name ?? row.name ?? row.title;
  if (isListOrArticleTitle(title)) return "الصفحة قائمة أو ترتيب أو مقال عن شركات، وليست شركة بذاتها";
  const link = row.page_url ?? row.url ?? row.website;
  if (typeof link === "string" && link && isListOrArticleUrl(link)) return "رابط الصفحة لمقال أو قائمة أو دليل، وليس موقع الشركة نفسها";
  return null;
}

/* ------------------------------------------------------------------ website, year, phone */

const MAP_HOST = /(?:^|\.)(?:maps\.google\.[a-z.]+|google\.[a-z.]+\/maps|goo\.gl\/maps|maps\.app\.goo\.gl|g\.page|share\.google|waze\.com|maps\.apple\.com|bing\.com\/maps|openstreetmap\.org)/i;
const EMAIL_VALUE = /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/;

/** True when a value in the website column is not a website: an e-mail address, a map link, or a place link of a search engine. */
export function isNotAWebsite(value: unknown): boolean {
  const text = String(value ?? "").trim();
  if (!text) return false;
  if (EMAIL_VALUE.test(text.replace(/^mailto:/i, ""))) return true;
  if (/^mailto:|^tel:/i.test(text)) return true;
  const probe = text.replace(/^https?:\/\//i, "").replace(/^www\./i, "");
  if (MAP_HOST.test(probe)) return true;
  if (/^google\.[a-z.]+\/(?:maps|search|local)/i.test(probe)) return true;
  return false;
}

/** The founding year as a plain 4-digit year, or "" when the value is not a plausible one («-1», «0», a text, a future year). */
export function cleanFoundedYear(value: unknown, now: Date = new Date()): string {
  const text = normalizeEasternArabicDigits(String(value ?? "")).trim();
  if (!/^\d{4}$/.test(text)) return "";
  const year = Number(text);
  return year >= 1000 && year <= now.getUTCFullYear() ? String(year) : "";
}

/** Calling codes of the countries requests come for (ISO 3166 alpha-2). */
export const CALLING_CODES: Record<string, string> = {
  EG: "20", SA: "966", AE: "971", KW: "965", QA: "974", BH: "973", OM: "968", JO: "962", LB: "961", IQ: "964", SY: "963", PS: "970", YE: "967",
  MA: "212", DZ: "213", TN: "216", LY: "218", SD: "249", US: "1", CA: "1", GB: "44", DE: "49", FR: "33", IT: "39", ES: "34", PT: "351", NL: "31",
  BE: "32", CH: "41", AT: "43", SE: "46", NO: "47", DK: "45", FI: "358", IE: "353", PL: "48", GR: "30", TR: "90", RU: "7", UA: "380",
  IN: "91", PK: "92", BD: "880", CN: "86", JP: "81", KR: "82", SG: "65", MY: "60", ID: "62", TH: "66", VN: "84", PH: "63", AU: "61", NZ: "64",
  ZA: "27", NG: "234", KE: "254", ET: "251", GH: "233", BR: "55", AR: "54", MX: "52", CL: "56", CO: "57", IL: "972", IR: "98",
};

/**
 * True when a phone carries an international prefix (+ or 00) that is NOT the requested country's. A number with no prefix says nothing about
 * its country, so it is never judged; an unknown country is never judged either.
 */
export function phoneHasForeignPrefix(phone: unknown, countryIso: string | null | undefined): boolean {
  const iso = String(countryIso || "").toUpperCase();
  const code = CALLING_CODES[iso];
  if (!code) return false;
  const text = String(phone ?? "").trim().replace(/[\s().-]/g, "");
  const m = /^(?:\+|00)(\d{1,4})/.exec(text);
  if (!m) return false;
  return !text.replace(/^00/, "+").startsWith(`+${code}`);
}

export const STATUS_UNVERIFIED_FIELD_AR = "لم يتم التحقق";

export interface HygieneContext { countryIso?: string | null; now?: Date }

/**
 * A delivered company row, cleaned. Returns a new object; keys it does not know are untouched. The phone of a foreign prefix is not delivered
 * and its status says it was not verified; an e-mail found in the website column is moved to the e-mail column when that one is empty.
 */
export function cleanCompanyRecord<T extends Record<string, any>>(row: T, context: HygieneContext = {}): T {
  const out: Record<string, any> = { ...row };
  const hasName = typeof out.company_name === "string" && out.company_name;
  if (hasName) out.company_name = cleanCompanyName(out.company_name);
  if (typeof out.description === "string" && out.description) out.description = cleanMarkdownText(out.description);
  for (const key of ["website", "website_url", "company_website", "domain"] as const) {
    const value = out[key];
    if (typeof value === "string" && isNotAWebsite(value)) {
      const email = value.trim().replace(/^mailto:/i, "");
      if (EMAIL_VALUE.test(email) && !out.work_email && !out.email) out.work_email = email;
      out[key] = "";
    }
  }
  if ("founded_year" in out) out.founded_year = cleanFoundedYear(out.founded_year, context.now);
  if (context.countryIso) {
    for (const key of ["phone", "phone_number", "business_phone"] as const) {
      if (typeof out[key] === "string" && out[key] && phoneHasForeignPrefix(out[key], context.countryIso)) {
        out[key] = "";
        if ("phone_verification_status" in out || key === "phone") out.phone_verification_status = STATUS_UNVERIFIED_FIELD_AR;
      }
    }
  }
  return out as T;
}

/** The phones a page lists, with those of a foreign prefix marked «unverified» (they stay listed so the reason is traceable; they are never delivered as verified). */
export function markForeignPhones<T extends { value: string; status: string; reason?: string }>(phones: T[], countryIso: string | null | undefined): T[] {
  if (!countryIso) return phones;
  return phones.map((phone) => (phone.status === "verified" && phoneHasForeignPrefix(phone.value, countryIso) ? { ...phone, status: "unverified", reason: "country_prefix_mismatch" } : phone));
}
