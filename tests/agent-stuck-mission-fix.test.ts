import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENT_BUCKET_ALLOWED_MIME, AGENT_ERROR_REQUEUES_MAX, AGENT_MEMORY_ADMIT_LIMIT_MB, AGENT_MEMORY_HARD_LIMIT_MB, AGENT_MEMORY_OBSERVED_PLANNING_PEAK_MB, AGENT_MEMORY_HIGHEST_IDLE_SEEN_MB, AGENT_MEMORY_RECYCLE_AFTER_MS, AGENT_MEMORY_RECYCLE_MIN_UPTIME_MS, AGENT_PHASE_STARTS_MAX, AGENT_SDK_CHILD_PEAK_MB, AGENT_STALL_AFTER_MS, MISSION_INTERNAL_COUNT_KEYS } from "../src/lib/agentMission/constants";
import { internalCountsLineAr, isInternalEvent } from "../src/lib/agentMission/eventText";
import { customerMissionView, SLOW_PLANNING_AR, STALLED_PLANNING_AR, type EventForCustomer, type MissionRowForCustomer } from "../src/lib/agentMission/customerView";
import { checkCustomerText } from "../src/lib/agentMission/text";
import { approveMission } from "../src/lib/agentMission/lifecycle";
import { sessionRestriction } from "../src/lib/agentMission/sources";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { createFakeDriver, type FakeStep } from "../agent/src/fakeDriver";
import type { ModelDriver } from "../agent/src/driver";
import { createMemoryStore, newMission } from "../agent/src/memoryStore";
import { readRunState, updateRunState } from "../agent/src/runState";
import { runMissionSafely, runPlanning, type RunnerDeps } from "../agent/src/runMission";
import { buildTools } from "../agent/src/tools";
import { createWorker } from "../agent/src/worker";
import { assertReplayInvariants, pagedAnswers, replay } from "./helpers/agentReplay";
import { callIds, lastOutputId, pagedCalls, tregResult, xPage, type Results } from "./helpers/agentFakeWorld";
import { COMMENTS_ENDPOINT, NOT_ADMIN, POSTS_ENDPOINT, USER_ID, commentsPage, fakeRecorder, makeHarness, postsPage } from "./helpers/agentHarness";
import { fakeMoneyClient } from "./helpers/agentMoney";
import { aboutWords, firstOutputId } from "./helpers/agentRelevance";

/**
 * THE STUCK-MISSION FIX. Mission msn_480a44f90e1784edbc94 stayed «planning» for ever: the memory requeue wrote `memory_requeues.txt` as text/plain, the bucket refuses that type, the exception reached the
 * worker's catch which only wrote the error field, and every heartbeat renewed the lease of ALL missions of the worker id. These tests would have failed on that code: the memory store now enforces the
 * bucket's real mime rules, a run that throws leaves no leased mission, a heartbeat renews only what the worker runs, and an orphan is taken over.
 */
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
const MODELS = { planning: "claude-haiku-5-5", execution: "claude-haiku-5-5" };
const reading = (treeRssMb: number | null, rssMb = 150) => ({ rssMb, treeRssMb });
const U = "00000000-0000-0000-0000-0000000000aa";

describe("the real bucket's mime rules are enforced in the tests", () => {
  it("the list in the code is the list of the bucket's SQL, and the in-memory store refuses text/plain with the bucket's own message", async () => {
    const sql = readFileSync(path.join(__dirname, "..", "docs/proposals/agent-worker/03_agent_storage.sql"), "utf8");
    const fromSql = [...sql.slice(sql.indexOf("ARRAY[")).matchAll(/'([a-z0-9./+-]+)'/g)].map((m) => m[1]);
    expect([...AGENT_BUCKET_ALLOWED_MIME].sort()).toEqual(fromSql.sort());
    const store = createMemoryStore();
    await expect(store.putFile("m1", "memory_requeues.txt", "1", "text/plain")).rejects.toThrow("upload: mime type text/plain is not supported");
    for (const type of AGENT_BUCKET_ALLOWED_MIME) await store.putFile("m1", `f_${type.length}`, "x", type);
    expect(store.files.size).toBe(AGENT_BUCKET_ALLOWED_MIME.length);
  });

  it("every putFile of the worker's source writes a type the bucket accepts (a text/plain note cannot come back)", () => {
    const dir = path.join(__dirname, "..", "agent", "src");
    const seen: string[] = [];
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts"))) {
      const text = readFileSync(path.join(dir, f), "utf8");
      for (const m of text.matchAll(/putFile\([^;\n]*?,\s*"([a-z]+\/[a-z0-9.+-]+)"\)/g)) seen.push(m[1]);
    }
    expect(seen.length).toBeGreaterThan(3);
    for (const type of seen) expect(AGENT_BUCKET_ALLOWED_MIME as readonly string[]).toContain(type);
    expect(readFileSync(path.join(dir, "runMission.ts"), "utf8")).not.toContain("text/plain");
  });

  it("the note of a mission's runs is JSON, and a note that cannot be saved never breaks the mission (the in-process copy still counts)", async () => {
    const store = createMemoryStore();
    const failing = { ...store, putFile: async () => { throw new Error("storage is down"); } } as typeof store;
    const logs: string[] = [];
    await updateRunState(failing, "m9", (s) => ({ ...s, errorRequeues: 1 }), (l) => logs.push(l));
    expect((await readRunState(failing, "m9")).errorRequeues).toBe(1);
    expect(logs[0]).toContain("run_state_not_saved");
    await updateRunState(store, "m8", (s) => ({ ...s, planningStarts: 2 }));
    expect(JSON.parse((await store.getFile("m8", "run_state.json"))!)).toMatchObject({ planningStarts: 2 });
  });
});

