import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCallRecorder } from "../src/lib/server/multiProvider/callRecorder";
import { commitTregSpend } from "../src/lib/server/tregCallRecord";
import { executeTregCall } from "../src/functions/shared/tregClient";
import { POOL_SNAPSHOT_TTL_MS } from "../src/lib/server/tregKeyPool";
import { parseCallsLogQuery, readCallsLog, readFilteredCalls, summarizeCalls } from "../src/lib/server/adminCallsLog";
import { EXPORT_COLUMNS, KEY_COLUMN, exportColumns, exportRows, toCsv } from "../src/lib/server/callsLogExport";
import { createGateway } from "../agent/src/gateway";
import { createJobCallBudget } from "../src/lib/server/callBudget";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { createMemoryStore, newMission } from "../agent/src/memoryStore";
import { NOT_ADMIN, POSTS_ENDPOINT, USER_ID } from "./helpers/agentHarness";
import { ADMIN, callOptions, clock, fakeSecret, makePoolWorld, teardownPoolWorld } from "./helpers/tregPoolKit";
import { captureConsole } from "./helpers/providerKeyTestKit";

/**
 * Every provider call records which pool key made it (number and label only), the calls log filters by key and shows spend per key, and while the pool is OFF nothing changes:
 * no mark, no column, no filter.
 */
let w: ReturnType<typeof makePoolWorld>;
let logs: ReturnType<typeof captureConsole>;
beforeEach(() => { w = makePoolWorld(); logs = captureConsole(); });
afterEach(() => { logs.restore(); teardownPoolWorld(); });

/** A Supabase stand-in: the cost functions answer, the pool functions go to the pool model. */
function combinedClient() {
  let nextCost = 1;
  const cost: Record<number, { usd: number }> = {};
  return {
    cost,
    rpc: async (fn: string, args: any) => {
      if (fn.startsWith("treg_pool_") || fn.startsWith("admin_")) return w.db.client.rpc(fn, args);
      if (fn === "reserve_provider_spend_atomic") { const id = nextCost++; return { data: { allowed: true, cost_id: id }, error: null }; }
      if (fn === "commit_provider_spend_v2") { cost[args.p_cost_id] = { usd: args.p_actual_cost_usd }; w.db.setCost(args.p_cost_id, args.p_actual_cost_usd); return { data: null, error: null }; }
      return { data: null, error: null };
    },
    from: () => { const c: any = { select: () => c, eq: () => c, gte: () => c, lt: () => c, maybeSingle: async () => ({ data: null, error: null }), insert: async () => ({ error: null }) }; return c; },
  };
}

