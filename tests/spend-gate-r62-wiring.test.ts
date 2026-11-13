import http from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createGateway } from "../agent/src/gateway";
import { createWebGateway, observeProviderFetch, reportedCreditsOf } from "../agent/src/webGateway";
import { createMemoryStore, newMission } from "../agent/src/memoryStore";
import { anthropicReviewCall } from "../agent/src/review";
import { buildQueryOptions } from "../agent/src/sdkOptions";
import { createWorkerSpendGate, gatedModelFetch, workerSpendGateFromEnv } from "../agent/src/spendGateWiring";
import { spendGateOf, spendReservationKey, withMissionSpendGate } from "../agent/src/spendGateKeys";
import { createJobCallBudget } from "../src/lib/server/callBudget";
import { createMemorySpendGate, gateAfter, gateBefore, type SpendGate } from "../src/lib/server/spendGate/gate";
import { createSupabaseSpendGate } from "../src/lib/server/spendGate/supabaseGate";
import { tregRouteCapUsd } from "../src/lib/server/spendGate/bounds";
import { MODEL_HAIKU } from "../src/lib/agentMission/constants";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import type { TregCallOptions, TregCallResult } from "../src/functions/shared/tregClient";
import { fakeRecorder, NOT_ADMIN, POSTS_ENDPOINT, USER_ID, postsPage, tregResult } from "./helpers/agentHarness";
import { assertReplayInvariants, pagedAnswers, replay } from "./helpers/agentReplay";
import { callIds, igHashtagPage, lastOutputId, planningFlow, pagedCalls, type Results } from "./helpers/agentFakeWorld";
import { aboutWords, firstOutputId } from "./helpers/agentRelevance";

/**
 * ROUND 62 (PR B): THE HARD SPEND GATE WIRED INTO THE WORKER, tested offline only. No paid call: TREG, Context.dev, Firecrawl and the model API are fakes,
 * the gate is the in-memory reference model of the SQL (createMemorySpendGate), and global fetch is stubbed to fail loudly.
 * OFF must be today's behaviour; OBSERVE must measure honestly (it is NOT enforcement); ENFORCE must send nothing without a reservation.
 */
/** The real fetch, kept ONLY for requests to the loopback servers of this file (the model gate and the fake upstream on 127.0.0.1). */
const loopbackFetch: typeof fetch = globalThis.fetch.bind(globalThis);
const realFetch: typeof fetch = (input, init) => {
  if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(String(input))) throw new Error("only loopback requests are allowed in this file");
  return loopbackFetch(input, init);
};
vi.stubGlobal("fetch", () => { throw new Error("a real network call was attempted"); });

const MISSION = "msn_r62gate01";
const catalog = loadTregCatalog();
const T0 = Date.now();
const grantOf = (w: ReturnType<typeof createMemorySpendGate>, g: Partial<{ ceilingUsd: number; perOpMaxUsd: number; perMissionMaxUsd: number; kinds: Array<"provider" | "model" | "chat" | "eval"> }> = {}) =>
  w.owner.issueGrant({ id: "g1", ceilingUsd: g.ceilingUsd ?? 1, perOpMaxUsd: g.perOpMaxUsd ?? 0.5, perMissionMaxUsd: g.perMissionMaxUsd ?? 1, kinds: g.kinds ?? ["provider", "model"], opensAt: T0 - 60_000, closesAt: T0 + 3_600_000, issuedBy: "owner", reason: "r62 test" });

/** A gate that counts what reaches it (reservations with their keys and bounds, settlements). */
function counting(inner: SpendGate) {
  const reserves: Array<{ key: string; boundUsd: number; op: string; kind: string; missionId: string | null }> = [];
  const settles: Array<{ id: string; actual: number | null }> = [];
  const gate: SpendGate = {
    async reserve(req) { reserves.push({ key: req.key, boundUsd: req.boundUsd, op: req.op, kind: req.kind, missionId: req.missionId }); return inner.reserve(req); },
    async settle(id, actual) { settles.push({ id, actual }); return inner.settle(id, actual); },
    stop: (r) => inner.stop(r),
  };
  return { gate, reserves, settles };
}
const failingGate = (how: "throw" | "slow"): SpendGate => ({
  reserve: () => (how === "throw" ? Promise.reject(new Error("database unreachable")) : new Promise(() => undefined)),
  settle: () => Promise.reject(new Error("database unreachable")),
  stop: async () => undefined,
});

const CLIENT = { from: () => ({ insert: async () => ({ error: null }), update: () => ({ eq: async () => ({}) }), select: () => ({ eq: () => ({ gte: () => ({ lt: async () => ({ data: [], error: null }) }) }) }) }) };

function treg(opts: { spendGate?: Parameters<typeof createGateway>[0]["spendGate"]; responses?: Array<TregCallResult | ((o: TregCallOptions) => TregCallResult | Promise<TregCallResult>)>; budgetUsd?: number } = {}) {
  const store = createMemoryStore();
  // execution phase: the planning-only sample rules (two samples per source) do not apply, so each test sees only the gate
  const mission = newMission({ id: MISSION, user_id: USER_ID, request_text: "منشورات", status: "executing", job_id: "job_r62" });
  store.missions.set(mission.id, mission);
  const rec = fakeRecorder({ dailyCapUsd: 100 });
  const queue = [...(opts.responses ?? [])];
  const call = vi.fn(async (o: TregCallOptions) => { const n = queue.shift() ?? tregResult(postsPage(3), 0.0004); return typeof n === "function" ? n(o) : n; });
  const budget = createJobCallBudget({ ceilingUsd: opts.budgetUsd ?? 5, spentUsd: 0 });
  const gateway = createGateway({ store, client: CLIENT, missionId: mission.id, userId: USER_ID, jobId: "job_r62", phase: "execution", access: NOT_ADMIN, catalog, budget, recorder: rec.recorder, commit: rec.commit, call, defaultPurpose: "test", counter: { seq: 0 }, ...(opts.spendGate ? { spendGate: opts.spendGate } : {}) });
  return { store, rec, call, budget, gateway };
}
const ask = (t: ReturnType<typeof treg>, q = "q") => t.gateway.tregCall({ endpoint_id: POSTS_ENDPOINT, params: { query: q } });

/** A fake Context.dev / Firecrawl that answers real Response objects (the shapes the adapters read). */
function webWorld(o: { credits?: number | null; status?: number; firecrawlCredits?: number | null; markdown?: string } = {}) {
  const requests: Array<{ url: string; body: any }> = [];
  const fetchFn = vi.fn(async (input: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    requests.push({ url: input, body });
    const json = (j: unknown, status = o.status ?? 200) => new Response(JSON.stringify(j), { status, headers: { "content-type": "application/json" } });
    const meta = o.credits === null || o.credits === undefined ? {} : { key_metadata: { credits_consumed: o.credits, credits_remaining: 100 } };
    if (input.includes("firecrawl")) {
      const fc = o.firecrawlCredits === null || o.firecrawlCredits === undefined ? {} : { creditsUsed: o.firecrawlCredits };
      if (input.endsWith("/scrape")) return json({ success: true, data: { markdown: o.markdown ?? "Contact us: info@example.com, phone +20 2 1234 5678. ".repeat(10), links: [], metadata: { statusCode: 200, url: body.url } }, ...fc });
      return json({ success: true, data: { web: [{ url: "https://a.example", title: "a", description: "d" }] }, ...fc });
    }
    if (input.endsWith("/web/search")) return json({ results: [{ url: "https://a.example", title: "a", description: "d" }], ...meta });
    if (input.endsWith("/web/scrape") && body?.formats?.parse) return json({ url: body.url, parsed: { type: body.parseParams.parser, requested: true, success: true, data: { posts: [{ id: "1", caption: "x" }] } }, ...meta });
    if (input.endsWith("/web/scrape")) return json({ url: body.url, markdown: { requested: true, success: true, data: o.markdown ?? "Contact us: info@example.com, phone +20 2 1234 5678. ".repeat(10) }, ...meta });
    if (input.endsWith("/people/search")) return json({ results: [{ name: "A", title: "CEO" }], next_cursor: null, ...meta });
    return json({ error: "unknown" }, 404);
  });
  return { fetchFn, requests };
}

