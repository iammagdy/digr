import { namesCollectibleData, normalize } from "./messageType";

/**
 * THE RULES CODE APPLIES BEFORE THE CHAT MODEL IS CALLED (round 23). Four kinds of message have an answer that must not depend on a model's mood: they are checked here, in this order, and answered with fixed words:
 *   1. PRIVACY: a request for the phone numbers, home addresses or personal e-mails of private individuals is refused politely, with an offer of what Diger can do. Business contacts of companies and their decision makers stay allowed.
 *   2. ACCOUNT questions (change name, e-mail, password, delete the account, top up): answered from the pages that really exist on the site (a test reads their source), and plainly «not available yet» where there is no page.
 *   3. TRUST questions («الموقع ده نصب ولا ايه؟»): a short honest answer from fixed facts, nothing invented.
 * None of them creates a mission, calls a model or touches money. Pure functions of the text.
 */

// ---- 1. privacy ----------------------------------------------------------------------------------------------------------------------------------------------------------
/** A kind of contact data that belongs to a person: a phone or WhatsApp number, a home address, a personal e-mail. */
const PERSONAL_CONTACT = /(?:ارقام?|رقم)\s*(?:ال)?(?:تليفون|تلفون|هاتف|هواتف|موبايل|جوال|محمول|واتس)|(?:^| )(?:ال)?(?:تليفونات|موبايلات|واتساب|واتس اب|phone numbers?|mobile numbers?|whatsapp)(?: |$)|عنوان\s*(?:ال)?(?:سكن|بيت|منزل|شخصي)|عناوين\s*(?:ال)?(?:سكن|بيوت|منازل|شخصيه|شخصية)|عناوين\s*(?:ال)?(?:سكن|بيوت|منازل|ناس|اشخاص|افراد|مواطنين)|(?:ايميل|ايميلات|اميل|بريد)\s*(?:ات)?\s*(?:ال)?(?:شخصي|شخصيه)|(?:ايميلات|بريد)\s*(?:ال)?(?:ناس|اشخاص|افراد|متابعين|معلقين|مستخدمين)|\b(?:personal|private)\s+e-?mails?\b|\be-?mails?\s+(?:of\s+)?(?:the\s+)?(?:people|users|followers|commenters|individuals|reviewers|customers|members)\b|\b(?:home|residential)\s+addresse?s?\b|\baddresses\s+of\s+(?:the\s+)?(?:people|users|followers|commenters|individuals|reviewers|customers|members)\b/;
/** The bare words of PERSONAL_CONTACT that name an app or a product, not a number. */
// never a token that follows «ارقام» / «رقم» («ارقام تليفونات» and «رقم واتساب» ask for numbers): those stay in the text the contact rule reads
// «الواتساب» with the article is the same word (live evaluation 2026-11-12, N5: «عايز الواتساب الشخصي للمعلقين» passed the rule)
const BARE_APP_OR_PRODUCT = /(?<!(?:ارقام?|رقم)\s*(?:ال)?)(?:^| )(?:ال)?(?:تليفونات|موبايلات|واتساب|واتس اب|whatsapp)(?= |$)/g;
/** Words that make the target an ordinary individual, whatever else the sentence says. */
const PRIVATE_EXPLICIT = /ناس\s*عادي|اشخاص\s*عادي|افراد\s*عادي|(?:ال)?مواطنين|اصحاب\s*(?:ال)?حسابات|(?:ال)?معلقين|(?:ال)?متابعين|ordinary people|private (?:individuals|people)|عنوان\s*(?:ال)?(?:سكن|بيت|منزل|شخصي)|عناوين\s*(?:ال)?(?:سكن|بيوت|منازل|شخصيه|شخصية)/;
/** The business side that stays allowed: companies, shops, clinics, offices and the decision makers of them. */
const BUSINESS = /شركات?|شركه|مؤسس|مصنع|مصانع|مطاعم|مطعم|عيادات|عياده|صيدليات|صيدليه|فنادق|فندق|متاجر|متجر|محلات|مكاتب|مكتب|مراكز|مركز|مقاول|مدير|مديري|مدراء|صناع\s*(?:ال)?قرار|مسؤول|مسئول|تنفيذي|اعمال|business|compan|b2b|decision|مورد|جهات|هيئات|جامعات|مدارس|اطباء|دكاتره|محامي|مهندس|ورش|وكالات|وكاله|بنوك|بنك|فروع|فرع/;

/**
 * CONSOLIDATED MISSION: what the contact rule decides for a message. «refuse»: it asks for personal contact data of private individuals. «clarify»: the only contact-looking words are a bare app or product word («موبايلات», «واتساب») with
 * nothing that says whose number is wanted, so the customer is ASKED what they mean (nothing is collected, no mission is created). «allow»: no personal contact data is asked.
 */