describe("the call is marked with its key when its cost row is committed", () => {
  it("website path: the job's latest call decides the key; after a switch the next row carries the new key", async () => {
    const client = combinedClient();
    const recorder = createCallRecorder(client, { capFor: async () => 10 });
    const main = w.addKey({ isMain: true }); const a = w.addKey({ label: "اختبار-١" }); const b = w.addKey({ label: "اختبار-٢" });
    w.switchOn(a.id);
    const commitFor = async (jobId: string) => {
      const res = await recorder.reserve({ provider: "treg", capabilityId: "x", estimatedUsd: 0.01, jobId });
      await executeTregCall(callOptions({ jobId }));
      await recorder.commit(res.costId, { provider: "treg", capabilityId: "x", status: "success", units: 1, costUsd: 0.001, durationMs: 5, jobId });
      return res.costId as number;
    };
    const c1 = await commitFor("job_1");
    await w.db.client.rpc("admin_set_treg_active_key", { p_admin_id: ADMIN, p_key_id: b.id, p_force: false });
    clock.advance(POOL_SNAPSHOT_TTL_MS + 100);
    const c2 = await commitFor("job_1");
    expect(w.db.calls.get(c1)).toMatchObject({ key_number: a.number, key_label: "اختبار-١", source: "website" });
    expect(w.db.calls.get(c2)).toMatchObject({ key_number: b.number, key_label: "اختبار-٢" });
    expect(JSON.stringify([...w.db.calls.values()])).not.toContain(a.plaintext);
    expect(main.plaintext).not.toBe(a.plaintext);
  });

  it("worker gateway: the explicit key of the call is recorded with source «worker»; the mission call carries the same cost row", async () => {
    const worker = makePoolWorld({ source: "worker" });
    w = worker;
    const heroku = fakeSecret("heroku"); worker.treg.set(heroku);
    worker.addKey({ isMain: true }); const t1 = worker.addKey({ label: "اختبار-١" });
    worker.switchOn(t1.id);
    const client = combinedClient();
    const store = createMemoryStore();
    const mission = newMission({ id: "msn_k1", user_id: USER_ID, request_text: "x", status: "planning", job_id: null });
    store.missions.set(mission.id, mission);
    const recorder = createCallRecorder(client, { capFor: async () => 10 });
    const gateway = createGateway({
      store, client, missionId: mission.id, userId: USER_ID, jobId: null, phase: "planning", access: NOT_ADMIN, catalog: loadTregCatalog(), budget: createJobCallBudget({ ceilingUsd: 1, spentUsd: 0 }),
      recorder, token: heroku, defaultPurpose: "x", counter: { seq: 0 },
    });
    const r = await gateway.tregCall({ endpoint_id: POSTS_ENDPOINT, params: { query: "q", max_results: 2 } });
    expect(worker.treg.tokensOfCalls()).toEqual([t1.plaintext]);
    expect(r).toMatchObject({ ok: true });
    const marks = [...worker.db.calls.entries()];
    expect(marks).toHaveLength(1);
    expect(marks[0][1]).toMatchObject({ key_number: t1.number, source: "worker" });
    const calls = await store.listCalls(mission.id);
    expect(calls[0].provider_cost_id).toBe(marks[0][0]);
  });

  it("while the pool is OFF nothing is marked and the call result has no key reference", async () => {
    const client = combinedClient();
    const legacy = fakeSecret("legacy"); vi.stubEnv("TREG_TOKEN", legacy); w.treg.set(legacy);
    w.addKey({ isMain: true });
    const recorder = createCallRecorder(client, { capFor: async () => 10 });
    const res = await recorder.reserve({ provider: "treg", capabilityId: "x", estimatedUsd: 0.01, jobId: "job_off" });
    const r = await executeTregCall(callOptions({ jobId: "job_off" }));
    await recorder.commit(res.costId, { provider: "treg", capabilityId: "x", status: "success", units: 1, costUsd: 0.001, durationMs: 5, jobId: "job_off" });
    expect(r.keyRef).toBeUndefined();
    expect(w.db.calls.size).toBe(0);
    expect(w.db.rpcCount("treg_pool_record_call")).toBe(0);
  });

  it("a mark that cannot be written never fails or blocks the commit", async () => {
    const client = combinedClient();
    const a = w.addKey({ isMain: true }); w.switchOn(a.id);
    const recorder = createCallRecorder(client, { capFor: async () => 10 });
    const res = await recorder.reserve({ provider: "treg", capabilityId: "x", estimatedUsd: 0.01, jobId: "job_x" });
    await executeTregCall(callOptions({ jobId: "job_x" }));
    w.db.flags.missingFunctions = true;
    await expect(commitTregSpend(client, { costId: res.costId, costUsd: 0.001, units: 1, capabilityId: "x", status: "success", durationMs: 5, jobId: "job_x" })).resolves.toBeUndefined();
    expect(client.cost[res.costId as number].usd).toBe(0.001);
  });
});

// ---- the calls log -----------------------------------------------------------------------------------------------------------------------

