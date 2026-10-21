import { vi } from "vitest";

/**
 * A small in-memory Supabase client with the production schema where it matters here: `jobs` has NO `conversation_id`
 * column (querying it is an error, as in production), jobs belong to a conversation only through the quote ids on its
 * messages, and every insert/update lands in the store so a test can read back what a turn wrote.
 */
const KNOWN_COLUMNS: Record<string, string[]> = {
  jobs: ["id", "user_id", "status", "endpoint_id", "target_volume_min", "target_volume_max", "reserved_credits", "charged_credits", "delivered_units", "current_cursor", "accumulated_cost_usd", "attempt_count", "result_file_id", "error_message", "created_at", "updated_at", "next_attempt_at", "step", "lease_until", "unit_price", "template_slug", "capability_slug", "platform"],
};

export function createStatefulSupabase(seed: { tables?: Record<string, any[]>; files?: Record<string, string>; maxRows?: number } = {}) {
  const tables: Record<string, any[]> = {};
  for (const [name, rows] of Object.entries(seed.tables || {})) tables[name] = rows.map((row) => ({ ...row }));
  const files: Record<string, string> = { ...(seed.files || {}) };
  const rpcCalls: string[] = [];
  let seq = 0;
  const now = () => new Date(Date.UTC(2026, 9, 19, 12, 0, 0) + ++seq * 1000).toISOString();

  function builder(name: string) {
    const rows = () => (tables[name] = tables[name] || []);
    const q: any = { filters: [] as Array<(r: any) => boolean>, columns: [] as string[], order: null as null | { c: string; asc: boolean }, limit: null as null | number, offset: 0, op: "select", payload: null as any };
    const run = async (single: false | "maybe" | "one") => {
      const unknown = q.columns.find((c: string) => KNOWN_COLUMNS[name] && !KNOWN_COLUMNS[name].includes(c));
      if (unknown) return { data: null, error: { message: `column ${name}.${unknown} does not exist`, code: "42703" } };
      let matched = rows().filter((r: any) => q.filters.every((f: (r: any) => boolean) => f(r)));
      if (q.op === "insert") {
        const inserted = (Array.isArray(q.payload) ? q.payload : [q.payload]).map((p: any) => ({ id: `${name}_${++seq}`, created_at: now(), ...p }));
        rows().push(...inserted);
        return { data: single ? inserted[0] : inserted, error: null };
      }
      if (q.op === "update") {
        for (const r of matched) Object.assign(r, q.payload);
        return { data: single ? matched[0] ?? null : matched, error: null };
      }
      if (q.op === "delete") {
        tables[name] = rows().filter((r: any) => !matched.includes(r));
        return { data: matched, error: null };
      }
      if (q.order) {
        const { c, asc } = q.order;
        matched = [...matched].sort((a: any, b: any) => (a[c] < b[c] ? -1 : a[c] > b[c] ? 1 : 0) * (asc ? 1 : -1));
      }
      if (q.limit !== null) matched = matched.slice(q.offset, q.offset + q.limit);
      // The API's own per-request row ceiling (PostgREST max-rows): a read can come back cut short.
      if (seed.maxRows && !single) matched = matched.slice(0, seed.maxRows);
      if (single) return { data: matched[0] ?? null, error: single === "one" && !matched[0] ? { message: "not found" } : null };
      return { data: matched, error: null };
    };
    const b: any = {
      select: () => b,
      eq: (c: string, v: any) => { q.columns.push(c); q.filters.push((r: any) => r[c] === v); return b; },
      neq: (c: string, v: any) => { q.columns.push(c); q.filters.push((r: any) => r[c] !== v); return b; },
      in: (c: string, vs: any[]) => { q.columns.push(c); q.filters.push((r: any) => vs.includes(r[c])); return b; },
      is: (c: string, v: any) => { q.filters.push((r: any) => (r[c] ?? null) === v); return b; },
      not: () => b,
      or: () => b,
      gte: (c: string, v: any) => { q.filters.push((r: any) => r[c] >= v); return b; },
      gt: (c: string, v: any) => { q.filters.push((r: any) => r[c] > v); return b; },
      lt: (c: string, v: any) => { q.filters.push((r: any) => r[c] < v); return b; },
      ilike: (c: string, pattern: string) => { const needle = pattern.replace(/%/g, "").toLowerCase(); q.filters.push((r: any) => String(r[c] ?? "").toLowerCase().includes(needle)); return b; },
      order: (c: string, o?: { ascending?: boolean }) => { q.order = { c, asc: o?.ascending !== false }; return b; },
      limit: (n: number) => { q.limit = n; return b; },
      range: (a: number, z: number) => { q.offset = a; q.limit = z - a + 1; return b; },
      insert: (p: any) => { q.op = "insert"; q.payload = p; return b; },
      upsert: (p: any) => { q.op = "insert"; q.payload = p; return b; },
      update: (p: any) => { q.op = "update"; q.payload = p; return b; },
      delete: () => { q.op = "delete"; return b; },
      maybeSingle: () => run("maybe"),
      single: () => run("one"),
      then: (resolve: any, reject: any) => run(false).then(resolve, reject),
    };
    return b;
  }

  const client = {
    from: (name: string) => builder(name),
    rpc: vi.fn(async (name: string) => { rpcCalls.push(name); return { data: null, error: null }; }),
    storage: {
      from: (bucket: string) => ({
        download: async (path: string) => (files[`${bucket}/${path}`] !== undefined ? { data: { text: async () => files[`${bucket}/${path}`] }, error: null } : { data: null, error: { message: "not found" } }),
        upload: async (path: string, body: any) => { files[`${bucket}/${path}`] = String(body); return { error: null }; },
      }),
    },
  };
  return {
    client,
    rows: (name: string) => (tables[name] || []) as any[],
    rpcCalls,
  };
}
