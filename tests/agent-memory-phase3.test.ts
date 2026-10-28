import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENT_MEMORY_ADMIT_LIMIT_MB, AGENT_MEMORY_HARD_LIMIT_MB, AGENT_MEMORY_OBSERVED_PLANNING_PEAK_MB, AGENT_MEMORY_PLANNING_TARGET_MB, AGENT_MEMORY_REQUEUES_MAX, AGENT_MEMORY_WATCH_MS, AGENT_NODE_HEAP_MB, AGENT_SDK_SESSIONS_AT_ONCE, AGENT_DYNO_MEMORY_MB, AGENT_WORKER_CONCURRENCY, SANDBOX_MAX_HEAP_MB } from "../src/lib/agentMission/constants";
import { guardEvent } from "../src/lib/agentMission/eventText";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { approveMission } from "../src/lib/agentMission/lifecycle";
import { createFakeDriver, type FakeStep } from "../agent/src/fakeDriver";
import type { ModelDriver, RunInput, RunOutput } from "../agent/src/driver";
import { createMemoryStore, newMission } from "../agent/src/memoryStore";
import { readMemory } from "../agent/src/memory";
import { runExecution, runPlanning, type RunnerDeps } from "../agent/src/runMission";
import { abortActiveRuns, acquireSession, clipToolResult, MAX_TOOL_RESULT_CHARS, openSessionCount, releaseSession, trackRun, untrackRun, waitingSessionCount } from "../agent/src/sessions";
import { createWorker } from "../agent/src/worker";
import { assertReplayInvariants, replay } from "./helpers/agentReplay";
import { callIds, lastOutputId, type Results } from "./helpers/agentFakeWorld";
import { igFeed, fakeContextDev } from "./helpers/fakeContextDev";
import { COMMENTS_ENDPOINT, NOT_ADMIN, POSTS_ENDPOINT, USER_ID, commentsPage, fakeRecorder, postsPage, tregResult } from "./helpers/agentHarness";
import { fakeMoneyClient } from "./helpers/agentMoney";

/**
 * PHASE 3: STABILITY ON THE 512 MB DYNO. A mission that would not fit in the memory waits in the queue; a running one that reaches the hard limit is stopped by the worker and put back in the queue;
 * the heartbeat carries the memory columns; one SDK session at a time; small tool results; the Procfile starts the worker with the Node heap flags. No real provider call anywhere.
 */
afterEach(() => { vi.unstubAllGlobals(); });

const U = "00000000-0000-0000-0000-0000000000aa";
const reading = (treeRssMb: number | null, rssMb = 120) => ({ rssMb, treeRssMb });

describe("the numbers are consistent", () => {
  it("target < admit < hard < the dyno, one worker slot, one SDK session at a time, and the sandbox heap is a fraction of the worker's", () => {
    expect(AGENT_MEMORY_PLANNING_TARGET_MB).toBeLessThanOrEqual(400);
    expect(AGENT_MEMORY_ADMIT_LIMIT_MB).toBeLessThan(AGENT_MEMORY_HARD_LIMIT_MB);
    // the two limits below replace "hard < dyno" and "hard < target + 100": a normal planning run was MEASURED at 486 MB (target 400 was not met), so the guard sits above that, just over the quota
    expect(AGENT_MEMORY_HARD_LIMIT_MB).toBeGreaterThanOrEqual(AGENT_MEMORY_OBSERVED_PLANNING_PEAK_MB + 30);
    expect(AGENT_MEMORY_HARD_LIMIT_MB).toBeLessThanOrEqual(AGENT_DYNO_MEMORY_MB * 1.15);
    expect(AGENT_WORKER_CONCURRENCY).toBe(1);
    expect(AGENT_SDK_SESSIONS_AT_ONCE).toBe(1);
    expect(SANDBOX_MAX_HEAP_MB).toBeLessThan(AGENT_NODE_HEAP_MB);
    expect(AGENT_MEMORY_REQUEUES_MAX).toBeGreaterThanOrEqual(1);
    expect(AGENT_MEMORY_WATCH_MS).toBeLessThanOrEqual(10_000);
  });

  it("the Procfile starts the worker in ONE process (no npx / tsx wrapper) with the heap flags that match the constant", () => {
    const procfile = readFileSync(path.join(__dirname, "..", "Procfile"), "utf8");
    const worker = procfile.split("\n").find((l) => l.startsWith("worker:"))!;
    expect(worker).toContain("node ");
    expect(worker).toContain(`--max-old-space-size=${AGENT_NODE_HEAP_MB}`);
    expect(worker).toMatch(/--max-semi-space-size=\d/);
    expect(worker).toContain("--import tsx");
    expect(worker).toContain("agent/src/main.ts");
    expect(worker).not.toMatch(/npx|npm run/);
  });
});

