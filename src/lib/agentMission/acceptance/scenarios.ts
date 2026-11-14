import { CAMPAIGN_CEILING_USD } from "./campaign";

/**
 * THE LIVE ACCEPTANCE SCENARIOS (owner-approved L1–L4, docs/intelligence/PHASE-5-CONTACTS-AND-REVERSE-LOOKUP.md §8). Definitions only: nothing here calls a provider.
 *  - L3 and L4 are the SAME request, created by the admin agent console for the agent test account: L3 with every Intelligence switch off, L4 inside a campaign (acceptance/campaign.ts). The plan is
 *    approved through the existing admin approval (test account only, the shared quote path): nothing here approves or reserves.
 *  - L1 and L2 (reverse lookups) need an e-mail and a phone number their owner has authorized for the test. None is stored here and none is accepted by the acceptance route: the owner types their own
 *    identifiers on the existing reverse-lookup screen (its $2 cap and fail-closed audit apply). Until then they are blocked.
 */
export type ScenarioId = "L1" | "L2" | "L3" | "L4";

export interface Scenario {
  id: ScenarioId;
  titleAr: string;
  /** The request the admin console creates (L3/L4 only). */
  requestAr: string | null;
  /** The approved provider-spend ceiling of this scenario (USD); the campaign total is `CAMPAIGN_CEILING_USD`. */
  ceilingUsd: number;
  /** Where it runs. */
  route: "agent_console" | "reverse_lookup";
  /** Whether it runs with the campaign's switches on. */
  intelligence: boolean;
  checksAr: string[];
}

export const B2B_ACCEPTANCE_REQUEST_AR = "عايز شركتين مدرجتين في البورصة المصرية ومقرهم الرئيسي في القاهرة، ومن كل شركة صانع قرار واحد (اسمه ومسماه الوظيفي)، مع إيميل العمل ورقم التواصل المهني لو متاحين.";

export const SCENARIOS: readonly Scenario[] = [
  { id: "L1", titleAr: "بحث عكسي ببريد عمل مصرّح به", requestAr: null, ceilingUsd: 0.01, route: "reverse_lookup", intelligence: false, checksAr: ["الهوية والشركة صحيحتان أو «لا نتيجة»", "لا هوية مختلقة", "صف في سجل المراجعة بالتكلفة الحقيقية"] },
  { id: "L2", titleAr: "بحث عكسي برقم هاتف مصرّح به", requestAr: null, ceilingUsd: 0.001, route: "reverse_lookup", intelligence: false, checksAr: ["الدولة وصيغة الرقم متوافقتان", "لا تطابق هوية بلا دليل", "صف في سجل المراجعة"] },
  { id: "L3", titleAr: "بحث B2B حقيقي بالمسار الحالي", requestAr: B2B_ACCEPTANCE_REQUEST_AR, ceilingUsd: 0.1, route: "agent_console", intelligence: false, checksAr: ["شركتان حقيقيتان بمصدر", "الشخص يعمل في شركته", "بريد العمل ليس بريدًا شخصيًا", "حالة التحقق", "الملفات Excel/CSV/PDF", "المسلَّم مقابل المطلوب", "الحجز والخصم والإفراج"] },
  { id: "L4", titleAr: "نفس البحث بمسار الذكاء", requestAr: B2B_ACCEPTANCE_REQUEST_AR, ceilingUsd: 0.1, route: "agent_console", intelligence: true, checksAr: ["الفهم واكتشاف القدرات والتوجيه", "SourceGateway ومصدر كل صف", "الالتزام بالنطاق المعتمد", "المقارنة مع L3"] },
];

/** The four ceilings add up to no more than the approved campaign ceiling (a test pins it). */
export const SCENARIOS_TOTAL_USD = SCENARIOS.reduce((s, x) => s + x.ceilingUsd, 0);
export const scenarioOf = (id: unknown): Scenario | null => SCENARIOS.find((s) => s.id === id) ?? null;
export { CAMPAIGN_CEILING_USD };