interface CostRow { id: number; provider: string; job_id: string | null; units: number; cost_usd: number; created_at: string; is_estimate: boolean; capability: string | null; status: string | null; duration_ms: number | null }
function logClient(costs: CostRow[], marks: Array<{ provider_cost_id: number; key_number: number; key_label: string; created_at: string }> | null) {
  const writes: string[] = [];
  const client: any = {
    from: (table: string) => {
      const filters: Array<(r: any) => boolean> = []; let order: { c: string; asc: boolean } | null = null; let lim: number | null = null; let off = 0;
      const source = () => (table === "provider_costs" ? costs : table === "treg_pool_calls" ? marks ?? [] : []);
      const run = async (single = false) => {
        if (table === "treg_pool_calls" && marks === null) return { data: null, error: { code: "42P01", message: 'relation "public.treg_pool_calls" does not exist' } };
        let rows = (source() as any[]).filter((r) => filters.every((f) => f(r)));
        if (order) { const { c, asc } = order; rows = [...rows].sort((a, b) => (a[c] < b[c] ? -1 : a[c] > b[c] ? 1 : 0) * (asc ? 1 : -1)); }
        if (lim !== null) rows = rows.slice(off, off + lim);
        return single ? { data: rows[0] ?? null, error: null } : { data: rows, error: null };
      };
      const b: any = {
        select: () => b, eq: (c: string, v: any) => { filters.push((r) => r[c] === v); return b; }, gte: (c: string, v: any) => { filters.push((r) => r[c] >= v); return b; }, lt: (c: string, v: any) => { filters.push((r) => r[c] < v); return b; },
        in: (c: string, vs: any[]) => { filters.push((r) => vs.includes(r[c])); return b; }, order: (c: string, o?: { ascending?: boolean }) => { order = { c, asc: o?.ascending !== false }; return b; },
        limit: (n: number) => { lim = n; return b; }, range: (a: number, z: number) => { off = a; lim = z - a + 1; return b; }, maybeSingle: () => run(true),
        insert: async () => { writes.push(`insert:${table}`); return { error: null }; }, update: () => { writes.push(`update:${table}`); return b; }, upsert: () => { writes.push(`upsert:${table}`); return b; }, delete: () => { writes.push(`delete:${table}`); return b; },
        then: (resolve: any, reject: any) => run().then(resolve, reject),
      };
      return b;
    },
    rpc: async (name: string) => { writes.push(`rpc:${name}`); return { data: null, error: null }; },
  };
  return { client, writes };
}
const row = (id: number, provider: string, usd: number): CostRow => ({ id, provider, job_id: null, units: 1, cost_usd: usd, created_at: `2026-10-22T0${id % 9}:00:00.000Z`, is_estimate: false, capability: "x", status: "success", duration_ms: 10 });
const COSTS = [row(1, "treg", 0.01), row(2, "treg", 0.02), row(3, "treg", 0.04), row(4, "treg", 0.08), row(5, "firecrawl", 0.5)];
const MARKS = [
  { provider_cost_id: 1, key_number: 2, key_label: "اختبار-١", created_at: "2026-10-22T01:00:00.000Z" },
  { provider_cost_id: 2, key_number: 2, key_label: "اختبار-١", created_at: "2026-10-22T02:00:00.000Z" },
  { provider_cost_id: 3, key_number: 3, key_label: "اختبار-٢", created_at: "2026-10-22T03:00:00.000Z" },
];
const q = (qs: string) => { const p = parseCallsLogQuery(new URLSearchParams(qs)); if (!p.ok) throw new Error(p.messageAr); return p.value; };