function web(opts: { spendGate?: Parameters<typeof createWebGateway>[0]["spendGate"]; world?: ReturnType<typeof webWorld>; phase?: "planning" | "execution"; pageReuse?: boolean; dailyCap?: number; budgetUsd?: number } = {}) {
  const store = createMemoryStore();
  store.missions.set(MISSION, newMission({ id: MISSION, user_id: USER_ID, status: "planning" }));
  const rec = fakeRecorder({ dailyCapUsd: opts.dailyCap });
  const world = opts.world ?? webWorld({ credits: 1 });
  const budget = createJobCallBudget({ ceilingUsd: opts.budgetUsd ?? 0.5, spentUsd: 0 });
  const g = createWebGateway({
    store, missionId: MISSION, jobId: opts.phase === "execution" ? "job_x" : null, phase: opts.phase ?? "planning", budget, recorder: rec.recorder,
    providerKey: async () => "provider-key-for-test", fetchFn: world.fetchFn as any, counter: { seq: 0 },
    ...(opts.pageReuse ? { pageReuse: { countryHint: "EG" } } : {}),
    ...(opts.spendGate ? { spendGate: opts.spendGate } : {}),
  });
  return { store, rec, world, budget, web: g };
}

// ======================================================================================================================================== OFF
describe("R62 OFF: DIGER_SPEND_GATE unset is today's behaviour, byte for byte", () => {
  it("the worker builds no gate at all unless the variable is set; a typo fails closed (enforce), never open", () => {
    for (const v of [undefined, "", "off", "OFF", "0", " off "]) expect(workerSpendGateFromEnv({ DIGER_SPEND_GATE: v }, null)).toBeNull();
    expect(workerSpendGateFromEnv({ DIGER_SPEND_GATE: "observe" }, null)!.mode).toBe("observe");
    expect(workerSpendGateFromEnv({ DIGER_SPEND_GATE: "enfroce" }, null)!.mode).toBe("enforce");
    // no gate: the gateways get no key at all (not even an undefined one)
    expect(spendGateOf({}, MISSION)).toEqual({});
    expect(Object.keys(spendGateOf({}, MISSION))).toEqual([]);
    // the runners' dependencies: the very same object when the gate is off; the mission's gated review call when it is on
    const review = async () => null;
    const offDeps = { reviewCall: review, log: () => undefined };
    expect(withMissionSpendGate(offDeps, MISSION)).toBe(offDeps);
    const sg = createWorkerSpendGate({ mode: "enforce", gate: null, apiKey: "k" });
    const on = withMissionSpendGate({ ...offDeps, spendGate: sg }, MISSION);
    expect(on.reviewCall).not.toBe(review);
    expect(on.spendGate).toBe(sg);
  });

  it("main.ts: the dispatch line is unchanged; the gate rides in deps() only when the variable is set, and the claim's tally is logged at its end", () => {
    const main = readFileSync(path.resolve(__dirname, "../agent/src/main.ts"), "utf8");
    expect(main).toMatch(/const spendGate = workerSpendGateFromEnv\(process\.env, client, log\);/);
    expect(main).toMatch(/\.\.\.\(spendGate \? \{ spendGate \} : \{\}\),/);
    expect(main).toMatch(/runClaimedSafely\(\{ \.\.\.deps\(\), store: view\.store, leaseLost: view\.revoked, ownerId: workerId, revokeOwnership \}, mission\)/);
    expect(main).toMatch(/spendGate\?\.finish\(mission\.id\)/);
  });

  it("TREG: with no gate and with a gate in mode off, the call sent, the records and the spend are identical, and a gate that would fail is never asked", async () => {
    const none = treg();
    const offGate = counting(failingGate("throw"));
    const off = treg({ spendGate: { gate: offGate.gate, mode: "off" } });
    const a = await ask(none);
    const b = await ask(off);
    expect(b).toEqual(a);
    expect(off.call.mock.calls[0][0]).toEqual(none.call.mock.calls[0][0]);
    expect(off.call.mock.calls[0][0].routeMaxCostUsd).toBe(none.call.mock.calls[0][0].routeMaxCostUsd);
    expect(off.rec.rows).toEqual(none.rec.rows);
    const norm = (rows: unknown[]) => rows.map((c) => ({ ...(c as Record<string, unknown>), duration_ms: 0, created_at: null }));
    expect(norm(off.store.calls)).toEqual(norm(none.store.calls));
    expect(off.budget.spentUsd()).toBe(none.budget.spentUsd());
    expect(offGate.reserves).toHaveLength(0);
  });

  it("WEB: with no gate and with a gate in mode off, the requests and the records are identical, and the adapter gets the SAME fetch", async () => {
    const worldA = webWorld({ credits: 1 });
    const worldB = webWorld({ credits: 1 });
    const offGate = counting(failingGate("throw"));
    const a = web({ world: worldA });
    const b = web({ world: worldB, spendGate: { gate: offGate.gate, mode: "off" } });
    const ra = await a.web.webSearch({ provider: "contextdev", query: "مطاعم القاهرة", limit: 10 });
    const rb = await b.web.webSearch({ provider: "contextdev", query: "مطاعم القاهرة", limit: 10 });
    expect(rb).toEqual(ra);
    expect(worldB.requests).toEqual(worldA.requests);
    expect(b.rec.rows).toEqual(a.rec.rows);
    expect(offGate.reserves).toHaveLength(0);
  });

  it("SDK options: without the gate's environment the child gets exactly what it always got; with it, never the real key", () => {
    const input = { model: MODEL_HAIKU, systemPrompt: "s", maxTurns: 3, maxBudgetUsd: 0.1, cwd: "/tmp/x", tools: [] };
    const env = { PATH: "/bin", HOME: "/home/w", ANTHROPIC_API_KEY: "real-key-of-the-worker", SUPABASE_SERVICE_ROLE_KEY: "never", TREG_TOKEN: "never" };
    const plain = buildQueryOptions(input, env);
    expect(plain.env).toEqual({ PATH: "/bin", HOME: "/home/w", ANTHROPIC_API_KEY: "real-key-of-the-worker" });
    const { canUseToolDecision: _a, ...plainRest } = plain;
    const { canUseToolDecision: _b, ...undefRest } = buildQueryOptions(input, env, undefined);
    expect(JSON.stringify(undefRest)).toBe(JSON.stringify(plainRest));
    const gated = buildQueryOptions(input, env, { ANTHROPIC_BASE_URL: "http://127.0.0.1:41234", ANTHROPIC_API_KEY: "gate-abc", CLAUDE_CODE_MAX_OUTPUT_TOKENS: "32000" });
    expect(gated.env).toEqual({ PATH: "/bin", HOME: "/home/w", ANTHROPIC_BASE_URL: "http://127.0.0.1:41234", ANTHROPIC_API_KEY: "gate-abc", CLAUDE_CODE_MAX_OUTPUT_TOKENS: "32000" });
    expect(JSON.stringify(gated)).not.toContain("real-key-of-the-worker");
    // a base URL that is not the loopback gate, a token that is not a gate token, or the real key itself: refused (the run does not start)
    expect(() => buildQueryOptions(input, env, { ANTHROPIC_BASE_URL: "https://api.anthropic.com", ANTHROPIC_API_KEY: "gate-abc" })).toThrow(/loopback/);
    expect(() => buildQueryOptions(input, env, { ANTHROPIC_BASE_URL: "http://127.0.0.1:1", ANTHROPIC_API_KEY: "sk-ant-x" })).toThrow(/gate token/);
    expect(() => buildQueryOptions(input, { ...env, ANTHROPIC_API_KEY: "gate-same" }, { ANTHROPIC_BASE_URL: "http://127.0.0.1:1", ANTHROPIC_API_KEY: "gate-same" })).toThrow(/real key/);
  });
});

