import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { world } from "./helpers/replayWorld";

vi.mock("../src/lib/supabase/server", async () => (await import("./helpers/replayWorld")).world.supabaseServerMock());
vi.mock("../src/lib/server/sendPlatformEmail", () => ({ sendPlatformEmail: vi.fn(async () => undefined), getRecipient: vi.fn(async () => null) }));
vi.mock("../src/functions/shared/catalogClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/functions/shared/catalogClient")>()),
  getEndpointDetails: vi.fn(async () => null),
  searchCatalog: vi.fn(async () => []),
}));

import { setProviderAdapterForTesting, defaultTregAdapter } from "../src/lib/server/tregAdapter";
import { ChatHandler } from "../src/functions/shared/chatHandler";
import { clearBriefCacheForTesting } from "../src/functions/shared/briefManager";
import { resetProviderBalanceCacheForTesting, setProviderBalanceForTesting } from "../src/functions/shared/providerSpend";
import { createChatDb } from "./helpers/chatSession";
import { createScriptedTransport, type PlannerTransport } from "../src/lib/modelPlanner/transport";
import { resetExplorationMemoryForTesting } from "../src/lib/modelPlanner/exploration";
import { MODEL_PLAN_PARAM, PLANNING_MAX_TURNS, PLANNING_STEP_DEADLINE_MS } from "../src/lib/modelPlanner/constants";
import { advancePlanningSession, loadPlanningSession, resumeStalePlanningSessions, startPlanningSession, sessionRequestOf, PLANNING_SESSIONS_TABLE } from "../src/lib/modelPlanner/planningSession";
import { deliveredTotalOf } from "../src/lib/modelPlanner/stageFit";
import { setRowAdvisorForTesting } from "../src/lib/server/rowReviewAdvisor";
import { REPLAY_CASES, type ReplayCase } from "./helpers/replayCases";
import { loadFixture } from "./helpers/replayWorld";
import { describe as describeTool, propose, sample, search, say } from "./helpers/plannerKit";

/**
 * THE PROOF OF THE PLANNING SESSION, with ZERO provider calls: three multi-stage missions are planned by a RECORDED model through several resumed invocations of the session, each invocation
 * under 45 s on a fake clock (the model call costs 10 s, a source call 6 s, so one request could never hold the loop), and each ends in a card whose stage counts add up.
 *
 * The three missions: companies AND their e-mails (a feeder stage then a delivered stage), the comments on the videos of a topic (stages that multiply), and the official channel of an entity
 * (the account is not in the customer's words). The fixtures are the catalog's example answers (the stored raw_first_page.json of the live runs is not readable from here): marked synthetic where renamed.
 */

const ALLOWLISTED = "magdy.saber@outlook.com";
const MODEL_STEP_MS = 10_000;
const SOURCE_STEP_MS = 6_000;
const PAGE_GAP_MS = 1_500;
const tick = (ms: number) => vi.setSystemTime(new Date(Date.now() + ms));
const caseOf = (id: string): ReplayCase => REPLAY_CASES.find((c) => c.id === id)!;

/** The official-channel mission: the customer names the entity, not the account; the model finds the channel from the catalog's account sample and the customer confirms in the card. */
const officialChannel = (): ReplayCase => {
  const base = loadFixture("real-rows_anyapi.x.user.posts");
  const rename = (v: any): any => (typeof v === "string" ? (v.toLowerCase() === "elonmusk" ? "FIFAcom" : v) : Array.isArray(v) ? v.map(rename) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, rename(x)])) : v);
  const fixture = { ...base, name: `${base.name} (account renamed to FIFAcom)`, pages: base.pages.map(rename), synthetic: "the live job's ten rows with the account name replaced by «FIFAcom»" };
  const plan = {
    summaryAr: "جمع ١٠ منشورات من حساب @FIFAcom على X",
    steps: [{
      endpointId: "anyapi.x.user.posts", volume: 10,
      params: [{ name: "handle", value: "FIFAcom", source: "customer_text", quote: "@FIFAcom" }],
      fieldMap: { columns: [{ field: "text", headerAr: "نص المنشور", role: "text" }, { field: "authorHandle", headerAr: "الحساب", role: "author_handle" }, { field: "createdUtc", headerAr: "تاريخ النشر", role: "date" }], pagination: { kind: "token", param: "cursor" } },
      filters: [{ kind: "author_equals", field: "authorHandle", value: "FIFAcom", quote: "@FIFAcom" }, { kind: "exclude_true", field: "isReply" }],
    }],
  };
  return {
    id: "OFFICIAL", group: "request", request: "أريد ١٠ منشورات من القناة الرسمية لفيفا على X (@FIFAcom)", fixtures: [fixture as any],
    script: [search("x", ["user", "posts"]), describeTool("anyapi.x.user.posts"), sample("anyapi.x.user.posts", [{ name: "handle", value: "FIFAcom", source: "customer_text", quote: "@FIFAcom" }]), propose(plan)],
    expectNew: { kind: "plan", endpoint: "anyapi.x.user.posts" },
  };
};

