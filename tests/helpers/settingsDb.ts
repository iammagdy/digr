/**
 * FAKE `agent_settings` table for the launch lock (src/lib/launch/launchLock.ts): an in-memory map with the same observable rules as Postgres for the
 * three statements the lock uses: INSERT (primary key on `key`: a second insert answers 23505), conditional UPDATE ... RETURNING and conditional DELETE.
 * Every statement runs to completion without yielding (like one SQL statement), so Promise.all of several callers models truly concurrent requests.
 * No network, no real database.
 */
export interface SettingsRow { key: string; value: any; updated_at: string }

export function makeSettingsDb() {
  const rows = new Map<string, SettingsRow>();
  const statements: string[] = [];
  let failWith: { code: string } | null = null;

  const read = (row: SettingsRow, col: string): unknown => (col === "value->>holder" ? row.value?.holder : (row as any)[col]);

  function builder(kind: "update" | "delete", patch?: Partial<SettingsRow>) {
    const eqs: Array<[string, unknown]> = [];
    const lts: Array<[string, string]> = [];
    let wantRows = false;
    const run = () => {
      statements.push(kind);
      if (failWith) return { data: null, error: failWith };
      const hit = [...rows.values()].filter((r) => eqs.every(([c, v]) => read(r, c) === v) && lts.every(([c, v]) => String(read(r, c)) < v));
      if (kind === "update") for (const r of hit) Object.assign(r, structuredClone(patch));
      else for (const r of hit) rows.delete(r.key);
      return { data: wantRows ? hit.map((r) => ({ key: r.key })) : null, error: null };
    };
    const api: any = {
      eq(col: string, v: unknown) { eqs.push([col, v]); return api; },
      lt(col: string, v: string) { lts.push([col, v]); return api; },
      select() { wantRows = true; return api; },
      then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) { return Promise.resolve(run()).then(resolve, reject); },
    };
    return api;
  }

  return {
    rows,
    statements,
    /** make every following statement fail with this database error (a closed circuit, a permission problem) */
    failAll(code: string | null) { failWith = code ? { code } : null; },
    from(table: string) {
      if (table !== "agent_settings") throw new Error(`unexpected table ${table}`);
      return {
        async insert(row: SettingsRow) {
          statements.push("insert");
          if (failWith) return { error: failWith };
          if (rows.has(row.key)) return { error: { code: "23505" } };
          rows.set(row.key, structuredClone(row));
          return { error: null };
        },
        update: (patch: Partial<SettingsRow>) => builder("update", patch),
        delete: () => builder("delete"),
      };
    },
  };
}
