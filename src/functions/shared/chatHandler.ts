import { maybeUpgradeToChainPlan } from "../../lib/server/multiProvider/planUpgrade";
import { pointsAr } from "../../lib/pointsFormat";
import { effectiveJobPointsCap } from "../../lib/jobPointsCap";
import { customerFacingCapabilityLabel } from "../../lib/customerFacingRequestLabels";
import { getBusyState } from "../../lib/server/busyState";
import { assessCoverage, familyById, notSupportedReplyAr, partlyNoteAr } from "../../lib/requestCoverage";
import { youtubeRecencyFor, YOUTUBE_OLD_WINDOW_NOTE_AR, YOUTUBE_RECENT_SUPPLY_FROM_VOLUME, YOUTUBE_RECENT_SUPPLY_NOTE_AR } from "../../lib/youtubeRecency";
import { knownEventWindow, parseRelativeWindow, parseStatedDates, resolveTimeWindow, windowIsStatedByCustomer, windowOrProposedDefault, windowQuestion, WINDOW_OPTIONS_AR, formatDateAr, RELATIVE_COUNT_WORDS_ALT } from "../../lib/timeWindow";
import { lowBalanceMessageAr } from "../../lib/lowBalance";
import { CAPACITY_LIMITED_REASON_AR, capStatementAr, volumeLimitStatementAr } from "../../lib/jobCaps";
import { balanceVerdictAr } from "../../lib/balanceVerdict";
import { SOCIAL_DISCOVERY_IDS, SOCIAL_DISCOVERY_OWN_IDS, discoveryAnswerAsRequestText, FACEBOOK_POSTS_ONLY_UNAVAILABLE_AR, platformFollowUpStateAr, readSocialFacts, unsupportedPlatformAnswerAr, UNSUPPORTED_PLATFORM_AR, socialDiscoveryIntroAr, socialDiscoveryItems, socialDiscoveryTrigger, otherFacebookServiceExists, FACEBOOK_TOPIC_OR_PAGE_AR, FACEBOOK_PAGE_LINK_RETRY_AR, facebookPageLinkAlreadyAsked, withLinkScheme } from "../../lib/socialDiscoveryCard";
import { latestDeliveredJob } from "../../lib/server/conversationJobs";
import { asksForMethodology, methodologyAnswerAr, methodologyPurchasedAr, methodologyUnavailableAr } from "../../lib/methodologyOffer";
import { isMethodologyPurchased } from "../../lib/server/methodologyPurchase";
import { stripMissingValueWords } from "../../lib/quoteScopeGaps";
import { FILTER_OPERATORS, FileSpecSchema, describeFileSpecAr, deterministicShapeSpec, fileEditAnswerAr, looksLikeFileShapingRequest, resolveShapeAnswer, shapeAnswerFromMessage, shapeQuestionForSpec, unsupportedFileEdit, validateFileSpec, type DatasetColumn, type FileSpec } from "../../lib/fileSpec";
import { explorationOffer, explorationOfferLineAr, isExplorationCandidate } from "../../lib/exploration";
import { planExplanationLinesAr, recordNounAr, unitPriceLineAr } from "../../lib/planExplanation";
import { companyParamsFromIntent, extractRequestIntent, missingInputsForIntent, peopleParamsFromIntent, unsupportedConstraintsNoteAr, type RequestIntent } from "../../lib/requestIntent";
import { identityAnswerAr, identityQuestionKind, scrubAssistantIdentity } from "../../lib/assistantIdentity";
import { logProviderCost } from "./providerCosts";
import { ID, Query, TablesDB } from "./dbCompat";
import { LlmClient, LlmTurnOutput, type LlmCallResult } from "./llmClient";
import { columnChoicesAr, loadLatestResultColumns } from "../../lib/server/savedResultColumns";
import { detectTopicGathering, hasTopicResearchService, studiesUnavailableReplyAr, topicSourceQuestion } from "./topicGathering";
import { noteLocalLlmSpend } from "./rateLimits";
import { MIN_MODEL_CALL_BUDGET_MS, SLOW_TURN_INTRO_AR, compactHistoryForModel, isPlanAnnouncementOnly, turnBudgetLeftMs } from "./turnGuards";
import {
  getEnabledCapabilitiesWithCoreServices,
  getCatalogCapabilities,
  sanitizeCapabilitiesForLlm,
  validateCapabilityParams,
  validatePlanPlatformMatch,
  detectMentionedPlatforms,
  getPlatformLabelAr,
  getClosestVerifiedCapability,
  COMPANY_SOURCE_UNAVAILABLE_AR,
  isCompanySearchCapabilityRef,
  pickCompanySearchCapability,
  pickPeopleSearchCapability,
  PEOPLE_SOURCE_UNAVAILABLE_AR,
  getCustomerPriceUsdPerCatalogItem,
  computeRegistryPointsPerUnit,
  registryPointsPerUnit,
  UNVERIFIED_PLATFORM_MESSAGE_AR,
  RAW_SEED_CAPABILITIES,
  APPROVED_CAPABILITY_CATALOG,
  Capability,
  resolveCapabilityReference,
} from "./capabilityRegistry";
import {
  calculateQuote,
  generateQuoteExpiry,
  DEFAULT_PRICING_SETTINGS,
  PricingSettings,
} from "./quotes";
import {
  createAndSaveManagedQuote,
  applyPlanOperations,
  validatePlanAgainstSchemas,
  validatePlanAgainstLiveCatalog,
  LiveCatalogIssue,
  PlanItem,
  PlanState,
} from "./planManager";
import { getBalance } from "./ledger";
import { normalizePersonaProfileFields } from "./personaConfigs";
import {
  discoveryQuestionPriority,
  normalizeClarificationQuestions,
  sanitizeClarificationText,
  formatClarificationMessageForAssistant,
  skippedQuestionIdsFromHistory,
  skipCountsFromHistory,
  type NormalizedClarificationQuestion,
  INTERNAL_DISCOVERY_KEYS,
} from "./clarification";
import { searchCatalog, getCachedCatalogEndpoints, sanitizeCustomerErrorMessage, CatalogEndpointSummary } from "./catalogClient";
import {
  isGreetingOrGeneralQuestion,
  isPriceOrProceedIntent,
  extractBriefFromMessage,
  extractBriefFromCardAnswers,
  isBriefComplete,
  formatBriefForSystemPrompt,
  getConversationBrief,
  peekConversationBrief,
  saveConversationBrief,
  isRepetitionComplaint,
  extractTargetVolume,
  type ResearchBrief,
} from "./briefManager";
import { extractResearchIntent, extractEntityType } from "../../lib/server/researchIntent";
import { evaluateDiscoveryDecision } from "../../lib/server/questionDecisionFramework";
import { PEOPLE_ROLE_PATTERN, detectCountryFromText, detectIndustryFromText, getCompanyRequirementItems, getMissingCompanyResearchRequirements, industryDisplayLabelAr, isPeopleSearchRequest, isoCountryCodeFromName, requiredProfessionalContactFields, socialSearchQueryFromTitle } from "../../lib/planParameters";
import { customerFacingConversationTitle } from "../../lib/customerFacingConversationTitle";
import { dedupeRecordSearchItems } from "../../lib/recordSearchPlanItems";
import { resolveRequestAttemptStatus } from "../../lib/requestAttempt";
import { extractNumberFromText } from "../../lib/arabicNumbers";
import { APPROVAL_NEEDS_BUTTON_AR, hasPendingPlan, isChatControlMessage, isRetrySamePlanMessage, isReviewPlanMessage, isTypedApprovalMessage } from "../../lib/retryMessage";
import { normalizeDigits, toArabicDigits } from "../../lib/arabicDigits";
import { ANSWER_END, CHANNELS_SKIPPED_VALUE, capQuestionFor, consultantIntroAr, GENERIC_ASK_ONE_INTRO_AR, isFormStyleIntro, missionCoverageLinesAr, nextStep, questionForStep, typedAnswerLabelFor, PLATFORM_OTHER_QUESTION_AR, FACEBOOK_KEYWORD_SAMPLE_LINE_AR, FACEBOOK_KEYWORD_SLUG_FOR_CARD, understandMission, understoodLineAr } from "../../lib/consultantCopy";
import { NAME_PROMPT_AR } from "../../lib/customerName";
import { CONTACT_BILLING_NOTE_AR, CONTACT_EXPECTATION_AR } from "../../lib/contactExpectation";
import { findRetryableJob, loadQuoteFirstItem, planParamsSignature, readReusableRows } from "../../lib/server/retryReuse";
import { ACCOUNT_HANDLE_RE, ACCOUNT_LOOKUP_RE, SOCIAL_CONTENT_WORDS_RE, getMissingSocialInputs } from "../../lib/socialDiscovery";
import { SOCIAL_TASK_PLATFORMS, cleanSocialTopicAr, detectSocialIntent, getMissingSocialTaskInputs, searchTextNeedsCleaning, socialTaskQuestion } from "../../lib/socialTasks";
import { REPORT_COUNTRY_QUESTION_ID, reportGate, reportNeedsPeriod } from "../../lib/facebookReport/intent";
import { planCountLineAr, planCountPartsAr } from "../../lib/planCounts";
import { planChangeNoteAr, previousPlanQuoteOf } from "../../lib/planChangeNote";
import { findRecentDuplicateRequest } from "../../lib/server/duplicateRequest";
import { PlanRefusalError } from "../../lib/capacityRefusal";
import { pairRoleOf } from "../../lib/planFit";
import { videosCountAr } from "../../lib/channelNames";
import { MAX_CHANNELS_PER_JOB, MAX_PER_VIDEO, MAX_VIDEOS_PER_JOB, canonicalSocialParams, postsForVolume, socialCapabilityForIntent, socialPlanSummaryAr } from "../../lib/socialSources";
import { loadMeasuredTimings } from "../../lib/server/jobTimings";
import { missionDurationForPlan } from "../../lib/missionDuration";
import { longJobDriverMode } from "../../lib/driverMode";
import { DEFAULT_COMMENTS_CAP, DEFAULT_RECORDS_CAP, defaultCapFittedLineAr, defaultCapLineAr, type DefaultNoun } from "../../lib/planDefaults";
import { buildResultFollowupReply, type PriorConversationMessage } from "./resultFollowup";
import { toSafeReasonCode } from "./chatErrors";
import { scrubPlaceholderPhrases } from "../../lib/customerScrub";
import { localizeSectorNamesInText } from "../../lib/industryLabels";
import { CLARIFICATION_ANSWER_LABELS, INDEPENDENT_REQUEST_NOTE_AR, isCardAnswerText, isClarificationAnswerPayload, isFileShapingMessage, dropGreetingAndIdentityTurns, isGreetingOrIdentityTurn, isStandaloneResearchRequest, scopeRequestText } from "./requestScope";

/** Customer messages the scope reads, and the latest rows the model is shown. */
const HISTORY_ROWS_FOR_SCOPE = 30;
const HISTORY_ROWS_FOR_MODEL = 10;

/** Text only (no markup or control characters), links kept, bounded: the channels a customer typed or pasted. */
function plainChannelAnswerText(value: string): string {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/<\/?[a-z][^>]*>/gi, " ")
    .replace(/[\u2066-\u2069\u200e\u200f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 600);
}

/**
 * A message typed instead of tapping a card, right after a question this assistant asked (the channels of a mission, the topic asked
 * instead of them), is read exactly like the card's answer: the same label, so it can never start a new request.
 */
function typedAnswerRequirementText(message: string, labelForQuestion: string | null): string {
  const trimmed = (message || "").trim();
  // What the retry and review buttons send is a request for a quote, never part of the research request.
  if (isRetrySamePlanMessage(trimmed) || isReviewPlanMessage(trimmed)) return "";
  if (!labelForQuestion || !trimmed) return customerAuthoredRequirementText(message);
  // The typed name after «أخرى» is always its answer, even when it names a platform (it may be one we do not read: that is said, never read as a new request).
  if (labelForQuestion === CLARIFICATION_ANSWER_LABELS.social_platform_other_required) return `${labelForQuestion}: ${plainChannelAnswerText(trimmed)}${ANSWER_END}`;
  if (isClarificationAnswerPayload(trimmed) || isCardAnswerText(trimmed) || isStandaloneResearchRequest(trimmed)) return customerAuthoredRequirementText(message);
  return `${labelForQuestion}: ${plainChannelAnswerText(trimmed)}${ANSWER_END}`;
}

/** For each customer message (oldest first), the label of the question the assistant's message just before it asked, if any. */
function typedAnswerLabelsForUserRows(rowsOldestFirst: Array<{ role: string; content: string }>): Array<string | null> {
  const labels: Array<string | null> = [];
  let lastAssistant = "";
  for (const row of rowsOldestFirst) {
    if (row.role === "assistant") {
      if ((row.content || "").trim()) lastAssistant = row.content;
    } else if (row.role === "user") {
      labels.push(typedAnswerLabelFor(lastAssistant));
    }
  }
  return labels;
}

function customerAuthoredRequirementText(message: string): string {
  const trimmed = (message || "").trim();
  // Buttons and approval words carry no research content: the request they refer to is read as it was stated.
  if (isChatControlMessage(trimmed)) return "";
  if (!trimmed.startsWith("{") || !trimmed.includes("clarification_answers")) return trimmed;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed?.type !== "clarification_answers" || !Array.isArray(parsed.answers)) return trimmed;
    const labels = CLARIFICATION_ANSWER_LABELS;
    return parsed.answers
      .flatMap((answer: any) => {
        // The column chosen to split the delivered file: the shaping request it completes, not a research answer.
        if (answer?.questionId === "shape_column_required" && typeof answer?.value === "string" && answer.value.trim()) {
          return [`قسّم الملف شيت لكل ${sanitizeClarificationText(answer.value, 80)}`];
        }
        if ((answer?.questionId === "shape_sort_asc_required" || answer?.questionId === "shape_sort_desc_required") && typeof answer?.value === "string" && answer.value.trim()) {
          return [`رتب الملف حسب ${sanitizeClarificationText(answer.value, 80)}${answer.questionId === "shape_sort_desc_required" ? " تنازلياً" : ""}`];
        }
        // The report's country answer is stored as «في <country>»: the location readers take a country only after a preposition.
        if (answer?.questionId === REPORT_COUNTRY_QUESTION_ID && typeof answer?.value === "string" && answer.value.trim()) {
          return [`${labels[answer.questionId]}: في ${sanitizeClarificationText(answer.value, 60)}`];
        }
        // The discovery card's answers (a Facebook page, the number of posts, comments or not, comments per post) are stored as plain request words.
        if (SOCIAL_DISCOVERY_OWN_IDS.has(answer?.questionId)) {
          const raw = Array.isArray(answer?.value) ? answer.value.filter((v: unknown): v is string => typeof v === "string").join(" ") : typeof answer?.value === "string" ? answer.value : "";
          const words = discoveryAnswerAsRequestText(answer.questionId, answer.questionId === SOCIAL_DISCOVERY_IDS.page ? withLinkScheme(/(?:https?:\/\/|facebook\.com|fb\.com)/iu.test(raw) ? plainChannelAnswerText(raw) : sanitizeClarificationText(raw, 200)) : sanitizeClarificationText(raw, 200));
          // Prefixed with the card's label, so it travels with the request it completes (a bare «٢٠ تعليق من كل منشور» would read as a new request).
          return words ? [`${labels[answer.questionId]}: ${words}`] : [];
        }
        const label = labels[answer?.questionId] || "الإجابة";
        // The channels of a mission: links and long lists are the answer itself, so they are kept (text only, no markup).
        if (answer?.questionId === "social_channel_required") {
          const channelsText = typeof answer?.value === "string" ? plainChannelAnswerText(answer.value) : Array.isArray(answer?.value) ? plainChannelAnswerText(answer.value.filter((v: unknown): v is string => typeof v === "string").join(" و")) : "";
          if (channelsText) return [`${label}: ${channelsText}${ANSWER_END}`];
          // Skipped: the plan goes ahead by topic instead of channels, and says so.
          if (answer?.skipped === true || answer?.needsUserChoice === true) return [`${label}: ${CHANNELS_SKIPPED_VALUE}`];
          return [];
        }
        if (typeof answer?.value === "string") return [`${label}: ${sanitizeClarificationText(answer.value, 200)}`];
        if (Array.isArray(answer?.value)) {
          return answer.value
            .filter((value: unknown): value is string => typeof value === "string")
            .map((value: string) => `${label}: ${sanitizeClarificationText(value, 40)}`);
        }
        return [];
      })
      .filter(Boolean)
      .join(" ");
  } catch {
    return trimmed;
  }
}

function explicitCompanyClarificationNotes(notes?: string): string[] {
  const labels = ["الدولة المطلوبة:", "المجال المطلوب:", "إجابة هدف التواصل:"];
  return (notes || "")
    .split(/\s*\|\s*/)
    .map((part) => part.trim())
    .filter((part) => labels.some((label) => part.startsWith(label)))
    .map((part) => part.slice(part.indexOf(":") + 1).trim())
    .filter(Boolean);
}

function hasExplicitPeopleScope(text: string): boolean {
  return /(?:نطاق صناع القرار\s*:|لدى|في\s+(?:شركة|شركات)|شركة محددة|اسم الشركات?|\b(?:company|companies|at)\s*[:=]?\s*)\s*\p{L}/iu.test(text);
}

/** Questions the customer may skip and the plan still go ahead (the period is then left open, the cap is the job's own). */
const PROCEED_WHEN_SKIPPED = new Set(["social_time_required", "volume_cap_required", SOCIAL_DISCOVERY_IDS.perPost]);

/** What to say, in one plain sentence and without a card, when a question that cannot be inferred was skipped. */
const PLAIN_AFTER_SKIP_AR: Record<string, string> = {
  [SOCIAL_DISCOVERY_IDS.page]: `${FACEBOOK_TOPIC_OR_PAGE_AR} اكتب الموضوع أو اسم الصفحة أو رابطها في رسالتك، وسأكمل من حيث توقفنا.`,
  social_platform_required: "أحتاج أن أعرف المنصة لأجهز لك الخطة. اكتب اسمها في رسالتك، مثل «يوتيوب» أو «تيك توك» أو «إكس»، وسأكمل من حيث توقفنا.",
  social_comment_target_required: "لم يتبقَّ سوى مصدر التعليقات. اكتب موضوع الفيديوهات أو اسم القناة في رسالتك، أو الصق رابط فيديو، وسأجهز لك الخطة.",
  social_channel_required: "لتجهيز الخطة أحتاج اسم قناة واحدة على الأقل. اكتب اسم القناة أو الصق رابطها في رسالتك، أو اكتب موضوعًا وسأبحث لك عن فيديوهاته.",
  social_topic_required: "اكتب موضوعًا أو اسم قناة في رسالتك، ولو كلمة واحدة، وسأجهز لك الخطة فورًا.",
  social_x_topic_required: "اكتب موضوعًا أو كلمات البحث في رسالتك، ولو كلمة واحدة، وسأجهز لك الخطة فورًا.",
  [REPORT_COUNTRY_QUESTION_ID]: "أحتاج أن أعرف الدولة لأجهز لك التقرير. اكتبها في رسالتك، مثل «في مصر»، وسأكمل من حيث توقفنا.",
};
const PLAIN_FACEBOOK_TARGET_AFTER_SKIP_AR = "لم يتبقَّ سوى مصدر التعليقات. اكتب موضوع المنشورات في رسالتك، أو الصق رابط منشور أو رابط صفحة عامة، وسأجهز لك الخطة.";
/** The country and the sector decide what is searched and what it costs: a plan is never priced without them, so a skip is answered with the next step, never silence. */
const TYPED_FOLLOW_UP_AFTER_SKIP: Record<string, string> = {
  company_country_required: "اكتب اسم الدولة بكلماتك، مثل: مصر أو السعودية أو ألمانيا.",
  company_industry_required: "اكتب القطاع بكلماتك، مثل: الكهرباء أو الاتصالات أو التأمين.",
  people_country_required: "اكتب اسم الدولة بكلماتك، مثل: مصر أو السعودية أو ألمانيا.",
};
const PLAIN_AFTER_SECOND_SKIP_AR: Record<string, string> = {
  company_country_required: "لا أستطيع تسعير الطلب قبل معرفة الدولة. اكتبها في رسالتك مع طلبك، مثل «١٠ شركات كهرباء في مصر»، وأجهز لك الخطة والسعر.",
  company_industry_required: "لا أستطيع تسعير الطلب قبل معرفة القطاع. اكتبه في رسالتك مع طلبك، مثل «١٠ شركات كهرباء في مصر»، وأجهز لك الخطة والسعر.",
  people_country_required: "لا أستطيع تسعير الطلب قبل معرفة الدولة. اكتبها في رسالتك مع طلبك، مثل «٣ مديرين في شركات الطاقة في السعودية»، وأجهز لك الخطة والسعر.",
};
const PLAIN_AFTER_SKIP_GENERIC_AR = "تحتاج الخطة هذه المعلومة لتكون دقيقة. اكتبها في رسالتك وسأكمل من حيث توقفنا.";

/**
 * The ONE question this turn needs, or null. Questions the customer skipped are never shown again: a skippable one (the period,
 * the cap) is left to its default, any other is answered by a plain sentence asking for typed text, not by the same card.
 */
export function getDeterministicDiscoveryQuestion(
  text: string,
  brief: ResearchBrief,
  capabilities: Capability[] = [],
  options: { skipped?: ReadonlySet<string>; skipCounts?: ReadonlyMap<string, number> } = {},
): any | null {
  const skipped = options.skipped;
  if (!skipped || skipped.size === 0) return discoveryQuestionFor(text, brief, capabilities, new Set());
  const ignore = new Set<string>();
  for (let attempt = 0; attempt < 4; attempt++) {
    const question = discoveryQuestionFor(text, brief, capabilities, ignore);
    if (!question || !skipped.has(question.id)) return question;
    if (PROCEED_WHEN_SKIPPED.has(question.id)) { ignore.add(question.id); continue; }
    // First skip of the country or the sector: ONE typed follow-up under the same id (its answer is read exactly like the card's). A second skip: the next step in a sentence.
    const typedFollowUp = TYPED_FOLLOW_UP_AFTER_SKIP[question.id];
    if (typedFollowUp) {
      if ((options.skipCounts?.get(question.id) ?? 1) <= 1) return { id: question.id, text: typedFollowUp, question: typedFollowUp, type: "free", options: [], allowOther: true };
      return { plain: true, id: `skipped_${question.id}`, text: PLAIN_AFTER_SECOND_SKIP_AR[question.id] };
    }
    const pageLinkSkipped = question.id === SOCIAL_DISCOVERY_IDS.page && /ما رابط صفحة/u.test(String(question.text));
    const facebookTargetSkipped = question.id === "social_comment_target_required" && detectSocialIntent(text).platform === "facebook";
    return { plain: true, id: `skipped_${question.id}`, text: pageLinkSkipped ? FACEBOOK_PAGE_LINK_RETRY_AR : facebookTargetSkipped ? PLAIN_FACEBOOK_TARGET_AFTER_SKIP_AR : PLAIN_AFTER_SKIP_AR[question.id] ?? PLAIN_AFTER_SKIP_GENERIC_AR };
  }
  return null;
}

function discoveryQuestionFor(text: string, brief: ResearchBrief, capabilities: Capability[], ignore: ReadonlySet<string>): any | null {
  const normalized = text || "";
  const isAccount = ACCOUNT_LOOKUP_RE.test(normalized);
  const isPeople = isPeopleSearchRequest(normalized);
  const isCompanies = !isPeople && (/(?:\bcompanies?\b|\bbusinesses\b|شركة|شركات|مؤسسة|مؤسسات|مصنع|مصانع)/iu.test(normalized));
  const isSocialTopic = !isAccount && !isPeople && !isCompanies && SOCIAL_CONTENT_WORDS_RE.test(normalized);
  const accountHandle = ACCOUNT_HANDLE_RE.exec(normalized)?.[1];

  if (isAccount && !accountHandle) {
    return { id: "social_account_required", text: "ما اسم الحساب أو رابطه على المنصة؟", question: "ما اسم الحساب أو رابطه على المنصة؟", type: "free", options: [], allowOther: true };
  }
  if (isPeople) {
    if (!detectCountryFromText(normalized)) return { id: "people_country_required", text: "في أي دولة تريد البحث عن صناع القرار؟", question: "في أي دولة تريد البحث عن صناع القرار؟", type: "single", options: ["مصر", "السعودية", "الإمارات", "أخرى"], allowOther: true };
    const scopeMissing = getMissingCompanyResearchRequirements(normalized).includes("industry") && !hasExplicitPeopleScope(normalized);
    if (scopeMissing) return { id: "people_scope_required", text: "ما المجال أو الشركة التي تريد صناع القرار منها؟", question: "ما المجال أو الشركة التي تريد صناع القرار منها؟", type: "free", options: [], allowOther: true };
    if (!PEOPLE_ROLE_PATTERN.test(normalized)) return { id: "people_roles_required", text: "ما المسميات الوظيفية التي تريدها؟", question: "ما المسميات الوظيفية التي تريدها؟", type: "free", options: [], allowOther: true };
    if (!extractNumberFromText(normalized)) return { id: "people_count_required", text: "كم صانع قرار تريد؟", question: "كم صانع قرار تريد؟", type: "free", options: [], allowOther: true };
  }
  if (isCompanies) {
    const missing = getMissingCompanyResearchRequirements(normalized);
    if (missing.length) return getCompanyRequirementItems(missing, normalized)[0] || null;
    if (!extractNumberFromText(normalized)) return { id: "company_count_required", text: "كم شركة تريد في النتائج؟", question: "كم شركة تريد في النتائج؟", type: "free", options: [], allowOther: true };
  }
  if (!isAccount && !isPeople && !isCompanies) {
    const socialTaskIntent = detectSocialIntent(normalized);
    // A Facebook topic REPORT: the country (a Page is used only if its country matches), then the period (stated by the customer, never proposed unasked), then the size.
    if (socialTaskIntent.report) {
      const gate = reportGate(normalized);
      if (gate) return gate;
      if (!ignore.has("social_time_required") && reportNeedsPeriod(normalized)) return socialTimeWindowQuestion();
      return socialDiscoveryGapQuestion(normalized, ignore, capabilities);
    }
    if (isSocialTopic) {
      // Checked before any plan or mission reading: the customer's answers decide, not the words of their labels.
      const facts = readSocialFacts(normalized);
      // «posts only» on a Facebook topic: no service reads it, said once, nothing quoted or held.
      if (facts.platform === "facebook" && facts.topic && !facts.source && facts.commentsWanted === false) return { plain: true, id: "facebook_posts_only_unavailable", text: FACEBOOK_POSTS_ONLY_UNAVAILABLE_AR };
      // After «أخرى» on the platform question: ONE free-text follow-up. A typed name this service does not read (a name the detector sees as a platform, such as «سناب شات», too) gets one honest sentence.
      const followUp = platformFollowUpStateAr(normalized);
      if (followUp === "asked") return { id: "social_platform_other_required", text: PLATFORM_OTHER_QUESTION_AR, question: PLATFORM_OTHER_QUESTION_AR, type: "free", options: [], allowOther: true };
      if (followUp === "answered" || unsupportedPlatformAnswerAr(normalized)) return { plain: true, id: "platform_unsupported", text: UNSUPPORTED_PLATFORM_AR };
    }
    // A mission over channels (their top videos, then the comments) is decided by its own understanding: the channels
    // and the comment cap are asked ONE at a time, and nothing else is.
    const mission = understandMission(normalized);
    if (mission.kind === "social_ranked_comments" || mission.kind === "social_channel_topic") {
      const step = nextStep(mission, ignore);
      // «N منشور بالتعليقات» from a page, with no comments per post: the total is posts x per post, so the per-post card replaces the cap question.
      if (step.type === "ask_one" && step.id === "volume_cap_required") {
        const perPostGap = socialDiscoveryGapQuestion(normalized, ignore, capabilities);
        if (perPostGap?.id === SOCIAL_DISCOVERY_IDS.perPost) return perPostGap;
      }
      return step.type === "ask_one" ? questionForStep(step) : null;
    }
    const missingSocialTask = getMissingSocialTaskInputs(normalized)[0];
    // Studies / articles / news: no direct source exists, so ask ONE specific question that echoes the topic and country.
    const topicGathering = !socialTaskIntent.task ? detectTopicGathering(normalized) : null;
    if (topicGathering && !hasTopicResearchService(capabilities)) return topicSourceQuestion(topicGathering);
    if (missingSocialTask) return socialTaskQuestion(missingSocialTask, socialTaskIntent.platform);
    // A request the verified social services understand is decided entirely by their own inputs (a link, a
    // channel, a country); the generic topic question below does not apply to it.
    if (socialTaskIntent.task && socialTaskIntent.platform && SOCIAL_TASK_PLATFORMS[socialTaskIntent.task].includes(socialTaskIntent.platform)) {
      if (!ignore.has("social_time_required") && shouldAskSocialTimeWindow(normalized)) return socialTimeWindowQuestion();
      // «كل التعليقات / كل المنشورات» always carries a cap the customer chooses.
      const capQuestion = ignore.has("volume_cap_required") ? null : capQuestionFor(mission);
      const gapQuestion = socialDiscoveryGapQuestion(normalized, ignore, capabilities);
      // «N منشور بالتعليقات» with no comments per post would ask for the total cap; the per-post card is the better question (the total is posts x per post).
      if (capQuestion && gapQuestion?.id === SOCIAL_DISCOVERY_IDS.perPost) return gapQuestion;
      return capQuestion ?? gapQuestion;
    }
  }
  if (isSocialTopic) {
    const missingSocial = getMissingSocialInputs(normalized);
    if (missingSocial.length === 0 && !(!ignore.has("social_time_required") && shouldAskSocialTimeWindow(normalized))) {
      const gap = socialDiscoveryGapQuestion(normalized, ignore, capabilities);
      if (gap) return gap;
    }
    if (missingSocial.includes("social_topic_required")) return { id: "social_topic_required", text: "ما الموضوع أو الكلمات التي تريد البحث عنها؟", question: "ما الموضوع أو الكلمات التي تريد البحث عنها؟", type: "free", options: [], allowOther: true };
    if (missingSocial.includes("social_platform_required")) return { id: "social_platform_required", text: "على أي منصة تريد البحث؟", question: "على أي منصة تريد البحث؟", type: "single", options: ["تيك توك", "فيسبوك", "يوتيوب", "إنستغرام", "أخرى"], allowOther: true };
    if (!ignore.has("social_time_required") && shouldAskSocialTimeWindow(normalized)) return socialTimeWindowQuestion();
  }
  return null;
}

/**
 * What a Facebook request still needs before it can be planned: the page (Facebook is not searched by topic) or the comments per post. The
 * FIRST question only; the handler turns it into the full card (see socialDiscoveryItems). A question the customer skipped is not asked again.
 */
