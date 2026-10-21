import { pointsAr } from "./pointsFormat";
/**
 * Honest display rules for the Diger redesign.
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

/* ------------------------------------------------------------------ */
/* Shared Numeral & Date Formatters (Consistent Arabic-Indic Digits)   */
/* ------------------------------------------------------------------ */

export const ARABIC_LOCALE = "ar-EG-u-nu-arab";

/**
 * Format any number consistently using Arabic-Indic digits (٠-٩).
 */
export function formatNumber(
  value: number | bigint,
  options?: Intl.NumberFormatOptions
): string {
  return new Intl.NumberFormat(ARABIC_LOCALE, options).format(value);
}

/**
 * Format points count with consistent Arabic-Indic digits.
 */
export function formatPoints(points: number): string {
  const abs = Math.abs(points);
  const unit = abs >= 3 && abs <= 10 ? "نقاط" : "نقطة";
  return `${formatNumber(points)} ${unit}`;
}

/**
 * Format Egyptian Pounds (EGP) currency with consistent Arabic-Indic digits.
 */
export function formatCurrency(
  amount: number,
  options?: { minimumFractionDigits?: number; maximumFractionDigits?: number }
): string {
  const min = options?.minimumFractionDigits ?? 2;
  const max = options?.maximumFractionDigits ?? 2;
  return `${formatNumber(amount, { minimumFractionDigits: min, maximumFractionDigits: max })} ج.م`;
}

/**
 * Format date consistently in Arabic with Arabic-Indic digits.
 */
export function formatDate(
  date: string | number | Date,
  options?: Intl.DateTimeFormatOptions
): string {
  try {
    const d = typeof date === "string" || typeof date === "number" ? new Date(date) : date;
    if (Number.isNaN(d.getTime())) return "";
    const opts: Intl.DateTimeFormatOptions = options ?? {
      day: "numeric",
      month: "long",
      year: "numeric",
    };
    return new Intl.DateTimeFormat(ARABIC_LOCALE, opts).format(d);
  } catch {
    return "";
  }
}

/**
 * Format time consistently in Arabic with Arabic-Indic digits.
 */
export function formatTime(
  date: string | number | Date,
  options?: Intl.DateTimeFormatOptions
): string {
  try {
    const d = typeof date === "string" || typeof date === "number" ? new Date(date) : date;
    if (Number.isNaN(d.getTime())) return "";
    const opts: Intl.DateTimeFormatOptions = options ?? {
      hour: "2-digit",
      minute: "2-digit",
    };
    return new Intl.DateTimeFormat(ARABIC_LOCALE, opts).format(d);
  } catch {
    return "";
  }
}

/** Text for the balance figure. Genuine zero renders as zero; failure never renders as zero. */
export function balanceText(view: BalanceView): string {
  if (view.status === "loading") return "…";
  if (view.status === "failed") return "غير متاح";
  return formatNumber(view.value ?? 0);
}

/** Derived amounts (EGP equivalents, estimates) may only render from a real balance. */
export function showDerivedAmounts(view: BalanceView): boolean {
  return view.status === "ready";
}

/**
 * Extract the authoritative total from a list/query response.
 * Returns null when the response carries no usable total — callers must then
 * render an unavailable state, never the page length as a total.
 */
export function jobTotalFromResponse(total: unknown): number | null {
  return typeof total === "number" && Number.isFinite(total) && total >= 0 ? total : null;
}

/** A job count stat is only claimable when the response total exists. */
export function jobCountText(total: number | null): string {
  return total === null ? "غير متاح" : formatNumber(total);
}

export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";
export type JobStatusTone = "neutral" | "info" | "success" | "warning" | "danger" | "accent";

/* ------------------------------------------------------------------ */
/* Shared Job Status Label & Tone Map (Strict Arabic, No English)    */
/* ------------------------------------------------------------------ */

export const JOB_STATUS_LABEL_MAP: Record<JobStatus, string> = {
  queued: "في الانتظار",
  running: "قيد التنفيذ",
  done: "مكتمل",
  failed: "متعثر",
  cancelled: "ملغي",
};

export const JOB_STATUS_TONE_MAP: Record<JobStatus, JobStatusTone> = {
  queued: "warning",
  running: "info",
  done: "success",
  failed: "danger",
  cancelled: "neutral",
};

/**
 * Maps any job status string to the unified Arabic label.
 * Never leaks English ("queued", "done", "running", "failed") to customers.
 */
