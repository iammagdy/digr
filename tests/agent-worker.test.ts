import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { AGENT_HEARTBEAT_ALIVE_MS, AGENT_HEARTBEAT_INTERVAL_MS, AGENT_WORKER_CONCURRENCY, AGENT_MISSION_LEASE_SECONDS, PLANNING_MODEL_SETTING_KEY } from "../src/lib/agentMission/constants";
import { latestBeat, workerAlive } from "../src/lib/agentMission/heartbeat";
import { createMemoryStore, newMission } from "../agent/src/memoryStore";
import { createWorker } from "../agent/src/worker";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseConcurrency, memoryWarning } from "../src/lib/agentMission/concurrency";
import { processTreeRssMb, readMemory } from "../agent/src/memory";
import { resolveModels } from "../agent/src/modelConfig";
import { chooseLlmCost, llmCostFromUsage } from "../agent/src/llmCost";
import { BUILT_IN_TOOLS, buildQueryOptions, mcpToolNames } from "../agent/src/sdkOptions";
import { buildTools, newRunState } from "../agent/src/tools";
import { loadSystemPrompt, SYSTEM_PROMPT_PATH } from "../agent/src/prompt";
import { makeHarness } from "./helpers/agentHarness";

const U = "00000000-0000-0000-0000-0000000000aa";
const queued = (n: number) => Array.from({ length: n }, (_, i) => newMission({ id: `msn_w${i}`, user_id: U, status: "queued" }));

describe("worker: concurrency, leases, heartbeat", () => {
  it("the default concurrency is 1 (Heroku Basic has 512 MB); with 2 the worker never runs more than 2 at once", async () => {
    expect(AGENT_WORKER_CONCURRENCY).toBe(1);
    const store = createMemoryStore(queued(5));
    let running = 0; let peak = 0;
    const release: Array<() => void> = [];
    const worker = createWorker({ store, workerId: "w1", version: "t", modelLabel: () => "m", concurrency: 2, runMission: () => new Promise<void>((resolve) => { running += 1; peak = Math.max(peak, running); release.push(() => { running -= 1; resolve(); }); }) });
    expect(await worker.tick()).toBe(2);
    expect(worker.activeCount()).toBe(2);
    expect(await worker.tick()).toBe(0); // no free slot: nothing more is taken
    release.shift()!();
    await new Promise((r) => setTimeout(r, 0));
    expect(await worker.tick()).toBe(1);
    expect(peak).toBe(2);
    while (release.length) { release.shift()!(); await new Promise((r) => setTimeout(r, 0)); await worker.tick(); }
    await worker.idle();
    expect(peak).toBe(2);
  });

  it("takes queued missions to plan and approved ones to execute; two workers never take the same mission", async () => {
    const store = createMemoryStore([newMission({ id: "msn_a", user_id: U, status: "queued" }), newMission({ id: "msn_b", user_id: U, status: "approved", job_id: "job1" })]);
    const first = await store.claimMission("w1", AGENT_MISSION_LEASE_SECONDS);
    const second = await store.claimMission("w2", AGENT_MISSION_LEASE_SECONDS);
    const third = await store.claimMission("w3", AGENT_MISSION_LEASE_SECONDS);
    expect([first!.id, second!.id].sort()).toEqual(["msn_a", "msn_b"]);
    expect(store.missions.get("msn_a")!.status).toBe("planning");
    expect(store.missions.get("msn_b")!.status).toBe("executing");
    expect(third).toBeNull();
  });

  it("takes over a mission whose worker died (its lease ran out)", async () => {
    const store = createMemoryStore([newMission({ id: "msn_dead", user_id: U, status: "executing", worker_id: "gone", lease_until: new Date(Date.now() - 1000).toISOString(), job_id: "j" })]);
    const claimed = await store.claimMission("w2", AGENT_MISSION_LEASE_SECONDS);
    expect(claimed).toMatchObject({ id: "msn_dead", worker_id: "w2", status: "executing" });
  });

  it("writes a heartbeat row and renews the leases of its missions", async () => {
    const store = createMemoryStore(queued(1));
    const worker = createWorker({ store, workerId: "w1", version: "v9", modelLabel: () => "claude-haiku-5-5", runMission: () => new Promise(() => undefined), now: () => new Date("2026-10-28T10:00:00Z"), readMemory: () => ({ rssMb: 180, treeRssMb: 410 }) });
    await worker.tick();
    const before = store.missions.get("msn_w0")!.lease_until!;
    await new Promise((r) => setTimeout(r, 5));
    await worker.heartbeat();
    expect(store.heartbeats).toEqual([{ worker_id: "w1", beat_at: "2026-10-28T10:00:00.000Z", active_missions: 1, model: "claude-haiku-5-5", version: "v9", rss_mb: 180, tree_rss_mb: 410 }]);
    expect(store.missions.get("msn_w0")!.lease_until! >= before).toBe(true);
  });

  it("beats every 30 seconds while it runs, on its own timer", async () => {
    vi.useFakeTimers();
    try {
      expect(AGENT_HEARTBEAT_INTERVAL_MS).toBe(30_000);
      const store = createMemoryStore();
      const worker = createWorker({ store, workerId: "w1", version: "t", modelLabel: () => "m", runMission: async () => undefined });
      let ticks = 0;
      const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(() => { ticks += 1; if (ticks >= 100) worker.stop(); resolve(); }, ms));
      const loop = worker.run({ pollMs: 5_000, sleep });
      await vi.advanceTimersByTimeAsync(0);
      expect(store.heartbeats).toHaveLength(1); // at start
      await vi.advanceTimersByTimeAsync(30_000);
      expect(store.heartbeats).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(store.heartbeats).toHaveLength(4);
      worker.stop();
      await vi.advanceTimersByTimeAsync(10_000);
      await loop;
    } finally {
      vi.useRealTimers();
    }
  });

  it("a failing heartbeat or claim never stops the worker", async () => {
    const store = createMemoryStore(queued(1));
    store.writeHeartbeat = async () => { throw new Error("db down"); };
    store.claimMission = async () => { throw new Error("db down"); };
    const logs: string[] = [];
    const worker = createWorker({ store, workerId: "w1", version: "t", modelLabel: () => "m", runMission: async () => undefined, log: (l) => logs.push(l) });
    await expect(worker.heartbeat()).resolves.toBeUndefined();
    await expect(worker.tick()).resolves.toBe(0);
    expect(logs.join(" ")).toContain("heartbeat_failed");
  });

  it("a mission that crashes is released from the active set and logged", async () => {
    const store = createMemoryStore(queued(1));
    const logs: string[] = [];
    const worker = createWorker({ store, workerId: "w1", version: "t", modelLabel: () => "m", runMission: async () => { throw new Error("boom"); }, log: (l) => logs.push(l) });
    await worker.tick();
    await worker.idle();
    expect(worker.activeCount()).toBe(0);
    expect(logs.join(" ")).toContain("mission_crashed");
  });
});

