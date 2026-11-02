/**
 * Dates as the customer reads them: Arabic month names, Arabic-Indic digits and the Cairo clock, never the stored ISO text («2026-10-30T21:59:00.000Z»).
 * Display only: nothing here changes a stored value. A date with no time stays a date (no shift across midnight); a real instant is shown in Cairo time.
 */
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const dateOnly = new Intl.DateTimeFormat("ar-EG-u-nu-arab", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric" });
const dateTime = new Intl.DateTimeFormat("ar-EG-u-nu-arab", { timeZone: "Africa/Cairo", day: "numeric", month: "long", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true });

const momentParts = new Intl.DateTimeFormat("ar-EG-u-nu-arab", { timeZone: "Africa/Cairo", day: "numeric", month: "long", hour: "numeric", minute: "2-digit", hour12: true });

/**
 * «٣١ أكتوبر، ٩:٢٥ ص»: the day AND the time of an instant on the Cairo clock (the same clock for every customer, whatever their phone's zone). The wallet writes it on each job's line so two jobs of the
 * same size on the same day («خُصم ٢٠٠ نقطة مقابل ٥٠ تغريدة» twice) are told apart. An unreadable instant is an empty text.
 */
export function formatMomentCairo(value: string | number | Date): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const part = (type: Intl.DateTimeFormatPartTypes) => momentParts.formatToParts(d).find((p) => p.type === type)?.value ?? "";
  return `${part("day")} ${part("month")}، ${part("hour")}:${part("minute")} ${part("dayPeriod")}`.trim();
}

export const isIsoDateText =(value: string): boolean => ISO_DATE.test(value.trim()) || ISO_DATE_TIME.test(value.trim());

/** «٣٠ أكتوبر ٢٠٢٦» for a date, «٣٠ أكتوبر ٢٠٢٦ في ١١:٥٩ م» (Cairo) for an instant. A text that is not an ISO date is returned as it is. */
export function formatIsoForCustomer(value: string): string {
  const text = value.trim();
  if (ISO_DATE.test(text)) {
    const d = new Date(`${text}T00:00:00Z`);
    return Number.isNaN(d.getTime()) ? value : dateOnly.format(d);
  }
  if (!ISO_DATE_TIME.test(text)) return value;
  // an instant with no zone is read as UTC, the way the sources and the engine write it
  const hasZone = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/.test(text);
  const d = new Date(`${text.replace(" ", "T")}${hasZone ? "" : "Z"}`);
  return Number.isNaN(d.getTime()) ? value : dateTime.format(d).replace("،", " في").replace(/\s+/g, " ");
}

const ARABIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";
const NUMBER_CELL = /^-?\d[\d,]*(?:\.\d+)?$/;
/**
 * A cell of a sample table, as the customer reads it (S11: the live card said «false» and showed «16»): an ISO date or instant is written in Arabic, true / false are «نعم» / «لا», a number is written in Arabic-Indic digits with the Arabic separators; every other text is left exactly as it is (and never cut).
 * Idempotent: a cell already written for the customer is returned as it is.
 */
export function formatSampleCell(value: unknown): string {
  const text = String(value ?? "");
  const t = text.trim();
  if (/^true$/i.test(t)) return "نعم";
  if (/^false$/i.test(t)) return "لا";
  if (isIsoDateText(text)) return formatIsoForCustomer(text);
  if (NUMBER_CELL.test(t)) return t.replace(/\d/g, (d) => ARABIC_DIGITS[Number(d)]).replace(/,/g, "٬").replace(/\./g, "٫");
  return text;
}
