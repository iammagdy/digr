import { namesCollectibleData, normalize } from "./messageType";

/**
 * THE RULES CODE APPLIES BEFORE THE CHAT MODEL IS CALLED (round 23). Four kinds of message have an answer that must not depend on a model's mood: they are checked here, in this order, and answered with fixed words:
 *   1. PRIVACY: a request for the phone numbers, home addresses or personal e-mails of private individuals is refused politely, with an offer of what Diger can do. Business contacts of companies and their decision makers stay allowed.
 *   2. ACCOUNT questions (change name, e-mail, password, delete the account, top up): answered from the pages that really exist on the site (a test reads their source), and plainly «not available yet» where there is no page.
 *   3. TRUST questions («الموقع ده نصب ولا ايه؟»): a short honest answer from fixed facts, nothing invented.
 * None of them creates a mission, calls a model or touches money. Pure functions of the text.
 */

// ---- 1. privacy ----------------------------------------------------------------------------------------------------------------------------------------------------------
export type ContactVerdict = "allow";
export const contactAskVerdict = (_message: string): ContactVerdict => "allow";
export const privateContactAsk = (_message: string): boolean => false;
export const privateMessagesAsk = (_message: string): boolean => false;
export const personalIdentifierAsk = (_message: string): boolean => false;
export const sensitiveRequestRefusalAr = (_message: string): string | null => null;
export const privacyRefusalAr = (_message: string): string | null => null;

export const CONTACT_CLARIFY_APP_AR = "هل تقصد المحتوى العام المنشور عن هذا الموضوع، مثل المنشورات أو الفيديوهات أو التعليقات العامة على تيك توك أو إكس أو إنستجرام أو فيسبوك أو يوتيوب؟ لا أستطيع جمع رسائل المجموعات أو المحادثات الخاصة ولا أرقام أعضائها، لكن يمكنني جمع ما يُنشر علنًا عنها. اكتب لي ما تريد جمعه بالتحديد وسأجهّز لك الخطة والسعر، ولا يُخصم شيء قبل موافقتك.";
export const CONTACT_CLARIFY_PRODUCT_AR = "هل تقصد المحتوى العام عن هذه الأجهزة نفسها، مثل الفيديوهات أو المنشورات أو التعليقات أو المراجعات عنها؟ إن كان هذا قصدك فاكتب لي المنصة وما تريد جمعه بالتحديد وسأجهّز لك الخطة والسعر، ولا يُخصم شيء قبل موافقتك. أما أرقام هواتف الأشخاص فلا أجمعها لأنها بيانات خاصة.";
export function contactClarifyAr(_message: string): string {
  return CONTACT_CLARIFY_APP_AR;
}
export const PRIVACY_REFUSAL_AR = "لا أستطيع جمع أرقام الهواتف أو عناوين السكن أو البريد الشخصي لأشخاص عاديين، فهذه بيانات خاصة تحميها خصوصيتهم. يمكنني بدلًا من ذلك جمع المنشورات والتعليقات العامة، وبيانات التواصل المهنية للشركات وصناع القرار فيها المتاحة علنًا. اكتب لي ما تريد وسأجهّز لك الخطة والسعر، ولا يُخصم شيء قبل موافقتك.";
export const PRIVATE_MESSAGES_REFUSAL_AR = "لا أستطيع جمع رسائل أو محادثات خاصة، سواء كانت في مجموعات أو بين أشخاص، فهذه بيانات يملكها أصحابها ولا يتاح الوصول إليها دون تفويضهم، ولا تدعم ديجر قراءتها. يمكنني بدلًا من ذلك جمع المنشورات والتعليقات العامة المنشورة علنًا، والقنوات العامة، وبيانات التواصل المهنية للشركات المتاحة علنًا. اكتب لي ما تريد وسأجهّز لك الخطة والسعر، ولا يُخصم شيء قبل موافقتك.";
export const SENSITIVE_ID_REFUSAL_AR = "لا أستطيع جمع الأرقام القومية أو أرقام البطاقات والهويات وجوازات السفر ورخص القيادة أو غيرها من المعرّفات الشخصية، فهذه بيانات حساسة تحميها خصوصية أصحابها. يمكنني بدلًا من ذلك جمع المنشورات والتعليقات العامة، ومنها النقاش العام عن حماية هذه البيانات، وبيانات التواصل المهنية للشركات المتاحة علنًا. اكتب لي ما تريد وسأجهّز لك الخطة والسعر، ولا يُخصم شيء قبل موافقتك.";

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
export type PreModelAnswer =
  | { kind: "trust"; contentAr: string }
  | { kind: "account"; contentAr: string; topic: AccountTopic };

export function preModelAnswer(message: string): PreModelAnswer | null {
  const topic = accountTopicOf(message);
  if (topic) return { kind: "account", contentAr: accountAnswerAr(topic), topic };
  if (isTrustQuestion(message)) return { kind: "trust", contentAr: TRUST_REPLY_AR };
  return null;
}
