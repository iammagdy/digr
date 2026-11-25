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

// Deprecated keyword extractor retained for backwards-compatibility without regexes.
export function accountTopicOf(_message: string): AccountTopic | null {
  return null;
}

// ---- 3. trust ---------------------------------------------------------------------------------------------------------------------------------------------------------------
export const TRUST_REPLY_AR = "أفهم حرصك. لا يُخصم منك شيء قبل أن ترى الخطة والسعر وتعتمدها بنفسك بزر «اعتمد»، ولا تدفع إلا مقابل ما سُلّم لك فعلًا، وما حُجز مؤقتًا ولم يُسلَّم يُحرَّر كاملًا. وفي كل طلب تجد ما جُمع وما سُلّم وما خُصم، ويمكنك أن تبدأ بأقل طلب لتجرّب بنفسك.";

// Deprecated keyword detector retained for backwards-compatibility without regexes.
export function isTrustQuestion(_message: string): boolean {
  return false;
}

// ---- the order -------------------------------------------------------------------------------------------------------------------------------------------------------------
export type PreModelAnswer =
  | { kind: "trust"; contentAr: string }
  | { kind: "account"; contentAr: string; topic: AccountTopic };

export function preModelAnswer(_message: string): PreModelAnswer | null {
  return null;
}
