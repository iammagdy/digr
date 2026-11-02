import { readFileSync, existsSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createFakeDriver } from "../agent/src/fakeDriver";
import { createMemoryStore, newMission } from "../agent/src/memoryStore";
import { runPlanning, type RunnerDeps } from "../agent/src/runMission";
import { compiledPlatformActive } from "../agent/src/compiled";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { checkCustomerText } from "../src/lib/agentMission/text";
import type { RedesignFlags } from "../src/lib/agentMission/redesignFlags";
import { NOT_ADMIN, fakeRecorder, tregResult } from "./helpers/agentHarness";
import { fakeMoneyClient } from "./helpers/agentMoney";
import { inputKey, storedCalls } from "./helpers/replayGateway";

/**
 * THE COMPILED PATH IN THE REAL PLANNING RUN (agent/src/runMission.ts), through the REAL gateway: the provider call is replaced by the stored real pages (only for the same
 * endpoint and inputs as the stored call), so every cap of the gateway, the call log and the planning budget are the live ones. Behind the per-platform flag only.
 */
vi.stubGlobal("fetch", () => { throw new Error("a real network call was attempted"); });
const catalog = loadTregCatalog();
const fixture = JSON.parse(readFileSync(new URL("./fixtures/live/replay-missions.json", import.meta.url), "utf8")) as { missions: Array<{ id: string; request: string }> };
const OFF = { social_posts: "off", social_account: "off", social_comments: "off", companies: "off", people: "off", places: "off" };
const TEST_EMAIL = "iam.magdy+1@outlook.com";

/** A provider that answers only with a stored page of `mission` for the same endpoint and inputs. */
function storedProvider(mission: string) {
  const byKey = new Map(storedCalls(mission).filter((c) => c[3] === "ok" || c[3] === "empty").map((c) => [inputKey(c[2], c[5]), c] as const));
  return vi.fn(async (o: { endpointId: string; params: Record<string, unknown> }) => {
    const c = byKey.get(inputKey(o.endpointId, o.params));
    const file = c ? new URL(`./fixtures/live/missions/${mission}/raw/${c[0]}.json`, import.meta.url) : null;
    if (!c || !file || !existsSync(file)) return tregResult(null, 0, { ok: false, httpStatus: 404, error: "not_found" });
    return tregResult(JSON.parse(readFileSync(file, "utf8")), Number(catalog.byId.get(o.endpointId)?.cost?.usd ?? 0.001));
  });
}

async function plan(fixtureMission: string, settings: Record<string, unknown>, email: string | null) {
  const store = createMemoryStore();
  const id = "msn_compiled_1";
  store.missions.set(id, newMission({ id, user_id: "user_c", request_text: fixture.missions.find((m) => m.id === fixtureMission)!.request, status: "planning" }));
  if (email) store.userEmails.set("user_c", email);
  Object.assign(store.settings, settings);
  const rec = fakeRecorder();
  const call = storedProvider(fixtureMission);
  const driver = createFakeDriver([{ tool: "ask_question", args: { question_ar: "هل تقصد هذا؟", options_ar: ["نعم", "لا"] } }]);
  const run = vi.spyOn(driver, "run");
  const deps: RunnerDeps = { store, client: fakeMoneyClient().client, catalog, driver, recorder: rec.recorder, commit: rec.commit, call: call as any, models: { planning: "claude-haiku-5-5", execution: "claude-haiku-5-5" }, resolveAccess: async () => NOT_ADMIN };
  await runPlanning(deps, store.missions.get(id)!);
  return { mission: store.missions.get(id)!, store, call, modelRuns: run.mock.calls.length };
}

