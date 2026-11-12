import { describe, expect, it, vi } from "vitest";
import { knownColumnTitleAr } from "../src/lib/agentMission/taskContracts";
import { checkCustomerLabel } from "../src/lib/agentMission/text";
import { yieldFromDiagnosis } from "../src/lib/agentMission/plan";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { rowsExpressionOf } from "../agent/src/gateway";
import { emptyMappingWarning } from "../agent/src/tools";
import { createFakeDriver, type FakeStep } from "../agent/src/fakeDriver";
import { createMemoryStore, newMission } from "../agent/src/memoryStore";
import { runPlanning, type RunnerDeps } from "../agent/src/runMission";
import { NOT_ADMIN, POSTS_ENDPOINT, USER_ID, fakeRecorder, tregResult } from "./helpers/agentHarness";
import { fakeMoneyClient } from "./helpers/agentMoney";
import { REVIEW_TEXTS, syntheticTreg } from "../evals/live-intelligence/synthetic";
import type { TregCallResult } from "../src/functions/shared/tregClient";

/**
 * PLANNER RELIABILITY, ROUND 52 (docs/DIGER-INTELLIGENCE-FINAL-ACCEPTANCE.md section 7; the recorded transcripts of the six real-planner runs of round 51). The four missions of the final run that ended as OUR failure (J3, G2, Z16,
 * Z35) were each refused for their FORM before the planner gave up:
 *   1. columns given by a common key code had no title for (`source` in 35 missions of the six runs, `maps_url` 15, `developer` 10, `snippet` 8, `country` 7, `company` 5, ...);
 *   2. a mapping that read a GUESSED path of the saved page (`inputs.call_N.data.items`, the run_code example) returned `[]`, and the stage's sample rows and yield_from were refused two or three times;
 *   3. the yield_from diagnosis offered a list of field NAMES as the rows (Z35: «return the «keys» array»).
 * And the synthetic provider rows of the evaluation ignored structured filters and echoed the query into every name, which the planner rightly read as placeholders.
 * No rule is weaker: an unknown untitled key is still refused, an empty or wrapped yield_from is still refused, and nothing is accepted that was refused for its content.
 */
vi.stubGlobal("fetch", () => { throw new Error("a real network call was attempted"); });

describe("1. the common column keys of the recorded rejections have a code title (the rule itself is unchanged)", () => {
  const RECORDED = ["source", "maps_url", "developer", "snippet", "country", "category", "summary", "company", "published", "employees", "profile_url", "linkedin", "source_page", "reviews_total", "language", "google_reviews_url", "domain"];
  it("every recorded untitled key now has a valid Arabic customer label", () => {
    for (const k of RECORDED) {
      const title = knownColumnTitleAr(k);
      expect(title, k).not.toBeNull();
      expect(checkCustomerLabel(title).issues, k).toEqual([]);
    }
  });
  it("an unknown key still has no title (the model must name it)", () => {
    expect(knownColumnTitleAr("zz_unknown_field")).toBeNull();
    expect(checkCustomerLabel(knownColumnTitleAr("zz_unknown_field") ?? "").issues.length).toBeGreaterThan(0);
  });
});

describe("2. every sample answer says where its rows are, as code", () => {
  it("rowsExpressionOf", () => {
    expect(rowsExpressionOf("call_0002", "items")).toBe("inputs.call_0002.items");
    expect(rowsExpressionOf("call_0002", "data.items")).toBe("inputs.call_0002.data.items");
    expect(rowsExpressionOf("call_0002", "root")).toBe("inputs.call_0002");
    expect(rowsExpressionOf("call_0002", "output.0.list")).toBe("inputs.call_0002.output[0].list");
    expect(rowsExpressionOf("call_0002", "data.search-results")).toBe('inputs.call_0002.data["search-results"]');
    expect(rowsExpressionOf("call_0002", "data", "single_object")).toBe("[inputs.call_0002.data]");
    expect(rowsExpressionOf("call_0002", null)).toBeNull();
  });
  it("an EMPTY mapping of a page with rows is told where the rows are; nothing is said when the pages had none", () => {
    const at = new Map([["call_0002", { rows: 10, expr: "inputs.call_0002.items" }]]);
    expect(emptyMappingWarning(["call_0002"], {}, at)).toMatch(/EMPTY array, but call_0002 holds 10 rows at inputs\.call_0002\.items/);
    // a parse_page / web answer is saved as { rows, ... }
    expect(emptyMappingWarning(["call_0006"], { call_0006: { rows: [{ id: 1 }, { id: 2 }] } }, undefined)).toMatch(/call_0006 holds 2 rows at inputs\.call_0006\.rows/);
    expect(emptyMappingWarning(["call_0003"], { call_0003: { rows: [] } }, new Map([["call_0003", { rows: 0, expr: "inputs.call_0003.items" }]]))).toBeNull();
    expect(emptyMappingWarning(["out_0001"], { out_0001: [] }, undefined)).toBeNull();
  });
});