describe("an exception in a run never leaves a mission leased", () => {
  function setup(store = createMemoryStore(), money = fakeMoneyClient()) {
    const rec = fakeRecorder();
    const notices: string[] = [];
    const call = vi.fn(async () => { throw new Error("no provider call in this test"); });
    const deps = (over: Partial<RunnerDeps> = {}): RunnerDeps => ({ store, client: money.client, catalog: loadTregCatalog(), driver: createFakeDriver([]), recorder: rec.recorder, commit: rec.commit, call: call as any, models: MODELS, resolveAccess: async () => NOT_ADMIN, notify: async (n) => { notices.push(n.kind); }, ...over });
    return { store, money, deps, notices, call };
  }
  const leased = (store: ReturnType<typeof createMemoryStore>) => [...store.missions.values()].filter((m) => (m.status === "planning" || m.status === "executing") && m.worker_id !== null).map((m) => m.id);

  it("PLANNING: back to «queued» with no worker and no lease (twice), then ONE honest Arabic message, no hold, the customer told; the error is kept for the admin", async () => {
    const t = setup();
    t.store.missions.set("msn_x1", newMission({ id: "msn_x1", user_id: USER_ID, request_text: "هات ٣٠٠ تغريدة عن محمد صلاح", status: "planning", worker_id: "w1", lease_until: new Date(Date.now() + 60_000).toISOString() }));
    const boom = t.deps({ resolveAccess: async () => { throw new Error("the account service is down"); } });
    for (let n = 1; n <= AGENT_ERROR_REQUEUES_MAX; n += 1) {
      await runMissionSafely(boom, t.store.missions.get("msn_x1")!);
      expect(t.store.missions.get("msn_x1")).toMatchObject({ status: "queued", worker_id: null, lease_until: null, error: "the account service is down" });
      expect(leased(t.store)).toEqual([]);
      expect(t.store.events[t.store.events.length - 1].counts).toEqual({ requeued: n });
      expect((await t.store.claimMission("w1", 120))?.status).toBe("planning"); // the worker takes it again
    }
    await runMissionSafely(boom, t.store.missions.get("msn_x1")!);
    const m = t.store.missions.get("msn_x1")!;
    expect(m).toMatchObject({ status: "failed", worker_id: null, lease_until: null, job_id: null, plan: null });
    expect(leased(t.store)).toEqual([]);
    const last = t.store.events[t.store.events.length - 1];
    expect(last).toMatchObject({ kind: "result", message_ar: "تعذّر على الوكيل إعداد خطة لهذا الطلب؛ لم يُحجز أي رصيد." });
    expect(t.notices).toEqual(["failed"]);
    expect(t.money.calls.map((c) => c.name)).toEqual([]); // no money function was touched: nothing was held
  });

  it("a run that returns without leaving the mission in any state is treated the same way (a lost write cannot leave a lease nobody works on)", async () => {
    const t = setup();
    t.store.missions.set("msn_x2", newMission({ id: "msn_x2", user_id: USER_ID, request_text: "طلب", status: "planning", worker_id: "w1", lease_until: new Date(Date.now() + 60_000).toISOString() }));
    // the first write that tries to end the mission (status «failed») is lost
    const realUpdate = t.store.updateMission.bind(t.store);
    let dropped = false;
    t.store.updateMission = async (id, patch) => { if (!dropped && patch.status === "failed") { dropped = true; return; } await realUpdate(id, patch); };
    await runMissionSafely(t.deps(), t.store.missions.get("msn_x2")!);
    expect(dropped).toBe(true);
    expect(t.store.missions.get("msn_x2")!.status).toBe("queued");
    expect(leased(t.store)).toEqual([]);
  });

  /** An approved mission holding a reserve, with posts already saved. */
  async function approved() {
    const store = createMemoryStore();
    const money = fakeMoneyClient();
    const t = setup(store, money);
    store.missions.set("msn_x3", newMission({ id: "msn_x3", user_id: USER_ID, request_text: "أريد منشورات عن القهوة مع تعليقاتها", status: "planning" }));
    const queue = [tregResult(postsPage(5), 0.025), tregResult(commentsPage("9000", 12), 0.00144)];
    const idOf = (r: Results, n: number) => String(r.filter((x) => x.tool === "treg_call")[n]?.result.call_id);
    const script: FakeStep[] = [
      { tool: "catalog_search", args: { words: ["posts", "search"], platform: "x", limit: 5 } },
      { tool: "describe_endpoint", args: { id: POSTS_ENDPOINT } },
      { tool: "treg_call", args: { endpoint_id: POSTS_ENDPOINT, params: { query: "قهوة", max_results: 5 }, why: "the fixture source is the one under test" } },
      { tool: "treg_call", args: { endpoint_id: COMMENTS_ENDPOINT, params: { url: "https://x.example/p/9000" }, why: "the fixture source is the one under test" } },
      { tool: "run_code", args: { code: "return inputs.call_0001.data.slice(0, 1).map(r => ({ id: r.id, text: r.text, url: r.url }))", files: ["call_0001"] } },
      { tool: "propose_plan", args: (r) => ({ summary_ar: "ستحصل على المنشورات ثم تعليقات كل منشور في ورقتين مرتبطتين بمعرّف المنشور.", stages: [
        { key: "posts", title_ar: "المنشورات", endpoint_id: POSTS_ENDPOINT, expected_rows: 20, parent_key: null, deliver: true, columns: [{ key: "text", title_ar: "النص" }, { key: "url", title_ar: "الرابط" }], sample_rows: [{ id: "9000", text: "post 0", url: "https://x.example/p/9000" }], measured_by: [idOf(r, 0)], relevance: aboutWords(["post"]), yield_from: firstOutputId(r) },
        { key: "comments", title_ar: "التعليقات", endpoint_id: COMMENTS_ENDPOINT, expected_rows: 200, parent_key: "posts", per_parent_rows: 12, deliver: true, columns: [{ key: "text", title_ar: "النص" }], sample_rows: [{ id: "9000-c0", text: "comment 0" }], measured_by: [idOf(r, 1)] },
      ] }) },
    ];
    await runPlanning({ ...t.deps({ driver: createFakeDriver(script) }), call: (async () => queue.shift()!) as any }, store.missions.get("msn_x3")!);
    const m = store.missions.get("msn_x3")!;
    expect(m.status).toBe("plan_ready");
    const ok = await approveMission(money.client, { id: m.id, user_id: m.user_id, plan: m.plan! });
    if (!ok.ok) throw new Error(ok.messageAr);
    await store.updateMission(m.id, { status: "executing", worker_id: "w1", lease_until: new Date(Date.now() + 60_000).toISOString(), job_id: ok.jobId, quote_id: ok.quoteId, reserved_points: ok.reservePoints, unit_price_points: ok.unitPricePoints });
    return { store, money, t, ok };
  }

  it("EXECUTION: back to «approved» (twice) with the hold and the saved rows untouched; then settled through the existing functions with what is saved: charge = ceil(delivered x unit), never above the reserve, the rest released", async () => {
    vi.stubGlobal("fetch", () => { throw new Error("a real network call was attempted"); });
    const { store, money, t, ok } = await approved();
    const rows = Array.from({ length: 3 }, (_, i) => ({ id: `p${i}`, text: "post t", url: `https://x.example/${i}` }));
    await store.putFile("msn_x3", "rows/posts.json", JSON.stringify(rows), "application/json");
    const balanceAfterHold = money.balance();
    const boom = t.deps({ resolveAccess: async () => { throw new Error("the account service is down"); } });
    for (let n = 1; n <= AGENT_ERROR_REQUEUES_MAX; n += 1) {
      store.missions.get("msn_x3")!.status = "executing";
      store.missions.get("msn_x3")!.worker_id = "w1";
      await runMissionSafely(boom, store.missions.get("msn_x3")!);
      expect(store.missions.get("msn_x3")).toMatchObject({ status: "approved", worker_id: null, lease_until: null, job_id: ok.jobId });
      expect(leased(store)).toEqual([]);
      expect(money.balance()).toBe(balanceAfterHold); // the hold is untouched
      expect(money.calls.map((c) => c.name)).not.toContain("settle_job_atomic");
    }
    store.missions.get("msn_x3")!.status = "executing";
    store.missions.get("msn_x3")!.worker_id = "w1";
    await runMissionSafely(boom, store.missions.get("msn_x3")!);
    const m = store.missions.get("msn_x3")!;
    expect(m).toMatchObject({ status: "completed", delivered_units: 3, worker_id: null, lease_until: null });
    expect(m.charged_points).toBe(Math.ceil(3 * m.unit_price_points!));
    expect(m.charged_points!).toBeLessThanOrEqual(m.reserved_points!);
    expect(money.calls.map((c) => c.name)).toContain("settle_job_atomic");
    expect(t.notices).toContain("partial");
    expect(leased(store)).toEqual([]);
  });

  it("a mission whose phase has started too many times (it keeps killing its worker) ends honestly instead of looping", async () => {
    const t = setup();
    t.store.missions.set("msn_x4", newMission({ id: "msn_x4", user_id: USER_ID, request_text: "طلب", status: "planning", worker_id: "w1" }));
    await updateRunState(t.store, "msn_x4", (s) => ({ ...s, planningStarts: AGENT_PHASE_STARTS_MAX }));
    await runMissionSafely(t.deps(), t.store.missions.get("msn_x4")!);
    expect(t.store.missions.get("msn_x4")).toMatchObject({ status: "failed", worker_id: null, lease_until: null });
    expect(t.store.events[t.store.events.length - 1].message_ar).toContain("لم يُحجز أي رصيد");
  });
});

