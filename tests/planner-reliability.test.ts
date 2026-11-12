import { describe, expect, it, vi } from "vitest";
import { classifyNoCardEnd, INTERNAL_PLANNING_AR, UNSUPPORTED_AR } from "../src/lib/agentMission/refusal";
import { sampleRowsDiagnosis, yieldFromDiagnosis } from "../src/lib/agentMission/plan";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { createFakeDriver, type FakeStep } from "../agent/src/fakeDriver";
import { createMemoryStore, newMission } from "../agent/src/memoryStore";
import { runPlanning, type RunnerDeps } from "../agent/src/runMission";
import { NOT_ADMIN, POSTS_ENDPOINT, USER_ID, fakeRecorder, postsPage, tregResult } from "./helpers/agentHarness";
import { fakeMoneyClient } from "./helpers/agentMoney";
import type { TregCallResult } from "../src/functions/shared/tregClient";

/**
 * PLANNER RELIABILITY (docs/DIGER-INTELLIGENCE-FINAL-ACCEPTANCE.md, defects B and C), OFFLINE. The real planner's plans were refused again and again for yield_from and sample rows, then it gave up, and the customer read «our sources do
 * not serve this» although the sources had answered with rows. Now (1) every such refusal says WHAT the cited output holds, and (2) a give-up after formal refusals is OUR failure (admin flagged), never «not served». The validator is unchanged.
 */
vi.stubGlobal("fetch", () => { throw new Error("a real network call was attempted"); });

describe("the reason of a yield_from / sample-row refusal is explicit (the same rule, never weaker)", () => {
  it("no yield_from, a call id, an unknown id, an object, an empty array, non-objects", () => {
    expect(yieldFromDiagnosis("", null)).toMatch(/gave no yield_from/);
    expect(yieldFromDiagnosis("call_0001", null)).toMatch(/not an output id/);
    expect(yieldFromDiagnosis("out_0009", null)).toMatch(/not an output of this mission/);
    expect(yieldFromDiagnosis("out_0002", JSON.stringify({ rows: [{ a: 1 }], count: 1 }))).toMatch(/JSON OBJECT \(keys: rows, count\).*return the «rows» array itself/);
    expect(yieldFromDiagnosis("out_0002", "[]")).toMatch(/EMPTY array/);
    expect(yieldFromDiagnosis("out_0002", "[1,2]")).toMatch(/not all objects/);
    expect(yieldFromDiagnosis("out_0002", "not json")).toMatch(/not JSON/);
    expect(sampleRowsDiagnosis([], () => null)).toMatch(/cites no out_ id/);
  });
});

describe("a give-up after the planner's plans were refused for their FORM is our failure, never «our sources do not serve this»", () => {
  const real = (rows: number) => ({ phase: "planning", status: "ok", rows_returned: rows });
  it("classifier", () => {
    expect(classifyNoCardEnd({ claim: "unsupported", endedWithoutAnswer: false, calls: [real(5)], planRejections: { count: 3, last: "formal" } })).toEqual({ cls: "internal", reason: "plan_invalid_after_3_rejections" });
    // the data contradicted the request (no sampled row matched): an honest «not served» stays
    expect(classifyNoCardEnd({ claim: "unsupported", endedWithoutAnswer: false, calls: [real(5)], planRejections: { count: 2, last: "data" } }).cls).toBe("unsupported");
    // no rows were ever returned: refusals of form do not make it ours
    expect(classifyNoCardEnd({ claim: "unsupported", endedWithoutAnswer: false, calls: [real(0)], planRejections: { count: 1, last: "formal" } }).cls).toBe("unsupported");
    // no plan was proposed: unchanged
    expect(classifyNoCardEnd({ claim: "unsupported", endedWithoutAnswer: false, calls: [real(5)] }).cls).toBe("unsupported");
  });

  const REQUEST = "هات ٥ بوستات إكس عن غلاء الأسعار في مصر";
  async function plan(steps: FakeStep[], answers: TregCallResult[]) {
    const store = createMemoryStore();
    const money = fakeMoneyClient();
    const queue = [...answers];
    const call = vi.fn(async () => { const n = queue.shift(); if (!n) throw new Error("no fake answer left"); return n; });
    const rec = fakeRecorder();
    const deps: RunnerDeps = { store, client: money.client, catalog: loadTregCatalog(), driver: createFakeDriver(steps), recorder: rec.recorder, commit: rec.commit, call: call as never, models: { planning: "claude-haiku-5-5", execution: "claude-haiku-5-5" }, resolveAccess: async () => NOT_ADMIN, notify: async () => undefined };
    store.missions.set("msn_p", newMission({ id: "msn_p", user_id: USER_ID, status: "planning", request_text: REQUEST }));
    await runPlanning(deps, store.missions.get("msn_p")!);
    return { m: store.missions.get("msn_p")!, store, money };
  }
  const badPlan: FakeStep = { tool: "propose_plan", args: { summary_ar: "خطة لجمع ٥ منشورات عن غلاء الأسعار.", stages: [{ key: "posts", title_ar: "المنشورات", endpoint_id: POSTS_ENDPOINT, expected_rows: 5, parent_key: null, deliver: true, columns: [{ key: "text" }, { key: "url" }], measured_by: ["call_0001"], yield_from: "out_0042", relevance: { subject_ar: "غلاء الأسعار", terms: ["غلاء", "الأسعار"], text_columns: ["text"] } }] } };
  const giveUp: FakeStep = { tool: "finish", args: { outcome: "cannot_serve", kind: "unsupported", summary_ar: "لا أستطيع." } };

  it("end to end: rows sampled, the plan refused for its yield_from, then a give-up → failed (ours), admin flagged, nothing held", async () => {
    const r = await plan([
      { tool: "catalog_search", args: { words: ["posts", "search"], platform: "x", limit: 5 } },
      { tool: "treg_call", args: { endpoint_id: POSTS_ENDPOINT, params: { query: "غلاء", max_results: 5 }, why: "the fixture source is the one under test" } },
      badPlan, badPlan, giveUp, giveUp, giveUp,
    ], [tregResult(postsPage(5), 0.025)]);
    expect(r.m.status).toBe("failed");
    expect(r.m.error).toMatch(/^admin: planning_failed class=internal reason=plan_invalid_after_2_rejections/);
    expect(r.m.summary_ar).toBe(INTERNAL_PLANNING_AR);
    expect(r.m.summary_ar).not.toBe(UNSUPPORTED_AR);
    expect(r.store.events.some((e) => e.counts?.adm_flag === 1)).toBe(true);
    expect(r.money.calls).toHaveLength(0);
    expect(r.m.job_id ?? null).toBeNull();
  });
});
