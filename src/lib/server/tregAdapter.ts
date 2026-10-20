import { executeTregCall, TregCallOptions, TregCallResult, serializeProviderParams } from "../../functions/shared/tregClient";
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
import { runSocialChunk, type SocialCall } from "./socialAdapter";
import { markContactRowsForReview } from "../../functions/shared/decisionMakerPricing";
import {
  createDecisionMakerSpendBudget,
  DECISION_MAKER_PROVIDER_SPEND_CAP_USD,
  DECISION_MAKER_ROUTE_COST_CAP_USD,
} from "./decisionMakerSpend";

export { hasRecognizedProviderResultShape };
import { arabicVerificationStatus } from "../contactVerification";
import {
  detectCountryFromText as detectInternationalCountryFromText,
  detectIndustryFromText as detectInternationalIndustryFromText,
  getMissingCompanyResearchRequirements,
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
  return {
    ...(q ? { q: String(q).slice(0, 500) } : {}),
    ...(raw.company_domain || raw.domain ? { company_domain: String(raw.company_domain || raw.domain) } : {}),
    ...(raw.full_name ? { full_name: String(raw.full_name) } : {}),
    ...(title ? { title: String(title) } : {}),
    ...(raw.country ? { country: String(raw.country) } : {}),
    ...(location ? { location: String(location) } : {}),
    ...(keywords?.length ? { keywords: (Array.isArray(keywords) ? keywords : [keywords]).map(String) } : {}),
    limit: Math.max(1, Math.min(50, Math.floor(Number(raw.limit) || pageSize || 10))),
  };
}

