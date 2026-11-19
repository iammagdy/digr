import http from "node:http";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createGateway } from "../agent/src/gateway";
import { createWebGateway } from "../agent/src/webGateway";
import { createMemoryStore, newMission } from "../agent/src/memoryStore";
import { createWorkerSpendGate, gatedModelFetch, workerSpendGateFromEnv } from "../agent/src/spendGateWiring";
import { spendGateOf, withMissionSpendGate } from "../agent/src/spendGateKeys";
import { createJobCallBudget } from "../src/lib/server/callBudget";
import { createMemorySpendGate, type SpendGate } from "../src/lib/server/spendGate/gate";
import { providerCallBound } from "../src/lib/server/spendGate/bounds";
import { CAMPAIGN_LIFETIME_CEILING_USD, SpendCampaignConfigError, TREG_CAMPAIGN_ATTEMPTS, campaignModeFromEnv, campaignReadiness, type CampaignEvidence } from "../src/lib/server/spendGate/campaign";
import { CAMPAIGN_EXCLUDED_GROUPS, CAMPAIGN_GATED_GROUPS, PAID_CALL_MARKERS, PAID_PATH_FILES, PAID_PATH_GROUPS } from "../src/lib/server/spendGate/paidPaths";
import { PRODUCTION_BUDGET_GUARANTEE } from "../src/lib/agentMission/acceptance/campaign";
import { startCampaign } from "../src/lib/agentMission/acceptance/campaign";
import { createScenarioMission } from "../src/lib/agentMission/acceptance/run";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import type { TregCallOptions, TregCallResult } from "../src/functions/shared/tregClient";
import { fakeRecorder, NOT_ADMIN, POSTS_ENDPOINT, USER_ID, postsPage, tregResult } from "./helpers/agentHarness";
import { assertReplayInvariants, pagedAnswers, replay, REPLAY_USER } from "./helpers/agentReplay";
import { callIds, igHashtagPage, lastOutputId, planningFlow, pagedCalls, type Results } from "./helpers/agentFakeWorld";
import { aboutWords, firstOutputId } from "./helpers/agentRelevance";

/**
 * SPEND SAFETY MILESTONE: the CAMPAIGN-SCOPED spend gate, tested offline only (docs/intelligence/SPEND-SAFETY-ACCEPTANCE.md). No paid call: TREG, Context.dev,
 * Firecrawl and the model API are fakes, the gate is the in-memory reference model of 003_campaign_scope.sql (the SQL itself is tested on a scratch Postgres in
 * tests/sql/spend-campaign.local-pg.test.ts), and global fetch is stubbed to fail loudly. The letters A to P are the owner's required tests.
 */
vi.stubGlobal("fetch", () => { throw new Error("a real network call was attempted"); });

const TEST_ACCOUNT = USER_ID;
const OTHER_ACCOUNT = "00000000-0000-0000-0000-0000000000bb";
const MISSION = "msn_camp0001";
const OTHER_MISSION = "msn_camp0002";
const catalog = loadTregCatalog();
const T0 = 1_800_000_000_000;

interface World { w: ReturnType<typeof createMemorySpendGate>; sg: ReturnType<typeof createWorkerSpendGate>; counts: { reserves: Array<{ key: string; boundUsd: number; kind: string; missionId: string | null }>; settles: number; enrolls: number; max: number }; clock: { now: number }; owners: Map<string, string> }

/** A campaign grant in the reference model, a worker gate in campaign scope over it, and a count of everything that reaches the gate. */
function world(o: { ceilingUsd?: number; perOpMaxUsd?: number; perMissionMaxUsd?: number; maxMissions?: number; gate?: (inner: SpendGate) => SpendGate; maxOutputTokens?: number; enrollTimeoutMs?: number } = {}): World {
  const clock = { now: T0 };
  const owners = new Map<string, string>([[MISSION, TEST_ACCOUNT], [OTHER_MISSION, OTHER_ACCOUNT]]);
  const w = createMemorySpendGate({ now: () => clock.now, missionOwner: (id) => owners.get(id) ?? null });
  w.owner.issueCampaignGrant({ id: "camp1", ceilingUsd: o.ceilingUsd ?? 0.3, perOpMaxUsd: o.perOpMaxUsd ?? 0.1, perMissionMaxUsd: o.perMissionMaxUsd ?? o.ceilingUsd ?? 0.3, kinds: ["provider", "model"], opensAt: T0 - 60_000, closesAt: T0 + 3_600_000, issuedBy: "owner", reason: "test", accountId: TEST_ACCOUNT, maxMissions: o.maxMissions ?? 1 });
  const counts: World["counts"] = { reserves: [], settles: 0, enrolls: 0, max: 0 };
  const watch = () => { const g = w.owner.grant("camp1")!; counts.max = Math.max(counts.max, g.reservedUsd + g.spentUsd); };
  const counting: SpendGate = {
    async reserve(req) { counts.reserves.push({ key: req.key, boundUsd: req.boundUsd, kind: req.kind, missionId: req.missionId }); const r = await w.gate.reserve(req); watch(); return r; },
    async settle(id, a) { counts.settles += 1; const r = await w.gate.settle(id, a); watch(); return r; },
    async enroll(id) { counts.enrolls += 1; return w.gate.enroll!(id); },
    stop: (r) => w.gate.stop(r),
  };
  const gate = o.gate ? o.gate(counting) : counting;
  const sg = createWorkerSpendGate({ mode: "enforce", gate, apiKey: "k", campaign: { accountId: TEST_ACCOUNT }, ...(o.maxOutputTokens ? { maxOutputTokens: o.maxOutputTokens } : {}), ...(o.enrollTimeoutMs ? { enrollTimeoutMs: o.enrollTimeoutMs } : {}) });
  return { w, sg, counts, clock, owners };
}

const CLIENT = { from: () => ({ insert: async () => ({ error: null }), update: () => ({ eq: async () => ({}) }), select: () => ({ eq: () => ({ gte: () => ({ lt: async () => ({ data: [], error: null }) }) }) }) }) };

