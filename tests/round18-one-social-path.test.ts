import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryStore, newMission } from "../agent/src/memoryStore";
import { runPlanning } from "../agent/src/runMission";
import { fakeMoneyClient } from "./helpers/agentMoney";
import { fakeRecorder, NOT_ADMIN, USER_ID } from "./helpers/agentHarness";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { approveForCustomer } from "../src/lib/agentMission/customerActions";
import { EXPIRED_SOCIAL_PLAN_AR, isStaleSocialPlan } from "../src/lib/agentMission/staleSocialPlan";
import { SOCIAL_NOT_OFFERED_AR } from "../src/lib/agentMission/foundation/namedShortfall";
import { modelPlanningForTests, setModelPlanningForTests } from "../src/lib/agentMission/testSeam";

/**
 * ROUND 18, PR B: ONE PATH FOR SOCIAL. (1) a platform switched to «إيقاف» is not offered: the customer is told before any planning call; (2) the approval guard: a social plan the compiler did not build is refused BEFORE any reserve;
 * (3) the test seam (src/lib/agentMission/testSeam.ts) cannot be enabled by any production code.
 */
const social = (compiled: boolean) => ({ summary_ar: "x", stages: [{ key: "posts", endpoint_id: "scrapecreators.instagram.user.posts", capability: "instagram.user.posts", engine: { built_by: compiled ? "code" : "model" } }], ...(compiled ? { compiled: { by: "compiler", platform: "instagram", promises: {} } } : {}) }) as never;

describe("seam off (the production behaviour) for the tests of this file", () => {
  beforeEach(() => setModelPlanningForTests(false));
  afterEach(() => setModelPlanningForTests(true));

  it("a social platform set to «إيقاف» shows the not-offered message before any planning call: no source is read, no model is paid, nothing is held", async () => {
    for (const mode of ["off", undefined] as const) {
      const store = createMemoryStore();
      store.settings.redesign_flags = { instagram: mode ?? undefined, social_posts: "on", social_account: "on", social_comments: "on" };
      store.missions.set("msn_off", newMission({ id: "msn_off", user_id: USER_ID, status: "planning", request_text: "هات منشورين من حساب الحدث على إنستجرام (alhadath)، مع كل التعليقات." }));
      const driver = { run: vi.fn(async () => { throw new Error("the model must not be called"); }) };
      const call = vi.fn(async () => { throw new Error("no provider call"); });
      const rec = fakeRecorder();
      await runPlanning({ store, client: fakeMoneyClient().client, catalog: loadTregCatalog(), driver, recorder: rec.recorder, commit: rec.commit, call: call as never, models: { planning: "claude-haiku-5-5", execution: "claude-haiku-5-5" }, resolveAccess: async () => NOT_ADMIN } as never, store.missions.get("msn_off")!);
      const m = store.missions.get("msn_off")!;
      expect(m.status, String(mode)).toBe("unserved");
      expect(m.summary_ar).toBe(SOCIAL_NOT_OFFERED_AR);
      expect(driver.run).not.toHaveBeenCalled();
      expect(call).not.toHaveBeenCalled();
      expect(store.calls).toHaveLength(0);
      expect(SOCIAL_NOT_OFFERED_AR).not.toMatch(/[A-Za-z]|USD/);
    }
  });

  it("a request that is not social is not touched by the gate (companies and places keep their own path)", async () => {
    const store = createMemoryStore();
    store.missions.set("msn_co", newMission({ id: "msn_co", user_id: USER_ID, status: "planning", request_text: "عايز ٥٠ شركة مقاولات في مصر" }));
    const driver = { run: vi.fn(async () => ({ llmCostUsd: 0, turns: 1, stop: "end", usage: { input_tokens: 1, output_tokens: 1 } })) };
    const rec = fakeRecorder();
    await runPlanning({ store, client: fakeMoneyClient().client, catalog: loadTregCatalog(), driver, recorder: rec.recorder, commit: rec.commit, call: (async () => { throw new Error("no call"); }) as never, models: { planning: "claude-haiku-5-5", execution: "claude-haiku-5-5" }, resolveAccess: async () => NOT_ADMIN } as never, store.missions.get("msn_co")!);
    expect(driver.run).toHaveBeenCalled();
  });

  it("THE APPROVAL GUARD: a social plan the compiler did not build is refused with the expiry sentence BEFORE any reserve (no money function is called)", async () => {
    expect(EXPIRED_SOCIAL_PLAN_AR).toBe("انتهت صلاحية هذه الخطة؛ اطلب البحث من جديد ولن يُخصم منك شيء.");
    expect(isStaleSocialPlan(social(false))).toBe(true);
    expect(isStaleSocialPlan(social(true))).toBe(false);
    expect(isStaleSocialPlan({ stages: [{ key: "c", endpoint_id: "x.companies.search", capability: "companies.search", engine: { built_by: "model" } }] } as never)).toBe(false);
    const rpc = vi.fn(async () => { throw new Error("a money function was called"); });
    const mk = (plan: unknown) => ({ rpc, from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: "m", user_id: "u", status: "plan_ready", plan } }) }) }) }) });
    const r = await approveForCustomer(mk(social(false)) as never, { id: "m", userId: "u", isGuest: false, emailVerified: true });
    expect(r).toMatchObject({ ok: false, status: 410, error: EXPIRED_SOCIAL_PLAN_AR });
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("the test seam can be enabled by no production code", () => {
  const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = path.join(dir, f); return statSync(p).isDirectory() ? (f === "node_modules" ? [] : files(p)) : /\.(ts|tsx)$/.test(f) ? [p] : []; });
  it("setModelPlanningForTests is named only in the seam itself and in tests/; it is off by default", () => {
    const root = path.resolve(__dirname, "..");
    const users = [...files(path.join(root, "src")), ...files(path.join(root, "agent", "src"))].filter((p) => readFileSync(p, "utf8").includes("setModelPlanningForTests"));
    expect(users.map((p) => path.relative(root, p))).toEqual(["src/lib/agentMission/testSeam.ts"]);
    expect(modelPlanningForTests()).toBe(true); // on here only because tests/setup/legacyModelPlanning.ts turned it on for this process
    const fresh = readFileSync(path.join(root, "src/lib/agentMission/testSeam.ts"), "utf8");
    expect(fresh).toContain("let modelPlanning = false;");
  });
});
