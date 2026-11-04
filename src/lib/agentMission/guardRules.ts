import { normalize } from "./messageType";

/**
 * THE RULES CODE APPLIES BEFORE THE CHAT MODEL IS CALLED (round 23). Four kinds of message have an answer that must not depend on a model's mood: they are checked here, in this order, and answered with fixed words:
 *   1. PRIVACY: a request for the phone numbers, home addresses or personal e-mails of private individuals is refused politely, with an offer of what Diger can do. Business contacts of companies and their decision makers stay allowed.
 *   2. ACCOUNT questions (change name, e-mail, password, delete the account, top up): answered from the pages that really exist on the site (a test reads their source), and plainly «not available yet» where there is no page.
 *   3. TRUST questions («الموقع ده نصب ولا ايه؟»): a short honest answer from fixed facts, nothing invented.
 * None of them creates a mission, calls a model or touches money. Pure functions of the text.
 */

// ---- 1. privacy ----------------------------------------------------------------------------------------------------------------------------------------------------------
/** A kind of contact data that belongs to a person: a phone or WhatsApp number, a home address, a personal e-mail. */
const PERSONAL_CONTACT = /(?:ارقام?|رقم)\s*(?:ال)?(?:تليفون|تلفون|هاتف|هواتف|موبايل|جوال|محمول|واتس)|(?:^| )(?:تليفونات|موبايلات|واتساب|واتس اب|phone numbers?|mobile numbers?|whatsapp)(?: |$)|عنوان\s*(?:ال)?(?:سكن|بيت|منزل)|عناوين\s*(?:ال)?(?:سكن|بيوت|منازل|ناس|اشخاص|افراد|مواطنين)|(?:ايميل|ايميلات|اميل|بريد)\s*(?:ات)?\s*(?:ال)?(?:شخصي|شخصيه)|(?:ايميلات|بريد)\s*(?:ال)?(?:ناس|اشخاص|افراد|متابعين|معلقين|مستخدمين)/;
/** Words that make the target an ordinary individual, whatever else the sentence says. */
const PRIVATE_EXPLICIT = /ناس\s*عادي|اشخاص\s*عادي|افراد\s*عادي|(?:ال)?مواطنين|اصحاب\s*(?:ال)?حسابات|(?:ال)?معلقين|(?:ال)?متابعين|ordinary people|private (?:individuals|people)|عنوان\s*(?:ال)?(?:سكن|بيت|منزل)|عناوين\s*(?:ال)?(?:سكن|بيوت|منازل)/;
/** The business side that stays allowed: companies, shops, clinics, offices and the decision makers of them. */
const BUSINESS = /شركات?|شركه|مؤسس|مصنع|مصانع|مطاعم|مطعم|عيادات|عياده|صيدليات|صيدليه|فنادق|فندق|متاجر|متجر|محلات|مكاتب|مكتب|مراكز|مركز|مقاول|مدير|مديري|مدراء|صناع\s*(?:ال)?قرار|مسؤول|مسئول|تنفيذي|اعمال|business|compan|b2b|decision|مورد|جهات|هيئات|جامعات|مدارس|اطباء|دكاتره|محامي|مهندس|ورش|وكالات|وكاله|بنوك|بنك|فروع|فرع/;

/** True when the message asks for personal contact data of private individuals. */
export function privateContactAsk(message: string): boolean {
  const text = normalize(message);
  if (!PERSONAL_CONTACT.test(text)) return false;
  if (PRIVATE_EXPLICIT.test(text)) return true;
  return !BUSINESS.test(text);
}

export const PRIVACY_REFUSAL_AR = "لا أستطيع جمع أرقام الهواتف أو عناوين السكن أو البريد الشخصي لأشخاص عاديين، فهذه بيانات خاصة تحميها خصوصيتهم. يمكنني بدلًا من ذلك جمع المنشورات والتعليقات العامة، وبيانات التواصل المهنية للشركات وصناع القرار فيها المتاحة علنًا. اكتب لي ما تريد وسأجهّز لك الخطة والسعر، ولا يُخصم شيء قبل موافقتك.";

// ---- 2. account questions -------------------------------------------------------------------------------------------------------------------------------------------------
export const ACCOUNT_TOPICS = ["name", "email", "password", "delete", "topup"] as const;
export type AccountTopic = (typeof ACCOUNT_TOPICS)[number];

