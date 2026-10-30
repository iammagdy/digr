/**
 * A minimal in-memory stand-in for the database client, for the model planner's tests: tables of plain rows, the query methods the planner code uses
 * (select / eq / gte / in / order / limit / maybeSingle / insert / update / upsert), `storage.from(bucket).upload`, and the admin auth lookup. A table named in `missing` behaves like
 * a table that does not exist yet (every call answers with an error): that is how the tests prove the code works before the owner applies the SQL.
 */
export interface MemoryDb {
  tables: Map<string, any[]>;
  uploads: Array<{ bucket: string; path: string; body: any }>;
  from(table: string): any;
  storage: { from(bucket: string): { upload(path: string, body: any, options?: any): Promise<{ data: any; error: null }> } };
  auth: { admin: { getUserById(id: string): Promise<{ data: { user: any } | null; error: null }> } };
  rows(table: string): any[];
  seed(table: string, rows: any[]): void;
  admins: Set<string>;
  /** Marks tables as not existing yet (every call answers with an error). */
  setMissing(names: string[]): void;
  reset(): void;
}

export function createMemoryDb(options: { missing?: string[] } = {}): MemoryDb {
  const missing = new Set(options.missing ?? []);
  const base = [...(options.missing ?? [])];
  const tables = new Map<string, any[]>();
  const uploads: MemoryDb["uploads"] = [];
  const admins = new Set<string>();
  const tableRows = (name: string) => { if (!tables.has(name)) tables.set(name, []); return tables.get(name)!; };

  const missingBuilder: any = {};
  for (const m of ["select", "eq", "gt", "neq", "gte", "lt", "lte", "in", "is", "range", "order", "limit", "insert", "update", "upsert", "maybeSingle", "single"]) missingBuilder[m] = () => missingBuilder;
  missingBuilder.then = (resolve: any) => resolve({ data: null, error: { message: "relation does not exist" } });

  const from = (name: string) => {
    if (missing.has(name)) return missingBuilder;
    const rows = tableRows(name);
    let filters: Array<(r: any) => boolean> = [];
    let mode: "select" | "update" = "select";
    let patch: any = null;
    let orderBy: { col: string; asc: boolean } | null = null;
    let max: number | null = null;
    let skip = 0;
    let single = false;
    let wantCount = false;
    let head = false;
    const run = () => {
      let out = rows.filter((r) => filters.every((f) => f(r)));
      if (mode === "update") { for (const r of out) Object.assign(r, patch); return { data: out, error: null }; }
      // select(cols, { count: "exact", head: true }): the number of matching rows (and no rows with head)
      if (wantCount) return { data: head ? null : out, count: out.length, error: null };
      if (orderBy) out = [...out].sort((a, b) => (a[orderBy!.col] > b[orderBy!.col] ? 1 : -1) * (orderBy!.asc ? 1 : -1));
      if (skip > 0) out = out.slice(skip);
      if (max !== null) out = out.slice(0, max);
      return { data: single ? out[0] ?? null : out, error: null };
    };
    const b: any = {
      select: (_cols?: string, opts?: { count?: string; head?: boolean }) => { if (opts?.count) { wantCount = true; head = Boolean(opts.head); } return b; },
      eq: (c: string, v: any) => { filters.push((r) => r[c] === v); return b; },
      gt: (c: string, v: any) => { filters.push((r) => r[c] > v); return b; },
      neq: (c: string, v: any) => { filters.push((r) => r[c] !== v); return b; },
      gte: (c: string, v: any) => { filters.push((r) => r[c] >= v); return b; },
      lt: (c: string, v: any) => { filters.push((r) => r[c] < v); return b; },
      lte: (c: string, v: any) => { filters.push((r) => r[c] <= v); return b; },
      in: (c: string, vs: any[]) => { filters.push((r) => vs.includes(r[c])); return b; },
      order: (c: string, o?: { ascending?: boolean }) => { orderBy = { col: c, asc: o?.ascending !== false }; return b; },
      limit: (n: number) => { max = n; return b; },
      // `is(col, null)`: the column is empty; `range(from, to)`: rows from..to inclusive (the paged reads)
      is: (c: string, v: any) => { filters.push((r) => (v === null ? r[c] === null || r[c] === undefined : r[c] === v)); return b; },
      range: (from: number, to: number) => { skip = from; max = to - from + 1; return b; },
      maybeSingle: () => { single = true; return Promise.resolve(run()); },
      single: () => { single = true; return Promise.resolve(run()); },
      insert: (row: any) => { for (const r of Array.isArray(row) ? row : [row]) rows.push({ ...r }); return Promise.resolve({ data: row, error: null }); },
      upsert: (row: any, o?: { onConflict?: string }) => {
        const key = o?.onConflict ?? "id";
        const at = rows.findIndex((r) => r[key] === row[key]);
        if (at >= 0) Object.assign(rows[at], row); else rows.push({ ...row });
        return Promise.resolve({ data: row, error: null });
      },
      update: (p: any) => { mode = "update"; patch = p; return b; },
      then: (resolve: any, reject: any) => Promise.resolve(run()).then(resolve, reject),
    };
    return b;
  };

  return {
    tables, uploads, admins,
    from,
    storage: { from: (bucket: string) => ({ upload: async (path: string, body: any) => { uploads.push({ bucket, path, body }); return { data: { path }, error: null }; } }) },
    auth: { admin: { getUserById: async (id: string) => ({ data: { user: { id, app_metadata: admins.has(id) ? { role: "admin" } : {} } }, error: null }) } },
    rows: (t: string) => tableRows(t),
    seed: (t: string, rows: any[]) => { tableRows(t).push(...rows.map((r) => ({ ...r }))); },
    setMissing: (names: string[]) => { missing.clear(); for (const n of names) missing.add(n); },
    reset: () => { tables.clear(); uploads.length = 0; admins.clear(); missing.clear(); for (const n of base) missing.add(n); },
  };
}
