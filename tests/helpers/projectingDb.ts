/**
 * A STRICT FAKE DATABASE (MONEY PR 7e, PHASE 2B-2 TASK 4): tables of plain rows that behave like PostgREST in the ways the add-on isolation depends on:
 *   - `select(cols)` returns ONLY the columns asked for, so a reader that forgot to ask for the add-on marker does not see it (the memory fake of `memoryDb.ts` returns whole rows, which hides that mistake);
 *   - a JSON-path column works the way the repository already uses it: `alias:plan->addon` (a select) and `plan->addon->>of` (a filter);
 *   - a primary key `id` that refuses a second row of the same id (code 23505);
 *   - an `update` applies only to the rows its filters match at that moment (a compare-and-set), and `.select("id")` after it returns exactly the rows it changed;
 *   - every write, every rpc and every storage call is recorded: the readers under test must make NO money call (no rpc, no ledger, no wallet, no job).
 */
type Row = Record<string, any>;

const pathValue = (row: Row, path: string): unknown => path.split(/->>?/).reduce((v: any, k) => (v === null || v === undefined ? v : v[k]), row) ?? null;

function project(row: Row, cols: string | undefined): Row {
  if (cols === undefined || cols.trim() === "*" || cols.trim() === "") return { ...row };
  const out: Row = {};
  for (const raw of cols.split(",").map((c) => c.trim()).filter(Boolean)) {
    if (raw === "*") { Object.assign(out, row); continue; }
    const alias = /^([A-Za-z_]\w*):(.+)$/.exec(raw);
    if (alias) { out[alias[1]] = pathValue(row, alias[2]); continue; }
    out[raw] = raw.includes("->") ? pathValue(row, raw) : row[raw] ?? null;
  }
  return out;
}

export interface WriteLog { op: "insert" | "update"; table: string; ids: string[]; patch?: Row }

export function projectingDb(seed: Record<string, Row[]> = {}) {
  const tables = new Map<string, Row[]>(Object.entries(seed).map(([t, rows]) => [t, rows.map((r) => ({ ...r }))]));
  const log: WriteLog[] = [];
  const selects: Array<{ table: string; cols: string }> = [];
  const rpcs: string[] = [];
  const storageCalls: string[] = [];
  const rowsOf = (t: string) => { if (!tables.has(t)) tables.set(t, []); return tables.get(t)!; };

  function builder(table: string) {
    let op: "select" | "insert" | "update" = "select";
    let cols: string | undefined;
    let payload: Row = {};
    let wantRows = false;
    let count = false;
    let head = false;
    let single = false;
    let max: number | null = null;
    let skip = 0;
    let order: { col: string; asc: boolean } | null = null;
    const filters: Array<(r: Row) => boolean> = [];
    const run = (): { data: any; error: any; count?: number } => {
      const rows = rowsOf(table);
      if (op === "insert") {
        for (const r of Array.isArray(payload) ? payload : [payload]) {
          if (r.id !== undefined && rows.some((x) => x.id === r.id)) return { data: null, error: { code: "23505", message: 'duplicate key value violates unique constraint "pkey"' } };
          rows.push({ created_at: new Date().toISOString(), ...r });
          log.push({ op: "insert", table, ids: [String(r.id)] });
        }
        return { data: null, error: null };
      }
      let hit = rows.filter((r) => filters.every((f) => f(r)));
      if (op === "update") {
        for (const r of hit) Object.assign(r, payload);
        log.push({ op: "update", table, ids: hit.map((r) => String(r.id)), patch: { ...payload } });
        return { data: wantRows ? hit.map((r) => project(r, cols)) : null, error: null };
      }
      if (count) return { data: head ? null : hit.map((r) => project(r, cols)), error: null, count: hit.length };
      if (order) { const o = order; hit = [...hit].sort((a, b) => (a[o.col] > b[o.col] ? 1 : a[o.col] < b[o.col] ? -1 : 0) * (o.asc ? 1 : -1)); }
      if (skip > 0) hit = hit.slice(skip);
      if (max !== null) hit = hit.slice(0, max);
      const out = hit.map((r) => project(r, cols));
      return { data: single ? out[0] ?? null : out, error: null };
    };
    const cmp = (c: string, v: any, f: (a: any, b: any) => boolean) => { filters.push((r) => { const x = c.includes("->") ? pathValue(r, c) : r[c]; return x !== null && x !== undefined && f(x, v); }); return b; };
    const b: any = {
      select: (c?: string, opts?: { count?: string; head?: boolean }) => {
        cols = c ?? "*";
        if (op === "select") selects.push({ table, cols });
        if (op !== "select") wantRows = true;
        if (opts?.count) { count = true; head = Boolean(opts.head); }
        return b;
      },
      insert: (row: Row) => { op = "insert"; payload = row; return b; },
      update: (patch: Row) => { op = "update"; payload = patch; return b; },
      eq: (c: string, v: unknown) => { filters.push((r) => (c.includes("->") ? pathValue(r, c) : r[c]) === v); return b; },
      neq: (c: string, v: unknown) => { filters.push((r) => r[c] !== v); return b; },
      in: (c: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[c])); return b; },
      is: (c: string, v: unknown) => { filters.push((r) => (v === null ? r[c] === null || r[c] === undefined : r[c] === v)); return b; },
      gt: (c: string, v: any) => cmp(c, v, (a, z) => a > z),
      gte: (c: string, v: any) => cmp(c, v, (a, z) => a >= z),
      lt: (c: string, v: any) => cmp(c, v, (a, z) => a < z),
      lte: (c: string, v: any) => cmp(c, v, (a, z) => a <= z),
      order: (c: string, o?: { ascending?: boolean }) => { order = { col: c, asc: o?.ascending !== false }; return b; },
      limit: (n: number) => { max = n; return b; },
      range: (from: number, to: number) => { skip = from; max = to - from + 1; return b; },
      maybeSingle: () => { single = true; return Promise.resolve(run()); },
      single: () => { single = true; return Promise.resolve(run()); },
      then: (resolve: any, reject: any) => Promise.resolve().then(run).then(resolve, reject),
    };
    return b;
  }

  return {
    from: (t: string) => builder(t),
    rpc: async (name: string) => { rpcs.push(name); return { data: null, error: { message: "no money call is expected here" } }; },
    storage: { from: (bucket: string) => ({ createSignedUrl: async (p: string) => { storageCalls.push(`sign ${bucket}/${p}`); return { data: { signedUrl: `https://signed.example/${bucket}/${p}` }, error: null }; }, download: async (p: string) => { storageCalls.push(`download ${bucket}/${p}`); return { data: null, error: { message: "not found" } }; }, upload: async (p: string) => { storageCalls.push(`upload ${bucket}/${p}`); return { data: null, error: null }; } }) },
    auth: { admin: { getUserById: async (id: string) => ({ data: { user: { id } }, error: null }) } },
    tables, log, selects, rpcs, storageCalls,
    rows: rowsOf,
    seed: (t: string, rows: Row[]) => { rowsOf(t).push(...rows.map((r) => ({ ...r }))); },
    /** Every write that touched a table other than `missions` and `mission_events`, plus every rpc: a review request's isolation must keep this EMPTY. */
    moneyTouched: (): string[] => [...rpcs.map((n) => `rpc ${n}`), ...log.filter((l) => !["missions", "mission_events"].includes(l.table)).map((l) => `${l.op} ${l.table}`)],
  };
}
export type ProjectingDb = ReturnType<typeof projectingDb>;