describe("3. the yield_from diagnosis offers only a list of ROW OBJECTS (Z35)", () => {
  it("a list of field names is not offered as the rows; a list of row objects still is", () => {
    const z35 = yieldFromDiagnosis("out_0004", JSON.stringify({ keys: ["0", "1", "2"], sample: "[{\"id\":1}]" }));
    expect(z35).toMatch(/JSON OBJECT/);
    expect(z35).not.toMatch(/return the «keys» array/);
    expect(z35).toMatch(/none of its keys holds a list of row objects.*rows_in_code/);
    expect(yieldFromDiagnosis("out_0002", JSON.stringify({ total: 2, sample: [{ id: "a" }, { id: "b" }] }))).toMatch(/return the «sample» array itself/);
  });
});

describe("end to end (the J3 article stage of round 51, replayed with the fake driver): a guessed path is corrected at once and an untitled «source» column no longer refuses the plan", () => {
  const REQUEST = "عايز بوستات إكس عن غلاء الأسعار في مصر";
  const page = { data: Array.from({ length: 6 }, (_, i) => ({ id: `${7100 + i}`, text: `غلاء الأسعار في مصر: رأي رقم ${i + 1} عن الأسعار والمرتبات`, url: `https://x.example/p/${7100 + i}`, source: `حساب ${i + 1}` })), next_cursor: "c1" };
  async function plan(steps: FakeStep[], answers: TregCallResult[]) {
    const store = createMemoryStore();
    const money = fakeMoneyClient();
    const queue = [...answers];
    const call = vi.fn(async () => { const n = queue.shift(); if (!n) throw new Error("no fake answer left"); return n; });
    const rec = fakeRecorder();
    const driver = createFakeDriver(steps);
    const deps: RunnerDeps = { store, client: money.client, catalog: loadTregCatalog(), driver, recorder: rec.recorder, commit: rec.commit, call: call as never, models: { planning: "claude-haiku-5-5", execution: "claude-haiku-5-5" }, resolveAccess: async () => NOT_ADMIN, notify: async () => undefined };
    store.missions.set("msn_r52", newMission({ id: "msn_r52", user_id: USER_ID, status: "planning", request_text: REQUEST }));
    await runPlanning(deps, store.missions.get("msn_r52")!);
    return { m: store.missions.get("msn_r52")!, results: driver.results, money };
  }
  const proposal: FakeStep = { tool: "propose_plan", args: { summary_ar: "خطة لجمع بوستات عن غلاء الأسعار في مصر.", stages: [{ key: "posts", title_ar: "البوستات", endpoint_id: POSTS_ENDPOINT, expected_rows: 6, parent_key: null, deliver: true, columns: [{ key: "text" }, { key: "url" }, { key: "source" }], measured_by: ["call_0001"], yield_from: "out_0002", relevance: { subject_ar: "غلاء الأسعار", terms: ["غلاء الأسعار"], context_terms: ["الأسعار", "مصر"], text_columns: ["text"] } }] } };

  it("the sample says rows_in_code; the wrong-path mapping is warned; the right mapping with an untitled «source» column is accepted", async () => {
    const r = await plan([
      { tool: "catalog_search", args: { words: ["posts", "search"], platform: "x", limit: 5 } },
      { tool: "treg_call", args: { endpoint_id: POSTS_ENDPOINT, params: { query: "غلاء الأسعار", max_results: 6 }, why: "the fixture source is the one under test" } },
      { tool: "run_code", args: { code: "const rows = inputs.call_0001.data.items || []; return rows.map(r => ({ id: String(r.id), text: r.text }));", files: ["call_0001"] } },
      { tool: "run_code", args: { code: "return inputs.call_0001.data.map(r => ({ id: String(r.id), text: r.text, url: r.url, source: r.source }));", files: ["call_0001"] } },
      proposal,
    ], [tregResult(page, 0.006)]);
    const sample = r.results.find((x) => x.tool === "treg_call")!.result;
    expect(sample.rows_in_code).toBe("inputs.call_0001.data");
    expect(String(sample.saved)).toMatch(/its rows are inputs\.call_0001\.data/);
    const [wrong, right] = r.results.filter((x) => x.tool === "run_code").map((x) => x.result);
    expect(wrong.warning).toMatch(/EMPTY array, but call_0001 holds 6 rows at inputs\.call_0001\.data/);
    expect(right.warning).toBeUndefined();
    const proposed = r.results.find((x) => x.tool === "propose_plan")!.result;
    expect(JSON.stringify(proposed)).not.toMatch(/code has no Arabic title/);
    expect(proposed.ok, JSON.stringify(proposed).slice(0, 600)).toBe(true);
    expect(r.m.status).not.toBe("failed");
    // a plan is a proposal: nothing was held or charged to the customer
    expect(r.money.calls).toHaveLength(0);
  });

  it("the plan citing the EMPTY output is still refused (the rule is not weaker)", async () => {
    const empty: FakeStep = { tool: "propose_plan", args: { ...(proposal.args as Record<string, unknown>), stages: [{ ...((proposal.args as { stages: Record<string, unknown>[] }).stages[0]), yield_from: "out_0001" }] } };
    const r = await plan([
      { tool: "catalog_search", args: { words: ["posts", "search"], platform: "x", limit: 5 } },
      { tool: "treg_call", args: { endpoint_id: POSTS_ENDPOINT, params: { query: "غلاء الأسعار", max_results: 6 }, why: "the fixture source is the one under test" } },
      { tool: "run_code", args: { code: "const rows = inputs.call_0001.data.items || []; return rows;", files: ["call_0001"] } },
      empty,
    ], [tregResult(page, 0.006)]);
    const proposed = r.results.find((x) => x.tool === "propose_plan")!.result;
    expect(proposed.ok).toBe(false);
    expect(JSON.stringify(proposed)).toMatch(/EMPTY array/);
  });
});