/** A worker TREG gateway of one mission, holding what the worker holds for it: spendGateOf(deps, missionId) (nothing at all for an ungated mission). */
function treg(sg: World["sg"] | undefined, o: { missionId?: string; userId?: string; noToken?: boolean; answers?: Array<TregCallResult | ((o: TregCallOptions) => TregCallResult | Promise<TregCallResult>)> } = {}) {
  const missionId = o.missionId ?? MISSION;
  const store = createMemoryStore();
  store.missions.set(missionId, newMission({ id: missionId, user_id: o.userId ?? TEST_ACCOUNT, request_text: "منشورات", status: "executing", job_id: "job_camp" }));
  const rec = fakeRecorder({ dailyCapUsd: 100 });
  const queue = [...(o.answers ?? [])];
  const call = vi.fn(async (opt: TregCallOptions) => { const n = queue.shift() ?? tregResult(postsPage(3), 0.0004); return typeof n === "function" ? n(opt) : n; });
  const budget = createJobCallBudget({ ceilingUsd: 5, spentUsd: 0 });
  const gateway = createGateway({ store, client: CLIENT, missionId, userId: o.userId ?? TEST_ACCOUNT, jobId: "job_camp", phase: "execution", access: NOT_ADMIN, catalog, budget, recorder: rec.recorder, commit: rec.commit, call, defaultPurpose: "q", counter: { seq: 0 }, ...(o.noToken ? {} : { token: "worker-treg-token" }), ...spendGateOf(sg ? { spendGate: sg } : {}, missionId) });
  return { call, gateway, rec, store };
}
const ask = (t: ReturnType<typeof treg>, q = "q") => t.gateway.tregCall({ endpoint_id: POSTS_ENDPOINT, params: { query: q } }) as Promise<any>;
const admit = (x: World, id = MISSION, user = TEST_ACCOUNT) => x.sg.admit({ id, user_id: user });

