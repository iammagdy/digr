import { readFileSync, existsSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createFakeDriver } from "../agent/src/fakeDriver";
import { createMemoryStore, newMission } from "../agent/src/memoryStore";
import { runPlanning, type RunnerDeps } from "../agent/src/runMission";
import { compiledPlatformActive } from "../agent/src/compiled";
import { COMPILED_PLATFORMS } from "../src/lib/agentMission/foundation/compilePlan";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { NAMED_SHORTFALL_OPTIONS_AR } from "../src/lib/agentMission/foundation/namedShortfall";
import { NOT_ADMIN, fakeRecorder, tregResult } from "./helpers/agentHarness";
import { fakeMoneyClient } from "./helpers/agentMoney";
import { inputKey, storedCalls } from "./helpers/replayGateway";

/**
 * PR 3, THE FLAGS (the per-platform keys of `redesign_flags`, no switch is changed): Facebook, Instagram and YouTube are compiled only when their OWN key is `on` (or `test` for a test account);
 * unset, today's path (the model plans) is byte for byte what it was. Through the REAL planning run and the REAL gateway, with the provider replaced by the stored pages.
 */
vi.stubGlobal("fetch", () => { throw new Error("a real network call was attempted"); });
const catalog = loadTregCatalog();
const fixture = JSON.parse(readFileSync(new URL("./fixtures/live/replay-missions.json", import.meta.url), "utf8")) as { missions: Array<{ id: string; request: string }> };
const OFF = { social_posts: "off", social_account: "off", social_comments: "off", companies: "off", people: "off", places: "off" };
const TEST_EMAIL = "iam.magdy+1@outlook.com";
const M17 = "msn_6bb78c15d116268b0b9b";
const M16 = "msn_e3e7632e2fb2d42f9c19";

function storedProvider(mission: string) {
  const byKey = new Map(storedCalls(mission).filter((c) => c[3] === "ok" || c[3] === "empty").map((c) => [inputKey(c[2], c[5]), c] as const));
  return vi.fn(async (o: { endpointId: string; params: Record<string, unknown> }) => {
    const c = byKey.get(inputKey(o.endpointId, o.params));
    const file = c ? new URL(`./fixtures/live/missions/${mission}/raw/${c[0]}.json`, import.meta.url) : null;
    if (!c || !file || !existsSync(file)) return tregResult(null, 0, { ok: false, httpStatus: 404, error: "not_found" });
    return tregResult(JSON.parse(readFileSync(file, "utf8")), Number(catalog.byId.get(o.endpointId)?.cost?.usd ?? 0.001));
  });
}

async function plan(fixtureMission: string, settings: Record<string, unknown>, email: string | null, answer: string | null = null) {
  const store = createMemoryStore();
  const id = "msn_pr3_1";
  store.missions.set(id, newMission({ id, user_id: "user_p3", request_text: fixture.missions.find((m) => m.id === fixtureMission)!.request, ...(answer ? { answer_text: answer } : {}), status: "planning", created_at: "2026-11-02T17:36:00Z" }));
  if (email) store.userEmails.set("user_p3", email);
  Object.assign(store.settings, settings);
  const rec = fakeRecorder();
  const call = storedProvider(fixtureMission);
  const driver = createFakeDriver([{ tool: "ask_question", args: { question_ar: "هل تقصد هذا؟", options_ar: ["نعم", "لا"] } }]);
  const run = vi.spyOn(driver, "run");
  const deps: RunnerDeps = { store, client: fakeMoneyClient().client, catalog, driver, recorder: rec.recorder, commit: rec.commit, call: call as any, models: { planning: "claude-haiku-5-5", execution: "claude-haiku-5-5" }, resolveAccess: async () => NOT_ADMIN };
  await runPlanning(deps, store.missions.get(id)!);
  return { mission: store.missions.get(id)!, store, call, modelRuns: run.mock.calls.length };
}