const DATA_NOUN = /تعليق|منشور|بوست|فيديو|ريلز|شركات|شركه|تغريد|داتا|بيانات|مراجعات|صيدلي|مطاعم|عيادات|قائمه|قوائم|حسابات|متابع|هاتف|تليفون|ارقام/;
const CHANGE = /غير|تغيير|اغير|بدل|تبديل|اعدل|تعديل|عدل|ضيف|اضافه|اضيف/;
const NAME_OBJ = /(?:^| )(?:اسمي|اسمى|الاسم|اسم الحساب|اسم المستخدم)(?: |$)/;
const EMAIL_OBJ = /ايميلي|(?:^| )الايميل|(?:^| )الاميل|(?:^| )البريد|بريدي|اميلي/;
const PASSWORD_OBJ = /كلمه (?:ال)?(?:سر|مرور)|باسورد|باسوورد|(?:ال)?رقم (?:ال)?سري/;
const DELETE_ASK = /(?:احذف|حذف|امسح|مسح|الغاء|الغي|الغا|اقفل|قفل|ازاله|ازيل)\S*\s*(?:ال)?(?:حساب|اكونت|اكاونت)|(?:حسابي|اكونتي|الاكونت|الاكاونت)\s*(?:ده|دا|هذا)?\s*(?:ال)?(?:حذف|مسح|الغاء)/;
const TOPUP_ASK = /اشحن|شحن\s*(?:ال)?(?:رصيد|حساب|محفظ)|(?:ال)?شحن(?: |$)|اضيف\s*(?:ال)?رصيد|اضافه\s*(?:ال)?رصيد|اشتري\s*(?:ال)?نقاط|شراء\s*(?:ال)?نقاط|طرق\s*(?:ال)?دفع|ادفع\s*ازاي|ازاي\s*ادفع|زياده\s*(?:ال)?رصيد|اعبي\s*(?:ال)?رصيد/;

/** The account question a message asks, or null. A message that asks for data (it only mentions «حسابات» or «البريد») is never an account question. */
export function accountTopicOf(message: string): AccountTopic | null {
  const text = normalize(message);
  if (text === "") return null;
  const dataLike = DATA_NOUN.test(text);
  if (DELETE_ASK.test(text) && !/حسابات/.test(text)) return "delete";
  if (PASSWORD_OBJ.test(text) && (CHANGE.test(text) || /نسيت|ازاي|كيف|عايز|اريد|ممكن|اعمل/.test(text))) return "password";
  if (TOPUP_ASK.test(text) && !/تعليق|منشور|فيديو|شركات|تغريد/.test(text)) return "topup";
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
const TRUST = /(?:^| )(?:نصب|نصاب\S*|نصبتوا|نصبو|احتيال\S*|حرام[يه]\S*|وهم[يه]|مزيف\S*|مضمون\S*|موثوق\S*|ضمان)(?: |$)|الوثوق|اثق |ثقه فيكم|ثقه في|هتسرقوا|بتسرقوا|سرقه|فلوسي\s*(?:هتضيع|ضاعت|راحت)|(?:ال)?موقع\s*(?:ده|دا|هذا)?\s*(?:حقيقي|امن|امان|مضمون)/;

/** A message that doubts whether the service is honest or safe. */
export function isTrustQuestion(message: string): boolean {
  return TRUST.test(` ${normalize(message)} `);
}

export const TRUST_REPLY_AR = "أفهم حرصك. لا يُخصم منك شيء قبل أن ترى الخطة والسعر وتعتمدها بنفسك بزر «اعتمد»، ولا تدفع إلا مقابل ما سُلّم لك فعلًا، وما حُجز مؤقتًا ولم يُسلَّم يُحرَّر كاملًا. وفي كل طلب تجد ما جُمع وما سُلّم وما خُصم، ويمكنك أن تبدأ بأقل طلب لتجرّب بنفسك.";

// ---- the order -------------------------------------------------------------------------------------------------------------------------------------------------------------
export type PreModelAnswer = { kind: "privacy_refusal" | "trust"; contentAr: string } | { kind: "account"; contentAr: string; topic: AccountTopic };

/** The fixed answer of the first rule the message matches, or null (the chat model reads it). Privacy first, then the account, then trust. */
export function preModelAnswer(message: string): PreModelAnswer | null {
  if (privateContactAsk(message)) return { kind: "privacy_refusal", contentAr: PRIVACY_REFUSAL_AR };
  const topic = accountTopicOf(message);
  if (topic) return { kind: "account", contentAr: accountAnswerAr(topic), topic };
  if (isTrustQuestion(message)) return { kind: "trust", contentAr: TRUST_REPLY_AR };
  return null;
}
