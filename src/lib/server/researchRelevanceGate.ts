import { MODEL_PLAN_SLUG } from "../modelPlanner/constants";
import { isTrueFlag } from "../coerce";
import { detectCountryFromText, detectIndustryFromText, isoCountryCodeFromName } from "../planParameters";
import { GENERIC_COMMENT_REASON_AR, MIN_MEANINGFUL_CHARS, facebookCommentDropReason, isGenericComment, meaningfulChars } from "./commentQuality";
import { isFacebookKeywordService } from "../facebookKeywordService";
import { isFacebookTopicReport } from "../facebookReport/constants";
import { evaluateDeterministicRelevance, type RelevanceDecision } from "./relevanceValidationLayer";
import { BASKETBALL_TOPIC_RE, FOOTBALL_TOPIC_RE, countPattern, hasRegionEvidence, hasTopicEvidence, isBasketballTopic, matchTopic, normalizeText as topicNormalize, topicStems } from "./topicMatch";
import { isCompanyDirectoryJob } from "./directoryCapability";
import { nonCompanyReasonAr } from "../companyRowHygiene";
import { companyActivityKeywords, hasActivityEvidence } from "./relevanceEvidence";
import { isChainSlug } from "../multiProvider/routes";
import { rowPassesGate } from "../multiProvider/policy";
import { contactValueDelivered } from "../../functions/shared/decisionMakerPricing";
import { isTechnologyRequest, technologyEvidenceOf } from "./technologyEvidence";
import { xAccountHandle } from "../socialSources";

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
  reasonCode?: "no_evidence" | "no_contact" | "out_of_scope";
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
function presumeTopicSearchRow(row: Record<string, any>, stems: string[], commentRow: boolean, region: string, evidenceOverride?: boolean): ResearchRelevanceResult {
  const ownKeys = commentRow ? COMMENT_OWN_KEYS : ["text", "full_text", "fullText", "content", "comment", "comment_text", "commentText", "message", "title", "description", "caption", "video_caption", "video_title", "post_text", "body", "summary"];
  const rawOwn = rawTextOf(row, ownKeys);
  const own = normalizeText(rawOwn);
  const noText = { decision: "no_match" as RelevanceDecision, reasonAr: "لا يتضمن السجل نصاً يمكن مطابقته مع موضوع البحث" };
  if (!/\p{L}/u.test(own)) return noText;
  // A comment of fewer than three letters («Wr», «ok») says nothing, whatever video it sits under.
  if (commentRow && meaningfulChars(rawOwn) < MIN_MEANINGFUL_CHARS) return { decision: "no_match", reasonAr: "التعليق أقصر من أن يحمل محتوى" };
  // A link, a mention or a number on its own is no content.
  if (!/\p{L}/u.test(rawOwn.replace(URL_RE, " ").replace(/[@#]?\w*\d\w*/g, " ").replace(/@\S+/g, " ")) ) return noText;
  const letters = [...own].filter((ch) => /\p{L}/u.test(ch));
  if (!letters.some((ch) => /[\u0600-\u06FF\u0750-\u077Fa-z]/i.test(ch))) {
    return { decision: "no_match", reasonAr: "لغة النص لا تحمل محتوى يمكن مطابقته مع موضوع البحث" };
  }
  const evidence = evidenceOverride ?? hasTopicEvidence(stems, own);
  // «اللهم …», «ما شاء الله», «تسلم»: a supplication or a reaction that does not name the topic says nothing about it, under any video.
  if (commentRow && !evidence && isGenericComment(rawOwn)) return { decision: "no_match", reasonAr: GENERIC_COMMENT_REASON_AR };
  if ((URL_RE.test(rawOwn) || PHONE_RE.test(rawOwn) || AD_RE.test(rawOwn)) && !evidence) {
    URL_RE.lastIndex = 0;
    return { decision: "no_match", reasonAr: "المحتوى إعلان أو ترويج لا يتناول موضوع البحث" };
  }
  URL_RE.lastIndex = 0;
  // Pre-filter before any model call, for POSTS: a post with no word of the topic AND (when a country was requested) no word of that country
  // is excluded here and never reaches the review. Comments are not judged by their own words: the video they sit under decides (the videos
  // are selected first, on evidence and then by the review), so a short comment that never repeats the topic is still a real comment.
  if (!commentRow && !evidence && !hasRegionEvidence(region, own)) {
    return { decision: "no_match", reasonAr: region ? "لا يذكر السجل موضوع البحث ولا الدولة المطلوبة" : "لا يذكر السجل كلمات من موضوع البحث" };
  }
  // Comments are judged by their VIDEO (see videoRelevance): a short or reacting comment is normal under an on-topic video, so no comment is
  // flagged as doubtful here. A post is its own unit, so a doubtful post still needs the review: a reaction, and a post that passed only
  // because it names the country (it has no word of the topic).
  const suspicious = !commentRow && (isReactionOnly(own) || !evidence);
  return { decision: "match", reasonAr: "من نتائج البحث بالموضوع المطلوب", ...(suspicious ? { suspicious: true } : {}) };
}

/**
 * The account a post says wrote it, in lower case without «@», or null when the row names none. Only the keys the code, its fixtures and the real rows of
 * `anyapi.x.user.posts` (read from a live job's step file, after `flattenRow`) use: `authorHandle` («elonmusk», no «@»), `authorUsername` (the provider spelling
 * of the search fixture), `author_username` and `username` (the normalised post), and `author_handle`, `screen_name`, `handle`. A nested author object is
 * not read: the rows are flattened before they reach the gate and carry no such object.
 */
const AUTHOR_HANDLE_KEYS = ["authorHandle", "authorUsername", "author_username", "author_handle", "username", "screen_name", "handle"];
export function postAuthorHandle(row: Record<string, any>): string | null {
  for (const key of AUTHOR_HANDLE_KEYS) {
    const value = row?.[key];
    const text = typeof value === "string" ? value.trim().replace(/^@+/, "") : "";
    if (/^[A-Za-z0-9_]{1,15}$/.test(text)) return text.toLowerCase();
  }
  return null;
}

/** The request reads the posts of ONE X account: a handle and no search text (a search text makes it a topic search, judged by topic words). */
export function isXAccountRequest(params: Record<string, any>): boolean {
  return typeof params?.channel === "string" && params.channel.trim() !== "" && !(typeof params.query === "string" && params.query.trim() !== "");
}

/** A flag the source sends as a boolean or as text: «True»/«False» (the real rows), «true», «1». Only a true value is true; «False» is not a reply. */
function flagIsTrue(value: unknown): boolean {
  return isTrueFlag(value);
}

/**
 * A row marked as a reply by the fields the code already reads and the real rows carry: `isReply` / `is_reply` (a boolean or the text «True» / «False»), a
 * reply target (`inReplyToId`, where the provider writes «0» for none), and the reply links `replyTo`, `inReplyTo`, `parentId`, `parent_id` that the result
 * review already counts as replies.
 */
export function isReplyRow(row: Record<string, any>): boolean {
  if (flagIsTrue(row?.isReply) || flagIsTrue(row?.is_reply)) return true;
  const target = row?.inReplyToId;
  if (target !== undefined && target !== null && String(target).trim() !== "" && String(target).trim() !== "0" && String(target).toLowerCase() !== "null") return true;
  return Boolean(row?.replyTo || row?.inReplyTo || row?.parentId || row?.parent_id);
}

/**
 * A repost. The real rows of the timeline source carry NO flag for it: a repost is the text «RT @name: …» (read from a live job's rows), so that is the only
 * mark read, and only at the very start of the post's text.
 */
const REPOST_TEXT = /^\s*RT\s+@[A-Za-z0-9_]{1,15}\s*:/;
export function hasRtTextMark(row: Record<string, any>): boolean {
  for (const key of ["text", "full_text", "fullText", "content", "post_text"]) {
    const value = row?.[key];
    if (typeof value === "string" && value.trim()) return REPOST_TEXT.test(value);
  }
  return false;
}

export const ACCOUNT_REPLY_REASON_AR = "السجل رد على منشور آخر وليس منشورًا كتبه الحساب؛ استُبعد ولم يُحتسب";
export const ACCOUNT_REPOST_REASON_AR = "السجل إعادة نشر لمنشور حساب آخر وليس منشورًا كتبه الحساب؛ استُبعد ولم يُحتسب";
export const ACCOUNT_OTHER_AUTHOR_REASON_AR = "المنشور ليس من الحساب المطلوب";
export const ACCOUNT_NO_AUTHOR_REASON_AR = "لا يظهر في السجل اسم الحساب الذي نشره؛ أُحيل للمراجعة ولم يُحتسب";

/**
 * A row of an X account's timeline is delivered only when it is a post the account wrote itself: its author is the requested account (any letter case, with
 * or without «@»), it is not a reply, and it is not a repost. A reply and a repost are excluded, each with its own honest reason; a post written by another
 * account is excluded; a row that names no author cannot be shown to be the account's own and is held for review. None of them is delivered or charged.
 */
function evaluateXAccountPost(row: Record<string, any>, params: Record<string, any>): ResearchRelevanceResult {
  const wanted = xAccountHandle(params.channel)?.toLowerCase();
  const author = postAuthorHandle(row);
  if (wanted && author && author !== wanted) return { decision: "no_match", reasonAr: ACCOUNT_OTHER_AUTHOR_REASON_AR };
  if (!author) return { decision: "uncertain", reasonAr: ACCOUNT_NO_AUTHOR_REASON_AR };
  if (hasRtTextMark(row)) return { decision: "no_match", reasonAr: ACCOUNT_REPOST_REASON_AR };
  if (isReplyRow(row)) return { decision: "no_match", reasonAr: ACCOUNT_REPLY_REASON_AR };
  return { decision: "match", reasonAr: "منشور كتبه الحساب المطلوب" };
}

function countMatches(value: string, pattern: RegExp): number {
  return [...value.matchAll(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`))].length;
}

export function regionMatches(row: Record<string, any>, requestedRegion: string): boolean {
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
 * A company's own address can name its head office and its branches («Cairo, Egypt; Berlin, Germany»). It is in the requested country when any
 * part of it names that country; when no part names a recognisable country it contradicts nothing. Only an address whose every named country
 * is another country is outside the request.
 */
export function companyAddressMatches(address: string, requestedRegion: string): boolean {
  const parts = address.split(/[;|\n]+|\s+\/\s+/).map((part) => part.trim()).filter(Boolean);
  if (parts.length <= 1) return regionMatches({ address }, requestedRegion);
  const expected = requestedRegion.trim();
  const expectedCode = /^[A-Za-z]{2}$/.test(expected) ? expected.toUpperCase() : (() => { const d = detectCountryFromText(expected); return d ? isoCountryCodeFromName(d.canonicalEnglish) : undefined; })();
  const named = parts.map((part) => { const d = detectCountryFromText(part); return d ? isoCountryCodeFromName(d.canonicalEnglish) : undefined; }).filter(Boolean);
  if (!expectedCode || named.length === 0) return true;
  return named.includes(expectedCode);
}

/** The activity words of a people request: the plan's English `keywords` (a list or one string) and any `query.keyword.include`. */
function peopleActivityKeywords(params: Record<string, any>): string[] {
  const out = [...companyActivityKeywords(params)];
  const raw = params?.keywords;
  for (const keyword of Array.isArray(raw) ? raw : raw ? [raw] : []) {
    if (typeof keyword === "string" && /[a-z]/i.test(keyword) && keyword.trim()) out.push(keyword.trim());
  }
  return [...new Set(out)];
}

/**
 * A person from the direct people source. The source's location filter is loose (a live direct call returned a person in Bahrain at a Sudanese
 * company for a search in Egypt), so the row is judged here, never trusted: a company address of another country, or a company with no sign
 * of the requested activity in its name, industry or description, is shown for review and is neither delivered nor charged. The person's own
 * address of another country is already refused by the region check above. Rows from other sources keep the region check only.
 */
function evaluateDirectPeopleRow(row: Record<string, any>, params: Record<string, any>, requestedRegion: string): ResearchRelevanceResult {
  const match: ResearchRelevanceResult = { decision: "match", reasonAr: "سجل مهني ضمن النطاق المطلوب" };
  if (row.people_source !== "icypeas") return match;
  const companyAddress = typeof row.company_address === "string" ? row.company_address.trim() : "";
  if (requestedRegion && companyAddress && !companyAddressMatches(companyAddress, requestedRegion)) {
    return { decision: "uncertain", reasonAr: "شركة الشخص خارج النطاق الجغرافي المطلوب؛ أُحيل السجل للمراجعة ولم يُحتسب", reasonCode: "out_of_scope" };
  }
  const keywords = peopleActivityKeywords(params);
  if (keywords.length > 0) {
    // The source's industry label alone is never evidence (the same rule as the company directory): the customer is charged per person, so a
    // company is delivered only when its OWN name or description names the requested activity. A label with no such text goes to review.
    const companyText = { company_name: row.company_name, industry_description: row.industry_description };
    // A request for technology companies also accepts ONE clear technology signal anywhere in the person's own data (see technologyEvidence): the
    // company's name or description, or a job title or headline that names a firm's technology activity. Never the label alone.
    const technologyEvidence = isTechnologyRequest(keywords, params?.industry) && technologyEvidenceOf(row) !== null;
    if (!hasActivityEvidence(companyText, keywords) && !technologyEvidence) {
      return {
        decision: "uncertain",
        reasonAr: "تصنيف المصدر وحده لا يكفي ولا يوجد في اسم شركة الشخص أو وصفها ما يؤكد نشاطها المطلوب؛ أُحيل السجل للمراجعة ولم يُحتسب",
        reasonCode: "no_evidence",
      };
    }
  }
  // A person with NEITHER requested contact value (after the lookups ran) is shown for review and is not delivered or charged: the price of a
  // person is paid for what reached the customer. `contact_review_status` is written once the lookups have run, so the people searched
  // BEFORE the lookups (to decide whom to look up) are not judged by a value they cannot have yet.
  const required = (Array.isArray(params?.requiredContactFields) ? params.requiredContactFields : []).filter((field: unknown) => field === "work_email" || field === "phone") as Array<"work_email" | "phone">;
  if (required.length > 0 && typeof row.contact_review_status === "string" && !required.some((field) => contactValueDelivered(row, field))) {
    return { decision: "uncertain", reasonAr: "لم يتوفر لهذا الشخص بريد مهني ولا هاتف مهني؛ أُحيل السجل للمراجعة ولم يُحتسب", reasonCode: "no_contact" };
  }
  return match;
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
  // A MODEL-PLANNED job: the approved plan's own filters (the account, replies, a stated period) were applied by the interpreter before the row got here, and the topic
  // review (when the request has a topic) runs there too. No topic word list judges it again.
  if (capabilitySlug === MODEL_PLAN_SLUG) return { decision: "match", reasonAr: "طابق الشروط المعتمدة في الخطة" };
  // The multi-provider contact chain: a row counts only when every required contact field is VERIFIED (the chain's own policy); an unverified row
  // is neither delivered nor charged. The chain already checked that the page was public; nothing here reads topic words.
  if (isChainSlug(capabilitySlug)) {
    const required = Array.isArray(params?.requiredFields) ? params.requiredFields.map(String) : ["work_email"];
    return rowPassesGate(row, required)
      ? { decision: "match", reasonAr: "حقول التواصل المطلوبة متحقَّق منها" }
      : { decision: "no_match", reasonAr: "لم يكتمل التحقق من حقول التواصل المطلوبة؛ لم يُسلَّم السجل ولم يُحتسب" };
  }
  const companyCapability = isCompanyDirectoryJob(capabilitySlug, endpointId, params);

  if (companyCapability) {
    // A list, a ranking, a directory or an article is never a company, whatever the source called it («Top 40 Pharmaceutical Companies…»).
    const notACompany = nonCompanyReasonAr({ company_name: row.company_name, name: row.name, title: row.title, website: row.website, url: row.url });
    if (notACompany) return { decision: "no_match", reasonAr: `${notACompany}؛ استُبعد السجل ولم يُحتسب` };
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
  if (peopleCapability) return evaluateDirectPeopleRow(row, params, requestedRegion);
  if (capabilitySlug === "social-x-posts" && isXAccountRequest(params)) return evaluateXAccountPost(row, params);

  // Facebook keyword service: the post was judged (adopted) before its comments were read, so its comments are delivered as they are. Only an empty
  // comment or a link on its own is not a delivered unit; no comment-content judgment (pleasantry, length, reaction, topic words) applies here.
  // The Facebook topic report takes the comments of its kept posts the same way: nothing is judged, only an empty comment or a bare link is left out.
  if (/comment/i.test(kindText) && (isFacebookKeywordService(capabilitySlug) || isFacebookTopicReport(capabilitySlug))) {
    const dropped = facebookCommentDropReason(rawTextOf(row, COMMENT_OWN_KEYS));
    if (dropped === "empty") return { decision: "no_match", reasonAr: "لا يتضمن السجل نصاً يمكن مطابقته مع موضوع البحث" };
    if (dropped === "link_only") return { decision: "no_match", reasonAr: "لا يتضمن السجل نصاً سوى رابط" };
    return { decision: "match", reasonAr: "تعليق على منشور معتمد" };
  }

  // Trending-video recency: a region-scoped trending feed is itself the evidence of current trend status. Upload age is not
  // trend age (resurfacing videos can be old), so age never rejects a row here; an explicit customer date window is
  // enforced separately by filterRowsByDateRange before this gate.
  const topic = topicFromParams(params);
  const basketball = isBasketballTopic(topic);
  const stems = basketball ? [] : topicStems(topic);
  if (!basketball && stems.length === 0) return { decision: "match", reasonAr: "لا يتضمن الطلب موضوعاً نصياً يلزم مطابقته" };

  const commentRow = /comment/i.test(kindText);
  // The source filtered by the topic itself: presume the rows on topic (see presumeTopicSearchRow). The strict evidence rule below
  // stays for feeds with no topic filter (an account, a channel, a link), for videos (the title IS the deliverable) and for the
  // basketball/football separation.
  if (/^social-(?:x-posts|tiktok-comments|youtube-comments|facebook-keyword-comments)$/i.test(capabilitySlug) && !basketball && isTopicSearchRequest(params)) return presumeTopicSearchRow(row, stems, commentRow, requestedRegion);
  // Basketball comments found by the source's own topic search (TikTok, YouTube): a short comment under a basketball video is a real comment
  // even when it never says «كرة السلة» (the same rule as every other topic). What stays strict: a comment or a video that is plainly about
  // FOOTBALL (the sports share the word «كرة»), a bare reaction, an ad. A video whose own text names neither sport is not rejected here: the
  // video-level review decides it (see videoRelevance), so its comments are delivered only when the video is on topic.
  if (basketball && commentRow && /^social-(?:tiktok-comments|youtube-comments)$/i.test(capabilitySlug) && isTopicSearchRequest(params)) {
    const own = textOf(row, COMMENT_OWN_KEYS);
    const context = textOf(row, COMMENT_CONTEXT_KEYS);
    const ownBasket = countPattern(own, BASKETBALL_TOPIC_RE);
    const contextBasket = countPattern(context, BASKETBALL_TOPIC_RE);
    const footballTerms = countPattern(`${own} ${context}`, FOOTBALL_TOPIC_RE);
    if (!own) return { decision: "no_match", reasonAr: "لا يتضمن السجل نصاً يمكن مطابقته مع موضوع البحث" };
    // A comment that names neither its video nor the sport has nothing to be judged by: it is not presumed on topic.
    const hasVideo = context !== "" || (typeof row.video_url === "string" && row.video_url.trim() !== "");
    if (ownBasket === 0 && !hasVideo) return { decision: "no_match", reasonAr: "لا يتضمن نص السجل كلمات من موضوع البحث" };
    if (ownBasket + contextBasket === 0 && footballTerms > 0) return { decision: "no_match", reasonAr: "لا يتضمن نص السجل كلمات من موضوع البحث" };
    if (ownBasket + contextBasket > 0 && footballTerms >= ownBasket + contextBasket) return { decision: "uncertain", reasonAr: "يذكر السجل كرة السلة وكرة القدم معاً؛ أُحيل للمراجعة ولم يُحتسب" };
    return presumeTopicSearchRow(row, [], true, requestedRegion, ownBasket > 0);
  }
  const ownContent = commentRow ? textOf(row, COMMENT_OWN_KEYS) : "";
  // A comment is judged by its own words first. The video it sits under is context: it can support a comment that has content of
  // its own, never a bare «اتفقت». Posts, videos and everything else are judged by their own text as before.
  const content = commentRow ? ownContent : rowText(row);
  if (!content) return { decision: "no_match", reasonAr: "لا يتضمن السجل نصاً يمكن مطابقته مع موضوع البحث" };

  if (basketball) {
    const BASKETBALL = BASKETBALL_TOPIC_RE;
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
    const footballTerms = countMatches(basis, FOOTBALL_TOPIC_RE);
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
