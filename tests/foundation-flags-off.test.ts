import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createFakeDriver } from "../agent/src/fakeDriver";
import { createMemoryStore, newMission } from "../agent/src/memoryStore";
import { runPlanning, type RunnerDeps } from "../agent/src/runMission";
import { fallbackStageOf, redesignStagesOf } from "../agent/src/redesign";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import type { PricedPlan } from "../src/lib/agentMission/plan";
import type { RedesignFlags } from "../src/lib/agentMission/redesignFlags";
import { NOT_ADMIN, fakeRecorder, tregResult } from "./helpers/agentHarness";
import { fakeMoneyClient } from "./helpers/agentMoney";

/**
 * FLAGS OFF, BYTE FOR BYTE (docs/FOUNDATION-PLAN.md PR 2a; this file imports nothing PR 2a added, so it runs as it is on `main`): for each of the 20 stored requests
 * the whole planning run (the tools the model is given, every tool answer, the provider call, the call log, the events, the mission's final record) and the engine selector
 * over the 20 stored plans are digested, with every flag off AND with today's type flags on and the platform flags unset. The expected digests were written by this file run
 * on `main` = 1b4049a (`WRITE_FLAGS_OFF_DIGESTS=1`), before any PR 2a code existed: tests/fixtures/foundation-flags-off.json. The compiled path must change none of them.
 */
vi.stubGlobal("fetch", () => { throw new Error("a real network call was attempted"); });
const fixture = JSON.parse(readFileSync(new URL("./fixtures/live/replay-missions.json", import.meta.url), "utf8")) as { missions: Array<{ id: string; cairo: string; request: string; stages: Array<{ key: string; parent_key: string | null; endpoint_id: string; planned: number; params?: Record<string, unknown> }> }> };
const DIGESTS = new URL("./fixtures/foundation-flags-off.json", import.meta.url);
const OFF = { social_posts: "off", social_account: "off", social_comments: "off", companies: "off", people: "off", places: "off" } as RedesignFlags;
const TYPES_TEST = { social_posts: "test", social_account: "test", social_comments: "test", companies: "off", people: "off", places: "off" } as RedesignFlags;
const TEST_EMAIL = "iam.magdy+1@outlook.com";
const sha = (v: unknown): string => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 16);
const PLATFORM_WORD: Record<string, string> = { tiktok: "tiktok", x: "x", youtube: "youtube", instagram: "instagram", facebook: "facebook" };

async function planningDigest(m: { id: string; request: string }, settings: Record<string, unknown>): Promise<string> {
  const store = createMemoryStore();
  store.missions.set(m.id, newMission({ id: m.id, user_id: "user_flags_off", request_text: m.request, status: "planning" }));
  store.userEmails.set("user_flags_off", TEST_EMAIL);
  Object.assign(store.settings, settings);
  const rec = fakeRecorder();
  const call = vi.fn(async () => tregResult({ output: { data: { items: [{ id: "1", text: "نص", url: "https://x.com/a/status/1" }] } } }, 0.001));
  const platform = /تيك/.test(m.request) ? "tiktok" : /يوتيوب/.test(m.request) ? "youtube" : /فيسبوك/.test(m.request) ? "facebook" : /إنستجرام/.test(m.request) ? "instagram" : "x";
  const endpoint = { tiktok: "tikhub.tiktok.search.videos", youtube: "crawl4ai.youtube.search.videos", facebook: "anyapi.facebook.user.posts", instagram: "scrapecreators.instagram.user.posts", x: "anyapi.x.search.posts" }[platform]!;
  const driver = createFakeDriver([
    { tool: "catalog_search", args: { words: ["posts", "search"], platform: PLATFORM_WORD[platform] } },
    { tool: "describe_endpoint", args: { endpoint_id: endpoint } },
    { tool: "treg_call", args: { endpoint_id: endpoint, params: { query: "ذكاء", keyword: "ذكاء", url: "https://www.facebook.com/AlArabiya", handle: "alhadath" }, why: "the source this request names in its own words" } },
    { tool: "ask_question", args: { question_ar: "هل تقصد هذا المعنى؟", options_ar: ["نعم", "لا"] } },
  ], { stopAfterTerminal: true });
  const deps: RunnerDeps = { store, client: fakeMoneyClient().client, catalog: loadTregCatalog(), driver, recorder: rec.recorder, commit: rec.commit, call: call as any, models: { planning: "claude-haiku-5-5", execution: "claude-haiku-5-5" }, resolveAccess: async () => NOT_ADMIN };
  await runPlanning(deps, store.missions.get(m.id)!);
  const mission = store.missions.get(m.id)!;
  return sha({
    tools: driver.results.map((r) => r.tool),
    results: driver.results.map((r) => r.result),
    providerCalls: call.mock.calls.map((c) => { const o = (c as unknown[])[0] as Record<string, unknown>; return { endpointId: o.endpointId, params: o.params }; }),
    callLog: store.calls.map((c) => ({ endpoint: c.endpoint_id, status: c.status, rows: c.rows_returned, params: c.params_digest, phase: c.phase })),
    // the one value that changes from run to run on any commit: the worker's memory at a turn (process.memoryUsage), a telemetry count, not an output
    events: store.events.map((e) => ({ kind: e.kind, message: e.message_ar, counts: e.counts ? Object.fromEntries(Object.entries(e.counts).filter(([k]) => k !== "turn_rss_mb")) : null })),
    mission: { status: mission.status, question: mission.question_ar, plan: mission.plan, plan_public: mission.plan_public, error: mission.error ?? null, summary: mission.summary_ar ?? null },
  });
}

function selectorDigest(m: (typeof fixture.missions)[number]): string {
  const plan = { stages: m.stages.map((s) => ({ key: s.key, parent_key: s.parent_key, endpoint_id: s.endpoint_id, planned_rows: s.planned, engine: { endpoint_id: s.endpoint_id, params: s.params ?? {}, built_by: "code" } })) } as unknown as PricedPlan;
  const out: unknown[] = [];
  for (const flags of [OFF, TYPES_TEST]) for (const isTest of [false, true]) out.push([[...redesignStagesOf(plan, flags, isTest)].sort(), fallbackStageOf(plan, flags, isTest)]);
  return sha(out);
}

async function digests(): Promise<Record<string, Record<string, string>>> {
  const out: Record<string, Record<string, string>> = {};
  for (const m of fixture.missions) {
    out[m.id] = {
      planning_flags_off: await planningDigest(m, {}),
      planning_type_flags_test: await planningDigest(m, { redesign_flags: TYPES_TEST }),
      selector: selectorDigest(m),
    };
  }
  return out;
}

describe("flags off (and today's type flags with no platform flag): the 20 stored requests and plans give exactly what main gave", () => {
  it("every digest equals the one written on main before PR 2a", async () => {
    const now = await digests();
    if (process.env.WRITE_FLAGS_OFF_DIGESTS === "1") { writeFileSync(DIGESTS, `${JSON.stringify({ _about: "Written on main = 1b4049a by tests/foundation-flags-off.test.ts (WRITE_FLAGS_OFF_DIGESTS=1), before PR 2a.", missions: now }, null, 1)}\n`); return; }
    expect(existsSync(DIGESTS)).toBe(true);
    const expected = (JSON.parse(readFileSync(DIGESTS, "utf8")) as { missions: Record<string, Record<string, string>> }).missions;
    expect(Object.keys(now).length).toBe(20);
    expect(now).toEqual(expected);
  }, 180_000);
});