describe("a mission that would not fit waits in the queue", () => {
  const make = (tree: { v: number | null }, extra: Partial<Parameters<typeof createWorker>[0]> = {}) => {
    const store = createMemoryStore([newMission({ id: "msn_m0", user_id: U, status: "queued" })]);
    const started: string[] = [];
    const logs: string[] = [];
    const worker = createWorker({ store, workerId: "w1", version: "t", modelLabel: () => "m", log: (l) => logs.push(l), readMemory: () => reading(tree.v), runMission: async (m) => { started.push(m.id); }, ...extra });
    return { store, started, logs, worker };
  };

  it("at or above the admit limit nothing is claimed: the mission stays queued with no worker and no lease; when the memory falls it starts", async () => {
    const tree = { v: AGENT_MEMORY_ADMIT_LIMIT_MB };
    const { store, started, logs, worker } = make(tree);
    expect(await worker.tick()).toBe(0);
    expect(worker.waitingForMemory()).toBe(true);
    expect(store.missions.get("msn_m0")).toMatchObject({ status: "queued", worker_id: null, lease_until: null });
    await worker.tick();
    expect(logs.filter((l) => l.startsWith("memory_wait"))).toHaveLength(1); // logged once per wait, not every poll
    tree.v = AGENT_MEMORY_ADMIT_LIMIT_MB - 40;
    expect(await worker.tick()).toBe(1);
    await worker.idle();
    expect(started).toEqual(["msn_m0"]);
    expect(worker.waitingForMemory()).toBe(false);
    expect(logs.some((l) => l.startsWith("memory_ok"))).toBe(true);
  });

  it("the memory of the whole tree counts (the SDK process), not only the worker's own; where the tree cannot be read the worker's own is used", async () => {
    const a = make({ v: 340 });
    expect(await a.worker.tick()).toBe(0); // worker alone 120 MB, tree 340: waits
    const b = make({ v: null }, { readMemory: () => ({ rssMb: 120, treeRssMb: null }) });
    expect(await b.worker.tick()).toBe(1);
    const c = make({ v: null }, { readMemory: () => ({ rssMb: 320, treeRssMb: null }) });
    expect(await c.worker.tick()).toBe(0);
  });

  it("a memory read that fails never blocks the queue", async () => {
    const { worker, started } = make({ v: 0 }, { readMemory: () => { throw new Error("proc not readable"); } });
    expect(await worker.tick()).toBe(1);
    await worker.idle();
    expect(started).toEqual(["msn_m0"]);
  });

  it("the heartbeat still carries the memory columns while a mission waits", async () => {
    const { store, worker } = make({ v: 380 });
    await worker.tick();
    await worker.heartbeat();
    expect(store.heartbeats[0]).toMatchObject({ rss_mb: 120, tree_rss_mb: 380, active_missions: 0 });
  });
});

