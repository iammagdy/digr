import { detectCountryFromText, detectIndustryFromText, isoCountryCodeFromName } from "../planParameters";
import { evaluateDeterministicRelevance, type RelevanceDecision } from "./relevanceValidationLayer";
import { matchTopic, normalizeText as topicNormalize, topicStems } from "./topicMatch";
import { companyActivityKeywords, hasActivityEvidence } from "./relevanceEvidence";

export interface ResearchRelevanceContext {
  capabilitySlug: string;
  endpointId: string;
  params: Record<string, any>;
  now?: Date;
}

export interface ResearchRelevanceResult {
  decision: RelevanceDecision;
  reasonAr: string;
  /** Short code for a demotion decided here (for logs and tests; never shown to the customer). */
  reasonCode?: "no_evidence";
  /** `own_text`: the match rests on the company's own text (not on the source label); see evaluateDeterministicRelevance. */
  evidence?: "own_text";
}

function normalizeText(value: string): string {
  return topicNormalize(value);
}

function topicFromParams(params: Record<string, any>): string {
  const values = [params.topic, params.query, params.keyword, params.search, params.search_query]
    .filter((value) => typeof value === "string") as string[];
  return values.join(" ").trim();
}

function rowText(row: Record<string, any>): string {
  const candidates = [
    "text", "full_text", "fullText", "content", "comment", "comment_text", "commentText", "message", "title",
    "description", "caption", "video_caption", "video_title", "post_text", "body", "summary", "company_name",
  ];
  return normalizeText(candidates.map((key) => row[key]).filter((value) => typeof value === "string").join(" "));
}

function countMatches(value: string, pattern: RegExp): number {
  return [...value.matchAll(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`))].length;
}

function regionMatches(row: Record<string, any>, requestedRegion: string): boolean {
  const countryCode = (value: string): string | undefined => {
    const trimmed = value.trim();
    if (/^[A-Za-z]{2}$/.test(trimmed)) return trimmed.toUpperCase();
    const detected = detectCountryFromText(trimmed);
    return detected ? isoCountryCodeFromName(detected.canonicalEnglish) : undefined;
  };
  const expectedCode = countryCode(requestedRegion);
  // Only contradict the source's requested region when a row has explicit,
  // recognizable country metadata. City/state labels (for example "Cairo")
  // and missing/opaque region fields are not evidence that a result is foreign.
  const candidates = [
    row.country_code,
    row.country,
    row.region_code,
    row.region,
    row.location,
    row.address,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !candidate.trim()) continue;
    const actualCode = countryCode(candidate);
    if (expectedCode && actualCode && actualCode !== expectedCode) return false;
  }
  return true;
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
    // A source label alone is never enough to deliver and charge a company: a match must rest on the company's own text,
    // either the sector rule's own evidence or a keyword of the request found in its name, description or specialties.
    // The keywords are the request's own (the planner's `query.keyword.include`) plus the English words of the sector the
    // request names, so a request that carries only its sector label is judged against that sector's words.
    const activityKeywords = [...companyActivityKeywords(params), ...(detectIndustryFromText(industry).englishKeywords || [])];
    if (result.decision === "match" && result.evidence !== "own_text" && !hasActivityEvidence(row, activityKeywords)) {
      return {
        decision: "uncertain",
        reasonAr: "تصنيف المصدر وحده لا يكفي ولا يوجد في وصف الشركة ما يؤكد نشاطها المطلوب؛ أُحيل السجل للمراجعة ولم يُحتسب",
        reasonCode: "no_evidence",
      };
    }
    return { decision: result.decision, reasonAr: result.reasonAr, ...(result.evidence ? { evidence: result.evidence } : {}) };
  }

  const kindText = `${capabilitySlug} ${endpointId}`;
  const peopleCapability = /people|person|decision/i.test(kindText);

  // Region: an explicit, recognisable country on the row that contradicts the requested country is never a match
  // (people, trending videos, tweets, comments, posts). Missing or opaque metadata is not evidence of a foreign row.
  const requestedRegion = String(params.region || (peopleCapability ? params.country || params.location : "") || "").trim();
  if (requestedRegion && !regionMatches(row, requestedRegion)) {
    return { decision: "no_match", reasonAr: peopleCapability ? "الشخص خارج النطاق الجغرافي المطلوب" : "النطاق الجغرافي في السجل لا يطابق الدولة المطلوبة" };
  }
  if (peopleCapability) return { decision: "match", reasonAr: "سجل مهني ضمن النطاق المطلوب" };

  // Trending-video recency: a region-scoped trending feed is itself the evidence of current trend status. Upload age is not
  // trend age (resurfacing videos can be old), so age never rejects a row here; an explicit customer date window is
  // enforced separately by filterRowsByDateRange before this gate.
  const topic = topicFromParams(params);
  const basketball = /كره (?:ال)?سله|كرة (?:ال)?سلة|basketball|\bnba\b|hoops/i.test(topic);
  const stems = basketball ? [] : topicStems(topic);
  if (!basketball && stems.length === 0) return { decision: "match", reasonAr: "لا يتضمن الطلب موضوعاً نصياً يلزم مطابقته" };

  const content = rowText(row);
  if (!content) return { decision: "no_match", reasonAr: "لا يتضمن السجل نصاً يمكن مطابقته مع موضوع البحث" };

  if (basketball) {
    const basketballTerms = countMatches(content, /كره (?:ال)?سله|basketball|\bnba\b|hoops|(?:دوري|لاعب\w*|مباراه|منتخب|اتحاد|نادي)\s+(?:ال)?سله/);
    const footballTerms = countMatches(content, /كره (?:ال)?قدم|football|soccer|(?<![\p{L}\p{N}])القدم(?![\p{L}\p{N}])/u);
    if (basketballTerms === 0) return { decision: "no_match", reasonAr: "لا يتضمن نص السجل كلمات من موضوع البحث" };
    if (footballTerms > 0 && footballTerms >= basketballTerms) return { decision: "uncertain", reasonAr: "يذكر السجل كرة السلة وكرة القدم معاً؛ أُحيل للمراجعة ولم يُحتسب" };
  } else {
    const { matched, total } = matchTopic(stems, content);
    if (matched === 0) return { decision: "no_match", reasonAr: "لا يتضمن نص السجل كلمات من موضوع البحث" };
    // A topic of several words that appears only in part («الطاقة الكهربائية» for «الطاقة الشمسية») is not a match.
    if (matched < total) return { decision: "uncertain", reasonAr: "يتضمن النص جزءاً من موضوع البحث فقط؛ أُحيل للمراجعة ولم يُحتسب" };
  }

  // Language, only when the request names one and the row states its own.
  const wanted = languageCode(params.language ?? params.lang);
  const actual = languageCode(row.lang ?? row.language ?? row.language_code);
  if (wanted && actual && wanted !== actual) {
    return { decision: "uncertain", reasonAr: "لغة السجل تختلف عن اللغة المطلوبة؛ أُحيل للمراجعة ولم يُحتسب" };
  }
  return { decision: "match", reasonAr: "يتضمن نص السجل موضوع البحث" };
}

function languageCode(value: unknown): string | null {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return null;
  if (/^(ar|arabic|عربي|العربيه|العربية)/.test(text)) return "ar";
  if (/^(en|english|انجليزي|الانجليزيه|الإنجليزية)/.test(text)) return "en";
  return /^[a-z]{2}/.test(text) ? text.slice(0, 2) : null;
}