export type ContactVerdict = "refuse" | "clarify" | "allow";

/**
 * EACH COLLECTION OBJECTIVE IS JUDGED ON ITS OWN. A collecting verb joined by «و» («… وهات أرقام …», «وكمان …») starts a new objective. A business word exempts only the objective it is in: «تعليقات عن شركات الاتصالات وهات أرقام تليفونات الناس اللي علقوا»
 * was allowed because «شركات» was anywhere in the sentence; the second objective is now refused on its own.
 */
const OBJECTIVE_BREAK = new RegExp(`(?<![ء-ي])(?:و(?:هات|جيب|اجمع|جمع|اسحب|استخرج|طلع|اطلع|نزل|حمل|ضيف|اضف|عايز|عاوز|محتاج|ابعت|ابعتلي|كمان|برضه|برضو)|كمان|برضه|برضو)(?![ء-ي])|\\b(?:and\\s+(?:also|get|collect|extract|give)|also|plus)\\b`, "g");
function objectivesOf(text: string): string[] {
  const cuts = [0];
  for (const m of text.matchAll(OBJECTIVE_BREAK)) if (m.index! > 0) cuts.push(m.index!);
  return cuts.map((start, i) => text.slice(start, cuts[i + 1] ?? text.length).trim()).filter((s) => s !== "");
}
/** The ordinary people a contact noun points at, right after it («أرقام موبايلات الناس», «تليفونات عملاء الشركة», «واتساب البنات»): a person target never takes the business exemption. */
const CONTACT_NOUN = "(?:ارقام?|رقم|تليفونات|تليفون|تلفون|هاتف|هواتف|موبايلات|موبايل|جوال|محمول|واتساب|واتس|ايميلات|ايميل|اميلات|بريد|عناوين|عنوان|phones?|numbers?|emails?|whatsapp|addresses)";
const PERSON_AFTER_CONTACT = new RegExp(`(?<![ء-ي])${CONTACT_NOUN}(?![ء-ي])(?:\\s+\\S+){0,2}\\s+(?:ال)?(?:ناس|عملاء|زباين|زبائن|مشتركين|اعضاء|بنات|شباب|ستات|رجاله|سكان|طلاب|طلبه|اهالي)(?![ء-ي])|(?<![ء-ي])${CONTACT_NOUN}(?![ء-ي])(?:\\s+\\S+){0,3}\\s+(?:اللي|الي)\\s+(?:علق|بيعلق|علقوا|بيعلقوا|كتبوا|نشروا|بيتابعوا|تابعوا|عملوا)|\\b(?:phones?|numbers?|emails?|addresses)\\b(?:\\s+\\S+){0,2}\\s+(?:of\\s+)?(?:the\\s+)?(?:people|customers|users|members|followers|commenters|reviewers|individuals)\\b`);
/** A product or app word that reads as the PRODUCT, not a number: a brand, a model, a price, a review, a business version. */
const PRODUCT_CUE = /(?<![ء-ي])(?:سامسونج|سامسونغ|ايفون|ابل|شاومي|هواوي|اوبو|ريلمي|نوكيا|انفنكس|انفينكس|فيفو|اونر|موتورولا|بكسل|جالكسي|اسعار|سعر|مراجعات|مراجعه|ريفيو|ريفيوهات|عروض|مواصفات|جديده|مستعمله|بيزنس|تحديث|تحديثات|مميزات|عيوب)(?![ء-ي])|\b(?:samsung|iphone|apple|xiaomi|huawei|oppo|realme|nokia|infinix|vivo|honor|pixel|galaxy|prices?|reviews?|specs|business|update)\b/;

/** The verdict of the contact rule (see ContactVerdict). Pure. */
export function contactAskVerdict(message: string): ContactVerdict {
  const text = normalize(message);
  if (!PERSONAL_CONTACT.test(text)) return "allow";
  // explicit private words anywhere keep the old answer: refused, whatever else the sentence says (unchanged)
  if (PRIVATE_EXPLICIT.test(text) && contactObjectiveIn(text)) return "refuse";
  let clarify = false;
  for (const objective of objectivesOf(text)) {
    const v = objectiveVerdict(objective);
    if (v === "refuse") return "refuse";
    if (v === "clarify") clarify = true;
  }
  return clarify ? "clarify" : "allow";
}

