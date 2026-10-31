/**
 * Dates as the customer reads them: Arabic month names, Arabic-Indic digits and the Cairo clock, never the stored ISO text («2026-10-30T21:59:00.000Z»).
 * Display only: nothing here changes a stored value. A date with no time stays a date (no shift across midnight); a real instant is shown in Cairo time.
 */
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const dateOnly = new Intl.DateTimeFormat("ar-EG-u-nu-arab", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric" });
const dateTime = new Intl.DateTimeFormat("ar-EG-u-nu-arab", { timeZone: "Africa/Cairo", day: "numeric", month: "long", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true });

export const isIsoDateText = (value: string): boolean => ISO_DATE.test(value.trim()) || ISO_DATE_TIME.test(value.trim());

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

/** A cell of a sample table: an ISO date or instant is written for the customer, every other text is left exactly as it is (and never cut). */
export function formatSampleCell(value: unknown): string {
  const text = String(value ?? "");
  return isIsoDateText(text) ? formatIsoForCustomer(text) : text;
}