describe("the calls log, by key", () => {
  it("each TREG row carries its key number and label; a TREG call without a mark says so (null); other providers carry nothing", async () => {
    const { client } = logClient(COSTS, MARKS);
    const { rows, keyOptions } = await readFilteredCalls(client, q(""));
    const by = (id: number) => rows.find((r) => r.id === id)!;
    expect(by(1)).toMatchObject({ keyNumber: 2, keyLabel: "اختبار-١" });
    expect(by(3)).toMatchObject({ keyNumber: 3, keyLabel: "اختبار-٢" });
    expect(by(4)).toMatchObject({ keyNumber: null, keyLabel: null });
    expect("keyNumber" in by(5)).toBe(false);
    expect(keyOptions).toEqual([{ number: 2, label: "اختبار-١", calls: 2 }, { number: 3, label: "اختبار-٢", calls: 1 }]);
  });

  it("filters by key number, and «none» keeps the TREG calls made before the pool was switched on", async () => {
    const { client } = logClient(COSTS, MARKS);
    expect((await readFilteredCalls(client, q("key=2"))).rows.map((r) => r.id).sort()).toEqual([1, 2]);
    expect((await readFilteredCalls(client, q("key=3"))).rows.map((r) => r.id)).toEqual([3]);
    expect((await readFilteredCalls(client, q("key=none"))).rows.map((r) => r.id)).toEqual([4]);
    expect(parseCallsLogQuery(new URLSearchParams("key=abc")).ok).toBe(false);
    expect(parseCallsLogQuery(new URLSearchParams("key=2")).ok).toBe(true);
  });

  it("spend per key is the sum of the cost rows the platform already wrote, for the filtered rows", async () => {
    const { client } = logClient(COSTS, MARKS);
    const log = await readCallsLog(client, q(""));
    expect(log.summary.byKey).toEqual([{ keyNumber: 2, keyLabel: "اختبار-١", calls: 2, costUsd: expect.closeTo(0.03, 8) }, { keyNumber: 3, keyLabel: "اختبار-٢", calls: 1, costUsd: expect.closeTo(0.04, 8) }]);
    expect(log.keyOptions).toHaveLength(2);
    expect((await readCallsLog(client, q("key=3"))).filters.key).toBe("3");
  });

  it("read only: the key filter and the marks never write anything", async () => {
    const { client, writes } = logClient(COSTS, MARKS);
    await readCallsLog(client, q("key=2"));
    expect(writes.filter((x) => !x.startsWith("rpc:"))).toEqual([]);
  });

  it("before the pool has marked anything (no table, or no rows) the log is exactly what it always was: no key field, no option, no column", async () => {
    for (const marks of [null, []]) {
      const { client } = logClient(COSTS, marks as any);
      const { rows, keyOptions } = await readFilteredCalls(client, q(""));
      expect(keyOptions).toBeUndefined();
      expect(rows.every((r) => !("keyNumber" in r))).toBe(true);
      const log = await readCallsLog(client, q(""));
      expect(log.summary.byKey).toBeUndefined();
      expect(exportColumns(rows)).toBe(EXPORT_COLUMNS);
      expect(toCsv(rows).split("\r\n")[0].split(",")).toHaveLength(EXPORT_COLUMNS.length);
    }
  });

  it("the export adds one column «المفتاح (TREG)» only when rows carry marks, and only a number and a label", async () => {
    const { client } = logClient(COSTS, MARKS);
    const { rows } = await readFilteredCalls(client, q("provider=treg"));
    expect(exportColumns(rows)).toEqual([...EXPORT_COLUMNS, KEY_COLUMN]);
    const cells = exportRows(rows);
    expect(cells.every((c) => c.length === EXPORT_COLUMNS.length + 1)).toBe(true);
    expect(cells.map((c) => c.at(-1))).toContain("#2 اختبار-١");
    expect(summarizeCalls(rows).byKey?.map((k) => k.keyNumber)).toEqual([2, 3]);
  });
});

describe("the calls log screen", () => {
  it("renders the key filter and column only when the log has keys (static markup of the component with data is covered by the existing screen test; here: the module loads without a browser)", async () => {
    const mod = await import("../src/components/admin/AllCallsLog");
    const html = renderToStaticMarkup(createElement(mod.AllCallsLog));
    expect(html).toContain("سجل الاستدعاءات");
    expect(html).not.toContain("مفتاح TREG"); // no data loaded yet: no key filter
  });
});
