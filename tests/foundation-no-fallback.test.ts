import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fallbackStageOf, isCompiledPlan, redesignStagesOf } from "../agent/src/redesign";
import type { PricedPlan } from "../src/lib/agentMission/plan";
import { REDESIGN_MODES, SOCIAL_PLATFORMS, type PlatformFlags, type RedesignFlags, type RedesignMode } from "../src/lib/agentMission/redesignFlags";

/**
 * F6, NO FALLBACK (docs/FOUNDATION-PLAN.md PR 2a acceptance 6), over the structure of all 20 stored plans (tests/fixtures/live/replay-missions.json): a plan the compiler built
 * runs the new engine whole under every combination of flags and accounts, and its fallback stage is never set; the same structure with one stage built by the model is not
 * trusted as compiled (today's rules decide it, unchanged).
 */
const fixture = JSON.parse(readFileSync(new URL("./fixtures/live/replay-missions.json", import.meta.url), "utf8")) as { missions: Array<{ id: string; stages: Array<{ key: string; parent_key: string | null; endpoint_id: string; planned: number }> }> };
const flagsOf = (m: RedesignMode): RedesignFlags => ({ social_posts: m, social_account: m, social_comments: m, companies: "off", people: "off", places: "off" });
const planOf = (m: (typeof fixture.missions)[number], compiled: boolean, modelStage = -1): PricedPlan => ({
  summary_ar: "", price: {} as PricedPlan["price"],
  stages: m.stages.map((s, i) => ({ key: s.key, parent_key: s.parent_key, endpoint_id: s.endpoint_id, planned_rows: s.planned, engine: { endpoint_id: s.endpoint_id, params: {}, cursor_param: null, map_code: "", map_file_id: "page", parent_binding: null, built_by: i === modelStage ? "model" : "code" } })) as unknown as PricedPlan["stages"],
  ...(compiled ? { compiled: { by: "compiler" as const, platform: "tiktok", promises: {} } } : {}),
});

describe("F6: a compiled plan can never run the old pipeline", () => {
  it("all 20 stored plan structures, compiled: every stage on the new engine, no fallback, for every type flag, every platform flag and both accounts", () => {
    expect(fixture.missions).toHaveLength(20);
    for (const m of fixture.missions) {
      const plan = planOf(m, true);
      expect(isCompiledPlan(plan)).toBe(true);
      for (const mode of REDESIGN_MODES) for (const pmode of REDESIGN_MODES) for (const isTest of [false, true]) {
        const platform: PlatformFlags = Object.fromEntries(SOCIAL_PLATFORMS.map((p) => [p, pmode]));
        expect([...redesignStagesOf(plan, flagsOf(mode), isTest, platform)].sort(), m.id).toEqual(m.stages.map((s) => s.key).sort());
        expect(fallbackStageOf(plan, flagsOf(mode), isTest, platform)).toBeNull();
      }
    }
  });

  it("the compiled mark on a plan with a model-built stage is not trusted: today's rules decide it, exactly as without the mark", () => {
    for (const m of fixture.missions) {
      const marked = planOf(m, true, 0);
      const plain = planOf(m, false, 0);
      expect(isCompiledPlan(marked)).toBe(false);
      for (const mode of REDESIGN_MODES) for (const isTest of [false, true]) {
        expect([...redesignStagesOf(marked, flagsOf(mode), isTest)]).toEqual([...redesignStagesOf(plain, flagsOf(mode), isTest)]);
        expect(fallbackStageOf(marked, flagsOf(mode), isTest)).toEqual(fallbackStageOf(plain, flagsOf(mode), isTest));
      }
    }
  });

  it("a stored plan without the mark keeps today's behaviour: off runs the old pipeline, test runs the new one for a test account only", () => {
    const m = fixture.missions.find((x) => x.id === "msn_5851abc92a1e6645a9cd")!;
    const plain = planOf(m, false);
    expect(redesignStagesOf(plain, flagsOf("off"), true).size).toBe(0);
    expect(redesignStagesOf(plain, flagsOf("test"), false).size).toBe(0);
    expect(redesignStagesOf(plain, flagsOf("test"), true).size).toBe(3);
  });
});
