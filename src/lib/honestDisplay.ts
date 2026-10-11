/**
 * Honest display rules for the Digr redesign.
 *
 * Pure, dependency-free helpers encoding the data-honesty invariants:
 *  - a failed balance request never presents as a zero balance
 *  - derived amounts (EGP equivalents) are suppressed when the balance is unknown
 *  - job totals come from the query response's own `total`, never from a page size
 *  - activity stages are never marked complete without recorded evidence
 *  - event histories loaded with a limit are always labeled with their scope
 */
export type BalanceStatus = "loading" | "ready" | "failed";

export interface BalanceView {
  status: BalanceStatus;
  /** Authoritative summed value once the query succeeds. Null while loading or failed. */
  value: number | null;
}

export function balanceLoading(): BalanceView {
  return { status: "loading", value: null };
}

export function balanceReady(total: number): BalanceView {
  return { status: "ready", value: total };
}

export function balanceFailed(): BalanceView {
  return { status: "failed", value: null };
}

/** Text for the balance figure. Genuine zero renders as zero; failure never renders as zero. */
export function balanceText(view: BalanceView): string {
  if (view.status === "loading") return "…";
  if (view.status === "failed") return "غير متاح";
  return (view.value ?? 0).toLocaleString("ar-EG");
}

/** Derived amounts (EGP equivalents, estimates) may only render from a real balance. */
export function showDerivedAmounts(view: BalanceView): boolean {
  return view.status === "ready";
}

/**
 * Extract the authoritative total from an Appwrite listDocuments-style response.
 * Returns null when the response carries no usable total — callers must then
 * render an unavailable state, never the page length as a total.
 */
export function jobTotalFromResponse(total: unknown): number | null {
  return typeof total === "number" && Number.isFinite(total) && total >= 0 ? total : null;
}

/** A job count stat is only claimable when the response total exists. */
export function jobCountText(total: number | null): string {
  return total === null ? "غير متاح" : total.toLocaleString("ar-EG");
}

export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

/**
 * Honest waiting text when a job has no recorded events yet.
 * The backend-confirmed status badge is the only claim made here —
 * no stage is ever marked complete from assumptions.
 */
export function timelineWaitingText(status: JobStatus): string {
  switch (status) {
    case "queued":
      return "الطلب في قائمة الانتظار — لم تُسجَّل أي مرحلة بعد.";
    case "running":
      return "التنفيذ جارٍ — بانتظار أول حدث مسجَّل من الخادم.";
    case "done":
      return "اكتمل التنفيذ وفق سجلّ الخادم — لا توجد أحداث مسجَّلة لعرضها.";
    case "failed":
      return "توقّف التنفيذ — لا توجد أحداث مسجَّلة لعرضها.";
    case "cancelled":
      return "أُلغي الطلب — لا توجد أحداث مسجَّلة لعرضها.";
  }
}

/** Maximum number of job events loaded in one read. Public so UI labels stay in sync. */
export const EVENT_HISTORY_LIMIT = 20;

/**
 * Scope label for a partially loaded event history.
 * Must accompany any event list fetched with a limit.
 */
export function eventHistoryScopeLabel(limit: number = EVENT_HISTORY_LIMIT): string {
  return `أحدث ${limit.toLocaleString("ar-EG")} حدثًا مسجَّلًا`;
}

/**
 * Order a desc-fetched page of events back into chronological display order.
 * Fetching `orderDesc` + limit keeps the LATEST events; reversing restores reading order.
 */
export function chronological<T>(descDocs: T[]): T[] {
  return [...descDocs].reverse();
}

/**
 * Success text for the paid methodology rewrite.
 * A monetary claim is made ONLY from a trustworthy server-reported charge.
 * When the server value is missing or invalid, the message stays generic
 * and names no amount — never a hardcoded figure.
 */
function trustworthyAmount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function methodologyAlertText(chargedPoints: unknown): string {
  const charged = trustworthyAmount(chargedPoints);
  if (charged === null) return "تمت صياغة المنهجية الأكاديمية بنجاح.";
  return `تمت صياغة المنهجية الأكاديمية بنجاح واقتطاع ${charged.toLocaleString("ar-EG")} نقطة من الرصيد.`;
}

export function methodologyMessageText(
  chargedPoints: unknown,
  remainingBalance: unknown,
  methodologyText: string,
): string {
  const charged = trustworthyAmount(chargedPoints);
  const balance = trustworthyAmount(remainingBalance);
  if (charged === null || balance === null) {
    return `تم توثيق المنهجية الأكاديمية بنجاح:\n\n${methodologyText}`;
  }
  return `تم توثيق المنهجية الأكاديمية بنجاح وخصم ${charged} نقاط (رصيدك الحالي: ${balance} نقطة):\n\n${methodologyText}`;
}
