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

import { plannerCapabilitySection, toolHint, buildCapabilityRegistry, discoverCapabilities, researchNeedOf } from "../src/lib/agentMission/capabilities";
import { blockedEndpointReason } from "../src/lib/treg/blockList";
import { policyVerdict } from "../src/lib/treg/dataPolicy";
import { validateAndPricePlan } from "../src/lib/agentMission/plan";

describe("round 51: the planner is told WHICH TOOL calls each provider's capability (it called parser ids with treg_call and fell back to the catalog)", () => {
  it("tool hints for every web-provider id; none for catalog ids", () => {
    expect(toolHint("contextdev.parse.google-maps-reviews")).toBe('parse_page {parser:"google-maps-reviews", url}');
    expect(toolHint("firecrawl.search")).toBe('web_search {provider:"firecrawl", query}');
    expect(toolHint("contextdev.scrape")).toBe('web_scrape {provider:"contextdev", url}');
    expect(toolHint("contextdev.people.search")).toBe("people_search {query}");
    expect(toolHint("crawl4ai.google.maps.reviews")).toBeNull();
  });
  it("the capability section marks them and says one plan may combine providers", () => {
    const reg = buildCapabilityRegistry(loadTregCatalog(), { isAllowed: (id) => !blockedEndpointReason(id) && policyVerdict(id, null).allowed, webKeys: { firecrawl: true, contextdev: true } });
    const text = plannerCapabilitySection(discoverCapabilities(researchNeedOf({ request: "عايز تقييمات فنادق الغردقة" }), reg));
    expect(text).toContain('contextdev.parse.google-maps-reviews [contextdev; call with parse_page {parser:"google-maps-reviews", url}]');
    expect(text).toMatch(/One plan may combine sources of different providers/);
  });
  it("treg_call on a web-provider id is refused with the right tool, nothing called", async () => {
    const store = createMemoryStore();
    const call = vi.fn();
    const rec = fakeRecorder();
    const deps: RunnerDeps = { store, client: fakeMoneyClient().client, catalog: loadTregCatalog(), driver: createFakeDriver([{ tool: "treg_call", args: { endpoint_id: "contextdev.parse.google-maps-reviews", params: { url: "https://maps.google.com/?cid=1" } } }, { tool: "finish", args: { outcome: "cannot_serve", kind: "unsupported", summary_ar: "لا." } }]), recorder: rec.recorder, commit: rec.commit, call: call as never, models: { planning: "claude-haiku-5-5", execution: "claude-haiku-5-5" }, resolveAccess: async () => NOT_ADMIN, notify: async () => undefined };
    store.missions.set("msn_w", newMission({ id: "msn_w", user_id: USER_ID, status: "planning", request_text: "عايز تقييمات فنادق الغردقة" }));
    const driver = deps.driver as ReturnType<typeof createFakeDriver>;
    await runPlanning(deps, store.missions.get("msn_w")!);
    expect(call).not.toHaveBeenCalled();
    expect(driver.results[0].result).toMatchObject({ ok: false });
    expect(String(driver.results[0].result.error)).toMatch(/web provider source, not a catalog endpoint: call it with parse_page \{parser:"google-maps-reviews", url\}/);
  });
  it("a column whose key code does not know and has no title: the rejection says what to do", () => {
    const r = validateAndPricePlan({ summary_ar: "خطة.", stages: [{ key: "places", title_ar: "الفنادق", endpoint_id: "crawl4ai.google.serp.maps", expected_rows: 5, parent_key: null, deliver: true, columns: [{ key: "maps_url" }], measured_by: [] }] }, { call: () => null, evidenceText: () => null, endpointAllowed: () => true } as never);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.join(" ")).toMatch(/column «maps_url»: code has no Arabic title for this key, so give it `title_ar`/);
  });
});

describe("round 51 (real planner, Z14): the phones of PLACES are their listing's phone, not a company contact stage", () => {
  const lookup = {
    call: (id: string) => (id === "call_0001" ? { id, endpointId: "crawl4ai.google.serp.maps", ok: true, costUsd: 0.01, rows: 10 } : null),
    evidenceText: (id: string) => (id === "call_0001" ? JSON.stringify([{ name: "مطعم الريادة", phone: "+201020000000", address: "شارع النخبة، المهندسين، الجيزة", rating: 4.2 }]) : null),
    endpointAllowed: () => true,
    endpointCapability: () => "google.serp.maps",
    isContactSource: () => false,
    requestText: "هات مطاعم المهندسين وأرقام تليفوناتها",
  };
  const plan = (columns: Array<{ key: string }>) => validateAndPricePlan({ summary_ar: "ستحصل على مطاعم المهندسين.", stages: [{ key: "places", title_ar: "المطاعم", endpoint_id: "crawl4ai.google.serp.maps", expected_rows: 10, parent_key: null, deliver: true, columns, sample_rows: [{ name: "مطعم الريادة", phone: "+201020000000" }], measured_by: ["call_0001"] }] }, lookup as never);
  const issuesOf = (r: ReturnType<typeof plan>) => (r.ok ? [] : r.issues).join(" | ");
  it("a delivered place stage with the phone column answers «أرقام تليفوناتها»", () => {
    expect(issuesOf(plan([{ key: "name" }, { key: "phone" }, { key: "address" }, { key: "rating" }]))).not.toMatch(/add a CONTACT STAGE/);
  });
  it("without the phone column the plan is still sent back", () => {
    expect(issuesOf(plan([{ key: "name" }, { key: "address" }, { key: "rating" }]))).toMatch(/add a CONTACT STAGE|phone/);
  });
});