/** Whether a part of the text asks for contact data at all (a bare app or product word in the SUBJECT of public content does not). */
function contactObjectiveIn(part: string): boolean {
  if (!PERSONAL_CONTACT.test(part)) return false;
  // SECURITY PR: a request for PUBLIC content whose SUBJECT is an app or a product («منشورات عامة عن واتساب») asks for nobody's number: the bare app and product words (never «ارقام» + a contact word) are read only BEFORE the topic marker
  const { head, tail } = splitAtPublicTopic(part);
  if (tail === null) return true;
  if (!PERSONAL_CONTACT.test(`${head} ${tail.replace(BARE_APP_OR_PRODUCT, " ")}`)) return false;
  // NO FALSE REFUSALS (docs/MULTI-OBJECTIVE-RESEARCH.md): the ROLE of the words decides, as for identifiers. Contact words that are only the SUBJECT of public content («تعليقات عن تسريب أرقام التليفونات», «الناس بتقول إيه عن
  // سرقة أرقام الموبايلات») ask for nobody's number: what is collected is the public content. They stay an ask when they point at private people, when they are what is collected: in the head, after a second collecting verb («… واستخرج الأرقام»), or as what the content
  // must CONTAIN («تعليقات فيها أرقام تليفونات»).
  if (PERSONAL_CONTACT.test(head)) return true;
  // the contact words point at private people («أرقام تليفونات الناس العاديين», «وأرقام تليفونات المعلقين»): never only a subject
  if (PERSON_AFTER_CONTACT.test(tail) || PRIVATE_EXPLICIT.test(tail)) return true;
  const extra = secondAsk(tail);
  if (extra !== null && PERSONAL_CONTACT.test(extra)) return true;
  return HARVEST_CONTACT.test(part);
}
/** Content collected FOR the contact data it contains («تعليقات فيها أرقام موبايلات»): harvesting, the same request as the numbers themselves. */
const HARVEST_CONTACT = new RegExp(`(?:فيها|فيه|تحتوي|تحتوى|تتضمن|يحتوي|كاتبين|كاتبه|كتبوا|نشروا|بيكتبوا|containing|contains|that\\s+include|with)(?:\\s+\\S+){0,3}\\s+(?:${CONTACT_NOUN})(?![ء-ي])`);

function objectiveVerdict(objective: string): ContactVerdict {
  if (!contactObjectiveIn(objective)) return "allow";
  if (PERSON_AFTER_CONTACT.test(objective)) return "refuse";
  if (BUSINESS.test(objective)) return "allow";
  // only bare app / product words («موبايلات», «واتساب»), no «أرقام», no address, no personal e-mail: a product cue means the product; otherwise the customer is asked
  const bareOnly = !PERSONAL_CONTACT.test(objective.replace(BARE_APP_OR_PRODUCT, " "));
  if (bareOnly) return PRODUCT_CUE.test(objective) ? "allow" : "clarify";
  return "refuse";
}

/** True when the message asks for personal contact data of private individuals. */
export function privateContactAsk(message: string): boolean {
  return contactAskVerdict(message) === "refuse";
}

/** Asked (never refused) when the only contact-looking word is a bare app or product word: nothing is collected, no mission is created. */
export const CONTACT_CLARIFY_APP_AR = "هل تقصد المحتوى العام المنشور عن هذا الموضوع، مثل المنشورات أو الفيديوهات أو التعليقات العامة على تيك توك أو إكس أو إنستجرام أو فيسبوك أو يوتيوب؟ لا أستطيع جمع رسائل المجموعات أو المحادثات الخاصة ولا أرقام أعضائها، لكن يمكنني جمع ما يُنشر علنًا عنها. اكتب لي ما تريد جمعه بالتحديد وسأجهّز لك الخطة والسعر، ولا يُخصم شيء قبل موافقتك.";
export const CONTACT_CLARIFY_PRODUCT_AR = "هل تقصد المحتوى العام عن هذه الأجهزة نفسها، مثل الفيديوهات أو المنشورات أو التعليقات أو المراجعات عنها؟ إن كان هذا قصدك فاكتب لي المنصة وما تريد جمعه بالتحديد وسأجهّز لك الخطة والسعر، ولا يُخصم شيء قبل موافقتك. أما أرقام هواتف الأشخاص فلا أجمعها لأنها بيانات خاصة.";
/** The clarification of a «clarify» verdict: about an app (a messenger, its groups) or about a product. */
export function contactClarifyAr(message: string): string {
  return MESSENGER_APP.test(normalize(message)) ? CONTACT_CLARIFY_APP_AR : CONTACT_CLARIFY_PRODUCT_AR;
}