interface Mission {
  invocations: number[];
  final: any;
  session: any;
  chat: ChatHandler;
  db: any;
  modelCalls: number;
}

/** Plans a case the way production does: the chat request runs the first step, then the page's step calls resume the session until it is done. */
async function planThroughSession(c: ReplayCase, options: { script?: ReplayCase["script"] } = {}): Promise<Mission> {
  const db: any = createChatDb();
  const handler = new ChatHandler(db);
  (handler as any).llm.executeTurn = vi.fn(async () => { throw new Error("the old model path must not run when the planner is on"); });
  const script = (options.script ?? c.script).map((content) => () => { tick(MODEL_STEP_MS); return content; });
  const transport: PlannerTransport & { requests: unknown[] } = createScriptedTransport(script as any, { model: "recorded" }) as any;
  handler.modelPlanner = { transport, client: world.mem, today: () => new Date("2026-10-27T12:00:00Z") };
  world.resetJob({ slug: "x", endpointId: "x", params: {}, target: 1, unitPrice: 1 });
  world.installFetch(c.fixtures);
  const served = globalThis.fetch;
  vi.stubGlobal("fetch", async (...args: Parameters<typeof fetch>) => { tick(SOURCE_STEP_MS); return served(...args); });
  clearBriefCacheForTesting();
  const conversationId = `conv_session_${c.id}`;
  await db.createRow({ tableId: "conversations", rowId: conversationId, data: { userId: "user_replay", title: "محادثة جديدة", status: "active", totalTokens: 0 } });
  const first0 = Date.now();
  const first = await handler.handleUserMessage({ userId: "user_replay", userEmail: ALLOWLISTED, conversationId, message: c.request, userBalance: 40_000 }) as any;
  const invocations = [Date.now() - first0];
  let reply = first;
  let session: any = null;
  let guard = 0;
  while (reply.outputType === "planning_pending" && guard++ < 20) {
    tick(PAGE_GAP_MS);
    session = await loadPlanningSession(world.mem, reply.planning.sessionId);
    expect(session?.status).toBe("running");
    const t0 = Date.now();
    const adv = await advancePlanningSession({ client: world.mem, tables: db, config: handler.modelPlanner!, session: session!, startedAtMs: t0 });
    invocations.push(Date.now() - t0);
    if (adv.status === "done") reply = { ...adv.session.result!.response, outputType: adv.session.result!.outputType };
    else expect(adv.status).toBe("running");
  }
  session = await loadPlanningSession(world.mem, first.planning?.sessionId ?? first.messageId);
  return { invocations, final: reply, session, chat: handler, db, modelCalls: (transport as any).requests.length };
}

let infoSpy: any;
beforeEach(() => {
  process.env.CRON_SECRET = "replay-test-secret"; process.env.ENABLE_MOCK_PROVIDER = "true"; (process.env as any).NODE_ENV = "test"; process.env.VERCEL_ENV = "development"; process.env.TREG_LIVE = "true"; process.env.TREG_TOKEN = "replay-token";
  vi.stubEnv("JOB_MAX_POINTS_CAP", "");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-27T12:00:00Z"));
  resetProviderBalanceCacheForTesting(); setProviderBalanceForTesting(50); setProviderAdapterForTesting(defaultTregAdapter);
  resetExplorationMemoryForTesting();
  world.mem.reset();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  setRowAdvisorForTesting(async (given) => ({ verdicts: new Map(given.rows.map((row) => [row.index, { verdict: "match", reasonAr: "" }])) as any, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, model: "stub", latencyMs: 0 }, failure: null } as any));
});
afterEach(() => { setRowAdvisorForTesting(null); vi.useRealTimers(); setProviderAdapterForTesting(null); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); resetProviderBalanceCacheForTesting(); });