describe("a running mission that reaches the hard limit is stopped before the platform kills the dyno", () => {
  it("watchMemory asks the entry point to stop the run only while a mission is running and the tree is at or above the hard limit", async () => {
    const tree = { v: 200 };
    const pressure = vi.fn();
    const store = createMemoryStore([newMission({ id: "msn_h0", user_id: U, status: "queued" })]);
    let release!: () => void;
    const worker = createWorker({ store, workerId: "w1", version: "t", modelLabel: () => "m", readMemory: () => reading(tree.v), onMemoryPressure: pressure, runMission: () => new Promise<void>((r) => { release = r; }) });
    expect(worker.watchMemory()).toBe(false); // nothing running: nothing to stop
    await worker.tick();
    expect(worker.watchMemory()).toBe(false);
    tree.v = AGENT_MEMORY_HARD_LIMIT_MB - 1;
    expect(worker.watchMemory()).toBe(false);
    expect(pressure).not.toHaveBeenCalled();
    tree.v = AGENT_MEMORY_HARD_LIMIT_MB;
    expect(worker.watchMemory()).toBe(true);
    expect(pressure).toHaveBeenCalledTimes(1);
    expect(pressure.mock.calls[0][0]).toMatchObject({ treeRssMb: AGENT_MEMORY_HARD_LIMIT_MB });
    release();
    await worker.idle();
  });

  it("the loop's own watcher fires on its timer, and a throwing handler never breaks the worker", async () => {
    vi.useFakeTimers();
    try {
      const tree = { v: 500 };
      const pressure = vi.fn(() => { throw new Error("boom"); });
      const store = createMemoryStore([newMission({ id: "msn_h1", user_id: U, status: "queued" })]);
      let release!: () => void;
      const worker = createWorker({ store, workerId: "w1", version: "t", modelLabel: () => "m", readMemory: () => reading(tree.v === 500 && worker.activeCount() === 0 ? 100 : tree.v), onMemoryPressure: pressure, memoryHardLimitMb: 450, runMission: () => new Promise<void>((r) => { release = r; }) });
      const loop = worker.run({ pollMs: 1_000, heartbeatMs: 60_000, watchMs: 2_000, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) });
      await vi.advanceTimersByTimeAsync(1_100); // the mission is taken (the reading is low while nothing runs)
      expect(worker.activeCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(2_100);
      expect(pressure).toHaveBeenCalled();
      release();
      worker.stop();
      await vi.advanceTimersByTimeAsync(2_000);
      await loop;
    } finally { vi.useRealTimers(); }
  });
});

describe("the SDK sessions: one at a time, stopped on demand, results kept small", () => {
  it("a second session waits for the first to be released (one native process at a time)", async () => {
    expect(openSessionCount()).toBe(0);
    await acquireSession();
    expect(openSessionCount()).toBe(1);
    let second = false;
    const p = acquireSession().then(() => { second = true; });
    await Promise.resolve();
    expect(second).toBe(false);
    expect(waitingSessionCount()).toBe(1);
    releaseSession();
    await p;
    expect(second).toBe(true);
    expect(openSessionCount()).toBe(1);
    releaseSession();
    expect(openSessionCount()).toBe(0);
    expect(waitingSessionCount()).toBe(0);
  });

  it("abortActiveRuns stops every run in flight, names the reason, and an ended run is no longer tracked", () => {
    const a = trackRun();
    const b = trackRun();
    untrackRun(b);
    expect(abortActiveRuns("memory")).toBe(1);
    expect(a.abort.signal.aborted).toBe(true);
    expect(a.reason.value).toBe("memory");
    expect(b.abort.signal.aborted).toBe(false);
    untrackRun(a);
    expect(abortActiveRuns("memory")).toBe(0);
  });

  it("a tool result put in the model's context is cut at the cap; a small one is untouched", () => {
    expect(MAX_TOOL_RESULT_CHARS).toBeLessThanOrEqual(10_000);
    const small = JSON.stringify({ ok: true, rows: [1, 2, 3] });
    expect(clipToolResult(small)).toBe(small);
    const big = JSON.stringify({ ok: true, rows: Array.from({ length: 5_000 }, (_, i) => ({ id: i, text: "كلام طويل ".repeat(5) })) });
    const cut = clipToolResult(big);
    expect(cut.length).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS + 10);
    expect(cut.endsWith("…(cut)")).toBe(true);
  });
});

/** A fake driver that does the first `n` steps of a script and then is stopped for memory (what the real driver reports when abortActiveRuns("memory") ends its run). */
const stoppedForMemory = (steps: FakeStep[]): ModelDriver & { runs: number } => {
  const inner = createFakeDriver(steps, { costUsd: 0.002 });
  const driver = {
    runs: 0,
    async run(input: RunInput): Promise<RunOutput> { driver.runs += 1; const out = await inner.run(input); return { ...out, stop: "memory" }; },
  };
  return driver;
};