describe("PR 3: the compiled path is per platform, behind its own flag", () => {
  it("the compiled platforms are the five social ones", () => {
    expect([...COMPILED_PLATFORMS].sort()).toEqual(["facebook", "instagram", "tiktok", "x", "youtube"]);
  });

  it("each platform's flag switches only that platform", () => {
    for (const p of COMPILED_PLATFORMS) {
      expect(compiledPlatformActive({ [p]: "on" }, p, false)).toBe(true);
      expect(compiledPlatformActive({ [p]: "test" }, p, true)).toBe(true);
      expect(compiledPlatformActive({ [p]: "test" }, p, false)).toBe(false);
      expect(compiledPlatformActive({ [p]: "off" }, p, true)).toBe(false);
      expect(compiledPlatformActive({}, p, true)).toBe(false);
      for (const other of COMPILED_PLATFORMS.filter((o) => o !== p)) expect(compiledPlatformActive({ [other]: "on" }, p, true)).toBe(false);
    }
  });

  it("Instagram `test` on a test account: planned by the compiler (no model), through the gateway, plan_ready with a compiled card of three stages", async () => {
    const r = await plan(M16, { redesign_flags: { ...OFF, instagram: "test" } }, TEST_EMAIL);
    expect(r.modelRuns).toBe(0);
    expect(r.mission.status).toBe("plan_ready");
    expect(r.mission.plan!.compiled?.by).toBe("compiler");
    expect(r.mission.plan!.stages.map((s) => s.endpoint_id)).toEqual(["scrapecreators.instagram.user.posts", "anyapi.instagram.post.comments", "anyapi.instagram.comment_replies"]);
    expect(r.store.calls.every((c) => c.phase === "planning")).toBe(true);
    const pub = JSON.stringify(r.mission.plan_public);
    expect(pub).not.toMatch(/scrapecreators|anyapi|tikhub|crawl4ai|justoneapi|usd|\$/i);
  });

  it("Instagram unset (inherit), or `test` on an account that is not a test account, or every flag off: today's path (the model plans)", async () => {
    for (const [settings, email] of [[{ redesign_flags: { ...OFF, social_posts: "test", social_account: "test", social_comments: "test" } }, TEST_EMAIL], [{ redesign_flags: { ...OFF, instagram: "test" } }, "someone@example.com"], [{}, TEST_EMAIL]] as const) {
      const r = await plan(M16, settings as Record<string, unknown>, email);
      expect(r.modelRuns).toBe(1);
      expect(r.mission.plan?.compiled).toBeUndefined();
    }
  });

  it("Facebook `test` on a test account, a named page with too few posts: a question card before approval (nothing priced), the model never runs, and the three answers are stored with it", async () => {
    const r = await plan(M17, { redesign_flags: { ...OFF, facebook: "test" } }, TEST_EMAIL);
    expect(r.modelRuns).toBe(0);
    expect(r.mission.status).toBe("needs_input");
    expect(r.mission.plan).toBeNull();
    expect(r.mission.reserved_points ?? 0).toBe(0);
    expect((r.mission.plan_public as { question_options?: string[] } | null)?.question_options).toEqual([NAMED_SHORTFALL_OPTIONS_AR.onlyFound, NAMED_SHORTFALL_OPTIONS_AR.fill, NAMED_SHORTFALL_OPTIONS_AR.cancel]);
    expect(r.store.events.some((e) => e.kind === "question")).toBe(true);
  });

  it("the answer «fill» plans it (posts marked), the answer «cancel» ends the mission before any read and nothing is held", async () => {
    const fill = await plan(M17, { redesign_flags: { ...OFF, facebook: "test" } }, TEST_EMAIL, NAMED_SHORTFALL_OPTIONS_AR.fill);
    expect(fill.mission.status).toBe("plan_ready");
    expect(fill.mission.plan!.stages[0].endpoint_id).toBe("justoneapi.x.facebook-search-post-v1");
    const cancel = await plan(M17, { redesign_flags: { ...OFF, facebook: "test" } }, TEST_EMAIL, NAMED_SHORTFALL_OPTIONS_AR.cancel);
    expect(cancel.mission.status).toBe("cancelled");
    expect(cancel.call).not.toHaveBeenCalled();
    expect(cancel.modelRuns).toBe(0);
  });
});
