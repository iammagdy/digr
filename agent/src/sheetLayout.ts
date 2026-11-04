/**
 * ROUND 35: THE LAYOUT OF A DATA SHEET (widths, wrapping, row heights), decided from what each column HOLDS, never from a word in its header.
 * Live (five delivered Excel files, inspected cell by cell): no column was shifted and no value was lost, but the widths were chosen by a pattern on the header's WORDS («نص», «تعليق», «وصف»…), so a counter named «عدد التعليقات» (values of one to four digits) and a mark named «علاقة النص بالموضوع» or «لغة النص» got the 52-wide text column,
 * a date got 13 and was cut, a 114-character link wrapped on four lines, and a post of 3,800 characters sat in a 52-wide cell on a row Excel sizes by itself (and cuts at 409 points). Nothing here changes a value: the cell keeps its full text; only the width, the wrap and the height of the row change.
 * Pure: no I/O.
 */
export type ColumnKind = "long_text" | "text" | "link" | "date" | "number" | "id";
export interface ColumnSpec { kind: ColumnKind; width: number; wrap: boolean }

/** Excel cannot show a row taller than this (points); a taller text stays whole in its cell (the formula bar and the CSV have all of it) and is cut only in the view. */
export const MAX_ROW_POINTS = 409;
const LINE_POINTS = 15;
export const LONG_TEXT_WIDTH = 70;
/** A text longer than this (characters) in some row is a long text: it gets the wide column and a taller row. */
const LONG_TEXT_FROM = 90;
const MIN_TEXT_WIDTH = 14;
const MAX_SHORT_TEXT_WIDTH = 42;

const textOf = (v: unknown): string => (v === null || v === undefined ? "" : typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : typeof v === "object" && v !== null && "text" in (v as Record<string, unknown>) ? String((v as { text: unknown }).text) : JSON.stringify(v));
const isLink = (s: string): boolean => /^https?:\/\//i.test(s.trim());

export function columnSpec(input: { title: string; values: ReadonlyArray<unknown>; date?: boolean; numeric?: boolean; id?: boolean }): ColumnSpec {
  const titleWidth = Math.max(MIN_TEXT_WIDTH, Math.ceil(input.title.length * 1.2) + 3);
  if (input.id) return { kind: "id", width: Math.max(24, Math.min(30, titleWidth)), wrap: false };
  if (input.date) return { kind: "date", width: 24, wrap: false };
  const shown = input.values.map(textOf).filter((s) => s.trim() !== "");
  const longest = shown.reduce((n, s) => Math.max(n, s.length), 0);
  if (input.numeric || (shown.length > 0 && shown.every((s) => /^-?[\d٠-٩][\d٠-٩.,٫٬]*$/.test(s.trim())))) return { kind: "number", width: Math.max(12, Math.min(18, Math.ceil(input.title.length * 1.05) + 3, Math.max(12, longest + 4))), wrap: false };
  // every filled cell an address: the address stays on ONE line (the hyperlink and the cell hold all of it); a wrapped 114-character link is four lines of noise
  if (shown.length > 0 && shown.every(isLink)) return { kind: "link", width: 40, wrap: false };
  if (longest > LONG_TEXT_FROM) return { kind: "long_text", width: LONG_TEXT_WIDTH, wrap: true };
  return { kind: "text", width: Math.max(titleWidth, Math.min(MAX_SHORT_TEXT_WIDTH, Math.ceil(longest * 1.1) + 3)), wrap: true };
}

/** The lines a text takes in a wrapped cell of this width (a paragraph is at least one line). */
export function linesOf(value: string, width: number): number {
  const perLine = Math.max(8, Math.floor(width));
  return value.split(/\r?\n/).reduce((n, part) => n + Math.max(1, Math.ceil(part.length / perLine)), 0);
}

/** The height of a data row in points, or undefined when every cell fits on one line (the default height is right). The tallest wrapped cell decides; Excel's own limit caps it. */
export function rowHeightOf(cells: ReadonlyArray<{ value: unknown; spec: ColumnSpec }>): number | undefined {
  let lines = 1;
  for (const c of cells) if (c.spec.wrap) lines = Math.max(lines, linesOf(textOf(c.value), c.spec.width));
  return lines <= 1 ? undefined : Math.min(MAX_ROW_POINTS, lines * LINE_POINTS + 4);
}

/** The header row's height: its titles wrap inside their columns. */
export function headerHeightOf(titles: ReadonlyArray<string>, specs: ReadonlyArray<ColumnSpec>): number {
  const lines = titles.reduce((n, t, i) => Math.max(n, linesOf(t, specs[i]?.width ?? 24)), 1);
  return Math.max(30, lines * LINE_POINTS + 6);
}
