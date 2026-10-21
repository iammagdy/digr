/**
 * The offline load harness (E1). It adds two things to the in-memory Supabase fake the tests already use:
 *  - every awaited query waits a fixed time (a stand-in for the round trip to the database), and is counted;
 *  - the count and the order of those waits can be read per run, so "how many database round trips one chat turn waits for, one after
 *    the other" is a measured number, not a guess.
 * Nothing here talks to a network, a provider or a model.
 */
import { createStatefulSupabase } from "./statefulSupabase";

export interface QueryStats {
  /** Every awaited query, in the order it started. */
  ops: Array<{ table: string; kind: string }>;
  /** Milliseconds each query waits (the fake round trip). */
  latencyMs: number;
  /** The largest number of queries that were waiting at the same moment (parallelism the code really uses). */
  maxInFlight: number;
  inFlight: number;
}

export function createLatencyDb(seed: Parameters<typeof createStatefulSupabase>[0] = {}, latencyMs = 4) {
  const base = createStatefulSupabase(seed);
  const stats: QueryStats = { ops: [], latencyMs, maxInFlight: 0, inFlight: 0 };
  const wait = async (table: string, kind: string) => {
    stats.ops.push({ table, kind });
    stats.inFlight += 1;
    stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
    await new Promise((resolve) => setTimeout(resolve, latencyMs));
    stats.inFlight -= 1;
  };
  const wrapBuilder = (table: string) => {
    const inner: any = base.client.from(table);
    let kind = "select";
    const proxy: any = new Proxy(inner, {
      get(target, prop: string) {
        const value = target[prop];
        if (prop === "insert" || prop === "upsert" || prop === "update" || prop === "delete") return (...args: any[]) => { kind = prop; value.apply(target, args); return proxy; };
        if (prop === "maybeSingle" || prop === "single") return async () => { await wait(table, kind); return value.apply(target, []); };
        if (prop === "then") return (resolve: any, reject: any) => wait(table, kind).then(() => value.call(target, resolve, reject), reject);
        if (typeof value === "function") return (...args: any[]) => { value.apply(target, args); return proxy; };
        return value;
      },
    });
    return proxy;
  };
  const client: any = {
    ...base.client,
    from: (table: string) => wrapBuilder(table),
    rpc: async (name: string, ..._args: unknown[]) => { await wait("rpc", name); return base.client.rpc(name); },
  };
  return { client, stats, rows: base.rows, reset: () => { stats.ops.length = 0; stats.maxInFlight = 0; stats.inFlight = 0; } };
}

/** The p-th percentile of a list of numbers (nearest rank). */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}
