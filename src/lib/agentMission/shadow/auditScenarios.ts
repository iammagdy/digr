import type { ShadowCase } from "./types";

/**
 * PHASE 7: THE AUDIT'S 35 SCENARIOS (docs/intelligence/DIGER_INTELLIGENCE_AUDIT.md chapter 11.2) as shadow cases, each as the customer wrote it, with the routing the Phase 2-4 acceptance pinned for a customer account (`prod`) and a test account
 * (`test`). Copied from `tests/intelligence-phases-2-4-acceptance.test.ts` (a test keeps the two lists equal). `gap` is a known Phase 1 understanding gap, recorded and never hidden. Scenario 35 is the in-message correction: the chat's validated brief
 * carries the latest platform, and the router follows it.
 */
type Status = "supported" | "partial" | "unsupported" | "blocked" | "needs_clarification";
interface Scenario { n: number; request: string; kind: string; ops: string[]; prod: Status; test: Status; gap?: string }

export const AUDIT_SCENARIO_LIST: ReadonlyArray<Scenario> = [
  { n: 1, request: "هات ١٠٠ تغريدة عن العاصمة الإدارية الشهر اللي فات", kind: "social", ops: ["social.parents"], prod: "supported", test: "supported" },
  { n: 2, request: "عايز ٢٠ تويتة عن الدوري مع الردود بتاعتها", kind: "social", ops: ["social.parents", "social.comments"], prod: "supported", test: "supported" },
  { n: 3, request: "فيديوهات تك توك عن الأكل الشعبي، ١٠ فيديوهات", kind: "social", ops: ["social.parents"], prod: "supported", test: "supported" },
  { n: 4, request: "هات الكومنتات والريبلايز على فيديوهات تيكتوك عن السياحة", kind: "social", ops: ["social.parents", "social.comments", "social.replies"], prod: "supported", test: "supported" },
  { n: 5, request: "بيانات حساب انستاجرام بتاع وزارة السياحة وآخر ١٠ بوستات", kind: "social", ops: ["social.profile", "social.parents"], prod: "partial", test: "partial" },
  { n: 6, request: "منشورات صفحة الأهلي الرسمية على الفيس آخر شهر", kind: "social", ops: ["social.parents"], prod: "supported", test: "supported" },
  { n: 7, request: "كل التعليقات على بوستات فيسبوك عن غلاء الأسعار", kind: "social", ops: ["social.parents", "social.comments"], prod: "supported", test: "supported" },
  { n: 8, request: "فيديوهات قناة الجزيرة على يوتيوب عن غزة الشهر ده", kind: "social", ops: ["social.parents"], prod: "supported", test: "supported" },
  { n: 9, request: "كومنتات فيديو يوتيوب ده https://youtu.be/dQw4w9WgXcQ", kind: "social", ops: ["social.parents", "social.comments"], prod: "supported", test: "supported" },
  { n: 10, request: "٥٠ شركه مقاولات فمصر", kind: "companies", ops: ["companies.discover"], prod: "unsupported", test: "supported", gap: "«فمصر» is not read as the country (Phase 1 lexicon)" },
  { n: 11, request: "٥٠ شركة مقاولات في مصر ومعاها الموقع الرسمي لكل شركة", kind: "companies", ops: ["companies.discover"], prod: "unsupported", test: "supported" },
  { n: 12, request: "٥٠ شركة مقاولات في مصر والإيميل العام ورقم المقر لكل شركة", kind: "companies", ops: ["companies.discover", "company.contacts"], prod: "unsupported", test: "supported", gap: "«رقم المقر» (the HQ phone) is not read as a phone ask (Phase 1)" },
  { n: 13, request: "صيدليات في المعادي على خرايط جوجل", kind: "places", ops: ["places.discover"], prod: "unsupported", test: "supported" },
  { n: 14, request: "تقييمات مطعم أبو طارق على جوجل ماب، آخر ٢٠٠ ريفيو", kind: "places", ops: ["places.discover", "places.reviews"], prod: "unsupported", test: "supported" },
  { n: 15, request: "٣ مديرين من كل شركة برمجيات في السعودية مع إيميلات الشغل", kind: "companies", ops: ["companies.discover", "company.contacts", "people.discover"], prod: "unsupported", test: "supported" },
  { n: 16, request: "شركات الطاقة الشمسية في مصر ومواقعهم وصفحاتهم على السوشيال", kind: "companies", ops: ["companies.discover"], prod: "unsupported", test: "supported", gap: "a company's public social links have no stage (no operation maps them)" },
  { n: 17, request: "شركات تسويق في دبي + الإيميلات اللي على مواقعهم", kind: "companies", ops: ["companies.discover", "company.contacts"], prod: "unsupported", test: "supported" },
  { n: 18, request: "كومنتات تيك توك عن رمضان", kind: "social", ops: ["social.parents", "social.comments"], prod: "supported", test: "supported" },
  { n: 19, request: "عايز رسايل الواتساب بتاعة جروب الشغل", kind: "unknown", ops: [], prod: "blocked", test: "blocked" },
  { n: 20, request: "هات تعليقات فيديوهات تيك توك الخاصة بالسياحه", kind: "social", ops: ["social.parents", "social.comments"], prod: "supported", test: "supported" },
  { n: 21, request: "عايز الكومنتس بتاعة التك توك عن الاكل", kind: "social", ops: ["social.parents", "social.comments"], prod: "supported", test: "supported" },
  { n: 22, request: "محتاج 200 comments من TikTok videos عن AI في مصر", kind: "social", ops: ["social.parents", "social.comments"], prod: "supported", test: "supported" },
  { n: 23, request: "عايز داتا عن رأي الناس في الذكاء الاصطناعي", kind: "unknown", ops: [], prod: "needs_clarification", test: "needs_clarification" },
  { n: 24, request: "هات ٢٠ فيديو يوتيوب عن السياحة", kind: "social", ops: ["social.parents"], prod: "supported", test: "supported" },
  { n: 25, request: "تغريدات عن الانتخابات من ١ لـ ١٥ أكتوبر ٢٠٢٦ بس", kind: "social", ops: ["social.parents"], prod: "supported", test: "supported" },
  { n: 26, request: "فيديوهات تيك توك من السعوديه بس", kind: "social", ops: ["social.parents"], prod: "supported", test: "supported", gap: "«السعوديه» (ه) is not read as the country (Phase 1)" },
  { n: 27, request: "بالظبط ٥٠٠ تعليق تيك توك عن السياحة، لا أكتر ولا أقل", kind: "social", ops: ["social.parents", "social.comments"], prod: "supported", test: "supported" },
  { n: 28, request: "أرقام موبايلات الناس اللي علّقوا على البوست ده", kind: "unknown", ops: [], prod: "blocked", test: "blocked" },
  { n: 29, request: "اسحب لي اللي الناس كاتباه تحت فيديوهات عمرو أديب على يوتيوب", kind: "social", ops: ["social.parents"], prod: "supported", test: "supported", gap: "«اللي الناس كاتباه تحت» (the comments) is not read as comments (Phase 1)" },
  { n: 30, request: "عايز بوستات ريديت عن الذكاء الاصطناعي وتعليقاتها", kind: "social", ops: ["social.parents", "social.comments"], prod: "unsupported", test: "supported" },
  { n: 31, request: "مقالات عن السياحة في مصر وعايز نص كل مقالة", kind: "web", ops: ["web.search", "web.read"], prod: "unsupported", test: "supported" },
  { n: 32, request: "بروفايل تيك توك بتاع عمرو دياب وعدد المتابعين", kind: "social", ops: ["social.profile", "social.parents"], prod: "partial", test: "supported" },
  { n: 33, request: "Find 50 software companies in Cairo with their official websites", kind: "companies", ops: ["companies.discover"], prod: "unsupported", test: "supported" },
  { n: 34, request: "هات منشورات فيسبوك عن السياحة مع التعليقات والردود", kind: "social", ops: ["social.parents", "social.comments", "social.replies"], prod: "supported", test: "supported" },
  { n: 35, request: "تعليقات تيك توك عن السياحة… لا خليهم على يوتيوب", kind: "social", ops: ["social.parents", "social.comments", "social.parents", "social.comments"], prod: "supported", test: "supported", gap: "a correction typed INSIDE one message is not applied by the words reading (both platforms are read); the chat's validated brief carries the latest correction (Phase 1), see the next test" },
];