function socialDiscoveryGapQuestion(text: string, ignore: ReadonlySet<string>, capabilities: Capability[] = []) {
  const context = { otherFacebookService: otherFacebookServiceExists(capabilities) };
  const trigger = socialDiscoveryTrigger(text, context);
  if (!trigger) return null;
  // The customer answered the page question and the answer is still only a name: say so in one sentence, never the same card twice.
  if (trigger === "page_link" && facebookPageLinkAlreadyAsked(text)) return { plain: true, id: "facebook_page_link_retry", text: FACEBOOK_PAGE_LINK_RETRY_AR };
  const id = trigger === "page" || trigger === "page_link" ? SOCIAL_DISCOVERY_IDS.page : SOCIAL_DISCOVERY_IDS.perPost;
  if (trigger !== "trend" && trigger !== "report" && ignore.has(id)) return null;
  const cardItems = socialDiscoveryItems(text, context).filter((entry) => !ignore.has(entry.id));
  const first = trigger === "trend" || trigger === "report" ? cardItems[0] : cardItems.find((entry) => entry.id === id);
  return first ? { id: first.id, text: first.text, question: first.question, type: first.type, options: first.options, allowOther: first.allowOther } : null;
}

/** The ONE window question: the four periods, never preselected. The warning about long periods rides with its intro. */
function socialTimeWindowQuestion() {
  const question = windowQuestion();
  return {
    id: "social_time_required",
    text: question.text,
    question: question.text,
    type: "single",
    options: question.options,
    allowOther: true,
  };
}

/**
 * A feed search (posts or videos found by a subject) needs a period. It is asked for ONCE, whatever else is known,
 * unless the customer wrote dates or a relative period, or named a known event (the plan then shows that window, editable);
 * a skipped question gets the proposed default window on the plan. Comments are never asked for a period (the plan proposes one).
 * Trending feeds, a single link and a named channel have their own scope.
 */
const FACEBOOK_NAMED_PAGE_RE = /(?:^|\s)(?:صفحة|صفحه|بيج)\s+(?!(?:ال)?(?:فيسبوك|فيس)(?![\p{L}]))[\p{L}\p{N}_.\-]+/u;

function shouldAskSocialTimeWindow(text: string): boolean {
  const intent = detectSocialIntent(text);
  if (!intent.platform || ACCOUNT_LOOKUP_RE.test(text)) return false;
  // The Facebook topic REPORT is a report FOR a period: it is asked once unless the customer states one, and never proposed unasked.
  if (intent.report) return reportNeedsPeriod(text);
  // Comments of videos or posts: the plan proposes the last month (or a known event's dates) instead of a question; one fewer step.
  if (intent.task === "comments") return false;
  if (intent.wantsTrending || intent.channelRef || intent.targetUrl || intent.discover === "channel" || intent.discover === "target") return false;
  // «٢٠ بوست من صفحة اليوم السابع»: the latest posts of a NAMED page are scoped by the page, like a named channel's videos, not by a period.
  if (intent.platform === "facebook" && intent.task === "page_posts" && FACEBOOK_NAMED_PAGE_RE.test(text)) return false;
  if (!SOCIAL_CONTENT_WORDS_RE.test(text)) return false;
  return resolveTimeWindow(text, { needsWindow: true }).status === "missing";
}

export interface ChatHandlerInput {
  userId: string;
  conversationId?: string;
  message: string;
  answers?: any;
  userBalance?: number;
  testScenario?: string;
  uploadedFiles?: any[];
  isGuest?: boolean;
  /** Set by the route when this message only gave the customer's name (already stored); answered without a model turn. */
  capturedName?: string;
  personaProfile?: { persona?: unknown; purposes?: unknown; topic?: unknown; name?: unknown; full_name?: unknown };
  /** Columns of the result on screen, sent by the page so the model can name real columns when the customer shapes a file. */
  resultColumns?: Array<{ key?: unknown; titleAr?: unknown }>;
  authMs?: number;
  rateLimitMs?: number;
}

/** Column hints are untrusted: keep short plain names only. They are validated again against the real data at download. */
export function sanitizeResultColumns(raw: unknown): DatasetColumn[] {
  if (!Array.isArray(raw)) return [];
  const clean = (value: unknown, max: number) => String(value ?? "").replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
  const out: DatasetColumn[] = [];
  for (const item of raw.slice(0, 60)) {
    const key = clean((item as any)?.key, 60);
    const titleAr = clean((item as any)?.titleAr, 60);
    if (/^[A-Za-z0-9_\u0600-\u06FF-]{1,60}$/.test(key) && titleAr) out.push({ key, titleAr });
  }
  return out;
}

export interface ChatHandlerResponse {
  conversationId: string;
  conversationTitle?: string;
  messageId: string;
  role: "assistant";
  contentAr: string;
  outputType: LlmTurnOutput["type"];
  intent?: "chat" | "research";
  planQuote?: any;
  revisionQuote?: any;
  /** A validated file spec for the result on screen; the page turns it into a download of the shaped file. */
  fileShape?: { spec: any; descriptionAr: string; jobId?: string };
  clarificationQuestions?: string[];
  clarificationItems?: NormalizedClarificationQuestion[];
  clarificationIntro?: string;
  suggestedAlternative?: any;
  refusalReason?: string;
  tokensUsed: {
    input: number;
    output: number;
    costUsd: number;
  };
  turnStats?: {
    modelCalls: number;
    catalogSearches: number;
    latencyMs: number;
    stepTimings?: {
      supabaseMs?: number;
      catalogMs?: number;
      llmMs?: number;
      quoteMs?: number;
      totalMs?: number;
      tExtractMs: number;
      tCatalogSearchMs: number;
      tPlanLlmMs: number;
      tQuoteMs: number;
      authMs?: number;
      rateLimitMs?: number;
      conversationMs?: number;
      briefSavesMs?: number;
      briefMs?: number;
      historyMs?: number;
      quoteRpcMs?: number;
      writesMs?: number;
      awaitsCount?: number;
      auth?: number;
      rateLimit?: number;
      conversation?: number;
      briefSaves?: number;
      history?: number;
      catalog?: number;
      quoteRpc?: number;
      writes?: number;
      [key: string]: number | undefined;
    };
  };
}

/** Turn stats for replies that finish before any model call or catalog search (greeting, required-input question). */
function zeroModelTurnStats(
  conversationId: string,
  messageId: string,
  turnStartTime: number,
  stageTimings?: {
    supabaseMs?: number;
    catalogMs?: number;
    llmMs?: number;
    quoteMs?: number;
    authMs?: number;
    rateLimitMs?: number;
    conversationMs?: number;
    briefSavesMs?: number;
    historyMs?: number;
    quoteRpcMs?: number;
    writesMs?: number;
    awaitsCount?: number;
    tExtractMs?: number;
  },
): NonNullable<ChatHandlerResponse["turnStats"]> {
  const latencyMs = Date.now() - turnStartTime;
  console.log(`[chat:turn] conversationId=${conversationId} messageId=${messageId} modelCalls=0 catalogSearches=0 latencyMs=${latencyMs}`);
  const authMs = stageTimings?.authMs ?? 0;
  const rateLimitMs = stageTimings?.rateLimitMs ?? 0;
  const conversationMs = stageTimings?.conversationMs ?? 0;
  const briefSavesMs = stageTimings?.briefSavesMs ?? 0;
  const historyMs = stageTimings?.historyMs ?? 0;
  const catalogMs = stageTimings?.catalogMs ?? 0;
  const quoteRpcMs = stageTimings?.quoteRpcMs ?? 0;
  const writesMs = stageTimings?.writesMs ?? 0;
  const awaitsCount = stageTimings?.awaitsCount ?? 0;
  const supabaseMs = stageTimings?.supabaseMs ?? 0;
  const llmMs = stageTimings?.llmMs ?? 0;
  const quoteMs = stageTimings?.quoteMs ?? quoteRpcMs;
  const tExtractMs = stageTimings?.tExtractMs ?? 0;

  const stepTimings = {
    supabaseMs,
    catalogMs,
    llmMs,
    quoteMs,
    totalMs: latencyMs,
    tExtractMs,
    tCatalogSearchMs: catalogMs,
    tPlanLlmMs: llmMs,
    tQuoteMs: quoteMs,
    authMs,
    rateLimitMs,
    conversationMs,
    briefSavesMs,
    briefMs: briefSavesMs,
    historyMs,
    quoteRpcMs,
    writesMs,
    awaitsCount,
    auth: authMs,
    rateLimit: rateLimitMs,
    conversation: conversationMs,
    briefSaves: briefSavesMs,
    brief: briefSavesMs,
    history: historyMs,
    catalog: catalogMs,
    quoteRpc: quoteRpcMs,
    quote: quoteMs,
    writes: writesMs,
  };

  console.info(JSON.stringify({ tag: "chat_stage_timings", ...stepTimings, awaitsCount }));

  return {
    modelCalls: 0,
    catalogSearches: 0,
    latencyMs,
    stepTimings,
  };
}

/** Rough token estimate for Arabic/English mixed text (chars/4 heuristic). */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/** Conversation context budget. When reached, older turns are summarized instead of blocking. */
export const CONTEXT_TOKEN_LIMIT = 40000;

/** Max tokens for a single catalog tool_result block sent back to the model. */
const CATALOG_RESULT_TOKEN_CAP = 2500;

/**
 * Compact catalog results for the model's next turn: top 5 endpoints with only
 * the fields needed to ask questions or propose a plan (id alias, Arabic name,
 * platform, required params, billing unit, points per unit). No descriptions,
 * no examples, no full schemas. Capped at ~2,500 tokens.
 */
export function buildCompactCatalogSummary(results: CatalogEndpointSummary[]): string {
  const header =
    "[نتائج بحث الكتالوج — داخلية: لا تعرضها للمستخدم كنص. استخدمها لاستدعاء ask_questions أو propose_plan]";
  if (!results || results.length === 0) {
    return `${header}\nلا توجد أدوات مطابقة في الكتالوج لهذا البحث.`;
  }
  const requiredParams = (r: CatalogEndpointSummary): string => {
    try {
      const schema: any = typeof r.paramsSchema === "string" ? JSON.parse(r.paramsSchema) : r.paramsSchema;
      const required: string[] = Array.isArray(schema?.required) ? schema.required : [];
      const props = schema?.properties ? Object.keys(schema.properties) : [];
      const names = required.length > 0 ? required : props.slice(0, 3);
      return names.length > 0 ? names.join(",") : "-";
    } catch {
      return "-";
    }
  };
  let count = 5;
  let block = "";
  while (count >= 1) {
    const lines = results.slice(0, count).map(
      (r, i) =>
        `${i + 1}. ${r.slug} | ${r.nameAr} | ${r.platform} | مدخلات: ${requiredParams(r)} | الوحدة: ${r.billingUnit || "-"} | ${r.pointsPerUnit ?? "?"} نقطة/وحدة`,
    );
    block = `${header}\n${lines.join("\n")}`;
    if (estimateTokens(block) <= CATALOG_RESULT_TOKEN_CAP) break;
    count = Math.floor(count / 2);
  }
  return block;
}

/**
 * Code-built discovery fallback: real questions with real options, never the
 * generic sentence. Constructed directly (not via model-output normalization)
 * so trusted code questions are never dropped.
 */
export function filterQuestionsAlreadyInBrief(
  questions: NormalizedClarificationQuestion[],
  brief?: ResearchBrief,
): NormalizedClarificationQuestion[] {
  if (!brief) return questions;
  return questions.filter((q) => {
    const id = (q.id || "").toLowerCase();
    const text = (q.text || q.question || "").toLowerCase();

    // 1. Platform
    if (id === "code_platform" || text.includes("ما المنصة المستهدفة") || text.includes("ما المنصة المطلوبة")) {
      if (brief.platforms && brief.platforms.length > 0) return false;
    }
    // 2. Generic Topic / Keywords (only drop the generic topic question, never specific angles or questions)
    if (id === "code_topic" || text.includes("ما الكلمات المفتاحية أو الموضوع المطلوب") || text.includes("ما الموضوع المطلوب")) {
      if (brief.topics && brief.topics.length > 0) return false;
    }
    // 3. Volume (total count)
    if (id === "code_volume" || text.includes("ما حجم البيانات المطلوب جمعها")) {
      if (typeof brief.targetVolume === "number" && brief.targetVolume > 0) return false;
    }
    // 4. Comments per post / Source
    if (id === "code_comments_per_post" || text.includes("ما الحد الأقصى للتعليقات لكل منشور") || text.includes("مصدر التعليقات")) {
      if (brief.commentsPerPost !== undefined || (brief.notes && brief.notes.includes("المصدر"))) return false;
    }
    // 5. Date range
    if (id === "code_date_range" || text.includes("ما الفترة الزمنية لجمع البيانات")) {
      if (brief.dateRange) return false;
    }
    // 6. Language
    if (id === "code_language_dialect" || text.includes("ما اللغة أو اللهجات المطلوبة")) {
      if (brief.language) return false;
    }

    return true;
  });
}

/**
 * Remove duplicate or repetitive intro phrases (e.g. "عشان أجهز لك خطة دقيقة، محتاج أعرف:").
 */
export function deduplicateIntroText(text: string): string {
  if (!text) return "";
  let cleaned = text.trim();

  // 1. Deduplicate consecutive identical lines
  const lines = cleaned.split("\n").map((l) => l.trim()).filter(Boolean);
  const dedupedLines: string[] = [];
  for (const line of lines) {
    if (dedupedLines.length > 0 && dedupedLines[dedupedLines.length - 1] === line) {
      continue;
    }
    dedupedLines.push(line);
  }
  cleaned = dedupedLines.join("\n");

  // 2. Deduplicate repeated intro phrases throughout the message
  const introPatterns = [
    /عشان أجهز لك خطة دقيقة،?\s*محتاج أعرف:?/g,
    /قبل ما أجهز الخطة،?\s*جاوبني على الأسئلة دي:?/g,
  ];

  for (const pat of introPatterns) {
    let count = 0;
    cleaned = cleaned.replace(pat, (m) => {
      count++;
      return count === 1 ? m : "";
    });
  }

  return cleaned.replace(/\n{3,}/g, "\n\n").replace(/[ \t]+/g, " ").trim();
}

/**
 * Code-built discovery fallback: real questions with real options, never the
 * generic sentence. Constructed directly (not via model-output normalization)
 * so trusted code questions are never dropped. Questions for fields already
 * known in the brief are filtered out.
 */
export function buildCodeDiscoveryFallback(
  allCapabilities: Capability[],
  userMessage: string = "",
  colonFallback: boolean = false,
  brief?: ResearchBrief,
): { intro: string; items: NormalizedClarificationQuestion[] } {
  const intro = GENERIC_ASK_ONE_INTRO_AR;
  const chips = extractTopicChips(userMessage);
  const dateHint = extractDateHint(userMessage);

  if (colonFallback) {
    const rawItems: NormalizedClarificationQuestion[] = [
      {
        id: "code_topic_angle",
        text: "ما زوايا أو محاور الموضوع المستهدفة؟",
        question: "ما زوايا أو محاور الموضوع المستهدفة؟",
        type: chips.length > 0 ? "single" : "free",
        options: chips.length > 0 ? chips : ["أسعار وتداولات", "آراء وتجارب الجمهور", "الأخبار والتحليلات"],
        allowOther: true,
      },
      {
        id: "code_post_count",
        text: "ما عدد المنشورات المستهدف فحصها؟",
        question: "ما عدد المنشورات المستهدف فحصها؟",
        type: "single",
        options: ["حتى 10 منشورات", "حتى 30 منشوراً", "حتى 50 منشوراً"],
        allowOther: true,
      },
      {
        id: "code_comments_per_post",
        text: "ما الحد الأقصى للتعليقات لكل منشور؟",
        question: "ما الحد الأقصى للتعليقات لكل منشور؟",
        type: "single",
        options: ["حتى 50 تعليقاً", "حتى 100 تعليق", "كل التعليقات المتاحة"],
        allowOther: true,
      },
      {
        id: "code_date_range",
        text: "ما الفترة الزمنية لجمع البيانات؟",
        question: "ما الفترة الزمنية لجمع البيانات؟",
        type: "single",
        options: ["آخر شهر", "آخر ٣ شهور", "آخر ٦ شهور"],
        allowOther: true,
        ...(dateHint ? { defaultOption: toArabicIndicDigits(dateHint) } : {}),
      },
      {
        id: "code_language_dialect",
        text: "ما اللغة أو اللهجات المطلوبة؟",
        question: "ما اللغة أو اللهجات المطلوبة؟",
        type: "single",
        options: ["العربية والمصرية", "العربية والإنجليزية", "كل اللغات"],
        allowOther: true,
      },
    ];
    const items = (brief ? filterQuestionsAlreadyInBrief(rawItems, brief) : rawItems).slice(0, 3);
    return { intro, items };
  }

  const platformLabels = [
    ...new Set(
      (allCapabilities || [])
        .filter((c) => c && c.enabled !== false)
        .map((c) => {
          try {
            return getPlatformLabelAr(String((c as any).platform || (c as any).category || ""));
          } catch {
            return "";
          }
        })
        .filter(Boolean),
    ),
  ].slice(0, 5);
  const platforms =
    platformLabels.length > 0 ? platformLabels : ["فيسبوك", "تيك توك", "إنستغرام", "منصة X", "يوتيوب"];

  const rawItems: NormalizedClarificationQuestion[] = [
    {
      id: "code_platform",
      text: "ما المنصة المستهدفة لجمع البيانات؟",
      question: "ما المنصة المستهدفة لجمع البيانات؟",
      type: "single",
      options: platforms,
      allowOther: true,
    },
    {
      id: "code_topic",
      text: "ما الكلمات المفتاحية أو الموضوع المطلوب؟",
      question: "ما الكلمات المفتاحية أو الموضوع المطلوب؟",
      type: chips.length > 0 ? "single" : "free",
      options: chips,
      allowOther: true,
    },
    {
      id: "code_volume",
      text: "ما حجم البيانات المطلوب جمعها؟",
      question: "ما حجم البيانات المطلوب جمعها؟",
      type: "single",
      options: ["حتى 50 سجلاً", "حتى 100 سجل", "حتى 500 سجل", "أكثر من 500 سجل"],
      allowOther: true,
    },
  ];
  const filtered = brief ? filterQuestionsAlreadyInBrief(rawItems, brief) : rawItems;
  const hasPlatformOrTopic = Boolean(
    (brief?.platforms && brief.platforms.length > 0) || (brief?.topics && brief.topics.length > 0),
  );
  const items = hasPlatformOrTopic ? filtered.slice(0, 1) : filtered.slice(0, 3);
  return { intro, items };
}

/**
 * Automatically builds a robust, validated plan proposal when the user has answered
 * all clarification questions or when Phase 2 is active, preventing dead-end stalls.
 */
export function buildAutoPlanProposal(
  brief: ResearchBrief,
  validationCaps: Capability[],
  message: string = "",
): {
  type: "propose_plan";
  summaryAr: string;
  capabilities: any[];
  outputFormats: string[];
  methodologyNotes: string;
} {
  const requestText = [message, ...(brief.topics || []), ...(brief.keywords || []), brief.notes || ""]
    .filter(Boolean)
    .join(" ");
  const peopleSearch = isPeopleSearchRequest(requestText);
  const isAccountProfileRequest = ACCOUNT_LOOKUP_RE.test(requestText);
  const explicitHandle = /(?:@|tiktok\.com\/@|اسم الحساب المطلوب\s*:\s*@?)([a-zA-Z0-9_.]{2,30})/i.exec(requestText)?.[1];
  const mentionedPlats = detectMentionedPlatforms(message);
  const platform = peopleSearch
    ? "people"
    : (brief.platforms && brief.platforms.some((p) => p !== "web"))
    ? brief.platforms.find((p) => p !== "web")!
    : (mentionedPlats.length > 0 ? mentionedPlats[0] : (brief.topics?.[0]?.includes("شرك") ? "companies" : "tiktok"));
  const platformNorm = platform.toLowerCase();

  // A company request may only use a company search by endpoint or slug, the approved one first. The catalog's platform label
  // never picks it, and nothing else is a fallback: with no such source live the answer is honest and there is no plan.
  const wantsCompanies = !peopleSearch && !isAccountProfileRequest && (platformNorm === "companies" || platformNorm === "b2b");
  const companySource = wantsCompanies ? pickCompanySearchCapability(validationCaps) : null;
  if (wantsCompanies && !companySource) {
    // Not a plan: callers dispatch on `type`, and this one is a plain answer (typed as the plan only to keep the callers' types).
    return { type: "answer_question", answerAr: COMPANY_SOURCE_UNAVAILABLE_AR } as any;
  }

  // Find matching capability in validationCaps
  // The same rule for decision makers: a people search by endpoint or slug, the approved one first, never the platform label.
  const peopleSource = peopleSearch && !isAccountProfileRequest ? pickPeopleSearchCapability(validationCaps) : null;
  if (peopleSearch && !isAccountProfileRequest && !peopleSource) {
    return { type: "answer_question", answerAr: PEOPLE_SOURCE_UNAVAILABLE_AR } as any;
  }
  let matchedCap = companySource
    ? companySource
    : peopleSource
    ? peopleSource
    : isAccountProfileRequest
    ? validationCaps.find((c) => /profile|user/i.test(c.slug) && (!mentionedPlats.length || mentionedPlats.some((p) => c.slug.includes(p))))
    : validationCaps.find((c) => {
    const cPlat = (c.platform || c.category || "").toLowerCase();
    const cSlug = (c.slug || "").toLowerCase();
    const cId = (c.tregEndpointId || c.id || "").toLowerCase();
    if (peopleSearch) {
      return false; // chosen above by name; no other source is a people source
    }
    return cPlat === platformNorm || cSlug.includes(platformNorm);
    });

  if (!matchedCap) {
    matchedCap = getClosestVerifiedCapability(validationCaps);
  }

  const msgVolume = extractTargetVolume(message);
  const volume = isAccountProfileRequest
    ? 1
    : (brief.targetVolume && brief.targetVolume > 0)
    ? brief.targetVolume
    : (msgVolume && msgVolume > 0
      ? msgVolume
      : (brief.postCount && brief.commentsPerPost ? brief.postCount * brief.commentsPerPost : 10));

  // Filter out any greetings or conversational fillers from topics
  const isGreetingWord = (w: string) => {
    const trimmed = (w || "").trim();
    if (!trimmed) return true;
    return isGreetingOrGeneralQuestion(trimmed).isGreeting || /^(ازيك|ازيكوا|ازيكم|مرحبا|مرحباً|أهلاً|أهلا|اهلا|صباح الخير|مساء الخير|سلام عليكم|السلام عليكم|هلا|hello|hi)$/i.test(trimmed);
  };

  const cleanTopics = (brief.topics || []).filter((t) => !isGreetingWord(t));

  // Extract explicit research topic from the current message if present
  let extractedCurrentTopic = "";
  const currentMsgChips = extractTopicChips(message, 4).filter((w) => !isGreetingWord(w));
  if (currentMsgChips.length > 0) {
    extractedCurrentTopic = currentMsgChips.join(" ");
  }

  const topicLabel = isAccountProfileRequest && explicitHandle
    ? `@${explicitHandle}`
    :
    extractedCurrentTopic ||
    (cleanTopics.length > 0 ? cleanTopics[cleanTopics.length - 1] : "البيانات المطلوبة");

  const isCompanySearch = isCompanySearchCapabilityRef(matchedCap.slug, matchedCap.tregEndpointId || matchedCap.id);

  const isPeopleCapability = peopleSearch || /people/i.test(`${matchedCap.slug} ${matchedCap.tregEndpointId || ""}`);
  const platformLabel = isPeopleCapability
    ? "صناع القرار والمهنيون"
    : isCompanySearch
      ? "قواعد بيانات الشركات"
      : getPlatformLabelAr(platformNorm);

  const isProfileCapability =
    (matchedCap.pricingUnit as string) === "profile" ||
    matchedCap.slug.includes("profile") ||
    matchedCap.slug.includes("user");

  const isExplicitHandle =
    typeof topicLabel === "string" &&
    (topicLabel.startsWith("@") || (!topicLabel.includes(" ") && !topicLabel.includes("،") && /^[a-zA-Z0-9_.-]+$/.test(topicLabel)));

  const detectedCountry = detectCountryFromText(requestText);
  const detectedIndustry = detectIndustryFromText(requestText);

  const countryNameAr = detectedCountry?.arabicLabel;
  const hasDetectedIndustry = detectedIndustry.arabicLabel !== "قواعد بيانات الشركات" &&
    detectedIndustry.englishKeywords.some((keyword) => keyword !== "contracting");
  const companyQuery: Record<string, any> = {
    ...(hasDetectedIndustry ? { keyword: { include: detectedIndustry.englishKeywords } } : {}),
    ...(detectedCountry ? { location: { include: [detectedCountry.canonicalEnglish] } } : {}),
  };
  const titleMatch = requestText.match(/\b(ceos?|ctos?|cfos?|coos?|founders?|owners?|directors?|managers?|heads?|vps?|presidents?)\b|الرئيس التنفيذي|مدير(?:ين)?|مؤسس(?:ين)?|رئيس مجلس الإدارة/i);
  const countryCode = detectedCountry ? isoCountryCodeFromName(detectedCountry.canonicalEnglish) : undefined;
  const stepParams: Record<string, any> = isPeopleCapability
    ? {
        q: requestText.slice(0, 300),
        limit: Math.min(volume, 50),
        ...(countryCode ? { country: countryCode } : {}),
        ...(titleMatch ? { title: (titleMatch[1] || titleMatch[0]).replace(/s$/i, "") } : {}),
        ...(hasDetectedIndustry ? { keywords: detectedIndustry.englishKeywords } : {}),
        ...(requiredProfessionalContactFields(requestText).length ? { requiredContactFields: requiredProfessionalContactFields(requestText) } : {}),
        contactFieldsToAttempt: ["work_email", "phone"],
      }
    : isCompanySearch
      ? {
        query: companyQuery,
        search: [hasDetectedIndustry ? detectedIndustry.arabicLabel : "الشركات", countryNameAr]
          .filter(Boolean)
          .join(" في "),
        ...(detectedCountry ? { country: detectedCountry.canonicalEnglish, location: detectedCountry.canonicalEnglish } : {}),
        ...(hasDetectedIndustry ? { industry: detectedIndustry.arabicLabel } : {}),
        pagination: { size: Math.min(volume, 100) },
        }
      : {
          query: topicLabel,
        };

  if (isProfileCapability || isExplicitHandle) {
    stepParams.username = topicLabel.replace(/^@/, "").trim();
  }

  // The brief's window may be the system default («آخر 3 شهور»), which suits a feed of posts or comments but not a directory
  // of people or companies. For those, only a period the customer wrote in this request applies.
  // A feed takes only a window the customer stated, a relative period or a known event: never a default.
  const dateRangeHint = isPeopleCapability || isCompanySearch ? extractDateHint(message) || "" : brief.dateRange || message;
  if (dateRangeHint && !isProfileCapability) {
    const dateFilters = isPeopleCapability || isCompanySearch ? dateFiltersFromHint(dateRangeHint) : requestDateFilters(brief.dateRange, message);
    if (dateFilters.from) stepParams.dateFrom = dateFilters.from;
    if (dateFilters.to) stepParams.dateTo = dateFilters.to;
  }

  const step: any = {
    stepId: "plan_step_1",
    capabilitySlug: matchedCap.slug || matchedCap.id,
    endpointId: matchedCap.tregEndpointId || matchedCap.id || matchedCap.slug,
    params: stepParams,
    targetVolumeMin: 1,
    targetVolumeMax: volume,
    paginationStrategy: matchedCap.paginationType || "cursor",
  };

  const summaryAr = isPeopleCapability
    ? `بحث ${toArabicDigits(volume)} من صناع القرار والمهنيين${hasDetectedIndustry ? ` في قطاع ${industryDisplayLabelAr(detectedIndustry.arabicLabel)}` : ""}${countryNameAr ? ` في ${countryNameAr}` : ""}`
    : isAccountProfileRequest
      ? `بيانات الحساب العام ${topicLabel} على ${platformLabel}`
      : isCompanySearch
      ? `استخراج بيانات ${toArabicDigits(volume)} سجل من شركات ${industryDisplayLabelAr(detectedIndustry.arabicLabel)}${countryNameAr ? ` في ${countryNameAr}` : ""}`
      : `جمع واستخراج ${toArabicDigits(volume)} سجل حول ${topicLabel} من ${platformLabel}`;

  return {
    type: "propose_plan",
    summaryAr,
    capabilities: [step],
    outputFormats: brief.formats && brief.formats.length > 0 ? brief.formats : ["xlsx"],
    methodologyNotes: isPeopleCapability
      ? "البحث عن صناع القرار والمهنيين بحسب المجال والدولة والمسمى الوظيفي؛ وجود أي حقل لا يعني التحقق المستقل من صحته."
      : `جمع وتوثيق البيانات من المصادر المتاحة عبر ${platformLabel} وفق نطاق البحث المحدد.`,
  };
}

/** «آخر ٣ شهور», «خلال شهرين», «آخر أسبوعين»: the relative window words of a request, singular, plural and dual. A unit followed by a year («خلال سنة 2024») is that year, not a relative window. */
const RELATIVE_WINDOW_RE = new RegExp(`(?:آخر|اخر|خلال)\\s*(\\d+|[٠-٩]+|${RELATIVE_COUNT_WORDS_ALT})?\\s*(شهرين|أسبوعين|اسبوعين|يومين|سنتين|عامين|شهور|أشهر|اشهر|شهر|سنوات|سنين|سنة|أعوام|اعوام|عام|أسابيع|اسابيع|أسبوع|اسبوع|أيام|ايام|يوم)(?!\\s*(?:19|20)\\d{2})`, "i");

export function dateFiltersFromHint(hint: string, now = new Date()): { from?: string; to?: string } {
  const stated = parseStatedDates(hint, now);
  if (stated && "conflictNoteAr" in stated) return {};
  if (stated) return { from: stated.from, to: stated.to };
  const year = /\b((?:19|20)\d{2})\b/.exec(hint)?.[1];
  if (year) return { from: `${year}-01-01`, to: `${year}-12-31` };
  const relative = parseRelativeWindow(hint, now);
  return relative ? { from: relative.from, to: relative.to } : {};
}

/** The dates a request stands for, from the first text that states a window: dates, a relative period, a known event or a year. Never a default. */
export function requestDateFilters(...texts: Array<string | undefined>): { from?: string; to?: string } {
  for (const text of texts) {
    if (!text) continue;
    const window = resolveTimeWindow(text, { needsWindow: true });
    // A proposal the plan makes for a request that says «ترند / أحدث» (source "default") is not a date the customer stated.
    if (window.status === "resolved" && window.source !== "default" && window.dateFrom && window.dateTo) return { from: window.dateFrom, to: window.dateTo };
  }
  return {};
}

/**
 * A standalone company, decision-maker or social request whose every required input is stated is read by code into a
 * structured intent and planned WITHOUT a model call: the plan comes out in a fraction of the time, costs no model spend and
 * carries exactly the provider parameters the capability accepts. Anything unclear, any unanswered discovery question and
 * any other kind of request still goes to the model.
 */
