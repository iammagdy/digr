import { extractNumberFromText } from "./arabicNumbers";
import {
  detectCountryFromText, detectIndustryFromText, getMissingCompanyResearchRequirements, isoCountryCodeFromName,
  isPeopleSearchRequest, requiredProfessionalContactFields,
} from "./planParameters";
import { withPeopleIdentity } from "./peopleSearchInput";
import { FOUNDED_RE, REVENUE_RE, SIZE_RE, stripConstraintPhrases } from "./requestConstraints";
import { ACCOUNT_LOOKUP_RE } from "./socialDiscovery";
import { detectSocialIntent, hasSocialSubject, socialSubjectText, type SocialPlatformId } from "./socialTasks";
import { detectTopicGathering } from "../functions/shared/topicGathering";

/**
 * The structured intent of ONE customer request, read by code from the customer's own words before any capability is
 * chosen: what kind of data, which activity and country, how many (digits, number words and the dual noun «شركتين»),
 * which contact fields, which constraints. The plan is then built from this intent and validated against what the
 * chosen capability accepts, so a model that copies the whole sentence into a provider field, or writes an Arabic job
 * title the source cannot match, can no longer change what is collected.
 */
export type DataType = "companies" | "people" | "posts" | "comments" | "videos" | "profile" | "studies" | "unknown";

export interface RequestIntent {
  dataType: DataType;
  platform: SocialPlatformId | null;
  discover: "keyword" | "channel" | "trending" | "target" | null;
  /** Social subject (keyword, hashtag, name) with verbs, platform, region and task words removed. */
  topic: string;
  industry: { arabic: string; keywordsEn: string[]; taxonomy: string[] } | null;
  country: { english: string; arabic: string; iso: string | undefined } | null;
  count: number | null;
  contactFields: Array<"work_email" | "phone">;
  /** English job titles for a people search (the source's data is English). */
  roles: string[];
  /** Things the customer asked for that the source cannot filter by; the relevance gate covers them. */
  unsupported: string[];
}

/** Arabic role words to the English title the source matches. Order matters: specific titles first. */
const ROLE_MAP: Array<{ re: RegExp; title: string }> = [
  { re: /\bceos?\b|الرئيس التنفيذي|الرؤساء التنفيذيين|رئيس تنفيذي/i, title: "CEO" },
  { re: /\bcfos?\b|المدير المالي|مدير مالي|مديرين ماليين/i, title: "CFO" },
  { re: /\bctos?\b|المدير التقني|مدير تقني/i, title: "CTO" },
  { re: /\bcoos?\b|مدير التشغيل|مدير تشغيل/i, title: "COO" },
  { re: /مدير عام|المدير العام|general managers?/i, title: "General Manager" },
  { re: /رئيس مجلس الإدارة|chairman/i, title: "Chairman" },
  { re: /\bfounders?\b|co-?founders?|مؤسس(?:ين)?/i, title: "Founder" },
  { re: /\bowners?\b|مالك(?:ي|ين)?|أصحاب الشركات/i, title: "Owner" },
  { re: /\bdirectors?\b|\bmanagers?\b|مدير(?:ين)?|مدراء/i, title: "Director" },
];

export function rolesFromText(text: string): string[] {
  const found: string[] = [];
  for (const { re, title } of ROLE_MAP) {
    if (re.test(text || "") && !found.includes(title)) found.push(title);
  }
  return found;
}

const SENTIMENT_RE = /(?:إيجابي|ايجابي|سلبي|محايد)(?:ة|ين|ات)?\s*(?:فقط)?|مشاعر|sentiment/i;
const LANGUAGE_RE = /بالعربي(?:ة)?\s*(?:فقط)?|بالإنجليزي(?:ة)?\s*(?:فقط)?|بالانجليزي(?:ة)?\s*(?:فقط)?|باللغة\s*(?:العربية|الإنجليزية|الانجليزية)/;

function unsupportedConstraints(text: string, dataType: DataType): string[] {
  const out: string[] = [];
  if (dataType === "companies" || dataType === "people") {
    if (SIZE_RE.test(text)) out.push("حجم الشركة أو عدد موظفيها");
    if (REVENUE_RE.test(text)) out.push("الإيرادات أو رأس المال");
    if (FOUNDED_RE.test(text)) out.push("سنة التأسيس");
  }
  if (dataType === "posts" || dataType === "comments" || dataType === "videos") {
    if (SENTIMENT_RE.test(text)) out.push("نوع الشعور (إيجابي أو سلبي)");
    if (LANGUAGE_RE.test(text)) out.push("لغة المحتوى");
  }
  return out;
}

/** Work email and phone, including the plural and dialect forms people actually write ("إيميلاتهم وأرقامهم"). */
function contactFieldsFrom(body: string): Array<"work_email" | "phone"> {
  const fields = new Set(requiredProfessionalContactFields(body) as Array<"work_email" | "phone">);
  if (/إيميل|ايميل|بريد|email/i.test(body)) fields.add("work_email");
  if (/(?<![\p{L}])(?:و)?(?:ال)?(?:أرقام|ارقام|رقم|هاتف|هواتف|تليفون|تليفونات|موبايل|موبايلات)|phone/iu.test(body)) fields.add("phone");
  return [...fields];
}

