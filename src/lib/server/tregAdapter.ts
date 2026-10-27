import { MODEL_PLAN_SLUG } from "../modelPlanner/constants";
import { runModelPlanChunk } from "../modelPlanner/interpreter";
import { getMissionManager } from "../modelPlanner/manager";
import { executeTregCall, TregCallOptions, TregCallResult, serializeProviderParams } from "../../functions/shared/tregClient";
import { JOB_BUDGET_STOP_AR } from "./callBudget";
import { evaluateResearchRowRelevance } from "./researchRelevanceGate";
import { buildPeopleIdentity, companyDomainFromWebsite, emailDomain, identityScore, isPersonalEmail, returnedPersonMatches } from "../peopleIdentity";
import { getEndpointDetails } from "../../functions/shared/catalogClient";
import {
  extractAndFlattenRows,
  parseTikTokProfileResponse,
  parseIcypeasCompaniesResponse,
} from "../../functions/shared/multiStepWorker";
import { getLiveProviderGateStatus } from "./providerGate";
import { resolveProviderKey } from "./providerKeys";
import { findProviderNextCursor, hasRecognizedProviderResultShape } from "./providerRows";
import { isSocialCapabilitySlug } from "../socialSources";
import { isFacebookTopicReport } from "../facebookReport/constants";
import { runFacebookReportChunk } from "./facebookReportAdapter";
import { runSocialChunk, type SocialCall, type VideoSelector } from "./socialAdapter";
import { markContactRowsForReview } from "../../functions/shared/decisionMakerPricing";
import {
  createDecisionMakerSpendBudget,
  DECISION_MAKER_EMAIL_ROUTE_COST_CAP_USD,
  DECISION_MAKER_ROUTE_COST_CAP_USD,
  DECISION_MAKER_VERIFY_ROUTE_COST_CAP_USD,
  decisionMakerJobSpendCeilingUsd,
} from "./decisionMakerSpend";
import { createCachedMailDomainResolver, currentMailDomainResolver, takesMail, type MailDomainStatus } from "./mailDomainCheck";

export { hasRecognizedProviderResultShape };
import { arabicVerificationStatus } from "../contactVerification";
import { withPeopleIdentity } from "../peopleSearchInput";
import {
  PROVIDER_BUSY_AR,
  PROVIDER_GENERIC_FAILURE_AR,
  PROVIDER_INCOMPATIBLE_ANSWER_AR,
  PROVIDER_INPUT_REJECTED_AR,
  PROVIDER_ROUTE_COST_EXCEEDED_AR,
  PROVIDER_TARGET_NOT_FOUND_AR,
  PROVIDER_TIMEOUT_AR,
  PROVIDER_UNAVAILABLE_AR,
} from "../providerFailureText";
import {
  detectCountryFromText as detectInternationalCountryFromText,
  detectIndustryFromText as detectInternationalIndustryFromText,
  getMissingCompanyResearchRequirements,
  isoCountryCodeFromName,
} from "../planParameters";

/**
 * Normalizes company search parameters (Arabic/English terms) into Icypeas API shape:
 * POST /find-companies with { query: { location, keyword, industry }, pagination: { size, token } }
 */
export interface CountryMapping {
  canonicalEnglish: string;
  arabicLabel: string;
}

export interface IndustryMapping {
  englishKeywords: string[];
  arabicLabel: string;
  exactTaxonomy?: string[];
}

export function detectCountryFromText(text: string): CountryMapping | null {
  if (!text || typeof text !== "string") return null;
  const t = text.toLowerCase().trim();

  if (t.includes("ليختنشتاين") || t.includes("liechtenstein")) {
    return { canonicalEnglish: "Liechtenstein", arabicLabel: "ليختنشتاين" };
  }
  if (t.includes("ألمانيا") || t.includes("المانيا") || t.includes("germany") || t.includes("deutschland")) {
    return { canonicalEnglish: "Germany", arabicLabel: "ألمانيا" };
  }
  if (t.includes("النمسا") || t.includes("austria") || t.includes("österreich")) {
    return { canonicalEnglish: "Austria", arabicLabel: "النمسا" };
  }
  if (
    t.includes("السعودية") ||
    t.includes("المملكة العربية السعودية") ||
    t.includes("saudi") ||
    t.includes("ksa")
  ) {
    return { canonicalEnglish: "Saudi Arabia", arabicLabel: "المملكة العربية السعودية" };
  }
  if (
    t.includes("الإمارات") ||
    t.includes("الامارات") ||
    t.includes("دبي") ||
    t.includes("أبوظبي") ||
    t.includes("ابوظبي") ||
    t.includes("uae") ||
    t.includes("emirates")
  ) {
    return { canonicalEnglish: "United Arab Emirates", arabicLabel: "الإمارات العربية المتحدة" };
  }
  if (
    t.includes("مصر") ||
    t.includes("القاهرة") ||
    t.includes("الإسكندرية") ||
    t.includes("الاسكندرية") ||
    t.includes("الجيزة") ||
    t.includes("egypt") ||
    t.includes("cairo")
  ) {
    return { canonicalEnglish: "Egypt", arabicLabel: "مصر" };
  }
  if (t.includes("الكويت") || t.includes("kuwait")) {
    return { canonicalEnglish: "Kuwait", arabicLabel: "الكويت" };
  }
  if (t.includes("قطر") || t.includes("qatar")) {
    return { canonicalEnglish: "Qatar", arabicLabel: "قطر" };
  }
  if (t.includes("البحرين") || t.includes("bahrain")) {
    return { canonicalEnglish: "Bahrain", arabicLabel: "البحرين" };
  }
  if (t.includes("عمان") || t.includes("سلطنة عمان") || t.includes("oman")) {
    return { canonicalEnglish: "Oman", arabicLabel: "سلطنة عمان" };
  }
  if (t.includes("الأردن") || t.includes("الاردن") || t.includes("jordan")) {
    return { canonicalEnglish: "Jordan", arabicLabel: "الأردن" };
  }
  if (t.includes("المملكة المتحدة") || t.includes("بريطانيا") || t.includes("إنجلترا") || t.includes("uk") || t.includes("united kingdom")) {
    return { canonicalEnglish: "United Kingdom", arabicLabel: "المملكة المتحدة" };
  }
  if (t.includes("الولايات المتحدة") || t.includes("أمريكا") || t.includes("امريكا") || t.includes("usa") || t.includes("united states")) {
    return { canonicalEnglish: "United States", arabicLabel: "الولايات المتحدة" };
  }
  if (t.includes("فرنسا") || t.includes("france")) {
    return { canonicalEnglish: "France", arabicLabel: "فرنسا" };
  }
  if (t.includes("إيطاليا") || t.includes("ايطاليا") || t.includes("italy")) {
    return { canonicalEnglish: "Italy", arabicLabel: "إيطاليا" };
  }
  if (t.includes("إسبانيا") || t.includes("اسبانيا") || t.includes("spain")) {
    return { canonicalEnglish: "Spain", arabicLabel: "إسبانيا" };
  }
  if (t.includes("سويسرا") || t.includes("switzerland")) {
    return { canonicalEnglish: "Switzerland", arabicLabel: "سويسرا" };
  }
  if (t.includes("هولندا") || t.includes("netherlands") || t.includes("holland")) {
    return { canonicalEnglish: "Netherlands", arabicLabel: "هولندا" };
  }
  if (t.includes("تركيا") || t.includes("turkey") || t.includes("türkiye")) {
    return { canonicalEnglish: "Turkey", arabicLabel: "تركيا" };
  }

  return detectInternationalCountryFromText(text);
}

// One industry detector for planning, provider requests and relevance review, so the three can never disagree.
export const detectIndustryFromText = detectInternationalIndustryFromText;

/**
 * Validates whether a company record returned from provider genuinely matches requested location.
 */
export function isCompanyRowMatchingLocation(row: Record<string, any>, expectedCountryCanonical?: string | null): boolean {
  if (!expectedCountryCanonical) return true;
  const targetLower = expectedCountryCanonical.toLowerCase().trim();
  const rowLoc = String(row.location || row.address || row.country || row.city || "").toLowerCase();
  const rowWeb = String(row.website || row.linkedin_url || "").toLowerCase();
  const rowDesc = String(row.description || "").toLowerCase();

  if (targetLower.includes("liechtenstein")) {
    return (
      rowLoc.includes("liechtenstein") ||
      rowLoc.includes("balzers") ||
      rowLoc.includes("vaduz") ||
      rowLoc.includes("schaan") ||
      rowWeb.includes(".li") ||
      rowDesc.includes("liechtenstein")
    );
  }
  if (targetLower.includes("saudi")) {
    return (
      rowLoc.includes("saudi") ||
      rowLoc.includes("riyadh") ||
      rowLoc.includes("jeddah") ||
      rowLoc.includes("dammam") ||
      rowLoc.includes("khobar") ||
      rowWeb.includes(".sa") ||
      rowLoc.includes("السعودية") ||
      rowLoc.includes("المملكة العربية السعودية")
    );
  }
  if (targetLower.includes("emirates") || targetLower.includes("uae")) {
    return (
      rowLoc.includes("emirates") ||
      rowLoc.includes("uae") ||
      rowLoc.includes("dubai") ||
      rowLoc.includes("abu dhabi") ||
      rowLoc.includes("sharjah") ||
      rowWeb.includes(".ae") ||
      rowLoc.includes("الإمارات") ||
      rowLoc.includes("الامارات") ||
      rowLoc.includes("دبي")
    );
  }
  if (targetLower.includes("germany")) {
    return (
      rowLoc.includes("germany") ||
      rowLoc.includes("deutschland") ||
      rowLoc.includes("berlin") ||
      rowLoc.includes("munich") ||
      rowLoc.includes("münchen") ||
      rowLoc.includes("essen") ||
      rowLoc.includes("frankfurt") ||
      rowLoc.includes("hamburg") ||
      rowWeb.includes(".de") ||
      rowLoc.includes("ألمانيا")
    );
  }
  if (targetLower.includes("egypt")) {
    return (
      rowLoc.includes("egypt") ||
      rowLoc.includes("cairo") ||
      rowLoc.includes("giza") ||
      rowLoc.includes("alexandria") ||
      rowWeb.includes(".eg") ||
      rowLoc.includes("مصر") ||
      rowLoc.includes("القاهرة") ||
      rowLoc.includes("الجيزة")
    );
  }
  if (targetLower.includes("austria")) {
    return (
      rowLoc.includes("austria") ||
      rowLoc.includes("österreich") ||
      rowLoc.includes("vienna") ||
      rowLoc.includes("wien") ||
      rowWeb.includes(".at") ||
      rowLoc.includes("النمسا")
    );
  }

  return rowLoc.includes(targetLower) || rowDesc.includes(targetLower);
}

function extractAllStrings(val: any): string[] {
  if (!val) return [];
  if (typeof val === "string") return [val];
  if (Array.isArray(val)) return val.flatMap(extractAllStrings);
  if (typeof val === "object") {
    return Object.values(val).flatMap(extractAllStrings);
  }
  return [];
}

/**
 * Normalizes company search parameters (Arabic/English terms) into Icypeas API shape:
 * POST /find-companies with { query: { location, keyword, industry }, pagination: { size, token } }
 * NEVER defaults country to Egypt. Extracts true country and industry from user parameters.
 */
/** Latin-only, trimmed, non-empty strings of a `{ include: [...] }` filter; the source's data is English. */
function latinIncludeList(filter: unknown): string[] {
  const list = (filter as any)?.include;
  if (!Array.isArray(list)) return [];
  return [...new Set(list
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => value.length > 0 && /^[\x20-\x7E]+$/.test(value)))];
}

/**
 * The structured query the planner produced (country in English, activity as the source's industry filter or English
 * keywords). It is what gets sent when its country is a real one; the sentence text only fills what it leaves out.
 */