describe("CAMPAIGN SCOPE: what the gate does for the campaign account and for everyone else", () => {
  it("A: one call under the remaining budget goes out, with its MAXIMUM reserved first (the route cap that is sent, one attempt) and settled by the reported charge", async () => {
    const x = world();
    expect(await admit(x)).toBe("gated");
    const t = treg(x.sg);
    const r = await ask(t);
    expect(r.ok).toBe(true);
    expect(t.call).toHaveBeenCalledTimes(1);
    const cap = Number((t.call.mock.calls[0][0] as TregCallOptions).routeMaxCostUsd);
    expect(x.counts.reserves).toHaveLength(1);
    expect(x.counts.reserves[0]).toMatchObject({ kind: "provider", missionId: MISSION });
    // ONE attempt by construction: the worker's token travels explicitly, so the client never hops to another pool key
    expect(x.counts.reserves[0].boundUsd).toBeCloseTo(cap, 6);
    const sent = t.call.mock.calls[0][0] as TregCallOptions;
    expect(sent.token).toBe("worker-treg-token");
    expect(sent.legacyToken).toBeUndefined();
    expect(x.counts.settles).toBe(1);
    expect(x.w.owner.grant("camp1")).toMatchObject({ reservedUsd: 0, spentUsd: 0.0004, overrunUsd: 0 });
  });

  it("A: with no token to pass (so the key pool could hop), the reservation covers the route cap of EVERY possible attempt", async () => {
    const x = world({ ceilingUsd: 0.3, perOpMaxUsd: 0.3 });
    await admit(x);
    const t = treg(x.sg, { noToken: true });
    expect((await ask(t)).ok).toBe(true);
    const cap = Number((t.call.mock.calls[0][0] as TregCallOptions).routeMaxCostUsd);
    expect(x.counts.reserves[0].boundUsd).toBeCloseTo(cap * TREG_CAMPAIGN_ATTEMPTS, 6);
    // and a grant whose per-operation maximum is lower refuses it before sending
    const y = world({ ceilingUsd: 0.3, perOpMaxUsd: 0.1 });
    await admit(y);
    const u = treg(y.sg, { noToken: true });
    expect(await ask(u)).toMatchObject({ ok: false, refused: "spend_gate" });
    expect(u.call).not.toHaveBeenCalled();
    expect(y.sg.summary(MISSION).refusal_reasons).toEqual({ over_op_max: 1 });
  });

  it("B: a call that would pass the remaining budget is refused BEFORE the provider is invoked, and the mission is not charged for it", async () => {
    const x = world({ ceilingUsd: 0.04, perOpMaxUsd: 0.1 });
    await admit(x);
    const t = treg(x.sg);
    const r = await ask(t);
    expect(r).toMatchObject({ ok: false, refused: "spend_gate" });
    expect(t.call).not.toHaveBeenCalled();
    expect(x.w.owner.grant("camp1")).toMatchObject({ reservedUsd: 0, spentUsd: 0 });
    expect(x.sg.summary(MISSION).refusal_reasons).toEqual({ over_ceiling: 1 });
  });

  it("C: 40 concurrent calls cannot collectively hold or spend past the campaign ceiling (measured after every reserve and settle)", async () => {
    const x = world({ ceilingUsd: 0.12, perOpMaxUsd: 0.1 });
    await admit(x);
    const t = treg(x.sg);
    const results = await Promise.all(Array.from({ length: 40 }, (_, i) => ask(t, `q${i}`)));
    const went = results.filter((r) => r.ok).length;
    expect(t.call).toHaveBeenCalledTimes(went);
    expect(x.counts.max).toBeLessThanOrEqual(0.12 + 1e-9);
    expect(went).toBeGreaterThanOrEqual(2);
    expect(x.w.owner.grant("camp1")!.spentUsd).toBeCloseTo(went * 0.0004, 6);
    expect(x.w.owner.grant("camp1")!.reservedUsd).toBe(0);
    expect(results.some((r) => r.ok === false && r.refused === "spend_gate")).toBe(true);
  });

  it("D: every attempt is its own reservation with its own key: a retry never rides on an earlier reservation, and the database's replay of ONE key never double-reserves", async () => {
    const x = world({ ceilingUsd: 0.3 });
    await admit(x);
    const t = treg(x.sg, { answers: [tregResult(postsPage(3), 0.0004), tregResult(postsPage(3), 0.0004)] });
    await ask(t); await ask(t);
    expect(new Set(x.counts.reserves.map((r) => r.key)).size).toBe(2);
    // the same key sent twice to the database (a lost answer to reserve) is the same reservation
    const k = { key: "dup-1", kind: "provider" as const, op: "x", boundUsd: 0.01, missionId: MISSION, ttlSeconds: 60 };
    const a = await x.w.gate.reserve(k); const b = await x.w.gate.reserve(k);
    expect(a).toMatchObject({ ok: true, replay: false });
    expect(b).toMatchObject({ ok: true, replay: true, reservationId: (a as { reservationId: string }).reservationId });
    expect(x.w.owner.grant("camp1")!.reservedUsd).toBeCloseTo(0.01, 6);
    expect(await x.w.gate.reserve({ ...k, boundUsd: 0.02 })).toMatchObject({ ok: false, reason: "key_conflict" });
    // a duplicate settle counts once
    const id = (a as { reservationId: string }).reservationId;
    await x.w.gate.settle(id, 0.004); const again = await x.w.gate.settle(id, 0.004);
    expect(again).toMatchObject({ ok: true, replay: true });
    expect(x.w.owner.grant("camp1")!.spentUsd).toBeCloseTo(0.0008 + 0.004, 6);
  });

  it("E: a call that timed out keeps its WHOLE reservation as spent (it may have been billed); the capacity is not given back", async () => {
    const x = world({ ceilingUsd: 0.05 });
    await admit(x);
    const t = treg(x.sg, { answers: [{ ...tregResult(null, 0), ok: false, timedOut: true, costMicro: 0 } as TregCallResult] });
    await ask(t);
    const cap = Number((t.call.mock.calls[0][0] as TregCallOptions).routeMaxCostUsd);
    expect(x.w.owner.grant("camp1")).toMatchObject({ reservedUsd: 0 });
    expect(x.w.owner.grant("camp1")!.spentUsd).toBeCloseTo(cap, 6);
  });

  it("F: a charge the provider did not report counts as the whole bound: unknown never frees budget", async () => {
    const x = world({ ceilingUsd: 0.05 });
    await admit(x);
    const unreported = { ...tregResult(postsPage(3), 0.0004), costIsEstimate: true } as TregCallResult;
    // and a malformed answer with no cost field at all is unknown too, never zero
    const malformed = { ...tregResult(postsPage(3), 0), costMicro: undefined } as unknown as TregCallResult;
    const t = treg(x.sg, { answers: [unreported, tregResult(postsPage(3), 0.0004)] });
    await ask(t);
    const cap = Number((t.call.mock.calls[0][0] as TregCallOptions).routeMaxCostUsd);
    expect(x.w.owner.grant("camp1")!.spentUsd).toBeGreaterThanOrEqual(cap - 1e-9);
    expect(x.sg.summary(MISSION).unknown_charges).toBe(1);
    const y = world({ ceilingUsd: 0.2 });
    await admit(y);
    await ask(treg(y.sg, { answers: [malformed] }));
    expect(y.w.owner.grant("camp1")!.spentUsd).toBeGreaterThanOrEqual(0.05 - 1e-9);
    expect(y.sg.summary(MISSION).unknown_charges).toBe(1);
  });

  it("F2 (independent review): a TREG answer that carries NO charge settles UNKNOWN, never at the placeholder 0 the client puts in costMicro", async () => {
    // the REAL client against a stubbed fetch: a header, an explicit 0 header, and an answer with neither
    const ANSWER = { total: 1, success: true, leads: [] };
    const opts = { token: "t", endpointId: "icypeas.people.search", method: "POST" as const, params: { query: { keyword: { include: ["software"] } }, pagination: { size: 9 } }, userId: "u", jobId: "j", stepId: "s", page: 1, routeMaxCostUsd: "0.005", timeoutMs: 2000 };
    const run = async (headers: Record<string, string>, status = 200) => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(ANSWER), { status, headers: { "content-type": "application/json", ...headers } })));
      try { return await (await import("../src/functions/shared/tregClient")).executeTregCall(opts); } finally { vi.unstubAllGlobals(); }
    };
    expect((await run({ "x-treg-cost-micro": "1140" })).costUnreported).toBeUndefined();
    expect((await run({ "x-treg-cost-micro": "0" })).costUnreported).toBeUndefined(); // a REPORTED zero is a zero
    for (const status of [200, 500, 503]) {
      const bare = await run({}, status);
      expect(bare.costUnreported, `status ${status}`).toBe(true);
      expect(bare.costMicro).toBe(0);
    }
    // the gateway settles that shape as unknown: the whole bound stays spent
    const x = world({ ceilingUsd: 0.2 });
    await admit(x);
    const bare = { ...tregResult(postsPage(3), 0), costUnreported: true } as TregCallResult;
    const t = treg(x.sg, { answers: [bare] });
    await ask(t);
    const cap = Number((t.call.mock.calls[0][0] as TregCallOptions).routeMaxCostUsd);
    expect(x.w.owner.grant("camp1")!.spentUsd).toBeGreaterThanOrEqual(cap - 1e-9);
    expect(x.sg.summary(MISSION).unknown_charges).toBe(1);
    // and a reported zero (header 0, no flag) still settles at zero
    const y = world({ ceilingUsd: 0.2 });
    await admit(y);
    await ask(treg(y.sg, { answers: [tregResult(postsPage(3), 0)] }));
    expect(y.w.owner.grant("camp1")!.spentUsd).toBeCloseTo(0, 9);
  });

  it("F3 (independent review): Context.dev credits that are null, empty, false or missing are NOT a reported zero", async () => {
    const { reportedCreditsOf } = await import("../agent/src/webGateway");
    for (const v of [null, "", "  ", false, undefined, {}, "abc", -1]) expect(reportedCreditsOf("contextdev", { key_metadata: { credits_consumed: v } }), String(JSON.stringify(v))).toBeNull();
    expect(reportedCreditsOf("contextdev", {})).toBeNull();
    expect(reportedCreditsOf("contextdev", null)).toBeNull();
    expect(reportedCreditsOf("contextdev", { key_metadata: { credits_consumed: 0 } })).toBe(0);
    expect(reportedCreditsOf("contextdev", { key_metadata: { credits_consumed: 3 } })).toBe(3);
    expect(reportedCreditsOf("contextdev", { key_metadata: { credits_consumed: "2" } })).toBe(2);
  });

  it("G: a worker restart cannot reset the campaign: spending lives in the store, and a restarted worker has NO mission admitted (every paid call is refused until it admits it again)", async () => {
    const x = world({ ceilingUsd: 0.2 });
    await admit(x);
    await ask(treg(x.sg));
    const spent = x.w.owner.grant("camp1")!.spentUsd;
    expect(spent).toBeGreaterThan(0);
    // the same store, a NEW worker process
    const restarted = createWorkerSpendGate({ mode: "enforce", gate: x.w.gate, apiKey: "k", campaign: { accountId: TEST_ACCOUNT } });
    const t = treg(restarted);
    expect(await ask(t)).toMatchObject({ ok: false, refused: "spend_gate" });
    expect(t.call).not.toHaveBeenCalled();
    expect(await restarted.admit({ id: MISSION, user_id: TEST_ACCOUNT })).toBe("gated");
    await ask(treg(restarted));
    expect(x.w.owner.grant("camp1")!.spentUsd).toBeCloseTo(spent + 0.0004, 6);
  });

  it("H: after the campaign's expiry no new paid request is allowed and no mission can be enrolled", async () => {
    const x = world();
    await admit(x);
    x.clock.now = T0 + 3_600_001;
    const t = treg(x.sg);
    expect(await ask(t)).toMatchObject({ ok: false, refused: "spend_gate" });
    expect(t.call).not.toHaveBeenCalled();
    expect(x.sg.summary(MISSION).refusal_reasons).toEqual({ grant_expired: 1 });
    const late = world(); late.clock.now = T0 + 3_600_001;
    expect(await admit(late)).toBe("blocked");
  });

  it("I/J: the grant belongs to the test account: another customer's mission is NEVER enrolled, never touches the gate, and runs exactly as it does today", async () => {
    const x = world();
    expect(await admit(x, OTHER_MISSION, OTHER_ACCOUNT)).toBe("ungated");
    const t = treg(x.sg, { missionId: OTHER_MISSION, userId: OTHER_ACCOUNT });
    const r = await ask(t);
    expect(r.ok).toBe(true);
    expect(t.call).toHaveBeenCalledTimes(1);
    expect(x.counts.reserves).toHaveLength(0);
    expect(x.counts.settles).toBe(0);
    expect(x.counts.enrolls).toBe(0);
    expect(x.sg.active(OTHER_MISSION)).toBe(false);
    // asked directly, an ungated mission's context is OFF with no gate at all
    expect(x.sg.context(OTHER_MISSION)).toEqual({ gate: null, mode: "off" });
    // and the store itself refuses it: not enrolled, and an enrollment of another account's mission is refused
    expect(await x.w.gate.reserve({ key: "o1", kind: "provider", op: "x", boundUsd: 0.001, missionId: OTHER_MISSION, ttlSeconds: 60 })).toMatchObject({ ok: false, reason: "mission_not_enrolled" });
    expect(await x.w.gate.enroll!(OTHER_MISSION)).toMatchObject({ ok: false, reason: "wrong_account" });
    expect(await x.w.gate.enroll!("msn_nobody")).toMatchObject({ ok: false, reason: "unknown_mission" });
    expect(x.w.owner.enrolledMissions("camp1")).toEqual([]);
  });

  it("I/J: the account is the mission row's own user_id, never a request field; the campaign serves only its enrolled missions, and no more than the limit", async () => {
    const x = world({ maxMissions: 1 });
    x.owners.set("msn_second", TEST_ACCOUNT);
    expect(await admit(x)).toBe("gated");
    expect(await admit(x, "msn_second")).toBe("blocked");
    const t = treg(x.sg, { missionId: "msn_second" });
    expect(await ask(t)).toMatchObject({ ok: false, refused: "spend_gate" });
    expect(t.call).not.toHaveBeenCalled();
    expect(await x.w.gate.reserve({ key: "nomission", kind: "provider", op: "x", boundUsd: 0.001, missionId: null, ttlSeconds: 60 })).toMatchObject({ ok: false, reason: "mission_not_enrolled" });
  });

  it("K: an operation with no maximum is refused before it is sent: a TREG call with no route cap, a Context.dev pre-built parser, and a model request with a server tool", async () => {
    expect(providerCallBound({ provider: "treg", op: "call", boundUsd: null })).toMatchObject({ ok: false, reason: "no_safe_bound" });
    expect(providerCallBound({ provider: "contextdev", op: "parser", parser: "google-maps" })).toMatchObject({ ok: false, reason: "no_safe_bound" });
    expect(providerCallBound({ provider: "firecrawl", op: "search", limit: 10, scrapesResults: true })).toMatchObject({ ok: false, reason: "no_safe_bound" });
    expect(providerCallBound({ provider: "treg", op: "call", boundUsd: 0.001, attempts: 0 })).toMatchObject({ ok: false, reason: "no_safe_bound" });
    const x = world();
    await admit(x);
    const inner = vi.fn(async () => new Response("{}"));
    const f = gatedModelFetch(x.sg.context(MISSION), MISSION, { inner: inner as never, maxOutputTokens: 500 });
    const body = { model: "claude-haiku-5-5", max_tokens: 100, messages: [{ role: "user", content: "hi" }], tools: [{ type: "web_search_20250305", name: "web_search" }] };
    const res = await f("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "anthropic-beta": "" }, body: JSON.stringify(body) });
    expect(res.status).toBe(403);
    expect(inner).not.toHaveBeenCalled();
    expect(x.counts.reserves).toHaveLength(0);
  });

  it("K: a Context.dev parser through the worker's web gateway is refused and nothing is sent", async () => {
    const x = world();
    await admit(x);
    const store = createMemoryStore();
    store.missions.set(MISSION, newMission({ id: MISSION, user_id: TEST_ACCOUNT, status: "planning" }));
    const fetchFn = vi.fn(async () => new Response("{}"));
    const web = createWebGateway({ store, missionId: MISSION, jobId: null, phase: "planning", budget: createJobCallBudget({ ceilingUsd: 0.5, spentUsd: 0 }), recorder: fakeRecorder({}).recorder, providerKey: async () => "key", fetchFn: fetchFn as never, counter: { seq: 0 }, ...spendGateOf({ spendGate: x.sg }, MISSION) });
    const r = await web.parsePage({ parser: "instagram-feed", url: "https://www.instagram.com/explore/tags/coffee/" });
    expect(r).toMatchObject({ ok: false, refused: "spend_gate" });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(x.counts.reserves).toHaveLength(0);
    expect(x.sg.summary(MISSION).refusal_reasons).toEqual({ no_safe_bound: 1 });
  });

  it("L: an unavailable spending store FAILS CLOSED for the enrolled test mission (enroll error, enroll hang, reserve error) and does not touch another customer", async () => {
    const down = (kind: "throw" | "hang"): ((g: SpendGate) => SpendGate) => (g) => ({
      reserve: () => (kind === "throw" ? Promise.reject(new Error("db down")) : new Promise(() => undefined)),
      settle: () => Promise.reject(new Error("db down")),
      enroll: () => (kind === "throw" ? Promise.reject(new Error("db down")) : new Promise(() => undefined)),
      stop: g.stop,
    });
    for (const kind of ["throw", "hang"] as const) {
      const x = world({ gate: down(kind), enrollTimeoutMs: 30 });
      expect(await admit(x)).toBe("blocked");
      const t = treg(x.sg);
      expect(await ask(t)).toMatchObject({ ok: false, refused: "spend_gate" });
      expect(t.call).not.toHaveBeenCalled();
      // the store being down does not stop a customer who is not in the campaign
      expect(await admit(x, OTHER_MISSION, OTHER_ACCOUNT)).toBe("ungated");
      const c = treg(x.sg, { missionId: OTHER_MISSION, userId: OTHER_ACCOUNT });
      expect((await ask(c)).ok).toBe(true);
    }
    // enrolled, then the store goes down for the reserve: still refused, nothing sent
    const y = world({ gate: (g) => ({ ...g, reserve: () => Promise.reject(new Error("db down")) }) });
    expect(await admit(y)).toBe("gated");
    const t2 = treg(y.sg);
    expect(await ask(t2)).toMatchObject({ ok: false, refused: "spend_gate" });
    expect(t2.call).not.toHaveBeenCalled();
    expect(y.sg.summary(MISSION).refusal_reasons).toEqual({ gate_unavailable: 1 });
  });

  it("N: model and provider spending consume the SAME campaign budget", async () => {
    const x = world({ ceilingUsd: 0.0505, perOpMaxUsd: 0.0505 });
    await admit(x);
    // a model request in flight holds its bound; the provider call that would pass the shared total is refused
    const hang = vi.fn(() => new Promise<Response>(() => undefined));
    const f = gatedModelFetch(x.sg.context(MISSION), MISSION, { inner: hang as never, maxOutputTokens: 1000 });
    void f("https://api.anthropic.com/v1/messages", { method: "POST", headers: {}, body: JSON.stringify({ model: "claude-haiku-5-5", max_tokens: 1000, messages: [{ role: "user", content: "hi" }] }) });
    await new Promise((r) => setTimeout(r, 20));
    const held = x.w.owner.grant("camp1")!.reservedUsd;
    expect(held).toBeGreaterThan(0.0005);
    expect(held).toBeLessThan(0.0015);
    expect(x.counts.reserves[0].kind).toBe("model");
    const t = treg(x.sg);
    expect(await ask(t)).toMatchObject({ ok: false, refused: "spend_gate" });
    expect(t.call).not.toHaveBeenCalled();
    expect(x.sg.summary(MISSION).refusal_reasons).toEqual({ over_ceiling: 1 });
  });

  /** One POST to the model gate on 127.0.0.1 with node's http (global fetch is stubbed to fail loudly in this file). */
  const postToGate = (base: string, token: string, body: unknown) => new Promise<{ status: number; text: string }>((resolve, reject) => {
    const u = new URL(`${base}/v1/messages`);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: "POST", headers: { "content-type": "application/json", "x-api-key": token } }, (res) => { let t = ""; res.on("data", (c) => (t += c)); res.on("end", () => resolve({ status: res.statusCode ?? 0, text: t })); });
    req.on("error", reject); req.end(JSON.stringify(body));
  });
  const modelBody = { model: "claude-haiku-5-5", max_tokens: 1000, messages: [{ role: "user", content: "hello" }] };
  const upstreamOk = () => vi.fn(async () => new Response(JSON.stringify({ id: "m", type: "message", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 300, output_tokens: 5 } }), { status: 200, headers: { "content-type": "application/json" } }));

  it("the SDK's model gate: an ENROLLED mission's request is reserved before it is forwarded, the child never holds the real key, and the campaign output cap applies; a mission that is NOT enrolled gets a refusal and nothing reaches the upstream", async () => {
    const upstream = upstreamOk();
    const w = createMemorySpendGate({ now: () => T0, missionOwner: () => TEST_ACCOUNT });
    w.owner.issueCampaignGrant({ id: "camp1", ceilingUsd: 0.3, perOpMaxUsd: 0.1, perMissionMaxUsd: 0.3, kinds: ["provider", "model"], opensAt: T0 - 60_000, closesAt: T0 + 3_600_000, issuedBy: "o", reason: "t", accountId: TEST_ACCOUNT, maxMissions: 1 });
    const sg = createWorkerSpendGate({ mode: "enforce", gate: w.gate, apiKey: "real-key-xyz", campaign: { accountId: TEST_ACCOUNT }, fetchFn: upstream as never, maxOutputTokens: 500 });
    expect(await sg.admit({ id: MISSION, user_id: TEST_ACCOUNT })).toBe("gated");
    expect(await sg.admit({ id: "msn_second", user_id: TEST_ACCOUNT })).toBe("blocked");
    const good = await sg.modelGateFor(MISSION).start();
    expect(good.childEnv.ANTHROPIC_API_KEY).not.toBe("real-key-xyz");
    expect(JSON.stringify(good.childEnv)).not.toContain("real-key-xyz");
    const ok = await postToGate(good.childEnv.ANTHROPIC_BASE_URL, good.childEnv.ANTHROPIC_API_KEY, modelBody);
    expect(ok.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String((upstream.mock.calls[0] as unknown[])[1] && ((upstream.mock.calls[0] as unknown[])[1] as { body: string }).body)).max_tokens).toBe(500);
    await good.close();
    expect(w.owner.grant("camp1")!.spentUsd).toBeGreaterThan(0);
    expect(w.owner.grant("camp1")!.reservedUsd).toBe(0);
    const bad = await sg.modelGateFor("msn_second").start();
    const refused = await postToGate(bad.childEnv.ANTHROPIC_BASE_URL, bad.childEnv.ANTHROPIC_API_KEY, modelBody);
    expect(refused.status).toBe(400);
    expect(refused.text).toContain("spend_gate_refused");
    expect(upstream).toHaveBeenCalledTimes(1);
    await bad.close();
  });

  it("the gate's own kinds exclude chat and eval: nothing of the website's chat can draw on a campaign grant", async () => {
    const x = world();
    await admit(x);
    expect(await x.w.gate.reserve({ key: "chat1", kind: "chat", op: "chat", boundUsd: 0.001, missionId: MISSION, ttlSeconds: 60 })).toMatchObject({ ok: false, reason: "kind_not_covered" });
    expect(await x.w.gate.reserve({ key: "eval1", kind: "eval", op: "eval", boundUsd: 0.001, missionId: MISSION, ttlSeconds: 60 })).toMatchObject({ ok: false, reason: "kind_not_covered" });
    expect(() => x.w.owner.issueCampaignGrant({ id: "c2", ceilingUsd: 0.01, perOpMaxUsd: 0.01, perMissionMaxUsd: 0.01, kinds: ["provider", "chat"], opensAt: T0, closesAt: T0 + 1000, issuedBy: "o", reason: "r", accountId: TEST_ACCOUNT, maxMissions: 1 })).toThrow(/provider and model only/);
  });

  it("ONE cumulative ceiling: a revoked, tripped or expired grant gives nothing back; a second grant can only use what is left of 0.30", async () => {
    const x = world({ ceilingUsd: 0.2, perOpMaxUsd: 0.1 });
    await admit(x);
    const r = await x.w.gate.reserve({ key: "u1", kind: "provider", op: "x", boundUsd: 0.05, missionId: MISSION, ttlSeconds: 60 });
    await x.w.gate.settle((r as { reservationId: string }).reservationId, null);
    // 0.05 is spent; one more 0.05 stays HELD while the grant is revoked
    await x.w.gate.reserve({ key: "u2", kind: "provider", op: "x", boundUsd: 0.05, missionId: MISSION, ttlSeconds: 60 });
    x.w.owner.revoke("camp1");
    expect(x.w.owner.campaignExposureUsd()).toBeCloseTo(0.1, 6);
    const next = (id: string, usd: number) => x.w.owner.issueCampaignGrant({ id, ceilingUsd: usd, perOpMaxUsd: 0.05, perMissionMaxUsd: usd, kinds: ["provider"], opensAt: T0, closesAt: T0 + 1000, issuedBy: "o", reason: "r", accountId: TEST_ACCOUNT, maxMissions: 1 });
    expect(() => next("camp2", 0.21)).toThrow(/cumulative ceiling/);
    expect(next("camp2", 0.2).ceilingUsd).toBe(0.2);
    expect(CAMPAIGN_LIFETIME_CEILING_USD).toBe(0.3);
  });

  it("an overrun is real money: it counts in the campaign's exposure, so it cannot be spent twice; and a campaign window is at most 72 hours", async () => {
    const x = world({ ceilingUsd: 0.3, perOpMaxUsd: 0.1 });
    await admit(x);
    const r = await x.w.gate.reserve({ key: "ov1", kind: "provider", op: "x", boundUsd: 0.01, missionId: MISSION, ttlSeconds: 60 });
    // settled at 0.05 against a bound of 0.01: counts 0.01, overrun 0.04, the grant trips
    expect(await x.w.gate.settle((r as { reservationId: string }).reservationId, 0.05)).toMatchObject({ ok: true, countedUsd: 0.01, overrunUsd: 0.04 });
    expect(x.w.owner.grant("camp1")).toMatchObject({ state: "tripped", spentUsd: 0.01, overrunUsd: 0.04 });
    expect(x.w.owner.campaignExposureUsd()).toBeCloseTo(0.05, 6);
    const next = (id: string, usd: number) => x.w.owner.issueCampaignGrant({ id, ceilingUsd: usd, perOpMaxUsd: 0.05, perMissionMaxUsd: usd, kinds: ["provider"], opensAt: T0, closesAt: T0 + 1000, issuedBy: "o", reason: "r", accountId: TEST_ACCOUNT, maxMissions: 1 });
    expect(() => next("c2", 0.26)).toThrow(/cumulative ceiling/);
    expect(next("c2", 0.25).ceilingUsd).toBe(0.25);
    const hours = (h: number) => ({ id: `w${h}`, ceilingUsd: 0.01, perOpMaxUsd: 0.01, perMissionMaxUsd: 0.01, kinds: ["provider" as const], opensAt: T0, closesAt: T0 + h * 3_600_000, issuedBy: "o", reason: "r", accountId: TEST_ACCOUNT, maxMissions: 1 });
    const y = world();
    y.w.owner.revoke("camp1");
    expect(() => y.w.owner.issueCampaignGrant(hours(73))).toThrow(/window is short/);
    expect(y.w.owner.issueCampaignGrant(hours(72)).id).toBe("w72");
  });
});

