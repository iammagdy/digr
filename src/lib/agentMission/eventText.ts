import { toArabicDigits } from "../arabicDigits";
import type { EventKind, MissionEventCountKey } from "./constants";
import { MISSION_EVENT_COUNT_KEYS } from "./constants";
import { checkCustomerText } from "./text";

/**
 * THE EVENT TEXT GUARD. Every line that reaches `mission_events` (what the live panel and the admin page read) passes the same Arabic-only check as every other customer-visible string:
 * Arabic, Arabic-Indic digits, no English word, no snake_case name, no provider or source name, no dollar amount, no internal id. A line that fails is NOT stored as written: it is replaced
 * by the fixed Arabic line of its kind, so a technical sentence can never reach a screen. Numbers go in the `counts` JSON under the fixed keys of MISSION_EVENT_COUNT_KEYS, never in the text.
 */
const FALLBACK_LINE_AR: Record<EventKind, string> = {
  progress: "الوكيل يواصل العمل على مهمتك.",
  plan: "جهّز الوكيل خطة لمهمتك.",
  question: "عند الوكيل سؤال واحد عن مهمتك.",
  answer: "وصلت إجابتك.",
  call: "يقرأ الوكيل من المصدر.",
  result: "انتهى عمل الوكيل على مهمتك.",
  system: "تحديث على مهمتك.",
  refusal: "تعذّر على الوكيل متابعة هذه الخطوة.",
};

export interface GuardedEvent { kind: EventKind; message_ar: string; counts: Record<string, number>; replaced: boolean }

/** The event as it may be stored: the text checked (or replaced by the fixed line of its kind), the counts cleaned to finite numbers under short keys. Never throws. */
export function guardEvent(event: { kind: EventKind; message_ar: unknown; counts?: Record<string, unknown> }): GuardedEvent {
  const checked = checkCustomerText(event.message_ar, { maxChars: 1100 });
  const counts: Record<string, number> = {};
  for (const [k, v] of Object.entries(event.counts ?? {}).slice(0, 24)) {
    if (typeof v === "number" && Number.isFinite(v) && /^[a-z][a-z0-9_]{0,39}$/.test(k)) counts[k] = v;
  }
  if (checked.issues.length === 0) return { kind: event.kind, message_ar: checked.text, counts, replaced: false };
  return { kind: event.kind, message_ar: FALLBACK_LINE_AR[event.kind] ?? FALLBACK_LINE_AR.system, counts, replaced: true };
}

const COUNT_LABEL_AR: Record<MissionEventCountKey, string> = {
  stages: "المراحل", rows: "الصفوف", stage: "المرحلة", saved: "المحفوظ", planned: "المتوقع", pages: "الصفحات", sources: "المصادر",
  delivered: "المسلَّم", charged_points: "المخصوم بالنقاط", reserve_points: "المحجوز بالنقاط", unit_points_x1000: "سعر الصف (بالألف)", queue_ahead: "قبلك في الدور", seconds_left: "الثواني المتبقية", requeued: "مرات التأجيل",
};

/** One count as an Arabic phrase, or null for a key that has no customer wording (it is simply not shown). `stage_<n>_rows` is the rows of stage n. */
export function countPhraseAr(key: string, value: number): string | null {
  if (!Number.isFinite(value)) return null;
  const stageRows = /^stage_(\d{1,2})_rows$/.exec(key);
  if (stageRows) return `صفوف المرحلة ${toArabicDigits(stageRows[1])}: ${toArabicDigits(value)}`;
  if ((MISSION_EVENT_COUNT_KEYS as readonly string[]).includes(key)) return `${COUNT_LABEL_AR[key as MissionEventCountKey]}: ${toArabicDigits(Math.round(value * 1000) / 1000)}`;
  return null;
}

/** The counts of an event as one Arabic line (for the admin page and the panel); keys without a customer wording are left out, never printed raw. */
export function countsLineAr(counts: Record<string, number> | null | undefined): string {
  return Object.entries(counts ?? {}).map(([k, v]) => countPhraseAr(k, Number(v))).filter((x): x is string => x !== null).join("، ");
}