describe("heartbeat: alive or not", () => {
  const now = Date.parse("2026-10-28T10:00:00Z");
  it("alive while the last beat is younger than 90 seconds", () => {
    expect(AGENT_HEARTBEAT_ALIVE_MS).toBe(90_000);
    expect(workerAlive("2026-10-28T09:59:45Z", now)).toEqual({ alive: true, ageSeconds: 15 });
    expect(workerAlive("2026-10-28T09:58:31Z", now).alive).toBe(true);
    expect(workerAlive("2026-10-28T09:58:29Z", now).alive).toBe(false);
  });
  it("not alive when there is no beat or it is unreadable", () => {
    expect(workerAlive(null, now)).toEqual({ alive: false, ageSeconds: null });
    expect(workerAlive("not a date", now).alive).toBe(false);
  });
  it("takes the freshest beat among workers", () => {
    expect(latestBeat([{ beat_at: "2026-10-28T09:00:00Z" }, { beat_at: "2026-10-28T09:59:00Z" }, { beat_at: null }])).toBe("2026-10-28T09:59:00Z");
    expect(latestBeat([])).toBeNull();
  });
});

describe("models and the cost of each mission", () => {
  it("defaults to claude-haiku-5-5; the owner's setting moves PLANNING to claude-sonnet-5-5; anything else is ignored", () => {
    expect(resolveModels({}, {})).toEqual({ planning: "claude-haiku-5-5", execution: "claude-haiku-5-5" });
    expect(resolveModels({ AGENT_MODEL: "claude-sonnet-5-5" }, {})).toEqual({ planning: "claude-sonnet-5-5", execution: "claude-sonnet-5-5" });
    expect(resolveModels({}, { [PLANNING_MODEL_SETTING_KEY]: "claude-sonnet-5-5" })).toEqual({ planning: "claude-sonnet-5-5", execution: "claude-haiku-5-5" });
    expect(resolveModels({}, { [PLANNING_MODEL_SETTING_KEY]: { model: "claude-sonnet-5-5" } }).planning).toBe("claude-sonnet-5-5");
    expect(resolveModels({ AGENT_MODEL: "gpt-5" }, { [PLANNING_MODEL_SETTING_KEY]: "some-other-model" })).toEqual({ planning: "claude-haiku-5-5", execution: "claude-haiku-5-5" });
  });
  it("prices the model's tokens per model so the owner can compare them per mission", () => {
    const usage = { input_tokens: 100_000, output_tokens: 20_000 };
    expect(llmCostFromUsage("claude-haiku-5-5", usage)).toBeCloseTo(0.1 * 0.1 + 0.02 * 0.5, 9);
    expect(llmCostFromUsage("claude-sonnet-5-5", usage)).toBeCloseTo(0.1 * 2 + 0.02 * 10, 9);
    expect(llmCostFromUsage("unknown", usage)).toBe(0);
    expect(chooseLlmCost(0.5, "claude-haiku-5-5", usage)).toBe(0.5);
    expect(chooseLlmCost(0, "claude-haiku-5-5", usage)).toBeCloseTo(0.02, 9);
  });
});

