/** Today's date in Cairo as yyyy-mm-dd (a date, not a moment: no time-zone shift later). */
export function todayCairo(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const at = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${at("year")}-${at("month")}-${at("day")}`;
}
