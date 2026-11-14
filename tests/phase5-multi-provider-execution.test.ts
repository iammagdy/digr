import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createMemoryStore } from "../agent/src/memoryStore";
import { ItemStore } from "../agent/src/items/itemStore";
import { runEngine } from "../agent/src/engine/run";
import { RAW_PATH, type Gateway } from "../agent/src/gateway";
import { createSourceGateway, isDirectWebSource, providerOf, stageDispatchOf, stageScopeOf, webRequestOf } from "../agent/src/engine/sourceGateway";
import { createJobCallBudget } from "../src/lib/server/callBudget";
import { MULTI_STAGE_ENGINE_FLAG_KEY, readMultiStageEngineFlag } from "../src/lib/agentMission/capabilities";
import type { PricedPlan } from "../src/lib/agentMission/plan";

/**
 * PHASE 5 (audit §9.1, PR-5.1 / PR-5.2): MULTI-PROVIDER, PER-STAGE EXECUTION behind `multi_stage_engine` (OFF).
 * Every provider answer here is SIMULATED (labelled): the gateways are fakes that store a raw page the way the real ones do. Proven: the stored scope, the dispatch to the TREG or the web gateway, the cross-provider
 * dependency (a web stage fed by a TREG stage's saved rows), the provenance marks, failures and refusals, per-stage dispatch, and that nothing changes with the switch off.
 */
const MISSION = "msn_p5";
const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const stage = (over: Record<string, unknown>) => ({ expected_rows: 1, planned_rows: 1, parent_key: null, deliver: true, sample_rows: [], measured_by: [], measured_from_calls: [], measured_cost_per_row_usd: 0.0005, ...over }) as any;
/** The mapping: a TREG page is a list of rows; a web page is saved as { rows } (webGateway.ts), and its recipe reads `.rows`. */
const ident = async (code: string, inputs: Record<string, unknown>) => { const page = Object.values(inputs)[0] as any; return { ok: true as const, resultJson: JSON.stringify(/\.rows/.test(code) ? page?.rows ?? null : page), logs: [] }; };

/** companies from a TREG id, then each company's public e-mails from the Context.dev parser over the company's website (a web id): the cross-provider chain of the B2B service. */
function chainPlan(over: { contactsEndpoint?: string; alternatives?: string[]; contactsEngine?: boolean } = {}): PricedPlan {
  const companies = stage({ key: "companies", title_ar: "الشركات", planned_rows: 3, columns: [{ key: "name", title_ar: "الاسم" }, { key: "website", title_ar: "الموقع" }], engine: { endpoint_id: "tomba.companies.search.reveal", params: { q: "software cairo" }, cursor_param: null, map_code: "return inputs.page", map_file_id: "page", parent_binding: null } });
  const contactsEndpoint = over.contactsEndpoint ?? "contextdev.parse.emails";
  const contacts = stage({ key: "contacts", title_ar: "الإيميلات العامة", parent_key: "companies", per_parent_rows: 2, planned_rows: 6, columns: [{ key: "email", title_ar: "الإيميل" }], ...(over.contactsEngine === false ? {} : { engine: { endpoint_id: contactsEndpoint, params: {}, cursor_param: null, map_code: "return inputs.page.rows", map_file_id: "page", parent_binding: { param: "url", from: "website" }, ...(over.alternatives ? { alternatives: over.alternatives.map((id) => ({ endpoint_id: id, params: {}, cursor_param: null, map_code: "return inputs.page.rows", map_file_id: "page" })) } : {}) } }) });
  return { summary_ar: "x", stages: [companies, contacts], price: { deliveredRows: 9 } } as unknown as PricedPlan;
}

