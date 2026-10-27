import { readFileSync } from "node:fs";
import { vi } from "vitest";
import { NextRequest } from "next/server";
import { jobIdForQuote } from "../../src/lib/server/retryReuse";
import { reserveForUnits } from "../../src/lib/recordPricing";
import { createMemoryDb } from "./memoryDb";

/**
 * The REPLAY WORLD: everything a full request needs after the customer approved the plan, with NO real provider call.
 *
 *  - an in-memory database (jobs, quotes, partials, results, events, provider costs) behind the same RPC names the worker calls;
 *  - the gateway answers from stored FIXTURES (`tests/fixtures/replay/*.json`): `global.fetch` is replaced, a request for a call route is served from the
 *    fixture of that endpoint, anything else is refused. The real fetch is never reached: `stats.realCalls` stays 0 and every test asserts it;
 *  - the worker runs for real (route, adapter, gate, dedupe, settlement arguments); only the database and the network are replaced.
 *
 * A fixture is either «real rows» (read from a live job's step file) or a «catalog example» (the catalog's trimmed example answer): the file name says which.
 */

export interface ReplayFixture {
  name: string;
  kind: "real rows" | "catalog example";
  endpointId: string;
  costMicro: number;
  pages: any[];
  repeatLastPage?: boolean;
  listPath?: string | null;
  cursorPath?: string | null;
  synthetic?: string;
}

export const loadFixture = (name: string): ReplayFixture => JSON.parse(readFileSync(`tests/fixtures/replay/${name}.json`, "utf-8"));

export interface ReplayStats {
  /** Calls served from a fixture: the endpoint, the page (1-based) and the body the worker sent. */
  served: Array<{ endpointId: string; page: number; body: any }>;
  /** Calls for an endpoint with no fixture (answered 404). */
  unserved: string[];
  /** Requests that were NOT a call route (a catalog read, anything else): refused. */
  other: string[];
  /** Requests that reached the real network. Always 0: the stub never delegates. */
  realCalls: number;
}

function builder(rows: () => any[]) {
  const filters: Array<[string, unknown]> = [];
  const apply = () => rows().filter((row) => filters.every(([col, val]) => row[col] === val));
  const api: any = {
    select: () => api,
    eq: (col: string, val: unknown) => { filters.push([col, val]); return api; },
    in: () => api, or: () => api, not: () => api, order: () => api, limit: () => api,
    range: async (from: number, to: number) => ({ data: apply().slice(from, to + 1), error: null }),
    maybeSingle: async () => ({ data: apply()[0] ?? null, error: null }),
    then: (resolve: any, reject: any) => Promise.resolve({ data: apply(), error: null }).then(resolve, reject),
  };
  return api;
}

export interface ReplayJobSeed {
  slug: string;
  endpointId?: string;
  params: Record<string, any>;
  target: number;
  unitPrice: number;
  unitCostUsd?: number;
  pricingUnit?: "item" | "call";
}