describe("what the model is given", () => {
  const h = makeHarness();
  const tools = buildTools({ ...h.ctx, state: newRunState() });
  const opts = buildQueryOptions({ model: "claude-haiku-5-5", systemPrompt: "p", maxTurns: 10, maxBudgetUsd: 0.1, cwd: "/tmp/x", tools }, {
    PATH: "/usr/bin", HOME: "/home/x", ANTHROPIC_API_KEY: "sk-fake", SUPABASE_SERVICE_ROLE_KEY: "fake-service", TREG_TOKEN: "fake-treg", SUPABASE_URL: "https://x.supabase.co",
  });
  it("no built-in tool: shell, web fetch and file tools are disabled three ways", () => {
    expect(opts.tools).toEqual([]);
    for (const banned of ["Bash", "WebFetch", "WebSearch", "Read", "Write", "Edit", "Glob", "Grep", "Task"]) expect(opts.disallowedTools).toContain(banned);
    expect(BUILT_IN_TOOLS).toContain("Bash");
    expect(opts.allowedTools).toEqual(mcpToolNames(tools));
    expect(opts.allowedTools.every((n) => n.startsWith("mcp__diger__"))).toBe(true);
    expect(opts.canUseToolDecision("Bash")).toBe(false);
    expect(opts.canUseToolDecision("WebFetch")).toBe(false);
    expect(opts.canUseToolDecision("mcp__diger__treg_call")).toBe(true);
    expect(opts.settingSources).toEqual([]);
    expect(opts.strictMcpConfig).toBe(true);
  });
  it("the SDK's process gets the Anthropic key and nothing else: never the Supabase key, the TREG token or the Supabase URL", () => {
    expect(Object.keys(opts.env).sort()).toEqual(["ANTHROPIC_API_KEY", "HOME", "PATH"]);
    expect(JSON.stringify(opts)).not.toMatch(/fake-service|fake-treg|supabase\.co/);
  });
  it("the system prompt is a file, carries the customer-text rules, and has a section per phase", () => {
    expect(readFileSync(SYSTEM_PROMPT_PATH, "utf8")).toContain("Arabic-Indic");
    const planning = loadSystemPrompt("planning");
    const execution = loadSystemPrompt("execution");
    for (const p of [planning, execution]) {
      expect(p).toMatch(/Arabic only/);
      expect(p).toMatch(/never name a provider/i);
      expect(p).toMatch(/dollar/i);
      expect(p).toMatch(/ONE question/);
      expect(p).toMatch(/Never invent ids, links/);
      expect(p).toMatch(/Cheapest suitable source first/);
      expect(p).toMatch(/Link child rows to parents/);
      expect(p).toMatch(/honest/i);
    }
    expect(planning).toContain("PLANNING");
    expect(planning).not.toContain("This phase: EXECUTION");
    expect(execution).toContain("This phase: EXECUTION");
    expect(execution).not.toContain("This phase: PLANNING");
  });
});

