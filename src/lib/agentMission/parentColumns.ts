/**
 * EVERY VALUE THAT DESCRIBES THE PARENT COMES FROM THAT ROW'S OWN PARENT. The people of a company are read once per company, but the mapping of the page is ONE piece of code written from the FIRST sample: a value it copied from the sample's
 * INPUT or its context instead of from the page (the company's website, written as the literal «orascom.com») is the same on every row, whichever company the row belongs to (live run of 2026-10-29: six people of three companies, «موقع الشركة» = the
 * first company's on all six). Before the file is written, code compares every child column with the parent's own fields:
 *   a column is PARENT-DESCRIBING when every filled value in it is the value of some parent's field (the same field for all of them), and it is WRONG on a row when that value is another parent's and not the row's own parent's.
 * A wrong value is replaced by the row's own parent's value (written in the style the column used: a bare domain stays a bare domain), and the fix is reported to the admin only. A column that is not entirely made of parent values (a person's own name)
 * is never touched, so a coincidence of one value cannot overwrite real data. Pure: no I/O.
 */
type Row = Record<string, unknown>;

export interface ParentColumnFix { stage_key: string; column: string; parent_field: string; rows: number }

const text = (v: unknown): string => (v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));

/** One value in a comparable form: lower case, no spaces around it, and for a link: no scheme, no «www.», no closing slash. */
export function comparableValue(v: unknown): string {
  const t = text(v).trim().toLowerCase();
  if (!t) return "";
  return /^(https?:\/\/)?(www\.)?[^\s/]+\.[a-z]{2,}(\/\S*)?$/.test(t) ? t.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "") : t;
}

const hasScheme = (v: string): boolean => /^https?:\/\//i.test(v.trim());
const hasWww = (v: string): boolean => /^(https?:\/\/)?www\./i.test(v.trim());

/** The parent's value written in the style the child column used (a bare domain stays bare; a link with a scheme keeps one). */
function inStyleOf(parentValue: unknown, used: string): unknown {
  const t = text(parentValue).trim();
  if (/^(https?:\/\/)?(www\.)?[^\s/]+\.[a-z]{2,}(\/\S*)?$/i.test(t)) {
    let out = t.replace(/^https?:\/\//i, "").replace(/^www\./i, "");
    if (hasWww(used)) out = `www.${out}`;
    if (hasScheme(used)) out = `${/^http:/i.test(used.trim()) ? "http" : "https"}://${out}`;
    return out;
  }
  return parentValue;
}

export interface ChildStageRef { key: string; parent_key: string | null }

/**
 * Returns the rows of every stage with the wrong parent-describing values of the child stages replaced from their own parents, and what was fixed. `columnKeys(stageKey)` lists the keys of the stage's own readable columns (the only ones checked);
 * rows are not changed in place.
 */
export function reconcileParentColumns(stages: ReadonlyArray<ChildStageRef>, rowsByStage: Record<string, Row[]>, columnKeys: (stageKey: string) => string[], parentKeys: (stageKey: string) => string[]): { rowsByStage: Record<string, Row[]>; fixes: ParentColumnFix[] } {
  const out: Record<string, Row[]> = { ...rowsByStage };
  const fixes: ParentColumnFix[] = [];
  for (const stage of stages) {
    if (stage.parent_key === null) continue;
    const rows = rowsByStage[stage.key] ?? [];
    const parentRows = rowsByStage[stage.parent_key] ?? [];
    if (rows.length === 0 || parentRows.length < 2) continue;
    const parentById = new Map(parentRows.map((r) => [text(r.id), r]));
    // the parent's fields to compare with: the readable columns first, then the rest of its keys (the id is the very value the source was asked about)
    const pFields = [...new Set([...parentKeys(stage.parent_key), ...parentRows.flatMap((r) => Object.keys(r))])].filter((k) => k !== "parent_id");
    const next = rows.map((r) => ({ ...r }));
    for (const column of columnKeys(stage.key)) {
      const filled = rows.map((r, i) => ({ r, i, v: comparableValue(r[column]) })).filter((x) => x.v !== "");
      if (filled.length === 0) continue;
      for (const pf of pFields) {
        const valuesOfParents = new Set(parentRows.map((p) => comparableValue(p[pf])).filter(Boolean));
        // a parent field whose values are all the same says nothing about which parent a value came from
        if (valuesOfParents.size < 2) continue;
        if (!filled.every((x) => valuesOfParents.has(x.v))) continue;
        const wrong = filled.filter((x) => {
          const own = parentById.get(text(x.r.parent_id));
          return own !== undefined && comparableValue(own[pf]) !== x.v;
        });
        if (wrong.length === 0) continue;
        for (const x of wrong) {
          const own = parentById.get(text(x.r.parent_id))!;
          const ownValue = own[pf];
          next[x.i][column] = text(ownValue).trim() === "" ? "" : inStyleOf(ownValue, text(x.r[column]));
        }
        fixes.push({ stage_key: stage.key, column, parent_field: pf, rows: wrong.length });
        break;
      }
    }
    out[stage.key] = next;
  }
  return { rowsByStage: out, fixes };
}
