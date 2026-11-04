import { fakeMoneyClient } from "./agentMoney";
import { previewClient } from "./reviewQuoteWorld";
import { OPEN_STATUSES } from "../../src/lib/agentMission/stage4/addonRow";

/**
 * STAGE E: A SCHEDULED WORLD FOR THE CONCURRENCY TESTS. One Supabase-shaped client per concurrent actor, over ONE shared state:
 *   - the `missions` table as a real table behaves for what the add-on code does: a primary key (code 23505), filters by `.eq` (the JSON path `plan->addon->>of` included), `.is`, `.in`, an `update` applied ONLY to the rows its filters match at that moment (a compare-and-set) whose
 *     `.select("id")` returns exactly the rows it changed, and `mission_events` inserts recorded;
 *   - OPTIONALLY the PROPOSED partial unique index of docs/MONEY-PR-7A.md section 17.5 (`uniqueOpenIndex`): one open add-on per `plan->addon->>of`, a violation is code 23505 with the index's own constraint name;
 *   - the hardened money fake (`fakeMoneyClient`) behind `rpc`, with its failure injection;
 *   - the storage bucket of `previewClient` (read-only; storage reads are NOT scheduled: the objects never change, so they add no interleaving).
 * EVERY table operation and EVERY rpc is one atomic step (as one SQL statement is). A scheduler picks which pending step of which actor runs next; `explore` runs every order (a depth-first walk of the choices), so a property is proved over all interleavings, not over one lucky run.
 * Nothing here reaches a database, a provider or the network.
 */
export type Row = Record<string, any>;
export const PK_CONSTRAINT = "missions_pkey";
export const INDEX_CONSTRAINT = "missions_one_open_addon_per_file";
const isOpenStatus = (s: unknown) => (OPEN_STATUSES as ReadonlyArray<string>).includes(String(s));
export const addonOf = (r: Row): string | null => (r.plan && typeof r.plan === "object" && r.plan.addon && typeof r.plan.addon.of === "string" ? r.plan.addon.of : null);
export const isOpenAddon = (r: Row): boolean => addonOf(r) !== null && isOpenStatus(r.status);
const valueAt = (row: Row, col: string): unknown => col.split(/->>?/).reduce((v: any, k) => (v === null || v === undefined ? v : v[k]), row);

export interface OpInfo {
  /** Which actor (the index in the list of makers). */
  client: number;
  /** "select" | "insert" | "update" | "events" | "rpc:<name>" */
  op: string;
  /** How many operations of this kind this actor has started, counting this one (1-based). */
  n: number;
  /** Has this actor's own insert into `missions` already committed? */
  inserted: boolean;
}
export interface SchedOpts {
  seed?: Row[];
  /** The storage objects (the published versions). */
  objects: Record<string, string>;
  balance?: number;
  /** The proposed partial unique index on `(plan->'addon'->>'of')` among open add-on rows. */
  uniqueOpenIndex?: boolean;
  /** A `select` that this returns true for answers «nothing» (it ran before the rows it would have found were visible: a stale read). */
  stale?: (info: OpInfo) => boolean;
  /** A step that this returns true for FAILS and changes nothing (the database or the network went away before it ran). */
  fault?: (info: OpInfo) => boolean;
  /** Runs once on a fresh world before the actors start (money failure injection, seeded jobs). */
  setup?: (w: World) => void;
}
export interface World {
  rows: Map<string, Row>;
  events: Row[];
  money: ReturnType<typeof fakeMoneyClient>;
  /** Tables other than `missions` and `mission_events` that were touched (must stay empty). */
  other: string[];
  /** The most open add-on rows ever seen on one file, after any step. */
  maxOpen: number;
}
export interface Actor { client: any; index: number; world: World }
export type Maker = (a: Actor) => Promise<unknown>;

type Pending = { exec: () => unknown; resolve: (v: unknown) => void; reject: (e: unknown) => void };
const settle = () => new Promise<void>((r) => setImmediate(r));
const openCount = (rows: Map<string, Row>): number => {
  const per = new Map<string, number>();
  for (const r of rows.values()) if (isOpenAddon(r)) per.set(addonOf(r)!, (per.get(addonOf(r)!) ?? 0) + 1);
  return Math.max(0, ...per.values());
};

