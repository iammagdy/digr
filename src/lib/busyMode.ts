import { toArabicDigits } from "./arabicDigits";

/**
 * «الخدمة مزدحمة»: the one place that decides when the platform stops starting new requests because the provider's daily allowance or its
 * real balance cannot pay for even a small one, and the plain Arabic sentence the customer reads. Pure: no I/O, no price, no cap changed.
 * The numbers it is given come from the same sources as the plan capacity gate: the daily limit left, and the provider's real balance
 * when a fresh reading exists (the estimate is never used to close the door).
 */

/** The smallest safe budget (USD) that still pays for a small request; below it no new request is started. */
export const BUSY_BELOW_SAFE_BUDGET_USD = 0.01;
/** The same 10% margin the plan gate keeps. */
export const BUSY_SAFETY_MARGIN = 0.9;

export type BusyReason = "daily_cap" | "balance";

export interface BusyInput {
  /** Daily provider limit minus today's recorded spend, in USD (never negative). */
  remainingDailyUsd: number;
  /** The provider's real balance in USD, or null when no fresh reading exists. */
  realBalanceUsd: number | null;
  /** Requests waiting or running right now. */
  queuedOrRunning: number;
}

export interface BusyState {
  busy: boolean;
  reason: BusyReason | null;
  /** Requests ahead of a new one (waiting or running now). */
  queueAhead: number;
  /** The place a new request would take if it were started after the ones ahead. */
  position: number;
  messageAr: string;
}

export const NOT_BUSY: BusyState = { busy: false, reason: null, queueAhead: 0, position: 1, messageAr: "" };

const DAILY_CAP_AR = "وصلنا إلى حد المعالجة اليومي للمصدر، لذلك لا نبدأ طلبات جديدة الآن. يتجدد الحد تلقائيًا في الصباح الباكر، وتبقى محادثاتك وخططك محفوظة.";
const BALANCE_AR = "سعة المصدر المتاحة نفدت مؤقتًا، لذلك لا نبدأ طلبات جديدة الآن. نعاود البدء فور توفرها، وتبقى محادثاتك وخططك محفوظة.";

export function evaluateBusy(input: BusyInput): BusyState {
  const remaining = Number.isFinite(input.remainingDailyUsd) ? Math.max(0, input.remainingDailyUsd) : 0;
  const real = input.realBalanceUsd !== null && Number.isFinite(input.realBalanceUsd) && input.realBalanceUsd >= 0 ? input.realBalanceUsd : null;
  const queueAhead = Math.max(0, Math.floor(Number(input.queuedOrRunning) || 0));
  const dailySafe = remaining * BUSY_SAFETY_MARGIN;
  const balanceSafe = real === null ? Number.POSITIVE_INFINITY : real * BUSY_SAFETY_MARGIN;
  const reason: BusyReason | null = dailySafe < BUSY_BELOW_SAFE_BUDGET_USD ? "daily_cap" : balanceSafe < BUSY_BELOW_SAFE_BUDGET_USD ? "balance" : null;
  if (!reason) return { ...NOT_BUSY, queueAhead, position: queueAhead + 1 };
  const position = queueAhead + 1;
  const queueLine = queueAhead > 0
    ? ` الطلبات قيد التنفيذ أو الانتظار الآن: ${toArabicDigits(queueAhead)}، وترتيب طلبك إن بدأ بعدها: ${toArabicDigits(position)}.`
    : "";
  return { busy: true, reason, queueAhead, position, messageAr: `${reason === "daily_cap" ? DAILY_CAP_AR : BALANCE_AR}${queueLine}` };
}