export function formatJobStatus(status: string | undefined | null): string {
  if (!status) return "غير معروف";
  const s = status.toLowerCase();
  if (s in JOB_STATUS_LABEL_MAP) return JOB_STATUS_LABEL_MAP[s as JobStatus];
  if (s === "completed") return JOB_STATUS_LABEL_MAP.done;
  if (s === "pending") return JOB_STATUS_LABEL_MAP.queued;
  if (s === "canceled") return JOB_STATUS_LABEL_MAP.cancelled;
  if (s === "partial") return "مكتمل جزئيًا";
  return "غير معروف";
}

/**
 * Maps any job status string to the UI tone.
 */
export function formatJobStatusTone(status: string | undefined | null): JobStatusTone {
  if (!status) return "neutral";
  const s = status.toLowerCase();
  if (s in JOB_STATUS_TONE_MAP) return JOB_STATUS_TONE_MAP[s as JobStatus];
  if (s === "completed") return "success";
  if (s === "pending") return "warning";
  if (s === "canceled") return "neutral";
  if (s === "partial") return "warning";
  return "neutral";
}

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
      return "التنفيذ جارٍ — بانتظار أول حدث مسجَّل من النظام.";
    case "done":
      return "اكتمل التنفيذ وفق سجلّ النظام — لا توجد أحداث مسجَّلة لعرضها.";
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
  return `أحدث ${formatNumber(limit)} حدثًا مسجَّلًا`;
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
  return `تمت صياغة المنهجية الأكاديمية بنجاح واقتطاع ${pointsAr(charged, formatNumber)} من الرصيد.`;
}

export function methodologyMessageText(
  chargedPoints: unknown,
  remainingBalance: unknown,
  methodologyText: string,
): string {
  const charged = trustworthyAmount(chargedPoints);
  const balance = trustworthyAmount(remainingBalance);
  // Never a storage link in the conversation: the file is downloaded from the «الملفات» tab, whose button reads the purchase from the ledger.
  const download = "\n\nتجد زر «تحميل المنهجية» في تبويب «الملفات» بلوحة النتائج.";
  if (charged === null || balance === null) {
    return `تم توثيق المنهجية الأكاديمية بنجاح:\n\n${methodologyText}${download}`;
  }
  return `تم توثيق المنهجية الأكاديمية بنجاح وخصم ${formatNumber(charged)} نقاط (رصيدك الحالي: ${pointsAr(balance, formatNumber)}):\n\n${methodologyText}${download}`;
}

/* ------------------------------------------------------------------ */
/* Instapay Configuration & Safety Checks                             */
/* ------------------------------------------------------------------ */

const PLACEHOLDER_HANDLES = new Set(["diger@instapay", "digr@instapay", "placeholder", "your_handle", "example@instapay"]);
const PLACEHOLDER_PHONES = new Set(["01000000000", "010xxxxxxxx", "placeholder", "00000000000", "1234567890"]);

/**
 * Checks whether Instapay credentials are legitimately configured.
 * Returns false if missing, blank, or pointing to known demo/placeholder values.
 */
export function isInstapayAvailable(handle?: string | null, phone?: string | null): boolean {
  const h = handle?.trim().toLowerCase();
  const p = phone?.trim().toLowerCase();
  if (!h || !p) return false;
  if (PLACEHOLDER_HANDLES.has(h) || h.includes("placeholder") || h.includes("example")) return false;
  if (PLACEHOLDER_PHONES.has(p) || p.includes("placeholder") || /^0+$/.test(p)) return false;
  return true;
}

/** The IPA (instant payment address) alone: configured and not a demo value. */
export function isIpaAvailable(handle?: string | null): boolean {
  const h = handle?.trim().toLowerCase();
  if (!h) return false;
  return !(PLACEHOLDER_HANDLES.has(h) || h.includes("placeholder") || h.includes("example"));
}

/* ------------------------------------------------------------------ */
/* Wallet Ledger Row Grouping (Net Job Display)                        */
/* ------------------------------------------------------------------ */

export interface RawLedgerEntry {
  $id: string;
  type?: string;
  delta: number;
  reference?: string;
  referenceId?: string;
  referenceType?: string;
  note?: string;
  description?: string;
  jobId?: string;
  createdAt: string;
  runningBalance?: number;
  balanceAfter?: number;
}