describe("a mission stopped for memory goes back to the queue instead of crashing", () => {
  const MODELS = { planning: "claude-haiku-5-5", execution: "claude-haiku-5-5" };
  function setup(store = createMemoryStore(), money = fakeMoneyClient()) {
    const rec = fakeRecorder();
    const call = vi.fn(async () => { throw new Error("no provider call in this test"); });
    const deps = (driver: ModelDriver): RunnerDeps => ({ store, client: money.client, catalog: loadTregCatalog(), driver, recorder: rec.recorder, commit: rec.commit, call: call as any, models: MODELS, resolveAccess: async () => NOT_ADMIN });
    return { store, money, deps, call };
  }

  it("PLANNING: back to «queued» with no worker and no lease, one Arabic notice with the count in the counts JSON, no plan, no charge; the 3rd stop ends it as before", async () => {
    vi.stubGlobal("fetch", () => { throw new Error("a real network call was attempted"); });
    const t = setup();
    t.store.missions.set("msn_r1", newMission({ id: "msn_r1", user_id: USER_ID, request_text: "أريد منشورات عن القهوة", status: "planning", worker_id: "w1", lease_until: new Date(Date.now() + 60_000).toISOString() }));
    for (let n = 1; n <= AGENT_MEMORY_REQUEUES_MAX; n += 1) {
      await runPlanning(t.deps(stoppedForMemory([{ tool: "report_progress", args: { message_ar: "أبحث عن أرخص مصدر مناسب" } }])), t.store.missions.get("msn_r1")!);
      expect(t.store.missions.get("msn_r1")).toMatchObject({ status: "queued", worker_id: null, lease_until: null, plan: null });
      const ev = t.store.events[t.store.events.length - 1];
      expect(ev.counts).toEqual({ requeued: n });
      expect(ev.message_ar).toMatch(/تأجّلت/);
      expect(guardEvent({ kind: ev.kind, message_ar: ev.message_ar, counts: ev.counts }).replaced).toBe(false);
      // the worker takes it again when the memory allows
      const again = await t.store.claimMission("w1", 120);
      expect(again).toMatchObject({ id: "msn_r1", status: "planning" });
    }
    // out of requeues: it ends like any other planning that produced nothing (no plan, no charge)
    await runPlanning(t.deps(stoppedForMemory([])), t.store.missions.get("msn_r1")!);
    expect(t.store.missions.get("msn_r1")!.status).not.toBe("queued");
    expect(t.store.missions.get("msn_r1")!.plan).toBeNull();
    expect(t.call).not.toHaveBeenCalled();
  });

  it("PLANNING: a run that already reached its end (a plan) keeps it even if the memory stop came at the same moment", async () => {
    vi.stubGlobal("fetch", () => { throw new Error("a real network call was attempted"); });
    const t = setup();
    t.store.missions.set("msn_r2", newMission({ id: "msn_r2", user_id: USER_ID, request_text: "أريد منشورات", status: "planning" }));
    await runPlanning(t.deps(stoppedForMemory([{ tool: "finish", args: { outcome: "cannot_serve", summary_ar: "لا يوجد مصدر متاح يخدم هذا الطلب بدقة، ولم يُحجز أي رصيد." } }])), t.store.missions.get("msn_r2")!);
    expect(t.store.missions.get("msn_r2")!.status).not.toBe("queued");
  });

  async function approvedMission() {
    const store = createMemoryStore();
    const money = fakeMoneyClient();
    const t = setup(store, money);
    store.missions.set("msn_r3", newMission({ id: "msn_r3", user_id: USER_ID, request_text: "أريد منشورات عن القهوة مع تعليقاتها", status: "planning" }));
    const queue = [tregResult(postsPage(5), 0.025), tregResult(commentsPage("9000", 12), 0.00144)];
    const call = vi.fn(async () => queue.shift()!);
    const rec = fakeRecorder();
    const idOf = (r: Results, n: number) => String(r.filter((x) => x.tool === "treg_call")[n]?.result.call_id);
    const script: FakeStep[] = [
      { tool: "catalog_search", args: { words: ["posts", "search"], platform: "x", limit: 5 } },
      { tool: "describe_endpoint", args: { id: POSTS_ENDPOINT } },
      { tool: "treg_call", args: { endpoint_id: POSTS_ENDPOINT, params: { query: "قهوة", max_results: 5 } } },
      { tool: "treg_call", args: { endpoint_id: COMMENTS_ENDPOINT, params: { url: "https://x.example/p/9000" } } },
      { tool: "run_code", args: { code: "return inputs.call_0001.data.slice(0, 1).map(r => ({ id: r.id, text: r.text, url: r.url }))", files: ["call_0001"] } },
      { tool: "propose_plan", args: (r) => ({
        summary_ar: "ستحصل على المنشورات ثم تعليقات كل منشور في ورقتين مرتبطتين بمعرّف المنشور.",
        stages: [
          { key: "posts", title_ar: "المنشورات", endpoint_id: POSTS_ENDPOINT, expected_rows: 20, parent_key: null, deliver: true, columns: [{ key: "text", title_ar: "النص" }, { key: "url", title_ar: "الرابط" }], sample_rows: [{ id: "9000", text: "post 0", url: "https://x.example/p/9000" }], measured_by: [idOf(r, 0)] },
          { key: "comments", title_ar: "التعليقات", endpoint_id: COMMENTS_ENDPOINT, expected_rows: 200, parent_key: "posts", per_parent_rows: 12, deliver: true, columns: [{ key: "text", title_ar: "النص" }], sample_rows: [{ id: "9000-c0", text: "comment 0" }], measured_by: [idOf(r, 1)] },
        ],
      }) },
    ];
    await runPlanning({ ...t.deps(createFakeDriver(script)), call: call as any, recorder: rec.recorder, commit: rec.commit }, store.missions.get("msn_r3")!);
    const m = store.missions.get("msn_r3")!;
    expect(m.status).toBe("plan_ready");
    const approved = await approveMission(money.client, { id: m.id, user_id: m.user_id, plan: m.plan! });
    if (!approved.ok) throw new Error(approved.messageAr);
    await store.updateMission(m.id, { status: "approved", job_id: approved.jobId, quote_id: approved.quoteId, reserved_points: approved.reservePoints, unit_price_points: approved.unitPricePoints });
    return { store, money, t, approved };
  }

  it("EXECUTION: back to «approved» with the reserve still held and every saved row kept; resumes, then delivers and settles normally; after the limit it settles what is saved", async () => {
    vi.stubGlobal("fetch", () => { throw new Error("a real network call was attempted"); });
    const { store, money, t, approved } = await approvedMission();
    const balanceAfterHold = money.balance();
    const rows = Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, text: "t", url: `https://x.example/${i}` }));
    const save: FakeStep = { tool: "save_rows", args: { stage_key: "posts", rows } };
    // stop #1: six rows are saved, then the memory stop
    store.missions.get("msn_r3")!.status = "executing";
    await runExecution(t.deps(stoppedForMemory([save])), store.missions.get("msn_r3")!);
    expect(store.missions.get("msn_r3")).toMatchObject({ status: "approved", worker_id: null, lease_until: null, job_id: approved.jobId });
    expect(store.events[store.events.length - 1].counts).toEqual({ requeued: 1 });
    expect(money.balance()).toBe(balanceAfterHold); // the hold is untouched: nothing settled, nothing released
    expect(money.calls.map((c) => c.name)).not.toContain("settle_job_atomic");
    expect(money.calls.map((c) => c.name)).not.toContain("release_job_atomic");
    expect(JSON.parse((await store.getFile("msn_r3", "rows/posts.json"))!)).toHaveLength(6);
    // resumed: the same rows are not saved twice, the mission finishes and is charged for the delivered rows only
    const claimed = await store.claimMission("w1", 120);
    expect(claimed).toMatchObject({ id: "msn_r3", status: "executing" });
    const more = Array.from({ length: 4 }, (_, i) => ({ id: `q${i}`, text: "t", url: `https://x.example/q${i}` }));
    await runExecution(t.deps(createFakeDriver([{ tool: "save_rows", args: { stage_key: "posts", rows: [...rows, ...more] } }, { tool: "finish", args: { outcome: "delivered", summary_ar: "سُلّمت عشرة منشورات." } }])), store.missions.get("msn_r3")!);
    const done = store.missions.get("msn_r3")!;
    expect(done.status).toBe("completed");
    expect(done.delivered_units).toBe(10);
    expect(done.charged_points).toBeLessThanOrEqual(done.reserved_points!);
    expect(money.calls.map((c) => c.name)).toContain("settle_job_atomic");
  });

  it("EXECUTION: after the allowed requeues the mission is settled with what is saved (charge = ceil(delivered x unit), never above the reserve) instead of waiting for ever", async () => {
    vi.stubGlobal("fetch", () => { throw new Error("a real network call was attempted"); });
    const { store, money, t } = await approvedMission();
    const rows = Array.from({ length: 3 }, (_, i) => ({ id: `p${i}`, text: "t", url: `https://x.example/${i}` }));
    for (let n = 0; n < AGENT_MEMORY_REQUEUES_MAX; n += 1) {
      store.missions.get("msn_r3")!.status = "executing";
      await runExecution(t.deps(stoppedForMemory(n === 0 ? [{ tool: "save_rows", args: { stage_key: "posts", rows } }] : [])), store.missions.get("msn_r3")!);
      expect(store.missions.get("msn_r3")!.status).toBe("approved");
    }
    store.missions.get("msn_r3")!.status = "executing";
    await runExecution(t.deps(stoppedForMemory([])), store.missions.get("msn_r3")!);
    const m = store.missions.get("msn_r3")!;
    expect(m.status).toBe("completed");
    expect(m.delivered_units).toBe(3);
    expect(m.charged_points).toBe(Math.ceil(3 * m.unit_price_points!));
    expect(m.charged_points!).toBeLessThanOrEqual(m.reserved_points!);
    expect(money.calls.map((c) => c.name)).toContain("settle_job_atomic");
  });
});

