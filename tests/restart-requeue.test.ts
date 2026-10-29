import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENT_RESTART_REQUEUES_MAX } from "../src/lib/agentMission/constants";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { createFakeDriver } from "../agent/src/fakeDriver";
import type { ModelDriver } from "../agent/src/driver";
import { createMemoryStore, newMission } from "../agent/src/memoryStore";
import { readRunState } from "../agent/src/runState";
import { endedByRestart, runMissionSafely, type RunnerDeps } from "../agent/src/runMission";
import { abortActiveRuns, trackRun, untrackRun } from "../agent/src/sessions";
import { NOT_ADMIN, USER_ID, fakeRecorder } from "./helpers/agentHarness";
import { fakeMoneyClient } from "./helpers/agentMoney";

/**
 * A DEPLOY MUST NOT KILL A PLANNING AS «A LIMIT OF OURS». Live run of 2026-10-29: «هات ١٠٠٠ تغريدة عن الدوري المصري» (created 13:37:37 UTC) planned for 54 seconds, made two sample calls, and ended with
 * `Claude Code process exited with code 143` (SIGTERM) at 13:38:33. Pull request #292 was merged at 13:37:05; the platform builds for about 90 seconds and restarts the worker: the heartbeat of the worker that
 * ran the mission stops at 13:38:34, the next worker's starts later. The size of the request had nothing to do with it. The run's model process died with the signal, the planning ended with «error», and the mission was
 * classified «internal» (status failed, «تعذّر تجهيز خطة لطلبك بسبب حد من جانبنا»). Now a run cut short by a restart goes back to the queue, counted apart, and the next worker plans it again.
 */
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
const MODELS = { planning: "claude-haiku-5-5", execution: "claude-haiku-5-5" };

function setup(driver: ModelDriver) {
  const store = createMemoryStore();
  const money = fakeMoneyClient();
  const rec = fakeRecorder();
  const notices: string[] = [];
  const call = vi.fn(async () => { throw new Error("no provider call in this test"); });
  const deps: RunnerDeps = { store, client: money.client, catalog: loadTregCatalog(), driver, recorder: rec.recorder, commit: rec.commit, call: call as any, models: MODELS, resolveAccess: async () => NOT_ADMIN, notify: async (n) => { notices.push(n.kind); } };
  store.missions.set("msn_r1", newMission({ id: "msn_r1", user_id: USER_ID, request_text: "هات ١٠٠٠ تغريدة عن الدوري المصري", status: "planning", worker_id: "w1", lease_until: new Date(Date.now() + 60_000).toISOString() }));
  return { store, deps, notices, money };
}
const driverEnding = (out: { stop: string; error?: string }): ModelDriver => ({ run: async () => ({ llmCostUsd: 0.0075, turns: 3, stop: out.stop, ...(out.error ? { error: out.error } : {}) }) });

describe("a run the platform cut short is recognised", () => {
  it("SIGTERM (143), SIGKILL (137) and the worker's own «restart» stop are restarts; an ordinary error, a time-out and the memory stop are not", () => {
    expect(endedByRestart({ stop: "restart" })).toBe(true);
    expect(endedByRestart({ stop: "error", error: "Claude Code process exited with code 143" })).toBe(true);
    expect(endedByRestart({ stop: "error", error: "Claude Code process exited with code 137" })).toBe(true);
    expect(endedByRestart({ stop: "error", error: "the process was terminated by signal SIGTERM" })).toBe(true);
    expect(endedByRestart({ stop: "error", error: "Claude Code process exited with code 1" })).toBe(false);
    expect(endedByRestart({ stop: "error", error: "the model run ended with error_max_turns" })).toBe(false);
    expect(endedByRestart({ stop: "time" })).toBe(false);
    expect(endedByRestart({ stop: "memory" })).toBe(false);
    expect(endedByRestart({ stop: "end" })).toBe(false);
  });

  it("the worker's shutdown stops every run in flight with the reason «restart» (what the entry point's SIGTERM handler calls)", () => {
    const a = trackRun();
    const b = trackRun();
    expect(abortActiveRuns("restart")).toBe(2);
    expect(a.reason.value).toBe("restart");
    expect(b.abort.signal.aborted).toBe(true);
    untrackRun(a); untrackRun(b);
    expect(abortActiveRuns("restart")).toBe(0);
  });
});

describe("planning that meets a restart goes back to the queue instead of failing", () => {
  it("the live case: the model process ended with exit code 143 after two sample calls; the mission is queued again, nothing held, the customer told it resumes, never a failure", async () => {
    const t = setup(driverEnding({ stop: "error", error: "Claude Code process exited with code 143" }));
    await runMissionSafely(t.deps, t.store.missions.get("msn_r1")!);
    const m = t.store.missions.get("msn_r1")!;
    expect(m).toMatchObject({ status: "queued", worker_id: null, lease_until: null, job_id: null, plan: null });
    expect(m.error ?? null).toBeNull();
    const last = t.store.events[t.store.events.length - 1];
    expect(last).toMatchObject({ kind: "system", message_ar: "أُعيد تشغيل الخدمة أثناء العمل على مهمتك، وستُستأنف تلقائيًا من حيث وصلت.", counts: { requeued: 1 } });
    expect(t.notices).toEqual([]);
    expect(t.money.calls.map((c) => c.name)).toEqual([]);
    expect((await readRunState(t.store, "msn_r1")).restartRequeues).toBe(1);
    // the model cost of the run that was cut is kept on the mission
    expect(Number(m.planning_llm_usd)).toBeGreaterThan(0);
    // the next worker takes it again
    expect((await t.store.claimMission("w2", 120))?.status).toBe("planning");
  });

  it("the worker's own stop («restart», from the SIGTERM handler) is the same", async () => {
    const t = setup(driverEnding({ stop: "restart" }));
    await runMissionSafely(t.deps, t.store.missions.get("msn_r1")!);
    expect(t.store.missions.get("msn_r1")).toMatchObject({ status: "queued", worker_id: null });
    expect(t.notices).toEqual([]);
  });

  it("restarts have their own, higher limit (a restart storm must still end): after it the mission ends honestly as before", async () => {
    const t = setup(driverEnding({ stop: "error", error: "Claude Code process exited with code 143" }));
    for (let n = 1; n <= AGENT_RESTART_REQUEUES_MAX; n += 1) {
      await runMissionSafely(t.deps, t.store.missions.get("msn_r1")!);
      expect(t.store.missions.get("msn_r1")!.status).toBe("queued");
      expect(t.store.events[t.store.events.length - 1].counts).toEqual({ requeued: n });
      await t.store.claimMission("w1", 120);
    }
    await runMissionSafely(t.deps, t.store.missions.get("msn_r1")!);
    expect(t.store.missions.get("msn_r1")!.status).toBe("failed");
    expect(AGENT_RESTART_REQUEUES_MAX).toBeGreaterThan(2);
  });

  it("an ordinary error is NOT a restart: it keeps its own counter and the failure class it had", async () => {
    const t = setup(driverEnding({ stop: "error", error: "Claude Code process exited with code 1" }));
    await runMissionSafely(t.deps, t.store.missions.get("msn_r1")!);
    const m = t.store.missions.get("msn_r1")!;
    expect(m.status).toBe("failed");
    expect(String(m.error)).toContain("planning_failed");
    expect((await readRunState(t.store, "msn_r1")).restartRequeues).toBe(0);
    void createFakeDriver;
  });
});
