import { toArabicDigits } from "../arabicDigits";
import { isReviewPlanMessage, isRetrySamePlanMessage } from "../retryMessage";
import { METHODOLOGY_POINTS } from "../methodologyOffer";
import { DEFAULT_MISSION_PRICING_SETTINGS, minimumLineAr } from "../missionPricing";

/**
 * THE TYPE OF A CHAT MESSAGE (round 21), decided by CODE before anything is planned. Live (4 Nov 2026): every message opened a mission, so «هاي يا صاحبي» got a mission card with plan steps and a methodology request ended with
 * «مصادرنا لا تخدم هذا الطلب». Only a DATA request may reach mission planning; the other four types are answered here, from fixed words and fixed facts, with no mission, no model and no provider call.
 *
 * The classifier is a pure function of the text (no model: the owner allowed one, but a model's word is never needed to say «this is a greeting», and its output would have to be validated back to this same fixed set). Its output is ONE of MESSAGE_TYPES.
 * A message that carries a request is the request (a greeting in front of it changes nothing); a price question about the methodology is a question, not a purchase.
 * The numbers an answer says are the code's own constants (the minimum, the point's value, the methodology's price), never a model's.
 */
export const MESSAGE_TYPES = ["greeting", "service_question", "methodology_request", "data_request", "other"] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

/** Said in the answer to a methodology request when the customer has delivered requests: the page draws the chooser card under it (it recognises this sentence in the message). */
export const METHODOLOGY_CHOOSER_SENTENCE_AR = "اختر الطلب الذي تريد منهجية جمع بياناته من القائمة أدناه.";
/** One point in Egyptian pounds, as the customer reads it (1 point = 0.10 EGP). */
export const POINT_VALUE_EGP_AR = "٠٫١٠";

const MAX_CLASSIFIED_CHARS = 2000;

