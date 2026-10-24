import { formatAr } from "@/lib/arabicDigits";
import type { VisitorSummary } from "@/lib/analytics/summary";

export interface VisitorsResponse {
  available: boolean;
  summary?: VisitorSummary;
  /** Accounts created and requests submitted in the range, counted from their own tables (null when a count could not be read). */
  newAccounts?: number | null;
  submittedRequests?: number | null;
}

/** «٣ دقائق و١٢ ثانية»; a dash when no visit has a recorded time. */
export function durationAr(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return "—";
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  const minuteWord = minutes === 1 ? "دقيقة" : minutes === 2 ? "دقيقتان" : minutes >= 3 && minutes <= 10 ? "دقائق" : "دقيقة";
  const secondWord = rest === 1 ? "ثانية" : rest === 2 ? "ثانيتان" : rest >= 3 && rest <= 10 ? "ثوانٍ" : "ثانية";
  if (minutes === 0) return `${formatAr(rest)} ${secondWord}`;
  const minutesText = minutes === 1 ? "دقيقة واحدة" : minutes === 2 ? "دقيقتان" : `${formatAr(minutes)} ${minuteWord}`;
  return rest === 0 ? minutesText : `${minutesText} و${formatAr(rest)} ${secondWord}`;
}

export const RANGE_LABEL_AR = { today: "اليوم", "7d": "آخر ٧ أيام", all: "الكل" } as const;
export const percentAr = (part: number, whole: number): string => (whole > 0 ? `${formatAr(Math.round((part / whole) * 1000) / 10, 1)}٪` : "—");
