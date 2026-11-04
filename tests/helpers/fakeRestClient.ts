/**
 * A minimal stand-in for the database's REST layer, as far as THE BODY of a write goes (ROUND 19). It refuses what the real one refused on 4 Nov 2026 («Empty or invalid json», 400): a body that is not strict JSON,
 * which includes a lone UTF-16 surrogate escape (`\ud83d` with no partner) and the NUL escape (`\u0000`) a JSON column cannot hold. Every accepted write is applied to an in-memory table.
 * It speaks only the calls `agent/src/supabaseStore.ts` makes for writes: `from(t).insert(v)`, `.update(v).eq(c, x)`, `.upsert(v, opts)`.
 */
const LONE = /\\u[dD][89abAB][0-9a-fA-F]{2}(?!\\u[dD][c-fC-F][0-9a-fA-F]{2})|(?<!\\u[dD][89abAB][0-9a-fA-F]{2})\\u[dD][c-fC-F][0-9a-fA-F]{2}|\\u0000/;

export const restRefuses = (body: string): boolean => LONE.test(body);

export function fakeRestClient() {
  const tables = new Map<string, Array<Record<string, unknown>>>();
  const rejected: Array<{ table: string; bytes: number }> = [];
  const rowsOf = (t: string) => { if (!tables.has(t)) tables.set(t, []); return tables.get(t)!; };
  const check = (table: string, values: unknown): { data: null; error: { message: string; code: string } } | null => {
    const body = JSON.stringify(values);
    if (restRefuses(body)) { rejected.push({ table, bytes: Buffer.byteLength(body, "utf8") }); return { data: null, error: { message: "Empty or invalid json", code: "PGRST102" } }; }
    return null;
  };
  const client = {
    from(table: string) {
      return {
        insert: async (values: Record<string, unknown> | Array<Record<string, unknown>>) => { const bad = check(table, values); if (bad) return bad; for (const v of Array.isArray(values) ? values : [values]) rowsOf(table).push(JSON.parse(JSON.stringify(v))); return { data: null, error: null }; },
        upsert: async (values: Record<string, unknown>) => { const bad = check(table, values); if (bad) return bad; rowsOf(table).push(JSON.parse(JSON.stringify(values))); return { data: null, error: null }; },
        update: (values: Record<string, unknown>) => ({
          eq: async (col: string, x: unknown) => { const bad = check(table, values); if (bad) return bad; for (const r of rowsOf(table)) if (r[col] === x) Object.assign(r, JSON.parse(JSON.stringify(values))); return { data: null, error: null }; },
        }),
      };
    },
  };
  return { client, tables, rejected, rowsOf };
}