describe("M/O: with the campaign OFF or for any other account, everything is exactly as today; no customer money moves", () => {
  it("M: DIGER_SPEND_GATE unset builds nothing; `campaign` without the test account's id does not start the worker; a typo still fails closed", () => {
    for (const v of [undefined, "", "off", "0"]) expect(workerSpendGateFromEnv({ DIGER_SPEND_GATE: v }, null)).toBeNull();
    expect(workerSpendGateFromEnv({ DIGER_SPEND_GATE: "off", DIGER_SPEND_CAMPAIGN_ACCOUNT: TEST_ACCOUNT }, null)).toBeNull();
    expect(campaignModeFromEnv({})).toBeNull();
    expect(campaignModeFromEnv({ DIGER_SPEND_GATE: "observe" })).toBeNull();
    expect(() => workerSpendGateFromEnv({ DIGER_SPEND_GATE: "campaign" }, null)).toThrow(SpendCampaignConfigError);
    expect(() => workerSpendGateFromEnv({ DIGER_SPEND_GATE: "campaign", DIGER_SPEND_CAMPAIGN_ACCOUNT: "not-a-uuid" }, null)).toThrow(SpendCampaignConfigError);
    const g = workerSpendGateFromEnv({ DIGER_SPEND_GATE: "Campaign", DIGER_SPEND_CAMPAIGN_ACCOUNT: TEST_ACCOUNT.toUpperCase() }, null)!;
    expect(g).toMatchObject({ mode: "enforce", scope: "campaign" });
    expect(workerSpendGateFromEnv({ DIGER_SPEND_GATE: "enfroce" }, null)).toMatchObject({ mode: "enforce", scope: "global" });
    // an account id beside an enforcing value is a campaign (a typo can never become a global enforce); beside off or observe it changes nothing
    for (const v of ["enforce", "enfroce", "campiagn"]) expect(workerSpendGateFromEnv({ DIGER_SPEND_GATE: v, DIGER_SPEND_CAMPAIGN_ACCOUNT: TEST_ACCOUNT }, null)).toMatchObject({ mode: "enforce", scope: "campaign" });
    expect(() => workerSpendGateFromEnv({ DIGER_SPEND_GATE: "enforce", DIGER_SPEND_CAMPAIGN_ACCOUNT: "garbage" }, null)).toThrow(SpendCampaignConfigError);
    expect(workerSpendGateFromEnv({ DIGER_SPEND_GATE: "observe", DIGER_SPEND_CAMPAIGN_ACCOUNT: TEST_ACCOUNT }, null)).toMatchObject({ mode: "observe", scope: "global" });
    expect(campaignModeFromEnv({ DIGER_SPEND_GATE: "off", DIGER_SPEND_CAMPAIGN_ACCOUNT: TEST_ACCOUNT })).toBeNull();
  });

  it("M: an ungated mission's dependencies are the very same objects as with no gate (no gateway key, no model gate, the same review call)", async () => {
    const x = world();
    await admit(x, OTHER_MISSION, OTHER_ACCOUNT);
    expect(spendGateOf({ spendGate: x.sg }, OTHER_MISSION)).toEqual({});
    expect("spendGate" in spendGateOf({ spendGate: x.sg }, OTHER_MISSION)).toBe(false);
    const deps = { spendGate: x.sg, reviewCall: (async () => ({})) as never };
    expect(withMissionSpendGate(deps, OTHER_MISSION)).toBe(deps);
    expect(withMissionSpendGate(deps, MISSION)).not.toBe(deps);
    // the campaign mission is blocked unless admitted: a mission nobody admitted gets the gate with NO store (refuses everything)
    expect(x.sg.active("msn_never_admitted")).toBe(true);
    expect(x.sg.summary("msn_never_admitted").mode).toBe("enforce");
    expect(x.sg.finish(OTHER_MISSION).reservations).toBe(0);
  });

  const ENDPOINT = "anyapi.instagram.hashtag.posts";
  const execCalls = (r: Results) => r.filter((x) => x.tool === "treg_call" && x.result.ok === true).map((x) => String(x.result.call_id));
  const mission = (deps?: (base: any) => any, chooseMission?: (turn: { missionId: string }) => string) => replay({
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
    ...(chooseMission ? { chooseMission } : {}),
  });

  const run = async (account: string, sg: ReturnType<typeof createWorkerSpendGate>) => {
    const modelRuns: boolean[] = [];
    let admitted: Promise<unknown> = Promise.resolve();
    // the worker admits a mission when it claims it, before it builds anything: here, as soon as the mission exists
    const on = await mission((base) => ({ ...base, spendGate: sg, driver: { run: async (input: any) => { modelRuns.push(Boolean(input.modelGate)); return base.driver.run(input); } } }),
      (turn) => { admitted = sg.admit({ id: turn.missionId, user_id: account }); return turn.missionId; });
    await admitted;
    return { on, modelRuns };
  };
  const SAME = ["status", "charged_points", "reserved_points", "unit_price_points", "planning_treg_usd", "execution_treg_usd", "error"] as const;

  it("O: a whole mission (plan, approve, execute, settle) of the campaign account, enrolled and gated, ends exactly as with the gate off: same charge, balance and records; every provider call was reserved first", async () => {
    const off = await mission();
    const w2 = createMemorySpendGate({ now: () => T0, missionOwner: () => REPLAY_USER });
    w2.owner.issueCampaignGrant({ id: "camp1", ceilingUsd: 0.3, perOpMaxUsd: 0.1, perMissionMaxUsd: 0.3, kinds: ["provider", "model"], opensAt: T0 - 60_000, closesAt: T0 + 3_600_000, issuedBy: "owner", reason: "test", accountId: REPLAY_USER, maxMissions: 1 });
    const reserves: number[] = [];
    const gate: SpendGate = { ...w2.gate, reserve: async (r) => { reserves.push(r.boundUsd); return w2.gate.reserve(r); }, enroll: (id) => w2.gate.enroll!(id) };
    const sg = createWorkerSpendGate({ mode: "enforce", gate, apiKey: "k", campaign: { accountId: REPLAY_USER } });
    const { on, modelRuns } = await run(REPLAY_USER, sg);
    assertReplayInvariants(off, { expectDelivered: 60 });
    assertReplayInvariants(on, { expectDelivered: 60 });
    expect(on.money.balance()).toBe(off.money.balance());
    for (const k of SAME) expect((on.mission as any)[k], k).toEqual((off.mission as any)[k]);
    expect(on.call.mock.calls.length).toBe(off.call.mock.calls.length);
    expect(reserves.length).toBe(on.call.mock.calls.length);
    expect(modelRuns.length).toBeGreaterThan(0);
    expect(modelRuns.every(Boolean)).toBe(true);
    const g = w2.owner.grant("camp1")!;
    expect(g.spentUsd).toBeGreaterThan(0);
    expect(g.spentUsd + g.reservedUsd).toBeLessThanOrEqual(0.3);
    expect(g).toMatchObject({ reservedUsd: 0, overrunUsd: 0, state: "open" });
    expect(w2.owner.enrolledMissions("camp1")).toHaveLength(1);
  });

  it("O: the same whole mission for ANOTHER account, in campaign scope, is identical to the gate off and touches the gate not at all", async () => {
    const off = await mission();
    const x = world();
    const sg = createWorkerSpendGate({ mode: "enforce", gate: x.w.gate, apiKey: "k", campaign: { accountId: OTHER_ACCOUNT } });
    const { on, modelRuns } = await run(REPLAY_USER, sg);
    assertReplayInvariants(on, { expectDelivered: 60 });
    expect(on.money.balance()).toBe(off.money.balance());
    for (const k of SAME) expect((on.mission as any)[k], k).toEqual((off.mission as any)[k]);
    expect(modelRuns.every((m) => m === false)).toBe(true);
    expect(x.counts.reserves).toHaveLength(0);
    expect(x.counts.enrolls).toBe(0);
    expect(x.w.owner.grant("camp1")).toMatchObject({ reservedUsd: 0, spentUsd: 0 });
  });
});

