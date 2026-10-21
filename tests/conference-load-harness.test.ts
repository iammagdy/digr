import { writeFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createLatencyDb, percentile } from "./helpers/loadHarness";
import { resetSpendReadCacheForTesting } from "../src/functions/shared/rateLimits";

const h = vi.hoisted(() => ({ db: null as any }));
vi.mock("../src/lib/supabase/server", () => ({
  createServerSideClient: vi.fn(async () => ({
    auth: {
      getUser: vi.fn(async (token?: string) => ({ data: { user: token ? { id: String(token), email: `${token}@x.test`, email_confirmed_at: "2026-10-01T00:00:00Z", user_metadata: {} } : null }, error: token ? null : new Error("no session") })),
    },
  })),
  createAdminClient: vi.fn(() => h.db.client),
}));
vi.mock("../src/functions/shared/catalogClient", () => ({
  searchCatalog: vi.fn(async () => []),
  getCachedCatalogEndpoints: vi.fn(() => []),
  getEndpointDetails: vi.fn(async (id: string) => ({ id, catalogPriceUsd: 0.005, pointsPerUnit: 28 })),
}));
vi.mock("../src/lib/server/sendPlatformEmail", () => ({ sendPlatformEmail: vi.fn(async () => ({ ok: true })), getRecipient: vi.fn(async () => null) }));
vi.mock("../src/functions/shared/llmClient", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/functions/shared/llmClient")>();
  class NoModelClient extends original.LlmClient {
    async executeTurn(): Promise<never> { throw new Error("the harness never calls a model"); }
  }
  return { ...original, LlmClient: NoModelClient };
});

import { POST as chatRoute } from "../src/app/api/chat/route";

const VISITORS = 500;
const LATENCY_MS = 4;
/** The three kinds of first messages a visitor sends: a greeting, a fully stated social request, a request that needs one question. */
const MESSAGES = [
  "مرحبا",
  "أريد ٣٠ تعليق على يوتيوب عن كرة القدم خلال الشهر الماضي",
  "أريد بيانات شركات",
];

function send(userId: string, message: string, conversationId?: string) {
  return chatRoute(new NextRequest("http://localhost:3000/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${userId}` },
    body: JSON.stringify({ message, ...(conversationId ? { conversationId } : {}) }),
  }));
}

const results: Record<string, any> = {};