function getTregPeopleArray(data: any): any[] {
  const candidates = [data?.output, data?.output?.people, data?.output?.results, data?.output?.items,
    data?.output?.data, data?.people, data?.results, data?.items, data?.data,
    data?.raw?.people, data?.raw?.results, data?.raw?.items, data?.raw?.data];
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
      person?.currentJobTitle, person?.headline);
    const email = firstPeopleText(person?.work_email, person?.workEmail, person?.business_email,
      person?.businessEmail, person?.corporateEmail, person?.email, contact?.work_email, contact?.email);
    const phone = firstPeopleText(person?.work_phone, person?.workPhone, person?.business_phone,
      person?.businessPhone, person?.phone_number, person?.phone, person?.officePhone, contact?.phone);
    return {
      ...person,
      contact_name: name,
      job_title: title,
      company_name: firstPeopleText(person?.company_name, person?.companyName, person?.current_company_name,
        person?.currentCompanyName, company?.name, company?.company_name, person?.organization),
      website: firstPeopleText(person?.company_website, person?.companyWebsite, person?.website, person?.domain, company?.website, company?.domain),
      linkedin_url: firstPeopleText(person?.linkedin_url, person?.linkedinUrl, person?.profile_url, person?.profileUrl, person?.linkedin, contact?.linkedin_url),
      location: firstPeopleText(person?.location, person?.city, person?.country, company?.location),
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

function getPeopleIdentity(row: Record<string, any>): Record<string, string> | null {
  const linkedin = firstPeopleText(row.linkedin_url, row.linkedinUrl, row.profile_url);
  if (linkedin) return { linkedin_url: linkedin };
  const domainValue = firstPeopleText(row.domain, row.company_domain, row.website);
  const domain = domainValue.replace(/^https?:\/\//i, "").replace(/^www\./i, "").split(/[/?#]/)[0];
  const name = firstPeopleText(row.contact_name, row.full_name, row.fullName, row.name);
  return domain && name ? { domain, full_name: name } : null;
}

async function enrichTregPeopleRows(
  rows: Record<string, any>[],
  input: ProviderAdapterCallInput,
  spendBudget: ReturnType<typeof createDecisionMakerSpendBudget>,
) {
  let costMicro = 0;
  let providerCallCount = 0;
  let spendBudgetExhausted = false;
  const callIds: string[] = [];
  const enriched: Record<string, any>[] = [];
  for (let index = 0; index < rows.length; index++) {
    const row = { ...rows[index] };
    const identity = getPeopleIdentity(row);
    if (identity && !row.work_email) {
      if (spendBudget.reserveCall()) {
        providerCallCount += 1;
        const result = await executeTregCallWithRetry({
          endpointId: "treg.people.email.find", method: "POST", params: identity,
          userId: input.userId, jobId: input.jobId, stepId: `people_email_${input.step}_${index}`,
          page: input.step + 1, routeMaxCostUsd: String(DECISION_MAKER_ROUTE_COST_CAP_USD),
          timeoutMs: 12000,
        }, 0, input.deadlineMs ? { deadlineMs: input.deadlineMs } : undefined);
        costMicro += Math.max(0, Number(result.costMicro) || 0);
        if (result.tregCallId) callIds.push(result.tregCallId);
        if (!result.ok) {
          console.warn("[decision_maker:contact_call_failed]", {
            endpointId: "treg.people.email.find",
            status: result.httpStatus,
            callId: result.tregCallId || "none",
          });
        }
        if (result.ok) {
          row.work_email = findContactValue(result.data, ["work_email", "workEmail", "business_email", "businessEmail", "corporateEmail", "email"]);
          row.work_email_verification_status = arabicVerificationStatus(result.data?._treg?.verification?.verdict ?? result.data?.verified, Boolean(row.work_email));
        }
      } else {
        spendBudgetExhausted = true;
      }
    }
    if (identity && !row.phone) {
      if (spendBudget.reserveCall()) {
        providerCallCount += 1;
        const phoneIdentity = row.work_email ? { email: String(row.work_email) } : identity;
        const result = await executeTregCallWithRetry({
          endpointId: "treg.people.phone.find", method: "POST", params: phoneIdentity,
          userId: input.userId, jobId: input.jobId, stepId: `people_phone_${input.step}_${index}`,
          page: input.step + 1, routeMaxCostUsd: String(DECISION_MAKER_ROUTE_COST_CAP_USD),
          timeoutMs: 12000,
        }, 0, input.deadlineMs ? { deadlineMs: input.deadlineMs } : undefined);
        costMicro += Math.max(0, Number(result.costMicro) || 0);
        if (result.tregCallId) callIds.push(result.tregCallId);
        if (!result.ok) {
          console.warn("[decision_maker:contact_call_failed]", {
            endpointId: "treg.people.phone.find",
            status: result.httpStatus,
            callId: result.tregCallId || "none",
          });
        }
        if (result.ok) {
          row.phone = findContactValue(result.data, ["work_phone", "workPhone", "business_phone", "businessPhone", "phone_number", "phone", "officePhone"]);
          row.phone_verification_status = arabicVerificationStatus(result.data?._treg?.verification?.verdict ?? result.data?.verified, Boolean(row.phone));
        }
      } else {
        spendBudgetExhausted = true;
      }
    }
    row.work_email = firstPeopleText(row.work_email);
    row.phone = firstPeopleText(row.phone);
    row.work_email_verification_status = arabicVerificationStatus(row.work_email_verification_status, Boolean(row.work_email));
    row.phone_verification_status = arabicVerificationStatus(row.phone_verification_status, Boolean(row.phone));
    row.work_email_presence_status = row.work_email ? "موجود" : "غير موجود";
    row.phone_presence_status = row.phone ? "موجود" : "غير موجود";
    enriched.push(row);
  }
  const requiredFields = Array.isArray(input.params?.requiredContactFields)
    ? input.params.requiredContactFields.map((field: unknown) => String(field))
    : [];
  const reviewedRows = markContactRowsForReview(enriched, requiredFields.filter(
    (field): field is "work_email" | "phone" => field === "work_email" || field === "phone",
  ));
  // Keep incomplete people visible. Enrichment calls have already incurred provider cost,
  // and settlement decides the delivered contact units independently from these review rows.
  return { rows: reviewedRows, costMicro, callIds, spendBudgetExhausted, providerCallCount };
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
  tregCallId: string;
  errorCode?: string;
  errorMessageAr?: string;
  /** An answer that is empty for a known reason: the search for the videos found none (the comments were never asked for). */
  emptyReason?: "no_videos";
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
export function providerFailureMessageAr(callResult: Pick<TregCallResult, "httpStatus" | "isRouteMaxCost" | "isPlatformBalanceLow">): string {
  if (callResult.isRouteMaxCost) return "تجاوز الطلب سقف التكلفة المسموح به للمصدر.";
  if (callResult.isPlatformBalanceLow) return "الخدمة غير متاحة مؤقتاً، يرجى المحاولة لاحقاً.";
  if (callResult.httpStatus === 404) return "الهدف المطلوب غير موجود أو غير متاح للعامة.";
  if (callResult.httpStatus === 422) return "تعذر معالجة مدخلات الطلب لدى المصدر.";
  if (callResult.httpStatus === 429) return "المصدر مشغول حالياً بعد استنفاد محاولات الإعادة.";
  return "تعذر استخراج البيانات من المصدر بعد عدة محاولات.";
}

/** Call made for the social sources: one retry only, because a failed source falls through to the next one. */
function socialCallThroughTreg(input: ProviderAdapterCallInput): SocialCall {
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
      errorMessageAr: callResult.ok ? undefined : providerFailureMessageAr(callResult),
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

  // Verified social services run through their own source chain (fallbacks, comments of discovered videos).
  if (isSocialCapabilitySlug(input.capabilitySlug)) {
    return runSocialChunk(input, { call: socialCallThroughTreg(input) });
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
    ? createDecisionMakerSpendBudget(input.decisionMakerSpendBudgetUsd ?? DECISION_MAKER_PROVIDER_SPEND_CAP_USD)
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
    pageParams = normalizeTregPeopleParams(input.params || {}, input.pageSize);
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
    endpointId: effectiveEndpointId,
    method: effectiveMethod,
    params,
    allowedParamKeys,
    userId: input.userId,
    jobId: input.jobId,
    // The retry gets its own idempotency key: it is a different request and must not replay the narrow one's answer.
    stepId: `step_${input.step}${stepSuffix}`,
    page,
    routeMaxCostUsd: isTregPeople ? String(DECISION_MAKER_ROUTE_COST_CAP_USD) : "0.05",
    timeoutMs: 12000,
  });
  let callResult = await executeTregCallWithRetry(
    callOptions(pageParams, cursorFromKeywordsQuery ? "_kw" : ""),
    retries,
    input.deadlineMs ? { deadlineMs: input.deadlineMs } : undefined
  );

  let costMicro = Math.max(0, Number(callResult.costMicro) || 0);
  let costUsd = Number((costMicro / 1_000_000).toFixed(6));
  let providerCallCount = 1;
  let keywordsRetryUsed = false;

  if (!callResult.ok) {
    const errorMessageAr = providerFailureMessageAr(callResult);

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
    rows = parseTregPeopleRows(callResult.data);
    if (rows.length === 0) rows = extractAndFlattenRows(callResult.data?.output ?? callResult.data?.raw ?? callResult.data);
    const enriched = await enrichTregPeopleRows(rows, input, peopleSpendBudget!);
    rows = enriched.rows;
    costMicro += enriched.costMicro;
    providerCallCount += enriched.providerCallCount;
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
      errorMessageAr: "استجاب المصدر ببيانات غير متوافقة مع نوع البحث؛ تم إيقاف الطلب وإرجاع الرصيد المحجوز.",
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
