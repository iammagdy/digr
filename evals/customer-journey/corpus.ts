/**
 * THE EGYPTIAN-COSMETICS CUSTOMER JOURNEY CORPUS (round 57, docs/CUSTOMER-JOURNEY-R57.md).
 *
 * Every case starts from the state the real customer was in on 13 Nov 2026 (conversation 98a724a3995b46579f82): the original request answered by a plan that waits for approval
 * (tests/fixtures/cosmetics-plan-r57.json, the real plan of that mission with its sample rows removed). The follow-ups are the customer's own words and realistic variations.
 *
 * Kinds (the brief of the round): A a follow-up question, B a new requirement, C a revision of the plan, D an explicit cancellation, E an entirely new request.
 * The OBJECTIVE checks are invariants the product must hold whatever the wording of the reply; the language itself is reviewed by a person (the report), never asserted here.
 */
export type JourneyKind = "A_question" | "B_requirement" | "C_revision" | "D_cancel" | "E_new";

export interface JourneyCase {
  id: string;
  kind: JourneyKind;
  title: string;
  /** The customer's messages after the original request (one turn each, in order). */
  turns: string[];
  /** What must hold after EVERY turn of the case. */
  expect: {
    /** The original plan is still plan_ready (not cancelled, not replaced). */
    keepPlan: boolean;
    /** A new mission may be created: "never", "allowed", or "required" (E). */
    newMission: "never" | "allowed" | "required";
    /** Each turn's reply must match at least one of these (per turn index; missing index: no check). */
    mention?: Array<RegExp | null>;
  };
}

export const ORIGINAL_REQUEST = "أنا بعمل بحث عن شركات مستحضرات التجميل في مصر. عايز أسماء الشركات، مواقعها الرسمية، وأرقام التليفونات والإيميلات المنشورة، مع رابط مصدر كل معلومة.";

/** The subject of the research: a mission whose request loses it is a fragment mission (the 13 Nov defect). */
export const SUBJECT = /تجميل|cosmetic/i;

/** The fixed replies that answer nothing about the customer's own plan (13 Nov). */
export const GENERIC_REPLIES = [
  /^لم أفهم من رسالتك أنها طلب لجمع بيانات/,
  /^لتعديل الفترة أو اللغة أو الأعمدة أو الاستثناءات استخدم زر/,
  /^قيمة النقطة الواحدة ٠٫١٠ جنيه مصري\. الحد الأدنى للمهمة ٢٠٠ نقطة، ولا خصم إن لم يُسلَّم شيء\. لا يُخصم شيء قبل موافقتك/,
];

const SOURCES = /خرائط|الموقع الرسمي|موقع (?:الشركة|كل شركة)|صفحة التواصل|رابط/;
const RELEVANCE = /تصنيف|نشاط|تجميل/;
const BLANK = /فاض|فارغ|نسيب|سنترك|هنسيب|هيفضل|يبقى|يُترك|نتركه|من غير ما (?:نخترع|نكمّل)|لا نخترع|مش هنخترع/;
const COST = /عدد|شركة|أقل|نقلل|تقليل|نقلّل|عمود|مرحلة|بيانات التواصل|نقطة/;

export const JOURNEY_CASES: JourneyCase[] = [
  { id: "F1", kind: "B_requirement", title: "relevance requirement", turns: ["أنا مش عايز بيانات ملهاش علاقة بالموضوع."], expect: { keepPlan: true, newMission: "never", mention: [RELEVANCE] } },
  { id: "F2", kind: "A_question", title: "how is the sector verified", turns: ["إزاي هتتأكد إن الشركة فعلًا شغالة في مستحضرات التجميل؟"], expect: { keepPlan: true, newMission: "never", mention: [RELEVANCE] } },
  { id: "F3", kind: "B_requirement", title: "leave missing contacts blank", turns: ["لو مش لاقي رقم أو إيميل، سيبه فاضي."], expect: { keepPlan: true, newMission: "never", mention: [BLANK] } },
  { id: "F4", kind: "A_question", title: "cheaper without losing quality", turns: ["ممكن نقلل التكلفة من غير ما نخسر الجودة؟"], expect: { keepPlan: true, newMission: "never", mention: [COST] } },
  { id: "F5", kind: "A_question", title: "where does the data come from", turns: ["أنا عايز أعرف البيانات دي جاية منين."], expect: { keepPlan: true, newMission: "never", mention: [SOURCES] } },
  { id: "U1", kind: "A_question", title: "company without an official site", turns: ["لو الشركة مالهاش موقع رسمي هتعمل إيه؟"], expect: { keepPlan: true, newMission: "never", mention: [/موقع|فاض|فارغ|خرائط/] } },
  { id: "Q1", kind: "A_question", title: "is the price final", turns: ["السعر ده نهائي ولا ممكن يزيد؟"], expect: { keepPlan: true, newMission: "never", mention: [/حجز|نقطة|المسلّم|المسلم|يُسلَّم|سُلّم/] } },
  { id: "Q2", kind: "A_question", title: "duplicates", turns: ["هل ممكن الشركة تتكرر مرتين في الملف؟"], expect: { keepPlan: true, newMission: "never" } },
  { id: "C1", kind: "C_revision", title: "count revision", turns: ["خليها ٥٠ شركة"], expect: { keepPlan: true, newMission: "never" } },
  { id: "C2", kind: "C_revision", title: "geography revision without count", turns: ["خليها شركات الإسكندرية بس"], expect: { keepPlan: false, newMission: "allowed" } },
  { id: "C3", kind: "C_revision", title: "restore an earlier plan", turns: ["ممكن ترجع لي الخطة اللي كانت معروضة قبل كده وأوافق عليها زي ما هي؟"], expect: { keepPlan: true, newMission: "never" } },
  { id: "B1", kind: "B_requirement", title: "add social pages", turns: ["عايز كمان صفحات الفيسبوك بتاعة الشركات دي"], expect: { keepPlan: false, newMission: "allowed" } },
  { id: "D1", kind: "D_cancel", title: "explicit cancellation (cancels, never a new mission)", turns: ["خلاص الغي الطلب ده"], expect: { keepPlan: false, newMission: "never", mention: [/ألغي|الغي|إلغاء|ألغِ/] } },
  { id: "E1", kind: "E_new", title: "entirely new request", turns: ["عايز تعليقات الناس على تيك توك عن أسعار الدهب في مصر آخر أسبوع"], expect: { keepPlan: false, newMission: "required" } },
  { id: "AMB", kind: "A_question", title: "ambiguous fragment", turns: ["طيب والإسكندرية؟"], expect: { keepPlan: false, newMission: "allowed" } },
  {
    id: "SEQ", kind: "A_question", title: "the exact 13 Nov follow-ups in order",
    turns: ["أنا مش عايز بيانات ملهاش علاقة بالموضوع.", "إزاي هتتأكد إن الشركة فعلًا شغالة في مستحضرات التجميل؟", "لو مش لاقي رقم أو إيميل، سيبه فاضي.", "ممكن نقلل التكلفة من غير ما نخسر الجودة؟", "أنا عايز أعرف البيانات دي جاية منين."],
    expect: { keepPlan: true, newMission: "never", mention: [RELEVANCE, RELEVANCE, BLANK, COST, SOURCES] },
  },
];
