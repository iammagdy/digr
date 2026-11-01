import { describe, expect, it, vi } from "vitest";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { MISSION_INTERNAL_COUNT_KEYS } from "../src/lib/agentMission/constants";
import { createFakeDriver } from "../agent/src/fakeDriver";
import { createMemoryStore, newMission } from "../agent/src/memoryStore";
import { runMissionSafely, type RunnerDeps } from "../agent/src/runMission";
import { NOT_ADMIN, USER_ID, fakeRecorder } from "./helpers/agentHarness";
import { fakeMoneyClient } from "./helpers/agentMoney";
import { checkCustomerText } from "../src/lib/agentMission/text";

/**
 * S1 item 0.4: PLANNING TELEMETRY (events only). Why does planning reach 580 MB and how do 36,577 output tokens split (docs/REDESIGN-PLAN.md F10)? Each model turn of a planning run records ONE internal event with COUNTS ONLY:
 * the turn number, the turn's own input, output and cache tokens, and the worker's memory at that moment. No text from the model, no provider name, no customer sentence.
 */
const MODELS = { planning: "claude-haiku-5-5", execution: "claude-haiku-5-5" };
const say = (n: number) => ({ tool: "report_progress", args: { message_ar: `أراجع الأدوات المتاحة ${n}`, counts: { sources: n } } });

function setup(script: ReturnType<typeof say>[]) {
  const store = createMemoryStore();
  const money = fakeMoneyClient();
  const rec = fakeRecorder();
  const driver = createFakeDriver(script, { stopAfterTerminal: false });
  const call = vi.fn(async () => { throw new Error("no provider call in this test"); });
  const deps: RunnerDeps = { store, client: money.client, catalog: loadTregCatalog(), driver, recorder: rec.recorder, commit: rec.commit, call: call as any, models: MODELS, resolveAccess: async () => NOT_ADMIN, notify: async () => undefined };
  store.missions.set("msn_t1", newMission({ id: "msn_t1", user_id: USER_ID, request_text: "هات ٥٠ تغريدة عن الذكاء الاصطناعي", status: "planning", worker_id: "w1", lease_until: new Date(Date.now() + 60_000).toISOString() }));
  return { store, deps };
}

describe("one internal event per model turn, counts only", () => {
  it("a fake driver that emits 3 turns leaves 3 turn events with the turn tokens and the worker memory", async () => {
    const t = setup([say(1), say(2), say(3)]);
    await runMissionSafely(t.deps, t.store.missions.get("msn_t1")!);
    const turns = t.store.events.filter((e) => e.counts && "turn_n" in e.counts);
    expect(turns).toHaveLength(3);
    expect(turns.map((e) => e.counts!.turn_n)).toEqual([1, 2, 3]);
    for (const e of turns) {
      expect(e.kind).toBe("call");
      expect(Object.keys(e.counts!).sort()).toEqual(["turn_cache_read", "turn_cache_write", "turn_in", "turn_n", "turn_out", "turn_rss_mb"]);
      expect(Object.values(e.counts!).every((v) => typeof v === "number" && Number.isFinite(v))).toBe(true);
      expect(e.counts!.turn_rss_mb).toBeGreaterThan(0);
      expect(Object.keys(e.counts!).every((k) => (MISSION_INTERNAL_COUNT_KEYS as readonly string[]).includes(k))).toBe(true);
    }
  });
  it("the text of a turn event is a fixed Arabic sentence: no model text, no provider name", async () => {
    const t = setup([say(1)]);
    await runMissionSafely(t.deps, t.store.missions.get("msn_t1")!);
    const e = t.store.events.find((x) => x.counts && "turn_n" in x.counts)!;
    expect(checkCustomerText(e.message_ar).issues).toEqual([]);
    expect(e.message_ar).not.toContain("أراجع الأدوات");
  });
});
