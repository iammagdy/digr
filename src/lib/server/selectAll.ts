/**
 * Reads every row of a query, not just the first thousand. PostgREST answers at most 1,000 rows per request unless the client pages, so a
 * sum over a table that grows with the work (one provider cost row per chunk, per call) silently stops counting at the thousandth row.
 *
 * `build` returns a fresh query each time (select, filters, no limit). The pages are read with `.range`, oldest first by `orderBy` so a
 * row can neither be skipped nor read twice between two pages. A query that cannot page (a simple test double without `.range`) is awaited
 * once, as before, so nothing that worked changes. Read-only: it never writes.
 */
export const SELECT_PAGE_SIZE = 1000;
/** A runaway stop: more rows than this are never read (the answer then carries what was read and `truncated: true`). */
export const SELECT_MAX_ROWS = 200_000;

export interface SelectAllResult<T> {
  data: T[];
  error: any;
  truncated: boolean;
}

export async function selectAllRows<T = any>(
  build: () => any,
  options: { pageSize?: number; maxRows?: number; orderBy?: string } = {},
): Promise<SelectAllResult<T>> {
  const pageSize = Math.max(1, Math.floor(options.pageSize ?? SELECT_PAGE_SIZE));
  const maxRows = Math.max(pageSize, Math.floor(options.maxRows ?? SELECT_MAX_ROWS));
  const first = build();
  if (typeof first?.range !== "function") {
    const single = await first;
    return { data: Array.isArray(single?.data) ? single.data : [], error: single?.error ?? null, truncated: false };
  }
  const rows: T[] = [];
  for (let from = 0; from < maxRows; from += pageSize) {
    let query = from === 0 ? first : build();
    if (options.orderBy && typeof query.order === "function") query = query.order(options.orderBy, { ascending: true });
    const { data, error } = await query.range(from, from + pageSize - 1);
    if (error) return { data: rows, error, truncated: false };
    const page: T[] = Array.isArray(data) ? data : [];
    rows.push(...page);
    if (page.length < pageSize) return { data: rows, error: null, truncated: false };
  }
  return { data: rows, error: null, truncated: true };
}
