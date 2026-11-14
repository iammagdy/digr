import corpusJson from "../../../../data/shadow/corpus.json";
import { AUDIT_CASES } from "./auditScenarios";
import type { AcceptedDifference } from "./compare";
import type { ExclusionFixture, Risk, ShadowCase, StoredPlan } from "./types";

/**
 * PHASE 7: THE SHADOW CORPUS. Real stored requests with their approved plans (20), the labelled understanding baseline (98), the audit's 35 scenarios, and synthetic exclusion-list cases. Everything is a committed copy of anonymised fixtures: no
 * database read, no live data. The synthetic cases are labelled `simulated` by the engine.
 */
interface CorpusFile {
  stored: Array<{ id: string; request: string; replies_status: string | null; delivered: number[]; stages: StoredPlan["stages"] }>;
  understanding: Array<{ id: string; group: string; text: string; answer?: string; expected: Record<string, unknown>; known_gap?: string }>;
}
const corpus = corpusJson as unknown as CorpusFile;

export const STORED_CASES: ReadonlyArray<ShadowCase> = corpus.stored.map((m) => ({
  id: `stored-${m.id}`, origin: "stored_mission" as const, group: "approved missions", request: m.request,
  stored: { id: m.id, stages: m.stages, replies_status: m.replies_status, delivered: m.delivered },
}));

export const UNDERSTANDING_CASES: ReadonlyArray<ShadowCase> = corpus.understanding.map((c) => ({
  id: `und-${c.id}`, origin: "understanding_baseline" as const, group: c.group, request: c.text, ...(c.answer ? { answer: c.answer } : {}),
  expected: c.expected as ShadowCase["expected"], ...(c.known_gap ? { knownGap: c.known_gap } : {}),
}));

const fixture = (f: Omit<ExclusionFixture, "rows"> & { rows: ExclusionFixture["rows"] }): ExclusionFixture => f;

/** SYNTHETIC exclusion-list cases (the safe `.example` domain; no real company or person). The engine labels their findings `simulated`. */
export const EXCLUSION_CASES: ReadonlyArray<ShadowCase> = [
  {
    id: "excl-companies", origin: "exclusion", group: "exclusion list", request: "٥٠ شركة مقاولات في مصر، واستبعد الشركات اللي في الملف",
    exclusion: fixture({
      fileName: "exclude.xlsx", stage: "companies",
      entities: [{ name: "أوراسكوم للإنشاءات", domain: "orascom.example", crNumber: "12345" }, { name: "بتروجت", domain: "petrojet.example" }],
      rows: [
        { name: "أوراسكوم للإنشاءات", website: "https://www.orascom.example/en" },
        { company_name: "شركة بتروجت المحدودة", website: "petrojet.example" },
        { name: "الفتح للمقاولات", website: "alfath.example" },
        { name: "الأمل للتوريدات", website: "alamal.example", email: "nobody@gmail.example" },
      ],
      expectExcluded: [0, 1],
    }),
  },
  {
    id: "excl-people", origin: "exclusion", group: "exclusion list", request: "مديرين في شركات برمجيات في مصر مع استبعاد الشركات اللي في الملف",
    exclusion: fixture({
      fileName: "exclude.csv", stage: "people",
      entities: [{ name: "أوراسكوم للإنشاءات", domain: "orascom.example" }],
      rows: [
        // a PERSON whose own name equals a listed company is never removed by it; only the employer counts
        { name: "أوراسكوم للإنشاءات", job_title: "مدير", company_name: "الفتح للبرمجيات", company_domain: "alfath-soft.example" },
        { name: "سامي علي", job_title: "مدير", company_name: "أوراسكوم للإنشاءات", company_domain: "orascom.example" },
      ],
      expectExcluded: [1],
    }),
  },
  {
    id: "excl-enrichment", origin: "exclusion", group: "exclusion list", request: "كمّل لي مواقع الشركات اللي في الملف",
    exclusion: fixture({
      fileName: "list.xlsx", stage: "companies",
      entities: [{ name: "أوراسكوم للإنشاءات", domain: "orascom.example" }],
      rows: [{ name: "أوراسكوم للإنشاءات", website: "orascom.example" }],
    }),
  },
];

export const ALL_CASES: ReadonlyArray<ShadowCase> = [...AUDIT_CASES, ...STORED_CASES, ...UNDERSTANDING_CASES, ...EXCLUSION_CASES];

/** Regressions that were examined, explained and ACCEPTED (reviewed data; the engine never adds to this list). */
export const ACCEPTED_DIFFERENCES: ReadonlyArray<AcceptedDifference> = [];

/** The risks of controlled activation the corpus cannot show case by case. */
export const OPEN_RISKS: ReadonlyArray<Risk> = [
  {
    id: "free_rerun_carries_no_exclusion_file", severity: "high", evidence: "code_computed",
    textAr: "إعادة التشغيل المجانية من المشرف تنشئ مهمة جديدة بلا رسالة بطاقة، فلا يجد العامل قائمة الاستبعاد ولا يطبّق شيئًا ولا يقول ذلك للعميل. لا تُعِد تشغيل طلب اعتمد على ملف استبعاد قبل أن يُربط الملف بالمهمة الجديدة.",
    text: "An admin's free re-run creates a new mission with no card message; the worker therefore finds no exclusion list, applies none and says nothing. Never re-run a request that relied on a list until the list is attached to the new mission (not built).",
  },
  {
    id: "legacy_planner_not_replayable", severity: "medium", evidence: "unverified",
    textAr: "المخطِّط القديم نموذج لغوي: اختياره للمصادر في طلبات الشركات والأماكن والويب لا يمكن إعادته دون اتصال، لذلك لا توجد مقارنة مصادر لها إلا من خطط معتمدة محفوظة.",
    text: "The legacy planner is a model: its provider choice for companies, places and web requests cannot be replayed offline, so a provider comparison exists only for the stored approved plans.",
  },
  {
    id: "router_for_customers_gates_non_social", severity: "high", evidence: "code_computed",
    textAr: "تشغيل الموجِّه لحسابات العملاء قبل ترقية عائلات المصادر (الشركات، الأماكن، الويب…) بأدلة سيجعل هذه الطلبات «غير مدعومة» لهم، بينما قد يخدمها المخطِّط القديم اليوم. المسار الآمن هو حساب الاختبار أولًا.",
    text: "Turning the router on for customer accounts before the non-social families are promoted with evidence turns those requests into «unsupported» for them, while the legacy planner may serve them today. The safe path is the test account first.",
  },
  {
    id: "no_live_shadow", severity: "medium", evidence: "unverified",
    textAr: "كل ما يعرضه هذا الشاشة بلا اتصال. لم تُقارَن طلبات عملاء حقيقية حيّة ولم تُنفَّذ خطة بالموجِّه؛ المقارنة الحيّة تحتاج سقفًا يوميًا يعتمده المالك.",
    text: "Everything this screen shows is offline. No live customer request was compared and no router plan was executed; a live shadow needs a daily cap approved by the owner.",
  },
];