describe("P: the existing acceptance workflow cannot start while the campaign ceiling is not enforceable", () => {
  it("the production guarantee is unchanged (enforceable: false, frozen), and a start or a scenario is refused without touching the database", async () => {
    expect(PRODUCTION_BUDGET_GUARANTEE).toEqual({ enforceable: false, ceilingUsd: null, reasons: ["model_calls_not_reserved", "provider_caps_shared_and_estimated", "no_aggregate_ledger"] });
    expect(Object.isFrozen(PRODUCTION_BUDGET_GUARANTEE)).toBe(true);
    const untouched = new Proxy({}, { get() { throw new Error("the database was touched"); } });
    expect(await startCampaign(untouched, { account: { id: TEST_ACCOUNT }, adminId: "adm", keys: ["registry_router"], minutes: 60, budget: PRODUCTION_BUDGET_GUARANTEE, nowMs: T0 })).toMatchObject({ ok: false, status: 409, error: "budget_not_enforceable" });
    expect(await createScenarioMission(untouched, { account: { id: TEST_ACCOUNT }, adminId: "adm", scenario: "L3", budget: PRODUCTION_BUDGET_GUARANTEE, nowMs: T0 })).toMatchObject({ ok: false, status: 409, error: "budget_not_enforceable" });
  });

  it("no production code reads the readiness checklist: nothing can flip the guarantee from here", () => {
    const hits: string[] = [];
    const walk = (dir: string) => { for (const e of readdirSync(dir)) { const p = path.join(dir, e); if (statSync(p).isDirectory()) walk(p); else if (/\.(ts|tsx)$/.test(e) && /campaignReadiness/.test(readFileSync(p, "utf8"))) hits.push(path.relative(ROOT, p)); } };
    walk(path.join(ROOT, "src")); walk(path.join(ROOT, "agent/src"));
    expect(hits).toEqual(["src/lib/server/spendGate/campaign.ts"]);
  });

  const all: CampaignEvidence = { sqlApplied: true, grantOpen: true, grantCeilingUsd: 0.3, grantAccountIsTestAccount: true, workerInCampaignMode: true, workerVersionHasGate: true, inventoryComplete: true, rehearsalPassed: true, providerLimitsConfigured: true };
  it("the ceiling is enforceable only when EVERY condition holds; each missing one is named", () => {
    expect(campaignReadiness(all)).toEqual({ enforceable: true, blockers: [] });
    const names: Record<keyof CampaignEvidence, string> = { sqlApplied: "sql_not_applied", grantOpen: "no_open_campaign_grant", grantCeilingUsd: "grant_ceiling_above_campaign_ceiling", grantAccountIsTestAccount: "grant_not_bound_to_the_test_account", workerInCampaignMode: "worker_not_in_campaign_mode", workerVersionHasGate: "worker_without_the_gate", inventoryComplete: "paid_call_inventory_incomplete", rehearsalPassed: "no_rehearsal_on_the_production_store", providerLimitsConfigured: "provider_side_limits_not_confirmed" };
    for (const k of Object.keys(all) as Array<keyof CampaignEvidence>) {
      const e = { ...all, [k]: k === "grantCeilingUsd" ? 0.31 : false } as CampaignEvidence;
      const r = campaignReadiness(e);
      expect(r.enforceable, k).toBe(false);
      expect(r.blockers, k).toContain(names[k]);
    }
    expect(campaignReadiness({ ...all, grantCeilingUsd: null }).enforceable).toBe(false);
    // the state of production today
    expect(campaignReadiness({ sqlApplied: false, grantOpen: false, grantCeilingUsd: null, grantAccountIsTestAccount: false, workerInCampaignMode: false, workerVersionHasGate: false, inventoryComplete: true, rehearsalPassed: false, providerLimitsConfigured: false }).blockers).toHaveLength(6);
  });
});