function structuredCompanyQuery(rawParams: Record<string, any>): { country: string; industry: string[]; keyword: string[] } | null {
  const query = rawParams?.query;
  if (!query || typeof query !== "object" || Array.isArray(query)) return null;
  for (const name of latinIncludeList(query.location)) {
    const country = detectCountryFromText(name);
    if (country && name.trim().toLowerCase() === country.canonicalEnglish.toLowerCase()) {
      return { country: country.canonicalEnglish, industry: latinIncludeList(query.industry), keyword: latinIncludeList(query.keyword) };
    }
  }
  return null;
}

/**
 * A cursor produced by the keywords-only retry belongs to THAT query, so it carries this marker and the next page is
 * sent with the same query. A page never changes the query it paginates.
 */
export const KEYWORDS_ONLY_CURSOR_PREFIX = "kw~";

/** The broad source label that returns water, filters, travel and junk when it is the only activity filter. */
const BROAD_INDUSTRY_LABEL = "Utilities";

export interface IcypeasCompanyQueryOptions {
  /** Send the activity keywords only (no industry labels): the one retry of a narrow query that found nothing. */
  keywordsOnly?: boolean;
}

/**
 * The activity filters of a company request. For every sector the previous rule holds exactly: the industry labels are the
 * filter, and keywords are sent alone only when there is no taxonomy. The one exception is a taxonomy that includes the
 * broad label «Utilities» (electricity, general energy): that label returns water, filters and travel when it stands
 * alone, so it is sent together with the activity keywords (the provider ANDs them), and never without keywords.
 */
function companyActivityFilters(
  industry: string[],
  keyword: string[],
  textFallback: () => { exactTaxonomy?: string[]; englishKeywords?: string[] },
): { industry: string[]; keyword: string[] } {
  let labels = industry;
  let words = keyword;
  if (labels.length === 0 && words.length === 0) {
    const detected = textFallback();
    if (detected.exactTaxonomy?.length) labels = detected.exactTaxonomy;
    else words = detected.englishKeywords || [];
  }
  if (labels.length === 0) return { industry: [], keyword: words };
  if (!labels.includes(BROAD_INDUSTRY_LABEL)) return { industry: labels, keyword: [] };
  if (words.length === 0) words = textFallback().englishKeywords || [];
  if (words.length === 0) labels = labels.filter((label) => label !== BROAD_INDUSTRY_LABEL);
  return { industry: labels, keyword: words };
}

export function normalizeIcypeasCompanyParams(
  rawParams: Record<string, any>,
  pageSize: number,
  cursor?: string | null,
  options: IcypeasCompanyQueryOptions = {},
): Record<string, any> {
  const structured = structuredCompanyQuery(rawParams);
  const size = Math.max(1, Math.min(100, pageSize || 5));
  const pagination: Record<string, any> = { size };
  if (cursor && String(cursor).trim()) pagination.token = String(cursor).trim();

  if (structured) {
    const filters = companyActivityFilters(structured.industry, structured.keyword, () => detectIndustryFromText(extractAllStrings(rawParams).join(" ")));
    const finalStructuredQuery: Record<string, any> = { location: { include: [structured.country] } };
    if (filters.industry.length > 0 && !options.keywordsOnly) finalStructuredQuery.industry = { include: filters.industry };
    if (filters.keyword.length > 0) finalStructuredQuery.keyword = { include: filters.keyword };
    return { query: finalStructuredQuery, pagination };
  }

  const fullPromptText = extractAllStrings(rawParams).join(" ");

  // 1. Detect Country without hidden default
  let detectedCountry =
    detectCountryFromText(rawParams?.country || "") ||
    detectCountryFromText(rawParams?.location || "") ||
    detectCountryFromText(fullPromptText);

  // 2. Detect Industry
  const detectedIndustry = detectIndustryFromText(fullPromptText);
  const missingRequirements = getMissingCompanyResearchRequirements(fullPromptText);

  const finalQuery: Record<string, any> = {};

  if (detectedCountry && !missingRequirements.includes("country")) {
    finalQuery.location = { include: [detectedCountry.canonicalEnglish] };
  }

  if (!missingRequirements.includes("industry")) {
    const filters = companyActivityFilters(detectedIndustry.exactTaxonomy || [], [], () => detectedIndustry);
    if (filters.industry.length > 0 && !options.keywordsOnly) finalQuery.industry = { include: filters.industry };
    if (filters.keyword.length > 0) finalQuery.keyword = { include: filters.keyword };
  }

  return {
    query: finalQuery,
    pagination,
  };
}

/**
 * Normalizes decision maker / people search parameters into Icypeas API shape:
 * POST /find-people with { query: { location, currentJobTitle }, pagination: { size, token } }
 */
export function normalizeIcypeasPeopleParams(
  rawParams: Record<string, any>,
  pageSize: number,
  cursor?: string | null
): Record<string, any> {
  const fullPromptText = extractAllStrings(rawParams).join(" ");

  const detectedCountry =
    detectCountryFromText(rawParams?.country || "") ||
    detectCountryFromText(rawParams?.location || "") ||
    detectCountryFromText(fullPromptText);

  const finalQuery: Record<string, any> = {};

  if (detectedCountry) {
    finalQuery.location = { include: [detectedCountry.canonicalEnglish] };
  }

  let title = "";
  const t = fullPromptText.toLowerCase();
  if (t.includes("ceo") || t.includes("رئيس تنفيذي") || t.includes("الرئيس التنفيذي")) {
    title = "CEO";
  } else if (t.includes("cto") || t.includes("مدير تقني") || t.includes("المدير التقني")) {
    title = "CTO";
  } else if (t.includes("cfo") || t.includes("مدير مالي") || t.includes("المدير المالي")) {
    title = "CFO";
  } else if (t.includes("founder") || t.includes("مؤسس")) {
    title = "Founder";
  } else if (t.includes("director") || t.includes("مدير")) {
    title = "Director";
  }

  if (title) finalQuery.currentJobTitle = { include: [title] };

  const detectedIndustry = detectIndustryFromText(fullPromptText);
  if (detectedIndustry.exactTaxonomy?.length) {
    finalQuery.keyword = { include: detectedIndustry.englishKeywords };
  }

  const effectiveSize = Math.max(1, Math.min(100, pageSize || 5));
  const paginationObj: Record<string, any> = {
    size: effectiveSize,
  };

  if (cursor && String(cursor).trim()) {
    paginationObj.token = String(cursor).trim();
  }

  return {
    query: finalQuery,
    pagination: paginationObj,
  };
}

export function normalizeTregPeopleParams(rawParams: Record<string, any>, pageSize: number): Record<string, any> {
  const raw = rawParams || {};
  const query = raw.query && typeof raw.query === "object" ? raw.query : {};
  const first = (value: any) => Array.isArray(value) ? value[0] : value;
  const q = raw.q || raw.search || (typeof raw.query === "string" ? raw.query : undefined);
  const title = raw.title || first(query.title) || first(query.jobTitle?.include) || first(query.currentJobTitle?.include);
  const location = raw.location || first(query.location?.include) || first(query.location);
  const keywords = Array.isArray(raw.keywords) ? raw.keywords : query.keyword?.include;
  // The source identifies a person search by q, company_domain, title or full_name; country, location, keywords and limit only filter it.
  // A plan made before this rule (or one that names no role) still gets an identity here, so no call goes out that the source must refuse.
  return withPeopleIdentity({
    ...(q ? { q: String(q).slice(0, 500) } : {}),
    ...(raw.company_domain || raw.domain ? { company_domain: String(raw.company_domain || raw.domain) } : {}),
    ...(raw.full_name ? { full_name: String(raw.full_name) } : {}),
    ...(title ? { title: String(title) } : {}),
    ...(raw.country ? { country: String(raw.country) } : {}),
    ...(location ? { location: String(location) } : {}),
    ...(keywords?.length ? { keywords: (Array.isArray(keywords) ? keywords : [keywords]).map(String) } : {}),
    limit: Math.max(1, Math.min(50, Math.floor(Number(raw.limit) || pageSize || 10))),
  });
}

function getTregPeopleArray(data: any): any[] {
  const candidates = [data?.output, data?.output?.people, data?.output?.results, data?.output?.items,
    data?.output?.data, data?.people, data?.results, data?.items, data?.data,
    data?.raw?.people, data?.raw?.results, data?.raw?.items, data?.raw?.data,
    // the direct people source answers {total, success, leads: [...], pagination}
    data];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
    if (candidate && typeof candidate === "object") {
      for (const key of ["people", "results", "items", "leads", "data"]) {
        if (Array.isArray(candidate[key])) return candidate[key];
      }
    }
  }
  return [];
}

