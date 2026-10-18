/**
 * A small in-memory Supabase client for route tests: select / eq / gte / lt / in / order / range / limit / single /
 * maybeSingle, plus insert / update / upsert / rpc. A table in `missing` answers like a table that was never
 * created (the state before a migration is applied); an rpc in `rpcMissing` answers like a missing function.
 */
export interface FakeDbOptions {
  tables?: Record<string, any[]>;
  missing?: string[];
  rpcMissing?: string[];
  rpc?: Record<string, (args: any) => { data?: any; error?: any }>;
  authUsers?: Record<string, { email?: string; user_metadata?: any; created_at?: string; last_sign_in_at?: string }>;
}

const missingError = (table: string) => ({ code: "42P01", message: `relation "public.${table}" does not exist` });

export function fakeSupabase(options: FakeDbOptions = {}) {
  const tables = new Map<string, any[]>(Object.entries(options.tables || {}).map(([k, v]) => [k, v.map((r) => ({ ...r }))]));
  const missing = new Set(options.missing || []);
  const rpcCalls: Array<{ fn: string; args: any }> = [];
  const writes: Array<{ table: string; op: string; row: any }> = [];

  const builder = (name: string) => {
    let rows = () => [...(tables.get(name) || [])];
    const filters: Array<(r: any) => boolean> = [];
    const orders: Array<{ col: string; asc: boolean }> = [];
    let range: [number, number] | null = null;
    let limit: number | null = null;
    const run = () => {
      if (missing.has(name)) return { data: null, error: missingError(name), count: null };
      let out = rows().filter((r) => filters.every((f) => f(r)));
      if (orders.length) out.sort((a, b) => { for (const o of orders) { const x = String(a[o.col]); const y = String(b[o.col]); if (x !== y) return (x < y ? -1 : 1) * (o.asc ? 1 : -1); } return 0; });
      const total = out.length;
      if (range) out = out.slice(range[0], range[1] + 1);
      if (limit !== null) out = out.slice(0, limit);
      return { data: out, error: null, count: total };
    };
    const c: any = {
      select: () => c,
      eq: (col: string, val: any) => { filters.push((r) => r[col] === val); return c; },
      neq: (col: string, val: any) => { filters.push((r) => r[col] !== val); return c; },
      gte: (col: string, val: any) => { filters.push((r) => String(r[col]) >= String(val)); return c; },
      lt: (col: string, val: any) => { filters.push((r) => String(r[col]) < String(val)); return c; },
      in: (col: string, vals: any[]) => { filters.push((r) => vals.includes(r[col])); return c; },
      not: () => c,
      order: (col: string, o?: { ascending?: boolean }) => { orders.push({ col, asc: o?.ascending !== false }); return c; },
      range: (a: number, b: number) => { range = [a, b]; return c; },
      limit: (n: number) => { limit = n; return c; },
      single: async () => { const r = run(); return r.error ? r : { data: r.data![0] ?? null, error: r.data![0] ? null : { code: "PGRST116", message: "no rows" } }; },
      maybeSingle: async () => { const r = run(); return r.error ? r : { data: r.data![0] ?? null, error: null }; },
      insert: async (row: any) => {
        if (missing.has(name)) return { error: missingError(name) };
        writes.push({ table: name, op: "insert", row });
        tables.set(name, [...(tables.get(name) || []), ...(Array.isArray(row) ? row : [row])]);
        return { error: null };
      },
      upsert: async (row: any) => { writes.push({ table: name, op: "upsert", row }); return missing.has(name) ? { error: missingError(name) } : { error: null }; },
      update: (row: any) => { writes.push({ table: name, op: "update", row }); return { eq: async () => ({ error: null }) }; },
      then: (resolve: any, reject: any) => Promise.resolve(run()).then(resolve, reject),
    };
    return c;
  };

  return {
    rpcCalls,
    writes,
    from: (name: string) => builder(name),
    rpc: async (fn: string, args: any) => {
      rpcCalls.push({ fn, args });
      if ((options.rpcMissing || []).includes(fn)) return { data: null, error: { code: "PGRST202", message: `Could not find the function public.${fn} in the schema cache` } };
      const handler = options.rpc?.[fn];
      return handler ? handler(args) : { data: null, error: null };
    },
    auth: {
      admin: {
        getUserById: async (id: string) => {
          const u = options.authUsers?.[id];
          return u ? { data: { user: { id, ...u } }, error: null } : { data: { user: null }, error: { message: "not found" } };
        },
      },
    },
  };
}