export async function runSchedule(makers: Maker[], choices: number[], opts: SchedOpts) {
  const rows = new Map<string, Row>((opts.seed ?? []).map((r) => [String(r.id), JSON.parse(JSON.stringify(r))]));
  const money = fakeMoneyClient({ balance: opts.balance ?? 100_000 });
  const world: World = { rows, events: [], money, other: [], maxOpen: openCount(rows) };
  opts.setup?.(world);
  const storage = previewClient(opts.objects).storage;
  const pending: Pending[] = [];
  const exec = <T,>(fn: () => T) => new Promise<T>((resolve, reject) => pending.push({ exec: fn, resolve: resolve as (v: unknown) => void, reject }));

  const clientFor = (index: number): any => {
    const counts = new Map<string, number>();
    let inserted = false;
    const failing = (op: string): boolean => {
      const n = (counts.get(op) ?? 0) + 1;
      counts.set(op, n);
      return Boolean(opts.fault?.({ client: index, op, n, inserted }));
    };
    const down = { message: "database is down" };
    const builder = (table: string) => {
      let op: "select" | "insert" | "update" = "select";
      let payload: any;
      let wantRows = false;
      const filters: Array<(r: Row) => boolean> = [];
      const run = (): { data: any; error: any } => {
        if (table === "mission_events") {
          if (failing("events")) return { data: null, error: down };
          world.events.push(payload);
          return { data: null, error: null };
        }
        if (table !== "missions") { world.other.push(`${op} ${table}`); return { data: null, error: { message: `unexpected table ${table}` } }; }
        if (failing(op)) return { data: null, error: down };
        if (op === "insert") {
          if (rows.has(payload.id)) return { data: null, error: { code: "23505", message: `duplicate key value violates unique constraint "${PK_CONSTRAINT}"` } };
          const row = { job_id: null, approved_at: null, ...JSON.parse(JSON.stringify(payload)) };
          if (opts.uniqueOpenIndex && isOpenAddon(row) && [...rows.values()].some((r) => isOpenAddon(r) && addonOf(r) === addonOf(row))) {
            return { data: null, error: { code: "23505", message: `duplicate key value violates unique constraint "${INDEX_CONSTRAINT}"` } };
          }
          rows.set(row.id, row);
          inserted = true;
          world.maxOpen = Math.max(world.maxOpen, openCount(rows));
          return { data: null, error: null };
        }
        if (op === "update") {
          const hit = [...rows.values()].filter((r) => filters.every((f) => f(r)));
          for (const r of hit) {
            const next = { ...r, ...payload };
            // the index also guards an update that would make a second row open
            if (opts.uniqueOpenIndex && isOpenAddon(next) && !isOpenAddon(r) && [...rows.values()].some((o) => o !== r && isOpenAddon(o) && addonOf(o) === addonOf(next))) {
              return { data: null, error: { code: "23505", message: `duplicate key value violates unique constraint "${INDEX_CONSTRAINT}"` } };
            }
            Object.assign(r, payload);
          }
          world.maxOpen = Math.max(world.maxOpen, openCount(rows));
          return { data: wantRows ? hit.map((r) => ({ id: r.id })) : null, error: null };
        }
        if (opts.stale?.({ client: index, op: "select", n: counts.get("select") ?? 0, inserted })) return { data: [], error: null };
        return { data: [...rows.values()].filter((r) => filters.every((f) => f(r))).map((r) => JSON.parse(JSON.stringify(r))), error: null };
      };
      const b: any = {
        select: () => { if (op !== "select") wantRows = true; return b; },
        insert: (row: any) => { op = "insert"; payload = row; return b; },
        update: (patch: any) => { op = "update"; payload = patch; return b; },
        eq: (c: string, v: unknown) => { filters.push((r) => valueAt(r, c) === v); return b; },
        is: (c: string, v: unknown) => { filters.push((r) => (v === null ? valueAt(r, c) === null || valueAt(r, c) === undefined : valueAt(r, c) === v)); return b; },
        in: (c: string, vs: unknown[]) => { filters.push((r) => vs.includes(valueAt(r, c))); return b; },
        limit: () => b,
        maybeSingle: () => exec(() => { const { data, error } = run(); return { data: Array.isArray(data) ? data[0] ?? null : null, error }; }),
        then: (resolve: any, reject: any) => exec(run).then(resolve, reject),
      };
      return b;
    };
    return {
      from: (t: string) => builder(t),
      storage,
      rpc: (name: string, args: any) => exec(() => (failing(`rpc:${name}`) ? Promise.resolve({ error: down }) : money.client.rpc(name, args))),
      auth: { admin: { getUserById: async () => ({ data: { user: null } }) } },
    };
  };

  const settled = makers.map(() => false);
  const results = makers.map((m, i) => m({ client: clientFor(i), index: i, world }).then((v) => { settled[i] = true; return { ok: true as const, value: v }; }, (e) => { settled[i] = true; return { ok: false as const, error: e }; }));
  const widths: number[] = [];
  const picks: number[] = [];
  let guard = 0;
  while (!settled.every(Boolean)) {
    if (++guard > 2000) throw new Error("the scheduler did not finish");
    await settle();
    if (pending.length === 0) continue;
    let pick = 0;
    if (pending.length > 1) { pick = (choices[widths.length] ?? 0) % pending.length; widths.push(pending.length); picks.push(pick); }
    const [p] = pending.splice(pick, 1);
    try { p.resolve(p.exec()); } catch (e) { p.reject(e); }
  }
  return { world, rows, money, results: await Promise.all(results), widths, picks };
}
export type Out = Awaited<ReturnType<typeof runSchedule>>;

/** Every order of the pending steps (depth-first over the choices). `check` runs on every end state. */
export async function explore(makers: Maker[], check: (out: Out) => void | Promise<void>, opts: SchedOpts, maxRuns = 40_000): Promise<{ runs: number }> {
  const stack: number[][] = [[]];
  let runs = 0;
  while (stack.length > 0) {
    const prefix = stack.pop()!;
    const out = await runSchedule(makers, prefix, opts);
    runs += 1;
    await check(out);
    for (let i = prefix.length; i < out.widths.length; i += 1) for (let alt = 1; alt < out.widths[i]; alt += 1) stack.push([...out.picks.slice(0, i), alt]);
    if (runs > maxRuns) throw new Error(`too many schedules (${runs})`);
  }
  return { runs };
}

export const openRows = (rows: Map<string, Row>, of?: string): Row[] => [...rows.values()].filter((r) => isOpenAddon(r) && (of === undefined || addonOf(r) === of));
export const addonRows = (rows: Map<string, Row>): Row[] => [...rows.values()].filter((r) => addonOf(r) !== null);

/** One actor on a fresh world, no interleaving: what a later reader of the same table does. */
export async function solo<T>(opts: SchedOpts, fn: (client: any, world: World) => Promise<T>): Promise<{ value: T; out: Out }> {
  const out = await runSchedule([async (a) => fn(a.client, a.world)], [], opts);
  const r = out.results[0];
  if (!r.ok) throw r.error;
  return { value: r.value as T, out };
}