export function createReplayWorld() {
  const db = {
    jobs: [] as any[],
    quotes: [] as any[],
    partials: new Map<string, Buffer>(),
    results: new Map<string, Buffer>(),
    rpcCalls: [] as Array<{ name: string; args: any }>,
    events: [] as any[],
    costs: [] as any[],
    step: 0,
    cursor: null as string | null,
    deliveredUnits: 0,
    targetVolumeMax: 10,
    unitPrice: 1,
    reserved: 1,
    slug: "",
    endpointId: "",
  };
  // every other table (recipes, the verified-business flag, the sensitive-lookup audit…) lives in an in-memory store, so the model planner's worker paths can be replayed
  const mem = createMemoryDb();
  const stats: ReplayStats = { served: [], unserved: [], other: [], realCalls: 0 };
  const JOB = jobIdForQuote("quote_replay");

  const adminClient = () => ({
    rpc: vi.fn(async (name: string, args: any) => {
      db.rpcCalls.push({ name, args });
      if (name === "claim_job_chunk") {
        return { data: { claimed: true, job_id: args.p_job_id, user_id: "user_1", step: db.step, current_cursor: db.cursor, delivered_units: db.deliveredUnits, target_volume_max: db.targetVolumeMax, target_volume_min: 1, endpoint_id: db.endpointId || db.slug, unit_price: db.unitPrice }, error: null };
      }
      if (name === "reserve_provider_spend_atomic") return { data: { allowed: true, cost_id: 11 }, error: null };
      if (name === "commit_provider_spend" || name === "commit_provider_spend_v2") {
        db.costs.push({ provider: "treg", job_id: JOB, cost_usd: Number(args.p_actual_cost_usd) || 0 });
        return { data: { success: true }, error: null };
      }
      if (name === "complete_chunk") {
        db.step += 1;
        db.deliveredUnits = args.p_new_delivered_units;
        db.cursor = args.p_new_cursor;
        const job = db.jobs.find((row) => row.id === args.p_job_id);
        if (job) Object.assign(job, { current_cursor: db.cursor, delivered_units: db.deliveredUnits, status: "running" });
        return { data: { success: true, delivered_units: db.deliveredUnits }, error: null };
      }
      if (name === "settle_job_atomic") {
        const charged = Math.min(Math.ceil(db.deliveredUnits * db.unitPrice), db.reserved);
        return { data: { success: true, charged_credits: charged, refunded_credits: db.reserved - charged }, error: null };
      }
      if (name === "release_job_atomic") return { data: { success: true, released_credits: db.reserved }, error: null };
      return { data: { success: true }, error: null };
    }),
    storage: {
      from: (bucket: string) => {
        const store = bucket === "partials" ? db.partials : db.results;
        return {
          upload: async (path: string, body: any) => { store.set(path, Buffer.isBuffer(body) ? body : Buffer.from(String(body))); return { data: { path }, error: null }; },
          download: async (path: string) => {
            const buf = store.get(path);
            return buf ? { data: new Blob([new Uint8Array(buf)]), error: null } : { data: null, error: { message: "not_found" } };
          },
          remove: async (paths: string[]) => { for (const p of paths) store.delete(p); return { data: paths, error: null }; },
        };
      },
    },
    from: (table: string) => {
      if (table === "jobs") return builder(() => db.jobs);
      if (table === "plans_quotes") return builder(() => db.quotes);
      if (table === "provider_costs") return builder(() => db.costs);
      if (table === "job_events" || table === "notifications" || table === "artifact_versions") {
        const base = builder(() => (table === "job_events" ? db.events : []));
        return { ...base, insert: async (row: any) => { if (table === "job_events") db.events.push(row); return { data: row, error: null }; }, upsert: async (row: any) => ({ data: row, error: null }) };
      }
      return mem.from(table);
    },
    auth: mem.auth,
  });

  return {
    db,
    mem,
    stats,
    JOB,
    /** What `vi.mock("../src/lib/supabase/server")` returns. */
    supabaseServerMock: () => ({
      createServerSideClient: vi.fn(async () => ({ auth: { getUser: vi.fn(async () => ({ data: { user: null }, error: null })) } })),
      createAdminClient: vi.fn(() => adminClient()),
    }),
    /** A fresh job of an approved plan: the reserve is the shared one, `ceil(target x unit x 1.15)`. */
    resetJob(seed: ReplayJobSeed) {
      db.slug = seed.slug;
      db.endpointId = seed.endpointId ?? seed.slug;
      db.jobs = [{ id: JOB, status: "running", current_cursor: null, delivered_units: 0, target_volume_max: seed.target, created_at: new Date().toISOString() }];
      db.quotes = [{
        id: "quote_replay", user_id: "user_1",
        items: [{ capabilitySlug: seed.slug, endpointId: seed.endpointId ?? seed.slug, params: seed.params, targetVolumeMax: seed.target, paginationStrategy: "cursor", unitCostUsd: seed.unitCostUsd ?? 0.0009, pricingUnit: seed.pricingUnit ?? "item" }],
        output_formats: ["csv", "xlsx"],
      }];
      db.partials.clear(); db.results.clear(); db.rpcCalls = []; db.events = []; db.costs = [];
      mem.reset();
      db.step = 0; db.cursor = null; db.deliveredUnits = 0;
      db.targetVolumeMax = seed.target; db.unitPrice = seed.unitPrice;
      db.reserved = reserveForUnits(seed.target, seed.unitPrice);
      stats.served = []; stats.unserved = []; stats.other = []; stats.realCalls = 0;
    },
    /** Replaces `fetch`: calls are served from the fixtures, everything else is refused, the real network is never reached. */
    installFetch(fixtures: ReplayFixture[], options: { costMicroOverride?: number } = {}) {
      const perEndpoint = new Map<string, number>();
      const byEndpoint = new Map(fixtures.map((f) => [f.endpointId, f]));
      vi.stubGlobal("fetch", vi.fn(async (url: any, init?: any) => {
        const text = String(url);
        const match = /\/call\/([^/?#]+)/.exec(text);
        if (!match) { stats.other.push(text); return new Response(JSON.stringify({ error: "replay_refused" }), { status: 404 }); }
        const endpointId = decodeURIComponent(match[1]);
        const fixture = byEndpoint.get(endpointId);
        if (!fixture) { stats.unserved.push(endpointId); return new Response(JSON.stringify({ error: "no_fixture" }), { status: 404 }); }
        const n = (perEndpoint.get(endpointId) ?? 0) + 1;
        perEndpoint.set(endpointId, n);
        let body: any = {};
        try { body = init?.body ? JSON.parse(init.body) : Object.fromEntries(new URL(text).searchParams); } catch { body = {}; }
        stats.served.push({ endpointId, page: n, body });
        const page = fixture.pages[Math.min(n, fixture.pages.length) - 1];
        if (n > fixture.pages.length && !fixture.repeatLastPage) return new Response(JSON.stringify({ rows: [] }), { status: 200, headers: { "x-treg-cost-micro": "0", "x-treg-call-id": `replay_${stats.served.length}` } });
        return new Response(JSON.stringify(page), { status: 200, headers: { "x-treg-cost-micro": String(options.costMicroOverride ?? fixture.costMicro), "x-treg-call-id": `replay_${stats.served.length}` } });
      }));
    },
    /** Runs the worker chunk after chunk until the job is done, released or failed. */
    async runWorker(maxChunks = 12) {
      const route = await import("../../src/app/api/worker/chunk/route");
      let last: { status: number; json: any } = { status: 0, json: {} };
      for (let i = 0; i < maxChunks; i++) {
        const res = await route.POST(new NextRequest("http://127.0.0.1:3000/api/worker/chunk", {
          method: "POST",
          headers: { authorization: "Bearer replay-test-secret" },
          body: JSON.stringify({ jobId: JOB, expectedStep: db.step, disableSelfChain: true }),
        }));
        last = { status: res.status, json: await res.json() };
        if (last.json.done || last.json.released || last.status >= 400) break;
      }
      return last;
    },
    lines: () => db.events.map((event) => String(event.message)),
  };
}

export type ReplayWorld = ReturnType<typeof createReplayWorld>;

/** One shared world per test file (module state), so `vi.mock` factories and the tests see the same database. */
export const world = createReplayWorld();
