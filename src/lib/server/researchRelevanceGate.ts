import { detectCountryFromText, isoCountryCodeFromName } from "../planParameters";
import { evaluateDeterministicRelevance, type RelevanceDecision } from "./relevanceValidationLayer";

export interface ResearchRelevanceContext {
  capabilitySlug: string;
  endpointId: string;
  params: Record<string, any>;
  now?: Date;
}

export interface ResearchRelevanceResult {
  decision: RelevanceDecision;
  reasonAr: string;
}

const TOPIC_STOP_WORDS = new Set([
  "عايز", "عايزة", "عاوز", "عاوزة", "هات", "اجمع", "جمع", "لي", "من", "في", "عن", "على", "مع", "خلال",
  "آخر", "اخر", "الفترة", "فترة", "زمنية", "الزمنية", "المطلوبة", "مطلوبة", "شهر", "الشهر", "يوم", "أيام", "ايام",
  "أسبوع", "اسبوع", "سنة", "سنه", "البلد", "الدولة", "مصر", "السعودية", "ألمانيا", "المانيا", "egypt", "saudi", "germany",
  "تغريدة", "تغريدات", "تويت", "تويتات", "tweet", "tweets", "بوست", "بوستات", "منشور", "منشورات", "post", "posts",
  "كومنت", "كومنتس", "تعليق", "تعليقات", "comment", "comments", "فيديو", "فيديوهات", "مقطع", "مقاطع", "video", "videos",
  "تيك", "توك", "تيكتوك", "tiktok", "يوتيوب", "youtube", "فيسبوك", "facebook", "تويتر", "اكس", "إكس", "twitter", "x",
  "ترند", "تريند", "ترندنج", "trending", "الرائجة", "رائجة", "القناة", "قناة", "حساب", "مصرى", "المصري", "المصرية",
]);

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u064B-\u065F\u0670\u0640]/gu, "")
    .replace(/[أإآٱ]/gu, "ا")
    .replace(/ى/gu, "ي")
    .replace(/ة/gu, "ه")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function topicFromParams(params: Record<string, any>): string {
  const values = [params.topic, params.query, params.keyword, params.search, params.search_query]
    .filter((value) => typeof value === "string") as string[];
  return values.join(" ").trim();
}

function topicTokens(topic: string): string[] {
  const normalized = normalizeText(topic);
  if (/كره (?:ال)?سله|كرة (?:ال)?سلة|basketball|\bnba\b|hoops/i.test(topic)) return ["__basketball__"];
  return [...new Set(normalized.split(/\s+/u).filter((token) => token.length > 1 && !TOPIC_STOP_WORDS.has(token)))];
}

function rowText(row: Record<string, any>): string {
  const candidates = [
    "text", "full_text", "fullText", "content", "comment", "comment_text", "commentText", "message", "title",
    "description", "caption", "video_caption", "video_title", "post_text", "body", "summary", "company_name",
  ];
  return normalizeText(candidates.map((key) => row[key]).filter((value) => typeof value === "string").join(" "));
}

function rowDate(row: Record<string, any>): number | null {
  const value = [row.published_at, row.publishedAt, row.published_date, row.create_time, row.createTime, row.created_at, row.createdAt, row.createdUtc, row.created_utc, row.timestamp, row.date]
    .find((candidate) => candidate !== undefined && candidate !== null && String(candidate).trim());
  if (value === undefined) return null;
  let time = typeof value === "number" ? value : Date.parse(String(value));
  if (!Number.isFinite(time)) return null;
  if (typeof value === "number" && Math.abs(time) < 1e12) time *= 1000;
  return time;
}

function countMatches(value: string, pattern: RegExp): number {
  return [...value.matchAll(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`))].length;
}

function regionMatches(row: Record<string, any>, requestedRegion: string): boolean {
  const rowRegion = [row.region, row.region_code, row.country, row.country_code, row.location, row.address]
    .find((value) => typeof value === "string" && value.trim());
  // A source request scoped to a region is sufficient when the provider does not expose row-level geography.
  if (!rowRegion) return true;
  const countryCode = (value: string): string | undefined => {
    const trimmed = value.trim();
    if (/^[A-Za-z]{2}$/.test(trimmed)) return trimmed.toUpperCase();
    const detected = detectCountryFromText(trimmed);
    return detected ? isoCountryCodeFromName(detected.canonicalEnglish) : undefined;
  };
  const expectedCode = countryCode(requestedRegion);
  const actualCode = countryCode(String(rowRegion));
  if (expectedCode && actualCode) return expectedCode === actualCode;
  const expected = normalizeText(requestedRegion);
  const actual = normalizeText(String(rowRegion));
  return actual === expected || actual.includes(expected) || expected.includes(actual);
}

/**
 * Deterministic final gate applied to provider rows before they are persisted,
 * counted as delivered, or charged. Advisory model output never controls a match.
 */
export function evaluateResearchRowRelevance(
  row: Record<string, any>,
  context: ResearchRelevanceContext,
): ResearchRelevanceResult {
  const { capabilitySlug, endpointId, params } = context;
  const companyCapability = /compan|company|icypeas/i.test(`${capabilitySlug} ${endpointId}`);

  if (companyCapability) {
    const industry = String(params.industry || params.search || topicFromParams(params) || "").trim();
    const country = String(params.country || params.location || "").trim();
    const result = evaluateDeterministicRelevance(row, country, industry);
    return result;
  }

  // The recency/region contract applies to trending-video rows, not comments
  // collected from videos discovered by a trending workflow.
  const trending = (params.trending === true || /trending/i.test(capabilitySlug)) &&
    /video/i.test(`${capabilitySlug} ${endpointId}`) && !/comment/i.test(`${capabilitySlug} ${endpointId}`);
  if (trending && params.region && !regionMatches(row, String(params.region))) {
    return { decision: "no_match", reasonAr: "النطاق الجغرافي في السجل لا يطابق الدولة المطلوبة" };
  }
  if (trending) {
    const published = rowDate(row);
    // When the source supplies a publication date, reject a stale or future-dated
    // result from a current trending feed. Missing dates are handled by an explicit
    // customer date window above; no date is invented when the customer gave none.
    if (published !== null) {
      const now = (context.now || new Date()).getTime();
      const maxAgeMs = 30 * 24 * 60 * 60 * 1000;
      if (published > now || now - published > maxAgeMs) {
        return { decision: "no_match", reasonAr: "تاريخ نشر السجل لا يناسب قائمة المحتوى الرائج الحالية" };
      }
    }
  }

  const tokens = topicTokens(topicFromParams(params));
  if (tokens.length === 0) return { decision: "match", reasonAr: "لا يتضمن الطلب موضوعاً نصياً يلزم مطابقته" };

  const content = rowText(row);
  if (!content) return { decision: "no_match", reasonAr: "لا يتضمن السجل نصاً يمكن مطابقته مع موضوع البحث" };

  const matched = tokens.some((token) => {
    if (token === "__basketball__") {
      const basketballTerms = countMatches(content, /كره (?:ال)?سله|basketball|\bnba\b|hoops/);
      const footballTerms = countMatches(content, /كره (?:ال)?قدم|football|soccer/);
      return basketballTerms > 0 && footballTerms <= basketballTerms;
    }
    return content.split(/\s+/u).includes(token);
  });
  return matched
    ? { decision: "match", reasonAr: "يتضمن نص السجل كلمة من موضوع البحث" }
    : { decision: "no_match", reasonAr: "لا يتضمن نص السجل كلمات من موضوع البحث" };
}