export function extractRequestIntent(text: string): RequestIntent {
  const original = (text || "").trim();
  // Counting and kind detection read the request without constraint phrases: «أكثر من ٥٠ موظف» is not 50 records.
  const body = stripConstraintPhrases(original);
  const social = detectSocialIntent(body);
  const country = detectCountryFromText(body);
  const industryRaw = detectIndustryFromText(body);
  const hasIndustry = Boolean(industryRaw.exactTaxonomy?.length);
  const people = isPeopleSearchRequest(body);

  let dataType: DataType = "unknown";
  if (detectTopicGathering(body)) dataType = "studies";
  else if (ACCOUNT_LOOKUP_RE.test(body)) dataType = "profile";
  else if (people) dataType = "people";
  else if (social.task === "comments") dataType = "comments";
  else if (social.task === "trending" || social.task === "channel_videos" || social.task === "video_search") dataType = "videos";
  else if (social.task === "x_posts" || social.task === "page_posts") dataType = "posts";
  else if (/شرك(?:ة|ات|تين|تان)|مؤسس(?:ة|ات|تين)|مصنع|مصانع|companies|company/i.test(body)) dataType = "companies";

  const roles = dataType === "people" ? rolesFromText(body) : [];
  const keywordsEn = (industryRaw.englishKeywords || []).filter((k) => /^[\x20-\x7E]+$/.test(k));
  const subject = dataType === "posts" || dataType === "comments" || dataType === "videos" ? socialSubjectText(body) : "";

  return {
    dataType,
    platform: social.platform,
    discover: social.discover,
    topic: subject,
    industry: hasIndustry ? { arabic: industryRaw.arabicLabel, keywordsEn, taxonomy: industryRaw.exactTaxonomy || [] } : null,
    country: country ? { english: country.canonicalEnglish, arabic: country.arabicLabel, iso: isoCountryCodeFromName(country.canonicalEnglish) } : null,
    count: extractNumberFromText(body) ?? null,
    contactFields: dataType === "people" ? contactFieldsFrom(body) : [],
    roles,
    unsupported: unsupportedConstraints(original, dataType),
  };
}

/** What a request of this kind still lacks before it can be priced; the first entry is the ONE question to ask. */
export function missingInputsForIntent(intent: RequestIntent, text: string): string[] {
  const missing: string[] = [];
  if (intent.dataType === "companies") {
    const gaps = getMissingCompanyResearchRequirements(text);
    if (gaps.includes("country")) missing.push("country");
    if (gaps.includes("industry")) missing.push("industry");
    if (intent.count === null) missing.push("count");
  } else if (intent.dataType === "people") {
    if (!intent.country) missing.push("country");
    if (!intent.industry && !/شركة|شركات|company/i.test(text)) missing.push("industry_or_company");
    if (intent.roles.length === 0 && !/صناع\s+(?:ال)?قرار|decision/i.test(text)) missing.push("roles");
    if (intent.count === null) missing.push("count");
  } else if (intent.dataType === "posts" || intent.dataType === "comments" || intent.dataType === "videos") {
    if (!intent.platform) missing.push("platform");
    else if (intent.discover === "keyword" && !hasSocialSubject(text)) missing.push("topic");
  }
  return missing;
}

/**
 * Provider parameters for a company search, in the form the catalog accepts: the country in English, the activity as the
 * source's taxonomy plus English keywords (the source's data is English). The customer's sentence never goes in.
 */
export function companyParamsFromIntent(intent: RequestIntent, current: Record<string, any> = {}, size?: number): Record<string, any> {
  const out: Record<string, any> = { ...current };
  // Keep what the plan already carries (for example keywords of a custom sector with no taxonomy) and set what the
  // customer's own words determine.
  const query: Record<string, any> = typeof current.query === "object" && current.query ? { ...current.query } : {};
  if (intent.country) query.location = { include: [intent.country.english] };
  if (intent.industry?.taxonomy.length) query.industry = { include: intent.industry.taxonomy };
  if (intent.industry?.keywordsEn.length) query.keyword = { include: intent.industry.keywordsEn };
  out.query = query;
  if (intent.country) { out.country = intent.country.english; out.location = intent.country.english; }
  if (intent.industry) out.industry = intent.industry.arabic;
  if (size && size > 0) out.pagination = { ...(typeof current.pagination === "object" ? current.pagination : {}), size };
  return out;
}

/**
 * Provider parameters for a people search: the job title as an English title, the activity as English keywords, the
 * country as an ISO code, and NO free-text copy of the request (it carries contact wording and the other words of the
 * sentence, which only add noise to the source's search).
 */
export function peopleParamsFromIntent(intent: RequestIntent, current: Record<string, any> = {}, limit?: number): Record<string, any> {
  const out: Record<string, any> = { ...current };
  delete out.q;
  delete out.company_domain;
  if (intent.roles.length) out.title = intent.roles[0];
  else if (typeof out.title === "string" && /[؀-ۿ]/.test(out.title)) delete out.title;
  if (intent.industry?.keywordsEn.length) out.keywords = intent.industry.keywordsEn;
  else if (Array.isArray(out.keywords)) out.keywords = out.keywords.filter((k: unknown) => typeof k === "string" && /^[\x20-\x7E]+$/.test(k));
  else delete out.keywords;
  if (intent.country) out.country = intent.country.iso || intent.country.english;
  if (limit && limit > 0) out.limit = limit;
  // «صناع القرار» names no role, and country, keywords and limit are filters, not an identity: without a title the source rejects the call.
  return withPeopleIdentity(out);
}

/** One honest sentence for the plan card when the customer asked for something the source cannot filter by. */
export function unsupportedConstraintsNoteAr(intent: RequestIntent): string | null {
  if (!intent.unsupported.length) return null;
  return `ملاحظة: المصدر لا يستطيع التصفية حسب ${intent.unsupported.join(" و")}. سنستلم النتائج ونراجع كل سجل بقواعد المطابقة، وما لا يطابق طلبك لا يُحتسب عليك.`;
}