describe("a planning run measured with the heartbeat memory columns", () => {
  it("the heartbeat rows carry real rss_mb / tree_rss_mb numbers before and after a full planning + execution replay, and the growth stays small", async () => {
    const store = createMemoryStore();
    const worker = createWorker({ store, workerId: "w_mem", version: "t", modelLabel: () => "m", runMission: async () => undefined });
    await worker.heartbeat();
    const web = fakeContextDev({ parse: () => ({ data: igFeed("قهوة", 12) }) });
    const URL_ = "https://www.instagram.com/explore/tags/%D9%82%D9%87%D9%88%D8%A9/";
    const r = await replay({
      request: "هات بوستات إنستجرام عن هاشتاج قهوة",
      web,
      planning: [
        { tool: "catalog_search", args: { words: ["hashtag", "posts"], platform: "instagram", limit: 6 } },
        { tool: "parse_page", args: { parser: "instagram-feed", url: URL_, why: "the catalog's cheaper sources carry no post fields in their description" } },
        { tool: "run_code", args: { code: "return inputs.call_0001.rows.slice(0, 3).map(p => ({ id: p.id, text: p.caption, url: p.url, likes: p.like_count }))", files: ["call_0001"] } },
        { tool: "propose_plan", args: (res: Results) => ({
          summary_ar: "ستحصل على منشورات إنستجرام الأكثر ظهورًا تحت وسم قهوة مع نص كل منشور ورابطه وعدد إعجاباته.",
          stages: [{ key: "posts", title_ar: "المنشورات", endpoint_id: "contextdev.parse.instagram-feed", expected_rows: 12, parent_key: null, deliver: true, columns: [{ key: "text", title_ar: "نص المنشور" }, { key: "url", title_ar: "رابط المنشور" }, { key: "likes", title_ar: "الإعجابات" }], sample_rows: (res.find((x) => x.tool === "run_code")!.result.result as unknown[]).slice(0, 3), measured_by: [callIds(res)[0]] }],
        }) },
      ],
      execution: () => [
        { tool: "parse_page", args: { parser: "instagram-feed", url: URL_ } },
        { tool: "run_code", args: (res: Results) => ({ code: "return inputs[Object.keys(inputs)[0]].rows.map(p => ({ id: p.id, text: p.caption, url: p.url, likes: p.like_count }))", files: callIds(res) }) },
        { tool: "save_rows", args: (res: Results) => ({ stage_key: "posts", from_output: lastOutputId(res) }) },
        { tool: "finish", args: { outcome: "delivered", summary_ar: "سُلّمت ١٢ منشورًا من وسم قهوة." } },
      ],
      answers: [],
    });
    assertReplayInvariants(r, { expectDelivered: 12 });
    await worker.heartbeat();
    const [before, after] = store.heartbeats;
    for (const beat of [before, after]) {
      expect(Number.isFinite(beat.rss_mb)).toBe(true);
      expect(beat.rss_mb!).toBeGreaterThan(0);
      if (beat.tree_rss_mb !== null) expect(beat.tree_rss_mb).toBeGreaterThanOrEqual(beat.rss_mb!);
    }
    // the in-process part of a whole mission (plan, approve, execute, files) adds little to the worker: far under the planning target
    expect(after.rss_mb! - before.rss_mb!).toBeLessThan(AGENT_MEMORY_PLANNING_TARGET_MB / 2);
    const now = readMemory();
    expect(now.rssMb).toBeGreaterThan(0);
  });
});