/** The text as the rules read it: Arabic-Indic digits to ASCII, no diacritics or tatweel, one letter for each hamza and for ى ة, lower case, punctuation as spaces. */
function normalize(raw: string): string {
  return String(raw ?? "")
    .slice(0, MAX_CLASSIFIED_CHARS)
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[ً-ٰٟـ]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " رابط ")
    .replace(/[،,.!؟?؛;:"'«»()[\]{}\-_/\\|*#@~`+=<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const set = (words: string): ReadonlySet<string> => new Set(words.split(/\s+/).filter(Boolean));
const GREETING_WORDS = set("هاي هلا هلو اهلا اهلين مرحبا مرحبتين سلام السلام عليكم ورحمه الله وبركاته وسهلا صباح مساء الخير النور ازيك ازيكم ازيكو عامل اخبارك اخباركم حالك حالكم هالو هيلو hi hello hey");
const THANKS_WORDS = set("شكرا شكراا جزيلا جزاك خيرا تسلم ايدك ايديك يسلمو ميرسي مشكور متشكر تشكرات thanks thank you");
const FILLER_WORDS = set("يا صاحبي صديقي باشا غالي دكتور دكتوره استاذ استاذه بيك هندسه معلم كبير حبيبي اخي اخوي ديجر بك بكم و ي وانت وانتم ايه كيف");

const THANKS_RE = /(?:^| )(?:شكر|تسلم|ميرسي|مشكور|متشكر|تشكرات|thanks|thank)/;
const QUESTION_WORDS = set("كام بكام بكم كم ازاي كيف هل ايه ما ماذا مين من ليه لماذا فين امتي متي ممكن");
const METHODOLOGY_RE = /منهجي|methodolog/;
/** Words that say the customer wants the WHOLE research methodology of a study, not how data was collected. */
const FULL_RESEARCH_RE = /تصميم (?:ال)?(?:دراسه|بحث)|عينه (?:ال)?(?:دراسه|بحث)|مجتمع (?:ال)?(?:دراسه|بحث)|فرضيات|الاطار النظري|الدراسات السابقه|التحليل الاحصائي|ادوات (?:ال)?(?:دراسه|بحث|تحليل)|المنهج (?:ال)?(?:وصفي|تجريبي|كمي|كيفي|شبه)|منهج (?:وصفي|تجريبي|كمي|كيفي)|مشكله (?:ال)?(?:دراسه|بحث)|حدود (?:ال)?دراسه|اسئله (?:ال)?(?:دراسه|بحث)/;
const FULL_RESEARCH_WEAK_RE = /تصميم|عينه|تحليل/g;
const PRICE_RE = /سعر|اسعار|بكام|بكم|تكلف|كام نقطه|كم نقطه|كم ثمن|بكام|ثمن/;
const SERVICE_RE = /نقطه|نقاط|سعر|اسعار|بكام|بكم|كام|تكلف|تحاسب|خصم|ادفع|دفع|رصيد|اشحن|شحن|الحد الادني|حد ادني|اشتراك|باقه|باقات|مجاني|مجانا|الخدمه|ديجر|بتعملوا|بتعمل|تقدموا|بتقدموا|تشتغل|بتشتغلوا|انتو مين|انتم مين|من انتم|مين انتو|فاتوره|استرجاع|ترجعوا|تعمل ايه/;
const HOW_RE = /كيف|ازاي|تعمل|تشتغل|بتعمل|بتشتغل|الخدمه|ديجر|مين|تقدم|تقدموا|بتقدموا|ايه هي|ما هي|ماهي|ماذا/;

/** What a data request is about: the kinds of data, the platforms and the file kinds the service collects and delivers. */
const STRONG_NOUN_RE = /تعليق|تغريد|تويت|تويتر|بوست|منشور|فيديو|ريلز|ريل |ستوري|حسابات|حساب |شركات|شركه|موظف|مديري|مديرين|مسؤول|ايميل|الايميل|بريد|هاتف|هواتف|ارقام|رقم |مراجعات|مراجعه|تقييم|خرائط|مطعم|مطاعم|صيدلي|عياد|مستشفي|فندق|فنادق|متابع|هاشتاج|هاشتاغ|قائمه|قوائم|اكسل|excel|xlsx|csv|tweet|post|comment|video|review|compan|email|lead|follower|account|ريديت|reddit|tiktok|تيك توك|تيكتوك|انستجرام|انستغرام|انستا|instagram|فيسبوك|فيس بوك|facebook|يوتيوب|youtube|لينكد|linkedin|twitter|(?:^| )اكس(?: |$)/;
const GENERIC_NOUN_RE = /بيانات|داتا|معلومات|(?:^| )data(?: |$)/;
const ASK_RE = /(?:^| )(?:عايز\S*|عاوز\S*|محتاج\S*|احتاج\S*|اريد|ابغي|ابي|ودي|نفسي|اطلب\S*|ممكن|هات\S*|جيب\S*|اعطني|اعطيني|وفر\S*|اعمل\S*|جهز\S*|want|need|give)(?: |$)/;
const COLLECT_STRONG_RE = /(?:^| )(?:اجمع\S*|جمعلي|جمّع\S*|اسحب\S*|استخرج\S*|collect|scrape|extract|download|fetch)(?: |$)/;
const SEARCH_RE = /(?:^| )(?:ابحث\S*|دور|دورلي|دوري|find|search)(?: |$)/;
const GET_RE = /(?:^| )(?:هات\S*|جيب\S*|نزل\S*|حمل\S*|get)(?: |$)/;

const wordsOf = (text: string): string[] => (text === "" ? [] : text.split(" "));

/** A message that is only a greeting, thanks or small talk (with the usual fillers: «يا صاحبي», «يا باشا»). */
function isOnlyGreeting(words: string[]): boolean {
  if (words.length === 0 || words.length > 8) return false;
  let real = 0;
  for (const w of words) {
    if (GREETING_WORDS.has(w) || THANKS_WORDS.has(w)) { real += 1; continue; }
    if (FILLER_WORDS.has(w)) continue;
    return false;
  }
  return real > 0;
}

/** Whether the customer asks for the study's whole research methodology (design, sample, analysis) and not for the data-collection one. */
export function isFullResearchMethodologyAsk(message: string): boolean {
  const text = normalize(message);
  if (FULL_RESEARCH_RE.test(text)) return true;
  return new Set(text.match(FULL_RESEARCH_WEAK_RE) ?? []).size >= 2;
}

/** The ONE type of a message (see MESSAGE_TYPES). Never throws; anything it cannot read is «other». */
export function classifyMessage(message: string): MessageType {
  // the fixed messages the chat's own buttons send («أعد المحاولة بنفس الخطة», «عايز أراجع الخطة...») belong to the data flow: they ask for a new quote of the plan above, never small talk
  if (isRetrySamePlanMessage(message) || isReviewPlanMessage(message)) return "data_request";
  const raw = String(message ?? "").slice(0, MAX_CLASSIFIED_CHARS);
  const text = normalize(raw);
  const words = wordsOf(text);
  if (words.length === 0) return "other";
  if (isOnlyGreeting(words)) return "greeting";

  const asksQuestion = /[؟?]/.test(raw) || QUESTION_WORDS.has(words[0]);
  const strongNoun = STRONG_NOUN_RE.test(` ${text} `);
  const generic = GENERIC_NOUN_RE.test(text);
  const ask = ASK_RE.test(text);
  const collectStrong = COLLECT_STRONG_RE.test(text);
  const number = /\d/.test(text);
  const url = /(?:^| )رابط(?: |$)/.test(text);
  const command = collectStrong && (strongNoun || number || url);

  // a price question is a question, also about the methodology («بكام المنهجية؟»)
  if (asksQuestion && PRICE_RE.test(text) && !command) return "service_question";
  if (METHODOLOGY_RE.test(text) && !command) return "methodology_request";
  if (asksQuestion && SERVICE_RE.test(text) && !command && !(strongNoun && (ask || number || url))) return "service_question";

  if (strongNoun && (ask || collectStrong || SEARCH_RE.test(text) || GET_RE.test(text) || number || url)) return "data_request";
  if (collectStrong && words.length >= 3) return "data_request";
  if (SEARCH_RE.test(text) && words.length >= 4) return "data_request";
  if (generic && (ask || collectStrong || GET_RE.test(text)) && words.length >= 3) return "data_request";
  return "other";
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// WHAT IS SAID BACK (fixed words and the code's own facts)
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------
const NOTHING_BEFORE_APPROVAL_AR = "لا يُخصم شيء قبل موافقتك على الخطة والسعر، ولا تدفع إلا مقابل ما سُلّم لك فعلًا.";
const HOW_IT_WORKS_AR = "تكتب لنا ما تريد جمعه، فنجهّز لك خطة بالعدد والسعر، وتعتمدها بزر «اعتمد» فنبدأ الجمع ونسلّمك النتيجة في ملف إكسل.";
const WHAT_WE_DO_AR = "ديجر تجمع بيانات البحث من وسائل التواصل الاجتماعي ومن مصادر الشركات والأشخاص، وتسلّمها لك في ملف إكسل منظم.";

const methodologyPriceAr = (): string => `منهجية جمع البيانات بصيغة بي دي إف لطلب سُلّم لك: ${toArabicDigits(METHODOLOGY_POINTS)} نقطة.`;

/** A greeting, small talk or thanks: short, friendly, formal Arabic that says what Diger does and invites a request. */
export function greetingReplyAr(message: string): string {
  if (THANKS_RE.test(normalize(message))) return "عفوًا، يسعدني أن أفيدك. متى أردت جمع بيانات جديدة اكتب لي طلبك، ولن يُخصم شيء قبل موافقتك.";
  return `أهلًا بك في ديجر. ${WHAT_WE_DO_AR} اكتب ما تريد جمعه، مثل تعليقات منشور على فيسبوك أو قائمة شركات في قطاع محدد، وسأجهّز لك خطة وسعرًا ولا يُخصم شيء قبل موافقتك.`;
}

/** The answer to a question about the service, its prices, its points or how it works: only fixed facts (never a number of a model). */
export function serviceAnswerAr(message: string): string {
  const text = normalize(message);
  const price = SERVICE_RE.test(text) && /نقطه|نقاط|سعر|اسعار|بكام|بكم|كام|كم|تكلف|تحاسب|خصم|ادفع|دفع|رصيد|اشحن|شحن|الحد الادني|حد ادني|اشتراك|باقه|باقات|مجاني|مجانا|فاتوره|استرجاع|ترجعوا|ثمن/.test(text);
  const how = HOW_RE.test(text);
  const parts: string[] = [];
  if (price) {
    if (METHODOLOGY_RE.test(text)) parts.push(methodologyPriceAr());
    parts.push(`قيمة النقطة الواحدة ${POINT_VALUE_EGP_AR} جنيه مصري.`);
    parts.push(minimumLineAr(DEFAULT_MISSION_PRICING_SETTINGS));
    parts.push(NOTHING_BEFORE_APPROVAL_AR);
    if (!METHODOLOGY_RE.test(text)) parts.push(methodologyPriceAr());
    if (how) parts.push(HOW_IT_WORKS_AR);
  } else {
    parts.push(WHAT_WE_DO_AR, HOW_IT_WORKS_AR, NOTHING_BEFORE_APPROVAL_AR);
  }
  return parts.join(" ");
}

/** Any other message: a short honest reply that says what Diger collects and how to ask. */
export function otherReplyAr(): string {
  return "لم أفهم من رسالتك أنها طلب لجمع بيانات. ديجر تجمع بيانات البحث (تعليقات ومنشورات وفيديوهات وشركات وأشخاص وبيانات تواصل) وتسلّمها لك في ملف إكسل؛ اكتب ما تريد جمعه ومن أي منصة، ولن يُخصم شيء قبل موافقتك.";
}

/** The one honest sentence said first to a clear ask for a FULL research methodology (study design, sample, analysis). */
export const FULL_RESEARCH_PREFIX_AR = "تكتب ديجر حاليًا منهجية جمع البيانات لطلباتك عبرها، وليس منهجية بحث كاملة تشمل تصميم الدراسة والعينة والتحليل. ";

/**
 * What follows the words of a methodology answer, written by CODE from the customer's delivered requests (`delivered`, read by the caller): with some, the chooser sentence the page recognises and the price the card shows before approval; with none, what the
 * document is and the offer to start a data request. The model may write the sentences before it (round 22) but never this part: it carries the price.
 */
export function methodologyTailAr(delivered: number): string {
  if (delivered > 0) return `${METHODOLOGY_CHOOSER_SENTENCE_AR} منهجية الجمع لهذا الطلب: ${toArabicDigits(METHODOLOGY_POINTS)} نقطة، ولا يُخصم شيء قبل تأكيدك.`;
  return `ليس لديك طلب مُسلَّم حتى الآن، فاكتب لي ما تريد جمعه لنبدأ، وبعد تسليمه تطلب منهجيته بسعر ${toArabicDigits(METHODOLOGY_POINTS)} نقطة.`;
}

/**
 * The answer to a methodology request. `delivered` is how many delivered compiled requests the customer has (read by the caller): with some, the chooser sentence and the price the card shows before approval; with none, what the document is and an offer to start a data request.
 * A clear ask for a full research methodology gets one honest sentence first.
 */
export function methodologyReplyAr(input: { text: string; delivered: number }): string {
  const prefix = isFullResearchMethodologyAsk(input.text) ? FULL_RESEARCH_PREFIX_AR : "";
  if (input.delivered > 0) return `${prefix}${methodologyTailAr(input.delivered)}`;
  return `${prefix}تصف المنهجية كيف جُمعت بيانات طلب نفّذته عبر ديجر: المصادر والفترة وما بُحث عنه والخطوات والأعداد المسلّمة وحدود التسليم. ${methodologyTailAr(0)}`;
}