describe("the heartbeat renews only the missions the worker really runs; an orphan is taken over", () => {
  it("a mission the worker no longer runs keeps its old lease (not renewed); the one it runs is renewed", async () => {
    const store = createMemoryStore([newMission({ id: "msn_a", user_id: U, status: "queued" })]);
    store.missions.set("msn_stale", newMission({ id: "msn_stale", user_id: U, status: "planning", worker_id: "w1", lease_until: new Date(Date.now() + 5_000).toISOString() }));
    const staleBefore = store.missions.get("msn_stale")!.lease_until;
    const worker = createWorker({ store, workerId: "w1", version: "t", modelLabel: () => "m", runMission: () => new Promise(() => undefined), readMemory: () => reading(200) });
    await worker.tick();
    // claimMission takes the oldest waiting mission: msn_a (queued); msn_stale's lease is still alive so it is not claimable
    expect(worker.activeCount()).toBe(1);
    const runningBefore = store.missions.get("msn_a")!.lease_until!;
    await new Promise((r) => setTimeout(r, 5));
    await worker.heartbeat();
    expect(store.missions.get("msn_stale")!.lease_until).toBe(staleBefore);
    expect(store.missions.get("msn_a")!.lease_until! > runningBefore).toBe(true);
  });

  it("after a restart the old worker's mission is not renewed by anyone: its lease ends and the NEW worker (another id) takes it over", async () => {
    const store = createMemoryStore([newMission({ id: "msn_o1", user_id: U, status: "queued" })]);
    const first = createWorker({ store, workerId: "w_old", version: "t", modelLabel: () => "m", runMission: async () => undefined, readMemory: () => reading(200) });
    await first.tick();
    await first.idle();
    // the run ended without settling the mission (the very state the stuck mission was in)
    expect(store.missions.get("msn_o1")).toMatchObject({ status: "planning", worker_id: "w_old" });
    const lease = store.missions.get("msn_o1")!.lease_until;
    await first.heartbeat();
    expect(store.missions.get("msn_o1")!.lease_until).toBe(lease); // the old code extended it here, for ever
    store.missions.get("msn_o1")!.lease_until = new Date(Date.now() - 1_000).toISOString(); // the lease ends
    const started: Array<{ id: string; worker: string | null; status: string }> = [];
    const second = createWorker({ store, workerId: "w_new", version: "t", modelLabel: () => "m", runMission: async (m) => { started.push({ id: m.id, worker: m.worker_id, status: m.status }); }, readMemory: () => reading(200) });
    expect(await second.tick()).toBe(1);
    await second.idle();
    expect(started).toEqual([{ id: "msn_o1", worker: "w_new", status: "planning" }]);
  });
});