export const PRIVACY_REFUSAL_AR = "لا أستطيع جمع أرقام الهواتف أو عناوين السكن أو البريد الشخصي لأشخاص عاديين، فهذه بيانات خاصة تحميها خصوصيتهم. يمكنني بدلًا من ذلك جمع المنشورات والتعليقات العامة، وبيانات التواصل المهنية للشركات وصناع القرار فيها المتاحة علنًا. اكتب لي ما تريد وسأجهّز لك الخطة والسعر، ولا يُخصم شيء قبل موافقتك.";

// ---- 1b. private conversations and personal identifiers (security PR) -------------------------------------------------------------------------------------------------------
/**
 * TWO MORE THINGS Diger never collects, refused BEFORE the model, a mission or a provider call (the rule above covers personal CONTACT data only; «رسايل الواتساب بتاعة جروب الشغل» and «الرقم القومي لأحمد» passed it):
 *   - the messages of a PRIVATE conversation (WhatsApp, Telegram, Messenger, …: a group chat or a chat between people), and
 *   - the personal IDENTIFIERS of a person (national ID number, ID card, passport, driving licence, social security, residence permit, bank card number).
 * Nothing in the product can read a private chat or hold an authorization from its members, so there is nothing to ask the customer to authorize: the request is refused, with what Diger CAN do.
 *
 * INTENT, NOT KEYWORDS. A word is judged by the ROLE it plays: what the customer asks us to COLLECT (the object of the request), not what the collected public content is ABOUT. «هات منشورات عامة عن حماية الرقم القومي» asks for public posts; the ID is their
 * subject. So when a topic marker («عن», «حول», «بخصوص», «تتناول», «about» …) follows a PUBLIC-CONTENT noun (posts, comments, videos, news …) only the part BEFORE the marker is what is collected. Without that shape the whole sentence is the object, and the rules apply to all of it.
 * A public broadcast CHANNEL (a Telegram channel's public posts) is public by design and is not a private conversation. Pure functions of the text; the same normalisation as the rules above (spelling folds, Arabic digits, no punctuation).
 */
const PFX = "(?<![ء-ي])[وبلفك]?(?:ال)?";
const END = "(?![ء-ي])";
const word = (alts: string): RegExp => new RegExp(`${PFX}(?:${alts})${END}`);
const ARABIC_OR_LATIN = (arabic: string, latin: string): RegExp => new RegExp(`${PFX}(?:${arabic})${END}|\\b(?:${latin})\\b`);

/** What a customer collects that is PUBLIC (the head noun of «هات منشورات عامة عن …»). */
const PUBLIC_CONTENT = ARABIC_OR_LATIN("بيقول|بيقولوا|بتقول|بيتكلموا|بيتكلم|بتتكلم|بيكتبوا|بتكتب|كلام|منشورات|منشور|بوستات|بوست|تعليقات|تعليق|تغريدات|تغريده|تويتات|فيديوهات|فيديو|ريلز|مقالات|مقال|اخبار|خبر|نقاشات|مناقشات|مناقشه|اراء|راي|مراجعات|تقييمات|هاشتاجات|ترند|دراسات|ابحاث|بحوث|تحليلات", "posts?|comments?|tweets?|videos?|reels?|articles?|news|discussions?|opinions?|reviews?|trends?|studies|research|saying|says|said|talking|think|thinks|discussing|writing");
/** A word that turns what follows into the SUBJECT of the collected content, not the thing collected. */
const TOPIC_MARK = /(?<![ء-ي])(?:عن|حول|بخصوص|بشان|تتناول|تناقش|تتحدث|بتتكلم|بتتناول|تتعلق|متعلقه|المتعلقه)(?![ء-ي])|\b(?:about|regarding|concerning|on|related to|discussing|discuss|discusses|mentioning|covering)\b/;

/** The text split at the first topic marker that follows PUBLIC content: `head` is what is collected, `tail` its subject. `tail` is null when the sentence has no such shape (the whole sentence is the object). */
function splitAtPublicTopic(text: string): { head: string; tail: string | null } {
  const m = TOPIC_MARK.exec(text);
  if (!m) return { head: text, tail: null };
  const head = text.slice(0, m.index);
  return PUBLIC_CONTENT.test(head) ? { head, tail: text.slice(m.index) } : { head: text, tail: null };
}

/**
 * A SECOND ASK hidden behind a public topic («هات منشورات عن حماية الرقم القومي واستخرج الأرقام القومية اللي فيها»): after the topic marker, a collecting verb («استخرج», «اسحب», «هات», «extract» …) or an additive cue («وكمان», «also») starts a NEW object, and
 * that object is judged as a request of its own. The subject of the public content stays free; what the customer asks to pull OUT of it does not.
 */
