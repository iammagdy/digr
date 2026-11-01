import { describe, expect, it, vi } from "vitest";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { createFakeDriver, type FakeStep } from "../agent/src/fakeDriver";
import type { ModelDriver, RunInput } from "../agent/src/driver";
import { createMemoryStore, newMission } from "../agent/src/memoryStore";
import { runMissionSafely, type RunnerDeps } from "../agent/src/runMission";
import { readPlanningState, PLANNING_STATE_FILE } from "../agent/src/planningState";
import { NOT_ADMIN, USER_ID, fakeRecorder } from "./helpers/agentHarness";
import { fakeMoneyClient } from "./helpers/agentMoney";
import { planning, ENDPOINT, pages } from "./helpers/engineXScenario";

/**
 * S1 item 1.11: PLANNING CHECKPOINT AND RESUME. After each tool turn the planning state (the sources tried, the samples taken, the full inputs of every call, the skips, the descriptions read, a short working summary) is saved to planning_state.json in the mission's folder; on a
 * memory stop or a restart the next run starts from it, and its prompt carries it, so the paid samples are not taken again. The note is never critical (a broken file is ignored) and holds no secret. Behind the flag: with every flag off nothing is written.
 */
const MODELS = { planning: "claude-haiku-5-5", execution: "claude-haiku-5-5" };
const SAMPLE_CODE = "return inputs.call_0001.output.data.items.map(t => ({ id: t.id, text: t.text, url: t.url, author: t.author, date: t.createdAt }))";

function setup(driver: ModelDriver, flags: unknown) {
  const store = createMemoryStore();
  store.settings.redesign_flags = flags;
  const money = fakeMoneyClient();
  const rec = fakeRecorder();
  const call = vi.fn(async () => pages(1)[0]);
  const deps: RunnerDeps = { store, client: money.client, catalog: loadTregCatalog(), driver, recorder: rec.recorder, commit: rec.commit, call: call as any, models: MODELS, resolveAccess: async () => NOT_ADMIN, notify: async () => undefined };
  store.missions.set("msn_pr1", newMission({ id: "msn_pr1", user_id: USER_ID, request_text: "هات ٣٠٠ تغريدة عن محمد صلاح", status: "planning", worker_id: "w1", lease_until: new Date(Date.now() + 60_000).toISOString() }));
  return { store, deps, call };
}

/** Run one: the first four steps of the standard X planning (a note, a search, the description, the paid sample), then the worker's memory guard stops it. */
const killedAtTurnFour = (): ModelDriver => {
  const fake = createFakeDriver(planning().slice(0, 4), { stopAfterTerminal: false });
  return { run: async (input: RunInput) => ({ ...(await fake.run(input)), stop: "memory" }) };
};
/** Run two: what the model does once it is told what it already did: the mapping on the saved page, then the plan. */
const resumed = () => {
  const prompts: string[] = [];
  const steps = planning();
  const runCode: FakeStep = { tool: "run_code", args: { code: SAMPLE_CODE, files: ["call_0001"] } };
  const propose: FakeStep = { tool: "propose_plan", args: (r) => (steps[5].args as (x: unknown) => Record<string, unknown>)([{ tool: "treg_call", result: { ok: true, call_id: "call_0001" } }, ...r]) };
  const fake = createFakeDriver([runCode, propose]);
  const driver: ModelDriver = { run: async (input: RunInput) => { prompts.push(input.userPrompt); return fake.run(input); } };
  return { driver, prompts };
};

describe("a planning killed by the memory guard resumes without paying for its samples again", () => {
  it("flag on: the state is saved after each tool, the second run is told what was done, takes no second paid sample, and reaches the plan", async () => {
    const t = setup(killedAtTurnFour(), { social_posts: "on" });
    await runMissionSafely(t.deps, t.store.missions.get("msn_pr1")!);
    expect(t.store.missions.get("msn_pr1")!.status).toBe("queued");
    expect(t.call).toHaveBeenCalledTimes(1);
    // what run one left in the mission's folder
    const saved = await readPlanningState(t.store, "msn_pr1");
    expect(saved).not.toBeNull();
    expect(saved!.tried).toContain(ENDPOINT);
    expect(saved!.samples[ENDPOINT]).toHaveLength(1);
    expect(saved!.callParams["call_0001"]).toMatchObject({ query: "محمد صلاح" });
    expect(saved!.described).toContain(ENDPOINT);
    // run two
    const second = resumed();
    t.deps.driver = second.driver;
    t.store.missions.get("msn_pr1")!.status = "planning";
    await runMissionSafely(t.deps, t.store.missions.get("msn_pr1")!);
    expect(t.call).toHaveBeenCalledTimes(1);
    expect(second.prompts[0]).toContain(ENDPOINT);
    expect(second.prompts[0]).toMatch(/already (?:did|tried|sampled)/i);
    expect(t.store.missions.get("msn_pr1")!.status).toBe("plan_ready");
  });
  it("the saved note holds no secret: a key, a token, a password or an authorization header in the inputs is dropped, and its size is bounded", async () => {
    const steps: FakeStep[] = planning().slice(0, 4).map((s) => (s.tool === "treg_call" ? { tool: "treg_call", args: (r: unknown) => { const a = (typeof s.args === "function" ? (s.args as (x: unknown) => Record<string, unknown>)(r) : s.args) as Record<string, any>; return { ...a, params: { ...a.params, api_key: "sk-live-SECRET-VALUE", token: "tok-SECRET", Authorization: "Bearer SECRET" } }; } } as FakeStep : s));
    const fake = createFakeDriver(steps, { stopAfterTerminal: false });
    const t = setup({ run: async (i: RunInput) => ({ ...(await fake.run(i)), stop: "memory" }) }, { social_posts: "on" });
    await runMissionSafely(t.deps, t.store.missions.get("msn_pr1")!);
    const raw = String(t.store.files.get(`msn_pr1/${PLANNING_STATE_FILE}`) ?? "");
    expect(raw.length).toBeGreaterThan(10);
    expect(raw).not.toMatch(/SECRET|sk-live|Bearer/);
    expect(raw.length).toBeLessThan(60_000);
  });
  it("a corrupt note is ignored: the run starts from nothing and never fails", async () => {
    const t = setup(killedAtTurnFour(), { social_posts: "on" });
    await t.store.putFile("msn_pr1", PLANNING_STATE_FILE, "{not json", "application/json");
    await runMissionSafely(t.deps, t.store.missions.get("msn_pr1")!);
    expect(t.store.missions.get("msn_pr1")!.status).toBe("queued");
  });
  it("flags off (the default): nothing is written and nothing is read", async () => {
    const t = setup(killedAtTurnFour(), {});
    await runMissionSafely(t.deps, t.store.missions.get("msn_pr1")!);
    expect(t.store.files.has(`msn_pr1/${PLANNING_STATE_FILE}`)).toBe(false);
  });
});