describe("the real peak memory of every run is recorded (an internal event); the limits come from the measured peak", () => {
  it("the numbers: admission above the highest idle reading ever seen (a healthy idle worker is never blocked), the hard limit above idle + a whole SDK process and above the measured planning peak", () => {
    expect(AGENT_MEMORY_OBSERVED_PLANNING_PEAK_MB).toBe(486);
    expect(AGENT_MEMORY_HIGHEST_IDLE_SEEN_MB).toBe(267); // fresh workers after the #276 deploy: 259-267 MB tree, all blocked by the old admit limit of 250
    expect(AGENT_MEMORY_ADMIT_LIMIT_MB).toBeGreaterThanOrEqual(AGENT_MEMORY_HIGHEST_IDLE_SEEN_MB + 30);
    expect(AGENT_MEMORY_HARD_LIMIT_MB).toBeGreaterThan(AGENT_MEMORY_OBSERVED_PLANNING_PEAK_MB);
    expect(AGENT_MEMORY_HARD_LIMIT_MB).toBeGreaterThanOrEqual(AGENT_MEMORY_HIGHEST_IDLE_SEEN_MB + AGENT_SDK_CHILD_PEAK_MB + 30);
    expect(AGENT_MEMORY_ADMIT_LIMIT_MB + AGENT_SDK_CHILD_PEAK_MB).toBeLessThanOrEqual(AGENT_MEMORY_HARD_LIMIT_MB);
  });

  it("a worker that is idle at the highest reading seen (267 MB) takes a mission", async () => {
    const store = createMemoryStore([newMission({ id: "msn_idle", user_id: U, status: "queued" })]);
    const worker = createWorker({ store, workerId: "w1", version: "t", modelLabel: () => "m", readMemory: () => reading(AGENT_MEMORY_HIGHEST_IDLE_SEEN_MB, 184), runMission: async () => undefined });
    expect(await worker.tick()).toBe(1);
    await worker.idle();
  });

  const run = async (readings: Array<ReturnType<typeof reading>>, status: "queued" | "approved" = "queued") => {
    const store = createMemoryStore([newMission({ id: "msn_p1", user_id: U, status, job_id: status === "approved" ? "job1" : null })]);
    const cur = { v: reading(210, 160) };
    const pressure = vi.fn();
    const worker = createWorker({ store, workerId: "w1", version: "t", modelLabel: () => "m", readMemory: () => cur.v, onMemoryPressure: pressure,
      runMission: async () => { await Promise.resolve(); for (const r of readings) { cur.v = r; worker.watchMemory(); } } });
    await worker.tick();
    await worker.idle();
    return { store, pressure, event: store.events.find((e) => e.counts && "mem_peak_tree_mb" in e.counts) };
  };

  it("a normal planning run that peaks at 486 MB is NOT stopped, and its peak (worker and whole tree) is written as an internal event with the phase", async () => {
    const { event, pressure } = await run([reading(300, 190), reading(486, 230), reading(400, 220)]);
    expect(pressure).not.toHaveBeenCalled();
    expect(event).toBeDefined();
    expect(event!.kind).toBe("call");
    expect(event!.counts).toMatchObject({ mem_phase: 0, mem_start_rss_mb: 160, mem_start_tree_mb: 210, mem_peak_rss_mb: 230, mem_peak_tree_mb: 486 });
    expect(event!.counts!.mem_samples).toBeGreaterThanOrEqual(4);
    expect(event!.counts).not.toHaveProperty("mem_stopped");
    expect(Object.keys(event!.counts!).every((k) => (MISSION_INTERNAL_COUNT_KEYS as readonly string[]).includes(k))).toBe(true);
  });

  it("an execution run is recorded as phase 1; a run the guard stopped says so", async () => {
    const exec = await run([reading(300)], "approved");
    expect(exec.event!.counts).toMatchObject({ mem_phase: 1 });
    const stopped = await run([reading(AGENT_MEMORY_HARD_LIMIT_MB + 5, 240)]);
    expect(stopped.pressure).toHaveBeenCalledTimes(1);
    expect(stopped.event!.counts).toMatchObject({ mem_stopped: 1, mem_peak_tree_mb: AGENT_MEMORY_HARD_LIMIT_MB + 5 });
  });

  it("the customer never sees it: the event is internal, the customer's view drops it, the admin reads it in Arabic", async () => {
    const { event } = await run([reading(400)]);
    const asEvent: EventForCustomer = { id: 1, kind: event!.kind, message_ar: event!.message_ar, counts: event!.counts as Record<string, number>, created_at: "2026-10-28T10:00:00Z" };
    expect(isInternalEvent(asEvent)).toBe(true);
    const v = customerMissionView({ mission: missionRow({ status: "planning" }), events: [asEvent], now: Date.parse("2026-10-28T10:00:30Z") });
    expect(v.currentLineAr).not.toContain("قياس");
    expect(JSON.stringify(v)).not.toContain("mem_");
    const line = internalCountsLineAr(event!.counts as Record<string, number>);
    expect(line).toContain("أعلى ذاكرة للعامل وعملياته");
    expect(checkCustomerText(line.replace(/\(م\.ب\)/g, "")).issues).toEqual([]);
  });

  it("an IDLE worker that stays at or above the admit limit is asked to restart (once) instead of leaving the queue to wait for ever; a young worker never restarts (no restart loop)", async () => {
    let clock = Date.parse("2026-10-28T10:00:00Z");
    const store = createMemoryStore([newMission({ id: "msn_w", user_id: U, status: "queued" })]);
    const recycle = vi.fn();
    const worker = createWorker({ store, workerId: "w1", version: "t", modelLabel: () => "m", readMemory: () => reading(AGENT_MEMORY_ADMIT_LIMIT_MB + 40), onRecycle: recycle, now: () => new Date(clock), runMission: async () => undefined });
    expect(await worker.tick()).toBe(0);
    // waiting for longer than the recycle time, but the worker is young: it keeps waiting, it does NOT restart
    clock += AGENT_MEMORY_RECYCLE_AFTER_MS + 5_000;
    await worker.tick();
    expect(recycle).not.toHaveBeenCalled();
    // old enough, and still above the limit for the recycle time
    clock += AGENT_MEMORY_RECYCLE_MIN_UPTIME_MS;
    await worker.tick();
    await worker.tick();
    expect(recycle).toHaveBeenCalledTimes(1);
    expect(store.missions.get("msn_w")).toMatchObject({ status: "queued", worker_id: null }); // still queued: nothing was lost
  });
});

