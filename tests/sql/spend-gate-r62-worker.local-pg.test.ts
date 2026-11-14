import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createScratchDb, scratchPgTarget, type ScratchDb } from "./localPg";
import { createSupabaseSpendGate } from "../../src/lib/server/spendGate/supabaseGate";
import { createGateway } from "../../agent/src/gateway";
import { createMemoryStore, newMission } from "../../agent/src/memoryStore";
import { createWorkerSpendGate } from "../../agent/src/spendGateWiring";
import { createJobCallBudget } from "../../src/lib/server/callBudget";
import { loadTregCatalog } from "../../src/lib/treg/catalog";
import type { TregCallOptions } from "../../src/functions/shared/tregClient";
import { fakeRecorder, NOT_ADMIN, POSTS_ENDPOINT, USER_ID, postsPage, tregResult } from "../helpers/agentHarness";

/**
 * ROUND 62: the WORKER's database adapter (src/lib/server/spendGate/supabaseGate.ts) and the TREG gateway against the REAL spend-gate SQL
 * (docs/proposals/spend-gate/sql/001_spend_gate.sql) on a scratch PostgreSQL 16 (DIGER_TEST_PG; skipped otherwise; NEVER Supabase). The adapter's `rpc` is
 * served by psql as service_role, exactly the role the worker holds. Nothing is applied anywhere else; no paid call (TREG is a fake).
 */
vi.stubGlobal("fetch", () => { throw new Error("a real network call was attempted"); });
const DIR = path.resolve(__dirname, "../../docs/proposals/spend-gate/sql");
const S = "SET ROLE service_role;";
const lit = (v: unknown) => (v === null || v === undefined ? "null" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

describe.skipIf(!scratchPgTarget())("R62 the worker's gate adapter against the real spend-gate SQL", () => {
  let db: ScratchDb;
  const rpcClient = () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      try {
        const sig = fn === "spend_reserve" ? `public.spend_reserve(${["p_key", "p_kind", "p_op", "p_bound_usd", "p_mission_id", "p_ttl_seconds"].map((k) => lit(args[k])).join(",")})`
          : fn === "spend_settle" ? `public.spend_settle(${lit(args.p_reservation)}::uuid,${lit(args.p_actual_usd)})`
          : fn === "spend_stop" ? `public.spend_stop(${lit(args.p_reason)})` : null;
        if (!sig) return { data: null, error: { message: `unknown function ${fn}` } };
        return { data: JSON.parse(await db.sqlAsync(`${S} select ${sig}`)), error: null };
      } catch (e) {
        return { data: null, error: { message: String((e as Error).message).slice(0, 120) } };
      }
    },
  });
  const grant = () => JSON.parse(db.sql("select row_to_json(g) from spend_gate.grants g order by issued_at desc limit 1"));

  beforeAll(() => {
    db = createScratchDb();
    db.sql("ALTER DEFAULT PRIVILEGES GRANT ALL ON TABLES TO anon, authenticated, service_role; ALTER DEFAULT PRIVILEGES GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role; ALTER DEFAULT PRIVILEGES GRANT ALL ON SEQUENCES TO anon, authenticated, service_role");
    db.sql(readFileSync(path.join(DIR, "001_spend_gate.sql"), "utf8"));
  }, 240000);
  afterAll(() => db?.drop());

  it("NO GRANT (the state the SQL is created in): the adapter refuses and the gateway sends nothing", async () => {
    const gate = createSupabaseSpendGate(rpcClient());
    expect(await gate.reserve({ key: "k0", kind: "provider", op: "x", boundUsd: 0.01, missionId: "msn_pg", ttlSeconds: 60 })).toEqual({ ok: false, reason: "no_grant" });
  });

  it("CONCURRENT TREG calls of two workers through the adapter never reserve past the grant; only reserved calls are sent; every one settles", async () => {
    db.sql("select spend_gate.issue_grant('g_r62', 0.05, 0.05, 0.05, '{provider,model}', now() - interval '1 minute', now() + interval '1 day', 'owner', 'round 62 test')");
    const catalog = loadTregCatalog();
    const sent: TregCallOptions[] = [];
    const workers = [0, 1].map(() => createWorkerSpendGate({ mode: "enforce", gate: createSupabaseSpendGate(rpcClient()), apiKey: "k" }));
    const gateways = workers.map((w, i) => {
      const store = createMemoryStore();
      const missionId = `msn_pg_w${i}`;
      store.missions.set(missionId, newMission({ id: missionId, user_id: USER_ID, status: "executing", job_id: `job_${i}` }));
      const rec = fakeRecorder({ dailyCapUsd: 100 });
      return createGateway({
        store, client: { from: () => ({ insert: async () => ({ error: null }), update: () => ({ eq: async () => ({}) }) }) }, missionId, userId: USER_ID, jobId: `job_${i}`, phase: "execution", access: NOT_ADMIN, catalog,
        budget: createJobCallBudget({ ceilingUsd: 100, spentUsd: 0 }), recorder: rec.recorder, commit: rec.commit, defaultPurpose: "t", counter: { seq: 0 },
        call: async (o: TregCallOptions) => { sent.push(o); return tregResult(postsPage(1), Number(o.routeMaxCostUsd) / 2); },
        spendGate: w.context(missionId),
      });
    });
    const results = await Promise.all(Array.from({ length: 30 }, (_, i) => gateways[i % 2].tregCall({ endpoint_id: POSTS_ENDPOINT, params: { query: `q${i}` } })));
    const cap = Number(sent[0]?.routeMaxCostUsd);
    expect(cap).toBeGreaterThan(0);
    const g = grant();
    expect(Number(g.reserved_usd)).toBe(0);
    expect(Number(g.spent_usd)).toBeLessThanOrEqual(0.05 + 1e-9);
    // every call that went out was reserved at its route cap and settled at what TREG reported (half the cap here)
    expect(Number(g.spent_usd)).toBeCloseTo(sent.reduce((n, o) => n + Number(o.routeMaxCostUsd) / 2, 0), 6);
    expect(sent.length).toBe(results.filter((r) => r.ok).length);
    expect(results.filter((r) => !r.ok).every((r) => (r as { refused?: string }).refused === "spend_gate")).toBe(true);
    // the ceiling held: what was spent (half of each sent cap) stays within it, and the refusals came only once it was reached
    expect((sent.length * cap) / 2).toBeLessThanOrEqual(0.05 + 1e-9);
    expect(sent.length).toBeLessThan(30);
    const summaries = workers.map((w, i) => w.finish(`msn_pg_w${i}`));
    expect(summaries.reduce((n, s) => n + s.reservations, 0)).toBe(sent.length);
    expect(summaries.every((s) => s.protection === "ENFORCED" && s.unreserved_ops === 0)).toBe(true);
  });

  it("a database that stops answering is a refusal (gate_unavailable), never a permission", async () => {
    const broken = createSupabaseSpendGate({ rpc: async () => ({ data: null, error: { message: "connection refused" } }) });
    expect(await broken.reserve({ key: "kx", kind: "provider", op: "x", boundUsd: 0.01, missionId: "msn_pg", ttlSeconds: 60 })).toMatchObject({ ok: false, reason: "gate_unavailable" });
  });
});