const ROOT = path.resolve(__dirname, "..");
describe("Q: THE PAID-CALL INVENTORY is complete: no file that can make a paid call is outside the registry", () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      if (e === "node_modules" || e === ".next" || e === "dist") continue;
      const p = path.join(dir, e);
      if (statSync(p).isDirectory()) walk(p); else if (/\.(ts|tsx|mjs|js)$/.test(e)) files.push(path.relative(ROOT, p));
    }
  };
  for (const d of ["src", "agent/src", "scripts", "evals"]) if (existsSync(path.join(ROOT, d))) walk(path.join(ROOT, d));

  it("every source file with a paid-call marker is classified (a new paid path cannot appear unclassified)", () => {
    // the registry itself names the markers as text; it is not a paid path
    const marked = files.filter((f) => f !== "src/lib/server/spendGate/paidPaths.ts").filter((f) => { const s = readFileSync(path.join(ROOT, f), "utf8"); return PAID_CALL_MARKERS.some((m) => m.test(s)); });
    const unclassified = marked.filter((f) => !PAID_PATH_FILES.has(f));
    expect(unclassified).toEqual([]);
  });

  it("every file the registry names exists, and no file is in two groups", () => {
    for (const g of PAID_PATH_GROUPS) for (const f of g.files) expect(existsSync(path.join(ROOT, f)), `${g.id}: ${f}`).toBe(true);
    const all = PAID_PATH_GROUPS.flatMap((g) => g.files);
    expect(new Set(all).size).toBe(all.length);
  });

  it("the worker's four paid paths are gated and safe; every website, admin and script path is EXCLUDED, none is claimed as covered", () => {
    expect(CAMPAIGN_GATED_GROUPS.map((g) => g.id).sort()).toEqual(["worker.review", "worker.sdk", "worker.treg", "worker.web"]);
    for (const g of CAMPAIGN_GATED_GROUPS) { expect(g.bound.length).toBeGreaterThan(20); expect(g.mechanism.length).toBeGreaterThan(20); }
    const excluded = CAMPAIGN_EXCLUDED_GROUPS.map((g) => g.id).sort();
    expect(excluded).toEqual(["admin.paid", "scripts.live", "website.chat", "website.planner", "website.review"]);
    for (const g of CAMPAIGN_EXCLUDED_GROUPS) expect(g.safeInCampaign, g.id).toBe(false);
    // the worker makes no network call outside those four paths
    const net = files.filter((f) => f.startsWith("agent/src/") && /\bfetch\(|fetchFn\(|node:https?"/.test(readFileSync(path.join(ROOT, f), "utf8"))).sort();
    expect(net).toEqual(["agent/src/modelGate.ts", "agent/src/review.ts", "agent/src/spendGateWiring.ts", "agent/src/webGateway.ts"]);
  });

  it("the worker constructs every gateway, model run and review call through the gate's hooks (no bare construction)", () => {
    const run = readFileSync(path.join(ROOT, "agent/src/runMission.ts"), "utf8");
    for (const m of run.matchAll(/createGateway\(\{[^\n]*\}\);/g)) expect(m[0]).toContain("spendGateOf(deps");
    for (const m of run.matchAll(/createWebGateway\(\{[^\n]*\}\)/g)) expect(m[0]).toContain("spendGateOf(deps");
    for (const m of run.matchAll(/deps\.driver\.run\(\{[^\n]*\}\);/g)) expect(m[0]).toContain("modelGateOf(deps");
    const addon = readFileSync(path.join(ROOT, "agent/src/stage4/runAddon.ts"), "utf8");
    for (const m of addon.matchAll(/createGateway\(\{[^\n]*\}\);/g)) expect(m[0]).toContain("spendGateOf(deps");
    const main = readFileSync(path.join(ROOT, "agent/src/main.ts"), "utf8");
    expect(main).toContain("spendGate.admit(");
    expect(main.indexOf("spendGate.admit(")).toBeLessThan(main.indexOf("runClaimedSafely({"));
  });
});
