/**
 * THE DEFAULT CHOICE OF VIDEOS (OR POSTS) FOR A COMMENTS REQUEST IS THE MOST ENGAGED (S5, owner decision of 2026-11-02): the ones with the highest comment counters, unless the customer asks for the newest or gives a date. The search tool's sort field is used when it has one (the most-liked
 * order); otherwise the highest counters among the results are taken. It is an ORDER, never a filter: nothing is removed for its content. Pure.
 */
const NEWEST = /(?:^|\s|و)(?:ال)?(?:أحدث|احدث|اجدد|أجدد|آخر|اخر|الأخيرة|الاخيرة|الجديدة|الجديد)(?:\s|$)/;
const DATE = /(?:\b20\d{2}\b|[٢][٠]\d{2}|(?:يناير|فبراير|مارس|أبريل|ابريل|مايو|يونيو|يوليو|أغسطس|اغسطس|سبتمبر|أكتوبر|اكتوبر|نوفمبر|ديسمبر)|\bاليوم\b|\bامبارح\b|الأسبوع|الاسبوع|الشهر)/;
export const wantsNewestOrDate = (request: unknown): boolean => NEWEST.test(String(request ?? "")) || DATE.test(String(request ?? ""));
/** True when the plan has a comments stage under a parent stage and the customer asked for neither the newest nor a date nor a period. */
export function engagedDefault(request: unknown, stages: ReadonlyArray<{ key: string; parent_key: string | null; filters?: ReadonlyArray<{ kind: string; enabled?: boolean }> }>): boolean {
  if (wantsNewestOrDate(request)) return false;
  if (stages.some((s) => (s.filters ?? []).some((f) => f.kind === "period" && f.enabled !== false))) return false;
  return stages.some((s) => s.parent_key !== null);
}