describe("a failed sample does not end exploration", () => {
  it("the 400 of the stuck mission: crawl4ai.x.search.posts takes `query` and `limit` (the payload is valid) but refuses a topic search without an X login, so the code does not call it at all", () => {
    expect(sessionRestriction("crawl4ai.x.search.posts", { query: "محمد صلاح", limit: 20 })).toContain("NOT called");
    expect(sessionRestriction("crawl4ai.x.search.posts", { query: "from:nasa" })).toBeNull();
    expect(sessionRestriction("crawl4ai.x.search.posts", { query: "  from:@nasa since:2026-10-01" })).toBeNull();
    expect(sessionRestriction("anyapi.x.search.posts", { query: "محمد صلاح" })).toBeNull();
    // the catalog says so itself (the evidence the rule rests on)
    const catalog = loadTregCatalog();
    const e = catalog.byId.get("crawl4ai.x.search.posts")!;
    expect(e.inputs.map((i) => [i.name, i.required])).toEqual([["limit", false], ["mode", false], ["query", true]]);
    expect(JSON.stringify(e)).toContain("Other queries are refused, not billed");
  });

  const tool = (h: ReturnType<typeof makeHarness>, name: string) => buildTools(h.ctx).find((t) => t.name === name)!;

  it("the topic search to that source is refused BEFORE any call (no provider call, no cost), recorded for the admin, and the answer lists the untried sources, cheapest first, to sample next", async () => {
    const h = makeHarness({ responses: [tregResult(xPage("محمد صلاح", 0, 20, "c"), 0.00075)] });
    const search = await tool(h, "catalog_search").handler({ words: ["tweets", "search"], platform: "x", limit: 5 }) as any;
    expect(search.hits[0].id).toBe("crawl4ai.x.search.posts");
    expect(search.hits[0].limit_note).toContain("NOT called");
    const first = await tool(h, "treg_call").handler({ endpoint_id: "crawl4ai.x.search.posts", params: { query: "محمد صلاح", limit: 20 } }) as any;
    expect(first).toMatchObject({ ok: false, refused: "needs_login" });
    expect(first.next_sources[0]).toBe("anyapi.x.search.posts");
    expect(first.next_sources).toHaveLength(3);
    expect(h.call).not.toHaveBeenCalled();
    expect(h.providerCosts).toHaveLength(0);
    expect(h.store.calls[0]).toMatchObject({ endpoint_id: "crawl4ai.x.search.posts", status: "refused", cost_usd: 0 });
    expect(h.store.calls[0].refused_reason).toContain("needs_login");
    // the next source is accepted without a `why` (the refused one counts as tried), and it works
    const second = await tool(h, "treg_call").handler({ endpoint_id: first.next_sources[0], params: { query: "محمد صلاح", limit: 20 } }) as any;
    expect(second.ok).toBe(true);
    expect(h.call).toHaveBeenCalledTimes(1);
  });

  it("a REAL failed sample (HTTP 400 from the source): its reason is kept for the admin, and the answer points to the next untried source", async () => {
    const h = makeHarness({ responses: [tregResult(null, 0, { ok: false, httpStatus: 400, errorDetails: "query refused: topic search needs a session", data: null }), tregResult(xPage("قهوة", 0, 5, null), 0.00075)] });
    await tool(h, "catalog_search").handler({ words: ["tweets", "search"], platform: "x", limit: 5 });
    // from:<account> passes the local rule, so the call is made, and the source itself answers 400
    const failed = await tool(h, "treg_call").handler({ endpoint_id: "crawl4ai.x.search.posts", params: { query: "from:nobody", limit: 20 } }) as any;
    expect(failed).toMatchObject({ ok: false, failed: true, http_status: 400 });
    expect(failed.message).toContain("query refused");
    expect(failed.next_sources[0]).toBe("anyapi.x.search.posts");
    expect(failed.next_step).toContain("sample the next untried source");
    expect(h.store.calls[0]).toMatchObject({ status: "failed", http_status: 400, cost_usd: 0 });
    expect(h.store.calls[0].params_digest._failure).toContain("query refused");
    const next = await tool(h, "treg_call").handler({ endpoint_id: failed.next_sources[0], params: { query: "قهوة", limit: 5 } }) as any;
    expect(next.ok).toBe(true);
  });

  it("an EMPTY sample also moves on: the answer lists the untried sources", async () => {
    const h = makeHarness({ responses: [tregResult({ output: { data: { items: [], nextCursor: null } } }, 0)] });
    await tool(h, "catalog_search").handler({ words: ["tweets", "search"], platform: "x", limit: 5 });
    const empty = await tool(h, "treg_call").handler({ endpoint_id: "crawl4ai.x.search.posts", params: { query: "from:nobody" } }) as any;
    if (empty.ok === true) expect(empty.rows_in_page).toBe(0);
    expect(empty.next_sources).toBeDefined();
    expect(empty.next_sources).not.toContain("crawl4ai.x.search.posts");
  });
});