const M12 = "msn_5851abc92a1e6645a9cd";
describe("the compiled path runs only behind the platform's OWN flag", () => {
  it("TikTok flag `test` on a test account: planned by the compiler, no model run, through the gateway (3 real-page reads), plan_ready with a compiled card", async () => {
    const r = await plan(M12, { redesign_flags: { ...OFF, tiktok: "test" } }, TEST_EMAIL);
    expect(r.modelRuns).toBe(0);
    expect(r.mission.status).toBe("plan_ready");
    expect(r.mission.plan!.compiled?.by).toBe("compiler");
    expect(r.mission.plan!.stages.map((s) => s.endpoint_id)).toEqual(["tikhub.tiktok.search.videos", "anyapi.tiktok.video.comments", "anyapi.tiktok.comment_replies"]);
    expect(r.call).toHaveBeenCalledTimes(3);
    // every call is in the call log, as planning calls
    expect(r.store.calls.map((c) => [c.endpoint_id, c.status, c.phase])).toEqual([["tikhub.tiktok.search.videos", "ok", "planning"], ["anyapi.tiktok.video.comments", "ok", "planning"], ["anyapi.tiktok.video.comments", "ok", "planning"]]);
    expect(r.store.events.find((e) => e.message_ar === "قياس داخلي: خطة مبنية بالكود.")?.counts).toEqual({ compiled: 1, pool_reads: 1, exposure_reads: 2 });
    // the customer's card: Arabic only, no provider, no endpoint, no USD
    const pub = JSON.stringify(r.mission.plan_public);
    expect(pub).not.toMatch(/tikhub|anyapi|crawl4ai|usd|\$/i);
    for (const line of [r.mission.plan!.summary_ar, ...(r.mission.plan!.notes_ar ?? [])]) expect(checkCustomerText(line, { maxChars: 400 }).issues).toEqual([]);
  });

  it("TikTok flag `on`: any account is compiled", async () => {
    const r = await plan(M12, { redesign_flags: { ...OFF, tiktok: "on" } }, null);
    expect(r.modelRuns).toBe(0);
    expect(r.mission.plan!.compiled?.by).toBe("compiler");
  });

  it("TikTok flag `test` on an account that is not a test account: today's path (the model plans), nothing compiled", async () => {
    const r = await plan(M12, { redesign_flags: { ...OFF, tiktok: "test" } }, "someone@example.com");
    expect(r.modelRuns).toBe(1);
    expect(r.mission.plan?.compiled).toBeUndefined();
    expect(r.store.events.some((e) => e.message_ar === "قياس داخلي: خطة مبنية بالكود.")).toBe(false);
  });

  it("today's type flags on, the platform flag unset (inherit): today's path, nothing compiled", async () => {
    const r = await plan(M12, { redesign_flags: { ...OFF, social_posts: "test", social_account: "test", social_comments: "test" } }, TEST_EMAIL);
    expect(r.modelRuns).toBe(1);
    expect(r.store.events.some((e) => e.message_ar === "قياس داخلي: خطة مبنية بالكود.")).toBe(false);
  });

  it("every flag off: today's path", async () => {
    const r = await plan(M12, {}, TEST_EMAIL);
    expect(r.modelRuns).toBe(1);
    expect(r.mission.status).toBe("needs_input");
  });

  it("the X flag does not compile TikTok, and the TikTok flag does not compile X; Facebook, Instagram and YouTube are never compiled in PR 2a", () => {
    expect(compiledPlatformActive({ x: "on" }, "tiktok", true)).toBe(false);
    expect(compiledPlatformActive({ tiktok: "on" }, "x", true)).toBe(false);
    for (const p of ["facebook", "instagram", "youtube"] as const) expect(compiledPlatformActive({ [p]: "on" }, p, true)).toBe(false);
    expect(compiledPlatformActive({}, "tiktok", true)).toBe(false);
    expect(compiledPlatformActive(undefined, "tiktok", true)).toBe(false);
  });

  it("F6: an X request on the compiled path whose pool cannot be read ends honestly; the model never plans it", async () => {
    const r = await plan("msn_b060d3347ed7660f972e", { redesign_flags: { ...OFF, x: "test" } as unknown as RedesignFlags }, TEST_EMAIL);
    expect(r.modelRuns).toBe(0);
    expect(r.mission.plan).toBeNull();
    expect(["unserved", "failed"]).toContain(r.mission.status);
    expect(r.store.events.find((e) => e.message_ar === "قياس داخلي: خطة مبنية بالكود.")?.counts).toEqual({ compiled: 0, pool_reads: 1, exposure_reads: 0 });
  });
});