// ======================================================================================================================================== ENFORCE: TREG
describe("R62 ENFORCE, TREG: no reservation, no call", () => {
  it("no grant: refused «spend_gate» before anything is sent; the budget, the daily-cap row and the call log show a refusal that cost nothing", async () => {
    const w = createMemorySpendGate();
    const t = treg({ spendGate: { gate: w.gate, mode: "enforce" } });
    const r = await ask(t);
    expect(r).toMatchObject({ ok: false, refused: "spend_gate" });
    expect(t.call).not.toHaveBeenCalled();
    expect(t.budget.spentUsd()).toBe(0);
    expect(t.rec.rows).toHaveLength(1);
    expect(t.rec.rows[0]).toMatchObject({ committedUsd: 0, status: "failed" });
    expect(t.store.calls[0]).toMatchObject({ status: "refused", refused_reason: "spend_gate:no_grant" });
  });

  it("with a grant: the reservation IS the route cap sent to TREG (the same number), and the reported charge settles it", async () => {
    const w = createMemorySpendGate();
    grantOf(w);
    const c = counting(w.gate);
    const t = treg({ spendGate: { gate: c.gate, mode: "enforce" }, responses: [tregResult(postsPage(3), 0.0004)] });
    const r = await ask(t);
    expect(r.ok).toBe(true);
    const sent = t.call.mock.calls[0][0] as TregCallOptions;
    expect(c.reserves).toHaveLength(1);
    expect(c.reserves[0].boundUsd).toBe(Number(sent.routeMaxCostUsd));
    expect(c.reserves[0]).toMatchObject({ kind: "provider", op: `treg:${POSTS_ENDPOINT}`, missionId: MISSION });
    expect(c.settles).toEqual([{ id: expect.any(String), actual: 0.0004 }]);
    expect(w.owner.grant("g1")).toMatchObject({ reservedUsd: 0, spentUsd: 0.0004, overrunUsd: 0, state: "open" });
  });

  it("DATABASE FAILURE: a gate that throws, or that does not answer in time, sends nothing", async () => {
    for (const how of ["throw", "slow"] as const) {
      const t = treg({ spendGate: { gate: failingGate(how), mode: "enforce", timeoutMs: 30 } });
      const r = await ask(t);
      expect(r).toMatchObject({ ok: false, refused: "spend_gate" });
      expect(t.call).not.toHaveBeenCalled();
      expect(t.store.calls[0].refused_reason).toBe("spend_gate:gate_unavailable");
    }
  });

  it("UNKNOWN CHARGE: a cut call, a thrown call or a charge TREG did not report keeps the WHOLE bound spent", async () => {
    for (const answer of [tregResult(null, 0, { ok: false, timedOut: true, httpStatus: 0 }), tregResult(postsPage(2), 0.0001, { costIsEstimate: true }), (() => { throw new Error("socket hang up"); }) as unknown as TregCallResult]) {
      const w = createMemorySpendGate();
      grantOf(w);
      const c = counting(w.gate);
      const t = treg({ spendGate: { gate: c.gate, mode: "enforce" }, responses: [answer] });
      await ask(t);
      expect(c.settles).toHaveLength(1);
      expect(c.settles[0].actual).toBeNull();
      expect(w.owner.grant("g1")!.spentUsd).toBe(c.reserves[0].boundUsd);
    }
  });

  it("OVERRUN: a charge above the route cap counts the bound, records the excess and TRIPS the grant; the next call is refused", async () => {
    const w = createMemorySpendGate();
    grantOf(w);
    const t = treg({ spendGate: { gate: w.gate, mode: "enforce" }, responses: [(o) => tregResult(postsPage(3), Number(o.routeMaxCostUsd) + 0.01)] });
    await ask(t);
    expect(w.owner.grant("g1")).toMatchObject({ state: "tripped" });
    expect(w.owner.grant("g1")!.overrunUsd).toBeCloseTo(0.01, 6);
    const again = await ask(t, "q2");
    expect(again).toMatchObject({ ok: false, refused: "spend_gate" });
    expect(t.call).toHaveBeenCalledTimes(1);
  });

  it("RETRIES: every new paid attempt has its own reservation (a retried call never rides on an earlier one)", async () => {
    const w = createMemorySpendGate();
    grantOf(w);
    const c = counting(w.gate);
    const t = treg({ spendGate: { gate: c.gate, mode: "enforce" }, responses: [tregResult(null, 0, { ok: false, timedOut: true, httpStatus: 0 }), tregResult(postsPage(3), 0.0004)] });
    await ask(t);
    await ask(t);
    expect(t.call).toHaveBeenCalledTimes(2);
    expect(c.reserves).toHaveLength(2);
    expect(new Set(c.reserves.map((r) => r.key)).size).toBe(2);
    // and the same call id after a restart still gets a fresh key
    expect(spendReservationKey("treg", MISSION, "call_0001")).not.toBe(spendReservationKey("treg", MISSION, "call_0001"));
  });

  it("CONCURRENT REQUESTS: twenty calls at once never reserve past the ceiling, and only the reserved ones are sent", async () => {
    const w = createMemorySpendGate();
    const probe = treg();
    await ask(probe);
    const cap = Number((probe.call.mock.calls[0][0] as TregCallOptions).routeMaxCostUsd);
    grantOf(w, { ceilingUsd: cap * 5 + cap / 2, perOpMaxUsd: 0.5, perMissionMaxUsd: 1 });
    const t = treg({ spendGate: { gate: w.gate, mode: "enforce" }, budgetUsd: 10, responses: Array.from({ length: 20 }, () => async () => { await new Promise((r) => setTimeout(r, 5)); return tregResult(postsPage(1), 0); }) });
    const out = await Promise.all(Array.from({ length: 20 }, (_, i) => ask(t, `q${i}`)));
    expect(t.call).toHaveBeenCalledTimes(5);
    expect(out.filter((r) => !r.ok && (r as any).refused === "spend_gate")).toHaveLength(15);
    const g = w.owner.grant("g1")!;
    expect(g.reservedUsd + g.spentUsd).toBeLessThanOrEqual(g.ceilingUsd + 1e-9);
  });

  it("the in-memory mission budget stays an additional safeguard: a call over it is refused before the gate is even asked", async () => {
    const w = createMemorySpendGate();
    grantOf(w);
    const c = counting(w.gate);
    const t = treg({ spendGate: { gate: c.gate, mode: "enforce" }, budgetUsd: 0.0000001 });
    expect(await ask(t)).toMatchObject({ ok: false, refused: "over_budget" });
    expect(c.reserves).toHaveLength(0);
    expect(t.call).not.toHaveBeenCalled();
  });

  it("the TREG route cap sent is unchanged by the wiring (tregRouteCapUsd is the value the gateway always sent)", () => {
    for (const e of [0.000001, 0.0004, 0.001, 0.0123456789, 0.05]) expect(tregRouteCapUsd(e)).toBe(Number(Math.max(e, 0.001).toFixed(6)));
  });
});