/**
 * What the audit's table (chapter 11.2, «Correct interpretation») says the request MEANS, for the scenarios where it names a platform, a topic or a period. Hand-labelled from the audit text, never edited to match the code: where the code
 * reads something else, the shadow view says so.
 */
const AUDIT_MEANING: Readonly<Record<number, NonNullable<ShadowCase["expected"]>>> = {
  1: { platform: "x", topic: "العاصمة الإدارية" },
  2: { platform: "x", route: "compiled" },
  3: { platform: "tiktok", route: "compiled" },
  5: { platform: "instagram", route: "compiled" },
  6: { platform: "facebook", route: "compiled" },
  8: { platform: "youtube", topic: "غزة" },
  21: { platform: "tiktok", route: "compiled" },
  25: { platform: "x", period: { from: "2026-10-01", to: "2026-10-15" } },
};

const obj = (id: string, operation: string, platform: string | null, parent: string | null = null) => ({ id, operation, platform, parent, contacts: [], what: "" });

export const AUDIT_CASES: ReadonlyArray<ShadowCase> = AUDIT_SCENARIO_LIST.map((s) => ({
  id: `audit-s${String(s.n).padStart(2, "0")}`,
  origin: "audit_scenario" as const,
  group: "audit chapter 11.2",
  request: s.request,
  // scenario 35 is routed WITH the chat's validated brief (the latest platform only); its words-only routing (both platforms) is the scenario list above
  expectedRouting: { kind: s.kind, ops: s.n === 35 ? ["social.parents", "social.comments"] : s.ops, production: s.prod, test: s.test },
  ...(AUDIT_MEANING[s.n] ? { expected: AUDIT_MEANING[s.n] } : {}),
  ...(s.gap ? { knownGap: s.gap } : {}),
  ...(s.n === 35 ? { brief: { platforms: ["youtube"], content: ["comments"], count: null, objectives: [obj("o1", "social.parents", "youtube"), obj("o2", "social.comments", "youtube", "o1")] as never } } : {}),
}));