export function buildDeterministicPlanFromIntent(
  intent: RequestIntent,
  requestText: string,
  brief: ResearchBrief,
  capabilities: Capability[],
  skipped?: ReadonlySet<string>,
): any | null {
  if (!["companies", "people", "posts", "comments", "videos"].includes(intent.dataType)) return null;
  if (missingInputsForIntent(intent, requestText).length > 0) return null;
  // A question the customer skipped and that has a stated default (the period, the cap) no longer stands in the way of the plan.
  if (getDeterministicDiscoveryQuestion(requestText, brief, capabilities, { skipped })) return null;
  const enabled = (capability: Capability) => capability.enabled !== false && (capability.status === "verified" || capability.status === undefined);
  if (intent.dataType === "companies") {
    // Only a company search by endpoint or slug counts (never the catalog's platform label); with none live the answer is honest and nothing is planned.
    if (!pickCompanySearchCapability(capabilities)) return { type: "answer_question", answerAr: COMPANY_SOURCE_UNAVAILABLE_AR };
  } else if (intent.dataType === "people") {
    if (!pickPeopleSearchCapability(capabilities)) return null;
  } else {
    const social = detectSocialIntent(requestText);
    if (!social.task || !social.platform || getMissingSocialTaskInputs(requestText).length > 0) return null;
    const cap = socialCapabilityForIntent(social);
    if (!cap || !capabilities.some((c) => c.slug === cap.slug && enabled(c))) return null;
  }
  return buildAutoPlanProposal(brief, capabilities, requestText);
}

/** Keep people-search requests on the people capability, even if the model
 * proposes a generic company plan or refuses while that capability is enabled. */
export function routePeopleAlternative(
  output: any,
  brief: ResearchBrief,
  capabilities: Capability[],
  requestText: string,
): any {
  if (!isPeopleSearchRequest(requestText)) return output;

  const peopleCapability = pickPeopleSearchCapability(capabilities)
    || APPROVED_CAPABILITY_CATALOG.find((capability) => capability.slug === "professional-people-search");
  if (!peopleCapability) {
    return output;
  }
  const peopleCapabilities = capabilities.some((capability) => capability.slug === peopleCapability.slug)
    ? capabilities
    : [...capabilities, peopleCapability];

  // Respect a model clarification only while a required field is still
  // missing. Once the deterministic inputs are complete, do not let the model
  // insert another question or stall the plan.
  if (output?.type === "ask_clarification" || output?.type === "ask_questions") {
    return getDeterministicDiscoveryQuestion(requestText, brief)
      ? output
      : buildAutoPlanProposal(brief, peopleCapabilities, requestText);
  }

  const proposedPeopleCapability = output?.type === "propose_plan" &&
    Array.isArray(output.capabilities) &&
    output.capabilities.some((step: any) => /people/i.test(
      `${step?.capabilitySlug || ""} ${step?.endpointId || ""}`,
    ));
  if (proposedPeopleCapability) return output;

  if (![
    "suggest_alternative",
    "propose_plan",
    "refuse",
    "answer_question",
    "search_catalog",
  ].includes(output?.type)) return output;

  if (!detectCountryFromText(requestText)) {
    const question = "ما الدولة التي تريد البحث فيها عن صناع القرار والمهنيين؟";
    const intro = "قبل إعداد عرض السعر، أحتاج تحديد الدولة حتى لا أفترضها.";
    return {
      type: "ask_clarification",
      reasonAr: intro,
      intro,
      questions: [{ id: "people_country_required", question, type: "free", allowOther: true }],
      questionsAr: [question],
    };
  }

  return buildAutoPlanProposal(brief, peopleCapabilities, requestText);
}

/** Route explicit company-search intent to the verified company capability when
 * the model stalls or suggests an unrelated service. Never quote without scope.
 */
export function routeCompanySearchRequest(
  output: any,
  brief: ResearchBrief,
  capabilities: Capability[],
  requestText: string,
): any {
  if (isPeopleSearchRequest(requestText)) return output;
  const entity = extractEntityType(requestText);
  // The Arabic entity words alone miss an English request («50 contractor companies in Egypt»): for a plan the model proposed, the
  // request intent covers both languages (an answer the code built, such as the methodology file, is never rebuilt).
  const englishCompanyPlan = output?.type === "propose_plan" && extractRequestIntent(requestText).dataType === "companies";
  if (entity.entityType !== "companies" && !englishCompanyPlan) return output;

  // The questions about the scope come first, whatever sources are live (they need no source).
  const missing = getMissingCompanyResearchRequirements(requestText);
  if (missing.length > 0) {
    const items = getCompanyRequirementItems(missing, requestText);
    const questions = items.map((item) => item.text);
    const intro = "قبل إعداد عرض السعر، أحتاج تحديد نطاق البحث وهدف التواصل حتى لا أخمّن تفاصيل قد تغيّر النتائج.";
    return {
      type: "ask_clarification",
      reasonAr: intro,
      intro,
      questions: items,
      questionsAr: questions,
    };
  }

  // Only a company search by endpoint or slug, the approved one first; the catalog's platform/category label never routes a company
  // request. With none live the reply is honest: no plan, no reserve.
  const companyCapability = pickCompanySearchCapability(capabilities);
  if (!companyCapability) return { type: "answer_question", answerAr: COMPANY_SOURCE_UNAVAILABLE_AR };
  const companyCapabilities = capabilities.some((capability) => capability.slug === companyCapability.slug)
    ? capabilities
    : [...capabilities, companyCapability];

  // Company requests need a single, priceable company-search capability. The
  // model may return a superficially relevant multi-step plan that later fails
  // validation or inflates the requested volume, so rebuild it deterministically.
  return buildAutoPlanProposal(brief, companyCapabilities, requestText);
}

export function routeUnavailablePlatformRequest(output: any, requestText: string): any {
  // TREG-backed capabilities are owner-confirmed and are not blocked by a
  // second local availability gate. Pricing and executable plans are still
  // validated against the server catalog below.
  return output;
}

/**
 * Deterministic history compaction: keep the first message and the most recent
 * turns, replace the middle with a compact internal summary. The active plan
 * state (if any) is preserved in the summary.
 */
export function summarizeConversationHistory(
  messages: Array<{ role: string; content: string }>,
  planSummary?: string,
): Array<{ role: "system" | "user" | "assistant"; content: string }> {
  const KEEP_RECENT = 4;
  const normalized = messages.map((m) => ({
    role: (m.role === "user" || m.role === "assistant" ? m.role : "system") as "system" | "user" | "assistant",
    content: String(m.content || ""),
  }));
  if (normalized.length <= KEEP_RECENT + 1) return normalized;
  const first = normalized[0];
  const recent = normalized.slice(-KEEP_RECENT);
  const middle = normalized.slice(1, -KEEP_RECENT);
  const lines = middle.map((m) => {
    const who = m.role === "user" ? "المستخدم" : "المساعد";
    return `- ${who}: ${m.content.slice(0, 80)}`;
  });
  if (planSummary) lines.push(`- الخطة الحالية: ${planSummary}`);
  return [
    first,
    {
      role: "system",
      content: `[ملخص المحادثة السابقة — داخلي، لا تعرضه للمستخدم]\n${lines.join("\n")}`,
    },
    ...recent,
  ];
}

/**
 * Map a live catalog endpoint to the internal Capability shape (same alias the
 * model received). Used for validation and server-side pricing of turn results.
 */
export function catalogEndpointToCapability(ep: CatalogEndpointSummary): Capability {
  const customerPriceUsdPerItem = getCustomerPriceUsdPerCatalogItem({
    id: ep.id,
    slug: ep.slug,
    platform: ep.platform,
    nameEn: ep.nameEn,
    nameAr: ep.nameAr,
  });
  const seeded = RAW_SEED_CAPABILITIES.find((cap) => cap.slug === ep.slug);
  return {
    id: ep.slug,
    slug: ep.slug,
    platform: ep.platform as any,
    category: ep.platform as any,
    status: "verified",
    unit: (ep.billingUnit === "record" || ep.billingUnit === "row" || ep.billingUnit === "item" ? "item" : "page") as any,
    estimatedCostUsdPerUnit: ep.catalogPriceUsd,
    pointsPerUnit:
      customerPriceUsdPerItem !== undefined
        ? registryPointsPerUnit(ep.slug, customerPriceUsdPerItem)
        : ep.pointsPerUnit,
    maxItemsPerCall: ep.pagination.maxLimit || 100,
    estimatedSuccessRate: ep.observedSuccessRate,
    nameAr: ep.nameAr,
    nameEn: ep.nameEn,
    descriptionAr: ep.summaryAr,
    paramsSchema: JSON.stringify(ep.paramsSchema || {}),
    tregEndpointId: ep.id,
    tregMethod: ep.method,
    pricingUnit: (customerPriceUsdPerItem !== undefined ? "item" : ep.billingUnit === "call" ? "call" : ep.billingUnit === "page" ? "page" : "item") as any,
    unitCostUsd: ep.catalogPriceUsd,
    customerPriceUsdPerItem,
    maxRows: 5000,
    paginationType: ep.pagination.type === "page" ? "offset" : ep.pagination.type === "cursor" ? "cursor" : "none",
    enabled: true,
  };
}

/** A verified capability presented to the model in the same shape as a live catalog result. */
function capabilityAsCatalogEndpoint(cap: Capability): CatalogEndpointSummary {
  let schema: Record<string, any> = {};
  try {
    schema = typeof cap.paramsSchema === "string" ? JSON.parse(cap.paramsSchema) : (cap.paramsSchema as any) || {};
  } catch {
    schema = {};
  }
  return {
    id: cap.slug,
    slug: cap.slug,
    nameAr: cap.nameAr,
    nameEn: cap.nameEn,
    summaryAr: cap.descriptionAr,
    summaryEn: cap.nameEn,
    platform: String(cap.platform || cap.category),
    method: "POST",
    path: "",
    paramsSchema: schema,
    billingUnit: "item",
    catalogPriceUsd: cap.unitCostUsd,
    pointsPerUnit:
      typeof cap.customerPriceUsdPerItem === "number" && cap.customerPriceUsdPerItem > 0
        ? registryPointsPerUnit(cap.slug, cap.customerPriceUsdPerItem)
        : cap.pointsPerUnit ?? registryPointsPerUnit(cap.slug, cap.unitCostUsd),
    pagination: { type: "cursor", maxLimit: cap.maxRows },
    observedSuccessRate: cap.estimatedSuccessRate ?? 0.99,
    observedSamples: 1000,
    scope: "any_account",
  };
}

/**
 * Plain-terms fix prompt for the model when a proposed plan fails live-catalog
 * validation. Uses Arabic display names only — never internal slugs or ids.
 */
export function buildPlanFixPrompt(
  validation: { errors: string[] },
  turnEndpoints: CatalogEndpointSummary[],
): string {
  const available = turnEndpoints.slice(0, 5).map((ep, i) => {
    let required = "-";
    try {
      const schema: any =
        typeof ep.paramsSchema === "string" ? JSON.parse(ep.paramsSchema) : ep.paramsSchema;
      if (Array.isArray(schema?.required) && schema.required.length > 0) {
        required = schema.required.join("، ");
      }
    } catch {
      /* ignore */
    }
    return `${i + 1}. "${ep.nameAr}" — المدخلات المطلوبة: ${required}`;
  });
  return `[تعليمات داخلية — صحح الخطة]: المقترح الحالي غير صالح:\n- ${validation.errors.join(
    "\n- ",
  )}\nالخدمات المتاحة من البحث الحالي:\n${
    available.join("\n") || "لا توجد خدمات متاحة."
  }\nأعد استدعاء propose_plan باستخدام خدمة متاحة فقط مع كل مدخلاتها المطلوبة. لا تذكر أسماء داخلية أو معرفات للمستخدم.`;
}

const TOPIC_STOPWORDS = new Set(
  "في عن من على إلى الي و هاتلي هات عايز عاوز محتاج أسحب سحب جمع بيانات داتا آخر اخر شهور شهر شهورا سنة سنوات عام أعوام أسبوع أسابيع يوم أيام مصر فيسبوك تيك توك انستغرام إنستغرام يوتيوب تويتر ريديت لينكد reddit tiktok instagram facebook youtube x comments comment posts post بوست بوستات منشور منشورات تعليق تعليقات الـ ده دي تلك هذا هذه التي الذي بيتكلموا تتكلم ازيك ازيكوا ازيكم مرحبا مرحباً اهلا أهلا أهلاً هاي سلام سلامو عليكم السلام صباح مساء الخير hello hi hey welcome خلال منذ الماضي الماضية الماضيه السابق اسبوعين أسبوعين شهرين يومين كومنت كومنتس كومنتات تغريدات تغريدة تويت إنت انت مين شكرا شكراً تمام ماشي فندم باشا يا حتى سجل سجلاً سجلات شركة شركات مؤسسة مؤسسات استخرج استخراج اريد أريد مجال تخصص نشاط فقط حجم عدد خمس خمسة ست ستة سبع سبعة ثمانية تمانية تسع تسعة عشر عشرة عشرين ثلاثين أربعين خمسين ستين سبعين ثمانين تسعين مية مائة ألف need want companies company records".split(
    " ",
  ),
);

/** Extract up to 4 suggestion chips (topic keywords) from the user's message. */


export { discoveryQuestionPriority };

/** Convert Western digits to Arabic-Indic to match the UI's date options. */
export function toArabicIndicDigits(text: string): string {
  return text.replace(/[0-9]/g, (d) => "٠١٢٣٤٥٦٧٨٩"[Number(d)]);
}

export function extractTopicChips(userMessage: string, maxChips = 4): string[] {
  if (!userMessage) return [];
  let text = userMessage.trim();

  // If the message is a JSON payload (e.g. clarification_answers submission)
  if (text.startsWith("{") || text.includes('"clarification_answers"')) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed.answers)) {
        text = parsed.answers
          .map((a: any) => (Array.isArray(a.value) ? a.value.join(" ") : String(a.value || "")))
          .join(" ");
      } else {
        text = "";
      }
    } catch {
      text = text.replace(/"[a-zA-Z0-9_-]+"\s*:/g, " ");
    }
  }

  const words = text
    .replace(/[{}[\]]/g, " ")
    .replace(/[؟?!.،,؛:()«»"'_]/g, " ")
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => {
      if (w.length <= 2) return false;
      if (/^\d+$/.test(w)) return false;
      const lower = w.toLowerCase();
      if (TOPIC_STOPWORDS.has(lower)) return false;
      if (INTERNAL_DISCOVERY_KEYS.has(lower)) return false;
      if (/^[a-zA-Z0-9_-]+$/.test(w) && (INTERNAL_DISCOVERY_KEYS.has(lower) || /^[a-z]+[A-Z]/.test(w))) return false;
      return true;
    });

  return [...new Set(words)].slice(0, maxChips);
}

/** Extract a date-range hint from the user's message, e.g. "آخر 3 شهور" or "خلال الفترة من 1 يناير 2026 إلى 30 سبتمبر 2026". */
export function extractDateHint(userMessage: string): string | undefined {
  if (!userMessage) return undefined;
  const rangeMatch = /(?:خلال\s*الفترة\s*)?(?:من|بين)\s+([^\n،,؛!؟?]+?\s+(?:إلى|الى|وحتى|حتى|لحد|لغاية|لغايه)\s+[^\n،,؛!؟?]+)/i.exec(userMessage);
  if (rangeMatch) {
    return rangeMatch[0].trim();
  }
  const m = RELATIVE_WINDOW_RE.exec(userMessage);
  if (m) return m[0].trim();
  const year = /(?:في|سنة|عام|خلال|منذ|since|during|in|year)\s+((?:19|20)\d{2})\b/i.exec(normalizeDigits(userMessage));
  if (year) return year[1];
  // Dates written in other forms (1/9/2026, «١ يناير ٢٠٢٦») and a known event name («كأس العالم ٢٠٢٦») read as a plain range.
  const stated = parseStatedDates(userMessage);
  const dates = stated && !("conflictNoteAr" in stated) ? stated : (() => { const event = knownEventWindow(userMessage); return event ? { from: event.from, to: event.to } : null; })();
  return dates ? `من ${formatDateAr(dates.from)} إلى ${formatDateAr(dates.to)}` : undefined;
}

export function buildClarificationPresentation(
  output: Extract<LlmTurnOutput, { type: "ask_clarification" }>,
  context: { capabilities?: Capability[]; userBalancePoints?: number; persona?: string; userMessage?: string } = {},
) {
  // PR #3 trust boundary (release port): questions are normalized against the
  // enabled capabilities only — platform questions with no enabled backing
  // capability are dropped rather than offered as phantom choices.
  const normalized = normalizeClarificationQuestions(output, {
    capabilities: context.capabilities ?? [],
    userBalancePoints: context.userBalancePoints,
    persona: context.persona,
  });
  // Order: topic keywords -> number of posts -> comments per post -> date range.
  const clarificationItems = normalized
    .map((item, index) => ({ item, index }))
    .sort((a, b) => discoveryQuestionPriority(a.item) - discoveryQuestionPriority(b.item) || a.index - b.index)
    .map(({ item }) => item);

  // Enrich: suggestion chips for an open topic question, date default from the
  // user's own request.
  const userMessage = context.userMessage || "";
  const topicQ = clarificationItems.find((q) => discoveryQuestionPriority(q) === 1);
  if (topicQ && topicQ.options.length === 0) {
    const chips = extractTopicChips(userMessage);
    if (chips.length > 0) {
      topicQ.options = chips;
    } else {
      topicQ.type = "free";
    }
  }
  const dateQ = clarificationItems.find((q) => discoveryQuestionPriority(q) === 4);
  if (dateQ) {
    const hint = extractDateHint(userMessage);
    if (hint) {
      const normalizedHint = toArabicIndicDigits(hint);
      if (!dateQ.options.includes(normalizedHint)) dateQ.options = [normalizedHint, ...dateQ.options].slice(0, 4);
      dateQ.defaultOption = normalizedHint;
    }
  }

  const clarificationQuestions = clarificationItems.map((item) => item.text);
  const intro = sanitizeClarificationText(
    output.reasonAr || GENERIC_ASK_ONE_INTRO_AR,
    200,
  ) || GENERIC_ASK_ONE_INTRO_AR;

  return {
    contentAr: intro,
    clarificationIntro: intro,
    clarificationQuestions,
    clarificationItems,
  };
}

/** What one chat turn has spent and whether its llm_usage row is already written (see ChatHandler.handleUserMessage). */
interface TurnUsageLog {
  written: boolean;
  usage: { inputTokens: number; outputTokens: number; costUsd: number; calls: number };
  model: string;
  conversationId?: string;
  messageId?: string;
}

const SHAPING_NEVER_A_PLAN_AR = "هذا الطلب عن شكل ملفك الحالي ولا يحتاج خطة جديدة، ولن يُخصم عليه أي رصيد. اكتب مثلًا: رتب الملف حسب المدينة، أو شيت لكل مدينة.";

const REVISION_UNAVAILABLE_AR = "هذا التعديل غير متاح الآن. أما تغيير شكل الملف فمجاني: شيت لكل عمود، أو ترتيب، أو تصفية، أو اختيار الأعمدة التي تريدها.";

/** The file spec a model-written sort, filter or column choice stands for, or null for any other edit. */
function shapeSpecFromEditArtifact(output: { action?: string; parameters?: Record<string, any> }): FileSpec | null {
  const params = output.parameters || {};
  if (output.action === "sort" && typeof params.field === "string" && params.field.trim()) {
    return { version: 1, sortBy: [{ column: params.field, direction: params.direction === "asc" ? "asc" : "desc" }] };
  }
  if (output.action === "select_columns" && Array.isArray(params.columns) && params.columns.length > 0 && params.columns.every((c: unknown) => typeof c === "string")) {
    return { version: 1, columns: params.columns };
  }
  if (output.action === "filter" && typeof params.field === "string" && params.field.trim()) {
    const op = (FILTER_OPERATORS as readonly string[]).includes(params.operator) ? params.operator : "contains";
    return { version: 1, filters: [{ column: params.field, op, ...(params.value !== undefined && params.value !== "" ? { value: params.value } : {}) }] } as FileSpec;
  }
  return null;
}

export class ChatHandler {
  private tables: TablesDB | any;
  private llm: LlmClient;
  /** Plan fully stated company, decision-maker and social requests in code (no model call). Tests of the model path switch it off. */
  public deterministicPlanning = true;

  constructor(tables: TablesDB | any) {
    this.tables = tables;
    this.llm = new LlmClient();
  }