const SECOND_ASK = new RegExp(`(?<![ء-ي])و?(?:استخرج|اطلع|طلع|جمع|اجمع|اسحب|سحب|هات|جيب|حمل|نزل|ضيف|اضف|وكمان|كمان|وبرضه|تجمع|تسحب|تستخرج|تطلع|تجيب|تنزل|تحمل|عايز|عاوز|اعرض)${END}|\\b(?:extract|collect|scrape|pull|harvest|gather|export|download|also|plus|and\\s+get)\\b`);
function secondAsk(tail: string | null): string | null {
  if (tail === null) return null;
  const m = SECOND_ASK.exec(tail);
  return m ? tail.slice(m.index) : null;
}

// -- private messages
const MESSENGER_APP = new RegExp(`${PFX}(?:واتس[ء-ي]*|تيليجرام|تليجرام|تلجرام|سيجنال|ماسنجر|فايبر|ايميسج)|\\b(?:whats\\s?app|telegram|messenger|viber|imessage|signal)\\b`);
const MESSAGE_NOUN = new RegExp(`${PFX}(?:رسايل|رسائل|رساله|محادثات|محادثه|دردشات|دردشه|مراسلات)${END}|\\b(?:messages?|chats|conversations?|dms?)\\b|(?:اللي|الي|ما)\\s+(?:اتكتب|اتبعت|اتقال|كتبوه|كتبوا|بيتكتب|اتبادل|اتبادلوه)`);
const LOOSE_CHAT = word("شات|شاتات|شاتس");
const GROUP_CHAT = ARABIC_OR_LATIN("جروب|جروبات|قروب|كروب|مجموعه|مجموعات", "groups?");
const PRIVATE_MARK = ARABIC_OR_LATIN("خاص|خاصه|خاصين|خاصات|سري|سريه|سريين|شخصي|شخصيه|شخصيين", "private|confidential|personal");
const BROADCAST_CHANNEL = ARABIC_OR_LATIN("قناه|قنوات", "channels?");

/** True when the customer asks for the messages of a private conversation (a group chat, a chat between people, a messenger inbox). */
export function privateMessagesAsk(message: string): boolean {
  const { head, tail } = splitAtPublicTopic(normalize(message));
  const extra = secondAsk(tail);
  if (extra !== null && privateMessagesAsk(extra)) return true;
  // «شات» / «شاتات» alone is also a product word («شات جي بي تي»): it counts as a message noun only with a messenger app or a group beside it
  const appOrGroup = MESSENGER_APP.test(head) || GROUP_CHAT.test(head);
  if (!MESSAGE_NOUN.test(head) && !(appOrGroup && LOOSE_CHAT.test(head))) return false;
  const asksPrivate = appOrGroup || PRIVATE_MARK.test(head);
  if (!asksPrivate) return false;
  // a public broadcast channel is public by design; a group or an explicit «private» keeps the request private
  if (BROADCAST_CHANNEL.test(head) && !GROUP_CHAT.test(head) && !PRIVATE_MARK.test(head)) return false;
  return true;
}

// -- personal identifiers
const PERSONAL_ID = new RegExp([
  `${PFX}(?:رقم|ارقام)\\s+(?:ال)?(?:قومي|قوميه|وطني|هويه|هويات|بطاق(?:ه|ات)|جواز|جوازات|رخص(?:ه|ات)?|تاميني|اقامه)${END}`,
  `${PFX}(?:بطاق(?:ه|ات))\\s+(?:ال)?(?:رقم\\s+(?:ال)?قومي|شخصي(?:ه|ات)|هويه|تحقيق\\s+شخصيه)${END}`,
  `${PFX}(?:جواز|جوازات)\\s+(?:ال)?سفر${END}`,
  `${PFX}رخص(?:ه|ات)?\\s+(?:ال)?قياده${END}`,
  `${PFX}(?:ال)?هويه\\s+(?:ال)?وطني(?:ه)?${END}`,
  `${PFX}(?:ارقام|رقم)\\s+(?:ال)?(?:فيزا|كارت|كروت|حساب\\s+(?:ال)?بنكي)${END}`,
  `${PFX}ارقام\\s+(?:ال)?بطاق(?:ات|ه)\\s+(?:ال)?(?:ائتمان|بنكي(?:ه|ات)?|فيزا|ماستر)${END}`,
  "\\b(?:national\\s+id|nid|id\\s+(?:card|number)|identity\\s+(?:card|number)|ssn|social\\s+security|passports?(?:\\s+(?:number|no|scan|copy))?|driv(?:er|ing)(?:'?s)?\\s+licen[sc]e|iqama|credit\\s+card\\s+numbers?|cvv|iban)\\b",
].join("|"));
/** Words that say the collected content CONTAINS the identifier («تعليقات فيها الرقم القومي»): collecting content to harvest identifiers is the same request. */
const CONTAINS = "فيها|فيه|تحتوي|تحتوى|تتضمن|يحتوي|تذكر|تضم|كاتبين|كاتبه|كتبوا|نشروا|بيكتبوا|containing|contains|that\\s+include";
const HARVEST_ID = new RegExp(`(?:${CONTAINS})(?:\\s+\\S+){0,3}\\s+(?:${PERSONAL_ID.source})`);
/** Policy and awareness words: public content about them is public discussion, not collection (used only when the sentence has no topic marker). */
const POLICY_CONTEXT = /حماي|سياس|قانون|تشريع|تسريب|توعي|خصوصي|امان|تجديد|تحديث|رسوم|اجراءات|شروط|منظومه|ميكنه|\b(?:protection|policy|law|leak|privacy|security|renewal|fees)\b/;

