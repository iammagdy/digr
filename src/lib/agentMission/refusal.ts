/**
 * WHY A MISSION ENDED WITHOUT A CARD, in exactly one of four classes, decided by CODE from what the planning really did (the calls and how it ended), never from the model's own wording:
 *
 *   needs_detail  the request lacks one essential detail: the agent asks ONE question with ready answers (status «needs_input»; the question tool refuses a question without 2 to 4 answers);
 *   unsupported   our sources cannot serve this request with the precision asked (the catalog has no source for it, or what the sources returned does not fit it): said as it is;
 *   internal      OUR planning failed (it ran out of its own budget or the provider's daily limit, every source it tried failed or was unavailable, or it ended without an answer): the hold is not taken, the admin is flagged,
 *                 the customer is told it was ours and is never told «nothing found»;
 *   empty_source  the source truly has nothing for this request: only when a REAL sample call returned no item and no call returned any.
 *
 * Each has its own Arabic sentence. Pure: no I/O.
 */
export type RefusalClass = "needs_detail" | "unsupported" | "internal" | "empty_source";

export interface PlanningCallFact { phase?: string; endpoint_id?: string; status: string; refused_reason?: string | null; rows_returned?: number | null }

export interface NoCardEndInput {
  /** What the model said when it ended with «cannot_serve»: a claim code checks. Null: it did not end that way. */
  claim: "unsupported" | "empty" | null;
  /** The planning run ended with no plan, no question and no ending (a crash, the turn or time limit, the memory limit). */
  endedWithoutAnswer: boolean;
  /** Why it ended without an answer (for the admin only). */
  stop?: string;
  calls: ReadonlyArray<PlanningCallFact>;
  /**
   * PLANNER RELIABILITY (docs/DIGER-INTELLIGENCE-FINAL-ACCEPTANCE.md): the plans the planner proposed that code refused, and what the LAST refusal was about. «formal»: the plan's form (yield_from, sample rows, columns, filters,
   * capabilities); «data»: what the sources returned contradicts the request (no sampled row matches the stage's rule). Absent: no plan was proposed.
   */
  planRejections?: { count: number; last: "formal" | "data" };
  /** DT-20261118-09 F2: the planner understood the people of the companies, and the endpoint ids of the catalog's people-of-company tools (from the catalog's own capability metadata, never a name list). */
  peopleAsked?: boolean;
  peopleEndpointIds?: ReadonlySet<string>;
}

/** The refusals that mean the PLANNING ran out of something of ours (its source budget, the provider's daily limit, the cost recorder). */
// P0 (15 Nov 2026, msn_8824508f840f703dee69): a call refused because OUR request lacked an input the source requires (an X search with no query) is our malformed request, never «our sources do not serve this»
const OWN_LIMIT = /^(over_budget|daily_cap|recording_unavailable|missing_params)/;
const SOURCE_DOWN = /^source_unavailable/;