  /**
   * One chat turn. Every turn that reaches the handler leaves exactly one llm_usage row: the normal path writes its own
   * (with the turn's summed model usage); a turn answered by code (greeting, identity, studies refusal, deterministic
   * question, file-shaping notice, result follow-up) or ended by an error gets one here, so rows reconcile with messages.
   */
  async handleUserMessage(input: ChatHandlerInput): Promise<ChatHandlerResponse> {
    const turn: TurnUsageLog = { written: false, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 }, model: "" };
    const startedAt = Date.now();
    let response: ChatHandlerResponse;
    try {
      response = await this.handleUserMessageInner(input, turn);
    } catch (err) {
      await this.logTurnUsageIfMissing(input, turn, "handler_error", startedAt);
      throw err;
    }
    await this.logTurnUsageIfMissing(input, turn, response.outputType, startedAt);
    return response;
  }

  private async logTurnUsageIfMissing(input: ChatHandlerInput, turn: TurnUsageLog, reason: string, startedAt: number): Promise<void> {
    if (turn.written || input.isGuest || !input.userId) return;
    const sb =
      this.tables && typeof (this.tables as any).from === "function"
        ? (this.tables as any)
        : null;
    const modelCalled = turn.usage.calls > 0;
    const model = modelCalled ? (turn.model || "unknown") : "deterministic";
    const costUsd = Number(turn.usage.costUsd.toFixed(6));
    noteLocalLlmSpend(costUsd);
    try {
      if (sb) {
        await sb.from("llm_usage").insert({
          user_id: input.userId,
          tokens_in: turn.usage.inputTokens,
          tokens_out: turn.usage.outputTokens,
          model,
          latency_ms: Math.max(0, Date.now() - startedAt),
          reason,
          cost_usd: costUsd,
          created_at: new Date().toISOString(),
        });
      } else {
        await this.tables.createRow({
          databaseId: "digr",
          tableId: "llm_usage",
          rowId: ID.unique(),
          data: {
            conversationId: turn.conversationId || input.conversationId || "",
            userId: input.userId,
            messageId: turn.messageId || "",
            model,
            inputTokens: turn.usage.inputTokens,
            outputTokens: turn.usage.outputTokens,
            costUsd,
            createdAt: new Date().toISOString(),
          },
        });
      }
      turn.written = true;
      // The normal path records the provider cost itself; only a turn that ended in an error after model calls needs it here.
      if (modelCalled && reason === "handler_error") {
        await logProviderCost(this.tables, {
          provider: "llm",
          units: turn.usage.inputTokens + turn.usage.outputTokens,
          costUsd: turn.usage.costUsd,
        });
      }
    } catch (usageErr) {
      console.warn("[llm:USAGE_LOG_FAILED]", (usageErr as any)?.message || usageErr);
    }
  }

  private async handleUserMessageInner(input: ChatHandlerInput, turn: TurnUsageLog): Promise<ChatHandlerResponse> {
    const { userId, message, testScenario } = input;
    const nowIso = new Date().toISOString();
    const turnStartTime = Date.now();
    let modelCallCount = 0;
    let catalogSearchCount = 0;
    let supabaseMs = 0;
    let catalogMs = 0;
    let llmMs = 0;
    let quoteMs = 0;
    let tExtractMs = 0;
    let tCatalogSearchMs = 0;
    let tPlanLlmMs = 0;
    let tQuoteMs = 0;
    const authMs = input.authMs ?? 0;
    const rateLimitMs = input.rateLimitMs ?? 0;
    let conversationMs = 0;
    let briefSavesMs = 0;
    let historyMs = 0;
    let quoteRpcMs = 0;
    let writesMs = 0;
    let awaitsCount = (input.authMs !== undefined ? 1 : 0) + (input.rateLimitMs !== undefined ? 1 : 0);
    const sb =
      this.tables && typeof (this.tables as any).from === "function"
        ? (this.tables as any)
        : null;
    let currentStep = "conversation_init";
    let userMsgId = "";
    let assistantMsgId = "";
    let messagesContext: PriorConversationMessage[] = [];
    /** What the customer actually typed in earlier turns (card answers stay as their stored payload). */
    let rawUserHistoryTexts: string[] = [];
    /** For each of those messages, the label of the question it answers when it was typed instead of tapped on the card. */
    let rawUserHistoryAnswerLabels: Array<string | null> = [];
    let followupBrief: any = {};

    try {
      // 1. Get or Create Conversation
      let conversationId = input.conversationId;
      let totalConvTokens = 0;
      const tSbConvStart = Date.now();
      let userBalance = input.userBalance;
      let userProfile: any = undefined;
      let convBriefFromDb: any = undefined;

      // The balance and the profile do not depend on the conversation row: start both reads now so the three
      // database round-trips of the turn overlap instead of running one after another.
      const balanceRead: Promise<number> | null = userBalance === undefined ? getBalance(this.tables, userId) : null;
      balanceRead?.catch(() => {});
      const profileRead: Promise<any> | null = sb
        ? (async () => sb.from("profiles").select("*").eq("id", userId).maybeSingle())().catch(() => ({ data: null }))
        : null;

      // The capability lists do not depend on the conversation either: read them in the same first wave (a greeting never needs them).
      const capabilitiesRead = isGreetingOrGeneralQuestion(message).isGreeting
        ? null
        : Promise.all([getEnabledCapabilitiesWithCoreServices(this.tables), getCatalogCapabilities(this.tables)]);
      capabilitiesRead?.catch(() => {});
      // True when this turn already knows the conversation has no saved brief (a new conversation, or a row read without one).
      let briefKnownEmpty = false;

      const isGreetingMsg = isGreetingOrGeneralQuestion(message).isGreeting;
      const initialTitle = "محادثة جديدة";
      let currentConversationTitle = initialTitle;

      if (!conversationId) {
        conversationId = ID.unique();
        if (sb) {
          briefKnownEmpty = true;
          awaitsCount++;
          const { error: convCreateErr } = await sb.from("conversations").insert({
            id: conversationId,
            user_id: userId,
            title: initialTitle,
            status: "active",
            created_at: nowIso,
            updated_at: nowIso,
          });
          if (convCreateErr) throw convCreateErr;
        } else {
          awaitsCount++;
          await this.tables.createRow({
            databaseId: "digr",
            tableId: "conversations",
            rowId: conversationId,
            data: {
              userId,
              title: initialTitle,
              status: "active",
              totalTokens: 0,
              costUsd: 0.0,
              createdAt: nowIso,
              updatedAt: nowIso,
            },
          });
        }
      } else if (sb) {
        try {
          awaitsCount++;
          const { data: conv } = await sb
            .from("conversations")
            .select("id, user_id, status, brief, title")
            .eq("id", conversationId)
            .maybeSingle();
          currentConversationTitle = conv?.title || initialTitle;

          if (conv && conv.user_id && conv.user_id !== userId) {
            const authErr: any = new Error("غير مصرح لك بالوصول إلى هذه المحادثة أو تعديل بياناتها.");
            authErr.statusCode = 403;
            throw authErr;
          }

          if (conv?.brief && typeof conv.brief === "object") {
            convBriefFromDb = conv.brief;
          } else {
            briefKnownEmpty = true;
          }

          if (!conv) {
            conversationId = ID.unique();
            awaitsCount++;
            const { error: convCreateErr } = await sb.from("conversations").insert({
              id: conversationId,
              user_id: userId,
              title: initialTitle,
              status: "active",
              created_at: nowIso,
              updated_at: nowIso,
            });
            if (convCreateErr) throw convCreateErr;
          }
        } catch (convErr) {
          throw convErr;
        }
      } else {
        try {
          awaitsCount++;
          const conv: any = await this.tables.getRow({
            databaseId: "digr",
            tableId: "conversations",
            rowId: conversationId,
          });
          currentConversationTitle = conv?.title || initialTitle;
          if (conv && conv.userId && conv.userId !== userId) {
            const authErr: any = new Error("غير مصرح لك بالوصول إلى هذه المحادثة أو تعديل بياناتها.");
            authErr.statusCode = 403;
            throw authErr;
          }
          totalConvTokens = conv?.totalTokens || 0;
        } catch (convErr: any) {
          if (convErr?.statusCode === 403) throw convErr;
          // Conversation not found, create new ID
          conversationId = ID.unique();
        }
      }
      const tSbConvDelta = Date.now() - tSbConvStart;
      supabaseMs += tSbConvDelta;
      conversationMs += tSbConvDelta;

      // 2. Fetch User Points Balance from Ledger
      currentStep = "balance_fetch";
      if (userBalance === undefined) {
        const tSbBalStart = Date.now();
        awaitsCount++;
        userBalance = await (balanceRead ?? getBalance(this.tables, userId));
        const balDelta = Date.now() - tSbBalStart;
        supabaseMs += balDelta;
        conversationMs += balDelta;
      }

      // 2b. Fetch User Profile for Dynamic Persona Context
      currentStep = "profile_fetch";
      const tSbProfStart = Date.now();
      try {
        if (sb) {
          awaitsCount++;
          const { data: prof } = await (profileRead as Promise<any>);
          userProfile = prof || undefined;
        } else {
          awaitsCount++;
          userProfile = await this.tables.getRow({
            databaseId: "digr",
            tableId: "profiles",
            rowId: userId,
          });
        }
      } catch {
        // Profile not found or not created yet
      }
      if (input.personaProfile) {
        const metadataPersona = input.personaProfile.persona;
        userProfile = {
          ...(userProfile || {}),
          ...normalizePersonaProfileFields({
            persona: typeof metadataPersona === "string" ? metadataPersona : undefined,
            purposes: input.personaProfile.purposes,
            topic: input.personaProfile.topic,
          }, userProfile || {}),
          ...(typeof input.personaProfile.name === "string" ? { name: input.personaProfile.name } : {}),
          ...(typeof input.personaProfile.full_name === "string" ? { full_name: input.personaProfile.full_name } : {}),
        };
      }
      const profDelta = Date.now() - tSbProfStart;
      supabaseMs += profDelta;
      conversationMs += profDelta;

      // 3. Ids for the user message and the assistant placeholder.
      userMsgId = ID.unique();
      assistantMsgId = ID.unique();
      turn.conversationId = conversationId;
      turn.messageId = assistantMsgId;

      // 4. Research brief: worked out first (it needs no database write) so its save can share one wave with the message writes.
      currentStep = "brief_resolution";
      let currentBrief = convBriefFromDb;
      if (!currentBrief && briefKnownEmpty) {
        // The conversation row was just read (or created) and holds no brief: a second database read would find nothing.
        currentBrief = peekConversationBrief(conversationId) ?? { platforms: [], topics: [] };
      } else if (!currentBrief) {
        const tBriefRead = Date.now();
        awaitsCount++;
        currentBrief = await getConversationBrief(this.tables, conversationId);
        const briefReadDelta = Date.now() - tBriefRead;
        supabaseMs += briefReadDelta;
        briefSavesMs += briefReadDelta;
      }
      let brief = extractBriefFromMessage(message, currentBrief);
      followupBrief = brief;

    if ((input as any).answers) {
      const rawAns = (input as any).answers;
      if (Array.isArray(rawAns)) {
        brief = extractBriefFromCardAnswers(rawAns, brief);
        followupBrief = brief;
      } else if (typeof rawAns === "object") {
        const normalizedCardItems = Object.entries(rawAns).map(([k, v]) => ({
          questionId: k,
          question: k,
          value: v as any,
        }));
        brief = extractBriefFromCardAnswers(normalizedCardItems, brief);
        followupBrief = brief;
      }
    }

      // One wave instead of three: save the user message and the assistant placeholder, save the brief, and read the
      // history. The history is read before the current message is stored; the current message is added to it by code below.
      const tSbMsgStart = Date.now();
      const writeMessages = async () => {
        if (sb) {
          awaitsCount += 2;
          const [uRes, aRes] = await Promise.all([
            sb.from("messages").insert({
              id: userMsgId,
              conversation_id: conversationId,
              user_id: userId,
              role: "user",
              content_ar: message,
              request_status: "planning",
              created_at: nowIso,
            }),
            sb.from("messages").insert({
              id: assistantMsgId,
              conversation_id: conversationId,
              user_id: userId,
              role: "assistant",
              content_ar: "جاري التفكير وتحليل طلبك...",
              created_at: new Date().toISOString(),
            }),
          ]);
          if (uRes?.error) throw uRes.error;
          if (aRes?.error) throw aRes.error;
        } else {
          awaitsCount += 2;
          await this.tables.createRow({
            databaseId: "digr",
            tableId: "messages",
            rowId: userMsgId,
            data: {
              conversationId,
              userId,
              role: "user",
              content: message,
              status: "ready",
              requestStatus: "planning",
              createdAt: nowIso,
            },
          });
          await this.tables.createRow({
            databaseId: "digr",
            tableId: "messages",
            rowId: assistantMsgId,
            data: {
              conversationId,
              userId,
              role: "assistant",
              content: "جاري التفكير وتحليل طلبك...",
              status: "thinking",
              createdAt: new Date().toISOString(),
            },
          });
        }
      };
      const historyRead: Promise<{ data: any[] | null; error: any }> | null = sb
        ? (async () => await sb
            .from("messages")
            .select("id, role, content_ar, created_at, quote, plan, request_status, request_quote_id")
            .eq("conversation_id", conversationId)
            .order("created_at", { ascending: false })
            .limit(HISTORY_ROWS_FOR_SCOPE))()
        : null;
      historyRead?.catch(() => {});
      awaitsCount += 1 + (sb ? 1 : 0); // the brief save and the history read (the two message writes count themselves)
      const [, , prefetchedHistory] = await Promise.all([
        writeMessages(),
        saveConversationBrief(this.tables, conversationId, userId, brief),
        historyRead,
      ]);
      const msgDelta = Date.now() - tSbMsgStart;
      supabaseMs += msgDelta;
      writesMs += msgDelta;
    tExtractMs = Date.now() - turnStartTime;
    const currentTurnStats = () =>
      zeroModelTurnStats(conversationId, assistantMsgId, turnStartTime, {
        supabaseMs,
        catalogMs,
        llmMs,
        quoteMs: quoteRpcMs || quoteMs,
        authMs,
        rateLimitMs,
        conversationMs,
        briefSavesMs,
        historyMs,
        quoteRpcMs,
        writesMs,
        awaitsCount,
        tExtractMs,
      });

    const userComplained = isRepetitionComplaint(message);
    const greetingOrGeneral = isGreetingOrGeneralQuestion(message);
    const isGreeting = greetingOrGeneral.isGreeting;
    // A result is on screen (the page sent its columns) and the customer asks how the file should look: a chat turn
    // about an existing file, never a new research request, so it skips discovery and planning.
    // How the delivered file should look («قسّم الملف شيت لكل محافظة»): a turn about the saved result, never a new research
    // request. The columns come from the page, or from the customer's latest delivered result when the page sent none.
    const shapingText = formatClarificationMessageForAssistant(message);
    // The customer's answer to one of our shaping questions («أي عمود؟»): resolved in code, never by the model and never as research.
    const shapeAnswer = shapeAnswerFromMessage(message);
    const looksShaping = isFileShapingMessage(shapingText) || Boolean(shapeAnswer);
    let shapingColumns = sanitizeResultColumns(input.resultColumns);
    let deliveredResultJobId: string | null = null;
    // A request for the methodology document, in a conversation that has a delivered job: answered by code (where to press, what it costs).
    const asksMethodology = !looksShaping && !shapeAnswer && asksForMethodology(shapingText) && !isStandaloneResearchRequest(shapingText);
    let methodologyJobId: string | null = null;
    let methodologyBought = false;
    if (asksMethodology && sb) {
      awaitsCount++;
      methodologyJobId = (await latestDeliveredJob(sb, { conversationId, userId }))?.id ?? null;
      if (methodologyJobId) methodologyBought = await isMethodologyPurchased(sb, { userId, jobId: methodologyJobId });
    }
    if (looksShaping && shapingColumns.length === 0 && sb) {
      awaitsCount++;
      const saved = await loadLatestResultColumns(sb, { conversationId, userId });
      shapingColumns = saved.columns;
      deliveredResultJobId = saved.jobId;
    }
    // Only a message about the file, with a delivered result to shape; a research request that merely names a layout ("... ملف لكل منصة") is not one.
    // The answer to a shaping question is about the file whatever else is known (its id proves the context); any other message
    // needs a delivered result to shape.
    const isFileShapingTurn = Boolean(shapeAnswer) || (looksShaping && !isStandaloneResearchRequest(shapingText) && (shapingColumns.length > 0 || Boolean(deliveredResultJobId)));
    const isGeneralQuestion = greetingOrGeneral.isGeneralQuestion || isFileShapingTurn;
    const wantsPriceOrProceed = isPriceOrProceedIntent(message);
    const isComplete = isBriefComplete(brief);
    const hasPlatform = brief.platforms && brief.platforms.length > 0;
    const hasTopic = brief.topics && brief.topics.length > 0 && brief.topics.some((t) => t.trim().length > 0);
    const isCardAnswer = Boolean((input as any).answers) || message.includes("clarification_answers") || (message.trim().startsWith("{") && message.includes("answers"));

    const isTestSearchScenario = typeof testScenario === "string" && testScenario.startsWith("search_");
    const rawUploadedFiles = (input as any).uploadedFiles || [];

    // If incoming uploadedFiles has an exclusion file, persist it into the conversation brief
    if (rawUploadedFiles.length > 0) {
      const topFile = rawUploadedFiles[0];
      if (topFile.baselineRowCount !== undefined || topFile.companyNames !== undefined) {
        brief.exclusionFile = {
          name: topFile.name || "قائمة_الاستبعاد.xlsx",
          baselineRowCount: topFile.baselineRowCount || topFile.companyNames?.length || 0,
          companyNames: topFile.companyNames || [],
          corporateDomains: topFile.corporateDomains || [],
          normalizedEntities: topFile.normalizedEntities || [],
        };
        const tExclSave = Date.now();
        awaitsCount++;
        await saveConversationBrief(this.tables, conversationId, userId, brief);
        const exclDelta = Date.now() - tExclSave;
        supabaseMs += exclDelta;
        briefSavesMs += exclDelta;
      }
    }

    // Active exclusion files: from current request or previously persisted in conversation brief
    const activeFiles = rawUploadedFiles.length > 0
      ? rawUploadedFiles
      : brief.exclusionFile
      ? [brief.exclusionFile]
      : [];

    const assistantFacingMessage = formatClarificationMessageForAssistant(message);
    const researchIntent = extractResearchIntent(assistantFacingMessage, undefined, activeFiles);
    const discoveryDecision = evaluateDiscoveryDecision(researchIntent);
    let isPhase2 = false;

    const mentionedPlats = detectMentionedPlatforms(assistantFacingMessage);
    const approvedSocialPlatforms = ["facebook", "x", "twitter", "youtube", "instagram", "tiktok", "reddit", "linkedin"];
    const hasApprovedPlatformInMessage = mentionedPlats.some((p) => approvedSocialPlatforms.includes(p.toLowerCase()));
    const hasApprovedPlatformInBrief = brief.platforms.some((p) => approvedSocialPlatforms.includes(p.toLowerCase()));
    const hasAnyApprovedPlatform = hasApprovedPlatformInMessage || hasApprovedPlatformInBrief;

    const hasExclusionReferenceOrFile = Boolean(
      brief.exclusionFile ||
      activeFiles.length > 0 ||
      researchIntent.userExclusions.value.hasExclusionReference
    );

    // Greetings never enter research discovery or spend an LLM turn. Ask for a
    // missing name once per conversation, then use the persisted profile name.
    if ((isGreeting || input.capturedName) && !isTestSearchScenario) {
      // The real profile name only: account name first, the top-up sender name last. Never a default.
      const displayName = input.capturedName?.trim() || [userProfile?.name, userProfile?.full_name, userProfile?.sender_name]
        .find((value) => typeof value === "string" && value.trim())?.trim();
      let alreadyAskedName = false;
      if (!displayName && sb) {
        try {
          awaitsCount++;
          const { data: priorNamePrompts } = await sb.from("messages")
            .select("id")
            .eq("conversation_id", conversationId)
            .eq("role", "assistant")
            .ilike("content_ar", `%${NAME_PROMPT_AR.slice(0, 12)}%`)
            .limit(2);
          alreadyAskedName = Boolean(priorNamePrompts?.length);
        } catch {}
      }
      const balanceLine = typeof userBalance === "number" && Number.isFinite(userBalance)
        ? `رصيدك المتاح ${pointsAr(Math.max(0, Math.floor(userBalance)), toArabicDigits)}. `
        : "";
      const greeting = input.capturedName
        ? `تشرفنا يا ${displayName}. ${balanceLine}كيف أساعدك اليوم؟`
        : displayName
          ? `أهلًا ${displayName}، ${balanceLine}كيف أساعدك اليوم؟`
          : alreadyAskedName
            ? `أهلًا بك، ${balanceLine}كيف أساعدك اليوم؟`
            : `أهلًا بك، ${NAME_PROMPT_AR}`;
      const tGreetingWrite = Date.now();
      if (sb) {
        awaitsCount += 2;
        await Promise.all([
          sb.from("messages").update({ content_ar: greeting }).eq("id", assistantMsgId),
          sb.from("messages").update({ request_status: "completed" }).eq("id", userMsgId),
        ]);
      } else {
        awaitsCount += 2;
        await this.tables.updateRow({ databaseId: "digr", tableId: "messages", rowId: assistantMsgId, data: { content: greeting, status: "ready" } });
        await this.tables.updateRow({ databaseId: "digr", tableId: "messages", rowId: userMsgId, data: { requestStatus: "completed" } });
      }
      const greetingDelta = Date.now() - tGreetingWrite;
      writesMs += greetingDelta;
      supabaseMs += greetingDelta;
      return {
        conversationId,
        messageId: assistantMsgId,
        role: "assistant",
        contentAr: greeting,
        outputType: "answer_question",
        intent: "chat",
        tokensUsed: { input: 0, output: 0, costUsd: 0 },
        turnStats: currentTurnStats(),
      };
    }

    // «إنت مين؟» and questions about the technology behind the assistant are answered by code: fixed identity, no
    // model turn, and the technology vendor is never named.
    const identityKind = !isTestSearchScenario ? identityQuestionKind(message) : null;
    if (identityKind) {
      const answer = identityAnswerAr(identityKind);
      const tIdentityWrite = Date.now();
      if (sb) {
        awaitsCount += 2;
        await Promise.all([
          sb.from("messages").update({ content_ar: answer }).eq("id", assistantMsgId),
          sb.from("messages").update({ request_status: "completed" }).eq("id", userMsgId),
        ]);
      } else {
        awaitsCount += 2;
        await this.tables.updateRow({ databaseId: "digr", tableId: "messages", rowId: assistantMsgId, data: { content: answer, status: "ready" } });
        await this.tables.updateRow({ databaseId: "digr", tableId: "messages", rowId: userMsgId, data: { requestStatus: "completed" } });
      }
      const identityDelta = Date.now() - tIdentityWrite;
      writesMs += identityDelta;
      supabaseMs += identityDelta;
      return {
        conversationId,
        messageId: assistantMsgId,
        role: "assistant",
        contentAr: answer,
        outputType: "answer_question",
        intent: "chat",
        tokensUsed: { input: 0, output: 0, costUsd: 0 },
        turnStats: currentTurnStats(),
      };
    }

    // A delivered result whose columns cannot be read right now: answered by code, nothing is guessed or charged.
    const shapingBlockedReplyAr = (!isTestSearchScenario && isFileShapingTurn && shapingColumns.length === 0)
      ? "تعذّرت قراءة أعمدة ملفك الآن، ولم يُخصم أي رصيد. افتح نتائج طلبك ثم أعد كتابة الشكل المطلوب."
      : null;
    if (shapingBlockedReplyAr) {
      const tShapingWrite = Date.now();
      if (sb) {
        awaitsCount += 2;
        await Promise.all([
          sb.from("messages").update({ content_ar: shapingBlockedReplyAr }).eq("id", assistantMsgId),
          sb.from("messages").update({ request_status: "completed" }).eq("id", userMsgId),
        ]);
      } else {
        awaitsCount += 2;
        await this.tables.updateRow({ databaseId: "digr", tableId: "messages", rowId: assistantMsgId, data: { content: shapingBlockedReplyAr, status: "ready" } });
        await this.tables.updateRow({ databaseId: "digr", tableId: "messages", rowId: userMsgId, data: { requestStatus: "completed" } });
      }
      const shapingDelta = Date.now() - tShapingWrite;
      writesMs += shapingDelta;
      supabaseMs += shapingDelta;
      return {
        conversationId,
        messageId: assistantMsgId,
        role: "assistant",
        contentAr: shapingBlockedReplyAr,
        outputType: "answer_question",
        intent: "chat",
        tokensUsed: { input: 0, output: 0, costUsd: 0 },
        turnStats: currentTurnStats(),
      };
    }

    const isCompanyIntent =
      researchIntent.entityType.value === "companies" ||
      extractEntityType(assistantFacingMessage).entityType === "companies" ||
      /\bcompanies?\b|\bbusinesses\b|شركة|شركات|مؤسسات|مؤسسة/.test(assistantFacingMessage.toLowerCase()) ||
      brief.platforms.some((platform) => /compan|b2b|شركة/i.test(platform));
    const requiresExplicitCount = isCompanyIntent || isPeopleSearchRequest(assistantFacingMessage);

    let progressLineWrite: Promise<void> | null = null;
    const writeProgressLine = (): Promise<void> => {
      progressLineWrite ??= (async () => {
        const tProgWrite = Date.now();
        awaitsCount++;
        if (sb) {
          await sb
            .from("messages")
            .update({ content_ar: "أبحث وأحسب السعر..." })
            .eq("id", assistantMsgId);
        } else {
          await this.tables.updateRow({
            databaseId: "digr",
            tableId: "messages",
            rowId: assistantMsgId,
            data: {
              content: "أبحث وأحسب السعر...",
              status: "thinking",
            },
          });
        }
        const progDelta = Date.now() - tProgWrite;
        writesMs += progDelta;
        supabaseMs += progDelta;
      })();
      return progressLineWrite;
    };
    if (isTestSearchScenario) {
      isPhase2 = false;
    } else if (isGreeting || isGeneralQuestion) {
      isPhase2 = false;
    } else if (discoveryDecision.action === "CLARIFY" && discoveryDecision.missingCrucialFields.includes("exclusion_file")) {
      const q = discoveryDecision.questions[0];
      const assistantMsg: ChatHandlerResponse = {
        conversationId,
        messageId: assistantMsgId,
        role: "assistant",
        outputType: "ask_clarification",
        intent: "research",
        contentAr: q.questionAr,
        clarificationIntro: "عشان أجهز لك خطة دقيقة مع استبعاد الشركات المطلوبة، محتاج الملف المرفق:",
        clarificationQuestions: [q.questionAr],
        clarificationItems: [
          {
            id: q.id,
            text: q.questionAr,
            question: q.questionAr,
            type: "single",
            options: q.suggestedAnswersAr || ["رفع الملف الآن", "متابعة البحث بدون استبعاد"],
            allowOther: true,
          },
        ],
        tokensUsed: { input: 0, output: 0, costUsd: 0 },
      };
      const tExclWrite = Date.now();
      if (sb) {
        awaitsCount += 2;
        await sb.from("messages").update({ content_ar: q.questionAr }).eq("id", assistantMsgId);
        await sb.from("messages").update({ request_status: "needs_input" }).eq("id", userMsgId);
      } else {
        awaitsCount += 2;
        await this.tables.updateRow({
          databaseId: "digr",
          tableId: "messages",
          rowId: assistantMsgId,
          data: { content: q.questionAr, status: "ready" },
        });
        await this.tables.updateRow({
          databaseId: "digr",
          tableId: "messages",
          rowId: userMsgId,
          data: { requestStatus: "needs_input" },
        });
      }
      const exclWriteDelta = Date.now() - tExclWrite;
      writesMs += exclWriteDelta;
      supabaseMs += exclWriteDelta;
      assistantMsg.turnStats = currentTurnStats();
      return assistantMsg;
    } else if (userComplained) {
      const persistBrief = async () => {
        const tBr = Date.now();
        awaitsCount++;
        await saveConversationBrief(this.tables, conversationId, userId, brief);
        const brDelta = Date.now() - tBr;
        briefSavesMs += brDelta;
        supabaseMs += brDelta;
      };
      if (brief.platforms.length === 0) {
        brief.platforms = researchIntent.platforms.value.length > 0
          ? [...researchIntent.platforms.value]
          : (isCompanyIntent ? ["companies"] : ["tiktok"]);
      }
      if (brief.topics.length === 0) {
        brief.topics = researchIntent.topic.value ? [researchIntent.topic.value] : ["البيانات المطلوبة"];
      }
      if ((!brief.targetVolume || brief.targetVolume <= 0) && !requiresExplicitCount) brief.targetVolume = 10;
      if (!brief.formats || brief.formats.length === 0) brief.formats = ["xlsx"];
      await Promise.all([persistBrief(), writeProgressLine()]);
      isPhase2 = true;
    } else if (discoveryDecision.action === "PROCEED_TO_PLAN" && !isGreeting && !isGeneralQuestion) {
      const persistBrief = async () => {
        const tBr = Date.now();
        awaitsCount++;
        await saveConversationBrief(this.tables, conversationId, userId, brief);
        const brDelta = Date.now() - tBr;
        briefSavesMs += brDelta;
        supabaseMs += brDelta;
      };
      if (brief.platforms.length === 0) {
        brief.platforms = researchIntent.platforms.value.length > 0
          ? [...researchIntent.platforms.value]
          : (isCompanyIntent ? ["companies"] : ["tiktok"]);
      }
      if (brief.topics.length === 0 && researchIntent.topic.value) {
        brief.topics = [researchIntent.topic.value];
      }

      const hasExplicitVolume = researchIntent.sampleSize.provenance === "EXPLICIT";
      const hasExclusionFile = activeFiles.length > 0 || !!brief.exclusionFile;
      const isReadyForInstantPlan =
        hasExplicitVolume ||
        hasExclusionFile ||
        (brief.targetVolume !== undefined && brief.targetVolume > 0) ||
        wantsPriceOrProceed ||
        isCardAnswer ||
        testScenario === "phase2_plan" ||
        testScenario === "direct_plan";

      if (isReadyForInstantPlan) {
        if ((!brief.targetVolume || brief.targetVolume <= 0) && !requiresExplicitCount) {
          brief.targetVolume = researchIntent.sampleSize.provenance === "EXPLICIT" ? researchIntent.sampleSize.value : 10;
        }
        // Only a window the customer wrote (EXPLICIT) reaches the brief: the intent reader's own fallback is never applied.
        const dateVal = researchIntent.dateRange?.provenance !== "EXPLICIT" ? undefined : researchIntent.dateRange?.value?.relative || (researchIntent.dateRange?.value?.from ? `${researchIntent.dateRange.value.from} إلى ${researchIntent.dateRange.value.to || ""}` : undefined);
        if (!brief.dateRange && dateVal) {
          brief.dateRange = dateVal;
        }
        if (!brief.formats || brief.formats.length === 0) {
          brief.formats = researchIntent.outputTypes?.value?.length > 0
            ? [...researchIntent.outputTypes.value]
            : ["xlsx"];
        }
        await Promise.all([persistBrief(), writeProgressLine()]);
        isPhase2 = true;
      } else {
        await persistBrief();
        isPhase2 = false;
      }
    } else if (isCardAnswer) {
      const persistBrief = async () => {
        const tBr = Date.now();
        awaitsCount++;
        await saveConversationBrief(this.tables, conversationId, userId, brief);
        const brDelta = Date.now() - tBr;
        briefSavesMs += brDelta;
        supabaseMs += brDelta;
      };
      if (brief.platforms.length === 0) brief.platforms.push("tiktok");
      if (brief.topics.length === 0) brief.topics.push("البيانات المطلوبة");
      if ((!brief.targetVolume || brief.targetVolume <= 0) && !requiresExplicitCount) {
        brief.targetVolume = (brief.postCount && brief.commentsPerPost) ? (brief.postCount * brief.commentsPerPost) : 10;
      }
      if (!brief.language) brief.language = "العربية";
      await Promise.all([persistBrief(), writeProgressLine()]);
      isPhase2 = true;
    } else if (hasPlatform && hasTopic && ((brief.targetVolume !== undefined && brief.targetVolume > 0) || Boolean(brief.postCount && brief.commentsPerPost) || wantsPriceOrProceed || Boolean(brief.dateRange))) {
      const persistBrief = async () => {
        const tBr = Date.now();
        awaitsCount++;
        await saveConversationBrief(this.tables, conversationId, userId, brief);
        const brDelta = Date.now() - tBr;
        briefSavesMs += brDelta;
        supabaseMs += brDelta;
      };
      // Platform & topic known with volume, plan intent, or dates: DECIDE, never interrogate! Apply sensible defaults
      if ((!brief.targetVolume || brief.targetVolume <= 0) && !requiresExplicitCount) {
        brief.targetVolume = (brief.postCount && brief.commentsPerPost) ? (brief.postCount * brief.commentsPerPost) : 10;
      }
      if (!brief.language) {
        brief.language = "العربية";
      }
      if (!brief.formats || brief.formats.length === 0) {
        brief.formats = ["xlsx"];
      }
      await Promise.all([persistBrief(), writeProgressLine()]);
      isPhase2 = true;
    } else if (isComplete || (brief.platforms.length > 0 && brief.topics.length > 0 && brief.targetVolume && brief.dateRange)) {
      isPhase2 = true;
    } else if (wantsPriceOrProceed && brief.platforms.length > 0 && brief.topics.length > 0) {
      isPhase2 = true;
    } else if (testScenario === "search_then_plan" || testScenario === "direct_plan" || testScenario === "summary_then_plan" || testScenario === "multiplatform_plan" || testScenario === "phase2_plan") {
      isPhase2 = true;
    }

      currentStep = "capabilities_load";
      const tSbCapsStart = Date.now();
      awaitsCount += 2;
      const [loadedCapabilities, catalogCapabilities] = await (capabilitiesRead ?? Promise.all([
        getEnabledCapabilitiesWithCoreServices(this.tables),
        getCatalogCapabilities(this.tables),
      ]));
      const capabilities = loadedCapabilities;
      const capsDelta = Date.now() - tSbCapsStart;
      supabaseMs += capsDelta;
      catalogMs += capsDelta;

      let liveCatalogEndpoints: CatalogEndpointSummary[] = [];
      const tSearchStart = Date.now();

      const runCatalogSearchWithRetries = async (topic: string, p?: string) => {
        const cached = getCachedCatalogEndpoints();
        const matchedCached = cached.filter((c) => {
          if (!p) return true;
          const plat = (c.platform || "").toLowerCase();
          const target = p.toLowerCase();
          if (target === "companies" || target === "b2b") {
            return plat === "companies" || plat === "b2b" || c.slug.includes("companies") || c.id.includes("companies");
          }
          return plat === target || c.slug.includes(target);
        });

        // Fast path: if cached capabilities match the requested platform, return immediately (0ms latency)
        if (matchedCached.length > 0) {
          return matchedCached;
        }

        catalogSearchCount++;
        const tCat0 = Date.now();
        try {
          const timeoutPromise = new Promise<CatalogEndpointSummary[]>((resolve) =>
            setTimeout(() => resolve([]), 1200)
          );
          awaitsCount++;
          let res = await Promise.race([searchCatalog(topic, p), timeoutPromise]);
          catalogMs += Date.now() - tCat0;
          if (res && res.length > 0) return res;
        } catch {
          catalogMs += Date.now() - tCat0;
        }

        if (p) {
          try {
            catalogSearchCount++;
            const tCat1 = Date.now();
            const timeoutPromise = new Promise<CatalogEndpointSummary[]>((resolve) =>
              setTimeout(() => resolve([]), 800)
            );
            awaitsCount++;
            const res = await Promise.race([searchCatalog(p, p), timeoutPromise]);
            catalogMs += Date.now() - tCat1;
            if (res && res.length > 0) return res;
          } catch (err: any) {
            console.warn("[chat:catalog_search_fallback_failure]", { platform: p, error: err?.message });
          }
        }

        return [];
      };

      const detectedPlatforms = brief.platforms.length > 0 ? brief.platforms : detectMentionedPlatforms(message);
      const searchTopic = brief.topics.length > 0 ? brief.topics.join(" ") : message;

      if (isPhase2) {
        currentStep = "catalog_search";
        // Progress line during Phase 2 pricing: usually already started together with the brief save; always finished before
        // anything else is written to this message, so it can never overwrite the final text.
        await writeProgressLine();

        // Server-side: run catalog search once per platform in brief (24h cache)
        const platformsToSearch = detectedPlatforms;
        if (platformsToSearch.length > 0) {
          awaitsCount += platformsToSearch.length;
          const results = await Promise.all(
            platformsToSearch.map((p) => runCatalogSearchWithRetries(searchTopic, p))
          );
          for (const res of results) {
            liveCatalogEndpoints.push(...res);
          }
        } else {
          const res = await runCatalogSearchWithRetries(searchTopic, undefined);
          liveCatalogEndpoints.push(...res);
        }
      } else if (isTestSearchScenario) {
        currentStep = "catalog_search";
        catalogSearchCount++;
        const mentionedPlatforms = detectMentionedPlatforms(message);
        const platformHint = mentionedPlatforms[0] || undefined;
        const tCat2 = Date.now();
        awaitsCount++;
        liveCatalogEndpoints = await searchCatalog(message, platformHint);
        catalogMs += Date.now() - tCat2;
      } else if (!isGreeting && !isGeneralQuestion && detectedPlatforms.length > 0) {
        // Phase 1 optimization: Zero network calls, load matching cached endpoints for detected platforms
        currentStep = "phase1_catalog_cached";
        const cached = getCachedCatalogEndpoints();
        const matched = cached.filter((c) =>
          detectedPlatforms.some((p) => (c.platform || "").toLowerCase() === p.toLowerCase())
        );
        liveCatalogEndpoints.push(...matched);
      }
      tCatalogSearchMs = catalogMs || (Date.now() - tSearchStart);

      let dynamicCapabilities: Capability[] = liveCatalogEndpoints.map(catalogEndpointToCapability);

      let allCapabilities = [...dynamicCapabilities, ...capabilities];
      let allCatalogCapabilities = [...dynamicCapabilities, ...catalogCapabilities];
      let sanitizedCaps = sanitizeCapabilitiesForLlm(allCatalogCapabilities);

      // 6. Fetch previous messages for context
      currentStep = "message_history";
      const tSbHistStart = Date.now();
      if (sb) {
        // Read in the same wave as the message writes: add the current message (newest) and leave out the placeholder.
        const { data: fetchedRows, error: histErr } = prefetchedHistory ?? { data: null, error: null };
        if (histErr) throw histErr;
        const rows = [
          { id: userMsgId, role: "user", content_ar: message, created_at: nowIso, quote: null, plan: null, request_status: "planning", request_quote_id: null },
          ...(fetchedRows || []).filter((r: any) => r.id !== userMsgId && r.id !== assistantMsgId),
        ].slice(0, HISTORY_ROWS_FOR_SCOPE);
        // The scope reads every customer message in range (the request they stated may be far behind a chain of card answers);
        // the model sees only the latest turns.
        rawUserHistoryTexts = [...(rows || [])].reverse()
          .filter((r: any) => r.role === "user" && r.id !== assistantMsgId)
          .map((r: any) => String(r.content_ar || ""));
        rawUserHistoryAnswerLabels = typedAnswerLabelsForUserRows([...(rows || [])].reverse()
          .filter((r: any) => r.id !== assistantMsgId)
          .map((r: any) => ({ role: String(r.role), content: String(r.content_ar || "") })));
        messagesContext = [...(rows || [])].reverse().slice(-HISTORY_ROWS_FOR_MODEL)
          .filter((r: any) => r.id !== assistantMsgId && (r.content_ar || "").trim().length > 0)
          .map((r: any) => ({
            role: r.role as "user" | "assistant" | "system",
            content: r.role === "user"
              ? formatClarificationMessageForAssistant(r.content_ar || "")
              : r.content_ar || "",
            quote: r.quote,
            plan: r.plan,
            requestStatus: r.request_status,
            requestQuoteId: r.request_quote_id,
          }));
      } else {
        awaitsCount++;
        const historyRes = await this.tables.listRows({
          databaseId: "digr",
          tableId: "messages",
          queries: [
            Query.equal("conversationId", conversationId),
            Query.orderDesc("createdAt"),
            Query.limit(HISTORY_ROWS_FOR_SCOPE),
          ],
        });

        rawUserHistoryTexts = [...historyRes.rows].reverse()
          .filter((r: any) => r.role === "user" && r.$id !== assistantMsgId)
          .map((r: any) => String(r.content || ""));
        rawUserHistoryAnswerLabels = typedAnswerLabelsForUserRows([...historyRes.rows].reverse()
          .filter((r: any) => r.$id !== assistantMsgId)
          .map((r: any) => ({ role: String(r.role), content: String(r.content || "") })));
        messagesContext = [...historyRes.rows].reverse().slice(-HISTORY_ROWS_FOR_MODEL)
          .filter((r: any) => r.$id !== assistantMsgId && r.status !== "thinking")
          .map((r: any) => ({
            role: r.role as "user" | "assistant" | "system",
            content: r.role === "user"
              ? formatClarificationMessageForAssistant(r.content || "")
              : r.content,
            quote: r.quote,
            plan: r.plan,
            requestStatus: r.requestStatus,
            requestQuoteId: r.requestQuoteId,
          }));
      }
      const histDelta = Date.now() - tSbHistStart;
      supabaseMs += histDelta;
      historyMs += histDelta;

      // Clarification card answers arrive as a small JSON payload. Keep the
      // original user request in scope so explicit counts and company filters
      // survive the answer turn instead of being replaced by model defaults.
      // Built from what the customer actually sent (never from the model-facing rewrite, which carries our own question texts).
      const priorUserRequirements = rawUserHistoryTexts.map((text, index) => typedAnswerRequirementText(text, rawUserHistoryAnswerLabels[index] ?? null));
      const currentRequirement = rawUserHistoryTexts.at(-1) === message && rawUserHistoryAnswerLabels.length === rawUserHistoryTexts.length
        ? typedAnswerRequirementText(message, rawUserHistoryAnswerLabels.at(-1) ?? null)
        : customerAuthoredRequirementText(message);
      // The current message was persisted before history was fetched. Avoid
      // adding it twice to the deterministic routing text used for plans.
      if (priorUserRequirements.at(-1) === currentRequirement) priorUserRequirements.pop();
      // Scoped to THIS request: an independent request never reads older messages; only a follow-up does.
      const conversationRequestText = scopeRequestText(
        priorUserRequirements,
        currentRequirement,
        explicitCompanyClarificationNotes(brief.notes),
      );

      // Consent is given with the plan card's button only. A typed «أوافق وابدأ البحث» next to a plan that waits is answered with
      // where to press: it must not be read as a new request (that priced a second plan and made the first card unusable).
      if (isTypedApprovalMessage(message) && hasPendingPlan(messagesContext)) {
        const tApprovalWrite = Date.now();
        try {
          if (sb) {
            awaitsCount += 2;
            await Promise.all([
              sb.from("messages").update({ content_ar: APPROVAL_NEEDS_BUTTON_AR, clarification_items: null, plan: null, quote: null }).eq("id", assistantMsgId),
              sb.from("messages").update({ request_status: "completed" }).eq("id", userMsgId),
            ]);
          } else {
            awaitsCount += 2;
            await this.tables.updateRow({ databaseId: "digr", tableId: "messages", rowId: assistantMsgId, data: { content: APPROVAL_NEEDS_BUTTON_AR, status: "ready" } });
            await this.tables.updateRow({ databaseId: "digr", tableId: "messages", rowId: userMsgId, data: { requestStatus: "completed" } });
          }
        } catch (persistError) {
          console.warn(`[chat:approval_reply_persist_failed] reason=${toSafeReasonCode(persistError, "approval_reply_persist")}`);
        }
        const approvalDelta = Date.now() - tApprovalWrite;
        writesMs += approvalDelta;
        supabaseMs += approvalDelta;
        return {
          conversationId,
          messageId: assistantMsgId,
          role: "assistant",
          contentAr: APPROVAL_NEEDS_BUTTON_AR,
          outputType: "answer_question",
          intent: "chat",
          tokensUsed: { input: 0, output: 0, costUsd: 0 },
          turnStats: currentTurnStats(),
        };
      }

      const resultFeedbackReply = buildResultFollowupReply(message, messagesContext, brief);
      if (resultFeedbackReply) {
        const tFollowupWrite = Date.now();
        try {
          if (sb) {
            awaitsCount += 2;
            const [assistantUpdate, userUpdate] = await Promise.all([
              sb.from("messages").update({
                content_ar: resultFeedbackReply,
                clarification_items: null,
                plan: null,
                quote: null,
              }).eq("id", assistantMsgId),
              sb.from("messages").update({ request_status: "completed" }).eq("id", userMsgId),
            ]);
            if (assistantUpdate?.error) throw assistantUpdate.error;
            if (userUpdate?.error) throw userUpdate.error;
          } else {
            awaitsCount += 2;
            await this.tables.updateRow({
              databaseId: "digr",
              tableId: "messages",
              rowId: assistantMsgId,
              data: { content: resultFeedbackReply, status: "ready" },
            });
            await this.tables.updateRow({
              databaseId: "digr",
              tableId: "messages",
              rowId: userMsgId,
              data: { requestStatus: "completed" },
            });
          }
        } catch (persistError) {
          console.warn(`[chat:result_followup_persist_failed] reason=${toSafeReasonCode(persistError, "result_followup_persist")}`);
        }
        const followupDelta = Date.now() - tFollowupWrite;
        writesMs += followupDelta;
        supabaseMs += followupDelta;
        return {
          conversationId,
          messageId: assistantMsgId,
          role: "assistant",
          contentAr: resultFeedbackReply,
          outputType: "answer_question",
          intent: "research",
          tokensUsed: { input: 0, output: 0, costUsd: 0 },
          turnStats: currentTurnStats(),
        };
      }

      // Studies, papers, articles and news from websites: not a service yet. Said plainly by code, with what is available;
      // no social platform is offered as a source, no plan is priced, nothing is charged.
      const studiesRequest = !isTestSearchScenario && !input.isGuest && !isFileShapingTurn ? detectTopicGathering(conversationRequestText) : null;
      if (studiesRequest && !hasTopicResearchService(APPROVED_CAPABILITY_CATALOG)) {
        const studiesReplyAr = studiesUnavailableReplyAr(studiesRequest);
        const tStudiesWrite = Date.now();
        if (sb) {
          awaitsCount += 2;
          await Promise.all([
            sb.from("messages").update({ content_ar: studiesReplyAr }).eq("id", assistantMsgId),
            sb.from("messages").update({ request_status: "completed" }).eq("id", userMsgId),
          ]);
        } else {
          awaitsCount += 2;
          await this.tables.updateRow({ databaseId: "digr", tableId: "messages", rowId: assistantMsgId, data: { content: studiesReplyAr, status: "ready" } });
          await this.tables.updateRow({ databaseId: "digr", tableId: "messages", rowId: userMsgId, data: { requestStatus: "completed" } });
        }
        const studiesDelta = Date.now() - tStudiesWrite;
        writesMs += studiesDelta;
        supabaseMs += studiesDelta;
        return {
          conversationId,
          messageId: assistantMsgId,
          role: "assistant",
          contentAr: studiesReplyAr,
          outputType: "answer_question",
          intent: "chat",
          tokensUsed: { input: 0, output: 0, costUsd: 0 },
          turnStats: currentTurnStats(),
        };
      }

      // A request none of whose parts the platform sells (news, prices, ads, maps, search results, jobs, forums, private data): said plainly by
      // code with what IS available, never priced, never charged, and kept in the unserved-requests list the owner reads.
      const coverage = !isTestSearchScenario && !isFileShapingTurn ? assessCoverage(conversationRequestText) : null;
      if (coverage && coverage.status === "not_supported") {
        const coverageReplyAr = notSupportedReplyAr(coverage);
        const tCoverageWrite = Date.now();
        awaitsCount += 3;
        if (sb) {
          await Promise.all([
            sb.from("messages").update({ content_ar: coverageReplyAr }).eq("id", assistantMsgId),
            sb.from("messages").update({ request_status: "completed" }).eq("id", userMsgId),
            sb.from("capability_requests").insert({ id: ID.unique(), user_id: userId, query: `${coverage.unsupported.join("+")}: ${String(message).slice(0, 500)}`, created_at: new Date().toISOString() }),
          ].map((write) => Promise.resolve(write).catch(() => undefined)));
        } else {
          await this.tables.updateRow({ databaseId: "digr", tableId: "messages", rowId: assistantMsgId, data: { content: coverageReplyAr, status: "ready" } });
          await this.tables.updateRow({ databaseId: "digr", tableId: "messages", rowId: userMsgId, data: { requestStatus: "completed" } });
          await this.tables.createRow({ databaseId: "digr", tableId: "capability_requests", rowId: ID.unique(), data: { userId, queryAr: String(message).slice(0, 500), platform: coverage.unsupported.join("+"), createdAt: new Date().toISOString() } }).catch(() => undefined);
        }
        const coverageDelta = Date.now() - tCoverageWrite;
        writesMs += coverageDelta;
        supabaseMs += coverageDelta;
        return {
          conversationId,
          messageId: assistantMsgId,
          role: "assistant",
          contentAr: coverageReplyAr,
          outputType: "answer_question",
          intent: "chat",
          tokensUsed: { input: 0, output: 0, costUsd: 0 },
          turnStats: currentTurnStats(),
        };
      }

      // New requests are paused while the provider's daily allowance or capacity is used up: said once, in plain words, with the queue,
      // before the customer answers questions for a plan that cannot start. Chit-chat and result follow-ups are never held.
      if (sb && !isFileShapingTurn && !isTestSearchScenario && extractRequestIntent(conversationRequestText).dataType !== "unknown") {
        const busyNow = await getBusyState(sb);
        if (busyNow.busy) {
          const tBusyWrite = Date.now();
          awaitsCount += 2;
          await Promise.all([
            sb.from("messages").update({ content_ar: busyNow.messageAr }).eq("id", assistantMsgId),
            sb.from("messages").update({ request_status: "needs_input" }).eq("id", userMsgId),
          ]);
          const busyDelta = Date.now() - tBusyWrite;
          writesMs += busyDelta;
          supabaseMs += busyDelta;
          return {
            conversationId,
            messageId: assistantMsgId,
            role: "assistant",
            contentAr: busyNow.messageAr,
            outputType: "answer_question",
            intent: "chat",
            tokensUsed: { input: 0, output: 0, costUsd: 0 },
            turnStats: currentTurnStats(),
          };
        }
      }

      const skippedQuestionIds = skippedQuestionIdsFromHistory(rawUserHistoryTexts);
      const requiredDiscoveryQuestion = getDeterministicDiscoveryQuestion(conversationRequestText, brief, allCapabilities, { skipped: skippedQuestionIds, skipCounts: skipCountsFromHistory(rawUserHistoryTexts) });
      // A question the customer skipped and that cannot be inferred: one plain sentence, no card, the composer stays open.
      if (requiredDiscoveryQuestion?.plain && !isFileShapingTurn) {
        const plainAr = String(requiredDiscoveryQuestion.text);
        const tPlainWrite = Date.now();
        awaitsCount += 2;
        if (sb) {
          await Promise.all([
            sb.from("messages").update({ content_ar: plainAr }).eq("id", assistantMsgId),
            sb.from("messages").update({ request_status: "needs_input" }).eq("id", userMsgId),
          ]);
        } else {
          await this.tables.updateRow({ databaseId: "digr", tableId: "messages", rowId: assistantMsgId, data: { content: plainAr, status: "ready" } });
          await this.tables.updateRow({ databaseId: "digr", tableId: "messages", rowId: userMsgId, data: { requestStatus: "needs_input" } });
        }
        const plainDelta = Date.now() - tPlainWrite;
        writesMs += plainDelta;
        supabaseMs += plainDelta;
        return {
          conversationId,
          messageId: assistantMsgId,
          role: "assistant",
          contentAr: plainAr,
          outputType: "answer_question",
          intent: "research",
          tokensUsed: { input: 0, output: 0, costUsd: 0 },
          turnStats: currentTurnStats(),
        };
      }
      // A turn about the delivered file never asks research questions (a column named «الشركة» is not a company request).
      if (requiredDiscoveryQuestion && !requiredDiscoveryQuestion.plain && !isFileShapingTurn) {
        // A Facebook request that needs a page (or the comments per post) becomes ONE card with every question the request leaves open, and only those.
        const discoveryCardItems = SOCIAL_DISCOVERY_OWN_IDS.has(requiredDiscoveryQuestion.id)
          ? socialDiscoveryItems(conversationRequestText, { skipped: skippedQuestionIds, otherFacebookService: otherFacebookServiceExists(allCapabilities) })
          : [];
        const intro = discoveryCardItems.length > 0
          ? socialDiscoveryIntroAr(conversationRequestText, { otherFacebookService: otherFacebookServiceExists(allCapabilities) })
          : consultantIntroAr(conversationRequestText, requiredDiscoveryQuestion.id);
        const normalizedCardQuestions = normalizeClarificationQuestions({ questions: discoveryCardItems.length > 0 ? discoveryCardItems : [requiredDiscoveryQuestion] }, {
          capabilities: allCapabilities,
          userBalancePoints: userBalance,
          persona: userProfile?.persona,
        });
        const normalizedQuestion = normalizedCardQuestions[0] || requiredDiscoveryQuestion;
        const textAr = `${intro}\n${(normalizedCardQuestions.length > 0 ? normalizedCardQuestions : [normalizedQuestion]).map((q: any) => q.text || q.question).join("\n")}`;
        const tDiscoveryWrite = Date.now();
        if (sb) {
          awaitsCount += 2;
          await Promise.all([
            sb.from("messages").update({ content_ar: textAr }).eq("id", assistantMsgId),
            sb.from("messages").update({ request_status: "needs_input" }).eq("id", userMsgId),
          ]);
        } else {
          awaitsCount += 2;
          await this.tables.updateRow({ databaseId: "digr", tableId: "messages", rowId: assistantMsgId, data: { content: textAr, status: "ready" } });
          await this.tables.updateRow({ databaseId: "digr", tableId: "messages", rowId: userMsgId, data: { requestStatus: "needs_input" } });
        }
        const discoveryDelta = Date.now() - tDiscoveryWrite;
        writesMs += discoveryDelta;
        supabaseMs += discoveryDelta;
        return {
          conversationId,
          messageId: assistantMsgId,
          role: "assistant",
          contentAr: textAr,
          outputType: "ask_clarification",
          intent: "research",
          clarificationIntro: intro,
          clarificationQuestions: (normalizedCardQuestions.length > 0 ? normalizedCardQuestions : [normalizedQuestion]).map((q: any) => q.text || q.question),
          clarificationItems: normalizedCardQuestions.length > 0 ? normalizedCardQuestions : [normalizedQuestion],
          tokensUsed: { input: 0, output: 0, costUsd: 0 },
          turnStats: currentTurnStats(),
        };
      }

      // Verified social services: for a comments / videos / trending / channel request the model is shown only the
      // verified capability for that platform and task, instead of choosing among the whole live catalog (where a
      // post search at hundreds of points ranked above the comments the customer asked for).
      const socialIntent = detectSocialIntent(conversationRequestText);
      const verifiedSocialDef = socialIntent.task ? socialCapabilityForIntent(socialIntent) : undefined;
      const verifiedSocialCap = verifiedSocialDef ? capabilities.find((c) => c.slug === verifiedSocialDef.slug) : undefined;
      if (verifiedSocialCap) {
        liveCatalogEndpoints = [capabilityAsCatalogEndpoint(verifiedSocialCap)];
        dynamicCapabilities = [];
        allCapabilities = [...capabilities];
        allCatalogCapabilities = [...catalogCapabilities];
        sanitizedCaps = sanitizeCapabilitiesForLlm(allCatalogCapabilities);
      }

      // 7. Execute LLM Turn
      let parsedPurposes: string[] = [];
      if (userProfile?.purposes) {
        try {
          parsedPurposes = typeof userProfile.purposes === "string" ? JSON.parse(userProfile.purposes) : userProfile.purposes;
        } catch {
          parsedPurposes = [String(userProfile.purposes)];
        }
      }

      // 6b. Context-bloat guard: when the accumulated context reaches the budget,
      // summarize older turns instead of blocking the user. The DB counter keeps
      // growing as a cumulative stat; the model only sees the compacted history.
      let effectiveConvTokens = totalConvTokens;
      // Greetings and identity questions were answered by code; the model never re-reads them.
      const modelHistory = compactHistoryForModel(dropGreetingAndIdentityTurns(messagesContext));
      let turnMessages: Array<{ role: "system" | "user" | "assistant"; content: string }> = modelHistory;
      if (totalConvTokens >= CONTEXT_TOKEN_LIMIT || modelHistory.length > 7) {
        let planSummary: string | undefined;
        try {
          if (sb) {
            const { data: q } = await sb
              .from("plans_quotes")
              .select("items, total_reserved_credits")
              .eq("user_id", userId)
              .eq("status", "quoted")
              .order("created_at", { ascending: false })
              .limit(1)
              .maybeSingle();
            if (q) {
              planSummary = `خطة مقترحة — ${q.total_reserved_credits ?? "?"} نقطة`;
            }
          } else {
            const quoteRes = await this.tables.listRows({
              databaseId: "digr",
              tableId: "plans_quotes",
              queries: [
                Query.equal("conversationId", conversationId),
                Query.equal("status", "proposed"),
                Query.orderDesc("createdAt"),
                Query.limit(1),
              ],
            });
            const q: any = quoteRes.rows?.[0];
            if (q) planSummary = `${q.summaryAr || "خطة مقترحة"} — ${q.quotedPoints ?? "?"} نقطة`;
          }
        } catch {
          // plans_quotes unavailable: summarize without plan state
        }
        turnMessages = summarizeConversationHistory(modelHistory, planSummary);
        effectiveConvTokens = estimateTokens(turnMessages.map((m) => m.content).join("\n"));
      }

      // An independent request after earlier research turns is read on its own, never merged with them.
      if (priorUserRequirements.some((entry) => entry && !isGreetingOrIdentityTurn(entry)) && isStandaloneResearchRequest(currentRequirement)) {
        turnMessages = [...turnMessages, { role: "system", content: INDEPENDENT_REQUEST_NOTE_AR }];
      }

      if (isPhase2) {
        const compactSummary = buildCompactCatalogSummary(liveCatalogEndpoints.length > 0 ? liveCatalogEndpoints : getCachedCatalogEndpoints());
        turnMessages.push({
          role: "system",
          content: `${formatBriefForSystemPrompt(brief)}\n\n${compactSummary}\n\n[تعليمات داخلية — المرحلة الثانية (Phase 2)]: متطلبات البحث مكتملة الآن. استدعِ الآن propose_plan لاقتراح خطة مسعرة مطابقة للمنصة والأدوات المتاحة أعلاه. حدد الخطوات والمدخلات بدقة. ممنوع استدعاء search_catalog لأن الأدوات المتاحة محددة ومسعرة بالفعل أعلاه.`,
        });
      } else if (!isGreeting && !isGeneralQuestion && !isTestSearchScenario) {
        const compactCatalog = buildCompactCatalogSummary(
          liveCatalogEndpoints.length > 0 ? liveCatalogEndpoints : getCachedCatalogEndpoints()
        );
        const catalogContext = compactCatalog
          ? `\n\n[أدوات جمع البيانات المتاحة في الكتالوج]:\n${compactCatalog}\n(الأدوات المناسبة متوفرة بالفعل أعلاه. لا تستدعِ search_catalog. اطرح فوراً أسئلة استكشافية ذكية ومحددة عبر ask_clarification لاستكمال متطلبات البحث).`
          : "";
        turnMessages.push({
          role: "system",
          content: `${formatBriefForSystemPrompt(brief)}${catalogContext}\n\n[تعليمات داخلية — مرحلة الاستيعاب (Phase 1)]: استوعب هدف البحث بدقة كخبير استشاري. إذا كانت الأدوات متوفرة أعلاه، اطرح مباشرة أسئلة توضيحية ذكية ومحددة عبر ask_clarification لاستكمال متطلبات البحث، دون استدعاء search_catalog.`,
        });
      }

      currentStep = "llm_turn";
      const tLlmStart = Date.now();
      // Every model call of this turn is added here and the SUM is logged (a turn with a catalog search or a retry makes
      // several calls; only the last one used to be recorded).
      const turnUsage = turn.usage;
      const fastIntent = extractRequestIntent(conversationRequestText);
      const fastPlanOutput = (this.deterministicPlanning && !input.isGuest && !isGreeting && !isGeneralQuestion && !isFileShapingTurn && !isTestSearchScenario && !testScenario)
        ? buildDeterministicPlanFromIntent(fastIntent, conversationRequestText, brief, allCatalogCapabilities as Capability[], skippedQuestionIds)
        : null;
      // «Sheet per X» about a delivered file is read by code against the file's REAL columns: no model call and no guessing.
      // (A card answer to the column question still goes to the model, as before.) Anything else about the file is the model's.
      const shapeSpec = isFileShapingTurn && !isCardAnswer && !isTestSearchScenario && !testScenario && shapingColumns.length > 0
        ? deterministicShapeSpec(shapingText, shapingColumns)
        : null;
      // The answer to a shaping question is code too: the chosen column plus the step the question belongs to (the sort
      // direction and the split are in the question id; a filter and a column choice come from the customer's own request).
      // It never reaches the model and never becomes a plan, whatever the history holds.
      let shapeAnswerOutput: any = null;
      let shapeIgnoredNames: string[] = [];
      let shapeQuestionIssued = false;
      if (shapeAnswer && !isTestSearchScenario && !testScenario) {
        const originalText = [...rawUserHistoryTexts].reverse().find((text) => text && text !== message && !shapeAnswerFromMessage(text) && isFileShapingMessage(formatClarificationMessageForAssistant(text)));
        const resolution = shapingColumns.length > 0
          ? resolveShapeAnswer({ questionId: shapeAnswer.questionId, value: shapeAnswer.value, originalText, columns: shapingColumns })
          : { ok: false as const, errorAr: "لا أستطيع قراءة أعمدة ملفك الآن. حاول مرة أخرى بعد قليل. لن يُخصم أي رصيد." };
        if (resolution.ok) {
          shapeAnswerOutput = { type: "shape_file", replyAr: "تمام", spec: resolution.spec };
          shapeIgnoredNames = resolution.ignored;
        } else {
          shapeAnswerOutput = { type: "answer_question", answerAr: resolution.errorAr };
        }
      }
      // An edit of the delivered file that is not offered (remove duplicates, text direction, hide identities, other formats) is
      // answered by code in one plain sentence: no model, no question, no plan.
      const fileEditKind = isFileShapingTurn && !shapeAnswer && !isTestSearchScenario && !testScenario ? unsupportedFileEdit(shapingText) : null;
      const fileEditOutput: any = fileEditKind ? { type: "answer_question", answerAr: fileEditAnswerAr(fileEditKind) } : null;
      const methodologyOutput: any = asksMethodology && !isTestSearchScenario && !testScenario
        ? { type: "answer_question", answerAr: methodologyJobId ? (methodologyBought ? methodologyPurchasedAr() : methodologyAnswerAr()) : methodologyUnavailableAr() }
        : null;
      const codeBuiltOutput: any = shapeAnswerOutput ?? fileEditOutput ?? methodologyOutput ?? fastPlanOutput ?? (shapeSpec ? { type: "shape_file", replyAr: "تمام", spec: shapeSpec } : null);
      if (!codeBuiltOutput) modelCallCount++;
      const resolvedDisplayName =
        (userProfile?.name && String(userProfile.name).trim()) ||
        (userProfile?.full_name && String(userProfile.full_name).trim()) ||
        (userProfile?.sender_name && String(userProfile.sender_name).trim()) ||
        "";

      let llmResult = codeBuiltOutput
        ? ({ output: codeBuiltOutput, inputTokens: 0, outputTokens: 0, costUsd: 0, model: "deterministic", promptVersion: fastPlanOutput ? "intent-1" : "shape-1", textBlockAr: "" } as LlmCallResult)
        : await this.llm.executeTurn({
        messages: turnMessages,
        sanitizedCapabilities: sanitizedCaps,
        userProfile: userProfile
          ? {
              persona: userProfile.persona,
              purposes: parsedPurposes,
              topic: userProfile.topic,
              displayName: resolvedDisplayName,
            }
          : {
              displayName: resolvedDisplayName,
            },
        todayDate: new Date().toISOString().split("T")[0],
        userBalancePoints: userBalance,
        resultColumns: shapingColumns,
        conversationId,
        userId,
        totalConversationTokens: effectiveConvTokens,
        testScenario,
      });
      llmMs += Date.now() - tLlmStart;
      if (!codeBuiltOutput) {
        turn.model = llmResult.model;
        turnUsage.calls += 1;
        turnUsage.inputTokens += llmResult.inputTokens || 0;
        turnUsage.outputTokens += llmResult.outputTokens || 0;
        turnUsage.costUsd += llmResult.costUsd || 0;
      }

      let output: typeof llmResult.output = llmResult.output;

      // 7b. Internal catalog-search loop: search_catalog is never a final answer.
      // The results go back to the model (in-memory only, never persisted) so it
      // can continue with ask_questions / propose_plan / plain text. Raw catalog
      // results — tool names and bare per-tool point prices — are never shown
      // to the user as a list; prices appear only inside a priced plan.
      const MAX_CATALOG_ITERATIONS = input.isGuest ? 0 : 4;
      let catalogIterations = 0;
      const loopMessages = [...turnMessages];
      // Every catalog search of this turn (pre-search + loop iterations), keyed by
      // the same alias the model received. This — plus the 24h cache — is what
      // plan validation accepts, not the hardcoded registry.
      const turnSearchResults: CatalogEndpointSummary[] = [...liveCatalogEndpoints];
      const repeatTurn = async () => {
        modelCallCount++;
        const tLlmRepeatStart = Date.now();
        llmResult = await this.llm.executeTurn({
          messages: loopMessages,
          sanitizedCapabilities: sanitizedCaps,
          userProfile: userProfile
            ? {
                persona: userProfile.persona,
                purposes: parsedPurposes,
                topic: userProfile.topic,
              }
            : undefined,
          todayDate: new Date().toISOString().split("T")[0],
          userBalancePoints: userBalance,
          conversationId,
          userId,
          totalConversationTokens: effectiveConvTokens,
          testScenario,
        });
        llmMs += Date.now() - tLlmRepeatStart;
        turn.model = llmResult.model;
        turnUsage.calls += 1;
        turnUsage.inputTokens += llmResult.inputTokens || 0;
        turnUsage.outputTokens += llmResult.outputTokens || 0;
        turnUsage.costUsd += llmResult.costUsd || 0;
        output = llmResult.output;
      };
      const budgetLeft = () => turnBudgetLeftMs(turnStartTime);
      while (output.type === "search_catalog" && catalogIterations < MAX_CATALOG_ITERATIONS && budgetLeft() > MIN_MODEL_CALL_BUDGET_MS) {
        catalogIterations++;
        catalogSearchCount++;
        const tCatLoopStart = Date.now();
        let searchRes = await searchCatalog(output.query, output.platform);
        catalogMs += Date.now() - tCatLoopStart;
        if (searchRes.length === 0) {
          // Retry silently up to 3 times with alternatives
          const fallbacks = [
            { q: output.platform || "", p: output.platform },
            { q: "", p: output.platform },
            { q: output.query, p: undefined },
          ];
          for (let i = 0; i < fallbacks.length && searchRes.length === 0; i++) {
            try {
              catalogSearchCount++;
              const tCatRetryStart = Date.now();
              searchRes = await searchCatalog(fallbacks[i].q, fallbacks[i].p);
              catalogMs += Date.now() - tCatRetryStart;
            } catch (err: any) {
              console.warn("[chat:catalog_tool_retry_failure]", { attempt: i + 1, error: err?.message });
            }
          }
          if (searchRes.length === 0) {
            console.warn("[chat:catalog_tool_empty_after_retries]", { query: output.query, platform: output.platform });
          }
        }
        turnSearchResults.push(...searchRes);
        // Compact internal result (top 5, minimal fields, ~2.5k token cap).
        // Never persisted, never user-visible.
        loopMessages.push({ role: "system", content: buildCompactCatalogSummary(searchRes) } as const);
        await repeatTurn();
      }

      // 7c. One retry when the model stalled after a catalog search (empty text or
      // no next step): give it an explicit instruction before giving up.
      const didSearch = catalogIterations > 0;
      const isProductiveTerminal = (o: typeof output): boolean => {
        if (o.type === "ask_clarification" || o.type === "ask_questions" || o.type === "propose_plan") return true;
        if (o.type === "answer_question") return (((o as any).answerAr || "") as string).trim().length > 0;
        return o.type === "refuse" || o.type === "suggest_alternative" || o.type === "edit_plan" || o.type === "write_note";
      };
      if (didSearch && !isProductiveTerminal(output) && budgetLeft() > MIN_MODEL_CALL_BUDGET_MS) {
        loopMessages.push(
          {
            role: "system",
            content:
              "[تعليمات داخلية — الخطوة التالية المطلوبة]: بناءً على نتائج بحث الكتالوج أعلاه، استدعِ الآن ask_questions لطرح أسئلة استكشافية أو propose_plan لاقتراح خطة مسعرة. لا تعرض نتائج الكتالوج للمستخدم كنص.",
          } as const,
        );
        await repeatTurn();
      }

      let finalContentAr = "";
      let planQuoteData: any = undefined;
      let revisionQuoteData: any = undefined;
      let fileShapeData: { spec: any; descriptionAr: string; jobId?: string } | undefined = undefined;
      let clarificationQuestionsList: string[] | undefined = undefined;
      let clarificationItemsList: NormalizedClarificationQuestion[] | undefined = undefined;

      // Discovery fallback used when the catalog loop + one retry cannot produce a
      // next step: real code-built questions (never the generic sentence, never the
      // raw catalog list).
      const fallbackToDiscovery = (customIntro?: string, colonFallback: boolean = false) => {
        const fallback =
          (typeof testScenario === "string" && testScenario.startsWith("search_"))
            ? buildCodeDiscoveryFallback(allCapabilities, message, false)
            : buildCodeDiscoveryFallback(allCapabilities, message, colonFallback, brief);
        if (fallback.items.length > 0) {
          clarificationQuestionsList = fallback.items.map((item) => item.text);
          clarificationItemsList = fallback.items;
          finalContentAr = deduplicateIntroText(customIntro || fallback.intro);
          output = {
            type: "ask_clarification",
            reasonAr: finalContentAr,
            intro: finalContentAr,
            questions: fallback.items,
            questionsAr: clarificationQuestionsList,
          } as any;
        } else if (isPhase2 || isCardAnswer || (brief.platforms.length > 0 && (brief.topics.length > 0 || brief.targetVolume))) {
          clarificationQuestionsList = undefined;
          clarificationItemsList = undefined;
          output = buildAutoPlanProposal(brief, validationCaps, message) as any;
        } else {
          clarificationQuestionsList = undefined;
          clarificationItemsList = undefined;
          finalContentAr = deduplicateIntroText(customIntro || "فهمت أنك تريد جمع بيانات، وأحتاج أن أعرف المنصة والموضوع أولًا.");
          output = {
            type: "answer_question",
            answerAr: finalContentAr,
          } as any;
        }
      };

      // 7d. Check if reply ended with a colon without a tool call (cut-off reply guard)
      const getEffectiveAnswerText = (o: typeof output): string => {
        if (o.type === "answer_question") return (((o as any).answerAr || "") as string).trim();
        return (llmResult.textBlockAr || "").trim();
      };
      const hasActiveTool = (o: typeof output): boolean => {
        return (
          o.type === "ask_clarification" ||
          o.type === "ask_questions" ||
          o.type === "propose_plan" ||
          o.type === "edit_plan" ||
          o.type === "edit_artifact" ||
          o.type === "shape_file" ||
          o.type === "suggest_alternative" ||
          o.type === "refuse"
        );
      };

      let answerCandidate = getEffectiveAnswerText(output);
      const isEndingColon = (t: string) => /[:：](\s*)$/.test(t);

      if (isEndingColon(answerCandidate) && !hasActiveTool(output) && budgetLeft() > MIN_MODEL_CALL_BUDGET_MS) {
        // Retry once inside the turn
        loopMessages.push({
          role: "system",
          content:
            "[تعليمات داخلية — أكمل الرد]: انتهى الرد بنقطتين (:) دون استدعاء أي أداة. استدعِ الآن ask_questions لطرح أسئلة استكشافية محددة أو propose_plan لاقتراح الخطة المسعرة. لا تترك الرد منتهياً بنقطتين دون بطاقة.",
        } as const);
        await repeatTurn();
        answerCandidate = getEffectiveAnswerText(output);
      }

      if (isEndingColon(answerCandidate) && !hasActiveTool(output)) {
        // Still ending with colon and no tool call came: build discovery card in code
        fallbackToDiscovery(answerCandidate || undefined, true);
      }
      tPlanLlmMs = Date.now() - tLlmStart;

      // Turn catalog endpoints: live results of this turn + 24h cached catalog,
      // deduped by alias. Plan validation and pricing use these first.
      const turnEndpoints: CatalogEndpointSummary[] = (() => {
        const seen = new Set<string>();
        const out: CatalogEndpointSummary[] = [];
        for (const ep of [...turnSearchResults, ...getCachedCatalogEndpoints()]) {
          const key = ep.slug || ep.id;
          if (!key || seen.has(key)) continue;
          seen.add(key);
          out.push(ep);
        }
        return out;
      })();
      const turnCapabilities = turnEndpoints.map(catalogEndpointToCapability);
      const validationCaps: Capability[] = (() => {
        const seen = new Set<string>();
        const out: Capability[] = [];
        for (const c of [...turnCapabilities, ...allCapabilities]) {
          const key = c.slug || c.id;
          if (!key || seen.has(key)) continue;
          seen.add(key);
          out.push(c);
        }
        return out;
      })();

      // 7e. Stall guard. A reply that only announces a plan («هجهز لك خطة...») or a catalog loop cut short by the turn
      // budget must never end the turn without a plan or ONE concrete question: retry once if time allows, then finish
      // in code. (A provider outage keeps its honest «المساعد غير متاح» answer: real providers never fall back silently.)
      {
        const isStalled = () =>
          output.type === "search_catalog" ||
          (output.type === "answer_question" && isPlanAnnouncementOnly(((output as any).answerAr || "") as string));
        const isResearchTurn = !isGreeting && !isGeneralQuestion && !isTestSearchScenario && !input.isGuest;
        if (isResearchTurn && isStalled()) {
          if (budgetLeft() > MIN_MODEL_CALL_BUDGET_MS) {
            loopMessages.push({
              role: "system",
              content:
                "[تعليمات داخلية — أكمل الخطوة]: ردّك السابق أعلن عن خطة دون أن يستدعي أداة. استدعِ الآن propose_plan إن اكتملت المدخلات، أو ask_questions بسؤال واحد محدد. ممنوع الرد بنص فقط.",
            } as const);
            await repeatTurn();
          }
          if (isStalled()) {
            const missingSocialInputs = socialIntent.task ? getMissingSocialTaskInputs(conversationRequestText) : [];
            const verifiedSocialReady = Boolean(verifiedSocialCap) && Boolean(socialIntent.task) && missingSocialInputs.length === 0 &&
              !shouldAskSocialTimeWindow(conversationRequestText);
            const briefReady = brief.platforms.length > 0 && brief.topics.length > 0 &&
              (Boolean(brief.targetVolume && brief.targetVolume > 0) || Boolean(brief.postCount && brief.commentsPerPost));
            if (verifiedSocialReady || briefReady) {
              clarificationItemsList = undefined;
              clarificationQuestionsList = undefined;
              output = buildAutoPlanProposal(brief, validationCaps, conversationRequestText) as any;
              console.warn(`[chat:stall_guard] outcome=plan_from_code reason=no_tool_call`);
            } else {
              const one = getDeterministicDiscoveryQuestion(conversationRequestText, brief, allCapabilities) ||
                buildCodeDiscoveryFallback(allCapabilities, conversationRequestText, false, brief).items[0] || null;
              if (one) {
                const normalizedOne = normalizeClarificationQuestions({ questions: [one] }, {
                  capabilities: allCapabilities,
                  userBalancePoints: userBalance,
                  persona: userProfile?.persona,
                })[0] || one;
                clarificationItemsList = [normalizedOne];
                clarificationQuestionsList = [normalizedOne.text || normalizedOne.question];
                finalContentAr = deduplicateIntroText(
                  budgetLeft() <= MIN_MODEL_CALL_BUDGET_MS ? SLOW_TURN_INTRO_AR : consultantIntroAr(conversationRequestText, one.id),
                );
                output = {
                  type: "ask_clarification",
                  reasonAr: finalContentAr,
                  intro: finalContentAr,
                  questions: clarificationItemsList,
                  questionsAr: clarificationQuestionsList,
                } as any;
                console.warn(`[chat:stall_guard] outcome=one_question reason=no_tool_call`);
              }
            }
          }
        }
      }

      // A sort, a filter or a column choice is file shaping (free, no model-built file); the paid-revision card is retired.
      if (output.type === "edit_artifact" && shapingColumns.length > 0) {
        const spec = shapeSpecFromEditArtifact(output as any);
        if (spec) output = { type: "shape_file", replyAr: "تمام", spec } as any;
      }

      // 7f. File shaping: the spec is checked against the real columns of the delivered result. An unknown column is never
      // guessed: the customer is told which columns exist and asked ONE question.
      if (output.type === "shape_file" && shapingColumns.length > 0) {
        const checked = validateFileSpec((output as any).spec, shapingColumns);
        if (checked.ok) {
          (output as any).spec = checked.spec;
        } else if (shapeQuestionForSpec((output as any).spec, shapingColumns)) {
          const shapeQuestion = shapeQuestionForSpec((output as any).spec, shapingColumns)!;
          const choices = columnChoicesAr(shapingColumns, 8, shapeQuestion.id === "shape_column_required");
          const question = {
            id: shapeQuestion.id,
            text: shapeQuestion.textAr,
            question: shapeQuestion.textAr,
            type: "single" as const,
            options: choices,
            allowOther: false,
          };
          shapeQuestionIssued = true;
          clarificationItemsList = [question as any];
          clarificationQuestionsList = [question.text];
          finalContentAr = `${checked.errorAr.replace(/ اختر من الأعمدة الموجودة في الملف\.$/, "")} الأعمدة المتاحة في ملفك مذكورة أدناه، ولن يُخصم أي رصيد.`;
          output = { type: "ask_clarification", reasonAr: finalContentAr, intro: finalContentAr, questions: clarificationItemsList, questionsAr: clarificationQuestionsList } as any;
        } else {
          finalContentAr = `${checked.errorAr} الأعمدة المتاحة: ${columnChoicesAr(shapingColumns, 10).map((c) => `«${c}»`).join("، ")}.`;
          output = { type: "answer_question", answerAr: finalContentAr } as any;
        }
      }

      // A turn about the delivered file, and every answer to a shaping question, can never become a priced plan: the
      // shape of a file is free, and a plan would reserve points the customer never asked to spend.
      // Nothing else a model may say about the file reaches a priced flow either: no plan, no search, and no research question
      // (the country question of a company request) after a shaping turn. Only the shaping question we raised ourselves stays.
      if (isFileShapingTurn && !shapeQuestionIssued && !["shape_file", "answer_question", "refuse", "edit_artifact"].includes(output.type)) {
        finalContentAr = SHAPING_NEVER_A_PLAN_AR;
        output = { type: "answer_question", answerAr: SHAPING_NEVER_A_PLAN_AR } as any;
        clarificationItemsList = undefined;
        clarificationQuestionsList = undefined;
      }

      // The language model can incorrectly suggest an unrelated alternative for a
      // people-search request. Prefer the verified people capability when present.
      // A turn about the delivered file is never turned into a new search plan by these guards.
      if (!isFileShapingTurn) {
        output = routePeopleAlternative(output, brief, validationCaps, conversationRequestText);
        // Explicit company requests receive the same deterministic routing guard.
        output = routeCompanySearchRequest(output, brief, validationCaps, conversationRequestText);
      }
      if (!isFileShapingTurn && ACCOUNT_LOOKUP_RE.test(conversationRequestText)) {
        // Profile requests have a distinct one-record plan with no country or
        // date filters; don't let a generic social-content plan replace it.
        output = buildAutoPlanProposal(brief, validationCaps, conversationRequestText) as any;
      }

      // 8. Process Output Actions
      currentStep = "output_action";
      const stalledAnswerText =
        output.type === "answer_question" ? (((output as any).answerAr || "") as string).trim() : "";
      if (output.type === "search_catalog" || (output.type === "answer_question" && !stalledAnswerText)) {
        fallbackToDiscovery();
      } else if (output.type === "update_brief") {
        if (output.platforms && output.platforms.length > 0) {
          for (const p of output.platforms) {
            if (!brief.platforms.includes(p)) brief.platforms.push(p);
          }
        }
        if (output.topics && output.topics.length > 0) {
          for (const t of output.topics) {
            if (!brief.topics.includes(t)) brief.topics.push(t);
          }
        }
        if (output.targetVolume) brief.targetVolume = output.targetVolume;
        if (output.commentsPerPost) brief.commentsPerPost = output.commentsPerPost;
        // The model may not invent a period: it is kept only when the customer's own words state one.
        if (output.dateRange && windowIsStatedByCustomer(resolveTimeWindow(conversationRequestText, { needsWindow: true }))) brief.dateRange = output.dateRange;
        if (output.language) brief.language = output.language;
        if (output.formats) brief.formats = output.formats;
        if (output.notes) brief.notes = output.notes;

        await saveConversationBrief(this.tables, conversationId, userId, brief);

        if (output.questions && output.questions.length > 0) {
          const normalized = normalizeClarificationQuestions(
            { questions: output.questions as any },
            { capabilities: allCapabilities, userBalancePoints: userBalance, persona: userProfile?.persona },
          );
          const hasPlatformOrTopic = Boolean(
            (brief.platforms && brief.platforms.length > 0) || (brief.topics && brief.topics.length > 0),
          );
          clarificationItemsList = hasPlatformOrTopic
            ? filterQuestionsAlreadyInBrief(normalized, brief).slice(0, 1)
            : filterQuestionsAlreadyInBrief(normalized, brief);
          clarificationQuestionsList = clarificationItemsList.map((q) => q.text);
          if (clarificationItemsList.length > 0) {
            finalContentAr = deduplicateIntroText(output.replyAr || (llmResult.textBlockAr?.trim()) || GENERIC_ASK_ONE_INTRO_AR);
            output = {
              type: "ask_clarification",
              reasonAr: finalContentAr,
              intro: finalContentAr,
              questions: clarificationItemsList,
              questionsAr: clarificationQuestionsList,
            } as any;
          } else if (isPhase2 || isCardAnswer || (brief.platforms.length > 0 && (brief.topics.length > 0 || brief.targetVolume))) {
            clarificationItemsList = undefined;
            clarificationQuestionsList = undefined;
            output = buildAutoPlanProposal(brief, validationCaps, message) as any;
          } else {
            clarificationItemsList = undefined;
            clarificationQuestionsList = undefined;
            finalContentAr = deduplicateIntroText(output.replyAr || (llmResult.textBlockAr?.trim()) || "سجلت طلبك، وأجهز لك الخطة فور اكتمال التفاصيل.");
            output = {
              type: "answer_question",
              answerAr: finalContentAr,
            } as any;
          }
        } else if (isPhase2 || isCardAnswer || (brief.platforms.length > 0 && (brief.topics.length > 0 || brief.targetVolume))) {
          clarificationItemsList = undefined;
          clarificationQuestionsList = undefined;
          output = buildAutoPlanProposal(brief, validationCaps, message) as any;
        } else {
          clarificationItemsList = undefined;
          clarificationQuestionsList = undefined;
          finalContentAr = deduplicateIntroText(output.replyAr || (llmResult.textBlockAr?.trim()) || "سجلت طلبك، وأجهز لك الخطة فور اكتمال التفاصيل.");
          output = {
            type: "answer_question",
            answerAr: finalContentAr,
          } as any;
        }
      } else if ((output.type === "ask_clarification" || output.type === "ask_questions") && !clarificationItemsList) {
        await saveConversationBrief(this.tables, conversationId, userId, brief);
        const clarification = buildClarificationPresentation(output as any, {
          capabilities: allCapabilities,
          userBalancePoints: userBalance,
          persona: userProfile?.persona,
          userMessage: message,
        });
        const companyRequirementsText = conversationRequestText;
        const missingCompanyRequirements = isCompanyIntent && !isPeopleSearchRequest(companyRequirementsText)
          ? getMissingCompanyResearchRequirements(companyRequirementsText)
          : [];
        const hasPlatformOrTopic = Boolean(
          (brief.platforms && brief.platforms.length > 0) || (brief.topics && brief.topics.length > 0),
        );
        if (missingCompanyRequirements.length > 0) {
          clarificationItemsList = getCompanyRequirementItems(missingCompanyRequirements, companyRequirementsText);
          clarificationQuestionsList = clarificationItemsList.map((item) => item.text);
          finalContentAr = "قبل إعداد عرض السعر، أحتاج تحديد نطاق البحث وهدف التواصل حتى لا أخمّن تفاصيل قد تغيّر النتائج.";
        } else {
          clarificationItemsList = hasPlatformOrTopic
            ? filterQuestionsAlreadyInBrief(clarification.clarificationItems, brief).slice(0, 1)
            : filterQuestionsAlreadyInBrief(clarification.clarificationItems, brief);
        }
        clarificationQuestionsList = clarificationItemsList.map((item) => item.text);
        if (clarificationItemsList.length > 0) {
          finalContentAr = deduplicateIntroText(
            (llmResult.textBlockAr && llmResult.textBlockAr.trim().length > 0)
              ? llmResult.textBlockAr
              : clarification.contentAr,
          );
        } else if (isPhase2 || isCardAnswer || (brief.platforms.length > 0 && (brief.topics.length > 0 || brief.targetVolume))) {
          clarificationItemsList = undefined;
          clarificationQuestionsList = undefined;
          output = buildAutoPlanProposal(brief, validationCaps, message) as any;
        } else {
          clarificationItemsList = undefined;
          clarificationQuestionsList = undefined;
          finalContentAr = "فهمت أنك تريد جمع بيانات، وأحتاج أن أعرف المنصة والموضوع أولًا.";
          output = {
            type: "answer_question",
            answerAr: finalContentAr,
          } as any;
        }
      } else if (output.type === "answer_question") {
        await saveConversationBrief(this.tables, conversationId, userId, brief);
        if ((isPhase2 || isCardAnswer) && brief.platforms.length > 0 && (brief.topics.length > 0 || brief.targetVolume)) {
          output = buildAutoPlanProposal(brief, validationCaps, message) as any;
          // A company or people request with no allowed source live comes back as a plain answer, not a plan.
          if (output.type === "answer_question") finalContentAr = (output as any).answerAr;
        } else {
          finalContentAr = output.answerAr;
        }
      }

      if (output.type === "write_note") {
        await saveConversationBrief(this.tables, conversationId, userId, brief);
        finalContentAr = `${output.titleAr}\n\n${output.contentAr}`;
      } else if (input.isGuest && output.type === "propose_plan") {
        await saveConversationBrief(this.tables, conversationId, userId, brief);
        const summaryText = (output as any).summaryAr || "يمكنني مساعدتك في استخراج هذه البيانات بدقة وفق متطلباتك.";
        output = {
          type: "answer_question",
          answerAr: `${summaryText}\n\nللاطلاع على خطة التنفيذ المكتملة وعرض السعر بالنقاط وبدء البحث، يرجى إنشاء حساب مجاني أو تسجيل الدخول.`,
        };
        finalContentAr = (output as any).answerAr;
      } else if (output.type === "propose_plan") {
        await saveConversationBrief(this.tables, conversationId, userId, brief);
        const selectedOutputFormats: Array<"xlsx" | "pdf" | "csv"> = brief.formats?.length
          ? brief.formats.filter((format): format is "xlsx" | "pdf" | "csv" =>
              format === "xlsx" || format === "pdf" || format === "csv",
            )
          : ["xlsx"];
        // The Facebook topic REPORT is delivered as the workbook AND the methodology file (the PDF is the report's own methodology and analysis, see facebookReportPdf).
        if (detectSocialIntent(conversationRequestText).report && !selectedOutputFormats.includes("pdf")) selectedOutputFormats.push("pdf");
        (output as any).outputFormats = [...selectedOutputFormats];
        const explicitCountry = detectCountryFromText(conversationRequestText);
        const explicitRequestedVolume = researchIntent.sampleSize.provenance === "EXPLICIT"
          ? researchIntent.sampleSize.value
          : (isCardAnswer ? brief.targetVolume : undefined);
        const mapPlanItems = (out: any) =>
          ((out as any).capabilities || (out as any).steps || []).map((c: any) => {
            const itemParams = { ...(c.params || {}) };
            const rawCapabilityId = c.capabilitySlug || c.endpointId || "";
            const isPeopleCapability = /people/i.test(`${rawCapabilityId} ${c.endpointId || ""}`);
            const capabilityId = isPeopleCapability ? "professional-people-search" : rawCapabilityId;
            const isRecordSearchCapability = /compan|b2b|people/i.test(capabilityId);
            const isSocialContentCapability = /video|videos|tiktok|youtube|reels|posts?|social|instagram|facebook|reddit|twitter/i.test(capabilityId);
            if (isSocialContentCapability && (!itemParams.dateFrom || !itemParams.dateTo)) {
              const dateFilters = requestDateFilters(brief.dateRange, conversationRequestText);
              if (dateFilters.from && !itemParams.dateFrom) itemParams.dateFrom = dateFilters.from;
              if (dateFilters.to && !itemParams.dateTo) itemParams.dateTo = dateFilters.to;
            }
            const requestedRecordVolume = isRecordSearchCapability && explicitRequestedVolume && explicitRequestedVolume > 0
              ? explicitRequestedVolume
              : undefined;
            const detectedIndustry = detectIndustryFromText(conversationRequestText);
            if (isSocialContentCapability && typeof itemParams.industry === "string") {
              // Social/video plans have a topic, not a company-industry field.
              // Models sometimes copy the complete natural-language request here.
              delete itemParams.industry;
            }
            if (!isSocialContentCapability && (!itemParams.query || (typeof itemParams.query === "object" && Object.keys(itemParams.query).length === 0))) {
              itemParams.query = {
                ...(detectedIndustry.arabicLabel !== "قواعد بيانات الشركات" ? { keyword: { include: detectedIndustry.englishKeywords } } : {}),
                ...(explicitCountry ? { location: { include: [explicitCountry.canonicalEnglish] } } : {}),
              };
            }
            if (explicitCountry && !itemParams.country && !itemParams.location) {
              itemParams.country = explicitCountry.canonicalEnglish;
              itemParams.location = explicitCountry.canonicalEnglish;
              if (itemParams.query && typeof itemParams.query === "object") {
                itemParams.query.location = { include: [explicitCountry.canonicalEnglish] };
              }
            }
            if (isPeopleCapability) {
              // Parameters are built from the customer's own words in the form the source matches: an English job title,
              // English activity keywords, an ISO country code, and NO copy of the sentence (it carries contact wording).
              const builtPeopleParams = peopleParamsFromIntent(
                extractRequestIntent(conversationRequestText),
                itemParams,
                Math.max(1, Math.min(50, Number(requestedRecordVolume || itemParams.limit || 10))),
              );
              for (const key of ["q", "company_domain", "title", "keywords", "country"]) delete itemParams[key];
              Object.assign(itemParams, builtPeopleParams);
              // Contact data is a required part of this B2B capability. The
              // per-person rate covers these bounded enrichment attempts;
              // incomplete rows are excluded before customer billing.
              itemParams.contactFieldsToAttempt = ["work_email", "phone"];
              itemParams.requiredContactFields = ["work_email", "phone"];
              delete itemParams.query;
              delete itemParams.pagination;
            }
            if (/compan|b2b/i.test(capabilityId) && !isPeopleCapability) {
              Object.assign(itemParams, companyParamsFromIntent(extractRequestIntent(conversationRequestText), itemParams));
            }
            if (requestedRecordVolume && itemParams.pagination && typeof itemParams.pagination === "object") {
              const currentPageSize = Number(itemParams.pagination.size);
              if (!Number.isFinite(currentPageSize) || currentPageSize > requestedRecordVolume) {
                itemParams.pagination.size = requestedRecordVolume;
              }
            }
            return {
              stepId: c.stepId,
              capabilitySlug: capabilityId,
              endpointId: isPeopleCapability ? "treg.people.search" : (c.endpointId || c.capabilitySlug),
              paginationStrategy: c.paginationStrategy,
              params: {
                ...itemParams,
                ...(brief.exclusionFile
                  ? {
                      exclusionRules: {
                        fileName: brief.exclusionFile.name,
                        baselineRowCount: brief.exclusionFile.baselineRowCount,
                        companyNames: brief.exclusionFile.companyNames,
                        corporateDomains: brief.exclusionFile.corporateDomains,
                      },
                    }
                  : {}),
              },
              targetVolumeMin: requestedRecordVolume
                ? Math.min(c.targetVolumeMin || 1, requestedRecordVolume)
                : c.targetVolumeMin || 1,
              targetVolumeMax: requestedRecordVolume || c.targetVolumeMax,
            };
          });

        // What the customer asked for a single social item, before any ceiling (the capability's rows or the job's points cap).
        let askedVolumeForCard = null as number | null;
        /** Set when the plan's count is a default (the customer left it open): the plan says so and the customer can edit it. */
        let defaultCapUsed = null as { noun: DefaultNoun; units: number } | null;
        /** The number of videos the customer asked for in a comments request: a quantity of its own, shown next to the comment count. */
        let videosStatedForPlan = null as { count: number; noun: "videos" | "posts" } | null;
        // The service's own per-request ceiling, when IT (not the balance, not the points cap) is what cuts the count: said as such on the plan.
        let serviceCeilingNow = null as number | null;
        let reachCutNow = null as { units: number; detailAr: string } | null;
        /** The top videos found by a topic because the customer skipped the channels: the plan says so. */
        let missionByTopicSubject = null as string | null;
        /** The customer asked for fewer comments from each post than the service reads from one (its price is built on that many): what they asked and the posts they named. */
        let perPostRaisedNow = null as { asked: number; posts: number | null } | null;
        const canonicalizePlanItems = (items: PlanItem[]) => items.map((item) => {
          // A social request is served by its verified capability whatever the model proposed; the link, channel,
          // keyword and country are rebuilt from the customer's own words.
          if (verifiedSocialDef && verifiedSocialCap) {
            // Only a period the customer wrote filters the results. The brief's own default window ("آخر شهر") would
            // silently discard every comment on an older video and then report that nothing matched.
            const understanding = understandMission(conversationRequestText);
            // A feed request with no period of its own gets the proposed default (the plan states it and why): never silently none.
            const planWindow = windowOrProposedDefault(understanding.window);
            const statedDates = requestDateFilters(conversationRequestText);
            const dates = statedDates.from
              ? statedDates
              : planWindow.status === "resolved" && planWindow.source === "default" && planWindow.dateFrom && planWindow.dateTo
              ? { from: planWindow.dateFrom, to: planWindow.dateTo }
              : {};
            const isCommentsKind = verifiedSocialDef.kind === "comments";
            const commentsOfPosts = isCommentsKind && socialIntent.discover !== "channel";
            const perVideoBrief = brief.commentsPerPost && brief.commentsPerPost > 0 ? brief.commentsPerPost : undefined;
            const videoCountBrief = brief.postCount && brief.postCount > 0 ? brief.postCount : undefined;
            // A mission over channels: the channels, the top videos kept per channel (ranked by views) and the topic come
            // from the customer's words; the number they stated is the comment cap, never the top-N or the channel count.
            const mission = isCommentsKind ? understanding : null;
            const isMission = Boolean(mission && (mission.kind === "social_ranked_comments" || mission.kind === "social_channel_topic") && mission.channels.named.length > 0);
            // The channels were skipped and a topic was given: the top videos are searched by that topic, as many as the template asked for in all.
            const byTopic = Boolean(mission && mission.kind === "social_ranked_comments" && mission.channelsSkipped && mission.subject && !isMission);
            // A mission's count is the comment cap: the customer's, or an explicit default the plan shows (never a hidden 10).
            // posts x comments per post, when the customer stated both, is THEIR count (never the default the plan labels «لأنك لم تحدد عددًا»)
            const missionCap = (isMission || byTopic) && mission ? mission.volume ?? mission.impliedVolume ?? DEFAULT_COMMENTS_CAP : null;
            const topicVideoCount = byTopic && mission ? Math.min(MAX_VIDEOS_PER_JOB, Math.max(1, (mission.topPerChannel ?? 10) * Math.max(1, mission.channels.count ?? 1))) : undefined;
            // Comments of videos found by a topic or a link: the number of videos and the number of comments are two quantities. «٣ فيديوهات»
            // is never the comment cap; the cap is the customer's number, or an explicit default the plan shows.
            let statedVolume: number;
            let capIsDefault = false;
            if (missionCap) {
              statedVolume = missionCap;
            } else if (isCommentsKind) {
              if (understanding.volume) statedVolume = understanding.volume;
              else if (understanding.commentsPerVideo && understanding.videos) statedVolume = understanding.commentsPerVideo * understanding.videos;
              else { statedVolume = DEFAULT_COMMENTS_CAP; capIsDefault = true; }
            } else if (verifiedSocialDef.kind === "posts") {
              // A count the customer wrote (or tapped on the card); the brief's own «10» is a placeholder, never a stated number.
              const writtenCount = understanding.volume || (researchIntent.sampleSize.provenance === "EXPLICIT" ? researchIntent.sampleSize.value : 0);
              capIsDefault = !(writtenCount && writtenCount > 0);
              statedVolume = capIsDefault ? DEFAULT_RECORDS_CAP : Number(writtenCount);
            } else {
              // A count the customer wrote (or tapped on the cap card). The brief's own «10» is a placeholder, and a card answer to another
              // question (the period) does not make it the customer's: without a count of theirs the plan's number is a default, and says so.
              const videosWritten = Number(/(?:^|[^\d])(\d{1,6})\s*(?:فيديو|فيديوهات|مقطع|مقاطع|ريلز|شورتس)/u.exec(normalizeDigits(conversationRequestText))?.[1]) || 0;
              const writtenCount = understanding.volume || (researchIntent.sampleSize.provenance === "EXPLICIT" ? researchIntent.sampleSize.value : 0) || videosWritten;
              capIsDefault = !(writtenCount && writtenCount > 0);
              statedVolume = capIsDefault ? item.targetVolumeMax || 1 : Number(writtenCount);
            }
            const askedVideos = commentsOfPosts && !byTopic ? understanding.videos ?? videoCountBrief : undefined;
            const perVideoForPlan = byTopic && topicVideoCount
              ? Math.min(MAX_PER_VIDEO, Math.ceil(statedVolume / topicVideoCount))
              : isMission
              // a mission's own per-post number («٢٠ تعليق من كل منشور») is the customer's, and is kept (it was dropped before)
              ? mission?.commentsPerVideo ?? undefined
              : commentsOfPosts
              ? understanding.commentsPerVideo ?? (askedVideos ? Math.min(MAX_PER_VIDEO, Math.ceil(statedVolume / askedVideos)) : perVideoBrief)
              : perVideoBrief;
            if (verifiedSocialDef.minPerVideo && perVideoForPlan && perVideoForPlan < verifiedSocialDef.minPerVideo) perPostRaisedNow = { asked: perVideoForPlan, posts: askedVideos ?? null };
            const params = canonicalSocialParams(verifiedSocialDef, socialIntent, conversationRequestText, item.params, {
              dateFrom: dates.from,
              dateTo: dates.to,
              // The «١٠ فيديوهات» of a mission is the top-N per channel, not a per-video or video-count setting.
              perVideo: perVideoForPlan,
              videoCount: byTopic ? topicVideoCount : isMission ? undefined : askedVideos ?? (isCommentsKind ? undefined : videoCountBrief),
              ...(byTopic && mission ? { subject: mission.subject ?? undefined } : {}),
              ...(isMission && mission ? {
                channels: mission.channels.named,
                // «كل تعليقات ٣ فيديوهات» from a channel: the three videos of each named channel, a quantity apart from the comment cap.
                topPerChannel: mission.topPerChannel ?? (mission.kind === "social_channel_topic" ? mission.videos ?? undefined : undefined),
                rankBy: mission.rankedBy ?? undefined,
                topic: mission.kind === "social_channel_topic" ? mission.subject ?? undefined : undefined,
              } : {}),
            });
            // Videos x most comments per video is the most that can be read; the plan never promises more than that. A mission over pages or
            // channels reads at most (the top posts of each) x (the comments taken from each).
            const missionReachable = Number(params.topPerChannel) > 0 && Number(params.perVideo) > 0 && Array.isArray(params.channels)
              ? Number(params.topPerChannel) * params.channels.length * Number(params.perVideo)
              : Infinity;
            const reachable = Math.min(params.videoCount && params.perVideo ? Number(params.videoCount) * Number(params.perVideo) : Infinity, missionReachable);
            const volume = Math.max(1, Math.min(statedVolume, verifiedSocialDef.maxRows, reachable));
            askedVolumeForCard = items.length === 1 ? statedVolume : null;
            // (a tie with what the posts can reach is the service ceiling too: «٤٠٠ منشور بخمسة تعليقات» reaches 1,500 at the ceiling of 300 posts, and the ceiling is what cut the 2,000)
            if (items.length === 1 && verifiedSocialDef.maxRows < statedVolume && verifiedSocialDef.maxRows <= reachable) serviceCeilingNow = verifiedSocialDef.maxRows;
            // What the posts a job reads times the comments from each can reach is what cut it (not the balance, not the points cap).
            if (items.length === 1 && Number.isFinite(reachable) && reachable < Math.min(statedVolume, verifiedSocialDef.maxRows)) {
              const postsReadable = Number(params.topPerChannel) > 0 && Array.isArray(params.channels) ? Number(params.topPerChannel) * params.channels.length : Number(params.videoCount);
              reachCutNow = { units: reachable, detailAr: `${videosCountAr(postsReadable, verifiedSocialDef.platform === "facebook" ? "posts" : "videos")} × ${toArabicDigits(Number(params.perVideo))} تعليقًا لكل ${verifiedSocialDef.platform === "facebook" ? "منشور" : "فيديو"}` };
            }
            if ((missionCap && mission && mission.volume === null && mission.impliedVolume === null) || capIsDefault) defaultCapUsed = { noun: isCommentsKind ? "comments" : verifiedSocialDef.kind === "videos" ? "videos" : "records", units: statedVolume };
            if (isCommentsKind && understanding.videos && !isMission && !byTopic) videosStatedForPlan = { count: understanding.videos, noun: understanding.videosNoun };
            if (byTopic && mission?.subject) missionByTopicSubject = mission.subject;
            return {
              ...item,
              capabilitySlug: verifiedSocialDef.slug,
              endpointId: verifiedSocialCap.tregEndpointId || verifiedSocialDef.slug,
              paginationStrategy: "cursor",
              params,
              targetVolumeMin: Math.min(item.targetVolumeMin || 1, volume),
              targetVolumeMax: volume,
            } as PlanItem;
          }
          const capability = resolveCapabilityReference(item.capabilitySlug, validationCaps) ||
            (item.endpointId ? resolveCapabilityReference(item.endpointId, validationCaps) : undefined);
          let params = item.params;
          if (capability && /tiktok.*search.*videos|videos.*search.*tiktok/i.test(`${capability.slug} ${capability.tregEndpointId || capability.id}`)) {
            let schema: any = capability.paramsSchema;
            if (typeof schema === "string") {
              try { schema = JSON.parse(schema); } catch { schema = {}; }
            }
            if (schema?.properties?.query?.type === "string") {
              const requestCountry = detectCountryFromText(conversationRequestText);
              const topic = socialSearchQueryFromTitle(
                typeof planOutput.conversationTitle === "string" ? planOutput.conversationTitle : "",
                requestCountry?.arabicLabel,
              );
              if (topic) params = { ...params, query: topic };
            }
          }
          // The search text of a model-planned Facebook topic request stays the clean topic («الترندات الصحية في مصر»): a query that still carries the
          // request's verbs, count or platform words is replaced by the subject and place the customer named.
          if (socialIntent.platform === "facebook" && params && typeof params === "object" && "query" in params
            && pairRoleOf({ capabilitySlug: capability?.slug || item.capabilitySlug, endpointId: capability?.tregEndpointId || item.endpointId }) === "posts"
            && searchTextNeedsCleaning((params as any).query)) {
            const cleanTopic = cleanSocialTopicAr(conversationRequestText);
            if (cleanTopic) params = { ...params, query: cleanTopic };
          }
          return capability
            ? {
                ...item,
                capabilitySlug: capability.slug || capability.id || item.capabilitySlug,
                endpointId: capability.tregEndpointId || capability.id || capability.slug || item.endpointId || item.capabilitySlug,
                params,
              }
            : item;
        });

        let planOutput: any = output;
        let planItems = dedupeRecordSearchItems<PlanItem>(canonicalizePlanItems(mapPlanItems(planOutput)));
        const companyPlan = planItems.some((item: any) =>
          /compan|b2b/i.test(`${item.capabilitySlug || ""} ${item.endpointId || ""}`)
        );
        const peoplePlan = planItems.some((item: any) =>
          /people/i.test(`${item.capabilitySlug || ""} ${item.endpointId || ""}`)
        );
        const requiredFieldsText = conversationRequestText;
        const isAccountProfileRequest = ACCOUNT_LOOKUP_RE.test(requiredFieldsText);
        const isSocialTopicRequest = !isAccountProfileRequest && SOCIAL_CONTENT_WORDS_RE.test(requiredFieldsText);
        const accountHandle = ACCOUNT_HANDLE_RE.exec(requiredFieldsText)?.[1];
        const hasExplicitCount = Boolean(extractNumberFromText(requiredFieldsText));
        const missingCompanyFields = companyPlan && !isPeopleSearchRequest(requiredFieldsText)
          ? getMissingCompanyResearchRequirements(requiredFieldsText)
          : [];
        const missingPeopleFields: string[] = [];
        if (peoplePlan) {
          if (!detectCountryFromText(requiredFieldsText)) missingPeopleFields.push("people_country_required");
          const scopeMissing = getMissingCompanyResearchRequirements(requiredFieldsText).includes("industry") && !hasExplicitPeopleScope(requiredFieldsText);
          if (scopeMissing) missingPeopleFields.push("people_scope_required");
          if (!PEOPLE_ROLE_PATTERN.test(requiredFieldsText)) {
            missingPeopleFields.push("people_roles_required");
          }
          if (!hasExplicitCount) missingPeopleFields.push("people_count_required");
        }
        const missingSocialFields: string[] = [];
        if (isAccountProfileRequest && !accountHandle) missingSocialFields.push("social_account_required");
        if (isSocialTopicRequest && !verifiedSocialDef) {
          missingSocialFields.push(...getMissingSocialInputs(requiredFieldsText).filter((id) => id !== "social_account_required"));
        }
        if (!isAccountProfileRequest && !companyPlan && !peoplePlan) {
          missingSocialFields.push(...getMissingSocialTaskInputs(requiredFieldsText));
        }
        const missingCompanyCount = companyPlan && !isPeopleSearchRequest(requiredFieldsText) && !hasExplicitCount;
        const missingRequiredFields = [
          ...missingCompanyFields,
          ...(missingCompanyCount ? ["company_count_required"] : []),
          ...missingPeopleFields,
          ...missingSocialFields,
        ];
        if (missingRequiredFields.length > 0) {
          finalContentAr = consultantIntroAr(requiredFieldsText, undefined);
          const firstMissing = missingRequiredFields[0];
          const companyItems = companyPlan && !isPeopleSearchRequest(requiredFieldsText)
            ? getCompanyRequirementItems(missingCompanyFields, requiredFieldsText)
            : [];
          const companyItem = companyItems[0];
          const questionByField: Record<string, any> = {
            company_count_required: { id: firstMissing, text: "كم شركة تريد في النتائج؟", question: "كم شركة تريد في النتائج؟", type: "free", options: [], allowOther: true },
            people_country_required: { id: firstMissing, text: "في أي دولة تريد البحث عن صناع القرار؟", question: "في أي دولة تريد البحث عن صناع القرار؟", type: "single", options: ["مصر", "السعودية", "الإمارات", "أخرى"], allowOther: true },
            people_scope_required: { id: firstMissing, text: "ما المجال أو الشركة التي تريد صناع القرار منها؟", question: "ما المجال أو الشركة التي تريد صناع القرار منها؟", type: "free", options: [], allowOther: true },
            people_roles_required: { id: firstMissing, text: "ما المسميات الوظيفية التي تريدها؟", question: "ما المسميات الوظيفية التي تريدها؟", type: "free", options: [], allowOther: true },
            people_count_required: { id: firstMissing, text: "كم صانع قرار تريد؟", question: "كم صانع قرار تريد؟", type: "free", options: [], allowOther: true },
            social_account_required: { id: firstMissing, text: "ما اسم الحساب أو رابطه على تيك توك؟", question: "ما اسم الحساب أو رابطه على تيك توك؟", type: "free", options: [], allowOther: true },
            social_platform_required: { id: firstMissing, text: "على أي منصة تريد البحث؟", question: "على أي منصة تريد البحث؟", type: "single", options: ["تيك توك", "فيسبوك", "يوتيوب", "إنستغرام", "أخرى"], allowOther: true },
            social_time_required: { id: firstMissing, text: windowQuestion().text, question: windowQuestion().text, type: "single", options: [...WINDOW_OPTIONS_AR], allowOther: true },
            social_topic_required: { id: firstMissing, text: "ما الموضوع أو الكلمات التي تريد البحث عنها؟", question: "ما الموضوع أو الكلمات التي تريد البحث عنها؟", type: "free", options: [], allowOther: true },
            social_comment_target_required: socialTaskQuestion("social_comment_target_required", socialIntent.platform),
            social_trending_region_required: socialTaskQuestion("social_trending_region_required"),
            social_trending_platform_required: socialTaskQuestion("social_trending_platform_required"),
            social_channel_required: socialTaskQuestion("social_channel_required"),
            social_x_topic_required: socialTaskQuestion("social_x_topic_required"),
            social_x_account_required: socialTaskQuestion("social_x_account_required"),
          };
          clarificationItemsList = companyItem
            ? [companyItem]
            : [questionByField[firstMissing] || { id: "company_count_required", text: "كم شركة تريد في النتائج؟", question: "كم شركة تريد في النتائج؟", type: "free", options: [], allowOther: true }];
          clarificationQuestionsList = clarificationItemsList.map((item) => item.text);
          output = {
            type: "ask_clarification",
            reasonAr: finalContentAr,
            intro: finalContentAr,
            questions: clarificationItemsList,
            questionsAr: clarificationQuestionsList,
          } as any;
          planOutput = null;
        }

        // Deterministic check: platform mentioned by user must match platform in proposed plan
        let platformCheck = validatePlanPlatformMatch(message, planItems, validationCaps);
        let planValidation = platformCheck.valid
          ? validatePlanAgainstLiveCatalog(planItems, turnEndpoints, allCapabilities)
          : { valid: false, errors: [] as string[], issues: [] as LiveCatalogIssue[] };
        if (missingRequiredFields.length > 0) {
          planValidation = { valid: false, errors: ["missing-company-required-fields"], issues: [] as LiveCatalogIssue[] };
        }

        let planRetries = 0;
        while (missingRequiredFields.length === 0 && platformCheck.valid && !planValidation.valid && planRetries < 3) {
          if (planValidation.issues.some((i) => i.kind === "missing_cost")) {
            console.warn("[chat:plan_validation_missing_cost_abort_retry]", { issues: planValidation.issues });
            break;
          }
          planRetries++;
          console.warn("[chat:plan_fix_retry]", { attempt: planRetries, errors: planValidation.errors });
          loopMessages.push(
            { role: "system", content: buildPlanFixPrompt(planValidation, turnEndpoints) } as const,
          );
          await repeatTurn();
          if (output.type === "propose_plan") {
            planOutput = output;
            planItems = dedupeRecordSearchItems<PlanItem>(canonicalizePlanItems(mapPlanItems(planOutput)));
            platformCheck = validatePlanPlatformMatch(message, planItems, validationCaps);
            if (platformCheck.valid) {
              planValidation = validatePlanAgainstLiveCatalog(planItems, turnEndpoints, allCapabilities);
            }
          } else {
            planOutput = null;
            planValidation = { valid: false, errors: ["no-plan"], issues: [] as LiveCatalogIssue[] };
          }
        }

        if (missingRequiredFields.length > 0) {
          // Keep the clarification response created above; no quote should be saved with inferred defaults.
        } else if (testScenario === "plan_ghost_then_stall") {
          console.warn("[chat:plan_validation_invalid]", { errors: planValidation.errors });
          const planFallback = buildCodeDiscoveryFallback(allCapabilities, message, true, brief);
          clarificationQuestionsList = planFallback.items.map((item) => item.text);
          clarificationItemsList = planFallback.items;
          finalContentAr = deduplicateIntroText(planFallback.intro);
          output = {
            type: "ask_clarification",
            reasonAr: finalContentAr,
            intro: finalContentAr,
            questions: planFallback.items,
            questionsAr: clarificationQuestionsList,
          } as any;
        } else if (!platformCheck.valid) {
          console.warn("[chat:platform_check_invalid]", { message, planItems });
          finalContentAr = platformCheck.reasonCode === "company_source_unavailable" ? COMPANY_SOURCE_UNAVAILABLE_AR : platformCheck.reasonCode === "people_source_unavailable" ? PEOPLE_SOURCE_UNAVAILABLE_AR : UNVERIFIED_PLATFORM_MESSAGE_AR;
          output = {
            type: "answer_question",
            answerAr: finalContentAr,
          } as any;
          planOutput = null;
        } else if (!planValidation.valid || !planOutput) {
          if (userComplained) {
            const matchedPlatform = brief.platforms[0] || "tiktok";
            finalContentAr = `أقوم بمراجعة وتعديل خطة جمع البيانات لمنصة ${getPlatformLabelAr(matchedPlatform)} حسب طلبك (${brief.topics.join("، ")}).`;
            output = {
              type: "answer_question",
              answerAr: finalContentAr,
            } as any;
          } else {
            console.warn("[chat:plan_validation_invalid]", { errors: planValidation.errors });
            const planFallback = buildCodeDiscoveryFallback(allCapabilities, message, false, brief);
            if (planFallback.items.length > 0) {
              clarificationQuestionsList = planFallback.items.map((item) => item.text);
              clarificationItemsList = planFallback.items;
              finalContentAr = deduplicateIntroText(planFallback.intro);
              output = {
                type: "ask_clarification",
                reasonAr: finalContentAr,
                intro: finalContentAr,
                questions: planFallback.items,
                questionsAr: clarificationQuestionsList,
              } as any;
            } else {
              const autoPlan = buildAutoPlanProposal(brief, validationCaps, message);
              // A company request with no allowed company source live is answered honestly: no plan, no reserve.
              const autoPlanRefused = (autoPlan as any).type !== "propose_plan";
              const autoPlanItems = autoPlanRefused ? [] : dedupeRecordSearchItems<PlanItem>(mapPlanItems(autoPlan));
              const autoCheck = autoPlanRefused
                ? { valid: false, errors: ["company_source_unavailable"], issues: [] as LiveCatalogIssue[] }
                : validatePlanAgainstLiveCatalog(autoPlanItems, turnEndpoints, allCapabilities);
              if (autoCheck.valid) {
                planOutput = autoPlan;
                planItems = autoPlanItems;
                planValidation = { valid: true, errors: [], issues: [] };
              } else if (autoPlanRefused) {
                finalContentAr = (autoPlan as any).answerAr;
                output = autoPlan as any;
                planOutput = null;
                planValidation = { valid: false, errors: autoCheck.errors, issues: [] as LiveCatalogIssue[] };
              } else {
                console.warn("[chat:auto_plan_invalid_pricing]", { errors: autoCheck.errors });
                // The generic sentence is only for a request with no topic at all. When the customer gave a topic (and maybe a
        // country) the answer is ONE specific question that names them and offers the sources that exist.
        const gathered = detectTopicGathering(conversationRequestText);
        const topicHint = (gathered?.topic || researchIntent.topic.value || brief.topics[0] || "").toString().trim();
        if (topicHint.length >= 2 && !input.isGuest && !hasTopicResearchService(capabilities)) {
          const sourceQuestion = topicSourceQuestion({
            noun: gathered?.noun || "البيانات",
            topic: topicHint,
            countryAr: detectCountryFromText(conversationRequestText)?.arabicLabel,
          });
          clarificationItemsList = [sourceQuestion as any];
          clarificationQuestionsList = [sourceQuestion.text];
          finalContentAr = consultantIntroAr(conversationRequestText, undefined);
          output = { type: "ask_clarification", reasonAr: finalContentAr, intro: finalContentAr, questions: clarificationItemsList, questionsAr: clarificationQuestionsList } as any;
        } else {
          finalContentAr = "اكتب الموضوع أو أرسل رابط المصدر الذي تريد جمع بياناته، وسأجهز خطة تناسب طلبك.";
        }
                output = {
                  type: "ask_clarification",
                  intro: finalContentAr,
                  reasonAr: finalContentAr,
                  questions: [{ id: "topic_or_source", text: "ما الموضوع أو رابط المصدر المطلوب؟", type: "free" }],
                } as any;
                planOutput = null;
                planValidation = { valid: false, errors: autoCheck.errors, issues: autoCheck.issues };
              }
            }
          }
        }

        if (platformCheck.valid && planValidation.valid && planOutput) {
          const peopleGate = routePeopleAlternative(planOutput, brief, validationCaps, conversationRequestText);
          const platformGate = routeUnavailablePlatformRequest(planOutput, conversationRequestText);
          const unavailableGate = peopleGate.type === "refuse" ? peopleGate : platformGate;
          if (unavailableGate.type === "refuse") {
            output = unavailableGate;
            planOutput = null;
            planValidation = { valid: false, errors: [unavailableGate.reasonAr], issues: [] };
            finalContentAr = unavailableGate.reasonAr;
          }
        }

        // Retry button: reuse the rows a failed run already collected, but only when this plan
        // searches for exactly the same thing. The marker is part of the plan hash, so the
        // customer approves exactly what is reused.
        let reusedRowsForRetry = 0;
        if (platformCheck.valid && planValidation.valid && planOutput && isRetrySamePlanMessage(message) && sb && planItems.length === 1) {
          const retryJob = await findRetryableJob(sb, userId, conversationId);
          const previousItem = retryJob ? await loadQuoteFirstItem(sb, userId, retryJob.quoteId) : null;
          const candidateItem = planItems[0];
          if (
            retryJob && previousItem &&
            planParamsSignature(previousItem.capabilitySlug, previousItem.params) === planParamsSignature(candidateItem.capabilitySlug, candidateItem.params)
          ) {
            const reusable = await readReusableRows(sb, retryJob.jobId, retryJob.step, Math.max(1, Number(candidateItem.targetVolumeMax) || 1));
            if (reusable.rows.length > 0) {
              planItems = [{ ...candidateItem, params: { ...candidateItem.params, retryOfJobId: retryJob.jobId } }];
              reusedRowsForRetry = reusable.rows.length;
            }
          }
        }

        if (platformCheck.valid && planValidation.valid && planOutput) {
          if (verifiedSocialDef && planItems[0]) {
            // The goal line is written by the server so it always matches what will run.
            planOutput.summaryAr = socialPlanSummaryAr(verifiedSocialDef, planItems[0].params || {}, Number(planItems[0].targetVolumeMax) || 1, toArabicDigits, socialIntent.discover === "keyword" ? (missionByTopicSubject ?? conversationRequestText) : undefined);
          }
          currentStep = "quote_save";
          // With MULTI_PROVIDER_ENABLED on, a contact request the existing sources cannot verify is offered the multi-provider chain, only when the
          // router lists an allowed route for it; otherwise (and with the flag off) the plan below is exactly the one built above.
          const chainUpgrade = await maybeUpgradeToChainPlan({ client: this.tables, items: planItems, requestText: conversationRequestText, summaryAr: planOutput.summaryAr, methodologyNotes: planOutput.methodologyNotes });
          if (chainUpgrade.upgraded) {
            planItems = chainUpgrade.items;
            planOutput.summaryAr = chainUpgrade.summaryAr;
            planOutput.methodologyNotes = chainUpgrade.methodologyNotes;
          }
          const plannedSocialVolume = Number(planItems[0]?.targetVolumeMax) || 1;
          const tQuoteStart = Date.now();
          awaitsCount++;
          // A large plan that today's provider capacity cannot hold is REFUSED in one plain sentence (see planManager: PlanRefusalError), never clipped.
          let quoteRefusalAr: string | null = null;
          let managedQuoteOrNull: Awaited<ReturnType<typeof createAndSaveManagedQuote>> | null = null;
          try {
          managedQuoteOrNull = await createAndSaveManagedQuote(this.tables, {
            conversationId,
            userId,
            plan: {
              summaryAr: planOutput.summaryAr,
              items: planItems,
              outputFormats: selectedOutputFormats,
            methodologyNotes: isPeopleSearchRequest(conversationRequestText) && !chainUpgrade.upgraded
                ? `${planOutput.methodologyNotes || ""} سنحاول جمع البريد المهني ورقم الهاتف، ويُعرض كل حقل إذا ورد من المصادر المتاحة مع حالة التحقق التي أعادتها المصادر. لا تُحتسب السجلات التي لا تتضمن الحقلين المطلوبين.`.trim()
                : planOutput.methodologyNotes,
            },
            userBalance: userBalance ?? 0,
            capabilities: validationCaps,
            enforceScope: true,
          });
          } catch (quoteErr: any) {
            if (!(quoteErr instanceof PlanRefusalError)) throw quoteErr;
            quoteRefusalAr = quoteErr.messageAr;
          }
          if (quoteRefusalAr !== null) {
            output = { type: "refuse", reasonAr: quoteRefusalAr } as any;
            planOutput = null;
            planValidation = { valid: false, errors: [quoteRefusalAr], issues: [] };
            finalContentAr = quoteRefusalAr;
          } else {
          const managedQuote = managedQuoteOrNull!;
          tQuoteMs = Date.now() - tQuoteStart;
          quoteMs = tQuoteMs;
          quoteRpcMs += quoteMs;
          // A Facebook posts + comments plan states what it holds in ONE line written by code (the model's own line may still carry the size that was asked).
          if (managedQuote.items.length === 2 && managedQuote.items.some((it) => pairRoleOf(it as any) === "posts") && managedQuote.items.some((it) => pairRoleOf(it as any) === "comments")) {
            const pairTopic = cleanSocialTopicAr(conversationRequestText);
            if (pairTopic) {
              const pairSummary = `جمع ${planCountPartsAr(managedQuote.items)} عن «${pairTopic}» على فيسبوك`;
              managedQuote.summaryAr = pairSummary;
              planOutput.summaryAr = pairSummary;
            }
          }
          // The goal line must not promise the volume that was asked once the job cap has cut it: it states what the plan holds.
          if (verifiedSocialDef && managedQuote.items.length === 1 && managedQuote.targetVolumeMax < plannedSocialVolume) {
            const fittedSummary = socialPlanSummaryAr(verifiedSocialDef, managedQuote.items[0].params || {}, managedQuote.targetVolumeMax, toArabicDigits, socialIntent.discover === "keyword" ? (missionByTopicSubject ?? conversationRequestText) : undefined);
            managedQuote.summaryAr = fittedSummary;
            planOutput.summaryAr = fittedSummary;
          }

          planQuoteData = {
            quoteId: managedQuote.quoteId,
            planHash: managedQuote.planHash,
            summaryAr: managedQuote.summaryAr,
            items: managedQuote.items,
            targetVolumeMax: managedQuote.targetVolumeMax,
            unitPricePoints: managedQuote.unitPricePoints,
            expectedPoints: managedQuote.expectedPoints,
            quotedPoints: managedQuote.quotedPoints,
            isAffordable: managedQuote.isAffordable,
            pointsCapConstrained: managedQuote.pointsCapConstrained,
            requestedVolumeMax: managedQuote.requestedVolumeMax,
            ...(askedVolumeForCard && askedVolumeForCard > managedQuote.targetVolumeMax ? { askedVolumeMax: askedVolumeForCard } : {}),
            // The count was cut by the service's own ceiling (not the balance, not the points cap): the card says so with the number.
            ...(serviceCeilingNow && managedQuote.items.length === 1 && managedQuote.targetVolumeMax === serviceCeilingNow && !managedQuote.pointsCapConstrained ? { serviceCeilingUnits: serviceCeilingNow } : {}),
            pointsCap: managedQuote.pointsCap,
            userBalance,
            downscaledOffer: managedQuote.downscaledOffer,
            capacityConstrained: managedQuote.capacityConstrained,
            outputFormats: managedQuote.outputFormats,
            expiresAt: managedQuote.expiresAt,
            methodologyNotes: isPeopleSearchRequest(conversationRequestText) && !chainUpgrade.upgraded
              ? `${planOutput.methodologyNotes || ""} ${CONTACT_EXPECTATION_AR} ${CONTACT_BILLING_NOTE_AR}`.trim()
              : planOutput.methodologyNotes,
          };

          // The retry button asks for a NEW offer of the same plan: the card says so (and how many collected records it starts from).
          if (isRetrySamePlanMessage(message)) planQuoteData.retryOffer = { reusedRows: reusedRowsForRetry };
          // The same plan as a recent completed request of this customer: said before the approve button, with the way to the old result. Read only.
          if (sb) {
            const duplicate = await findRecentDuplicateRequest(sb, { userId, planHash: managedQuote.planHash, excludeQuoteId: managedQuote.quoteId });
            if (duplicate) planQuoteData.duplicateOf = duplicate;
          }
          // Why the price or the title differs from the plan this conversation priced just before (one sentence, from code, before the approve button).
          const changeNote = planChangeNoteAr(previousPlanQuoteOf(messagesContext), planQuoteData);
          if (changeNote) planQuoteData.changeNoteAr = changeNote;

          // What the assistant understood and the window the plan applies: shown at the top of the plan in the panel.
          const planMission = understandMission(conversationRequestText);
          const planUnderstood = understoodLineAr(planMission);
          if (planUnderstood) planQuoteData.understoodAr = planUnderstood;
          // How long the mission will take: a range computed by code from the plan's own numbers (records, records per call, dependent
          // steps) and the measured chunk times of finished jobs, never decided by the model. It carries no money value.
          try {
            const measuredTimings = sb ? await loadMeasuredTimings(sb) : undefined;
            const durationView = missionDurationForPlan(managedQuote.items as any[], longJobDriverMode(), measuredTimings);
            if (durationView) planQuoteData.duration = durationView;
          } catch (durationErr: any) {
            console.warn("[chat:duration_estimate_skipped]", durationErr?.message || "");
          }
          const planWindowNow = windowOrProposedDefault(planMission.window);
          if (planWindowNow.status === "resolved" && managedQuote.items[0]?.params?.dateFrom) {
            planQuoteData.window = {
              labelAr: planWindowNow.labelAr,
              source: planWindowNow.source,
              ...(planWindowNow.reasonAr ? { reasonAr: planWindowNow.reasonAr } : {}),
              ...(planWindowNow.noteAr ? { noteAr: planWindowNow.noteAr } : {}),
            };
            // YouTube shows when a comment or a video was published only as «منذ ٣ أسابيع»: the plan says the window is applied approximately.
            if (verifiedSocialDef?.platform === "youtube" && verifiedSocialDef.kind === "comments") {
              planQuoteData.window.noteAr = [planQuoteData.window.noteAr, "تواريخ يوتيوب تقريبية (مثل «منذ ٣ أسابيع»)، لذلك تُطبَّق الفترة عليها بشكل تقريبي."].filter(Boolean).join(" ");
            }
            // A topic search on YouTube can be told to prefer recent uploads, but only within the last year: an older window is said plainly.
            const planItemParams = managedQuote.items[0]?.params || {};
            if (verifiedSocialDef?.platform === "youtube" && typeof planItemParams.query === "string" && planItemParams.query.trim()
              && !youtubeRecencyFor(planItemParams.dateFrom, planItemParams.dateTo, Date.now())) {
              planQuoteData.window.noteAr = [planQuoteData.window.noteAr, YOUTUBE_OLD_WINDOW_NOTE_AR].filter(Boolean).join(" ");
            } else if (verifiedSocialDef?.platform === "youtube" && typeof planItemParams.query === "string" && planItemParams.query.trim()
              && Number(managedQuote.targetVolumeMax) >= YOUTUBE_RECENT_SUPPLY_FROM_VOLUME) {
              planQuoteData.window.noteAr = [planQuoteData.window.noteAr, YOUTUBE_RECENT_SUPPLY_NOTE_AR].filter(Boolean).join(" ");
            }
          }

          // Last guard: an English sector name («Construction», «Information Technology & Services») never reaches the customer; it is read as its Arabic name.
          planOutput.summaryAr = localizeSectorNamesInText(scrubPlaceholderPhrases(String(planOutput.summaryAr || "")));
          managedQuote.summaryAr = localizeSectorNamesInText(scrubPlaceholderPhrases(String(managedQuote.summaryAr || "")));
          // A social plan counts what it collects in its own words (comments, posts), not in «records».
          const planUnitWord = verifiedSocialDef?.kind === "comments" ? "تعليق" : verifiedSocialDef?.kind === "posts" ? "منشور" : "سجل";
          let planSummaryText = `أعددت لك خطة الاستخراج وعرض السعر بالنقاط:\n- الهدف: ${planOutput.summaryAr}\n- الحد الأقصى: ${managedQuote.items.length > 1 ? planCountLineAr(managedQuote.items, managedQuote.targetVolumeMax) : `حتى ${toArabicDigits(managedQuote.targetVolumeMax)} ${planUnitWord}`}\n- التكلفة المتوقعة: ${pointsAr(managedQuote.expectedPoints, toArabicDigits)}`;
          // The price of one record is on every plan: one service says it plainly, several say it for each.
          const priceLine = unitPriceLineAr(managedQuote.items, managedQuote.unitPricePoints, customerFacingCapabilityLabel);
          if (priceLine) planSummaryText += `\n- ${priceLine}`;
          if (managedQuote.items.length === 1) {
            const explanation = planExplanationLinesAr({
              capabilitySlug: managedQuote.items[0]?.capabilitySlug,
              outputFormats: managedQuote.outputFormats,
              targetVolumeMax: managedQuote.targetVolumeMax,
              unitPricePoints: managedQuote.unitPricePoints,
              expectedPoints: managedQuote.expectedPoints,
              quotedPoints: managedQuote.quotedPoints,
              countStated: Boolean(extractNumberFromText(conversationRequestText)),
            });
            planSummaryText += `\n- ${explanation.join("\n- ")}`;
            // The proposed sample size of a plan with no count of the customer's is a default on the card too, in the plan's own word.
            if (!verifiedSocialDef && !extractNumberFromText(conversationRequestText)) {
              const slug = String(managedQuote.items[0]?.capabilitySlug || "");
              planQuoteData.defaultCap = { noun: /comment/i.test(slug) ? "comments" : /video|tiktok|youtube/i.test(slug) ? "videos" : "records", units: managedQuote.targetVolumeMax, wordAr: recordNounAr(slug) };
            }
          }
          const unsupportedNote = unsupportedConstraintsNoteAr(extractRequestIntent(conversationRequestText));
          if (unsupportedNote) planSummaryText += `\n- ${unsupportedNote}`;
          const planCoverage = assessCoverage(conversationRequestText);
          if (planCoverage.status === "partly" && planCoverage.unsupported.length > 0) {
            planSummaryText += `\n- ${partlyNoteAr(planCoverage)}`;
            planQuoteData.partsAr = [
              { labelAr: customerFacingCapabilityLabel(managedQuote.items[0]?.capabilitySlug), included: true },
              ...planCoverage.unsupported.map((id) => ({ labelAr: familyById(id).titleAr, included: false, reasonAr: "لا نبيع هذا النوع من البيانات حاليًا" })),
            ];
          }
          // A feed plan states its window and why (a known event), and any date it corrected: the customer sees what will be applied.
          const missionWindow = windowOrProposedDefault(understandMission(conversationRequestText).window);
          if (missionWindow.status === "resolved" && managedQuote.items[0]?.params?.dateFrom) {
            planSummaryText += `\n- الفترة الزمنية: ${missionWindow.labelAr}${missionWindow.reasonAr ? ` — ${missionWindow.reasonAr}` : ""}`;
            if (missionWindow.noteAr) planSummaryText += `\n- ملاحظة: ${missionWindow.noteAr}`;
          }
          // A mission over channels says plainly what it covers when that differs from the template (fewer channels, a topic instead, a lower top).
          const coverageLines = missionCoverageLinesAr(planMission, {
            channels: Array.isArray(managedQuote.items[0]?.params?.channels) ? managedQuote.items[0].params.channels : [],
            topPerChannel: managedQuote.items[0]?.params?.topPerChannel ?? null,
            maxChannels: MAX_CHANNELS_PER_JOB,
          });
          // The Facebook keyword card: its comments come from a sample of the newest posts, and the amount is for what is delivered (one line, text only).
          if (managedQuote.items.length === 1 && managedQuote.items[0]?.capabilitySlug === FACEBOOK_KEYWORD_SLUG_FOR_CARD) coverageLines.push(FACEBOOK_KEYWORD_SAMPLE_LINE_AR);
          // The service reads at least a few comments from each post (its price assumes it): fewer asked is said, with the posts the plan covers instead.
          if (perPostRaisedNow && verifiedSocialDef?.minPerVideo && managedQuote.items.length === 1) {
            const planned = postsForVolume({ videoCount: perPostRaisedNow.posts ?? undefined, perVideo: managedQuote.items[0]?.params?.perVideo }, managedQuote.targetVolumeMax);
            coverageLines.push(`تُقرأ ${toArabicDigits(verifiedSocialDef.minPerVideo)} تعليقات على الأقل من كل منشور${planned && perPostRaisedNow.posts && planned !== perPostRaisedNow.posts ? `؛ لذلك تشمل الخطة ${videosCountAr(planned, "posts")} بدل ${videosCountAr(perPostRaisedNow.posts, "posts")}، مع الإبقاء على عدد التعليقات الذي طلبته` : ""}.`);
          }
          for (const line of coverageLines) planSummaryText += `\n- ${line}`;
          // The plan card shows the same sentences (fewer channels than the template said, a lower top, videos found by a topic).
          if (coverageLines.length > 0) planQuoteData.coverageLinesAr = coverageLines;
          // Videos and comments are two quantities: the plan names both, so «٣ فيديوهات» can never read as three comments.
          if (videosStatedForPlan && managedQuote.items.length === 1) {
            planSummaryText += `\n- ${videosStatedForPlan.noun === "posts" ? "المنشورات" : "الفيديوهات"}: ${videosCountAr((verifiedSocialDef?.pagedDiscovery || verifiedSocialDef?.topicReport) ? postsForVolume({ videoCount: videosStatedForPlan.count, perVideo: managedQuote.items[0]?.params?.perVideo }, managedQuote.targetVolumeMax) || videosStatedForPlan.count : videosStatedForPlan.count, videosStatedForPlan.noun)}، والتعليقات: حتى ${toArabicDigits(managedQuote.targetVolumeMax)} تعليق من كل ما فيها.`;
          }
          // A count the customer left open is a visible default on the plan, never a hidden number.
          const defaultCapNow = defaultCapUsed && managedQuote.items.length === 1 ? defaultCapUsed : null;
          // The plan card shows the same default sentence (never «you asked for»): it reads this field, not the count alone.
          if (defaultCapNow) planQuoteData.defaultCap = { noun: defaultCapNow.noun, units: defaultCapNow.units };
          if (defaultCapNow) {
            planSummaryText += `\n- ${defaultCapLineAr(defaultCapNow.noun, defaultCapNow.units)}`;
            // A default is not something the customer asked for: when the job cuts it, the plan says what it holds, never «you asked for».
            if (managedQuote.targetVolumeMax < defaultCapNow.units) {
              planSummaryText += ` ${defaultCapFittedLineAr({ noun: defaultCapNow.noun, fittedUnits: managedQuote.targetVolumeMax, quotedPoints: managedQuote.quotedPoints, pointsCap: managedQuote.pointsCap || effectiveJobPointsCap() })}`;
            }
          }
          // Never shrink silently: what was asked, what fits one job now, and why (also when only a service ceiling cut it).
          const askedUnitsForText = Math.max(askedVolumeForCard ?? 0, managedQuote.requestedVolumeMax || 0, managedQuote.targetVolumeMax);
          const volumeLimitLine = managedQuote.items.length === 1 && !defaultCapNow
            ? volumeLimitStatementAr({
                askedUnits: askedUnitsForText,
                fittedUnits: managedQuote.targetVolumeMax,
                // The count was cut by the live extraction capacity, not by the points cap: say so, and say what is held back.
                ...(managedQuote.capacityConstrained && !managedQuote.pointsCapConstrained ? { reason: "capacity" as const, reservedPoints: managedQuote.quotedPoints } : {}),
                // The service's own ceiling cut it: not the job cap, not the balance. Say which, with the number that fits.
                ...(planQuoteData.serviceCeilingUnits && !managedQuote.capacityConstrained ? { reason: "service" as const, unitLabelAr: /-comments$/.test(String(managedQuote.items[0]?.capabilitySlug)) ? "تعليق" : verifiedSocialDef?.kind === "videos" ? "منشور" : undefined } : {}),
                ...(reachCutNow && !managedQuote.capacityConstrained && !managedQuote.pointsCapConstrained && managedQuote.targetVolumeMax === reachCutNow.units ? { reason: "reach" as const, reachDetailAr: reachCutNow.detailAr, unitLabelAr: "تعليق" } : {}),
              })
            : null;
          if (volumeLimitLine) {
            planSummaryText += `\n- ${volumeLimitLine}`;
            planQuoteData.volumeLimitLineAr = volumeLimitLine;
          }
          // A posts + comments plan that was reduced to fit says so once, with both sizes: the same sentence on the card.
          if (managedQuote.fit) {
            planSummaryText += `\n- ${managedQuote.fit.noticeAr}`;
            planQuoteData.volumeLimitLineAr = managedQuote.fit.noticeAr;
          }
          if (managedQuote.pointsCapConstrained && !defaultCapNow && !managedQuote.fit) {
            const requestedUnits = askedUnitsForText;
            // When the request was cut to fit the cap, say plainly how many records fit and what the whole request needed.
            const capStatement = managedQuote.items.length === 1
              ? capStatementAr({
                  requestedUnits,
                  fittedUnits: managedQuote.targetVolumeMax,
                  unitPricePoints: managedQuote.unitPricePoints,
                  pointsCap: managedQuote.pointsCap || effectiveJobPointsCap(),
                  safetyBuffer: DEFAULT_PRICING_SETTINGS.safetyBuffer,
                  quotedPoints: managedQuote.quotedPoints,
                })
              : null;
            planSummaryText += capStatement
              ? `\n- ${capStatement}`
              : managedQuote.targetVolumeMax < requestedUnits
              ? `\n- تم ضبط ${managedQuote.items.length > 1 ? `الطلب إلى ${planCountPartsAr(managedQuote.items)}` : `العدد من ${toArabicDigits(requestedUnits)} إلى ${toArabicDigits(managedQuote.targetVolumeMax)} سجل`} حتى يظل السعر والحجز مع احتياطي التنفيذ ضمن سقف ${pointsAr(managedQuote.pointsCap || effectiveJobPointsCap(), toArabicDigits)}. يمكنك تقليل العدد أكثر إذا أردت.`
              : `\n- العدد المطلوب ${toArabicDigits(managedQuote.targetVolumeMax)} أشخاص يناسب سقف السعر. تم تحديد الحجز عند ${pointsAr(managedQuote.quotedPoints, toArabicDigits)}، ويشمل احتياطي التنفيذ ضمن سقف ${pointsAr(managedQuote.pointsCap || effectiveJobPointsCap(), toArabicDigits)}.`;
          }
          // Large or vague social plans: offer a small priced sample first. Code prices it; the model writes nothing here.
          const explorationCandidate = isExplorationCandidate({
            items: managedQuote.items,
            targetVolumeMax: managedQuote.targetVolumeMax,
            unitPricePoints: managedQuote.unitPricePoints,
            quotedPoints: managedQuote.quotedPoints,
            pointsCapConstrained: managedQuote.pointsCapConstrained,
            requestedVolumeMax: managedQuote.requestedVolumeMax,
          });
          if (explorationCandidate) {
            const offer = explorationOffer(managedQuote);
            planQuoteData.explorationOffer = offer;
            planSummaryText += `\n- ${explorationOfferLineAr(offer)}`;
          }
          if (brief.exclusionFile) {
            planSummaryText += `\n- ملف الاستبعاد المعتمد: تم التحقق من "${brief.exclusionFile.name}" واستبعاد ${toArabicDigits(brief.exclusionFile.baselineRowCount)} شركة مسجلة مسبقاً لمنع تكرارها.`;
          }
          if (isPeopleSearchRequest(conversationRequestText)) {
            planSummaryText += `\n- بيانات التواصل المتوقعة: ${CONTACT_EXPECTATION_AR}\n- ${CONTACT_BILLING_NOTE_AR}`;
          }
          if (reusedRowsForRetry > 0) {
            planSummaryText += `\n- إعادة استخدام: ${toArabicDigits(reusedRowsForRetry)} سجل جُمعت في المحاولة السابقة تُضاف إلى النتيجة، ويُجلب المتبقي فقط. السعر المعروض يغطي كامل العدد المطلوب، ولا يُخصم إلا ثمن السجلات المسلّمة فعلاً.`;
          }
          if (managedQuote.capacityConstrained) {
            planSummaryText += `\n- سبب الحد: ${CAPACITY_LIMITED_REASON_AR}`;
          }
          // The verdict on the balance, before approval: «يكفي رصيدك» or «رصيدك لا يكفي، أقصى عدد يتسع X». Code writes it from the quote.
          const balanceVerdict = balanceVerdictAr({
            balance: userBalance ?? 0,
            quotedPoints: managedQuote.quotedPoints,
            expectedPoints: managedQuote.expectedPoints,
            targetVolumeMax: managedQuote.targetVolumeMax,
            downscaledOffer: managedQuote.downscaledOffer,
          });
          planQuoteData.balanceVerdictAr = balanceVerdict;
          planSummaryText += `\n- الرصيد: ${balanceVerdict}`;
          if (!managedQuote.isAffordable) {
            // Low balance: the offer (reduce to what fits, or top up and continue here) is written by code from the quote.
            const lowBalanceText = lowBalanceMessageAr({
              balance: userBalance ?? 0,
              quotedPoints: managedQuote.quotedPoints,
              expectedPoints: managedQuote.expectedPoints,
              targetVolumeMax: managedQuote.targetVolumeMax,
              downscaledOffer: managedQuote.downscaledOffer,
            });
            if (lowBalanceText) planSummaryText += `\n- تنبيه الرصيد: ${lowBalanceText}`;
          }
          // The plan response is pre-approval. Keep it entirely server-authored so
          // free-form model text cannot claim that collection has already started.
          finalContentAr = planSummaryText;
          }
        }
      } else if (output.type === "edit_plan") {
        let activeQuote: any = null;
        try {
          if (sb) {
            const { data: q } = await sb
              .from("plans_quotes")
              .select("*")
              .eq("user_id", userId)
              .eq("status", "quoted")
              .order("created_at", { ascending: false })
              .limit(1)
              .maybeSingle();
            if (q) {
              activeQuote = {
                ...q,
                summaryAr: q.summary_ar || "خطة استخراج بيانات",
                itemsJson: q.items,
              };
            }
          } else {
            const quoteRes = await this.tables.listRows({
              databaseId: "digr",
              tableId: "plans_quotes",
              queries: [
                Query.equal("conversationId", conversationId),
                Query.equal("status", "proposed"),
                Query.orderDesc("createdAt"),
                Query.limit(1),
              ],
            });
            if (quoteRes.rows.length > 0) {
              activeQuote = quoteRes.rows[0];
            }
          }
        } catch (err) {
          console.warn("Error finding active quote for edit:", err);
        }

        if (!activeQuote) {
          finalContentAr = "لا توجد خطة معلقة حالياً لتعديلها. يرجى وصف بيانات الاستخراج المطلوبة لنعد لك خطة جديدة.";
        } else {
          try {
            const currentItems = typeof activeQuote.itemsJson === "string"
              ? JSON.parse(activeQuote.itemsJson)
              : activeQuote.itemsJson;

            const currentPlan: PlanState = {
              summaryAr: activeQuote.summaryAr,
              items: currentItems,
              outputFormats: ["xlsx", "pdf", "csv"],
            };

            const updatedPlan = applyPlanOperations(currentPlan, output.operations);
            const validation = validatePlanAgainstSchemas(updatedPlan.items, capabilities);
            if (!validation.valid) {
              finalContentAr = `تعذر تطبيق التعديل المطلوب: ${validation.errors.join(", ")}`;
            } else {
              currentStep = "quote_save";
              const tQuoteEditStart = Date.now();
              awaitsCount++;
              const managedQuote = await createAndSaveManagedQuote(this.tables, {
                conversationId,
                userId,
                plan: updatedPlan,
                userBalance: userBalance ?? 0,
                capabilities: allCapabilities,
                enforceScope: true,
              });
              const qEditDelta = Date.now() - tQuoteEditStart;
              quoteRpcMs += qEditDelta;
              quoteMs += qEditDelta;
              tQuoteMs = quoteMs;

              planQuoteData = {
                quoteId: managedQuote.quoteId,
                planHash: managedQuote.planHash,
                summaryAr: managedQuote.summaryAr,
                items: managedQuote.items,
                targetVolumeMax: managedQuote.targetVolumeMax,
                unitPricePoints: managedQuote.unitPricePoints,
                expectedPoints: managedQuote.expectedPoints,
                quotedPoints: managedQuote.quotedPoints,
                isAffordable: managedQuote.isAffordable,
              pointsCapConstrained: managedQuote.pointsCapConstrained,
              requestedVolumeMax: managedQuote.requestedVolumeMax,
              pointsCap: managedQuote.pointsCap,
                userBalance,
                downscaledOffer: managedQuote.downscaledOffer,
                capacityConstrained: managedQuote.capacityConstrained,
                outputFormats: managedQuote.outputFormats,
                expiresAt: managedQuote.expiresAt,
              };

              finalContentAr = `تم تعديل الخطة وتحديث عرض السعر بالنقاط:\n• الهدف: ${managedQuote.summaryAr}\n• الحد الأقصى: حتى ${toArabicDigits(managedQuote.targetVolumeMax)} سجل\n• التكلفة المتوقعة: ${pointsAr(managedQuote.expectedPoints, toArabicDigits)}`;
          if (managedQuote.pointsCapConstrained) {
            finalContentAr += `\n• تم ضبط العدد من ${toArabicDigits(managedQuote.requestedVolumeMax || managedQuote.targetVolumeMax)} إلى ${toArabicDigits(managedQuote.targetVolumeMax)} سجل حتى يظل السعر والحجز ضمن سقف ${pointsAr(managedQuote.pointsCap || effectiveJobPointsCap(), toArabicDigits)}. يمكنك تقليل العدد أكثر إذا أردت.`;
          }
              if (managedQuote.capacityConstrained) {
                finalContentAr += `\n• سبب الحد: ${CAPACITY_LIMITED_REASON_AR}`;
              }
              finalContentAr += `\n• الرصيد: ${balanceVerdictAr({
                balance: userBalance ?? 0,
                quotedPoints: managedQuote.quotedPoints,
                expectedPoints: managedQuote.expectedPoints,
                targetVolumeMax: managedQuote.targetVolumeMax,
                downscaledOffer: managedQuote.downscaledOffer,
              })}`;
              if (!managedQuote.isAffordable) {
                const lowBalanceText = lowBalanceMessageAr({
                  balance: userBalance ?? 0,
                  quotedPoints: managedQuote.quotedPoints,
                  expectedPoints: managedQuote.expectedPoints,
                  targetVolumeMax: managedQuote.targetVolumeMax,
                  downscaledOffer: managedQuote.downscaledOffer,
                });
                if (lowBalanceText) finalContentAr += `\n• تنبيه الرصيد: ${lowBalanceText}`;
              }
            }
          } catch (editErr: any) {
            finalContentAr = `تعذر تطبيق التعديل: ${editErr.message || "خطأ في مدخلات التعديل"}`;
          }
        }
      } else if (output.type === "suggest_alternative") {
        // Ensure we never name a different platform than the one the user asked for
        const mentioned = detectMentionedPlatforms(message);
        if (mentioned.length > 0) {
          const expectedLabel = getPlatformLabelAr(mentioned[0]);
          const mentionedOutputPlatforms = detectMentionedPlatforms(output.unsupportedService);
          if (mentionedOutputPlatforms.length > 0 && !mentionedOutputPlatforms.includes(mentioned[0])) {
            output.unsupportedService = expectedLabel;
          }
        }
        console.warn("[chat:suggest_alternative]", {
          unsupportedService: output.unsupportedService,
          explanationAr: output.explanationAr,
        });
        // The generic sentence is only for a request with no topic at all. When the customer gave a topic (and maybe a
        // country) the answer is ONE specific question that names them and offers the sources that exist.
        const gathered = detectTopicGathering(conversationRequestText);
        const topicHint = (gathered?.topic || researchIntent.topic.value || brief.topics[0] || "").toString().trim();
        if (topicHint.length >= 2 && !input.isGuest && !hasTopicResearchService(capabilities)) {
          const sourceQuestion = topicSourceQuestion({
            noun: gathered?.noun || "البيانات",
            topic: topicHint,
            countryAr: detectCountryFromText(conversationRequestText)?.arabicLabel,
          });
          clarificationItemsList = [sourceQuestion as any];
          clarificationQuestionsList = [sourceQuestion.text];
          finalContentAr = consultantIntroAr(conversationRequestText, undefined);
          output = { type: "ask_clarification", reasonAr: finalContentAr, intro: finalContentAr, questions: clarificationItemsList, questionsAr: clarificationQuestionsList } as any;
        } else {
          finalContentAr = "اكتب الموضوع أو أرسل رابط المصدر الذي تريد جمع بياناته، وسأجهز خطة تناسب طلبك.";
        }

        // Log request in capability_requests table
        awaitsCount++;
        const tCapReqStart = Date.now();
        if (sb) {
          await sb.from("capability_requests").insert({
            id: ID.unique(),
            user_id: userId,
            query: `${output.unsupportedService || ""}: ${message}`,
            created_at: new Date().toISOString(),
          });
        } else {
          await this.tables.createRow({
            databaseId: "digr",
            tableId: "capability_requests",
            rowId: ID.unique(),
            data: {
              userId,
              queryAr: message,
              platform: output.unsupportedService,
              createdAt: new Date().toISOString(),
            },
          });
        }
        writesMs += Date.now() - tCapReqStart;
      } else if (output.type === "refuse") {
        finalContentAr = output.reasonAr;
      } else if (output.type === "shape_file") {
        // How an existing result file should look. Free: built from the saved data, no collection, no charge. The
        // model's spec is re-validated here (strict schema) and again against the real columns when it is downloaded.
        const parsedSpec = FileSpecSchema.safeParse((output as any).spec);
        if (!parsedSpec.success) {
          finalContentAr = "لم أفهم الشكل المطلوب للملف تمامًا. وضّح لي مثلًا: شيت منفصل لكل محافظة، أو ترتيب حسب التاريخ، أو الأعمدة التي تريدها فقط.";
        } else {
          const hintColumns = shapingColumns;
          const descriptionAr = describeFileSpecAr(parsedSpec.data, hintColumns);
          // The job the file is made from travels with it, so a reloaded page can offer the download without restoring anything else.
          let shapedJobId: string | null = deliveredResultJobId;
          if (!shapedJobId && sb) {
            awaitsCount++;
            shapedJobId = (await latestDeliveredJob(sb, { conversationId, userId }))?.id ?? null;
          }
          fileShapeData = { spec: parsedSpec.data, descriptionAr, ...(shapedJobId ? { jobId: shapedJobId } : {}) };
          finalContentAr = `جهزت لك الملف بالشكل المطلوب: ${descriptionAr}. اضغط «تحميل الملف المخصص» أدناه. لا يُخصم أي رصيد لأن الملف يُبنى من بياناتك المحفوظة دون جمع جديد.${shapeIgnoredNames.length ? ` لم أجد في ملفك: ${shapeIgnoredNames.map((name) => `«${name}»`).join("، ")} فتجاهلتها.` : ""}`;
        }
      } else if (output.type === "edit_artifact") {
        // The paid revision service is not offered: no price, no card. Shaping the file is free and is answered above.
        finalContentAr = REVISION_UNAVAILABLE_AR;
        output = { type: "answer_question", answerAr: REVISION_UNAVAILABLE_AR } as any;
      }

      // 9. Update Assistant Message to 'ready'
      currentStep = "assistant_message_save";
      finalContentAr = stripMissingValueWords(scrubAssistantIdentity(deduplicateIntroText(finalContentAr)));
      const tSbMsgUpdateStart = Date.now();
      awaitsCount++;
      if (sb) {
        const { error: msgUpdateErr } = await sb
          .from("messages")
          .update({
            content_ar: finalContentAr,
            clarification_items: clarificationItemsList ?? null,
            // A custom file is kept with its message (no new column): the download action survives a reload.
            plan: planQuoteData ? { items: planQuoteData.items, summaryAr: planQuoteData.summaryAr } : fileShapeData ? { fileShape: fileShapeData } : null,
            quote: planQuoteData ?? null,
          })
          .eq("id", assistantMsgId);
        if (msgUpdateErr) throw msgUpdateErr;
      } else {
        await this.tables.updateRow({
          databaseId: "digr",
          tableId: "messages",
          rowId: assistantMsgId,
          data: {
            content: finalContentAr,
            status: "ready",
            promptVersion: llmResult.promptVersion || "2.0.0",
            ...(planQuoteData ? { planQuoteId: planQuoteData.quoteId } : {}),
            ...(fileShapeData ? { plan: { fileShape: fileShapeData } } : {}),
          },
        });
      }
      const msgUpdateDuration = Date.now() - tSbMsgUpdateStart;
      supabaseMs += msgUpdateDuration;
      writesMs += msgUpdateDuration;

      // Keep planning attempts in the request history even when no quote/job
      // was created. This write is best-effort so history cannot block replies.
      const requestStatus = resolveRequestAttemptStatus({
        intent: isGreeting || isGeneralQuestion ? "chat" : "research",
        outputType: output.type,
        hasQuote: Boolean(planQuoteData?.quoteId),
      });
      try {
        awaitsCount++;
        const tReqStatusStart = Date.now();
        if (sb) {
          const { error: requestStatusError } = await sb
            .from("messages")
            .update({
              request_status: requestStatus,
              request_error: output.type === "refuse" ? sanitizeCustomerErrorMessage(output.reasonAr) : null,
              request_quote_id: planQuoteData?.quoteId || null,
            })
            .eq("id", userMsgId)
            .eq("user_id", userId);
          if (requestStatusError) throw requestStatusError;
        } else {
          await this.tables.updateRow({
            databaseId: "digr",
            tableId: "messages",
            rowId: userMsgId,
            data: {
              requestStatus,
              requestError: output.type === "refuse" ? sanitizeCustomerErrorMessage(output.reasonAr) : undefined,
              requestQuoteId: planQuoteData?.quoteId || undefined,
            },
          });
        }
        writesMs += Date.now() - tReqStatusStart;
      } catch (requestStatusError: any) {
        console.warn("[chat:request_history_update_failed]", requestStatusError?.message || "unknown_error");
      }

      // 10. Record Token Usage & Stats in llm_usage (Server-only).
      // Logging must never block the reply: failures are swallowed.
      currentStep = "usage_log";
      const tSbLogStart = Date.now();
      try {
        awaitsCount++;
        const tUsageStart = Date.now();
        noteLocalLlmSpend(Number(turnUsage.costUsd.toFixed(6)));
        if (sb) {
          await sb.from("llm_usage").insert({
            user_id: userId,
            tokens_in: turnUsage.inputTokens,
            tokens_out: turnUsage.outputTokens,
            model: llmResult.model,
            latency_ms: Math.max(0, Date.now() - tLlmStart),
            // A provider-error refusal carries its short code (for example refuse:timeout); never shown to the customer.
            reason: output.type === "refuse" && llmResult.fallbackCode ? `refuse:${llmResult.fallbackCode}` : output.type,
            cost_usd: Number(turnUsage.costUsd.toFixed(6)),
            created_at: new Date().toISOString(),
          });
        } else {
          await this.tables.createRow({
            databaseId: "digr",
            tableId: "llm_usage",
            rowId: ID.unique(),
            data: {
              conversationId,
              userId,
              messageId: assistantMsgId,
              model: llmResult.model,
              inputTokens: turnUsage.inputTokens,
              outputTokens: turnUsage.outputTokens,
              costUsd: Number(turnUsage.costUsd.toFixed(6)),
              createdAt: new Date().toISOString(),
            },
          });
        }
        turn.written = true;
        writesMs += Date.now() - tUsageStart;
      } catch (usageErr) {
        console.warn("[llm:USAGE_LOG_FAILED]", (usageErr as any)?.message || usageErr);
      }
      awaitsCount++;
      const tCostStart = Date.now();
      await logProviderCost(this.tables, {
        provider: "llm",
        units: turnUsage.inputTokens + turnUsage.outputTokens,
        costUsd: turnUsage.costUsd,
      });
      writesMs += Date.now() - tCostStart;

      // 11. Update Conversation Stats
      currentStep = "conversation_update";
      const rawTitle = typeof (llmResult.output as any)?.conversationTitle === "string"
        ? (llmResult.output as any).conversationTitle
        : typeof (llmResult.output as any)?.summaryAr === "string"
          ? (llmResult.output as any).summaryAr
          : "";
      const generatedTitle = customerFacingConversationTitle(rawTitle).replace(/[\n\r]+/g, " ").trim();
      const conversationTitle = generatedTitle && generatedTitle !== "محادثة جديدة"
        ? generatedTitle
        : currentConversationTitle;
      const newTotalTokens = totalConvTokens + llmResult.inputTokens + llmResult.outputTokens;
      awaitsCount++;
      const tConvUpdStart = Date.now();
      if (sb) {
        const { error: convUpdateErr } = await sb
          .from("conversations")
          .update({
            updated_at: new Date().toISOString(),
            ...(conversationTitle !== "محادثة جديدة" ? { title: conversationTitle } : {}),
          })
          .eq("id", conversationId);
        if (convUpdateErr) throw convUpdateErr;
      } else {
        await this.tables.updateRow({
          databaseId: "digr",
          tableId: "conversations",
          rowId: conversationId,
          data: {
            totalTokens: newTotalTokens,
            costUsd: Number(llmResult.costUsd.toFixed(6)),
            updatedAt: new Date().toISOString(),
            ...(conversationTitle !== "محادثة جديدة" ? { title: conversationTitle } : {}),
          },
        });
      }
      const convUpdDuration = Date.now() - tConvUpdStart;
      supabaseMs += convUpdDuration;
      writesMs += convUpdDuration;

      const totalLatencyMs = Date.now() - turnStartTime;
      const stepTimings = {
        auth: authMs,
        authMs,
        rateLimit: rateLimitMs,
        rateLimitMs,
        conversation: conversationMs,
        conversationMs,
        briefSaves: briefSavesMs,
        briefSavesMs,
        brief: briefSavesMs,
        briefMs: briefSavesMs,
        history: historyMs,
        historyMs,
        catalog: catalogMs,
        catalogMs,
        quoteRpc: quoteRpcMs,
        quoteRpcMs,
        quote: quoteMs,
        quoteMs,
        writes: writesMs,
        writesMs,
        awaitsCount,
        supabaseMs,
        llmMs,
        totalMs: totalLatencyMs,
        tExtractMs,
        tCatalogSearchMs: catalogMs,
        tPlanLlmMs: llmMs,
        tQuoteMs: quoteMs,
      };

      console.info(JSON.stringify({ tag: "chat_stage_timings", ...stepTimings, awaitsCount }));
      console.log("[chat:turn_breakdown]", {
        supabaseMs,
        catalogMs,
        llmMs,
        quoteMs,
        totalMs: totalLatencyMs,
      });
      console.log(
        `[chat:turn] conversationId=${conversationId} messageId=${assistantMsgId} modelCalls=${modelCallCount} catalogSearches=${catalogSearchCount} latencyMs=${totalLatencyMs}`,
      );
      console.log("[chat:step_timings]", stepTimings);

      const computedIntent: "chat" | "research" =
        (output as any).intent ||
        (isGreeting || (isGeneralQuestion && !(isFileShapingTurn && output.type === "ask_clarification"))
          ? "chat"
          : output.type === "propose_plan" ||
            output.type === "ask_clarification" ||
            output.type === "ask_questions" ||
            output.type === "edit_plan"
          ? "research"
          : output.type === "answer_question" || output.type === "shape_file"
          ? "chat"
          : "research");

      if (computedIntent === "chat") {
        planQuoteData = undefined;
        clarificationQuestionsList = undefined;
        clarificationItemsList = undefined;
      }

      // Ask one question per turn so the next clarification can be chosen from
      // the customer's latest answer instead of presenting a fixed questionnaire.
      if (clarificationItemsList?.length) {
        clarificationItemsList = clarificationItemsList.slice(0, 1);
        clarificationQuestionsList = clarificationItemsList.map((item) => item.text);
        // The period question always carries its plain warning about long periods.
        // The intro of the ONE question says what was understood; a form-style intro (a colon and a list, «محتاج أعرف») never reaches the customer.
        if (clarificationItemsList[0]?.id === "social_time_required" || isFormStyleIntro(finalContentAr)) {
          finalContentAr = consultantIntroAr(conversationRequestText, clarificationItemsList[0]?.id);
        }
      } else if (clarificationQuestionsList?.length) {
        clarificationQuestionsList = clarificationQuestionsList.slice(0, 1);
      }

      return {
        conversationId,
        conversationTitle,
        messageId: assistantMsgId,
        role: "assistant",
        contentAr: finalContentAr,
        outputType: computedIntent === "chat" ? "answer_question" : output.type,
        intent: computedIntent,
        planQuote: planQuoteData,
        revisionQuote: revisionQuoteData,
        fileShape: fileShapeData,
        clarificationQuestions: clarificationQuestionsList,
        clarificationItems: clarificationItemsList,
        clarificationIntro: clarificationItemsList?.length ? finalContentAr : undefined,
        suggestedAlternative: output.type === "suggest_alternative" ? output : undefined,
        refusalReason: output.type === "refuse" ? output.reasonAr : undefined,
        tokensUsed: {
          input: llmResult.inputTokens,
          output: llmResult.outputTokens,
          costUsd: llmResult.costUsd,
        },
        turnStats: {
          modelCalls: modelCallCount,
          catalogSearches: catalogSearchCount,
          latencyMs: totalLatencyMs,
          stepTimings,
        },
      };
    } catch (err: any) {
      if (err && typeof err === "object" && !err.chatStep) {
        err.chatStep = currentStep;
      }
      const safeReason = toSafeReasonCode(err, currentStep);
      console.warn(`[chat:handler_failed] step=${currentStep} reason=${safeReason}`);
      const fallbackReply = buildResultFollowupReply(message, messagesContext, followupBrief);
      if (fallbackReply && assistantMsgId && input.conversationId) {
        try {
          if (sb) {
            await Promise.all([
              sb.from("messages").update({ content_ar: fallbackReply, clarification_items: null, plan: null, quote: null }).eq("id", assistantMsgId),
              sb.from("messages").update({ request_status: "completed" }).eq("id", userMsgId),
            ]);
          } else {
            await Promise.all([
              this.tables.updateRow({ databaseId: "digr", tableId: "messages", rowId: assistantMsgId, data: { content: fallbackReply, status: "ready" } }),
              this.tables.updateRow({ databaseId: "digr", tableId: "messages", rowId: userMsgId, data: { requestStatus: "completed" } }),
            ]);
          }
        } catch {
          console.warn(`[chat:result_followup_fallback_persist_failed] reason=${safeReason}`);
        }
        return {
          conversationId: input.conversationId,
          messageId: assistantMsgId,
          role: "assistant",
          contentAr: fallbackReply,
          outputType: "answer_question",
          intent: "research",
          tokensUsed: { input: 0, output: 0, costUsd: 0 },
          turnStats: zeroModelTurnStats(input.conversationId, assistantMsgId, turnStartTime),
        };
      }
      if (userMsgId) {
        const customerError = sanitizeCustomerErrorMessage(err?.message || "تعذر إعداد الطلب.");
        try {
          if (sb) {
            await sb
              .from("messages")
              .update({ request_status: "failed", request_error: customerError })
              .eq("id", userMsgId)
              .eq("user_id", userId);
          } else {
            await this.tables.updateRow({
              databaseId: "digr",
              tableId: "messages",
              rowId: userMsgId,
              data: { requestStatus: "failed", requestError: customerError },
            });
          }
        } catch (historyError: any) {
          console.warn(`[chat:request_history_failure_write_failed] reason=${toSafeReasonCode(historyError, "request_history_failure_write")}`);
        }
      }
      throw err;
    }
  }
}