describe("4. the synthetic provider rows of the evaluation answer the filters they were given (evaluation fidelity, never production)", () => {
  const rowsOf = (v: unknown) => (v as { items: Array<Record<string, unknown>> }).items;
  it("J3: a structured Dubai marketing filter gives Dubai marketing companies whose names do not repeat the query", () => {
    const rows = rowsOf(syntheticTreg("tomba.companies.search.reveal", { filters: { location_country: { include: ["AE"] }, industry: { include: ["Marketing and Advertising"] } }, page: 1 }));
    for (const r of rows) { expect(r.country).toBe("AE"); expect(r.city).toBe("دبي"); expect(String(r.industry)).toMatch(/Marketing/); }
    expect(String(rows[0].name)).not.toMatch(/السوق المحلي/);
  });
  it("G2 / Z16: a query's sector is the industry, and no name carries the whole query", () => {
    const g2 = rowsOf(syntheticTreg("tomba.companies.search.reveal", { query: "pharmaceutical companies in Egypt" }));
    for (const r of g2) { expect(String(r.name)).not.toMatch(/companies in Egypt/); expect(String(r.name)).toMatch(/Pharmaceutical/); expect(r.country).toBe("EG"); }
    const z16 = rowsOf(syntheticTreg("aiark.companies.search", { filters: { industry: ["الطاقة الشمسية"] }, country: "EG" }));
    expect(String(z16[0].name)).toBe("النخبة للطاقة الشمسية");
    const people = rowsOf(syntheticTreg("wiza.people.search", { filters: { job_title: ["Marketing Manager"], company_keywords: ["pharmaceutical"], location: ["Egypt"] } }));
    expect(String(people[0].company)).toMatch(/Pharmaceutical/);
  });
  it("Z35: an App Store search answers App Store pages, and only the first app carries the searched name", () => {
    const apps = rowsOf(syntheticTreg("litescrape.app_store.search.apps", { term: "talabat" }));
    for (const a of apps) expect(String(a.url)).toMatch(/^https:\/\/apps\.apple\.com\/eg\/app\/[a-z-]+\/id\d+$/);
    expect(apps.filter((a) => /talabat/.test(String(a.name)))).toHaveLength(1);
    const play = rowsOf(syntheticTreg("crawl4ai.google-play.search.apps", { query: "fawry" }));
    for (const a of play) expect(String(a.url)).toMatch(/^https:\/\/play\.google\.com\//);
  });
  it("reviews are not a short repeating set", () => {
    const reviews = rowsOf(syntheticTreg("anyapi.google.maps.reviews", { place_id: "x" }));
    expect(new Set(reviews.map((r) => r.text)).size).toBeGreaterThanOrEqual(8);
    expect(new Set(reviews.map((r) => r.author)).size).toBeGreaterThanOrEqual(8);
    expect(REVIEW_TEXTS.length).toBeGreaterThanOrEqual(12);
  });
});
