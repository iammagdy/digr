import type { DocForm } from "../form";

/**
 * «خلي الـ PDF صفحة واحدة»: the sheet is real A4 pages measured in the browser, so the page count is only known there. The builder asks for the next reduction until the
 * measured page count fits (or nothing is left to reduce). A reduction never changes a total:
 *   1. the sector with the most lines that is not yet a summary becomes «summary only» (one row: name, count, subtotal), largest first;
 *   2. lines that belong to no sector are hidden together (they still count in the totals and show as «بنود أخرى»).
 */
export function nextFitStep(form: DocForm): { form: DocForm; note: string } | null {
  const size = (key: string) => form.lines.filter((l) => l.batchKey === key && !l.hidden).length;
  const candidates = form.batches.map((b, order) => ({ b, order, n: size(b.key) })).filter((x) => !x.b.summaryOnly && x.n >= 2).sort((a, b) => b.n - a.n || a.order - b.order);
  if (candidates.length) {
    const pick = candidates[0].b;
    return { form: { ...form, batches: form.batches.map((b) => (b.key === pick.key ? { ...b, summaryOnly: true } : b)) }, note: `عرض «${pick.title || "قطاع"}» كملخص` };
  }
  const loose = form.lines.filter((l) => l.batchKey === null && !l.hidden);
  if (loose.length >= 2) return { form: { ...form, lines: form.lines.map((l) => (l.batchKey === null ? { ...l, hidden: true } : l)) }, note: "إخفاء البنود بدون قطاع" };
  return null;
}
