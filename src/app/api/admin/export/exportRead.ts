import { columnsOf, EXPORT_PAGE_SIZE, stripSecrets, type ExportTableId } from "@/lib/adminExport";

export interface ExportPageRead {
  rows: Array<Record<string, unknown>>;
  columns: string[];
  omitted: string[];
  /** Only on the first page: the number of rows the table held when the read started. */
  count: number | null | undefined;
  /** A short page is the last one. */
  done: boolean;
}

/**
 * ONE page (at most EXPORT_PAGE_SIZE rows) of one exported table, SELECT only, oldest first (created_at, then id) so rows written while an export runs
 * land at the end and never shift the pages already read. Secret-looking columns are left out and named. Shared by the page-by-page route and the ZIP
 * route, so both files come from the same query and the same cleaning. Returns null when the database could not be read (the caller says so in Arabic).
 */
export async function readExportPage(db: { from: (table: string) => any }, table: ExportTableId, offset: number): Promise<ExportPageRead | null> {
  const query = db
    .from(table)
    .select("*", offset === 0 ? { count: "exact" } : undefined)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .range(offset, offset + EXPORT_PAGE_SIZE - 1);
  const { data, error, count } = await query;
  if (error) return null;

  const omitted = new Set<string>();
  const rows = ((data || []) as Array<Record<string, unknown>>).map((raw) => {
    const { row, omitted: left } = stripSecrets(raw);
    for (const name of left) omitted.add(name);
    return row;
  });
  return { rows, columns: columnsOf(rows), omitted: [...omitted], count: offset === 0 ? count ?? null : undefined, done: rows.length < EXPORT_PAGE_SIZE };
}
