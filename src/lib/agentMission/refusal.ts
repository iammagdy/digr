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

export interface PlanningCallFact { phase?: string; status: string; refused_reason?: string | null; rows_returned?: number | null }

export interface NoCardEndInput {
  /** What the model said when it ended with «cannot_serve»: a claim code checks. Null: it did not end that way. */
  claim: "unsupported" | "empty" | null;
  /** The planning run ended with no plan, no question and no ending (a crash, the turn or time limit, the memory limit). */
  endedWithoutAnswer: boolean;
  /** Why it ended without an answer (for the admin only). */
  stop?: string;
  calls: ReadonlyArray<PlanningCallFact>;
}

/** The refusals that mean the PLANNING ran out of something of ours (its source budget, the provider's daily limit, the cost recorder). */
const OWN_LIMIT = /^(over_budget|daily_cap|recording_unavailable)/;
const SOURCE_DOWN = /^source_unavailable/;

export function classifyNoCardEnd(input: NoCardEndInput): { cls: RefusalClass; reason: string } {
  if (input.endedWithoutAnswer) return { cls: "internal", reason: `no_plan(${(input.stop ?? "unknown").slice(0, 40)})` };
  const planning = input.calls.filter((c) => (c.phase ?? "planning") === "planning");
  const limit = planning.find((c) => c.status === "refused" && OWN_LIMIT.test(String(c.refused_reason ?? "")));
  if (limit) return { cls: "internal", reason: `planning_${String(limit.refused_reason).split(":")[0]}` };
  const real = planning.filter((c) => c.status === "ok" || c.status === "empty");
  // every source it tried failed or was unavailable: nothing was learned about the request, and that is ours
  if (planning.length > 0 && real.length === 0 && planning.some((c) => c.status === "failed" || SOURCE_DOWN.test(String(c.refused_reason ?? "")))) return { cls: "internal", reason: "sources_failed" };
  if (input.claim === "empty" && real.length > 0 && real.every((c) => (c.rows_returned ?? 0) === 0)) return { cls: "empty_source", reason: "sample_empty" };
  return { cls: "unsupported", reason: input.claim === "empty" ? "claimed_empty_but_rows_returned" : "not_served" };
}

export const UNSUPPORTED_AR = "مصادرنا لا تخدم هذا الطلب بالدقة المطلوبة الآن، فلم نجهّز له خطة ولم يُخصم منك شيء. يمكنك تعديل الطلب أو تجربة صيغة أخرى له.";
export const INTERNAL_PLANNING_AR = "تعذّر تجهيز خطة لطلبك بسبب حد من جانبنا، وليس لأن المصدر خالٍ من النتائج. أبلغنا فريقنا ليراجعه، ولم يُخصم منك شيء. جرّب الطلب مرة أخرى بعد قليل.";
export const EMPTY_SOURCE_AR = "بحثنا في المصادر المتاحة فلم نجد ما يطابق طلبك، ولم يُخصم منك شيء.";

/** The sentence the customer reads for a class that has no question of its own. */
export const refusalSentenceAr = (cls: Exclude<RefusalClass, "needs_detail">): string => (cls === "internal" ? INTERNAL_PLANNING_AR : cls === "empty_source" ? EMPTY_SOURCE_AR : UNSUPPORTED_AR);