describe("concurrency from AGENT_CONCURRENCY, default 1", () => {
  it("reads a whole number from 1 to 4; anything else is the default of 1", () => {
    expect(parseConcurrency(undefined)).toBe(1);
    expect(parseConcurrency("")).toBe(1);
    expect(parseConcurrency("2")).toBe(2);
    expect(parseConcurrency(" 3 ")).toBe(3);
    expect(parseConcurrency("4")).toBe(4);
    expect(parseConcurrency("9")).toBe(4);
    for (const bad of ["0", "-1", "1.5", "two", "1e3", "NaN", "٢"]) expect(parseConcurrency(bad), bad).toBe(1);
  });

  it("a worker built with no setting takes one mission at a time", async () => {
    const store = createMemoryStore(queued(3));
    const worker = createWorker({ store, workerId: "w1", version: "t", modelLabel: () => "m", runMission: () => new Promise(() => undefined) });
    expect(await worker.tick()).toBe(1);
    expect(await worker.tick()).toBe(0);
    expect(worker.activeCount()).toBe(1);
  });

  it("a worker built with the parsed setting takes that many", async () => {
    const store = createMemoryStore(queued(5));
    const worker = createWorker({ store, workerId: "w1", version: "t", modelLabel: () => "m", concurrency: parseConcurrency("3"), runMission: () => new Promise(() => undefined) });
    expect(await worker.tick()).toBe(3);
  });
});

describe("memory in the heartbeat row", () => {
  it("every heartbeat carries the real RSS of the process (a positive number of MB) and the tree figure", async () => {
    const store = createMemoryStore();
    const worker = createWorker({ store, workerId: "w1", version: "t", modelLabel: () => "m", runMission: async () => undefined });
    await worker.heartbeat();
    await worker.heartbeat();
    expect(store.heartbeats).toHaveLength(2);
    for (const row of store.heartbeats) {
      expect(Number.isInteger(row.rss_mb)).toBe(true);
      expect(row.rss_mb).toBeGreaterThan(10);
      // the two figures are read a moment apart, so under load they can differ either way: only their kind is fixed
      expect(row.tree_rss_mb === null || (Number.isInteger(row.tree_rss_mb) && row.tree_rss_mb > 10)).toBe(true);
    }
    // read a moment apart from a live process: equal up to what the process allocates in between
    expect(Math.abs(readMemory().rssMb - Math.round(process.memoryUsage().rss / 1048576))).toBeLessThan(100);
  });

  it("the tree figure adds the processes the worker started (read from /proc), and is null when /proc cannot be read", () => {
    const proc = mkdtempSync(path.join(tmpdir(), "fakeproc-"));
    const add = (pid: number, ppid: number, pages: number, comm = "node") => {
      mkdirSync(path.join(proc, String(pid)));
      writeFileSync(path.join(proc, String(pid), "stat"), `${pid} (${comm}) S ${ppid} 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 1 1 1`);
      writeFileSync(path.join(proc, String(pid), "statm"), `1000 ${pages} 10 1 0 1 0`);
    };
    add(100, 1, 25600);                 // the worker: 100 MB
    add(200, 100, 51200, "claude (x)"); // its child (a name with a parenthesis): 200 MB
    add(300, 200, 12800);               // its grandchild: 50 MB
    add(400, 1, 256000);                // an unrelated process: not counted
    mkdirSync(path.join(proc, "self")); // not a pid
    expect(processTreeRssMb(100, proc)).toBe(350);
    expect(processTreeRssMb(200, proc)).toBe(250);
    expect(processTreeRssMb(999, proc)).toBeNull();
    expect(processTreeRssMb(100, path.join(proc, "missing"))).toBeNull();
  });

  it("warns at 80% of the dyno's 512 MB and never when it was not measured", () => {
    expect(memoryWarning(409)).toBe(false);
    expect(memoryWarning(410)).toBe(true);
    expect(memoryWarning(null)).toBe(false);
    expect(memoryWarning(undefined)).toBe(false);
  });
});
