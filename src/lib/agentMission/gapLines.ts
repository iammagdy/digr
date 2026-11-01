import type { Gap } from "./toolInput";

/**
 * THE HONEST GAP STATEMENT (docs/REDESIGN.md section 3, S1 item 1.7, owner decision D7). The ranking has already tried every other tool that can carry the customer's conditions; for each condition no tool can carry, the plan card says so, in plain Arabic and
 * before approval, and the customer chooses: go on (the rows are delivered with a column that marks them), change the request, or cancel. Nothing is charged before the choice. Pure; every sentence passes checkCustomerText (Arabic only, no source names).
 */
const WHAT_AR: Record<string, { no: string; mark: string }> = {
  date: { no: "الفترة الزمنية", mark: "فستصلك نتائج من أي تاريخ، وفي الملف عمود يبيّن هل كل نتيجة ضمن الفترة التي طلبتها." },
  language: { no: "اللغة", mark: "فستصلك نتائج بلغات مختلفة، وفي الملف عمود يبيّن لغة كل نص." },
  country: { no: "البلد", mark: "فقد تصلك نتائج من بلدان أخرى." },
  account: { no: "الحساب", mark: "فقد تصلك نتائج من حسابات أخرى، وفي الملف عمود يبيّن هل النتيجة من المصدر الذي سمّيته." },
  replies: { no: "استبعاد الردود أو تضمينها", mark: "فقد تظهر الردود بين النتائج، وفي الملف عمود يبيّن هل كل نتيجة رد أم أصلية." },
};
export const GAP_CHOICE_LINE_AR = "يمكنك المتابعة كما هي، أو أن تعدّل الطلب، أو الإلغاء قبل الاعتماد، ولن يُخصم منك شيء قبل اعتمادك.";

/** The lines for the conditions the chosen tool cannot carry: one per condition, then one closing line that names the choice. Empty when there is no gap. */
export function gapLinesAr(gaps: ReadonlyArray<Gap>): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const g of gaps) {
    const what = WHAT_AR[g.cls];
    if (!what || seen.has(g.cls)) continue;
    seen.add(g.cls);
    lines.push(g.reason === "not_enforced" ? `المصدر المختار يستخدم ${what.no} لتوجيه الطلب فقط ولا يضمن أن تكون كل النتائج منه، ${what.mark}` : `المصدر المختار لا يسمح بتحديد ${what.no}، ${what.mark}`);
  }
  return lines.length > 0 ? [...lines, GAP_CHOICE_LINE_AR] : [];
}

/** Adds the gap lines to the plan's notes (shown open on the card), once: a line already there is not added again. */
export function applyGapNotes(plan: { notes_ar?: string[] }, gaps: ReadonlyArray<Gap>): void {
  const lines = gapLinesAr(gaps);
  if (lines.length === 0) return;
  const have = new Set(plan.notes_ar ?? []);
  const add = lines.filter((l) => !have.has(l));
  if (add.length > 0) plan.notes_ar = [...(plan.notes_ar ?? []), ...add];
}
