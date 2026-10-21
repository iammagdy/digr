import { detectCountryFromText, detectIndustryFromText, isoCountryCodeFromName } from "../planParameters";
import { evaluateDeterministicRelevance, type RelevanceDecision } from "./relevanceValidationLayer";
import { hasTopicEvidence, matchTopic, normalizeText as topicNormalize, topicStems } from "./topicMatch";
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
  /**
   * A row of a topic search that is presumed on topic but looks doubtful (a bare «اتفقت», or a long text with no word of the topic
   * anywhere): it is delivered only when the automatic review confirms it. Every other presumed row is delivered without review.
   */
  suspicious?: boolean;
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

/** The comment's own words, as opposed to the title or caption of the video it was written under (which is context). */
const COMMENT_OWN_KEYS = ["text", "full_text", "fullText", "content", "comment", "comment_text", "commentText", "message", "body"];
const COMMENT_CONTEXT_KEYS = ["video_title", "video_caption", "title", "caption", "description", "summary"];

function textOf(row: Record<string, any>, keys: string[]): string {
  return normalizeText(keys.map((key) => row[key]).filter((value) => typeof value === "string").join(" "));
}

/** Words that only agree, react or acknowledge: a comment made of them (and nothing else) says nothing about any topic. */
const REACTION_WORDS = new Set([
  "اتفقت", "اتفق", "موافق", "موافقه", "صح", "صحيح", "تمام", "ايوه", "ايوا", "اه", "اها", "لا", "نعم", "فعلا", "بالظبط", "بالضبط",
  "شكرا", "ممتاز", "جيد", "مفيد", "احسنت", "مبدع", "جزاك", "خيرا", "فيك", "عليك", "يسلمو", "تسلم", "ايديك", "يعطيك", "العافيه", "الله", "تماما", "طبعا", "اكيد", "بالتاكيد", "كلامك", "معاك", "معك", "ايوه", "فعلا", "يا", "ما", "شاء", "بارك", "جميل", "حلو", "رائع", "جدا", "اوي", "كده", "ده", "دي", "هذا", "هذه", "ان", "و", "ف", "ب",
  "ok", "okay", "yes", "no", "lol", "wow", "nice", "true", "agree", "agreed", "thanks", "good",
]);

/** True when every word of the text only agrees, reacts or acknowledges: it carries no content of its own. */
export function isReactionOnly(text: string): boolean {
  const words = normalizeText(text).split(/\s+/u).filter(Boolean);
  return words.length > 0 && words.every((word) => REACTION_WORDS.has(word));
}

/** The request carries a source-side topic filter: the source searched for the topic itself, so what it returned is on topic until shown otherwise. */
export function isTopicSearchRequest(params: Record<string, any>): boolean {
  const query = typeof params.query === "string" ? params.query.trim() : "";
  if (!query) return false;
  return !["channel", "channels", "url", "handle", "account", "trending", "ref"].some((key) => {
    const value = params[key];
    return Array.isArray(value) ? value.length > 0 : Boolean(value);
  });
}

const URL_RE = /(?:https?:\/\/|www\.|t\.me\/|wa\.me\/)\S+/gi;
const PHONE_RE = /\+?\d[\d\s().-]{8,}\d/;
const AD_RE = /(للتواصل|واتساب|واتس اب|اشترك|تابعني|تابعونا|تابع حسابي|خصم|عرض خاص|اطلب(?:ي)? الان|اطلب(?:ي)? الآن|للطلب|رابط البايو|الرابط في البايو|كود خصم|اربح|ربح مضمون|follow me|dm me|dm for|promo code|link in bio|subscribe|whatsapp)/i;

function rawTextOf(row: Record<string, any>, keys: string[]): string {
  return keys.map((key) => row[key]).filter((value) => typeof value === "string").join(" ");
}

/**
 * A row that came back from the source's own topic search is on topic unless it is empty, a bare ad or link, or written in a script
 * with no Arabic or Latin letters at all. A short real comment («ماتش حلو») does not have to repeat the topic's words. Only rows
 * that look doubtful are flagged for the automatic review.
 */