function firstPeopleText(...values: any[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

function parseTregPeopleRows(data: any): Record<string, any>[] {
  return getTregPeopleArray(data).map((person: any) => {
    const company = person?.current_company || person?.currentCompany || person?.company || {};
    const contact = person?.contact || {};
    const name = firstPeopleText(person?.full_name, person?.fullName, person?.name,
      [person?.first_name || person?.firstname, person?.last_name || person?.lastname].filter(Boolean).join(" "));
    const title = firstPeopleText(person?.job_title, person?.jobTitle, person?.title, person?.current_title,
      person?.currentJobTitle, person?.lastJobTitle, person?.headline);
    const email = firstPeopleText(person?.work_email, person?.workEmail, person?.business_email,
      person?.businessEmail, person?.corporateEmail, person?.email, contact?.work_email, contact?.email);
    const phone = firstPeopleText(person?.work_phone, person?.workPhone, person?.business_phone,
      person?.businessPhone, person?.phone_number, person?.phone, person?.officePhone, contact?.phone);
    return {
      ...person,
      contact_name: name,
      job_title: title,
      company_name: firstPeopleText(person?.company_name, person?.companyName, person?.current_company_name,
        person?.currentCompanyName, person?.lastCompanyName, company?.name, company?.company_name, person?.organization),
      website: firstPeopleText(person?.company_website, person?.companyWebsite, person?.website, person?.domain, person?.lastCompanyWebsite, company?.website, company?.domain),
      linkedin_url: firstPeopleText(person?.linkedin_url, person?.linkedinUrl, person?.profile_url, person?.profileUrl, person?.linkedin, contact?.linkedin_url),
      location: firstPeopleText(person?.location, person?.city, person?.country, person?.address, company?.location),
      // what the company is and where it is: the relevance gate reads these, never the person's free profile text for a contact value
      company_address: firstPeopleText(person?.lastCompanyAddress, company?.address),
      industry: firstPeopleText(person?.lastCompanyIndustry, person?.industry, company?.industry),
      industry_description: firstPeopleText(person?.lastCompanyDescription, company?.description),
      work_email: email,
      phone,
      work_email_verification_status: arabicVerificationStatus(
        person?.work_email_verification_status ?? person?.email_verification_status ?? person?.email_status ?? person?.email_verified,
        Boolean(email),
      ),
      phone_verification_status: arabicVerificationStatus(
        person?.phone_verification_status ?? person?.phone_status ?? person?.phone_verified,
        Boolean(phone),
      ),
      contact_name_presence_status: name ? "موجود" : "غير موجود",
      job_title_presence_status: title ? "موجود" : "غير موجود",
      work_email_presence_status: email ? "موجود" : "غير موجود",
      phone_presence_status: phone ? "موجود" : "غير موجود",
    };
  });
}

function findContactValue(data: any, keys: string[]): string {
  const wanted = new Set(keys.map((key) => key.toLowerCase()));
  const visit = (node: any, depth: number): string => {
    if (!node || typeof node !== "object" || depth > 5) return "";
    for (const [key, value] of Object.entries(node)) {
      if (wanted.has(key.toLowerCase()) && typeof value === "string" && value.trim()) return value.trim();
    }
    for (const key of ["output", "data", "result", "person", "contact", "raw"]) {
      const value = visit(node[key], depth + 1);
      if (value) return value;
    }
    return "";
  };
  return visit(data, 0);
}

/**
 * The people search goes to ONE direct source, not through the routed endpoint. The routed `treg.people.search` tries providers one after
 * another (a miss moves on to the next) and answered after our 30 s limit while billing the call (live 2026-10-26, two jobs); its direct
 * child `icypeas.people.search` is synchronous (catalog: p50 584 ms, p95 1,122 ms) and a job through it finished in 8 s on 2026-10-16.
 */
export const PEOPLE_DISCOVERY_ENDPOINT = "icypeas.people.search";
/** Catalog price of one row (USD). `pagination.size` is the price dial: every row returned is billed. */
export const PEOPLE_DISCOVERY_USD_PER_ROW = 0.00038;

/**
 * Rows asked for: three times the people wanted (the relevance gate keeps the ones that match), never above what one call may cost: the rows
 * are billed one by one, so the most is what fits under the per-call ceiling with a tenth to spare (11 rows = 0.00418 USD under 0.005).
 */
export function peopleDiscoverySize(limit: number): number {
  const most = Math.max(1, Math.floor((DECISION_MAKER_ROUTE_COST_CAP_USD * 0.9) / PEOPLE_DISCOVERY_USD_PER_ROW));
  return Math.max(1, Math.min(most, Math.floor(Number(limit) || 1) * 3));
}

const countryCodeOf = (value: unknown): string | undefined => {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return undefined;
  if (/^[A-Za-z]{2}$/.test(text)) return text.toUpperCase();
  const detected = detectInternationalCountryFromText(text);
  return detected ? isoCountryCodeFromName(detected.canonicalEnglish) : undefined;
};

/**
 * The body of the direct source, from the plan's flat people params: the title as `currentJobTitle`, the country as an alpha-2 code in
 * `location` (the catalog: «Locations are best given as alpha-2 country codes»), the activity words as `keyword`, the company site as
 * `currentCompanyWebsite`; `pagination.size` is what is billed.
 */
export function icypeasPeopleBody(params: Record<string, any>, size: number): Record<string, any> {
  const list = (value: unknown): string[] => (Array.isArray(value) ? value : value ? [value] : [])
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim().slice(0, 120));
  const query: Record<string, any> = {};
  const title = list(params.title);
  if (title.length) query.currentJobTitle = { include: title };
  const place = countryCodeOf(params.country) || (typeof params.location === "string" && params.location.trim() ? params.location.trim().slice(0, 120) : undefined);
  if (place) query.location = { include: [place] };
  const keywords = list(params.keywords).filter((keyword) => !/[\u0600-\u06FF]/.test(keyword)).slice(0, 5);
  if (keywords.length) query.keyword = { include: keywords };
  const domain = typeof params.company_domain === "string" ? params.company_domain.trim().replace(/^https?:\/\//i, "").replace(/^www\./i, "").split(/[/?#]/)[0] : "";
  if (domain) query.currentCompanyWebsite = { include: [domain] };
  if (!title.length && typeof params.q === "string" && params.q.trim()) query.keyword = { include: [...(query.keyword?.include || []), params.q.trim().slice(0, 120)] };
  return { query, pagination: { size } };
}

/** The answer's own people rows, marked as coming from the direct source (the relevance gate judges those by their company and country). */
export function parseDirectPeopleRows(data: any): Record<string, any>[] {
  return parseTregPeopleRows(data).map((row) => ({ ...row, people_source: "icypeas" }));
}

/** A work-email lookup may run long (measured 7 to 57 s at the 0.02 ceiling); a phone lookup answers quickly or not at all. */
export const PEOPLE_EMAIL_LOOKUP_TIMEOUT_MS = 25_000;
/** The FIRST work-email lookups of all people run together, and each is cut at this limit (the live answers came in at 5 to 13 s): a slow one does not hold the window for the checks and phones of the people already found. */
export const PEOPLE_FIRST_EMAIL_LOOKUP_TIMEOUT_MS = 14_000;
/** A first lookup cut by its limit is read ONCE more after the checks and phones (the same idempotency key: no new charge), only with this much time for the read. */
export const PEOPLE_FIRST_EMAIL_RETRY_MIN_MS = 4_000;
export const PEOPLE_PHONE_LOOKUP_TIMEOUT_MS = 12_000;
/** The deliverability check of a found work email answers in seconds (measured 0.4 to a few s). */
export const PEOPLE_VERIFY_LOOKUP_TIMEOUT_MS = 12_000;
/** How long to wait before reading a call our time limit cut (the source is likely finished by then), and before one more read of an answer that is still in flight. */
export const PEOPLE_REPLAY_WAIT_MS = 4_000;
export const PEOPLE_REREAD_WAIT_MS = 3_000;
/** The person lookups wait longer: a work email is a slow answer (7 to 57 s measured), so the first read follows a cut call after 8 s, and a 409 gets one more after 4 s. */
export const PEOPLE_LOOKUP_REPLAY_WAIT_MS = 8_000;
export const PEOPLE_LOOKUP_REREAD_WAIT_MS = 4_000;
/**
 * Time kept free, after the last lookup, for what must still happen in the same chunk: recording the page, building and saving the files, and the
 * settlement check (measured about 10 s in the live job of 14:59 UTC). No people lookup starts when the worker's deadline (45 s from its start) is this
 * close: lookups end at about 33 s, saving and settling at about 43 s, inside both the worker's deadline and the dispatcher's 55 s wait.
 */
export const PEOPLE_LOOKUP_RESERVE_MS = 12_000;
/** A deliverability check is skipped (the address is delivered as «لم يتوفر تأكيد») when less than this is left before the reserve: it answers in 1.6 to 4 s. */
export const PEOPLE_VERIFY_MIN_TIME_MS = 6_000;
/** The shortest read worth making. */
const MIN_READ_MS = 3_000;
/** How many people are looked up at the same time in the second step (the check and the phone); the first email lookups of all people run together (see enrichTregPeopleRows). */
export const PEOPLE_LOOKUP_CONCURRENCY = 3;

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** One outbound call of a lookup, as the owner reads it: the status, the time, and whether OUR time limit cut it. */
export interface LookupAttempt { status: number; latencyMs: number; cut: boolean }
const attemptOf = (result: Pick<TregCallResult, "httpStatus" | "latencyMs" | "timedOut">): LookupAttempt =>
  ({ status: result.httpStatus, latencyMs: Math.round(result.latencyMs || 0), cut: Boolean(result.timedOut) });

/** A call that has no answer YET: our own time limit cut it, or the gateway says the first call with this key is still running (HTTP 409). */
export const isInFlightResult = (result: Pick<TregCallResult, "ok" | "timedOut" | "httpStatus">): boolean =>
  !result.ok && (Boolean(result.timedOut) || result.httpStatus === 409);

/**
 * One call, and when it has no answer yet (our time limit cut it, or HTTP 409: the first call is still running), a read of it with the SAME
 * idempotency key: the gateway answers a replay from the stored result at no charge (`X-Treg-Original-Cost-Micro` carries the first call's
 * charge), so an answer the source finished after we stopped waiting is read, not bought again. A replay is never immediate: the call is given
 * `waitsMs[0]` first, and a 409 (not ready) gets one more read after `waitsMs[1]`. Each read runs only when time is left (`deadlineMs`, minus
 * `reserveMs` for what must still happen) and the job's spend budget allows it (`beforeReplay`); otherwise the in-flight result is returned.
 */
export async function executeTregCallWithReplay(
  options: TregCallOptions,
  control: { deadlineMs?: number; reserveMs?: number; beforeReplay?: () => boolean; now?: () => number; sleep?: (ms: number) => Promise<void>; waitsMs?: number[] } = {},
): Promise<{ result: TregCallResult; calls: number; attempts: LookupAttempt[] }> {
  const now = control.now ?? Date.now;
  const sleep = control.sleep ?? defaultSleep;
  let result = await executeTregCall(options);
  let calls = 1;
  const attempts: LookupAttempt[] = [attemptOf(result)];
  for (const wait of control.waitsMs ?? [PEOPLE_REPLAY_WAIT_MS, PEOPLE_REREAD_WAIT_MS]) {
    // the first read follows a call that has no answer yet (cut by our limit, or 409); one more read follows only a 409 ("not ready")
    if (calls === 1 ? !isInFlightResult(result) : result.httpStatus !== 409) break;
    const left = control.deadlineMs ? control.deadlineMs - now() - (control.reserveMs ?? 0) : 30_000;
    if (left < wait + MIN_READ_MS) break;
    if (control.beforeReplay && !control.beforeReplay()) break;
    await sleep(wait);
    result = await executeTregCall({ ...options, timeoutMs: Math.min(15_000, Math.floor(left - wait)) });
    calls += 1;
    attempts.push(attemptOf(result));
  }
  return { result, calls, attempts };
}

/** What a call cost: a replay reports 0 and carries the first call's charge in the original-cost header. */
export const callCostMicro = (result: Pick<TregCallResult, "costMicro" | "originalCostMicro">): number =>
  Math.max(0, Number(result.costMicro) || 0, Number(result.originalCostMicro) || 0);

/** What the deliverability check said about an address, as a code. */
export type EmailVerdict = "valid" | "risky" | "catch_all" | "unknown" | "invalid";

/**
 * The verdict of a `treg.people.email.verify` answer. The routed answer is `{output, raw, _treg}` and the child that served it names its own fields, so the
 * status is read from the usual ones (`status`, `result`, `deliverability`, `verdict`, `state`, `validity`, or a boolean `valid` / `deliverable`);
 * a reason («risky», «catch-all») only refines a positive one. Null when the answer carries no verdict (a miss: nothing is known).
 */
export function emailVerdictOf(data: any): EmailVerdict | null {
  const out = data?.output && typeof data.output === "object" ? data.output : data?.raw && typeof data.raw === "object" ? data.raw : data;
  if (!out || typeof out !== "object") return null;
  const text = (value: unknown): string => (typeof value === "string" ? value.trim().toLowerCase() : "");
  const status = ["status", "result", "deliverability", "verdict", "state", "validity"].map((key) => text(out[key])).find(Boolean) || "";
  const reason = ["reason", "sub_status", "substatus", "detail"].map((key) => text(out[key])).filter(Boolean).join(" ");
  if (!status) {
    for (const key of ["valid", "is_valid", "deliverable", "is_deliverable"]) {
      if (typeof out[key] === "boolean") return out[key] ? (/risky|catch|accept/.test(reason) ? "risky" : "valid") : "invalid";
    }
    return null;
  }
  if (/invalid|undeliverable|undelivered|bounce|disposable|rejected|fail|bad/.test(status)) return "invalid";
  if (/catch[-_ ]?all|accept[-_ ]?all/.test(status)) return "catch_all";
  if (/risky/.test(status)) return "risky";
  if (/unknown|unverifiable|inconclusive|error|timeout|pending/.test(status)) return "unknown";
  if (/valid|deliverable|verified|safe|^ok$|^good$/.test(status)) return /catch[-_ ]?all|accept[-_ ]?all/.test(reason) ? "catch_all" : /risky/.test(reason) ? "risky" : "valid";
  return "unknown";
}

/** One lookup, as the owner reads it afterwards: no name, email, phone, link or token, only what happened. */
export interface PeopleLookupLogEntry {
  endpoint: string;
  step: string;
  /** Position of the person in the source's answer, and the place in the order the people were looked up. */
  person: number;
  rank: number;
  /** The NAMES of the identity keys that were sent. */
  keys: string[];
  status: number;
  latencyMs: number;
  costUsd: number;
  servedBy?: string;
  tried?: number;
  outcome: "hit" | "miss" | "error" | "timeout" | "mismatch" | "personal_email" | "no_mx" | "verify_invalid";
  emailPresent: boolean;
  phonePresent: boolean;
  /** Outbound calls for this lookup (2 when the first was cut by our time limit and replayed). */
  calls: number;
  error?: string;
  /** Set when the lookup took more than one call: the FIRST call (its status, time and whether our own limit cut it) and each read after it. */
  firstAttempt?: LookupAttempt;
  reads?: Array<{ status: number; latencyMs: number }>;
  /** A discarded address (personal mailbox, no mail server, invalid): its mailbox domain only («gmail.com»), never the address. A lookup NOT made because its company domain has no mail server (`calls` 0, `status` 0): the company domain only. */
  mailboxDomain?: string;
  /** Which identity this email lookup sent: the company domain with the names (the first choice), the profile link with the names (when no domain exists), or the profile link as the fallback after a miss. */
  attempt?: "domain_and_name" | "profile_link" | "profile_link_fallback";
  /** The one later read of a first lookup that its limit had cut (same idempotency key as the cut call). */
  retry?: true;
  /** The DNS answer for the domain (a code only): `mx`, `a` (no MX, an address record: not a mail server for this decision), `unknown` (the check itself failed). `none` is the outcome `no_mx`. */
  mailServer?: Exclude<MailDomainStatus, "none">;
  /** The deliverability verdict of a checked work email, as a code. */
  verdict?: EmailVerdict;
}

/** Why a person did or did not reach delivery, from the rules (no personal value): the gate's verdict and code, the identity, and the final reason. */
export interface PeopleRowLogEntry {
  person: number;
  gate: "match" | "uncertain" | "no_match";
  /** The gate's code when it did not match (`out_of_scope`, `no_evidence`); a person's own foreign address is `out_of_scope` too. */
  reasonCode?: "out_of_scope" | "no_evidence" | "no_contact";
  hasDomain: boolean;
  hasProfileLink: boolean;
  /** No profile link and no company domain with a name: nothing a provider could match on. */
  identityNull: boolean;
  lookedUp: boolean;
  /** `contact`: a work email or an office phone was found; otherwise the code that kept the person out. */
  finalReason: "contact" | "out_of_scope" | "no_evidence" | "no_contact" | "identity_null" | "personal_email" | "mismatch" | "no_mx" | "verify_invalid";
}

export interface PeopleLookupSummary {
  rows: number;
  eligible: number;
  noIdentity: number;
  lookedUp: number;
  lookupCalls: number;
  skippedBudget: number;
  skippedTime: number;
  skippedEnough: number;
  withContact: number;
  /** Lookups with the profile link made after the first lookup (company domain and names) found nothing. */
  linkFallbacks?: number;
  /** People with no company domain: their only identity is the profile link, which is not paid for as a first lookup (they keep the phone lookup). */
  linkOnlySkipped?: number;
  /** First lookups cut by their limit (PEOPLE_FIRST_EMAIL_LOOKUP_TIMEOUT_MS), and the later reads made of them. */
  firstEmailCut?: number;
  firstEmailRetries?: number;
  /** People whose domain has no mail server (the paid lookup was not made) or whose found address is on a domain with none: outcome `no_mx`. */
  noMx?: number;
  verifyInvalid?: number;
  verifyCalls?: number;
  /** Deliverability checks not made because too little time was left (the address is delivered as «لم يتوفر تأكيد»). */
  verifySkippedTime?: number;
}

const safeLogText = (value: unknown): string | undefined => {
  const text = typeof value === "string" ? value.trim() : "";
  return /^[A-Za-z0-9._:-]{1,48}$/.test(text) ? text : undefined;
};

async function enrichTregPeopleRows(
  rows: Record<string, any>[],
  input: ProviderAdapterCallInput,
  spendBudget: ReturnType<typeof createDecisionMakerSpendBudget>,
  options: { judge?: (row: Record<string, any>) => { decision: "match" | "uncertain" | "no_match"; reasonCode?: string }; wanted?: number } = {},
) {
  let costMicro = 0;
  let providerCallCount = 0;
  let spendBudgetExhausted = false;
  const callIds: string[] = [];
  const log: PeopleLookupLogEntry[] = [];
  const summary: PeopleLookupSummary = { rows: rows.length, eligible: 0, noIdentity: 0, lookedUp: 0, lookupCalls: 0, skippedBudget: 0, skippedTime: 0, skippedEnough: 0, withContact: 0, linkFallbacks: 0, noMx: 0, verifyInvalid: 0, verifyCalls: 0 };
  // Time kept free for what must still happen after a lookup (saving the rows): no lookup starts when the worker's deadline is this close.
  const RESERVE_MS = PEOPLE_LOOKUP_RESERVE_MS;
  /** The time a lookup may take: its own limit, or what the worker's deadline leaves; 0 when too little is left to start one. */
  const timeLeftFor = (limitMs: number): number => {
    if (!input.deadlineMs) return limitMs;
    const left = input.deadlineMs - Date.now() - RESERVE_MS;
    return left >= MIN_READ_MS ? Math.min(limitMs, Math.floor(left)) : 0;
  };
  // A later read of a cut call sends the same idempotency key, so the reservation the cut call still holds (its cost is unknown) covers it: no new one.
  const lookup = async (endpointId: string, params: Record<string, any>, stepId: string, options: { limitMs?: number; waitsMs?: number[]; reuseReservation?: boolean } = {}) => {
    const isEmail = endpointId === "treg.people.email.find";
    const isVerify = endpointId === "treg.people.email.verify";
    const capUsd = isEmail ? DECISION_MAKER_EMAIL_ROUTE_COST_CAP_USD : isVerify ? DECISION_MAKER_VERIFY_ROUTE_COST_CAP_USD : DECISION_MAKER_ROUTE_COST_CAP_USD;
    const timeoutMs = timeLeftFor(options.limitMs ?? (isEmail ? PEOPLE_EMAIL_LOOKUP_TIMEOUT_MS : isVerify ? PEOPLE_VERIFY_LOOKUP_TIMEOUT_MS : PEOPLE_PHONE_LOOKUP_TIMEOUT_MS));
    if (timeoutMs <= 0) { summary.skippedTime += 1; return null; }
    if (!options.reuseReservation && !spendBudget.reserveCall(capUsd)) { spendBudgetExhausted = true; summary.skippedBudget += 1; return null; }
    providerCallCount += 1;
    const { result, calls, attempts } = await executeTregCallWithReplay({
      endpointId, method: "POST", params,
      userId: input.userId, jobId: input.jobId, stepId,
      page: input.step + 1, routeMaxCostUsd: String(capUsd),
      timeoutMs,
    }, { deadlineMs: input.deadlineMs, reserveMs: RESERVE_MS, waitsMs: options.waitsMs ?? [PEOPLE_LOOKUP_REPLAY_WAIT_MS, PEOPLE_LOOKUP_REREAD_WAIT_MS] });
    providerCallCount += calls - 1;
    summary.lookupCalls += calls;
    const spent = callCostMicro(result);
    costMicro += spent;
    // The reads after the first call use its idempotency key: the gateway never bills a key twice, so ONE reservation covers the whole lookup.
    // A cost that was reported (a hit, a free miss, a refusal) gives back what it did not use of it; one that is unknown (no answer yet:
    // our time limit, or HTTP 409) keeps it, because the source may have billed the first call.
    spendBudget.settleCall({ calls: 1, actualMicros: spent, capUsd, costKnown: result.ok || (!isInFlightResult(result) && result.httpStatus >= 400 && result.httpStatus < 500) });
    if (result.tregCallId) callIds.push(result.tregCallId);
    if (!result.ok) {
      console.warn("[decision_maker:contact_call_failed]", { endpointId, status: result.httpStatus, callId: result.tregCallId || "none", timedOut: Boolean(result.timedOut), inFlight: isInFlightResult(result) });
    }
    return { result, calls, spent, attempts };
  };
  const record = (entry: Omit<PeopleLookupLogEntry, "costUsd" | "status" | "latencyMs" | "servedBy" | "tried" | "calls" | "error"> & { done: { result: TregCallResult; calls: number; spent: number; attempts: LookupAttempt[] } }): PeopleLookupLogEntry => {
    const { done, ...rest } = entry;
    const tregInfo = done.result.data?._treg;
    const tried = Array.isArray(tregInfo?.tried) ? tregInfo.tried.length : Number.isFinite(Number(tregInfo?.tried)) ? Number(tregInfo.tried) : undefined;
    return {
      ...rest, status: done.result.httpStatus, latencyMs: Math.round(done.result.latencyMs || 0), costUsd: Number((done.spent / 1_000_000).toFixed(6)),
      ...(safeLogText(tregInfo?.served_by) ? { servedBy: safeLogText(tregInfo.served_by) } : {}),
      ...(tried !== undefined ? { tried } : {}), calls: done.calls,
      ...(!done.result.ok ? { error: safeLogText(done.result.error) || `http_${done.result.httpStatus}` } : {}),
      // a lookup that took more than one call: the FIRST call apart (was it cut by our own limit?), then each read
      ...(done.attempts.length > 1 ? { firstAttempt: done.attempts[0], reads: done.attempts.slice(1).map(({ status, latencyMs }) => ({ status, latencyMs })) } : {}),
    } satisfies PeopleLookupLogEntry;
  };

  const verdicts = rows.map((row) => (options.judge ? options.judge(row) : { decision: "match" as const }));
  const eligibleAt = verdicts.map((verdict) => verdict.decision === "match");
  const identities = rows.map((row, at) => (eligibleAt[at] ? buildPeopleIdentity(row) : null));
  summary.eligible = eligibleAt.filter(Boolean).length;
  summary.noIdentity = rows.filter((_, at) => eligibleAt[at] && !identities[at]).length;
  // The best identities first (a profile link with a real company domain), so the allowance and the time go to the people most likely to answer.
  const order = rows.map((_, at) => at).sort((a, b) => identityScore(identities[b]) - identityScore(identities[a]) || a - b);
  const done: Record<string, any>[] = new Array(rows.length);
  let withContact = 0;
  type Candidate = {
    index: number; rank: number; row: Record<string, any>; identity: Record<string, string>; lookedUp: boolean;
    /** The first email lookup's outcome (null when it was not made); `canFallback`: a miss may be retried once with the profile link. */
    firstOutcome?: PeopleLookupLogEntry["outcome"] | null; canFallback: boolean;
    /** What the first lookup sent (the identity, its step key and attempt): a later read of a cut lookup sends the same. */
    first?: { identity: Record<string, string>; stepId: string; attempt: NonNullable<PeopleLookupLogEntry["attempt"]> };
    /** Reached by the second step (the check and the phone), and whether its deliverability check was decided (made, or skipped for time). */
    reached: boolean; checked: boolean;
    personal: boolean; mismatch: boolean; noMx: boolean; verifyInvalid: boolean;
    // the log entries of the three kinds of lookup are kept apart: verify and phone run at the same time, and the log keeps one fixed order (finds, verify, phone)
    findEntries: PeopleLookupLogEntry[]; verifyEntries: PeopleLookupLogEntry[]; phoneEntries: PeopleLookupLogEntry[];
    /** A found address that passed the free DNS check and waits for its deliverability check. */
    candidate?: { value: string; mailboxDomain: string; findEntry: PeopleLookupLogEntry; fallbackStatus: unknown };
  };
  const rowLog: PeopleRowLogEntry[] = new Array(rows.length);
  const noteRow = (index: number, row: Record<string, any>, lookedUp: boolean, flags: { personal?: boolean; mismatch?: boolean; noMx?: boolean; verifyInvalid?: boolean } = {}) => {
    const verdict = verdicts[index];
    const contact = Boolean(row.work_email || row.phone);
    const gateCode = verdict.decision === "match" ? undefined : verdict.reasonCode === "no_evidence" ? "no_evidence" : "out_of_scope";
    const finalReason: PeopleRowLogEntry["finalReason"] = verdict.decision !== "match" ? gateCode! : !identities[index] ? "identity_null" : contact ? "contact" : flags.noMx ? "no_mx" : flags.verifyInvalid ? "verify_invalid" : flags.personal ? "personal_email" : flags.mismatch ? "mismatch" : "no_contact";
    rowLog[index] = {
      person: index, gate: verdict.decision, ...(gateCode ? { reasonCode: gateCode } : {}),
      hasDomain: Boolean(companyDomainFromWebsite(row.domain ?? row.company_domain) || companyDomainFromWebsite(row.website)),
      hasProfileLink: Boolean(String(row.linkedin_url ?? row.linkedinUrl ?? row.profile_url ?? "").trim()),
      identityNull: !buildPeopleIdentity(row), lookedUp, finalReason,
    };
  };
  const finish = (index: number, row: Record<string, any>, eligible: boolean, lookedUp: boolean, flags: { personal?: boolean; mismatch?: boolean; noMx?: boolean; verifyInvalid?: boolean } = {}) => {
    if (lookedUp) summary.lookedUp += 1;
    noteRow(index, row, lookedUp, flags);
    row.work_email = firstPeopleText(row.work_email);
    row.phone = firstPeopleText(row.phone);
    row.work_email_verification_status = arabicVerificationStatus(row.work_email_verification_status, Boolean(row.work_email));
    row.phone_verification_status = arabicVerificationStatus(row.phone_verification_status, Boolean(row.phone));
    row.work_email_presence_status = row.work_email ? "موجود" : "غير موجود";
    row.phone_presence_status = row.phone ? "موجود" : "غير موجود";
    if (eligible && (row.work_email || row.phone)) withContact += 1;
    row._people_match = eligible;
    done[index] = row;
  };
  const mailDomain = createCachedMailDomainResolver(currentMailDomainResolver());
  /**
   * The deliverability check of a found work email: one `treg.people.email.verify` call. Null when it was not made (no time, no budget); otherwise the verdict
   * (null inside when the answer carried none). Only the address is sent to the source; the log keeps the verdict and the domain, never the address.
   */
  const runVerify = async (person: Candidate, address: string, mailboxDomain: string): Promise<{ made: boolean; verdict: EmailVerdict | null }> => {
    const stepId = `people_verify_${input.step}_${person.index}`;
    const result = await lookup("treg.people.email.verify", { email: address }, stepId);
    if (!result) return { made: false, verdict: null };
    summary.verifyCalls = (summary.verifyCalls ?? 0) + 1;
    const verdict = result.result.ok ? emailVerdictOf(result.result.data) : null;
    const outcome: PeopleLookupLogEntry["outcome"] = verdict === "invalid" ? "verify_invalid" : result.result.ok ? (verdict ? "hit" : "miss") : isInFlightResult(result.result) ? "timeout" : "error";
    person.verifyEntries.push({
      ...record({ endpoint: "treg.people.email.verify", step: stepId, person: person.index, rank: person.rank, keys: ["email"], outcome, emailPresent: true, phonePresent: false, done: result }),
      ...(verdict === "invalid" ? { mailboxDomain } : {}), ...(verdict ? { verdict } : {}),
    });
    return { made: true, verdict };
  };
  /** One work-email lookup with the identity given; null when it was not made (no time, no budget). */
  const runEmail = async (person: Candidate, identity: Record<string, string>, stepId: string, attempt: NonNullable<PeopleLookupLogEntry["attempt"]>, companyStatus?: MailDomainStatus, options: { limitMs?: number; waitsMs?: number[]; retry?: true; reuseReservation?: boolean } = {}): Promise<PeopleLookupLogEntry["outcome"] | null> => {
    // Before the paid call: the company domain must publish a mail server. None (or an address record only) and the lookup is not made: nothing is charged,
    // and the log keeps the domain only. A DNS check that cannot answer does not stop the lookup.
    const companyDomain = identity.domain;
    if (companyDomain) {
      const status = companyStatus ?? (await mailDomain(companyDomain));
      if (!takesMail(status)) {
        person.findEntries.push({
          endpoint: "treg.people.email.find", step: stepId, person: person.index, rank: person.rank, keys: Object.keys(identity).sort(), outcome: "no_mx",
          emailPresent: false, phonePresent: false, calls: 0, status: 0, latencyMs: 0, costUsd: 0, mailboxDomain: companyDomain, attempt,
          ...(status === "a" ? { mailServer: status } : {}),
        });
        person.noMx = true;
        summary.noMx = (summary.noMx ?? 0) + 1;
        return "no_mx";
      }
    }
    const result = await lookup("treg.people.email.find", identity, stepId, { limitMs: options.limitMs, waitsMs: options.waitsMs, reuseReservation: options.reuseReservation });
    if (!result) return null;
    person.lookedUp = true;
    let outcome: PeopleLookupLogEntry["outcome"] = result.result.ok ? "miss" : isInFlightResult(result.result) ? "timeout" : "error";
    let mailboxDomain: string | undefined;
    let mailServer: MailDomainStatus | undefined;
    let foundValue = "";
    if (result.result.ok) {
      const answer = result.result.data?.output ?? {};
      const value = findContactValue(result.result.data, ["work_email", "workEmail", "business_email", "businessEmail", "corporateEmail", "email"]);
      if (value && !returnedPersonMatches(person.row.contact_name, { first: answer.first_name ?? answer.firstName, last: answer.last_name ?? answer.lastName, full: answer.full_name ?? answer.name })) {
        // an email that belongs to someone else is never delivered or charged
        outcome = "mismatch";
        person.mismatch = true;
      } else if (value && isPersonalEmail(value)) {
        // an address on a personal mailbox (gmail, yahoo, ...) is not a work email: not delivered, not charged; only its mailbox DOMAIN is kept in the log
        outcome = "personal_email";
        person.personal = true;
        mailboxDomain = emailDomain(value) || undefined;
      } else if (value) {
        mailboxDomain = emailDomain(value) || undefined;
        foundValue = value;
        // 1) a free DNS check: a domain with no mail server can never receive the message, so the address is neither delivered nor charged
        mailServer = mailboxDomain ? await mailDomain(mailboxDomain) : "unknown";
        if (!takesMail(mailServer)) {
          outcome = "no_mx";
          person.noMx = true;
          summary.noMx = (summary.noMx ?? 0) + 1;
        } else {
          // the address waits for its deliverability check (verifyCandidate), which runs at the same time as the phone lookup
          outcome = "hit";
        }
      }
    }
    const findEntry: PeopleLookupLogEntry = {
      ...record({ endpoint: "treg.people.email.find", step: stepId, person: person.index, rank: person.rank, keys: Object.keys(identity).sort(), outcome, emailPresent: false, phonePresent: false, done: result }),
      ...(mailboxDomain && outcome !== "hit" && outcome !== "miss" ? { mailboxDomain } : {}),
      ...(mailServer && mailServer !== "none" ? { mailServer } : {}),
      attempt,
      ...(options.retry ? { retry: options.retry } : {}),
    };
    person.findEntries.push(findEntry);
    if (outcome === "hit" && foundValue) person.candidate = { value: foundValue, mailboxDomain: mailboxDomain ?? "", findEntry, fallbackStatus: result.result.data?._treg?.verification?.verdict ?? result.result.data?.verified };
    return outcome;
  };
  /** A found address is delivered with the status of its check, or with the honest label when no check was made. */
  const deliverCandidate = (person: Candidate, verdict: EmailVerdict | null) => {
    const candidate = person.candidate!;
    person.row.work_email = candidate.value;
    person.row.work_email_verification_status = arabicVerificationStatus(verdict ?? candidate.fallbackStatus, true);
    candidate.findEntry.emailPresent = true;
  };
  /**
   * The deliverability check of the found address, and what follows from it: `invalid` keeps the address out (not delivered, not charged), any other verdict
   * delivers it with its honest status label, and a check that was not made (no time left, no budget, no answer) delivers it as «لم يتوفر تأكيد».
   */
  const verifyCandidate = async (person: Candidate) => {
    const candidate = person.candidate;
    if (!candidate) return;
    person.checked = true;
    let verdict: EmailVerdict | null = null;
    const timeLeft = input.deadlineMs ? input.deadlineMs - Date.now() - RESERVE_MS : Number.POSITIVE_INFINITY;
    if (timeLeft < PEOPLE_VERIFY_MIN_TIME_MS) summary.verifySkippedTime = (summary.verifySkippedTime ?? 0) + 1;
    else verdict = (await runVerify(person, candidate.value, candidate.mailboxDomain)).verdict;
    if (verdict === "invalid") {
      person.verifyInvalid = true;
      summary.verifyInvalid = (summary.verifyInvalid ?? 0) + 1;
      candidate.findEntry.outcome = "verify_invalid";
      if (candidate.mailboxDomain) candidate.findEntry.mailboxDomain = candidate.mailboxDomain;
      return;
    }
    deliverCandidate(person, verdict);
  };
  // The first work-email lookup: from the company domain and the person's names when both exist (the domain-and-name finders delivered a work address both
  // times they were asked). A person with NO company domain has only the profile link, which answered with a PERSONAL mailbox 6 of 6 times in live jobs and
  // again in the job of 18:35 UTC: it is not paid for as a first lookup, and the person keeps the phone lookup. The first lookups are cut at their own limit
  // and not replayed here: a later read comes in its own step, after the checks and phones of the people already found.
  const firstEmail = async (person: Candidate, companyStatus?: MailDomainStatus) => {
    if (person.row.work_email) return;
    if (!person.identity.domain) { summary.linkOnlySkipped = (summary.linkOnlySkipped ?? 0) + 1; return; }
    const { linkedin_url: profileLink, ...byDomainAndName } = person.identity;
    const byName = Boolean(person.identity.full_name);
    person.canFallback = byName && Boolean(profileLink);
    const first = { identity: byName ? byDomainAndName : person.identity, stepId: `people_email_${input.step}_${person.index}`, attempt: (byName ? "domain_and_name" : "profile_link") as NonNullable<PeopleLookupLogEntry["attempt"]> };
    person.first = first;
    person.firstOutcome = await runEmail(person, first.identity, first.stepId, first.attempt, companyStatus, { limitMs: PEOPLE_FIRST_EMAIL_LOOKUP_TIMEOUT_MS, waitsMs: [] });
    if (person.firstOutcome === "timeout") summary.firstEmailCut = (summary.firstEmailCut ?? 0) + 1;
  };
  const fallbackEmail = async (person: Candidate) => {
    if (person.firstOutcome !== "miss" || !person.canFallback) return;
    summary.linkFallbacks = (summary.linkFallbacks ?? 0) + 1;
    await runEmail(person, person.identity, `people_email_link_${input.step}_${person.index}`, "profile_link_fallback");
  };
  const phoneLookup = async (person: Candidate) => {
    if (person.row.phone) return;
    // the phone lookup carries the address found (it need not wait for its deliverability check, which runs at the same time)
    const knownEmail = person.candidate?.value || person.row.work_email;
    const phoneIdentity = knownEmail ? { ...person.identity, email: String(knownEmail) } : person.identity;
    const stepId = `people_phone_${input.step}_${person.index}`;
    const result = await lookup("treg.people.phone.find", phoneIdentity, stepId);
    if (!result) return;
    person.lookedUp = true;
    let outcome: PeopleLookupLogEntry["outcome"] = result.result.ok ? "miss" : isInFlightResult(result.result) ? "timeout" : "error";
    if (result.result.ok) {
      const value = findContactValue(result.result.data, ["work_phone", "workPhone", "business_phone", "businessPhone", "phone_number", "phone", "officePhone"]);
      if (value) {
        person.row.phone = value;
        person.row.phone_verification_status = arabicVerificationStatus(result.result.data?._treg?.verification?.verdict ?? result.result.data?.verified, true);
        outcome = "hit";
      }
    }
    person.phoneEntries.push(record({ endpoint: "treg.people.phone.find", step: stepId, person: person.index, rank: person.rank, keys: Object.keys(phoneIdentity).sort(), outcome, emailPresent: false, phonePresent: Boolean(person.row.phone), done: result }));
  };
  // The people are looked up best identity first, in four steps, so that no person waits behind another person's slow answer for a first try:
  //  1. the first work-email lookup of every eligible person WITH a company domain, all at the same time, each cut at PEOPLE_FIRST_EMAIL_LOOKUP_TIMEOUT_MS
  //     (each reserves its ceiling from the job's budget; what does not fit is skipped for budget); a person with no company domain gets no paid lookup;
  //  2. the deliverability check of the address found and the office phone lookup, for the best identities first, in groups of at most PEOPLE_LOOKUP_CONCURRENCY
  //     and only while people are still needed (each person's two lookups run at the same time);
  //  3. one later read of each first lookup that its limit cut, for the people still needed, and only while the window leaves the verify minimum after it;
  //  4. the one fallback lookup of a missed person (the profile link), for the people reached in step 2, again only while people are still needed.
  // A found address whose person was not reached in step 2 is not delivered (the wanted count is already met); its lookup is still billed and logged.
  const people: Candidate[] = [];
  order.forEach((index, at) => {
    const row = { ...rows[index] };
    // an address on a personal mailbox that the source itself gave is not a work email either
    if (isPersonalEmail(row.work_email)) row.work_email = "";
    const identity = eligibleAt[index] ? identities[index] : null;
    if (!identity) { finish(index, row, eligibleAt[index], false); return; }
    people.push({ index, rank: at, row, identity, lookedUp: false, canFallback: false, reached: false, checked: false, personal: false, mismatch: false, noMx: false, verifyInvalid: false, findEntries: [], verifyEntries: [], phoneEntries: [] });
  });
  // The company domains are checked first, then every first lookup starts in the order of the people (the best identities reserve the budget first).
  const companyStatus = await Promise.all(people.map((person) => (person.identity.domain ? mailDomain(person.identity.domain) : undefined)));
  await Promise.all(people.map((person, at) => firstEmail(person, companyStatus[at])));
  // the people still needed: the wanted count, less the people reached so far that have a contact value (and the rows without an identity that have one)
  const needed = (): number => options.wanted !== undefined
    ? Math.max(0, options.wanted - withContact - people.filter((person) => person.reached && (person.row.work_email || person.row.phone)).length)
    : Number.POSITIVE_INFINITY;
  let next = 0;
  while (next < people.length && needed() > 0) {
    const group = people.slice(next, next + Math.min(PEOPLE_LOOKUP_CONCURRENCY, needed()));
    next += group.length;
    await Promise.all(group.map(async (person) => {
      person.reached = true;
      await Promise.all([verifyCandidate(person), phoneLookup(person)]);
    }));
  }
  // Step 3: each first lookup that its limit cut gets ONE later read, with the same identity and idempotency key (the gateway answers a stored result at no
  // new charge), while people are still needed. The read's own limit leaves the verify minimum after it, so an address it finds can still be checked; a
  // found address is checked before the next read.
  const retryFirstEmail = async (person: Candidate) => {
    const limitMs = timeLeftFor(PEOPLE_EMAIL_LOOKUP_TIMEOUT_MS) - PEOPLE_VERIFY_MIN_TIME_MS;
    if (!person.first || limitMs < PEOPLE_FIRST_EMAIL_RETRY_MIN_MS) return;
    summary.firstEmailRetries = (summary.firstEmailRetries ?? 0) + 1;
    await runEmail(person, person.first.identity, person.first.stepId, person.first.attempt, undefined, { limitMs, waitsMs: [], retry: true, reuseReservation: true });
  };
  const cut = people.filter((person) => person.firstOutcome === "timeout");
  for (let at = 0; at < cut.length && needed() > 0;) {
    const group = cut.slice(at, at + Math.min(PEOPLE_LOOKUP_CONCURRENCY, needed()));
    at += group.length;
    await Promise.all(group.map(async (person) => {
      await retryFirstEmail(person);
      if (person.candidate && !person.checked) await verifyCandidate(person);
    }));
  }
  const reachedPeople = people.filter((person) => person.reached);
  for (let at = 0; at < reachedPeople.length && needed() > 0;) {
    const group = reachedPeople.slice(at, at + Math.min(PEOPLE_LOOKUP_CONCURRENCY, needed()));
    at += group.length;
    await Promise.all(group.map(async (person) => {
      await fallbackEmail(person);
      if (person.candidate && !person.checked) await verifyCandidate(person);
    }));
  }
  for (const person of people) {
    // not reached in step 2: the wanted people already had a contact value (skipped as enough). Its address, found but not needed and never checked, is
    // not delivered or charged: the customer asked for the wanted count, and the provider cost of the lookup is in the log.
    if (!person.reached) summary.skippedEnough += 1;
    log.push(...person.findEntries, ...person.verifyEntries, ...person.phoneEntries);
    finish(person.index, person.row, true, person.lookedUp, { personal: person.personal, mismatch: person.mismatch, noMx: person.noMx, verifyInvalid: person.verifyInvalid });
  }
  summary.withContact = withContact;
  const enriched = done;
  const requiredFields = Array.isArray(input.params?.requiredContactFields)
    ? input.params.requiredContactFields.map((field: unknown) => String(field))
    : [];
  const reviewedRows = markContactRowsForReview(enriched, requiredFields.filter(
    (field): field is "work_email" | "phone" => field === "work_email" || field === "phone",
  ));
  // The people who match come first, those with a contact value before those without; the rest follow (the relevance gate keeps them out of
  // the delivery and the charge). The order is stable inside each group.
  let ordered = reviewedRows;
  if (options.judge) {
    const rank = (row: Record<string, any>) => (row._people_match ? (row.work_email || row.phone ? 0 : 1) : 2);
    ordered = reviewedRows.map((row, at) => ({ row, at })).sort((a, b) => rank(a.row) - rank(b.row) || a.at - b.at).map(({ row }) => row);
  }
  for (const row of ordered) delete row._people_match;
  // Keep incomplete people visible. Enrichment calls have already incurred provider cost,
  // and settlement decides the delivered contact units independently from these review rows.
  return { rows: ordered, costMicro, callIds, spendBudgetExhausted, providerCallCount, lookupLog: { entries: log, summary, rows: rowLog } };
}

export interface ProviderAdapterCallInput {
  jobId: string;
  userId: string;
  step: number;
  endpointId: string;
  capabilitySlug: string;
  method: "GET" | "POST";
  params: Record<string, any>;
  paginationStrategy: "cursor" | "offset" | "page" | "none";
  cursor: string | null;
  pageSize: number;
  remainingNeeded: number;
  targetVolumeMax: number;
  deliveredSoFar: number;
  /** Remaining per-job decision-maker spend ceiling, set by the worker. */
  decisionMakerSpendBudgetUsd?: number;
  /** Deadline timestamp in milliseconds for chunk execution. */
  deadlineMs?: number;
  /** The job's unit price in points (set by the worker): the multi-provider chain derives its provider-spend budget from the reserve it implies. */
  unitPricePoints?: number;
  /** The accepted quote of the job (set by the worker for a chain job: where its admin-only routing decision is kept). */
  quoteId?: string;
  /** Social topic searches only: judges the discovered videos before their comments are read (set by the worker). */
  videoSelector?: VideoSelector;
  /** The Facebook topic report only (set by the worker): where the collector keeps its record between chunks, and the one model call that places the posts the rules could not. */
  reportStore?: import("./facebookReportAdapter").ReportStateStore;
  axisModel?: import("./facebookReportAdapter").AxisModelCall;
  /** The job's hard USD budget (set by the worker): asked before EVERY provider call of the chunk, not once per chunk. */
  callBudget?: import("./callBudget").JobCallBudget;
  /** What one call of a generic (non-social) source may cost, for that budget. */
  callEstimateUsd?: number;
  /** Raw first-page capture (on by default, see rawCapture.ts): set by the worker for the first chunk. */
  rawCapture?: import("./rawCapture").RawCapture;
  /** A model-planned job only (set by the worker): the database client, the account's access and the purpose, for the audited path of a sensitive step. */
  sensitive?: { client: any; access: import("../treg/dataPolicy").AccountAccess; purpose: string };
}

export interface ProviderAdapterCallOutput {
  ok: boolean;
  httpStatus: number;
  rows: Record<string, any>[];
  rawProfile?: Record<string, any> | null;
  nextCursor: string | null;
  costUsd: number;
  costMicro: number;
  /** Number of outbound TREG attempts, used for conservative DM cap accounting. */
  providerCallCount?: number;
  /** Decision makers: what each email and phone lookup did (no personal value), for the owner's internal job event. */
  lookupLog?: { entries: PeopleLookupLogEntry[]; summary: PeopleLookupSummary; rows?: PeopleRowLogEntry[] };
  tregCallId: string;
  errorCode?: string;
  errorMessageAr?: string;
  /** An answer that is empty for a known reason: the search for the videos found none (the comments were never asked for). */
  emptyReason?: "no_videos" | "no_relevant_videos";
  /** YouTube comments by topic with a window: whether the search was told to prefer recent uploads (the worker words an empty result by it). */
  discoveryWindow?: "recency_applied" | "recency_unsupported";
  /**
   * Facebook keyword search only: what this chunk's reading of POSTS found, counted from the answers themselves. `read` posts had their comments asked for,
   * `sourceShort` of them returned fewer comments than were asked (none included), and `sourceMissing` is how many comments those answers were short of the number asked (in all), and `filteredShort` returned enough but fewer than asked were worth keeping
   * (links, bare reactions, pleasantries). `asked` is the number of comments wanted from each post.
   */
  postReads?: { read: number; sourceShort: number; sourceMissing: number; filteredShort: number; asked: number };
  /** The Facebook topic report only: a chunk that delivered no row but made progress (browsing, classifying): the worker does not count it as an empty page. */
  reportProgress?: boolean;
  /** A model-planned job with a topic: the model calls of the topic review of the chunk (usage and cost), for the worker to log. */
  reviewModelUsage?: Array<{ inputTokens: number; outputTokens: number; costUsd: number; model: string; latencyMs: number; failure?: string; reason?: string }>;
  /** A model-planned mission only: short Arabic lines about what happened at a decision point (a source replaced, a stage stopped, the final review), kept with the job for the customer's summary. */
  missionNotes?: Array<{ kind: string; stage?: number; textAr: string }>;
  /** A model-planned mission only: where each stage stands after this chunk (rows collected, rows delivered, rows wanted, parent rows waiting, finished, why stopped). The panel reads it. */
  missionProgress?: { stages: Array<{ c: number; d: number; x: number; e: number; q: number; done: boolean; stopped?: string }> };
  /** The Facebook topic report only: the model calls of the chunk (usage and cost), for the worker to log. */
  reportModelUsage?: Array<{ inputTokens: number; outputTokens: number; costUsd: number; model: string; latencyMs: number; failure?: string }>;
}

export type ProviderAdapterFn = (
  input: ProviderAdapterCallInput
) => Promise<ProviderAdapterCallOutput>;

let injectedTestAdapter: ProviderAdapterFn | null = null;

/**
 * Registers a test-only provider adapter.
 * Note: /api/worker/chunk strictly blocks injected/mock adapters with HTTP 403
 * whenever NODE_ENV === 'production' or ENABLE_MOCK_PROVIDER !== 'true'.
 */
export function setProviderAdapterForTesting(adapter: ProviderAdapterFn | null): void {
  injectedTestAdapter = adapter;
}

export function getInjectedProviderAdapter(): ProviderAdapterFn | null {
  return injectedTestAdapter;
}

export interface TregRetryControl {
  deadlineMs?: number;
}

/**
 * The routed people search tries providers one after another, cheapest first, until one answers. A call cut at 12 s (the live job of
 * 2026-10-23 ended 12.6 s after its cost row, with a title and a country in the body) fails the whole job, so the search may use the
 * time the worker's deadline leaves, keeping 12 s for the per-person email and phone lookups; up to 30 s, never below the usual 12 s.
 */
export function peopleSearchTimeoutMs(deadlineMs: number | undefined, now: number = Date.now()): number {
  if (!deadlineMs || !Number.isFinite(deadlineMs)) return 12_000;
  return Math.max(12_000, Math.min(30_000, Math.floor(deadlineMs - now - 12_000)));
}

export async function executeTregCallWithRetry(
  options: TregCallOptions,
  maxRetries: number = 3,
  control?: TregRetryControl
): Promise<TregCallResult> {
  // First real TikTok profile test requires exactly ONE outbound provider attempt maximum
  const isSingleAttemptEndpoint = options.endpointId === "tikhub.tiktok.user.profile";
  const effectiveMaxRetries = isSingleAttemptEndpoint ? 0 : maxRetries;
  let attempt = 0;
  let lastResult: TregCallResult | null = null;
  const timeoutMs = options.timeoutMs ?? 0;

  while (attempt <= effectiveMaxRetries) {
    lastResult = await executeTregCall(options);
    if (lastResult.ok) {
      return lastResult;
    }

    const isRetryable =
      lastResult.httpStatus === 429 ||
      (lastResult.httpStatus >= 500 && lastResult.httpStatus <= 599) ||
      lastResult.error === "network_failure" ||
      lastResult.error === "rate_limit";

    if (!isRetryable || attempt === effectiveMaxRetries) {
      return lastResult;
    }

    attempt++;
    const backoffTable = [2000, 4000, 8000];
    let backoffMs = backoffTable[attempt - 1] ?? 8000;
    const retryAfter = (lastResult as any)?.retryAfterMs;
    if (typeof retryAfter === "number" && retryAfter > 0) {
      backoffMs = Math.min(8000, retryAfter);
    }

    if (control?.deadlineMs && Date.now() + backoffMs + timeoutMs > control.deadlineMs) {
      return lastResult;
    }

    await new Promise((r) => setTimeout(r, backoffMs));
  }

  return lastResult!;
}

/** Plain Arabic reason a provider call failed, with no provider or technical wording. */
export function providerFailureMessageAr(callResult: Pick<TregCallResult, "httpStatus" | "isRouteMaxCost" | "isPlatformBalanceLow"> & { timedOut?: boolean }): string {
  if (callResult.isRouteMaxCost) return PROVIDER_ROUTE_COST_EXCEEDED_AR;
  if (callResult.isPlatformBalanceLow) return PROVIDER_UNAVAILABLE_AR;
  if (callResult.httpStatus === 404) return PROVIDER_TARGET_NOT_FOUND_AR;
  if (callResult.httpStatus === 422) return PROVIDER_INPUT_REJECTED_AR;
  if (callResult.httpStatus === 429) return PROVIDER_BUSY_AR;
  if (callResult.timedOut) return PROVIDER_TIMEOUT_AR;
  return PROVIDER_GENERIC_FAILURE_AR;
}

/** Call made for the social sources: one retry only, because a failed source falls through to the next one. */
export function socialCallThroughTreg(input: ProviderAdapterCallInput): SocialCall {
  return async (source, params, context) => {
    const callResult = await executeTregCallWithRetry(
      {
        endpointId: source.endpointId,
        method: source.method,
        params,
        userId: input.userId,
        jobId: input.jobId,
        stepId: `step_${input.step}`,
        page: input.step + 1,
        routeMaxCostUsd: "0.05",
        idempotencyKey: context.idempotencyKey,
        timeoutMs: context.timeoutMs,
        ...(input.callBudget ? { callBudget: input.callBudget, callEstimateUsd: source.costUsd } : {}),
        ...(input.rawCapture ? { rawCapture: input.rawCapture } : {}),
      },
      1,
      input.deadlineMs ? { deadlineMs: input.deadlineMs } : undefined
    );
    return {
      ok: callResult.ok,
      httpStatus: callResult.httpStatus,
      data: callResult.data,
      costMicro: Math.max(0, Number(callResult.costMicro) || 0),
      tregCallId: callResult.tregCallId || "",
      errorCode: callResult.ok ? undefined : callResult.error || `http_${callResult.httpStatus}`,
      errorMessageAr: callResult.ok ? undefined : callResult.budgetStopped ? JOB_BUDGET_STOP_AR : providerFailureMessageAr(callResult),
    };
  };
}

/**
 * Real TREG provider adapter calling https://treg.to/call/{endpoint-id}.
 * Strictly gated by TREG_LIVE === 'true' and TREG_TOKEN.
 */
export const defaultTregAdapter: ProviderAdapterFn = async (
  input: ProviderAdapterCallInput
): Promise<ProviderAdapterCallOutput> => {
  await resolveProviderKey("treg");
  const gate = getLiveProviderGateStatus();
  if (!gate.isReady) {
    return {
      ok: false,
      httpStatus: 503,
      rows: [],
      nextCursor: null,
      costUsd: 0,
      costMicro: 0,
      tregCallId: "",
      errorCode: gate.reasonCode,
      errorMessageAr: gate.messageAr,
    };
  }

  // The Facebook topic report has its own collector (vetted Pages round-robin, the exact date window, the per-publisher cap, then the comments): see facebookReportAdapter.
  if (isFacebookTopicReport(input.capabilitySlug)) {
    if (!input.reportStore) return { ok: false, httpStatus: 500, rows: [], nextCursor: null, costUsd: 0, costMicro: 0, tregCallId: "", errorCode: "report_store_missing", errorMessageAr: "تعذر تجهيز التقرير؛ لم يُخصم أي رصيد." };
    return runFacebookReportChunk(input, { call: socialCallThroughTreg(input), store: input.reportStore, axisModel: input.axisModel });
  }

  // A MODEL-PLANNED job: the generic interpreter runs the approved plan (see src/lib/modelPlanner/interpreter.ts).
  if (input.capabilitySlug === MODEL_PLAN_SLUG) return runModelPlanChunk(input, { ...(input.sensitive ? { sensitive: input.sensitive } : {}), manager: getMissionManager() });

  // Verified social services run through their own source chain (fallbacks, comments of discovered videos).
  if (isSocialCapabilitySlug(input.capabilitySlug)) {
    return runSocialChunk(input, { call: socialCallThroughTreg(input), videoSelector: input.videoSelector });
  }

  const page = input.step + 1;
  let effectiveEndpointId = input.endpointId;
  let endpointDetails = null as Awaited<ReturnType<typeof getEndpointDetails>>;
  try {
    if (effectiveEndpointId) endpointDetails = await getEndpointDetails(effectiveEndpointId);
  } catch {
    // Keep the adapter's safe per-endpoint fallback below if live schema lookup fails.
  }
  if (effectiveEndpointId && effectiveEndpointId.includes("-") && !effectiveEndpointId.includes(".")) {
    try {
      endpointDetails = endpointDetails || await getEndpointDetails(effectiveEndpointId);
      if (endpointDetails?.id && endpointDetails.id.includes(".")) {
        effectiveEndpointId = endpointDetails.id;
      }
    } catch {
      // Continue
    }
  }

  const isIcypeasCompanies =
    effectiveEndpointId === "icypeas.companies.search" ||
    input.capabilitySlug === "icypeas-companies-search" ||
    input.capabilitySlug === "company-research";

  const isIcypeasPeople =
    effectiveEndpointId === "icypeas.people.search" ||
    input.capabilitySlug === "icypeas-people-search";

  const isIcypeas = isIcypeasCompanies || isIcypeasPeople;
  const isTregPeople = effectiveEndpointId === "treg.people.search" || input.capabilitySlug === "professional-people-search";
  const peopleSpendBudget = isTregPeople
    ? createDecisionMakerSpendBudget(input.decisionMakerSpendBudgetUsd ?? decisionMakerJobSpendCeilingUsd(input.targetVolumeMax))
    : null;

  // Pagination hints come from the generic source planner, but the live
  // provider endpoint schema is authoritative. Some search endpoints expose
  // only `query` and `limit`; sending an inferred offset/page/cursor then
  // makes an otherwise valid first-page request fail with HTTP 400.
  const supportsPaginationParam = (param: string) =>
    !allowedParamKeys || allowedParamKeys.includes(param);

  let allowedParamKeys: string[] | undefined;
  const schemaProperties = endpointDetails?.paramsSchema?.properties;
  if (schemaProperties && typeof schemaProperties === "object") {
    const keys = Object.keys(schemaProperties);
    if (keys.length > 0) allowedParamKeys = keys;
  }
  // The catalog endpoint's allowlist is stable and its detail request can
  // occasionally be unavailable in the worker region. Keep this live source
  // usable while still blocking every undeclared request field.
  if (effectiveEndpointId === "crawl4ai.tiktok.search.videos") {
    allowedParamKeys = allowedParamKeys || ["query", "limit"];
  }
  if (effectiveEndpointId === "treg.people.search") {
    allowedParamKeys = ["q", "company_domain", "full_name", "title", "country", "location", "keywords", "limit"];
  }
  // tregClient translates this local alias to uniqueId before sending it.
  if (effectiveEndpointId === "tikhub.tiktok.user.profile" && allowedParamKeys) {
    allowedParamKeys = [...new Set([...allowedParamKeys, "username", "uniqueId"])];
  }

  // A cursor made by the keywords-only retry paginates THAT query: the next page keeps it (a page never changes its query).
  const cursorFromKeywordsQuery = isIcypeasCompanies && typeof input.cursor === "string" && input.cursor.startsWith(KEYWORDS_ONLY_CURSOR_PREFIX);
  const providerCursor = cursorFromKeywordsQuery ? String(input.cursor).slice(KEYWORDS_ONLY_CURSOR_PREFIX.length) : input.cursor;

  let pageParams: Record<string, any>;
  if (isIcypeasCompanies) {
    pageParams = normalizeIcypeasCompanyParams(input.params || {}, input.pageSize, providerCursor, { keywordsOnly: cursorFromKeywordsQuery });
  } else if (isIcypeasPeople) {
    pageParams = normalizeIcypeasPeopleParams(input.params || {}, input.pageSize, input.cursor);
  } else if (isTregPeople) {
    const flat = normalizeTregPeopleParams(input.params || {}, input.pageSize);
    pageParams = icypeasPeopleBody(flat, peopleDiscoverySize(Number(flat.limit)));
  } else {
    pageParams = serializeProviderParams(input.params || {}, allowedParamKeys);
    if (input.paginationStrategy === "cursor") {
      if (input.cursor) {
        if (supportsPaginationParam("cursor")) pageParams.cursor = input.cursor;
        else if (supportsPaginationParam("next_cursor")) pageParams.next_cursor = input.cursor;
      }
    } else if (input.paginationStrategy === "offset") {
      const numericOffset = input.cursor ? Number(input.cursor) : input.step * input.pageSize;
      if (supportsPaginationParam("offset")) {
        pageParams.offset = Number.isFinite(numericOffset) ? numericOffset : input.step * input.pageSize;
      }
      pageParams.limit = input.pageSize;
    } else if (input.paginationStrategy === "page") {
      if (supportsPaginationParam("page")) pageParams.page = page;
      pageParams.limit = input.pageSize;
    }
  }

  // Date filters are applied locally when a source only supports keyword
  // search. Overfetch within the provider's safe limit so recent matches can
  // still fill the requested sample after stale rows are removed.
  const hasRequestedDateWindow =
    typeof input.params?.dateFrom === "string" || typeof input.params?.dateTo === "string";
  if (effectiveEndpointId === "crawl4ai.tiktok.search.videos" && hasRequestedDateWindow) {
    pageParams.limit = Math.min(25, Math.max(input.pageSize, input.pageSize * 5));
  }

  const isSingleAttemptCap =
    effectiveEndpointId === "tikhub.tiktok.user.profile" ||
    input.capabilitySlug === "tiktok-profile";
  const retries = isTregPeople || isSingleAttemptCap ? 0 : 3;

  const effectiveMethod = isIcypeas ? "POST" : input.method;

  if (isTregPeople && !peopleSpendBudget!.reserveCall()) {
    return {
      ok: true,
      httpStatus: 200,
      rows: [],
      nextCursor: null,
      costUsd: 0,
      costMicro: 0,
      providerCallCount: 0,
      tregCallId: "",
    };
  }

  const callOptions = (params: Record<string, any>, stepSuffix = "") => ({
    endpointId: isTregPeople ? PEOPLE_DISCOVERY_ENDPOINT : effectiveEndpointId,
    method: effectiveMethod,
    params,
    allowedParamKeys: isTregPeople ? ["query", "pagination"] : allowedParamKeys,
    userId: input.userId,
    jobId: input.jobId,
    // The retry gets its own idempotency key: it is a different request and must not replay the narrow one's answer.
    stepId: `step_${input.step}${stepSuffix}`,
    page,
    // The same ceiling as before for every people call. The direct source bills per row returned (`pagination.size`, at most 11 rows = 0.00418 USD),
    // so the ceiling holds; the live routed call that billed 3 rows of this source (0.00114 USD) passed the same 0.005 guard.
    routeMaxCostUsd: isTregPeople ? String(DECISION_MAKER_ROUTE_COST_CAP_USD) : "0.05",
    // The job's hard budget is asked before this call and before each retry. A people job keeps its own decision-maker budget instead.
    ...(input.callBudget && !isTregPeople ? { callBudget: input.callBudget, ...(input.callEstimateUsd !== undefined ? { callEstimateUsd: input.callEstimateUsd } : {}) } : {}),
    ...(input.rawCapture ? { rawCapture: input.rawCapture } : {}),
    // Up to 20 s for the first answer: the direct source answers in about a second (p95 1.1 s), and what is left of the worker's deadline
    // is kept for one replay of the same call and for the per-person lookups.
    timeoutMs: isTregPeople ? Math.min(20_000, peopleSearchTimeoutMs(input.deadlineMs)) : 12000,
  });
  let callResult: TregCallResult;
  let searchCalls = 1;
  if (isTregPeople) {
    // A call cut by our own time limit may already be billed at the source: read it again once with the same idempotency key (read, not bought again).
    const out = await executeTregCallWithReplay(callOptions(pageParams), {
      deadlineMs: input.deadlineMs,
      reserveMs: 12_000,
      beforeReplay: () => peopleSpendBudget!.reserveCall(),
    });
    callResult = out.result;
    searchCalls = out.calls;
    // The search bills per row (0.00038 USD), well under the 0.005 reserved for it: the difference goes back to the job's allowance.
    peopleSpendBudget!.settleCall({
      calls: out.calls, actualMicros: callCostMicro(callResult),
      costKnown: callResult.ok || (!isInFlightResult(callResult) && callResult.httpStatus >= 400 && callResult.httpStatus < 500),
    });
  } else {
    callResult = await executeTregCallWithRetry(
      callOptions(pageParams, cursorFromKeywordsQuery ? "_kw" : ""),
      retries,
      input.deadlineMs ? { deadlineMs: input.deadlineMs } : undefined
    );
  }

  let costMicro = callCostMicro(callResult);
  let costUsd = Number((costMicro / 1_000_000).toFixed(6));
  let providerCallCount = searchCalls;
  let peopleLookupLog: ProviderAdapterCallOutput["lookupLog"];
  let keywordsRetryUsed = false;

  if (!callResult.ok) {
    const errorMessageAr = callResult.budgetStopped ? JOB_BUDGET_STOP_AR : providerFailureMessageAr(callResult);

    return {
      ok: false,
      httpStatus: callResult.httpStatus,
      rows: [],
      nextCursor: null,
      costUsd,
      costMicro,
      providerCallCount,
      tregCallId: callResult.tregCallId || "",
      errorCode: callResult.error || `http_${callResult.httpStatus}`,
      errorMessageAr,
    };
  }

  let rows: Record<string, any>[] = [];
  let rawProfile: Record<string, any> | null = null;
  let nextCursor: string | null = null;

  if (
    input.endpointId === "tikhub.tiktok.user.profile" ||
    input.capabilitySlug === "tiktok-profile"
  ) {
    const requestedUser = String(
      input.params?.username || input.params?.uniqueId || ""
    );
    const parsed = parseTikTokProfileResponse(callResult.data, requestedUser);
    if (parsed) {
      rawProfile = parsed;
      rows = [parsed];
    } else {
      rows = extractAndFlattenRows(callResult.data);
    }
  } else if (isIcypeas) {
    let parsed = parseIcypeasCompaniesResponse(callResult.data);
    // The narrow query (industry AND keywords) found nothing at all: retry ONCE with the keywords only, same country, on
    // the first request of the job only (a cursor belongs to its query, so a later page never widens). Never taxonomy-only.
    if (isIcypeasCompanies && parsed.rows.length === 0 && !input.cursor && pageParams.query?.industry && pageParams.query?.keyword?.include?.length) {
      const keywordsOnly = normalizeIcypeasCompanyParams(input.params || {}, input.pageSize, null, { keywordsOnly: true });
      if (keywordsOnly.query?.keyword?.include?.length && !keywordsOnly.query.industry) {
        const retry = await executeTregCallWithRetry(
          callOptions(keywordsOnly, "_kw"),
          retries,
          input.deadlineMs ? { deadlineMs: input.deadlineMs } : undefined
        );
        costMicro += Math.max(0, Number(retry.costMicro) || 0);
        costUsd = Number((costMicro / 1_000_000).toFixed(6));
        providerCallCount += 1;
        keywordsRetryUsed = true;
        if (retry.ok) {
          callResult = retry;
          parsed = parseIcypeasCompaniesResponse(retry.data);
        }
      }
    }
    rows = parsed.rows;
    nextCursor = parsed.nextCursor && (keywordsRetryUsed || cursorFromKeywordsQuery) ? `${KEYWORDS_ONLY_CURSOR_PREFIX}${parsed.nextCursor}` : parsed.nextCursor;
  } else if (isTregPeople) {
    rows = parseDirectPeopleRows(callResult.data);
    if (rows.length === 0) rows = extractAndFlattenRows(callResult.data?.output ?? callResult.data?.raw ?? callResult.data);
    // The same deterministic gate the worker applies decides which people are looked up (a mismatching row costs nothing more).
    const judge = (row: Record<string, any>) => evaluateResearchRowRelevance(row, {
      capabilitySlug: input.capabilitySlug,
      endpointId: input.endpointId,
      params: input.params || {},
    });
    const enriched = await enrichTregPeopleRows(rows, input, peopleSpendBudget!, {
      judge,
      wanted: Math.max(1, Math.floor(Number(input.remainingNeeded) || Number(input.targetVolumeMax) || 1)),
    });
    rows = enriched.rows;
    costMicro += enriched.costMicro;
    providerCallCount += enriched.providerCallCount;
    peopleLookupLog = enriched.lookupLog;
    costUsd = Number((costMicro / 1_000_000).toFixed(6));
    const allCallIds = [callResult.tregCallId, ...enriched.callIds].filter(Boolean);
    callResult.tregCallId = allCallIds.join(",");
    if (enriched.spendBudgetExhausted) nextCursor = null;
  } else {
    rows = extractAndFlattenRows(callResult.data);
  }

  if (!rows.length && !hasRecognizedProviderResultShape(callResult.data)) {
    return {
      ok: false,
      httpStatus: callResult.httpStatus,
      rows: [],
      nextCursor: null,
      costUsd,
      costMicro,
      providerCallCount,
      tregCallId: callResult.tregCallId || "",
      errorCode: "invalid_provider_payload",
      errorMessageAr: `${PROVIDER_INCOMPATIBLE_ANSWER_AR}؛ تم إيقاف الطلب: حجز مؤقت مُحرَّر.`,
    };
  }

  if (rows.length > 0 && !isIcypeas) {
    if (input.paginationStrategy === "cursor" &&
        (supportsPaginationParam("cursor") || supportsPaginationParam("next_cursor"))) {
      const candidateCursor = findProviderNextCursor(callResult.data);
      if (
        candidateCursor !== null &&
        candidateCursor !== undefined &&
        String(candidateCursor) !== "" &&
        String(candidateCursor) !== String(input.cursor || "")
      ) {
        nextCursor = String(candidateCursor);
      }
    } else if (input.paginationStrategy === "offset" && supportsPaginationParam("offset")) {
      if (rows.length >= input.pageSize) {
        const baseOffset = input.cursor ? Number(input.cursor) : input.step * input.pageSize;
        nextCursor = String((Number.isFinite(baseOffset) ? baseOffset : 0) + rows.length);
      }
    } else if (input.paginationStrategy === "page" && supportsPaginationParam("page")) {
      if (rows.length >= input.pageSize) {
        nextCursor = String(page + 1);
      }
    }
  }

  return {
    ok: true,
    httpStatus: callResult.httpStatus,
    rows,
    rawProfile,
    nextCursor,
    costUsd,
    costMicro,
    providerCallCount,
    ...(peopleLookupLog ? { lookupLog: peopleLookupLog } : {}),
    tregCallId: callResult.tregCallId || "",
  };
};

/**
 * Built-in test adapter for legacy mockProvider body/header requests in non-production tests.
 */
export function createBuiltInMockAdapter(bodyOptions: {
  simulateProviderError?: boolean;
  mockBatchSize?: number;
  mockCostUsd?: number;
}): ProviderAdapterFn {
  return async (input: ProviderAdapterCallInput): Promise<ProviderAdapterCallOutput> => {
    if (bodyOptions.simulateProviderError) {
      return {
        ok: false,
        httpStatus: 502,
        rows: [],
        nextCursor: null,
        costUsd: 0,
        costMicro: 0,
        tregCallId: `mock_err_${input.jobId}_${input.step}`,
        errorCode: "simulated_provider_error",
        errorMessageAr: "خطأ محاكى من مزود البيانات لاختبار إعادة المحاولة.",
      };
    }

    const batchSize =
      typeof bodyOptions.mockBatchSize === "number" && bodyOptions.mockBatchSize > 0
        ? Math.min(input.pageSize, Math.floor(bodyOptions.mockBatchSize))
        : Math.min(input.pageSize, input.remainingNeeded);

    const countToProduce = Math.max(0, Math.min(batchSize, input.remainingNeeded));
    const rows: Record<string, any>[] = Array.from({ length: countToProduce }, (_, idx) => {
      const globalIndex = input.deliveredSoFar + idx + 1;
      return {
        id: `rec_${globalIndex}`,
        uniqueId: `user_${globalIndex}`,
        nickname: `حساب بحثي ${globalIndex}`,
        signature: `سجل مصدر مرقّم ${globalIndex}`,
        verified: globalIndex % 2 === 0,
        followerCount: 1000 * globalIndex,
        followingCount: 150 + globalIndex,
        heartCount: 25000 * globalIndex,
        videoCount: 40 + globalIndex,
        bioLink: `https://example.org/u/${globalIndex}`,
        profileUrl: `https://www.tiktok.com/@user_${globalIndex}`,
        collectedDate: new Date().toISOString().slice(0, 10),
      };
    });

    const totalAfter = input.deliveredSoFar + rows.length;
    const nextCursor =
      totalAfter < input.targetVolumeMax && rows.length > 0
        ? `cursor_step_${input.step + 1}`
        : null;
    const costUsd = typeof bodyOptions.mockCostUsd === "number" ? bodyOptions.mockCostUsd : 0.004;

    return {
      ok: true,
      httpStatus: 200,
      rows,
      rawProfile: rows[0] || null,
      nextCursor,
      costUsd,
      costMicro: Math.round(costUsd * 1_000_000),
      tregCallId: `mock_call_${input.jobId}_${input.step}`,
    };
  };
}

const inMemoryPartialStepFallback = new Map<string, any>();

export function getInMemoryPartialStepFallback(): Map<string, any> {
  return inMemoryPartialStepFallback;
}

export function clearInMemoryPartialStepFallbackForTesting(): void {
  inMemoryPartialStepFallback.clear();
}
