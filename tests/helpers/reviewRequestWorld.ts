import { OPEN_STATUSES } from "../../src/lib/agentMission/stage4/addonRow";
import { MISSION, OTHER_MISSION, ME, previewClient } from "./reviewQuoteWorld";

export { MISSION, OTHER_MISSION, ME };

/**
 * A STATEFUL FAKE WORLD FOR THE REVIEW REQUEST (MONEY PR 7d, PHASE 2B-2 TASK 3): the `missions` table as a real table would behave for what the request code does: a primary key that refuses a second row of the same id (code 23505), filters by `.eq` (the JSON path
 * `plan->addon->>of` included), `.is(col, null)` and `.in`, an `update` that is applied ONLY to the rows its filters match at that moment (a compare-and-set), and `.select("id")` after it that returns exactly the rows it changed. The storage bucket is the read-only one of
 * `previewClient`. Every table other than `missions`, every rpc and every storage write is recorded: a review request must touch none of them (no job, no ledger, no wallet, no reservation).
 */
export interface WorldOpts {
  seed?: Array<Record<string, unknown>>;
  listError?: boolean; downloadError?: boolean;
  /** the list query of add-on rows fails */
  addonQueryError?: boolean;
  missionError?: boolean;
  insertError?: boolean;
  updateError?: boolean;
  /** The READ-ONLY money tables the paid-review verdict looks at (safety fix B): a job per id and ledger lines per job. Empty by default (no job, no ledger row = «nothing was reserved»). A write to them is recorded in `other`. */
  jobs?: Array<Record<string, unknown>>;
  ledger?: Array<Record<string, unknown>>;
  /** called just before an update is matched: a test changes the row here to model another process winning the race */
  beforeUpdate?: (rows: Map<string, any>, id: string | null) => void;
}

export function requestClient(objects: Record<string, string>, opts: WorldOpts = {}) {
  const base = previewClient(objects, { listError: opts.listError, downloadError: opts.downloadError });
  const rows = new Map<string, any>();
  for (const r of [
    { id: MISSION, user_id: ME, status: "completed", plan: { stages: [] }, delivered_units: 60 },
    { id: OTHER_MISSION, user_id: "u-2", status: "completed", plan: { stages: [] }, delivered_units: 1 },
    ...(opts.seed ?? []),
  ]) rows.set(String(r.id), { ...r });
  const log: string[] = [];
  const tables = new Set<string>();
  const other: string[] = [];
  const moneyReads: string[] = [];
  const valueAt = (row: any, col: string): unknown => col.split(/->>?/).reduce((v: any, k) => (v === null || v === undefined ? v : v[k]), row);

  function builder(table: string) {
    tables.add(table);
    let op: "select" | "insert" | "update" = "select";
    let payload: any;
    let wantRows = false;
    let addonPath = false;
    const filters: Array<(r: any) => boolean> = [];
    let idFilter: string | null = null;
    const run = (): { data: any; error: any } => {
      if ((table === "jobs" || table === "credit_ledger") && op === "select") {
        moneyReads.push(table);
        return { data: (table === "jobs" ? opts.jobs ?? [] : opts.ledger ?? []).filter((r) => filters.every((f) => f(r))).map((r) => ({ ...r })), error: null };
      }
      if (table !== "missions") { other.push(`${op} ${table}`); return { data: null, error: { message: `unexpected table ${table}` } }; }
      if (op === "insert") {
        if (opts.insertError) return { data: null, error: { message: "database is down" } };
        if (rows.has(payload.id)) return { data: null, error: { code: "23505", message: 'duplicate key value violates unique constraint "missions_pkey"' } };
        rows.set(payload.id, { ...payload, created_at: new Date().toISOString() });
        log.push(`insert ${payload.id} ${payload.status}`);
        return { data: null, error: null };
      }
      if (op === "update") {
        if (opts.updateError) return { data: null, error: { message: "database is down" } };
        opts.beforeUpdate?.(rows, idFilter);
        const hit = [...rows.values()].filter((r) => filters.every((f) => f(r)));
        for (const r of hit) { Object.assign(r, payload); log.push(`update ${r.id} ${JSON.stringify(payload)}`); }
        return { data: wantRows ? hit.map((r) => ({ id: r.id })) : null, error: null };
      }
      if (opts.addonQueryError && addonPath) return { data: null, error: { message: "database is down" } };
      return { data: [...rows.values()].filter((r) => filters.every((f) => f(r))).map((r) => ({ ...r })), error: null };
    };
    const b: any = {
      select: () => { if (op !== "select") wantRows = true; return b; },
      insert: (row: any) => { op = "insert"; payload = row; return b; },
      update: (patch: any) => { op = "update"; payload = patch; return b; },
      eq: (c: string, v: unknown) => { if (c === "id") idFilter = String(v); if (c.includes("->")) addonPath = true; filters.push((r) => valueAt(r, c) === v); return b; },
      is: (c: string, v: unknown) => { filters.push((r) => (v === null ? valueAt(r, c) === null || valueAt(r, c) === undefined : valueAt(r, c) === v)); return b; },
      in: (c: string, vs: unknown[]) => { filters.push((r) => vs.includes(valueAt(r, c))); return b; },
      limit: () => b,
      maybeSingle: async () => {
        if (opts.missionError) return { data: null, error: { message: "database is down" } };
        const { data, error } = run();
        return { data: Array.isArray(data) ? data[0] ?? null : null, error };
      },
      then: (resolve: any, reject: any) => Promise.resolve().then(run).then(resolve, reject),
    };
    return b;
  }
  return {
    from: (t: string) => builder(t),
    storage: base.storage,
    rpc: async (name: string) => { other.push(`rpc ${name}`); return { data: null, error: null }; },
    auth: base.auth,
    rows, log, tables, other, moneyReads, storageWrites: base.writes,
  };
}
export type RequestWorld = ReturnType<typeof requestClient>;

/** The add-on rows of a mission that are open, and every add-on row, from the world's own table. */
export const addonRowsIn = (w: RequestWorld, of = MISSION) => [...w.rows.values()].filter((r) => r.plan?.addon?.of === of);
export const openRowsIn = (w: RequestWorld, of = MISSION) => addonRowsIn(w, of).filter((r) => (OPEN_STATUSES as ReadonlyArray<string>).includes(r.status));