export function classifyNoCardEnd(input: NoCardEndInput): { cls: RefusalClass; reason: string } {
  if (input.endedWithoutAnswer) return { cls: "internal", reason: `no_plan(${(input.stop ?? "unknown").slice(0, 40)})` };
  const planning = input.calls.filter((c) => (c.phase ?? "planning") === "planning");
  const limit = planning.find((c) => c.status === "refused" && OWN_LIMIT.test(String(c.refused_reason ?? "")));
  if (limit) return { cls: "internal", reason: `planning_${String(limit.refused_reason).split(":")[0]}` };
  const real = planning.filter((c) => c.status === "ok" || c.status === "empty");
  // DT-20261118-09 F2: the people were asked for and no people tool answered (every call failed or was refused, or none was made): that is a failure to reach them, never «they were not found» and never «not served».
  // A catalog with no people tool says nothing about them (an empty set is no evidence).
  const peopleIds = input.peopleEndpointIds;
  // FIX1 (Gate 2 P1-1): only when the COMPANIES answered with rows (something real was found for the people to hang on); a companies search that was empty or failed, or no call at all, keeps its own class
  const isPeople = (c: PlanningCallFact): boolean => c.endpoint_id !== undefined && peopleIds !== undefined && peopleIds.has(c.endpoint_id);
  if (input.peopleAsked && peopleIds && peopleIds.size > 0 && planning.some((c) => c.status === "ok" && (c.rows_returned ?? 0) > 0 && !isPeople(c)) && !planning.some((c) => c.endpoint_id !== undefined && peopleIds.has(c.endpoint_id) && (c.status === "ok" || c.status === "empty"))) {
    return { cls: "internal", reason: planning.some((c) => c.endpoint_id !== undefined && peopleIds.has(c.endpoint_id)) ? "people_sources_failed" : "people_sources_not_tried" };
  }
  // every source it tried failed or was unavailable: nothing was learned about the request, and that is ours
  if (planning.length > 0 && real.length === 0 && planning.some((c) => c.status === "failed" || SOURCE_DOWN.test(String(c.refused_reason ?? "")))) return { cls: "internal", reason: "sources_failed" };
  if (input.claim === "empty" && real.length > 0 && real.every((c) => (c.rows_returned ?? 0) === 0)) return { cls: "empty_source", reason: "sample_empty" };
  // the sources gave rows and the planner proposed plans that code refused for their FORM, then gave up: the data may well be available, the failure is OUR planner's, never «our sources do not serve this» (defect C)
  if (input.planRejections && input.planRejections.count > 0 && input.planRejections.last === "formal" && real.some((c) => (c.rows_returned ?? 0) > 0)) return { cls: "internal", reason: `plan_invalid_after_${Math.min(input.planRejections.count, 99)}_rejections` };
  return { cls: "unsupported", reason: input.claim === "empty" ? "claimed_empty_but_rows_returned" : "not_served" };
}

export const UNSUPPORTED_AR = "مصادرنا لا تخدم هذا الطلب بالدقة المطلوبة الآن، فلم نجهّز له خطة ولم يُخصم منك شيء. يمكنك تعديل الطلب أو تجربة صيغة أخرى له.";
export const INTERNAL_PLANNING_AR = "تعذّر تجهيز خطة لطلبك بسبب حد من جانبنا، وليس لأن المصدر خالٍ من النتائج. أبلغنا فريقنا ليراجعه، ولم يُخصم منك شيء. جرّب الطلب مرة أخرى بعد قليل.";
export const EMPTY_SOURCE_AR = "بحثنا في المصادر المتاحة فلم نجد ما يطابق طلبك، ولم يُخصم منك شيء.";

/** The sentence the customer reads for a class that has no question of its own. */
export const refusalSentenceAr = (cls: Exclude<RefusalClass, "needs_detail">): string => (cls === "internal" ? INTERNAL_PLANNING_AR : cls === "empty_source" ? EMPTY_SOURCE_AR : UNSUPPORTED_AR);

/** DT-20261118-09 F2: what the customer reads when the people sources could not be reached: ours, said as it is (passes checkCustomerText; nothing is held in a planning that ended without a card). */
export const PEOPLE_UNAVAILABLE_AR = "تعذّر الوصول إلى مصدر بيانات مسؤولي الشركات الآن، وليس لأنهم غير موجودين. أبلغنا فريقنا ليراجعه، ولم يُخصم منك شيء. جرّب الطلب مرة أخرى بعد قليل.";
/** The sentence of a no-card end: the people sentence when the reason is about the people sources, else the class's own. */
export const noCardSentenceAr = (v: { cls: RefusalClass; reason: string }): string => (v.cls === "internal" && /^people_sources_/.test(v.reason) ? PEOPLE_UNAVAILABLE_AR : refusalSentenceAr(v.cls as Exclude<RefusalClass, "needs_detail">));