describe("the tweets mission end to end with the stuck mission's first step", () => {
  const ENDPOINT = "anyapi.x.search.posts";
  const TOPIC = "محمد صلاح";
  it("«هات ٣٠٠ تغريدة عن محمد صلاح»: the topic search to the login-only source is refused for free, the next source is sampled, 300 rows are planned, approved, paged, delivered and settled; nothing stays leased", async () => {
    const r = await replay({
      request: "هات ٣٠٠ تغريدة عن محمد صلاح",
      planning: [
        { tool: "report_progress", args: { message_ar: "أبحث عن أرخص مصدر مناسب للتغريدات", counts: { sources: 3, stages: 1 } } },
        { tool: "catalog_search", args: { words: ["tweets", "search"], platform: "x", limit: 5 } },
        { tool: "treg_call", args: { endpoint_id: "crawl4ai.x.search.posts", params: { query: TOPIC, limit: 20 } } },
        { tool: "report_progress", args: { message_ar: "المصدر الأول لا يخدم هذا البحث، أجرّب المصدر التالي", counts: { samples: 1, stages: 1 } } },
        { tool: "treg_call", args: (res: Results) => ({ endpoint_id: String((res[res.length - 2].result as any).next_sources[0]), params: { query: TOPIC, limit: 20 } }) },
        { tool: "run_code", args: { code: "return inputs.call_0002.output.data.items.slice(0, 3).map(t => ({ id: t.id, text: t.text, url: t.url, author: t.author }))", files: ["call_0002"] } },
        { tool: "propose_plan", args: (res: Results) => ({
          summary_ar: "ستحصل على ٣٠٠ تغريدة عن محمد صلاح مع نص كل تغريدة ورابطها.",
          stages: [{ key: "tweets", title_ar: "التغريدات", endpoint_id: ENDPOINT, expected_rows: 300, parent_key: null, deliver: true,
            columns: [{ key: "text", title_ar: "نص التغريدة" }, { key: "url", title_ar: "رابط التغريدة" }, { key: "author", title_ar: "الحساب" }, { key: "date", title_ar: "التاريخ والوقت" }],
            sample_rows: (res.filter((x) => x.tool === "run_code")[0].result.result as unknown[]).slice(0, 3), measured_by: [callIds(res)[0]], relevance: aboutWords(["محمد صلاح"]), yield_from: firstOutputId(res) }],
        }) },
      ],
      execution: () => [
        ...pagedCalls(ENDPOINT, 15, (cursor) => ({ query: TOPIC, limit: 20, ...(cursor ? { cursor } : {}) })),
        { tool: "run_code", args: (res: Results) => ({ code: "const seen = new Set(); const out = []; for (const page of Object.values(inputs)) for (const t of page.output.data.items) { if (seen.has(t.id)) continue; seen.add(t.id); out.push({ id: t.id, text: t.text, url: t.url, author: t.author }); } return out;", files: callIds(res) }) },
        { tool: "save_rows", args: (res: Results) => ({ stage_key: "tweets", from_output: lastOutputId(res) }) },
        { tool: "finish", args: { outcome: "delivered", summary_ar: "سُلّمت ٣٠٠ تغريدة عن محمد صلاح، لكل تغريدة نصها ورابطها." } },
      ],
      answers: [tregResult(xPage(TOPIC, 0, 20, "cur_20"), 0.00075), ...pagedAnswers(300, 20, 0.00075, (o, n, next) => xPage(TOPIC, o, n, next), tregResult)],
    });
    // the first step: refused locally, free, recorded; the provider was called only for the working source (1 sample + 15 pages)
    expect(r.planningDriver.results[2].result).toMatchObject({ ok: false, refused: "needs_login" });
    expect(r.store.calls[0]).toMatchObject({ endpoint_id: "crawl4ai.x.search.posts", status: "refused", phase: "planning" });
    expect(r.call).toHaveBeenCalledTimes(16);
    expect(r.plannedPlan.stages[0].endpoint_id).toBe(ENDPOINT);
    expect(r.planView.totalRows).toBe(300);
    assertReplayInvariants(r, { expectDelivered: 300 });
    expect(r.mission).toMatchObject({ status: "completed", worker_id: null, lease_until: null });
    expect(r.mission.charged_points!).toBeLessThanOrEqual(r.mission.reserved_points!);
    // the planning events carry the sample progress the panel shows
    expect(r.store.events.filter((e) => e.counts?.samples === 1)).toHaveLength(1);
  });
});