// ======================================================================================================================================== ENFORCE: WEB
describe("R62 ENFORCE, Context.dev and Firecrawl: the bound before the call, the REPORTED charge after", () => {
  it("UNKNOWN COST: a Context.dev pre-built parser has no documented bound, so it is refused and NOTHING is sent", async () => {
    const w = createMemorySpendGate();
    grantOf(w);
    const t = web({ spendGate: { gate: w.gate, mode: "enforce" } });
    const r = await t.web.parsePage({ parser: "instagram-feed", url: "https://www.instagram.com/explore/tags/coffee/" });
    expect(r).toMatchObject({ ok: false, refused: "spend_gate" });
    expect(t.world.fetchFn).not.toHaveBeenCalled();
    expect(t.budget.spentUsd()).toBe(0);
    expect(t.store.calls[0].refused_reason).toBe("spend_gate:no_safe_bound");
  });

  it("a Firecrawl scrape reserves the STEALTH bound (5 credits, proxy auto), and an answer reporting no credits keeps the whole bound spent", async () => {
    const w = createMemorySpendGate();
    grantOf(w);
    const c = counting(w.gate);
    const t = web({ spendGate: { gate: c.gate, mode: "enforce" }, world: webWorld({ firecrawlCredits: null }) });
    const r = await t.web.webScrape({ provider: "firecrawl", url: "https://example.com/contact" });
    expect(r.ok).toBe(true);
    expect(t.world.requests[0].body.proxy).toBe("auto");
    expect(c.reserves[0].boundUsd).toBeCloseTo(5 * 0.005, 9);
    expect(c.settles[0].actual).toBeNull();
    expect(w.owner.grant("g1")!.spentUsd).toBeCloseTo(0.025, 9);
  });

  it("a Context.dev search reserves whole blocks of ten results and settles at the credits the answer reports", async () => {
    const w = createMemorySpendGate();
    grantOf(w);
    const c = counting(w.gate);
    const t = web({ spendGate: { gate: c.gate, mode: "enforce" }, world: webWorld({ credits: 1 }) });
    await t.web.webSearch({ provider: "contextdev", query: "مطاعم", limit: 15 });
    expect(c.reserves[0].boundUsd).toBeCloseTo(2 * 0.00254, 9);
    expect(c.settles[0].actual).toBeCloseTo(0.00254, 9);
    expect(w.owner.grant("g1")).toMatchObject({ reservedUsd: 0, overrunUsd: 0 });
  });

  it("people search reserves the fast-mode page (10 credits); a 5xx without reported credits is an UNKNOWN charge", async () => {
    const w = createMemorySpendGate();
    grantOf(w);
    const c = counting(w.gate);
    const t = web({ spendGate: { gate: c.gate, mode: "enforce" }, world: webWorld({ status: 502 }) });
    await t.web.peopleSearch({ query: "مدير تسويق القاهرة" });
    expect(c.reserves[0].boundUsd).toBeCloseTo(10 * 0.00254, 9);
    expect(c.settles[0].actual).toBeNull();
  });

  it("a call the provider's daily cap stopped was never sent: the reservation settles at 0", async () => {
    const w = createMemorySpendGate();
    grantOf(w);
    const c = counting(w.gate);
    const t = web({ spendGate: { gate: c.gate, mode: "enforce" }, dailyCap: 0 });
    const r = await t.web.webSearch({ provider: "contextdev", query: "مطاعم", limit: 10 });
    expect(r).toMatchObject({ ok: false, refused: "daily_cap" });
    expect(t.world.fetchFn).not.toHaveBeenCalled();
    expect(c.settles).toEqual([{ id: expect.any(String), actual: 0 }]);
    expect(w.owner.grant("g1")).toMatchObject({ reservedUsd: 0, spentUsd: 0 });
  });

  it("DATABASE FAILURE: nothing is sent", async () => {
    const t = web({ spendGate: { gate: failingGate("throw"), mode: "enforce" } });
    expect(await t.web.webScrape({ provider: "contextdev", url: "https://example.com/" })).toMatchObject({ ok: false, refused: "spend_gate" });
    expect(t.world.fetchFn).not.toHaveBeenCalled();
  });

  it("ROUND 60 PAGE REUSE PRESERVED: a page is bought ONCE (one reservation); every later field of it is read from the cache with no reservation and no request", async () => {
    const w = createMemorySpendGate();
    grantOf(w);
    const c = counting(w.gate);
    const t = web({ spendGate: { gate: c.gate, mode: "enforce" }, phase: "execution", pageReuse: true });
    const a = await t.web.parsePage({ parser: "emails", url: "https://example.com/contact" });
    const b = await t.web.parsePage({ parser: "phone-numbers", url: "https://example.com/contact" });
    const s = await t.web.webScrape({ provider: "contextdev", url: "https://example.com/contact" });
    expect([a.ok, b.ok, s.ok]).toEqual([true, true, true]);
    expect(t.world.fetchFn).toHaveBeenCalledTimes(1);
    expect(c.reserves).toHaveLength(1);
    expect(c.reserves[0].boundUsd).toBeCloseTo(0.00254, 9);
    expect(t.store.calls.filter((x) => x.endpoint_id === "page.reuse")).toHaveLength(2);
  });

  it("the provider's own report is read without changing the answer the adapter reads; a fallback is never taken for a report", async () => {
    expect(reportedCreditsOf("contextdev", { key_metadata: { credits_consumed: 3 } })).toBe(3);
    expect(reportedCreditsOf("contextdev", {})).toBeNull();
    expect(reportedCreditsOf("firecrawl", { creditsUsed: 2 })).toBe(2);
    expect(reportedCreditsOf("firecrawl", { creditsUsed: 1.5 })).toBeNull();
    expect(reportedCreditsOf("firecrawl", { data: {} })).toBeNull();
    const o = observeProviderFetch(async () => new Response(JSON.stringify({ key_metadata: { credits_consumed: 2 }, x: 1 }), { status: 200 }), "contextdev");
    expect(o.chargeUsd()).toBe(0);
    const res = await o.fetchFn("https://api.context.dev/v1/web/search", {});
    expect(await res.json()).toEqual({ key_metadata: { credits_consumed: 2 }, x: 1 });
    expect(o.chargeUsd()).toBeCloseTo(2 * 0.00254, 9);
    await o.fetchFn("https://api.context.dev/v1/web/search", {});
    expect(o.chargeUsd()).toBeNull();
  });
});

