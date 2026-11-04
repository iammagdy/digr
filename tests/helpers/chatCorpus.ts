import type { ChatType } from "../../src/lib/agentMission/conversationModel";

/**
 * ROUND 22: THE PERMANENT CORPUS of the chat's message types, each message with the type it must get and, when it is sent while the customer has an OPEN request, that request's state.
 * It keeps the round-21 messages (the two live ones first), adds the three live messages of 4 Nov 2026 (after #372), follow-ups with an open request, and ambiguous data requests.
 * A new live message that is mistyped is added here with its expected type, never argued with.
 */
export type OpenState = "plan_ready" | "needs_input" | "planning";
export interface CorpusEntry { text: string; type: ChatType; open?: OpenState; count?: number }

const base: Array<[string, ChatType]> = [
  // ---- greeting or small talk (the two live ones first)
  ["هاي يا صاحبي", "greeting_or_small_talk"],
  ["السلام عليكم", "greeting_or_small_talk"],
  ["السلام عليكم ورحمة الله وبركاته", "greeting_or_small_talk"],
  ["إزيك", "greeting_or_small_talk"],
  ["ازيك يا باشا", "greeting_or_small_talk"],
  ["صباح الخير", "greeting_or_small_talk"],
  ["مساء الخير يا دكتور", "greeting_or_small_talk"],
  ["مرحبا", "greeting_or_small_talk"],
  ["أهلاً وسهلاً", "greeting_or_small_talk"],
  ["شكرًا", "greeting_or_small_talk"],
  ["شكرا جزيلا", "greeting_or_small_talk"],
  ["تسلم ايدك", "greeting_or_small_talk"],
  ["hi", "greeting_or_small_talk"],
  // ---- a question about the service, its prices, its points or how it works
  ["بكام النقطة؟", "service_question"],
  ["كام سعر النقطة", "service_question"],
  ["ايه الحد الأدنى للطلب؟", "service_question"],
  ["هل بتخصموا قبل ما أوافق؟", "service_question"],
  ["ازاي بتحاسبوا على الطلبات؟", "service_question"],
  ["ديجر بتعمل ايه بالظبط؟", "service_question"],
  ["كيف تعمل الخدمة؟", "service_question"],
  ["كيف أشحن رصيدي؟", "service_question"],
  ["كم سعر ملف المنهجية؟", "service_question"],
  ["بكام المنهجية؟", "service_question"],
  ["هل أدفع مقابل ما لم يُسلَّم؟", "service_question"],
  ["انتو مين؟", "service_question"],
  // ---- a methodology request (the live one first)
  ["عايزك تعملي منهجية بحث تكون pdf", "methodology_request"],
  ["اكتب لي المنهجية", "methodology_request"],
  ["محتاج ملف المنهجية بتاع الطلب اللي جمعته", "methodology_request"],
  ["أريد منهجية جمع البيانات بصيغة pdf", "methodology_request"],
  ["عاوز منهجية للبيانات اللي جمعتها", "methodology_request"],
  ["هل تكتبون منهجية الدراسة؟", "methodology_request"],
  ["اكتبلي منهجية بحث كاملة فيها تصميم الدراسة والعينة والتحليل الإحصائي", "methodology_request"],
  ["محتاج المنهجية بتاعة التعليقات اللي سلمتوها", "methodology_request"],
  // ---- a data request
  ["هات ٣٠٠ تغريدة عن محمد صلاح بعد انتقاله لتركيا", "data_request"],
  ["عايز ١٠٠ تعليق من بوست على فيسبوك عن الغلاء", "data_request"],
  ["اجمعلي تعليقات هذا الفيديو https://www.youtube.com/watch?v=abc123", "data_request"],
  ["محتاج قائمة شركات مقاولات في القاهرة مع الإيميلات", "data_request"],
  ["هات لي ٥٠ فيديو تيك توك عن الذكاء الاصطناعي", "data_request"],
  ["ابحث عن حسابات إنستجرام لعيادات الأسنان في الرياض", "data_request"],
  ["أريد بيانات مديري التسويق في شركات الاتصالات في مصر", "data_request"],
  ["محتاج مراجعات خرائط جوجل للمطاعم في جدة", "data_request"],
  ["اسحب لي منشورات ريديت عن الهجرة آخر شهر", "data_request"],
  ["هل ممكن تجمعلي ١٠٠ تعليق من فيسبوك؟", "data_request"],
  ["collect 200 tweets about electric cars", "data_request"],
  ["اجمع لي كل الصيدليات في المنصورة مع أرقام الهاتف", "data_request"],
  // ---- the chat's own button messages belong to the data flow (found by the stuck-missions replay)
  ["أعد المحاولة بنفس الخطة. اعرض عرض سعر جديدًا فقط، ولا تعتمد أو تبدأ التنفيذ.", "data_request"],
  ["عايز أراجع الخطة السابقة وأعدّلها. اعرض خطة وعرض سعر جديد فقط، ولا تبدأ أي استخراج قبل ما أوافق بنفسي.", "data_request"],
  // ---- anything else
  ["ايه رأيك في الجو النهاردة", "other"],
  ["احكيلي نكتة", "other"],
  ["بتحب الكورة؟", "other"],
  ["اكتب لي قصيدة عن البحر", "other"],
  ["طيب", "other"],
  ["؟؟؟", "other"],
  ["مين رئيس الوزراء", "other"],
];