function presumeTopicSearchRow(row: Record<string, any>, stems: string[], commentRow: boolean): ResearchRelevanceResult {
  const ownKeys = commentRow ? COMMENT_OWN_KEYS : ["text", "full_text", "fullText", "content", "comment", "comment_text", "commentText", "message", "title", "description", "caption", "video_caption", "video_title", "post_text", "body", "summary"];
  const rawOwn = rawTextOf(row, ownKeys);
  const own = normalizeText(rawOwn);
  const noText = { decision: "no_match" as RelevanceDecision, reasonAr: "لا يتضمن السجل نصاً يمكن مطابقته مع موضوع البحث" };
  if (!/\p{L}/u.test(own)) return noText;
  // A link, a mention or a number on its own is no content.
  if (!/\p{L}/u.test(rawOwn.replace(URL_RE, " ").replace(/[@#]?\w*\d\w*/g, " ").replace(/@\S+/g, " ")) ) return noText;
  const letters = [...own].filter((ch) => /\p{L}/u.test(ch));
  if (!letters.some((ch) => /[\u0600-\u06FF\u0750-\u077Fa-z]/i.test(ch))) {
    return { decision: "no_match", reasonAr: "لغة النص لا تحمل محتوى يمكن مطابقته مع موضوع البحث" };
  }
  const evidence = hasTopicEvidence(stems, own);
  if ((URL_RE.test(rawOwn) || PHONE_RE.test(rawOwn) || AD_RE.test(rawOwn)) && !evidence) {
    URL_RE.lastIndex = 0;
    return { decision: "no_match", reasonAr: "المحتوى إعلان أو ترويج لا يتناول موضوع البحث" };
  }
  URL_RE.lastIndex = 0;
  const context = commentRow ? textOf(row, COMMENT_CONTEXT_KEYS) : "";
  const words = own.split(/\s+/u).filter(Boolean);
  // Comments are judged by their VIDEO (see videoRelevance): a short or reacting comment is normal under an on-topic video, so no comment is
  // flagged as doubtful here. A post is its own unit, so a doubtful post still needs the review.
  const suspicious = !commentRow && (isReactionOnly(own) || (words.length >= 6 && !evidence && !hasTopicEvidence(stems, context)));
  return { decision: "match", reasonAr: "من نتائج البحث بالموضوع المطلوب", ...(suspicious ? { suspicious: true } : {}) };
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

  const commentRow = /comment/i.test(kindText);
  // The source filtered by the topic itself: presume the rows on topic (see presumeTopicSearchRow). The strict evidence rule below
  // stays for feeds with no topic filter (an account, a channel, a link), for videos (the title IS the deliverable) and for the
  // basketball/football separation.
  if (/^social-(?:x-posts|tiktok-comments|youtube-comments)$/i.test(capabilitySlug) && !basketball && isTopicSearchRequest(params)) return presumeTopicSearchRow(row, stems, commentRow);
  const ownContent = commentRow ? textOf(row, COMMENT_OWN_KEYS) : "";
  // A comment is judged by its own words first. The video it sits under is context: it can support a comment that has content of
  // its own, never a bare «اتفقت». Posts, videos and everything else are judged by their own text as before.
  const content = commentRow ? ownContent : rowText(row);
  if (!content) return { decision: "no_match", reasonAr: "لا يتضمن السجل نصاً يمكن مطابقته مع موضوع البحث" };

  if (basketball) {
    const BASKETBALL = /كره (?:ال)?سله|basketball|\bnba\b|hoops|(?:دوري|لاعب\w*|مباراه|منتخب|اتحاد|نادي)\s+(?:ال)?سله/;
    let basis = content;
    if (commentRow && countMatches(basis, BASKETBALL) === 0) {
      // A comment with no topic word of its own is supported by the video it sits under, unless it only reacts.
      const context = textOf(row, COMMENT_CONTEXT_KEYS);
      if (countMatches(context, BASKETBALL) > 0) {
        if (isReactionOnly(ownContent)) return { decision: "uncertain", reasonAr: "تعليق قصير لا يذكر الموضوع بنفسه؛ أُحيل للمراجعة ولم يُحتسب" };
        basis = `${basis} ${context}`;
      }
    }
    const basketballTerms = countMatches(basis, BASKETBALL);
    const footballTerms = countMatches(basis, /كره (?:ال)?قدم|football|soccer|(?<![\p{L}\p{N}])القدم(?![\p{L}\p{N}])/u);
    if (basketballTerms === 0) return { decision: "no_match", reasonAr: "لا يتضمن نص السجل كلمات من موضوع البحث" };
    if (footballTerms > 0 && footballTerms >= basketballTerms) return { decision: "uncertain", reasonAr: "يذكر السجل كرة السلة وكرة القدم معاً؛ أُحيل للمراجعة ولم يُحتسب" };
  } else {
    const { matched, total } = matchTopic(stems, content);
    if (commentRow && matched < total) {
      const context = matchTopic(stems, textOf(row, COMMENT_CONTEXT_KEYS));
      if (context.total > 0 && context.matched === context.total) {
        if (isReactionOnly(ownContent)) {
          return { decision: "uncertain", reasonAr: "تعليق قصير لا يذكر الموضوع بنفسه؛ أُحيل للمراجعة ولم يُحتسب" };
        }
        // The comment has content of its own, under a video whose own text is about the topic.
        return { decision: "match", reasonAr: "تعليق على فيديو موضوعه مطابق لموضوع البحث" };
      }
    }
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
