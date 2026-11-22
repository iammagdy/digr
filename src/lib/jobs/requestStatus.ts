import { toArabicDigits } from "../arabicDigits";
import { countPlainAr, type CountKind } from "../planCounts";

/**
 * The one place that decides how a request is described to the customer.
 * "مكتمل" only when the requested volume was delivered; a finished run that
 * delivered less is "مكتمل جزئياً" and states requested vs delivered; a failed,
 * cancelled or refused run is refunded in full (the worker never charges a run
 * that did not settle), so it is "refunded" whatever it collected on the way.
 */
export type RequestKind = "done" | "partial" | "running" | "refunded";

/**
 * THE words for a request that finished with fewer records than asked, used on «طلباتي», in the chat, in the notices and in the e-mails:
 * the status is «مكتمل جزئيًا», the sentence about it is «اكتمل طلبك جزئيًا», and the count is «تم تسليم X من Y سجلاً».
 */
export const PARTIAL_STATUS_AR = "مكتمل جزئيًا";
export const PARTIAL_SENTENCE_AR = "اكتمل طلبك جزئيًا";

/**
 * «تم تسليم ٤ من ٥ سجلات»، «تم تسليم ٨ من ١٠ سجلات»، «تم تسليم ٤٠ من ١٠٠ سجل»: the delivered count against the asked count, the same everywhere.
 * The noun is the asked count's, written by the ONE plural rule (`countPlainAr`), never a fixed «سجلاً».
 */
export function deliveredOfRequestedAr(delivered: number, requested: number, kind: CountKind = "records"): string {
  return `تم تسليم ${toArabicDigits(delivered)} من ${countPlainAr(requested, kind)}`;
}

export const REQUEST_STATUS_LABEL_AR: Record<RequestKind, string> = {
  done: "مكتمل",
  partial: PARTIAL_STATUS_AR,
  running: "قيد التنفيذ",
  refunded: "تعذر التنفيذ · رجع لمحفظتك",
};

const FINISHED = new Set(["done", "completed"]);
const NOT_DELIVERED = new Set(["failed", "cancelled", "canceled", "refused"]);

export function resolveRequestKind(input: {
  status: unknown;
  delivered?: number | null;
  requested?: number | null;
}): RequestKind {
  const status = String(input.status || "").toLowerCase();
  if (FINISHED.has(status)) {
    const requested = Number(input.requested) || 0;
    const delivered = Number(input.delivered) || 0;
    return requested > 0 && delivered < requested ? "partial" : "done";
  }
  if (NOT_DELIVERED.has(status)) return "refunded";
  return "running";
}

/**
 * THE JOB AS A SCREEN READS IT, when the job belongs to a mission (DT-20261119-06 PART B, D-0117). The job's `delivered_units` is the count the settlement CHARGED (the billable rows: a person with none of the asked contacts is delivered but not
 * charged), and a mission delivered with nothing to charge releases its job (`failed`). Both are money facts, not delivery facts: the delivery is the mission's own count and status (precedent: walletLine.ts jobFactsForWallet).
 * A mission with no recorded count, or one that did not complete with rows, leaves the job as it is.
 */
export function jobViewWithMission(job: { status?: unknown; delivered_units?: unknown }, mission: { status?: unknown; delivered_units?: unknown } | null | undefined): { status: string; delivered: number } {
  const jobDelivered = Number(job.delivered_units) || 0;
  const missionDelivered = mission && typeof mission.delivered_units === "number" && Number.isFinite(mission.delivered_units) ? mission.delivered_units : null;
  if (missionDelivered === null) return { status: String(job.status ?? ""), delivered: jobDelivered };
  return { status: String(mission?.status) === "completed" && missionDelivered > 0 ? "completed" : String(job.status ?? ""), delivered: missionDelivered };
}

/** "تم تسليم ٤ من ٥ سجلات" for a partial run. */
export function partialDeliveryText(delivered: number, requested: number): string {
  return `${deliveredOfRequestedAr(delivered, requested)}؛ الخصم يقتصر على السجلات المسلّمة المطابقة.`;
}

/** For a refunded run that did collect rows: they are kept for a retry that fetches only the rest. */
export function collectedBeforeStopText(collected: number, requested: number): string {
  return `جُمع ${toArabicDigits(collected)} من ${countPlainAr(requested, "records")} قبل التوقف ولم يُخصم أي رصيد؛ تُستكمل عند إعادة المحاولة.`;
}

/**
 * A request that finished (fully or partly) with ZERO delivered records has no data file to offer: its card shows zero files and says so (the
 * results panel follows the same rule). An absent delivered count is unknown, never zero.
 */
export function deliveredNothing(input: { kind: RequestKind; delivered?: number | null; deliveredKnown?: boolean }): boolean {
  return (input.kind === "done" || input.kind === "partial") && input.deliveredKnown === true && (Number(input.delivered) || 0) === 0;
}

export function deliveredChargedLineAr(input: { delivered: number; charged: number; concise?: boolean }): string {
  const delivered = Math.max(0, Math.round(input.delivered));
  const charged = Math.max(0, Math.round(input.charged));
  const unmatched = Math.max(0, delivered - charged);
  const dStr = delivered === 1 ? "عنصرًا واحدًا" : delivered === 2 ? "عنصرين" : delivered <= 10 ? `${toArabicDigits(delivered)} عناصر` : `${toArabicDigits(delivered)} عنصرًا`;
  const uStr = unmatched === 1 ? "عنصرًا واحدًا" : unmatched === 2 ? "عنصرين" : unmatched <= 10 ? `${toArabicDigits(unmatched)} عناصر` : `${toArabicDigits(unmatched)} عنصرًا`;
  if (input.concise) {
    return `استلمت ${toArabicDigits(delivered)}، ودُفع ثمن ${toArabicDigits(charged)} لعدم توفر بيانات الاتصال في ${unmatched === 1 ? "عنصر واحد" : uStr}.`;
  }
  const uClause = unmatched === 1 ? "عنصرًا واحدًا لم يحتوِ" : `${uStr} لم تحتوِ`;
  return `تم تسليم ${dStr}، وحُسبت تكلفة ${toArabicDigits(charged)} فقط لأن ${uClause} على بيانات الاتصال المطلوبة.`;
}