// ======================================================================================================================================== OBSERVE
describe("R62 OBSERVE: measured honestly, and NOT budget enforcement", () => {
  it("with no grant every call IS sent; each one is recorded as unreserved, as what enforce would refuse, with its reported charge", async () => {
    const w = createMemorySpendGate();
    const sg = createWorkerSpendGate({ mode: "observe", gate: w.gate, apiKey: "real-key" });
    const t = treg({ spendGate: sg.context(MISSION), responses: [tregResult(postsPage(3), 0.0004)] });
    const tw = web({ spendGate: sg.context(MISSION), world: webWorld({ credits: 1 }) });
    expect((await ask(t)).ok).toBe(true);
    expect((await tw.web.parsePage({ parser: "instagram-feed", url: "https://www.instagram.com/explore/tags/coffee/" })).ok).toBe(true);
    expect(t.call).toHaveBeenCalledTimes(1);
    expect(tw.world.fetchFn).toHaveBeenCalledTimes(1);
    const s = sg.summary(MISSION);
    expect(s).toMatchObject({ mode: "observe", protection: "NOT_PROTECTED_OBSERVE_ONLY", reservations: 0, refused: 0, would_refuse: 2, unreserved_ops: 2, unreserved_unknown_charge: 0, refusal_reasons: { no_grant: 1, no_safe_bound: 1 } });
    expect(s.unreserved_usd).toBeCloseTo(0.0004 + 0.00254, 9);
    expect(s.total_unreserved_requests).toBe(2);
    expect(s.note).toMatch(/NOT budget enforcement/);
    expect(JSON.stringify(s)).not.toMatch(/"protection":"ENFORCED"/);
  });

  it("with a grant the calls are reserved and settled; an unknown charge is counted apart; the summary line carries no key", async () => {
    const w = createMemorySpendGate();
    grantOf(w);
    const lines: string[] = [];
    const sg = createWorkerSpendGate({ mode: "observe", gate: w.gate, apiKey: "real-key-never-logged", log: (l) => lines.push(l) });
    const t = treg({ spendGate: sg.context(MISSION), responses: [tregResult(postsPage(3), 0.0004), tregResult(null, 0, { ok: false, timedOut: true, httpStatus: 0 })] });
    await ask(t);
    await ask(t, "q2");
    const s = sg.finish(MISSION);
    expect(s).toMatchObject({ reservations: 2, unknown_charges: 1, unreserved_ops: 0, would_refuse: 0 });
    expect(s.settled_usd).toBeCloseTo(0.0004 + Number((t.call.mock.calls[1][0] as TregCallOptions).routeMaxCostUsd), 9);
    expect(lines.join("\n")).toContain("spend_gate.summary");
    expect(lines.join("\n")).not.toContain("real-key-never-logged");
    // finish forgets the mission
    expect(sg.summary(MISSION).reservations).toBe(0);
  });

  it("gateBefore/gateAfter: off and an absent context do nothing; enforce stops; observe proceeds and reports", async () => {
    const events: string[] = [];
    const ctx = (mode: "off" | "observe" | "enforce") => ({ gate: failingGate("throw"), mode, onEvent: (e: { type: string }) => events.push(e.type) });
    const req = { key: "k1", kind: "provider" as const, op: "x", boundUsd: 0.01, missionId: null, ttlSeconds: 60 };
    expect(await gateBefore(undefined, req)).toEqual({ proceed: true, reservationId: null, op: "x" });
    expect(await gateBefore(ctx("off"), req)).toEqual({ proceed: true, reservationId: null, op: "x" });
    expect(events).toEqual([]);
    expect(await gateBefore(ctx("enforce"), req)).toMatchObject({ proceed: false, reason: "gate_unavailable" });
    const obs = await gateBefore(ctx("observe"), req);
    expect(obs).toMatchObject({ proceed: true, reservationId: null, observedRefusal: "gate_unavailable" });
    await gateAfter(ctx("observe"), obs, 0.002);
    expect(events).toEqual(["spend_gate.refused", "spend_gate.observed_refusal", "spend_gate.observed_unreserved_usage"]);
  });

  it("a settle that is repeated is a replay: the charge is never counted twice", async () => {
    const w = createMemorySpendGate();
    grantOf(w);
    const ctx = { gate: w.gate, mode: "enforce" as const };
    const b = await gateBefore(ctx, { key: "k-dup", kind: "provider", op: "x", boundUsd: 0.01, missionId: MISSION, ttlSeconds: 60 });
    await gateAfter(ctx, b, 0.004);
    await gateAfter(ctx, b, 0.004);
    await gateAfter(ctx, b, null);
    expect(w.owner.grant("g1")).toMatchObject({ spentUsd: 0.004, reservedUsd: 0 });
  });
});

