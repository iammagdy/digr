import { toArabicDigits } from "../arabicDigits";

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

/** «تم تسليم ٤ من ٥ سجلاً»: the delivered count against the asked count, the same everywhere. */
export function deliveredOfRequestedAr(delivered: number, requested: number, noun = "سجلاً"): string {
  return `تم تسليم ${toArabicDigits(delivered)} من ${toArabicDigits(requested)} ${noun}`;
}

export const REQUEST_STATUS_LABEL_AR: Record<RequestKind, string> = {
  done: "مكتمل",
  partial: PARTIAL_STATUS_AR,
  running: "قيد التنفيذ",
  refunded: "تعذر التنفيذ · حجز مؤقت مُحرَّر",
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

/** "تم تسليم ٤ من ٥ سجلات" for a partial run. */
export function partialDeliveryText(delivered: number, requested: number): string {
  return `${deliveredOfRequestedAr(delivered, requested)}؛ الخصم يقتصر على السجلات المسلّمة المطابقة.`;
}

/** For a refunded run that did collect rows: they are kept for a retry that fetches only the rest. */
export function collectedBeforeStopText(collected: number, requested: number): string {
  return `جُمع ${toArabicDigits(collected)} من ${toArabicDigits(requested)} سجلاً قبل التوقف ولم يُخصم أي رصيد؛ تُستكمل عند إعادة المحاولة.`;
}

/**
 * A request that finished (fully or partly) with ZERO delivered records has no data file to offer: its card shows zero files and says so (the
 * results panel follows the same rule). An absent delivered count is unknown, never zero.
 */
export function deliveredNothing(input: { kind: RequestKind; delivered?: number | null; deliveredKnown?: boolean }): boolean {
  return (input.kind === "done" || input.kind === "partial") && input.deliveredKnown === true && (Number(input.delivered) || 0) === 0;
}