/** True when the customer asks us to COLLECT a personal identifier (a national ID number, an ID card, a passport, a licence, a bank card number); public content ABOUT such identifiers is not. */
export function personalIdentifierAsk(message: string): boolean {
  const text = normalize(message);
  if (!PERSONAL_ID.test(text)) return false;
  if (HARVEST_ID.test(text)) return true;
  const { head, tail } = splitAtPublicTopic(text);
  // a collecting verb after the topic starts a second ask, judged on its own («… عن الحماية واستخرج الأرقام القومية منها»)
  const extra = secondAsk(tail);
  if (extra !== null && personalIdentifierAsk(extra)) return true;
  // the identifier is only in the SUBJECT of public content («منشورات عامة عن حماية الرقم القومي»)
  if (tail !== null && !PERSONAL_ID.test(head)) return false;
  // public content about a policy or its protection, written with NO topic marker («أخبار تسريب الأرقام القومية»): a marker means the head is what is collected, and an identifier in it stays refused
  if (tail === null && PUBLIC_CONTENT.test(text) && POLICY_CONTEXT.test(text)) return false;
  return true;
}

export const PRIVATE_MESSAGES_REFUSAL_AR = "لا أستطيع جمع رسائل أو محادثات خاصة، سواء كانت في مجموعات أو بين أشخاص، فهذه بيانات يملكها أصحابها ولا يتاح الوصول إليها دون تفويضهم، ولا تدعم ديجر قراءتها. يمكنني بدلًا من ذلك جمع المنشورات والتعليقات العامة المنشورة علنًا، والقنوات العامة، وبيانات التواصل المهنية للشركات المتاحة علنًا. اكتب لي ما تريد وسأجهّز لك الخطة والسعر، ولا يُخصم شيء قبل موافقتك.";
export const SENSITIVE_ID_REFUSAL_AR = "لا أستطيع جمع الأرقام القومية أو أرقام البطاقات والهويات وجوازات السفر ورخص القيادة أو غيرها من المعرّفات الشخصية، فهذه بيانات حساسة تحميها خصوصية أصحابها. يمكنني بدلًا من ذلك جمع المنشورات والتعليقات العامة، ومنها النقاش العام عن حماية هذه البيانات، وبيانات التواصل المهنية للشركات المتاحة علنًا. اكتب لي ما تريد وسأجهّز لك الخطة والسعر، ولا يُخصم شيء قبل موافقتك.";

/**
 * The fixed refusal of a request for private conversations or personal identifiers (the two rules of this section only), or null. It is the ONE definition applied wherever a customer's words become a request after the chat (the creation of a mission, the answer
 * to a question card), so the same words cannot be refused in the chat and accepted through another door. The personal-contact rule above is deliberately NOT repeated there: it keeps being applied exactly where it was (the chat), so no eligibility changes elsewhere.
 */
export function sensitiveRequestRefusalAr(message: string): string | null {
  if (privateMessagesAsk(message)) return PRIVATE_MESSAGES_REFUSAL_AR;
  if (personalIdentifierAsk(message)) return SENSITIVE_ID_REFUSAL_AR;
  return null;
}

/** The chat's fixed privacy refusal: the personal-contact rule (unchanged), then the two rules above. */
export function privacyRefusalAr(message: string): string | null {
  if (privateContactAsk(message)) return PRIVACY_REFUSAL_AR;
  return sensitiveRequestRefusalAr(message);
}

// ---- 2. account questions -------------------------------------------------------------------------------------------------------------------------------------------------
export const ACCOUNT_TOPICS = ["name", "email", "password", "delete", "topup"] as const;
export type AccountTopic = (typeof ACCOUNT_TOPICS)[number];