// ======================================================================================================================================== MODEL
/** A fake Anthropic upstream on 127.0.0.1: answers a stream (or cuts it) and records what it was sent. */
async function fakeAnthropic(mode: "ok" | "cut" | "json" | "full" = "ok") {
  const seen: Array<{ key: string; max_tokens: number; model: string }> = [];
  const server = http.createServer((req, res) => {
    let raw = ""; req.on("data", (c) => (raw += c)); req.on("end", () => {
      const j = JSON.parse(raw || "{}");
      seen.push({ key: String(req.headers["x-api-key"] ?? ""), max_tokens: j.max_tokens, model: j.model });
      if (mode === "json") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ id: "m", type: "message", content: [{ type: "text", text: "[1,0]" }], usage: { input_tokens: 300, output_tokens: 5 } })); return; }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const ev = (t: string, d: object) => res.write(`event: ${t}\ndata: ${JSON.stringify({ type: t, ...d })}\n\n`);
      ev("message_start", { message: { id: "m", type: "message", role: "assistant", model: j.model, content: [], usage: { input_tokens: 500, output_tokens: 1 } } });
      if (mode === "cut") { res.destroy(); return; }
      ev("message_delta", { delta: { stop_reason: mode === "full" ? "max_tokens" : "end_turn" }, usage: { output_tokens: mode === "full" ? j.max_tokens : 20 } });
      ev("message_stop", {});
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, close: () => new Promise<void>((r) => server.close(() => r())) };
}
/** One model request as the SDK's child sends it: to the gate's base URL, with the gate's token only. */
async function childRequest(env: Record<string, string>, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  const r = await realFetch(`${env.ANTHROPIC_BASE_URL}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", ...headers }, body: JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, text };
}
const turn = (model = MODEL_HAIKU, maxTokens = 128_000) => ({ model, max_tokens: maxTokens, stream: true, messages: [{ role: "user", content: "say done" }] });

describe("R62 MODEL REQUESTS: every request of the SDK's process goes through the model gate, per mission, across rounds and restarts", () => {
  it("planning and execution runs: the child holds the gate's token only; each request is capped, reserved and settled; the real key is used upstream only", async () => {
    const up = await fakeAnthropic();
    const w = createMemorySpendGate();
    grantOf(w);
    const c = counting(w.gate);
    const sg = createWorkerSpendGate({ mode: "enforce", gate: c.gate, apiKey: "real-key-stays-in-worker", upstreamBaseUrl: up.url, fetchFn: realFetch as any, maxOutputTokens: 4000 });
    for (const phase of ["planning", "execution round 1", "execution round 2"]) {
      const run = await sg.modelGateFor(MISSION).start();
      expect(run.childEnv.ANTHROPIC_API_KEY).not.toBe("real-key-stays-in-worker");
      expect(run.childEnv.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(run.childEnv.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe("4000");
      const r = await childRequest(run.childEnv, turn());
      expect(r.status, phase).toBe(200);
      // a request with the real key, or with no key, is refused by the gate (only the child's token is accepted)
      expect((await childRequest({ ...run.childEnv, ANTHROPIC_API_KEY: "real-key-stays-in-worker" }, turn())).status).toBe(401);
      await run.close();
    }
    expect(up.seen).toHaveLength(3);
    expect(up.seen.every((s) => s.key === "real-key-stays-in-worker" && s.max_tokens === 4000)).toBe(true);
    expect(c.reserves.filter((r) => r.kind === "model")).toHaveLength(3);
    const s = sg.finish(MISSION);
    expect(s).toMatchObject({ protection: "ENFORCED", reservations: 3, refused: 0, model: { runs: 3, requests: 3, forwarded: 3, unauthorized: 3, unreserved: 0 } });
    await up.close();
  });

  it("the model budget does NOT reset each round or after a restart: the grant's per-mission maximum stops the mission's request once its total is used", async () => {
    // every answer uses its whole output allowance, so each request really spends most of its bound
    const up = await fakeAnthropic("full");
    const w = createMemorySpendGate();
    const probe = (await import("../src/lib/server/spendGate/modelBound")).modelRequestBound(turn(MODEL_HAIKU, 4000), Buffer.byteLength(JSON.stringify(turn(MODEL_HAIKU, 128_000))), { maxOutputTokens: 4000 });
    expect(probe.ok).toBe(true);
    const one = (probe as { usd: number }).usd;
    grantOf(w, { ceilingUsd: 1, perOpMaxUsd: 0.5, perMissionMaxUsd: one * 2.5 });
    const statuses: number[] = [];
    // two rounds in one worker, then a NEW worker process (a restart: a new wiring and new model gates) over the same database
    for (const worker of [0, 0, 1, 1]) {
      const sg = createWorkerSpendGate({ mode: "enforce", gate: w.gate, apiKey: "k", upstreamBaseUrl: up.url, fetchFn: realFetch as any, maxOutputTokens: 4000 });
      void worker;
      const run = await sg.modelGateFor(MISSION).start();
      statuses.push((await childRequest(run.childEnv, turn())).status);
      await run.close();
    }
    // two requests fit in the mission's maximum; the third (the first of the restarted worker) and the fourth are refused: nothing resets the total
    expect(statuses).toEqual([200, 200, 400, 400]);
    expect(up.seen).toHaveLength(2);
    const used = w.owner.grant("g1")!.spentUsd;
    expect(used).toBeLessThanOrEqual(one * 2.5 + 1e-9);
    // another mission still has its own room
    const before = up.seen.length;
    const other = createWorkerSpendGate({ mode: "enforce", gate: w.gate, apiKey: "k", upstreamBaseUrl: up.url, fetchFn: realFetch as any, maxOutputTokens: 4000 });
    const run2 = await other.modelGateFor("msn_other0001").start();
    expect((await childRequest(run2.childEnv, turn())).status).toBe(200);
    expect(up.seen.length).toBe(before + 1);
    await run2.close();
    await up.close();
  });

  it("INTERRUPTED STREAM: a cut answer settles as an UNKNOWN charge (the whole bound stays spent)", async () => {
    const up = await fakeAnthropic("cut");
    const w = createMemorySpendGate();
    grantOf(w);
    const c = counting(w.gate);
    const sg = createWorkerSpendGate({ mode: "enforce", gate: c.gate, apiKey: "k", upstreamBaseUrl: up.url, fetchFn: realFetch as any, maxOutputTokens: 4000 });
    const run = await sg.modelGateFor(MISSION).start();
    await childRequest(run.childEnv, turn()).catch(() => null);
    await run.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(c.settles).toEqual([{ id: expect.any(String), actual: null }]);
    expect(w.owner.grant("g1")!.spentUsd).toBe(c.reserves[0].boundUsd);
    expect(sg.summary(MISSION).unknown_charges).toBe(1);
    await up.close();
  });

  it("UNKNOWN MODEL OR PRICE, a non-allowlisted beta, or a database failure: refused in enforce, nothing reaches the upstream", async () => {
    const up = await fakeAnthropic();
    const cases: Array<{ gate: SpendGate; body: Record<string, unknown>; headers?: Record<string, string> }> = [
      { gate: (() => { const w = createMemorySpendGate(); grantOf(w); return w.gate; })(), body: turn("claude-unknown-9") },
      { gate: (() => { const w = createMemorySpendGate(); grantOf(w); return w.gate; })(), body: turn(), headers: { "anthropic-beta": "context-1m-2025-08-07" } },
      { gate: failingGate("throw"), body: turn() },
    ];
    for (const k of cases) {
      const sg = createWorkerSpendGate({ mode: "enforce", gate: k.gate, apiKey: "k", upstreamBaseUrl: up.url, fetchFn: realFetch as any });
      const run = await sg.modelGateFor(MISSION).start();
      expect((await childRequest(run.childEnv, k.body, k.headers)).status).toBe(400);
      await run.close();
      expect(sg.finish(MISSION).refused).toBe(1);
    }
    expect(up.seen).toHaveLength(0);
    await up.close();
  });

  it("OBSERVE: the same requests ARE sent, and every one is counted as unreserved (observe is not protection)", async () => {
    const up = await fakeAnthropic();
    const sg = createWorkerSpendGate({ mode: "observe", gate: createMemorySpendGate().gate, apiKey: "k", upstreamBaseUrl: up.url, fetchFn: realFetch as any });
    const run = await sg.modelGateFor(MISSION).start();
    expect(run.childEnv.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBeUndefined();
    expect((await childRequest(run.childEnv, turn())).status).toBe(200);
    expect((await childRequest(run.childEnv, turn("claude-unknown-9"))).status).toBe(200);
    await run.close();
    const s = sg.finish(MISSION);
    expect(up.seen).toHaveLength(2);
    expect(up.seen[0].max_tokens).toBe(128_000);
    expect(s).toMatchObject({ protection: "NOT_PROTECTED_OBSERVE_ONLY", reservations: 0, model: { unreserved: 2 }, total_unreserved_requests: 2 });
    expect(s.would_refuse).toBeGreaterThanOrEqual(2);
    expect(s.model.unreserved_usd).toBeGreaterThan(0);
    await up.close();
  });

  it("enforce: a model gate that cannot start does not start the run (the driver gets an error, never an ungated child)", async () => {
    const sg = createWorkerSpendGate({ mode: "enforce", gate: null, apiKey: "k", upstreamBaseUrl: "http://127.0.0.1:9" });
    const starter = sg.modelGateFor(MISSION);
    expect(starter.mode).toBe("enforce");
    // with no gate client every request is refused (gate_unavailable): the gate starts, and refuses
    const run = await starter.start();
    expect((await childRequest(run.childEnv, turn())).status).toBe(400);
    await run.close();
    // the driver's contract (sdkRuntime.ts): a start that throws in enforce ends the run with stop «spend_gate» before the SDK is called
    const src = readFileSync(path.resolve(__dirname, "../agent/src/sdkRuntime.ts"), "utf8");
    expect(src).toMatch(/if \(input\.modelGate\.mode === "enforce"\) throw new SpendGateNotStarted\(\)/);
    expect(src.indexOf("new SpendGateNotStarted()")).toBeLessThan(src.indexOf("q = query({"));
  });
});

// ======================================================================================================================================== DIRECT MODEL REQUESTS
describe("R62 DIRECT MODEL REQUESTS of the worker (review.ts): one reservation per attempt", () => {
  const modelFake = (status = 200, json?: unknown) => vi.fn(async (_u: string, _i?: RequestInit) => new Response(JSON.stringify(json ?? { content: [{ type: "tool_use", name: "verdicts", input: { verdicts: [1, 0] } }], usage: { input_tokens: 300, output_tokens: 8 } }), { status, headers: { "content-type": "application/json" } }));

  it("enforce, no grant: the review gets no answer and NOTHING is sent", async () => {
    const inner = modelFake();
    const sg = createWorkerSpendGate({ mode: "enforce", gate: createMemorySpendGate().gate, apiKey: "k" });
    const review = anthropicReviewCall("real-key", sg.modelFetch(MISSION, inner as any));
    expect(await review({ model: MODEL_HAIKU, system: "s", user: "u", maxTokens: 200, rows: 2 })).toBeNull();
    expect(inner).not.toHaveBeenCalled();
    expect(sg.summary(MISSION)).toMatchObject({ refused: 1, refusal_reasons: { no_grant: 1 } });
  });

  it("enforce, with a grant: reserved, sent unchanged (max_tokens under the cap), settled by the answer's usage", async () => {
    const inner = modelFake();
    const w = createMemorySpendGate();
    grantOf(w);
    const c = counting(w.gate);
    const sg = createWorkerSpendGate({ mode: "enforce", gate: c.gate, apiKey: "k" });
    const review = anthropicReviewCall("real-key", sg.modelFetch(MISSION, inner as any));
    const got = await review({ model: MODEL_HAIKU, system: "s", user: "u", maxTokens: 200, rows: 2 });
    expect(got?.text).toBe("[1,0]");
    expect(JSON.parse(String(inner.mock.calls[0][1]!.body)).max_tokens).toBe(200);
    expect(c.reserves).toHaveLength(1);
    expect(c.settles[0].actual).toBeCloseTo((300 * 0.1 + 8 * 0.5) / 1_000_000, 12);
  });

  it("RETRIES: review.ts asks again without its tool after a 400: that second attempt has its own reservation; a 400 costs nothing", async () => {
    let n = 0;
    const inner = vi.fn(async () => (++n === 1 ? new Response("{}", { status: 400 }) : new Response(JSON.stringify({ content: [{ type: "text", text: "[1]" }], usage: { input_tokens: 100, output_tokens: 3 } }), { status: 200, headers: { "content-type": "application/json" } })));
    const w = createMemorySpendGate();
    grantOf(w);
    const c = counting(w.gate);
    const sg = createWorkerSpendGate({ mode: "enforce", gate: c.gate, apiKey: "k" });
    await anthropicReviewCall("real-key", sg.modelFetch(MISSION, inner as any))({ model: MODEL_HAIKU, system: "s", user: "u", maxTokens: 50, rows: 1 });
    expect(inner).toHaveBeenCalledTimes(2);
    expect(c.reserves).toHaveLength(2);
    expect(new Set(c.reserves.map((r) => r.key)).size).toBe(2);
    expect(c.settles.map((s) => s.actual)[0]).toBe(0);
  });

  it("a server error or a thrown request is an UNKNOWN charge (the whole bound stays spent)", async () => {
    for (const inner of [modelFake(529), vi.fn(async () => { throw new Error("reset"); })]) {
      const w = createMemorySpendGate();
      grantOf(w);
      const c = counting(w.gate);
      const sg = createWorkerSpendGate({ mode: "enforce", gate: c.gate, apiKey: "k" });
      await anthropicReviewCall("real-key", sg.modelFetch(MISSION, inner as any))({ model: MODEL_HAIKU, system: "s", user: "u", maxTokens: 50 });
      expect(c.settles[0].actual).toBeNull();
      expect(w.owner.grant("g1")!.spentUsd).toBe(c.reserves[0].boundUsd);
    }
  });

  it("observe, no grant: sent as today and counted unreserved with its priced charge", async () => {
    const inner = modelFake();
    const sg = createWorkerSpendGate({ mode: "observe", gate: createMemorySpendGate().gate, apiKey: "k" });
    expect(await anthropicReviewCall("real-key", sg.modelFetch(MISSION, inner as any))({ model: MODEL_HAIKU, system: "s", user: "u", maxTokens: 200, rows: 2 })).not.toBeNull();
    const s = sg.summary(MISSION);
    expect(s).toMatchObject({ unreserved_ops: 1, direct_model_unreserved: 1, would_refuse: 1, protection: "NOT_PROTECTED_OBSERVE_ONLY" });
    expect(s.direct_model_unreserved_usd).toBeCloseTo((300 * 0.1 + 8 * 0.5) / 1_000_000, 12);
  });

  it("a mode of off passes straight through (the worker never builds this fetch when the gate is off)", async () => {
    const inner = modelFake();
    const f = gatedModelFetch({ gate: null, mode: "off" }, MISSION, { inner: inner as any });
    await f("https://api.anthropic.com/v1/messages", { method: "POST", body: "{}" });
    expect(inner).toHaveBeenCalledTimes(1);
  });
});

// ======================================================================================================================================== CUSTOMER MONEY
describe("R62 CUSTOMER MONEY: the gate holds OWNER money only; no ledger, reservation or settlement of the customer changes", () => {
  const ENDPOINT = "anyapi.instagram.hashtag.posts";
  const execCalls = (r: Results) => r.filter((x) => x.tool === "treg_call" && x.result.ok === true).map((x) => String(x.result.call_id));
  const mission = (deps?: (base: any) => any) => replay({
    request: "هات ٦٠ بوست إنستجرام عن هاشتاج قهوة",
    planning: planningFlow({
      progress: "أجرّب مصدر منشورات الوسوم", searchWords: ["instagram", "hashtag"], platform: "instagram",
      sample: [{ endpoint: ENDPOINT, params: { hashtag: "قهوة" }, why: "the cheaper sources return no author or link fields in their catalog description" }],
      sampleCode: "return inputs.call_0001.output.data.posts.slice(0, 3).map(p => ({ id: p.id, text: p.caption, url: p.displayUrl, likes: p.likes }))",
      plan: (res) => ({
        summary_ar: "ستحصل على ٦٠ منشورًا من إنستجرام تحت وسم قهوة مع نص كل منشور ورابطه وعدد الإعجابات.",
        stages: [{ key: "posts", title_ar: "المنشورات", endpoint_id: ENDPOINT, expected_rows: 60, parent_key: null, deliver: true, columns: [{ key: "text", title_ar: "نص المنشور" }, { key: "url", title_ar: "رابط الصورة" }, { key: "likes", title_ar: "الإعجابات" }, { key: "comments_count", title_ar: "عدد التعليقات" }, { key: "date", title_ar: "التاريخ والوقت" }],
          sample_rows: (res.filter((x) => x.tool === "run_code")[0].result.result as unknown[]).slice(0, 3), measured_by: [callIds(res)[0]], relevance: aboutWords(["قهوة"]), yield_from: firstOutputId(res) }],
      }),
    }),
    execution: () => [
      ...pagedCalls(ENDPOINT, 3, (cursor) => ({ hashtag: "قهوة", ...(cursor ? { cursor } : {}) })),
      { tool: "run_code", args: (res: Results) => ({ code: "const out = []; for (const page of Object.values(inputs)) for (const p of page.output.data.posts) out.push({ id: p.id, text: p.caption, url: p.displayUrl, likes: p.likes }); return out;", files: execCalls(res) }) },
      { tool: "save_rows", args: (res: Results) => ({ stage_key: "posts", from_output: lastOutputId(res) }) },
      { tool: "finish", args: { outcome: "delivered", summary_ar: "سُلّم ٦٠ منشورًا من وسم قهوة." } },
    ],
    answers: [tregResult(igHashtagPage("قهوة", 0, 20, "cur_20"), 0.002), ...pagedAnswers(60, 20, 0.002, (o, n, next) => igHashtagPage("قهوة", o, n, next), tregResult)],
    ...(deps ? { deps } : {}),
  });

  it("a whole mission (plan, approve, execute, settle) with the gate ENFORCING a sufficient grant ends exactly as with the gate off: same charge, balance, records and file", async () => {
    const off = await mission();
    const w = createMemorySpendGate();
    grantOf(w);
    const c = counting(w.gate);
    const sg = createWorkerSpendGate({ mode: "enforce", gate: c.gate, apiKey: "k" });
    const modelRuns: boolean[] = [];
    const on = await mission((base) => ({ ...base, spendGate: sg, driver: { run: async (input: any) => { modelRuns.push(Boolean(input.modelGate)); return base.driver.run(input); } } }));
    assertReplayInvariants(off, { expectDelivered: 60 });
    assertReplayInvariants(on, { expectDelivered: 60 });
    // the customer's money and the mission's settled figures are identical
    expect(on.money.balance()).toBe(off.money.balance());
    for (const k of ["status", "charged_points", "reserved_points", "unit_price_points", "planning_treg_usd", "execution_treg_usd", "error"] as const) expect((on.mission as any)[k], k).toEqual((off.mission as any)[k]);
    const costRows = (rows: typeof on.rec.rows) => rows.map((r) => ({ reservedUsd: r.reservedUsd, committedUsd: r.committedUsd, units: r.units, status: r.status, capabilityId: r.capabilityId }));
    expect(costRows(on.rec.rows)).toEqual(costRows(off.rec.rows));
    // every TREG call that went out was reserved first, with its route cap, and settled; every model run got the model gate
    expect(c.reserves).toHaveLength(on.call.mock.calls.length);
    expect(c.reserves.map((r) => r.boundUsd)).toEqual(on.call.mock.calls.map((x) => Number((x[0] as TregCallOptions).routeMaxCostUsd)));
    expect(c.settles).toHaveLength(c.reserves.length);
    expect(modelRuns.length).toBeGreaterThan(0);
    expect(modelRuns.every(Boolean)).toBe(true);
    expect(w.owner.grant("g1")).toMatchObject({ reservedUsd: 0, overrunUsd: 0, state: "open" });
  });

  it("with the gate ENFORCING and NO grant, planning sends no paid call (and the customer is never charged)", async () => {
    const sg = createWorkerSpendGate({ mode: "enforce", gate: createMemorySpendGate().gate, apiKey: "k" });
    let thrown: unknown = null;
    let calls = -1;
    let missionId = "";
    try {
      await mission((base) => {
        calls = Math.max(calls, 0);
        missionId = [...base.store.missions.keys()][0];
        const call = base.call;
        return { ...base, spendGate: sg, call: async (o: any) => { calls += 1; return call(o); } };
      });
    } catch (e) { thrown = e; }
    // planning cannot sample anything, so it ends without a plan: nothing was approved, nothing charged
    expect(String((thrown as Error)?.message)).toMatch(/planning did not end with a plan/);
    expect(calls).toBe(0);
    expect(sg.summary(missionId)).toMatchObject({ protection: "ENFORCED", reservations: 0 });
    expect(sg.summary(missionId).refused).toBeGreaterThan(0);
  });

  it("the worker's gate code calls only the spend-gate functions (spend_reserve, spend_settle, spend_stop): never a customer ledger, balance or settlement function", async () => {
    const calls: string[] = [];
    const g = createSupabaseSpendGate({ rpc: (fn: string) => { calls.push(fn); return Promise.resolve({ data: { ok: false, reason: "no_grant" }, error: null }); } });
    await g.reserve({ key: "k", kind: "provider", op: "x", boundUsd: 0.01, missionId: null, ttlSeconds: 60 });
    await g.settle("00000000-0000-0000-0000-000000000000", null);
    await g.stop("t");
    expect(calls).toEqual(["spend_reserve", "spend_settle", "spend_stop"]);
    for (const f of ["agent/src/spendGateWiring.ts", "agent/src/spendGateKeys.ts", "src/lib/server/spendGate/supabaseGate.ts", "src/lib/server/spendGate/gate.ts"]) {
      const src = readFileSync(path.resolve(__dirname, "..", f), "utf8");
      const rpcs = [...src.matchAll(/rpc\(\s*"([a-z_]+)"/g)].map((m) => m[1]);
      expect(rpcs.every((n) => ["spend_reserve", "spend_settle", "spend_stop"].includes(n)), f).toBe(true);
      // no table is read or written directly (the customer's ledger, balances and jobs are tables and functions this code never names)
      expect(src, f).not.toMatch(/\.from\(\s*["'`]/);
      expect(src, f).not.toMatch(/credit_ledger|settle_job|reserve_job|wallet|customer_balance/i);
    }
  });

  it("a database error of the gate is returned as gate_unavailable (a refusal in enforce), never as permission", async () => {
    const g = createSupabaseSpendGate({ rpc: () => Promise.resolve({ data: null, error: { message: "relation does not exist" } }) });
    expect(await g.reserve({ key: "k", kind: "provider", op: "x", boundUsd: 0.01, missionId: null, ttlSeconds: 60 })).toMatchObject({ ok: false, reason: "gate_unavailable" });
    const g2 = createSupabaseSpendGate({ rpc: () => Promise.resolve({ data: { ok: true }, error: null }) });
    expect(await g2.reserve({ key: "k", kind: "provider", op: "x", boundUsd: 0.01, missionId: null, ttlSeconds: 60 })).toMatchObject({ ok: false, reason: "gate_unavailable" });
  });
});