describe("500 visitors through the real chat route and handler, with a fake database that waits 4 ms per query", () => {
  beforeAll(() => {
    h.db = createLatencyDb({ tables: {}, maxRows: 1000 }, LATENCY_MS);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
  });

  it("one visitor alone: how many database round trips a turn makes, and how many of them it waits for one after the other", async () => {
    const perKind: Record<string, { queries: number; sequentialWaits: number; elapsedMs: number; status: number; payloadBytes: number }> = {};
    for (const [index, message] of MESSAGES.entries()) {
      h.db.reset();
      const startedAt = performance.now();
      const res = await send(`solo_${index}`, message);
      const elapsedMs = performance.now() - startedAt;
      const text = await res.text();
      perKind[["greeting", "social_plan", "needs_question"][index]] = {
        queries: h.db.stats.ops.length,
        // the time spent, in fake round trips: (total time) / (one round trip); parallel queries share one trip
        sequentialWaits: Math.max(1, Math.round(elapsedMs / LATENCY_MS)),
        elapsedMs: Math.round(elapsedMs),
        status: res.status,
        payloadBytes: Buffer.byteLength(text),
      };
      expect(res.status, `${message}: ${text.slice(0, 200)}`).toBe(200);
    }
    results.single = perKind;
    for (const kind of Object.values(perKind)) {
      expect(kind.queries).toBeGreaterThan(0);
      expect(kind.payloadBytes).toBeLessThan(60_000);
    }
  });

  it("one turn late in a busy day: a refresh of the daily model-spend read still grows with the rows written today, and the turns after it make no read at all", async () => {
    const perDay: Record<string, { refreshQueries: number; nextTurnQueries: number; totalQueries: number; elapsedMs: number }> = {};
    for (const rowsToday of [0, 900, 2500, 10_000]) {
      h.db.rows("llm_usage").length = 0;
      const now = new Date().toISOString();
      for (let i = 0; i < rowsToday; i += 1) h.db.rows("llm_usage").push({ id: `u_${i}`, created_at: now, cost_usd: 0.0004, user_id: "someone" });
      resetSpendReadCacheForTesting();
      const llmReads = () => h.db.stats.ops.filter((op: any) => op.table === "llm_usage" && op.kind === "select").length;
      h.db.reset();
      const startedAt = performance.now();
      const first = await send(`late_${rowsToday}`, "مرحبا");
      const elapsedMs = performance.now() - startedAt;
      await first.text();
      expect(first.status).toBe(200);
      const refreshQueries = llmReads();
      const totalQueries = h.db.stats.ops.length;
      h.db.reset();
      const second = await send(`late_again_${rowsToday}`, "مرحبا");
      await second.text();
      expect(second.status).toBe(200);
      perDay[`rowsToday_${rowsToday}`] = { refreshQueries, nextTurnQueries: llmReads(), totalQueries, elapsedMs: Math.round(elapsedMs) };
    }
    results.lateDay = perDay;
    h.db.rows("llm_usage").length = 0;
    resetSpendReadCacheForTesting();
    // a refresh is one request while the day holds fewer rows than the API returns per request, then one request per page of the whole day
    expect(perDay.rowsToday_0.refreshQueries).toBeLessThanOrEqual(2);
    expect(perDay.rowsToday_10000.refreshQueries).toBeGreaterThan(perDay.rowsToday_900.refreshQueries);
    // inside the window the next turn reads nothing, however large the day is
    for (const entry of Object.values(perDay)) expect(entry.nextTurnQueries).toBe(0);
  });

  it("500 visitors at the same moment, three messages each in a row: all answered, bounded memory, payload sizes, latency percentiles", async () => {
    h.db.reset();
    if (typeof (globalThis as any).gc === "function") (globalThis as any).gc();
    const heapBefore = process.memoryUsage().heapUsed;
    const latencies: number[] = [];
    const sizes: number[] = [];
    const statuses = new Map<number, number>();
    const startedAt = performance.now();
    await Promise.all(Array.from({ length: VISITORS }, async (_unused, i) => {
      for (const message of MESSAGES) {
        const t0 = performance.now();
        const res = await send(`visitor_${i}`, message);
        const text = await res.text();
        latencies.push(performance.now() - t0);
        sizes.push(Buffer.byteLength(text));
        statuses.set(res.status, (statuses.get(res.status) ?? 0) + 1);
        if (res.status !== 200) { const key = `${MESSAGES.indexOf(message)}:${res.status}`; (results.refused ??= {})[key] = ((results.refused[key] as number) ?? 0) + 1; (results.refusedSample ??= {})[key] = text.slice(0, 300); }
      }
    }));
    const wallMs = performance.now() - startedAt;
    const heapAfter = process.memoryUsage().heapUsed;
    const turns = VISITORS * MESSAGES.length;
    const ok = statuses.get(200) ?? 0;
    results.crowd = {
      visitors: VISITORS,
      turns,
      answered200: ok,
      statuses: Object.fromEntries(statuses),
      wallMs: Math.round(wallMs),
      p50Ms: Math.round(percentile(latencies, 50)),
      p95Ms: Math.round(percentile(latencies, 95)),
      maxMs: Math.round(Math.max(...latencies)),
      queriesTotal: h.db.stats.ops.length,
      queriesPerTurn: Number((h.db.stats.ops.length / turns).toFixed(1)),
      maxQueriesWaitingAtOnce: h.db.stats.maxInFlight,
      heapGrowthMb: Number(((heapAfter - heapBefore) / 1024 / 1024).toFixed(1)),
      payloadMaxBytes: Math.max(...sizes),
      payloadAvgBytes: Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length),
      queriesByTable: Object.fromEntries([...h.db.stats.ops.reduce((m: Map<string, number>, o: any) => m.set(`${o.table}:${o.kind}`, (m.get(`${o.table}:${o.kind}`) ?? 0) + 1), new Map()).entries()].sort((a: any, b: any) => b[1] - a[1]).slice(0, 12)),
    };
    if (process.env.HARNESS_OUT) writeFileSync(process.env.HARNESS_OUT, JSON.stringify(results, null, 2));
    // nobody is lost: every turn is answered (a per-account rate limit may refuse some, never crash)
    expect(ok).toBe(turns);
    expect(results.crowd.heapGrowthMb).toBeLessThan(400);
    expect(results.crowd.payloadMaxBytes).toBeLessThan(60_000);
    if (process.env.HARNESS_OUT) writeFileSync(process.env.HARNESS_OUT, JSON.stringify(results, null, 2));
  }, 180_000);
});
