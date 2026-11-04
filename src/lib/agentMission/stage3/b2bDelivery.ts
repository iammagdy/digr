import { countAr, knownItemNoun } from "../itemNoun";
import { COMPANY_EMAIL_TITLE_AR, COMPANY_PHONE_TITLE_AR } from "../taskContracts";
import { fillColumn, gapLineAr, markCellAr, removeExactDuplicates, type Attempt, type B2BCompileResult, type ColumnGap, type ContactField } from "./b2bCompile";

/**
 * STAGE 3 S2 and S4 (docs/STAGE-3.md): THE B2B DELIVERY, pure. From the compiled B2B plan, the company rows and what each lookup answered per row (`Attempt`), it writes:
 *   - the CONTACT CELLS of the company sheet (the general e-mail and the HQ phone) by the fallthrough: the value of the first tool of the chain that gave one; «غير متوفر» only after EVERY tool of
 *     the chain answered with nothing; «لم يكتمل البحث» when a call failed or was refused or the chain has no verified tool (a search that did not run is never a negative answer);
 *   - the MARK COLUMNS (a condition no chosen tool carries): «نعم» / «لا» / «غير معروف» from the row's own value;
 *   - the removal of EXACT duplicates only (every value identical; a near copy stays);
 *   - the lines for the file's «حدود هذا التسليم»: the duplicates, each column's gap, each mark.
 * No row is removed for a condition, a gap or a mark. The input rows are not changed. The caller records the attempts (the engine side is the next session's: docs/STAGE-3.md) and passes the lines
 * to `buildMissionFiles` as `extraLimitLines`. The people sheet (decision-maker mark, per-person contacts) comes with the planning wiring.
 */
type Row = Record<string, unknown>;
export interface B2BDeliveryInput {
  plan: Extract<B2BCompileResult, { ok: true }>;
  /** The company rows keyed by the cards' field names: id, name, website, activity, hq, employees, founded ... */
  rows: ReadonlyArray<Row>;
  /** For each contact column, what each tool answered for each row (by the row's id). A row with no entry has no attempt. */
  attempts: Partial<Record<ContactField, Readonly<Record<string, ReadonlyArray<Attempt>>>>>;
}
export interface B2BDelivery {
  rows: Row[];
  removedDuplicates: number;
  gaps: Partial<Record<ContactField, ColumnGap>>;
  limitLines: string[];
}

const COMPANY_COLUMNS: ReadonlyArray<{ field: ContactField; titleAr: string }> = [
  { field: "general_email", titleAr: COMPANY_EMAIL_TITLE_AR },
  { field: "hq_phone", titleAr: COMPANY_PHONE_TITLE_AR },
];
const company = knownItemNoun("شركة")!;

export const duplicatesLineAr = (n: number): string => `حذفنا ${countAr(n, company)} مكررة تمامًا، ولم نحذف شيئًا غيرها.`;
export const markLineAr = (titleAr: string): string => `«${titleAr}»: كُتب في عمود خاص (نعم أو لا أو غير معروف)، ولم تُحذف أي شركة بسببه.`;

export function buildB2BDelivery(input: B2BDeliveryInput): B2BDelivery {
  const { plan } = input;
  const deduped = removeExactDuplicates(input.rows.map((r) => ({ ...r })));
  const rows: Row[] = deduped.rows;
  const ids = rows.map((r) => String(r.id ?? ""));
  const gaps: Partial<Record<ContactField, ColumnGap>> = {};
  const lines: string[] = [];
  if (deduped.removed > 0) lines.push(duplicatesLineAr(deduped.removed));
  for (const { field, titleAr } of COMPANY_COLUMNS) {
    // a column the plan does not ask for is not written
    if (!plan.columns.company.some((c) => c.key === field)) continue;
    const filled = fillColumn(ids, plan.chains[field], input.attempts[field] ?? {});
    rows.forEach((r, i) => { r[field] = filled.cells[ids[i]]; });
    gaps[field] = filled.gap;
    lines.push(gapLineAr(titleAr, filled.gap, "company"));
  }
  plan.marks.forEach((m, i) => {
    rows.forEach((r) => { r[`__mark_${i}`] = markCellAr(m.condition, r); });
    lines.push(markLineAr(m.titleAr));
  });
  return { rows, removedDuplicates: deduped.removed, gaps, limitLines: lines };
}
