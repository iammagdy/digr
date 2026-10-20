import { toArabicDigits } from "./arabicDigits";

/**
 * The remaining time of a running job, computed from REAL progress samples (when each count of delivered records was
 * seen), never guessed. With fewer than two distinct samples, or no progress between them, there is no estimate and the
 * customer is told nothing rather than a made-up time.
 */
export interface ProgressSample {
  /** epoch milliseconds when the count was seen */
  at: number;
  /** records delivered at that time */
  delivered: number;
}

/** Samples older than this are ignored: a job that sped up or slowed down is judged by its recent pace. */
export const ETA_WINDOW_MS = 10 * 60 * 1000;
/** Fewest seconds between the first and last sample before the pace is trusted. */
export const ETA_MIN_SPAN_MS = 20 * 1000;

export function estimateRemainingSeconds(samples: readonly ProgressSample[], target: number, now = Date.now()): number | null {
  if (!(target > 0)) return null;
  const recent = samples.filter((s) => Number.isFinite(s.at) && Number.isFinite(s.delivered) && now - s.at <= ETA_WINDOW_MS).sort((a, b) => a.at - b.at);
  if (recent.length < 2) return null;
  const first = recent[0];
  const last = recent[recent.length - 1];
  const span = last.at - first.at;
  const gained = last.delivered - first.delivered;
  if (span < ETA_MIN_SPAN_MS || gained <= 0) return null;
  const left = Math.max(0, target - last.delivered);
  if (left === 0) return 0;
  const perSecond = gained / (span / 1000);
  return Math.ceil(left / perSecond);
}

/** «حوالي ٥ دقائق» — rounded up to a calm unit, Arabic digits; null when there is no estimate. */
export function etaTextAr(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return null;
  if (seconds < 60) return "أقل من دقيقة";
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) {
    const unit = minutes === 1 ? "دقيقة" : minutes === 2 ? "دقيقتين" : minutes <= 10 ? "دقائق" : "دقيقة";
    return minutes === 2 ? "حوالي دقيقتين" : `حوالي ${toArabicDigits(minutes)} ${unit}`;
  }
  const hours = Math.ceil(minutes / 60);
  const unit = hours === 1 ? "ساعة" : hours === 2 ? "ساعتين" : hours <= 10 ? "ساعات" : "ساعة";
  return hours === 2 ? "حوالي ساعتين" : `حوالي ${toArabicDigits(hours)} ${unit}`;
}