export interface GroupedLedgerRow {
  key: string;
  isJob: boolean;
  isJobGroup: boolean;
  jobId?: string;
  title: string;
  netDelta: number;
  delta: number;
  runningBalance: number;
  createdAt: string;
  movements: RawLedgerEntry[];
}

/**
 * Groups multiple ledger movements belonging to the same job (hold, release, charge)
 * into a single net customer-facing row with expandable breakdown.
 */
export function groupLedgerEntries(entries: RawLedgerEntry[]): GroupedLedgerRow[] {
  const jobGroups = new Map<string, RawLedgerEntry[]>();
  const singleEntries: { order: number; entry: RawLedgerEntry }[] = [];
  const jobLatestTime = new Map<string, number>();

  entries.forEach((entry, idx) => {
    const jId =
      entry.jobId ||
      (entry.referenceId && entry.referenceId.match(/^(?:res|rel|chg)_(.+)$/)?.[1]) ||
      (entry.reference && entry.reference.match(/^(?:res|rel|chg)_(.+)$/)?.[1]) ||
      entry.$id.match(/^(?:res|rel|chg)_(.+)$/)?.[1];

    if (jId) {
      const list = jobGroups.get(jId) || [];
      list.push({ ...entry, jobId: jId });
      jobGroups.set(jId, list);
      const time = new Date(entry.createdAt).getTime();
      const currentMax = jobLatestTime.get(jId) || 0;
      if (time > currentMax) jobLatestTime.set(jId, time);
    } else {
      singleEntries.push({ order: idx, entry });
    }
  });

  const result: GroupedLedgerRow[] = [];

  jobGroups.forEach((movs, jobId) => {
    movs.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    const latest = movs[movs.length - 1];
    const netDelta = movs.reduce((sum, m) => sum + m.delta, 0);

    let handleOrTitle = "";
    for (const m of movs) {
      const text = m.note || m.description || "";
      if (text) {
        const atMatch = text.match(/@[\w.-]+/);
        if (atMatch) {
          handleOrTitle = `تحليل ${atMatch[0]}`;
          break;
        }
        const parenMatch = text.match(/\(([^)]+)\)/);
        if (parenMatch) {
          handleOrTitle = parenMatch[1];
          break;
        }
        if (!handleOrTitle) handleOrTitle = text;
      }
    }
    if (!handleOrTitle) handleOrTitle = `طلب #${jobId.slice(0, 8)}`;

    let actionPrefix = "";
    if (netDelta < 0) {
      actionPrefix = `خصم ${formatPoints(Math.abs(netDelta))}`;
    } else if (netDelta === 0) {
      actionPrefix = `استرداد كامل (٠ نقطة)`;
    } else {
      actionPrefix = `إيداع ${formatPoints(netDelta)}`;
    }
    const title = `${actionPrefix} · ${handleOrTitle}`;

    result.push({
      key: `job_${jobId}`,
      isJob: true,
      isJobGroup: true,
      jobId,
      title,
      netDelta,
      delta: netDelta,
      runningBalance: latest.runningBalance ?? latest.balanceAfter ?? 0,
      createdAt: latest.createdAt,
      movements: movs,
    });
  });

  singleEntries.forEach(({ entry }) => {
    const fallbackTitle =
      entry.note ||
      entry.description ||
      (entry.reference ? `شحن رصيد (${entry.reference})` : entry.type === "topup" ? "شحن رصيد" : entry.type || "حركة رصيد");
    result.push({
      key: entry.$id,
      isJob: false,
      isJobGroup: false,
      title: fallbackTitle,
      netDelta: entry.delta,
      delta: entry.delta,
      runningBalance: entry.runningBalance ?? entry.balanceAfter ?? 0,
      createdAt: entry.createdAt,
      movements: [entry],
    });
  });

  result.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return result;
}

/**
 * A finished run must not keep saying it is still working. An event that ends with an ellipsis is an in-progress line
 * («جاري تجهيز ملفات النتائج…», «…جاري بدء معالجة الطلب...»); once the job reached a final state it is superseded by the
 * completion line, so it is dropped. Page summaries and every other recorded event stay.
 */
export function settleTimelineEvents<T extends { textAr: string }>(events: T[], status: string | undefined | null): T[] {
  const terminal = status === "done" || status === "failed" || status === "cancelled" || status === "completed" || status === "partial";
  if (!terminal) return events;
  return events.filter((event) => !/(?:\.{3}|…)\s*$/u.test((event.textAr || "").trim()));
}