const DATA_NOUN = /تعليق|منشور|بوست|فيديو|ريلز|شركات|شركه|تغريد|داتا|بيانات|مراجعات|صيدلي|مطاعم|عيادات|قائمه|قوائم|حسابات|متابع|هاتف|تليفون|ارقام/;
const CHANGE = /غير|تغيير|اغير|بدل|تبديل|اعدل|تعديل|عدل|ضيف|اضافه|اضيف/;
const NAME_OBJ = /(?:^| )(?:اسمي|اسمى|الاسم|اسم الحساب|اسم المستخدم)(?: |$)/;
const EMAIL_OBJ = /ايميلي|(?:^| )الايميل|(?:^| )الاميل|(?:^| )البريد|بريدي|اميلي/;
const PASSWORD_OBJ = /كلمه (?:ال)?(?:سر|مرور)|باسورد|باسوورد|(?:ال)?رقم (?:ال)?سري/;
const DELETE_ASK = /(?:احذف|حذف|امسح|مسح|الغاء|الغي|الغا|اقفل|قفل|ازاله|ازيل)\S*\s*(?:ال)?(?:حساب|اكونت|اكاونت)|(?:حسابي|اكونتي|الاكونت|الاكاونت)\s*(?:ده|دا|هذا)?\s*(?:ال)?(?:حذف|مسح|الغاء)/;
const TOPUP_ASK = /اشحن|شحن\s*(?:ال)?(?:رصيد|حساب|محفظ)|اضيف\s*(?:ال)?رصيد|اضافه\s*(?:ال)?رصيد|اشتري\s*(?:ال)?نقاط|شراء\s*(?:ال)?نقاط|طرق\s*(?:ال)?دفع|ادفع\s*ازاي|ازاي\s*ادفع|زياده\s*(?:ال)?رصيد|اعبي\s*(?:ال)?رصيد/;
/**
 * PR-1.4: the bare noun «شحن» («الشحن ازاي؟») is a top-up question only when nothing else says it is about SHIPPING or about data to collect: «قائمة مكاتب شحن في جدة» asks for shipping offices. A short message with no shipping or data word keeps its fixed top-up answer.
 */
const TOPUP_BARE = /(?:ال)?شحن(?: |$)/;
const SHIPPING_CONTEXT = /مكاتب|مكتب|شركات|شركه|خدمات|خدمه|اسعار|سعر|تكلفه|بضاع|بضايع|شحنات|شحنه|دولي|بحري|جوي|جمارك|توصيل|مناديب|تجار|مستورد|موردين|مورد|(?:^| )(?:في|من|الي|الى|لـ)(?: |$)/;

/** The account question a message asks, or null. A message that asks for data (it only mentions «حسابات» or «البريد») is never an account question. */
export function accountTopicOf(message: string): AccountTopic | null {
  const text = normalize(message);
  if (text === "") return null;
  const dataLike = DATA_NOUN.test(text);
  if (DELETE_ASK.test(text) && !/حسابات/.test(text)) return "delete";
  if (PASSWORD_OBJ.test(text) && (CHANGE.test(text) || /نسيت|ازاي|كيف|عايز|اريد|ممكن|اعمل/.test(text))) return "password";
  if (TOPUP_ASK.test(text) && !/تعليق|منشور|فيديو|شركات|تغريد/.test(text)) return "topup";
  if (TOPUP_BARE.test(text) && !dataLike && !namesCollectibleData(text) && !SHIPPING_CONTEXT.test(text) && text.split(" ").length <= 4) return "topup";
  if (dataLike) return null;
  if (EMAIL_OBJ.test(text) && CHANGE.test(text)) return "email";
  if (NAME_OBJ.test(text) && CHANGE.test(text)) return "name";
  return null;
}