describe("planning sessions: multi-stage missions planned through several resumed invocations", () => {
  const missions: Array<{ name: string; make: () => ReplayCase; stages: number }> = [
    { name: "companies and their e-mails (P10)", make: () => caseOf("P10"), stages: 2 },
    { name: "comments on the videos of a topic (A)", make: () => caseOf("A"), stages: 2 },
    { name: "the official channel of an entity", make: officialChannel, stages: 1 },
  ];

  for (const m of missions) {
    it(`${m.name}: each invocation stays under 45 s, the session resumes, and the card's stages add up`, async () => {
      const c = m.make();
      const r = await planThroughSession(c);
      // several invocations (the chat request and then the page's steps), none near the 60 s function limit
      expect(r.invocations.length, `invocations ${r.invocations.join(", ")}`).toBeGreaterThanOrEqual(m.stages > 1 ? 2 : 1);
      for (const ms of r.invocations) expect(ms).toBeLessThan(45_000);
      expect(PLANNING_STEP_DEADLINE_MS).toBeLessThan(45_000);
      // the ending is a card, never «غير متاحة»
      expect(r.final.outputType).toBe("propose_plan");
      expect(JSON.stringify(r.final.contentAr ?? "")).not.toContain("غير متاحة");
      const quote = r.final.planQuote;
      const item = quote.items[0];
      const stored = item.params[MODEL_PLAN_PARAM];
      expect(stored.steps).toHaveLength(m.stages);
      // ONE source of truth: the delivered rows of the stored stages are the card's total, the item's target and the quote's target
      const stages = stored.stages as Array<{ effVolume: number; deliver: boolean }>;
      expect(stages).toHaveLength(m.stages);
      expect(deliveredTotalOf(stages)).toBe(item.targetVolumeMax);
      expect(item.targetVolumeMax).toBeGreaterThanOrEqual(1);
      // the session is closed and keeps the answer, the conversation carries the card, and no provider was called
      expect(r.session.status).toBe("done");
      expect(r.session.state).toBeNull();
      expect(r.session.result.outputType).toBe("propose_plan");
      expect(world.stats.realCalls).toBe(0);
      expect(world.stats.unserved).toEqual([]);
    });
  }

  it("the planner's steps are written as they happen (the panel reads them): one event per tool call, spread over the invocations", async () => {
    const r = await planThroughSession(caseOf("P10"));
    const calls = world.mem.rows("exploration_calls");
    expect(calls.length).toBeGreaterThan(2);
    expect(r.invocations.length).toBeGreaterThanOrEqual(2);
    const times = calls.map((row: any) => Date.parse(row.created_at ?? row.createdAt ?? "")).filter((t: number) => Number.isFinite(t));
    if (times.length > 1) expect(Math.max(...times) - Math.min(...times)).toBeGreaterThan(MODEL_STEP_MS);
  });

  it("a planning budget spent ends in ONE clear question or explanation, never «غير متاحة»", async () => {
    // a model that only ever searches: the turn budget runs out, and the customer gets what was found and one question
    const endless = Array.from({ length: PLANNING_MAX_TURNS + 4 }, (_, i) => search("x", ["user", "posts", String(i)]));
    const r = await planThroughSession(caseOf("L1"), { script: endless });
    expect(r.final.outputType).not.toBe("propose_plan");
    const text = String(r.final.contentAr ?? "");
    expect(text.length).toBeGreaterThan(10);
    expect(text).not.toContain("غير متاحة");
    expect(text).toMatch(/[؟?]/);
    expect(r.session.status).toBe("done");
    expect(r.modelCalls).toBeLessThanOrEqual(PLANNING_MAX_TURNS);
  });

  it("a model that answers in words in the middle of a session ends the session with that one question", async () => {
    const r = await planThroughSession(caseOf("P15"));
    expect(r.final.outputType).toBe("answer_question");
    expect(r.session.status).toBe("done");
  });

  it("without the table the chat plans in one request, as before (nothing is stored)", async () => {
    const c = caseOf("L1");
    const db: any = createChatDb();
    const handler = new ChatHandler(db);
    (handler as any).llm.executeTurn = vi.fn(async () => { throw new Error("no"); });
    handler.modelPlanner = { transport: createScriptedTransport(c.script as any, { model: "recorded" }), client: world.mem, today: () => new Date("2026-10-27T12:00:00Z") };
    world.resetJob({ slug: "x", endpointId: "x", params: {}, target: 1, unitPrice: 1 });
    world.mem.setMissing([PLANNING_SESSIONS_TABLE]);
    world.installFetch(c.fixtures);
    await db.createRow({ tableId: "conversations", rowId: "conv_missing", data: { userId: "user_replay", title: "x", status: "active", totalTokens: 0 } });
    const reply = await handler.handleUserMessage({ userId: "user_replay", userEmail: ALLOWLISTED, conversationId: "conv_missing", message: c.request, userBalance: 40_000 }) as any;
    expect(reply.outputType).toBe("propose_plan");
    expect(world.mem.rows(PLANNING_SESSIONS_TABLE)).toEqual([]);
  });

  it("two callers never run the same step: the second gets «busy» while the first holds the lease", async () => {
    const c = caseOf("P10");
    const client = world.mem;
    const request = sessionRequestOf({ message: c.request, messagesContext: [], userBalance: 40_000 });
    const started = await startPlanningSession(client, { id: "session_lease_1", userId: "user_replay", conversationId: "conv_lease", userMsgId: "u1", assistantMsgId: "a1", request });
    expect(started.ok).toBe(true);
    const row = world.mem.rows(PLANNING_SESSIONS_TABLE)[0];
    row.lease_until = new Date(Date.now() + 30_000).toISOString();
    const db: any = createChatDb();
    const adv = await advancePlanningSession({ client, tables: db, config: { transport: createScriptedTransport([], { model: "recorded" }), client, today: () => new Date() } as any, session: row });
    expect(adv.status).toBe("busy");
    expect(adv.steps).toBe(0);
  });

  it("the background driver continues a session nobody stepped for a while, and leaves a fresh one alone", async () => {
    const c = caseOf("P10");
    const db: any = createChatDb();
    const handler = new ChatHandler(db);
    (handler as any).llm.executeTurn = vi.fn(async () => { throw new Error("no"); });
    const transport = createScriptedTransport(c.script.map((content) => () => { tick(MODEL_STEP_MS); return content; }) as any, { model: "recorded" });
    handler.modelPlanner = { transport, client: world.mem, today: () => new Date("2026-10-27T12:00:00Z") };
    world.resetJob({ slug: "x", endpointId: "x", params: {}, target: 1, unitPrice: 1 });
    world.installFetch(c.fixtures);
    const served = globalThis.fetch;
    vi.stubGlobal("fetch", async (...args: Parameters<typeof fetch>) => { tick(SOURCE_STEP_MS); return served(...args); });
    await db.createRow({ tableId: "conversations", rowId: "conv_driver", data: { userId: "user_replay", title: "x", status: "active", totalTokens: 0 } });
    const first = await handler.handleUserMessage({ userId: "user_replay", userEmail: ALLOWLISTED, conversationId: "conv_driver", message: c.request, userBalance: 40_000 }) as any;
    expect(first.outputType).toBe("planning_pending");
    const id = first.planning.sessionId;
    // fresh: the page is still stepping it
    expect((await resumeStalePlanningSessions({ client: world.mem, tables: db, config: handler.modelPlanner!, nowMs: Date.now() })).considered).toBe(0);
    // the page was closed: the driver steps it until it is done (each call inside the invocation limit)
    let done = false;
    for (let i = 0; i < 6 && !done; i++) {
      tick(PLANNING_STEP_DEADLINE_MS);
      const before = Date.now();
      const out = await resumeStalePlanningSessions({ client: world.mem, tables: db, config: handler.modelPlanner!, nowMs: Date.now() });
      expect(Date.now() - before).toBeLessThan(45_000);
      done = (await loadPlanningSession(world.mem, id))?.status === "done";
      if (!done) expect(out.considered).toBeLessThanOrEqual(1);
    }
    expect(done).toBe(true);
    const saved = (await loadPlanningSession(world.mem, id))!;
    expect(saved.result?.outputType).toBe("propose_plan");
  });

  it("a request with only a catalog answer in words (no tool call) is one invocation", async () => {
    const r = await planThroughSession(caseOf("P7"));
    expect(r.invocations).toHaveLength(1);
    expect(r.final.outputType).toBe("answer_question");
    void say;
  });
});