function world(opts: { webFails?: "always" | "once"; webMissing?: boolean; tregRefuse?: string } = {}) {
  const store = createMemoryStore();
  const budget = createJobCallBudget({ ceilingUsd: 1, spentUsd: 0 });
  const treg: Array<{ endpoint: string; params: Record<string, unknown>; id: string }> = [];
  const webCalls: Array<{ method: string; args: Record<string, unknown>; id: string }> = [];
  let seq = 0;
  const nextId = () => `call_${String((seq += 1)).padStart(4, "0")}`;
  const gateway = {
    async tregCall(input: { endpoint_id?: unknown; params?: unknown }) {
      const id = nextId();
      treg.push({ endpoint: String(input.endpoint_id), params: (input.params ?? {}) as Record<string, unknown>, id });
      if (opts.tregRefuse) return { ok: false as const, call_id: id, refused: opts.tregRefuse, message: "no" };
      const rows = [{ id: "c1", name: "Acme", website: "https://acme.example" }, { id: "c2", name: "Beta", website: "https://beta.example" }, { id: "c3", name: "Gamma", website: "https://gamma.example" }];
      await store.putFile(MISSION, RAW_PATH(id), JSON.stringify(rows), "application/json");
      budget.settle(0, 0.004);
      return { ok: true as const, call_id: id, http_status: 200, rows_in_page: rows.length, has_more: false, next_cursor: null, shape: null, first_rows: [], warnings: [], saved: "" };
    },
  } as unknown as Gateway;
  let failedOnce = false;
  const parsePage = async (args: Record<string, unknown>) => {
    const id = nextId();
    webCalls.push({ method: "parsePage", args, id });
    if (opts.webFails === "always" || (opts.webFails === "once" && !failedOnce)) { failedOnce = true; return { ok: false as const, call_id: id, failed: true as const, message: "the source answered with an error (timeout)" }; }
    const host = String(args.url).replace(/^https?:\/\//, "").split("/")[0];
    const rows = [{ id: `info@${host}`, email: `info@${host}` }];
    await store.putFile(MISSION, RAW_PATH(id), JSON.stringify({ rows }), "application/json");
    budget.settle(0, 0.0008);
    return { ok: true as const, call_id: id, source: "contextdev.parse.emails", rows_in_page: rows.length, next_cursor: null, shape: null, first_rows: [], cost_basis: "reported" as const, saved: id };
  };
  const web = opts.webMissing ? undefined : { parsePage, webSearch: parsePage, webScrape: parsePage, peopleSearch: parsePage } as any;
  return { store, budget, gateway, web, treg, webCalls };
}

async function runChain(plan: PricedPlan, w: ReturnType<typeof world>, extra: Record<string, unknown> = {}) {
  const items = await ItemStore.open(w.store, MISSION);
  const sources = createSourceGateway({ gateway: w.gateway, ...(w.web ? { web: w.web } : {}), scope: stageScopeOf(plan), budget: w.budget });
  const outcome = await runEngine({ items, store: w.store, plan, missionId: MISSION, gateway: w.gateway, sandbox: ident, addEvent: async () => undefined, deadlineMs: Date.now() + 3_600_000, sleep: async () => undefined, sources, provenance: true, ...extra });
  return { items, sources, outcome };
}

describe("Phase 5: the SourceGateway keeps every stage inside its stored scope", () => {
  it("the scope of a plan is each recipe's endpoint plus the approved fallback tools of that same recipe; a stage without a recipe has none", () => {
    expect(stageScopeOf(chainPlan({ alternatives: ["contextdev.scrape"] }))).toEqual({ companies: { endpointIds: ["tomba.companies.search.reveal"], capUsd: null }, contacts: { endpointIds: ["contextdev.parse.emails", "contextdev.scrape"], capUsd: null } });
    expect(stageScopeOf(chainPlan({ contactsEngine: false }))).toEqual({ companies: { endpointIds: ["tomba.companies.search.reveal"], capUsd: null } });
  });

  it("a call to an endpoint outside the stage's scope (or for an unknown stage) is refused with NO request and no cost", async () => {
    const w = world();
    const sg = createSourceGateway({ gateway: w.gateway, web: w.web, scope: stageScopeOf(chainPlan()), budget: w.budget });
    for (const [stageKey, endpoint_id] of [["companies", "aviato.people.search"], ["contacts", "tomba.companies.search.reveal"], ["ghost", "contextdev.parse.emails"]]) {
      const r = await sg.call({ stageKey, endpoint_id, params: {} });
      expect(r).toMatchObject({ ok: false, refused: "out_of_scope" });
    }
    expect(w.treg).toHaveLength(0);
    expect(w.webCalls).toHaveLength(0);
    expect(w.budget.spentUsd()).toBe(0);
    expect(sg.records().every((r) => r.outcome === "refused" && r.via === "none" && r.spentUsd === 0)).toBe(true);
  });

  it("dispatch by provider: a TREG id goes to the TREG gateway, a direct web id to the web gateway; each call is recorded with its provider, route and call id", async () => {
    const w = world();
    const sg = createSourceGateway({ gateway: w.gateway, web: w.web, scope: stageScopeOf(chainPlan()), budget: w.budget });
    const a = await sg.call({ stageKey: "companies", endpoint_id: "tomba.companies.search.reveal", params: { q: "x" } });
    const b = await sg.call({ stageKey: "contacts", endpoint_id: "contextdev.parse.emails", params: { url: "https://acme.example" } });
    expect(a).toMatchObject({ ok: true, via: "treg", provider: "tomba" });
    expect(b).toMatchObject({ ok: true, via: "web", provider: "contextdev", has_more: false });
    expect(w.webCalls[0]).toMatchObject({ method: "parsePage", args: { parser: "emails", url: "https://acme.example" } });
    expect(sg.records().map((r) => [r.stageKey, r.via, r.call_id])).toEqual([["companies", "treg", a.call_id], ["contacts", "web", b.call_id]]);
    expect(sg.stageSpentUsd("companies")).toBeCloseTo(0.004, 9);
    expect(sg.stageSpentUsd("contacts")).toBeCloseTo(0.0008, 9);
  });

  it("a web stage when this worker has no web key: refused, nothing called (never silently re-routed to another provider)", async () => {
    const w = world({ webMissing: true });
    const sg = createSourceGateway({ gateway: w.gateway, scope: stageScopeOf(chainPlan()), budget: w.budget });
    expect(await sg.call({ stageKey: "contacts", endpoint_id: "contextdev.parse.emails", params: { url: "https://acme.example" } })).toMatchObject({ ok: false, refused: "source_unavailable" });
    expect(w.treg).toHaveLength(0);
  });

  it("a stage cap (when the plan carries one) stops that stage's calls once its own spend reaches it; other stages are unaffected", async () => {
    const w = world();
    const plan = chainPlan();
    (plan.stages[1] as any).max_usd = 0.001;
    const sg = createSourceGateway({ gateway: w.gateway, web: w.web, scope: stageScopeOf(plan), budget: w.budget });
    expect((await sg.call({ stageKey: "contacts", endpoint_id: "contextdev.parse.emails", params: { url: "https://a.example" } })).ok).toBe(true);
    expect((await sg.call({ stageKey: "contacts", endpoint_id: "contextdev.parse.emails", params: { url: "https://b.example" } })).ok).toBe(true);
    expect(await sg.call({ stageKey: "contacts", endpoint_id: "contextdev.parse.emails", params: { url: "https://c.example" } })).toMatchObject({ ok: false, refused: "stage_cap" });
    expect(w.webCalls).toHaveLength(2);
    expect((await sg.call({ stageKey: "companies", endpoint_id: "tomba.companies.search.reveal", params: {} })).ok).toBe(true);
  });

  it("web ids map to the existing web gateway methods with the stage's own inputs; TREG ids are never treated as web ids", () => {
    expect(webRequestOf("contextdev.parse.emails", { url: "u" })).toEqual({ method: "parsePage", args: { parser: "emails", url: "u" } });
    expect(webRequestOf("firecrawl.search", { query: "q", limit: 5 })).toEqual({ method: "webSearch", args: { provider: "firecrawl", query: "q", limit: 5 } });
    expect(webRequestOf("contextdev.scrape", { url: "u" })).toEqual({ method: "webScrape", args: { provider: "contextdev", url: "u" } });
    expect(webRequestOf("contextdev.people.search", { query: "cto" })).toEqual({ method: "peopleSearch", args: { query: "cto" } });
    for (const id of ["firecrawl.web.search", "branddev.web.scrape", "branddev.brand.retrieve-by-name", "treg.web.extract"]) { expect(isDirectWebSource(id), id).toBe(false); expect(webRequestOf(id, {})).toBeNull(); }
    expect(providerOf("contextdev.parse.emails")).toBe("contextdev");
  });
});

describe("Phase 5: a cross-provider chain on the engine (TREG companies → web contacts)", () => {
  it("each company's website feeds the web stage; rows carry their source and call; the file's columns never include them", async () => {
    const w = world();
    const plan = chainPlan();
    const { items, outcome, sources } = await runChain(plan, w);
    expect(outcome.aborted).toBeNull();
    expect(items.acceptedRows("companies").map((r) => r.id)).toEqual(["c1", "c2", "c3"]);
    expect(w.webCalls.map((c) => c.args.url)).toEqual(["https://acme.example", "https://beta.example", "https://gamma.example"]);
    const contacts = items.acceptedRows("contacts");
    expect(contacts.map((r) => [r.parent_id, r.email])).toEqual([["c1", "info@acme.example"], ["c2", "info@beta.example"], ["c3", "info@gamma.example"]]);
    for (const r of contacts) {
      expect(r._src).toBe("contextdev.parse.emails");
      const rec = sources.records().find((x) => x.call_id === r._call)!;
      expect(rec).toMatchObject({ stageKey: "contacts", via: "web", outcome: "ok" });
    }
    expect(items.acceptedRows("companies").every((r) => r._src === "tomba.companies.search.reveal" && typeof r._call === "string")).toBe(true);
    for (const s of plan.stages) for (const c of s.columns) expect(c.key.startsWith("_")).toBe(false);
  });

  it("a recipe whose endpoint is not the approved one cannot run: the stage ends refused with no request to that provider", async () => {
    const w = world();
    const approved = chainPlan();
    const items = await ItemStore.open(w.store, MISSION);
    const tampered = chainPlan({ contactsEndpoint: "aviato.people.search" });
    const sources = createSourceGateway({ gateway: w.gateway, web: w.web, scope: stageScopeOf(approved), budget: w.budget });
    const out = await runEngine({ items, store: w.store, plan: tampered, missionId: MISSION, gateway: w.gateway, sandbox: ident, addEvent: async () => undefined, deadlineMs: Date.now() + 3_600_000, sleep: async () => undefined, sources, provenance: true });
    expect(out.stops.contacts).toBe("refused");
    expect(w.treg.map((c) => c.endpoint)).toEqual(["tomba.companies.search.reveal"]);
    expect(w.webCalls).toHaveLength(0);
  });

  it("a failing web provider: each company's page is asked once more, then the stage stops «failed»; what the TREG stage saved stays", async () => {
    const w = world({ webFails: "always" });
    const { items, outcome } = await runChain(chainPlan(), w);
    expect(outcome.stops.contacts).toBe("failed");
    expect(items.acceptedRows("companies")).toHaveLength(3);
    expect(items.acceptedRows("contacts")).toHaveLength(0);
    expect(w.webCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("a timeout once, then an answer: the retry delivers", async () => {
    const w = world({ webFails: "once" });
    const { items } = await runChain(chainPlan(), w);
    expect(items.acceptedRows("contacts").length).toBe(3);
  });

  it("the job budget refusal from the TREG gateway ends the stage on «budget»; the web stage is never fed", async () => {
    const w = world({ tregRefuse: "over_budget" });
    const { items, outcome } = await runChain(chainPlan(), w);
    expect(outcome.stops.companies).toBe("budget");
    expect(items.acceptedRows("contacts")).toHaveLength(0);
    expect(w.webCalls).toHaveLength(0);
  });
});

describe("Phase 5: per-stage dispatch", () => {
  it("stages with a recipe whose parent is on the engine run on it; a stage without a recipe and its children go to the model", () => {
    expect(stageDispatchOf(chainPlan())).toEqual({ engine: ["companies", "contacts"], model: [] });
    expect(stageDispatchOf(chainPlan({ contactsEngine: false }))).toEqual({ engine: ["companies"], model: ["contacts"] });
    const p = chainPlan();
    delete (p.stages[0] as any).engine;
    expect(stageDispatchOf(p)).toEqual({ engine: [], model: ["companies", "contacts"] });
  });

  it("the engine carries out ONLY the stages it is given: the others are left untouched for the model path", async () => {
    const w = world();
    const plan = chainPlan({ contactsEngine: false });
    const { items, outcome } = await runChain(plan, w, { onlyStages: new Set(["companies"]) });
    expect(Object.keys(outcome.stops)).toEqual(["companies"]);
    expect(items.acceptedRows("companies")).toHaveLength(3);
    expect(items.acceptedRows("contacts")).toHaveLength(0);
    expect(w.webCalls).toHaveLength(0);
  });
});

describe("Phase 5: with the switch off nothing changes", () => {
  it("the switch is OFF unless the settings name it (no repository default sets it)", () => {
    expect(MULTI_STAGE_ENGINE_FLAG_KEY).toBe("multi_stage_engine");
    expect(readMultiStageEngineFlag({}, "u1")).toBe(false);
    expect(readMultiStageEngineFlag(null, "u1")).toBe(false);
    expect(readMultiStageEngineFlag({ multi_stage_engine: { user_ids: [U2] } }, U1)).toBe(false);
    expect(readMultiStageEngineFlag({ multi_stage_engine: { user_ids: [U1] } }, U1)).toBe(true);
    expect(readMultiStageEngineFlag({ multi_stage_engine: "test" }, U1)).toBe(false);
  });

  it("the engine without `sources` calls the TREG gateway exactly as before and writes no provenance mark", async () => {
    const w = world();
    const plan = chainPlan();
    (plan.stages[1] as any).engine.endpoint_id = "tikhub.web.emails"; // a TREG id for the old path
    const items = await ItemStore.open(w.store, MISSION);
    await runEngine({ items, store: w.store, plan, missionId: MISSION, gateway: w.gateway, sandbox: async (_c, inputs) => ({ ok: true, resultJson: JSON.stringify(Array.isArray(Object.values(inputs)[0]) ? Object.values(inputs)[0] : []), logs: [] }), addEvent: async () => undefined, deadlineMs: Date.now() + 3_600_000, sleep: async () => undefined });
    expect(w.treg[0].endpoint).toBe("tomba.companies.search.reveal");
    expect(w.webCalls).toHaveLength(0);
    for (const r of items.acceptedRows("companies")) { expect("_src" in r).toBe(false); expect("_call" in r).toBe(false); }
  });

  it("runMission builds the SourceGateway, the dispatch and the provenance ONLY under the switch", () => {
    const src = readFileSync("agent/src/runMission.ts", "utf-8");
    expect(src).toContain("const multiStage = deps.engine !== false && readMultiStageEngineFlag(redesignSettings, mission.user_id);");
    expect(src).toContain("const sources = multiStage ? createSourceGateway(");
    expect(src).toContain("const dispatch = multiStage && !engineOn ? stageDispatchOf(plan) : null;");
    expect(src).toContain("...(sources ? { sources, provenance: true } : {}), ...(engineStages ? { onlyStages: engineStages } : {})");
    // the money path is untouched: settlement still counts the file, the SourceGateway has no ledger, price or reservation code
    const sg = readFileSync("agent/src/engine/sourceGateway.ts", "utf-8");
    expect(sg).not.toMatch(/accept_quote_atomic|settle_job_atomic|release_job_atomic|credit_ledger|priceMission|reserve\(/);
  });
});

// ------------------------------------------------------------------------------------------------ end to end: approval, reservation and settlement with the switch on
import { readWorkbook, replay } from "./helpers/agentReplay";
import { pages, planning } from "./helpers/engineXScenario";
import { readSnapshot } from "../agent/src/items/itemStore";

describe("Phase 5 end to end (replayed X mission, SIMULATED pages): the switch changes the route and the marks, never the money", () => {
  const run = (on: boolean) => replay({
    request: "هات ٣٠٠ تغريدة عن محمد صلاح", planning: planning(), execution: () => [], answers: [pages(1)[0], ...pages(30)],
    makeStore: () => { const s = createMemoryStore(); if (on) s.settings.multi_stage_engine = true; return s; },
  });

  it("same calls, same delivered count, same charge and release, charge never above the hold; the saved rows carry their source and call only with the switch on", async () => {
    const off = await run(false);
    const on = await run(true);
    for (const k of ["status", "delivered_units", "charged_points", "reserved_points", "unit_price_points"] as const) expect(on.mission[k], k).toEqual(off.mission[k]);
    expect(Number(on.mission.charged_points)).toBeLessThanOrEqual(Number(on.mission.reserved_points));
    const callsOf = async (r: typeof on) => (await r.store.listCalls(r.missionId)).filter((c) => c.phase === "execution").map((c) => c.endpoint_id);
    expect(await callsOf(on)).toEqual(await callsOf(off));
    const rowsOn = (await readSnapshot(on.store, on.missionId)).acceptedRows("tweets");
    const rowsOff = (await readSnapshot(off.store, off.missionId)).acceptedRows("tweets");
    expect(rowsOn.length).toBe(rowsOff.length);
    expect(rowsOn.every((r) => typeof r._src === "string" && typeof r._call === "string")).toBe(true);
    expect(rowsOff.some((r) => "_src" in r || "_call" in r)).toBe(false);
    // the delivered workbook is the same sheet for sheet and cell for cell: the marks never reach the file
    const dump = async (r: typeof on) => { const wb = await readWorkbook(r); const out: unknown[] = []; wb.eachSheet((ws) => ws.eachRow((row) => out.push([ws.name, row.values]))); return JSON.stringify(out); };
    const fileOn = await dump(on);
    expect(fileOn).toBe(await dump(off));
    expect(fileOn).not.toMatch(/_src|_call|call_0/);
    expect(on.store.events.some((e) => e.counts && "multi_stage" in e.counts)).toBe(true);
    expect(off.store.events.some((e) => e.counts && "multi_stage" in e.counts)).toBe(false);
  });
});