export const ROUND21_CORPUS: CorpusEntry[] = base.map(([text, type]) => ({ text, type }));

/** The three live messages after #372: «هاي» and «انت مين» were acceptable, «يعني ايه ديجر الذكي» got «لم أفهم من رسالتك أنها طلب لجمع بيانات». */
export const ROUND22_LIVE: CorpusEntry[] = [
  { text: "هاي", type: "greeting_or_small_talk" },
  { text: "انت مين", type: "service_question" },
  { text: "يعني ايه ديجر الذكي", type: "service_question" },
  { text: "ممكن تساعدني في رسالة الماجستير؟", type: "other" },
];

/** Messages that change or answer the open request: never a new mission, never a generic reply. */
export const FOLLOW_UPS: CorpusEntry[] = [
  { text: "خليها ٥٠٠", type: "edit_of_open_request", open: "plan_ready", count: 500 },
  { text: "خليها ٥ تعليقات بس", type: "edit_of_open_request", open: "plan_ready", count: 5 },
  { text: "بس ١٠٠ تغريدة", type: "edit_of_open_request", open: "plan_ready", count: 100 },
  { text: "خليهم 30 بس", type: "edit_of_open_request", open: "plan_ready", count: 30 },
  { text: "قللها لـ ٢٠٠ لو سمحت", type: "edit_of_open_request", open: "plan_ready", count: 200 },
  { text: "عدّل العدد إلى ١٢٠٠", type: "edit_of_open_request", open: "plan_ready", count: 1200 },
  { text: "خليها بالعربي بس", type: "edit_of_open_request", open: "plan_ready" },
  { text: "السعودية", type: "edit_of_open_request", open: "needs_input" },
  { text: "آخر ٣ شهور", type: "edit_of_open_request", open: "needs_input" },
  { text: "ايوه كمّل بنفس الشروط", type: "edit_of_open_request", open: "needs_input" },
  { text: "الحسابات الرسمية بس", type: "edit_of_open_request", open: "needs_input" },
  { text: "خليها ٢٠٠", type: "edit_of_open_request", open: "planning", count: 200 },
  // with an open request, a message of another kind keeps its own type
  { text: "شكرًا", type: "greeting_or_small_talk", open: "plan_ready" },
  { text: "بكام النقطة؟", type: "service_question", open: "plan_ready" },
  { text: "هات ٣٠٠ تغريدة عن محمد صلاح بعد انتقاله لتركيا", type: "data_request", open: "plan_ready" },
];

/** Data requests the keywords do not recognise: the model reads them as requests (and when unsure the answer is «data», never a refusal). */
export const AMBIGUOUS_DATA: CorpusEntry[] = [
  { text: "عايز بيانات عن سوق العقارات في مصر", type: "data_request" },
  { text: "محتاج أعرف رأي الناس في الأسعار", type: "data_request" },
  { text: "ممكن تجيبلي كلام الناس عن شركة فودافون؟", type: "data_request" },
  { text: "نفسي أشوف الناس بتقول ايه عن مستشفى دار الفؤاد", type: "data_request" },
  { text: "محتاج داتا لرسالة الدكتوراه عن التسوق الإلكتروني", type: "data_request" },
  { text: "أبحث عن آراء المستخدمين في تطبيقات التوصيل", type: "data_request" },
];

export const CORPUS: CorpusEntry[] = [...ROUND21_CORPUS, ...ROUND22_LIVE, ...FOLLOW_UPS, ...AMBIGUOUS_DATA];

/** ROUND 23: the live messages of the 30-scenario test (after #373) with the behaviour each must get, with or without open missions. */
export type Behaviour = "platform_question" | "privacy_refusal" | "account_name" | "trust" | "greeting_with_name";
export const ROUND23_LIVE: Array<{ text: string; behaviour: Behaviour }> = [
  { text: "عايز داتا عن رأي الناس في الذكاء الاصطناعي", behaviour: "platform_question" },
  { text: "هات أرقام تليفونات ناس عادية من فيسبوك", behaviour: "privacy_refusal" },
  { text: "ممكن أغير اسمي في الحساب؟", behaviour: "account_name" },
  { text: "الموقع ده نصب ولا ايه؟", behaviour: "trust" },
];
