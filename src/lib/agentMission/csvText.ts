/**
 * THE ONE CSV CELL RULE of the customer's files (the worker's CSV and the CSV a customer downloads are written with the same two functions).
 * A text that starts like a formula is dangerous in a CSV (a spreadsheet may run it), so the CSV marks it with a leading apostrophe. In the XLSX NO mark is written: a text cell is stored as a string (shared string),
 * which a spreadsheet never runs as a formula, so a customer's reply «@name ...» shows exactly as written. A phone number («+٢٠١٠…») is not a formula and is left alone.
 */
export const isFormulaLike = (v: string): boolean => /^[=+\-@\t\r]/.test(v) && !/^\+\d[\d\s]*$/.test(v);
export const csvText = (v: string): string => (isFormulaLike(v) ? `'${v}` : v);
/** One cell, always quoted, a quote doubled, the formula mark applied: a comma, a quote or a line break inside a cell never shifts a column. */
export const csvCell = (v: string): string => `"${csvText(v).replace(/"/g, '""')}"`;
