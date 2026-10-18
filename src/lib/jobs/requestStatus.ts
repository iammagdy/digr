import { toArabicDigits } from "../arabicDigits";

/**
 * The one place that decides how a request is described to the customer.
 * "مكتمل" only when the requested volume was delivered; a finished run that
 * delivered less is "مكتمل جزئياً" and states requested vs delivered; a failed,
 * cancelled or refused run is refunded in full (the worker never charges a run
 * that did not settle), so it is "refunded" whatever it collected on the way.
 */
export type RequestKind = "done" | "partial" | "running" | "refunded";

export const REQUEST_STATUS_LABEL_AR: Record<RequestKind, string> = {
  done: "مكتمل",
  partial: "مكتمل جزئياً",
  running: "قيد التنفيذ",
  refunded: "تعذر التنفيذ · رصيدك مسترد",
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
  return `تم تسليم ${toArabicDigits(delivered)} من ${toArabicDigits(requested)} سجلاً؛ الخصم يقتصر على السجلات المسلّمة المطابقة.`;
}

/** For a refunded run that did collect rows: they are kept for a retry that fetches only the rest. */
export function collectedBeforeStopText(collected: number, requested: number): string {
  return `جُمع ${toArabicDigits(collected)} من ${toArabicDigits(requested)} سجلاً قبل التوقف ولم يُخصم أي رصيد؛ تُستكمل عند إعادة المحاولة.`;
}