describe("the customer's panel: elapsed time, progress inside the step, an honest line when nothing moves", () => {
  const T0 = Date.parse("2026-10-28T16:57:36Z");
  const mission = (over: Partial<MissionRowForCustomer> = {}) => missionRow({ created_at: new Date(T0).toISOString(), ...over });
  const event = (id: number, over: Partial<EventForCustomer> = {}): EventForCustomer => ({ id, kind: "system", message_ar: "بدأ الوكيل دراسة طلبك.", counts: {}, created_at: new Date(T0 + 2_000 + id * 1_000).toISOString(), ...over });

  it("the stuck mission's panel: no card, no hold, the elapsed clock starts at the creation even with no event, and after three quiet minutes it says plainly nothing was held (never an ETA)", () => {
    const base = { mission: mission({ status: "planning" }), events: [event(1)], callsMade: 1 };
    const early = customerMissionView({ ...base, now: T0 + 60_000 });
    expect(early.delayAr).toBeNull();
    const slow = customerMissionView({ ...base, now: T0 + 2_000 + 1_000 + 100_000 });
    expect(slow.delayAr).toBe(SLOW_PLANNING_AR);
    const stalled = customerMissionView({ ...base, now: T0 + 3_000 + AGENT_STALL_AFTER_MS + 1_000 });
    expect(stalled.delayAr).toBe(STALLED_PLANNING_AR);
    expect(stalled.delayAr).toContain("لم يُحجز أي رصيد");
    for (const line of [SLOW_PLANNING_AR, STALLED_PLANNING_AR]) { expect(checkCustomerText(line).issues, line).toEqual([]); expect(line).not.toMatch(/[0-9٠-٩]\s*(دقيقة|ثانية|ساعة)/); }
    expect(stalled.remainingAr).toBeNull();
    // no event at all: the clock and the stall are measured from the creation
    const none = customerMissionView({ mission: mission({ status: "planning" }), events: [], now: T0 + AGENT_STALL_AFTER_MS + 5_000 });
    expect(none.startedAt).toBe(T0);
    expect(none.delayAr).toBe(STALLED_PLANNING_AR);
    expect(stalled.queueLineAr).toBeNull();
  });

  it("progress inside «تجربة عينة من كل مرحلة»: «عينة ١ من ٢» when the agent said how many stages it plans, else how many samples were tried", () => {
    const withTotal = customerMissionView({ mission: mission({ status: "planning" }), events: [event(1, { kind: "progress", message_ar: "أجرّب العينة الأولى", counts: { stages: 2, samples: 1 } })], callsMade: 1, now: T0 + 20_000 });
    const step = withTotal.steps.find((s) => s.titleAr === "تجربة عينة من كل مرحلة")!;
    expect(step.state).toBe("running");
    expect(step.countAr).toBe("عينة ١ من ٢");
    expect(step.ratio).toBeCloseTo(0.5, 5);
    expect(withTotal.currentLineAr).toContain("عينة ١ من ٢");
    const noTotal = customerMissionView({ mission: mission({ status: "planning" }), events: [event(1)], callsMade: 2, now: T0 + 20_000 });
    expect(noTotal.steps.find((s) => s.titleAr === "تجربة عينة من كل مرحلة")!.detailAr).toBe("جُرّبت عينتان");
    for (const v of [withTotal, noTotal]) expect(checkCustomerText([v.currentLineAr, ...v.steps.flatMap((s) => [s.titleAr, s.countAr ?? "", s.detailAr ?? ""])].join(" ")).issues).toEqual([]);
  });

  it("a running mission quiet for a long time says it charges only what is delivered (and keeps the existing «المصدر أبطأ» wording)", () => {
    const v = customerMissionView({ mission: mission({ status: "executing" }), events: [event(1, { counts: { stage: 1, saved: 5, planned: 20 } })], now: T0 + 2_000 + 1_000 + AGENT_STALL_AFTER_MS + 5_000 });
    expect(v.delayAr).toContain("المصدر أبطأ من المعتاد");
    expect(v.delayAr).toContain("ولن يُخصم منك إلا ما يُسلَّم فعلًا");
  });
});

function missionRow(over: Partial<MissionRowForCustomer> = {}): MissionRowForCustomer {
  return { id: "msn_view00001", status: "planning", question_ar: null, plan_public: null, reserved_points: null, unit_price_points: null, delivered_units: null, charged_points: null, summary_ar: null, files: null, created_at: "2026-10-28T10:00:00Z", ...over };
}