/** Fixed answers, each naming only pages and buttons that exist (tests/round23-live-fixes.test.ts reads their source). */
export function accountAnswerAr(topic: AccountTopic): string {
  switch (topic) {
    case "name":
      return "تغيّر اسمك من «الإعدادات» في القائمة الجانبية: افتح قسم «الملف الشخصي»، وعدّل خانة «الاسم»، ثم اضغط «حفظ».";
    case "email":
      return "تغيير البريد الإلكتروني غير متاح حاليًا من الإعدادات؛ يظهر بريدك هناك ولا يمكن تعديله. إن احتجت تغييره فاكتب لنا من صفحة «تواصل معنا» وسنرد عليك على بريدك.";
    case "password":
      return "من «الإعدادات» افتح قسم «كلمة المرور»، واكتب كلمة المرور الحالية ثم الجديدة (ثماني خانات على الأقل)، واضغط «تغيير كلمة المرور». وإن نسيتها فاضغط «نسيت كلمة المرور؟» في صفحة الدخول.";
    case "delete":
      return "من «الإعدادات» انزل إلى قسم «حذف الحساب»، واكتب كلمة «حذف» لتأكيد الطلب. يُحذف حسابك وملفات أبحاثك نهائيًا خلال ثلاثين يومًا، ولا يمكن استعادة الرصيد المتبقي بعد الحذف.";
    case "topup":
      return "من «المحفظة» في القائمة الجانبية اضغط «شحن الرصيد» واتبع الخطوات هناك؛ ويظهر رصيدك الجديد بعد مراجعة طلب الشحن.";
  }
}

// ---- 3. trust ---------------------------------------------------------------------------------------------------------------------------------------------------------------
/**
 * PR-1.4: the bare words of TRUST («نصب», «احتيال», «مضمون», «ضمان» …) are also the SUBJECT of public research («هات تعليقات تيك توك عن نصب الاستثمار»). A bare word is a doubt about Diger only when it is not the subject of a topic marker («عن نصب …») and the message does not name data to
 * collect; the phrases that are about the service itself («نصبتوا», «هتسرقوا», «ثقه فيكم», «الموقع ده حقيقي») are unchanged.
 */
const TRUST_BARE = /(?:^| )(?:نصب|نصاب\S*|احتيال\S*|حرام[يه]\S*|وهم[يه]|مزيف\S*|مضمون\S*|موثوق\S*|ضمان)(?: |$)|سرقه|الوثوق|اثق /;
const TRUST_SELF = /(?:نصبتوا|نصبو|ثقه فيكم|ثقه في|هتسرقوا|بتسرقوا|فلوسي\s*(?:هتضيع|ضاعت|راحت)|(?:ال)?موقع\s*(?:ده|دا|هذا)?\s*(?:حقيقي|امن|امان|مضمون))/;
const SUBJECT_OF = /(?:^| )(?:عن|حول|بخصوص|في موضوع|رايك في|رايكم في|about|regarding)\s+(?:ال)?(?:\S+\s+){0,2}$/;

/** A message that doubts whether the service is honest or safe. */
export function isTrustQuestion(message: string): boolean {
  const text = ` ${normalize(message)} `;
  if (TRUST_SELF.test(text)) return true;
  const bare = TRUST_BARE.exec(text);
  if (!bare) return false;
  if (namesCollectibleData(message)) return false;
  // the text BEFORE the word: a match that starts at its own leading space keeps that space, a match inside the text (e.g. «سرقه») starts at the word itself (cutting one letter of it made «عن سرقة الهوية» look like no topic marker)
  const start = bare[0].startsWith(" ") ? bare.index + 1 : bare.index;
  return !SUBJECT_OF.test(text.slice(0, start));
}

export const TRUST_REPLY_AR = "أفهم حرصك. لا يُخصم منك شيء قبل أن ترى الخطة والسعر وتعتمدها بنفسك بزر «اعتمد»، ولا تدفع إلا مقابل ما سُلّم لك فعلًا، وما حُجز مؤقتًا ولم يُسلَّم يُحرَّر كاملًا. وفي كل طلب تجد ما جُمع وما سُلّم وما خُصم، ويمكنك أن تبدأ بأقل طلب لتجرّب بنفسك.";

// ---- the order -------------------------------------------------------------------------------------------------------------------------------------------------------------
export type PreModelAnswer = { kind: "privacy_refusal" | "privacy_clarify" | "trust"; contentAr: string } | { kind: "account"; contentAr: string; topic: AccountTopic };

/**
 * The fixed answer of the first rule the message matches, or null (the chat model reads it). Privacy first, then the account, then trust.
 * CONSOLIDATED MISSION: a message whose only contact-looking word is a bare app or product word, with no private conversation or identifier asked, is ASKED what it means («privacy_clarify»), never refused and never planned.
 */
export function preModelAnswer(message: string): PreModelAnswer | null {
  const refusal = privacyRefusalAr(message);
  if (refusal) return { kind: "privacy_refusal", contentAr: refusal };
  if (contactAskVerdict(message) === "clarify") return { kind: "privacy_clarify", contentAr: contactClarifyAr(message) };
  const topic = accountTopicOf(message);
  if (topic) return { kind: "account", contentAr: accountAnswerAr(topic), topic };
  if (isTrustQuestion(message)) return { kind: "trust", contentAr: TRUST_REPLY_AR };
  return null;
}
