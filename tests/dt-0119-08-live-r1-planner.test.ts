import { describe, expect, it, vi } from "vitest";
import { withCheckedCompaniesCount, withCheckedPerCompany, type Understanding } from "../agent/src/llmPlanner/planner";
import { UNDERSTAND_TOOL } from "../agent/src/llmPlanner/prompts";
import { createFakeDriver, type FakeStep } from "../agent/src/fakeDriver";
import type { ModelDriver } from "../agent/src/driver";
import { createMemoryStore, newMission } from "../agent/src/memoryStore";
import { runPlanning, type RunnerDeps } from "../agent/src/runMission";
import { validateAndPricePlan, type PlanLookup } from "../src/lib/agentMission/plan";
import { PEOPLE_UNAVAILABLE_AR } from "../src/lib/agentMission/refusal";
import { PEOPLE_OF_COMPANY_CAPABILITIES, peopleSourcesForCompanies } from "../src/lib/agentMission/childSources";
import { capabilitiesOf, peopleOfCompanyCapabilitiesOf } from "../agent/src/llmPlanner/catalogView";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { NOT_ADMIN, USER_ID, fakeRecorder, tregResult } from "./helpers/agentHarness";
import { fakeMoneyClient } from "./helpers/agentMoney";
import { COMPANIES, PEOPLE, SLUGS, ccolumns, companiesPage, company, linkedinOf, peopleOfCompany, personOf, pcolumns, why } from "./helpers/a1World";
import { callIds, lastOutputId, type Results } from "./helpers/agentFakeWorld";
import { firstOutputId } from "./helpers/agentRelevance";
import type { TregCallOptions, TregCallResult } from "../src/functions/shared/tregClient";
import { blockedEndpointReason } from "../src/lib/treg/blockList";
import { policyVerdict } from "../src/lib/treg/dataPolicy";

/**
 * DT-20261119-08 c1:
 *  (a) A proposal declaring people unserved while saved measured people rows exist gets ONE bounded, evidence-based
 *      repair message naming saved successful call IDs + concrete missing mapping/stage (no repeated paid query,
 *      no lowered validation, no fabricated match).
 *  (b) #584 regression (empty-only people samples + estimate): no 10x loop; accept estimated stage after 1 repair;
 *      stubborn repeats stop after bounded repair with safe structured categories + counts.
 *  (c) «من كل شركة مدير» preserves 1 per company at the planner handoff + plan validation; explicit «٣ مديرين» stays 3;
 *      «٥ شركات» stays 5; genuinely unspecified count keeps default 2.
 */
vi.stubGlobal("fetch", () => { throw new Error("a real network call was attempted"); });

const catalog = loadTregCatalog();
const allowed = (id: string) => policyVerdict(id, NOT_ADMIN).allowed && !blockedEndpointReason(id) && catalog.byId.has(id);
const COMPANIES_CAP = [...capabilitiesOf(catalog, NOT_ADMIN, "companies")].sort().find((c) => !PEOPLE_OF_COMPANY_CAPABILITIES.has(c))!;
const PEOPLE_CAP = peopleOfCompanyCapabilitiesOf(catalog, NOT_ADMIN)[0] ?? "people.company.employees";
const ALT = "blitzapi.people.employee-finder";

const LIVE_REQ = "عايز شركتين مقاولات في القاهرة ومن كل شركة مدير";

const rawUnderstandTemplate = (over: {
  companiesTotal?: number | null;
  companiesText?: string;
  perCompany?: number | null;
  perCompanyText?: string;
  peopleTitle?: string;
}) => ({
  decision: "plan",
  understanding_ar: "شركتا مقاولات في القاهرة ومدير واحد من كل شركة.",
  accepts_available: false,
  steps: [
    {
      key: "companies",
      title_ar: "شركات المقاولات في القاهرة",
      platform: "companies",
      capability: COMPANIES_CAP,
      parent: "",
      deliver: true,
      count: { ...(over.companiesTotal !== null ? { total: over.companiesTotal ?? 2 } : {}), all: false },
      topic: "contracting",
      search_terms: ["contracting"],
      country: "EG",
    },
  ],
  people_of_companies: {
    asked: true,
    title_ar: over.peopleTitle ?? "المديرين",
    per_company: over.perCompany === undefined ? 1 : (over.perCompany ?? 0),
    per_company_text: over.perCompanyText ?? "مدير",
    companies_text: over.companiesText ?? "شركتين",
    contact_kinds: [],
  },
});

const uTemplate = (over: {
  companiesTotal?: number | null;
  companiesText?: string;
  perCompany?: number | null;
  perCompanyText?: string;
  peopleTitle?: string;
}): Understanding => ({
  decision: "plan",
  missing: [],
  understanding_ar: "شركتا مقاولات في القاهرة ومدير واحد من كل شركة.",
  question_ar: "",
  options_ar: [],
  cannot_ar: "",
  assumptions_ar: [],
  no_repeat: false,
  accepts_available: false,
  steps: [
    {
      key: "companies",
      title_ar: "شركات المقاولات في القاهرة",
      platform: "companies",
      capability: COMPANIES_CAP,
      parent: null,
      deliver: true,
      count: { total: over.companiesTotal === undefined ? 2 : over.companiesTotal, per_parent: null, all: false },
      source: null,
      topic: "contracting",
      search_terms: ["contracting"],
      period: null,
      language: null,
      country: "EG",
      order: null,
    },
    {
      key: "people",
      title_ar: over.peopleTitle ?? "المديرين",
      platform: "linkedin",
      capability: PEOPLE_CAP,
      parent: "companies",
      deliver: true,
      count: { total: null, per_parent: over.perCompany === undefined ? 1 : over.perCompany, all: false },
      source: null,
      topic: null,
      search_terms: [],
      period: null,
      language: null,
      country: null,
      order: null,
    },
  ],
  people_of_companies: {
    asked: true,
    title_ar: over.peopleTitle ?? "المديرين",
    per_company: over.perCompany === undefined ? 1 : over.perCompany,
    per_company_text: over.perCompanyText ?? "مدير",
    companies_text: over.companiesText ?? "شركتين",
    contact_kinds: [],
  },
});

const constructionCompany = (slug: string, i: number) => ({
  ...company(slug, i),
  name: `${["Orascom", "Nile", "Delta", "Cairo", "Suez"][i]} Contracting`,
  industry: "Construction & Contracting",
  description: "General contracting and construction company in Cairo",
});
const constructionCompaniesPage = { data: { companies: SLUGS.map(constructionCompany) } };

describe("c1-(c): singular count «من كل شركة مدير» stays 1 while explicit/unspecified keep theirs", () => {
  it("«من كل شركة مدير» preserves per_company=1 through withCheckedPerCompany and binds per_parent_rows=1 in validateAndPricePlan", () => {
    const u = uTemplate({ perCompany: 1, perCompanyText: "مدير", companiesTotal: 2, companiesText: "شركتين" });
    const checked = withCheckedPerCompany(u, [LIVE_REQ]);
    expect(checked.people_of_companies?.per_company).toBe(1);
    expect(checked.steps[1].count.per_parent).toBe(1);

    const calls = new Map([
      ["call_0001", { id: "call_0001", endpointId: COMPANIES, ok: true, costUsd: 0.0005, rows: 5, params: { query: "contracting" } }],
      ["call_0002", { id: "call_0002", endpointId: PEOPLE, ok: true, costUsd: 0.0005, rows: 6, params: { company_linkedin_url: linkedinOf("orascom-em") } }],
    ]);
    const lookup: PlanLookup = {
      call: (id) => calls.get(id) ?? null,
      evidenceText: () => `${linkedinOf("orascom-em")} Orascom Contracting https://www.linkedin.example/in/orascom-em-2`,
      endpointAllowed: () => true,
      requestText: LIVE_REQ,
      noRelevance: true,
      endpointCapability: (id) => catalog.byId.get(id)?.capability ?? null,
      understoodPeople: { noun_ar: "المديرين", parent_ar: "الشركات", per_parent: checked.people_of_companies!.per_company, companies: 2 },
    };
    const r = validateAndPricePlan({
      summary_ar: "ستحصل على شركتي مقاولات في القاهرة ومدير من كل شركة.",
      stages: [
        { key: "companies", title_ar: "شركات المقاولات في القاهرة", endpoint_id: COMPANIES, expected_rows: 5, parent_key: null, deliver: true, columns: ccolumns, sample_rows: [{ id: linkedinOf("orascom-em"), name: "Orascom Contracting", industry: "Construction & Contracting", city: "Cairo", website: "orascom-em.com.eg", linkedin: linkedinOf("orascom-em") }], measured_by: ["call_0001"] },
        { key: "people", title_ar: "مديرو كل شركة", endpoint_id: PEOPLE, expected_rows: 10, parent_key: "companies", per_parent_rows: 1, deliver: true, columns: pcolumns, sample_rows: [{ id: "https://www.linkedin.example/in/orascom-em-2", full_name: "Karim orascom", job_title: "Chief Executive Officer", company: "orascom-em co", linkedin: "https://www.linkedin.example/in/orascom-em-2", email: "", phone: "" }], measured_by: ["call_0002"] },
      ],
    }, lookup);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.plan.stages.find((s) => s.key === "companies")?.planned_rows).toBe(2);
    expect(r.plan.stages.find((s) => s.key === "people")).toMatchObject({ per_parent_rows: 1, planned_rows: 2 });
    expect((r.plan.assumptions_ar ?? []).join(" ")).not.toMatch(/لم تحدد عدد/);
  });

  it("counters: «٥ شركات» -> 5; «٣ مديرين» -> 3; genuinely unspecified «ومعاهم المديرين» -> default 2", () => {
    const req5 = "عايز ٥ شركات مقاولات في القاهرة ومن كل شركة ٣ مديرين";
    const u5 = withCheckedCompaniesCount(withCheckedPerCompany(uTemplate({ companiesTotal: 5, companiesText: "٥ شركات", perCompany: 3, perCompanyText: "٣ مديرين" }), [req5]), [req5]);
    expect(u5.steps[0].count.total).toBe(5);
    expect(u5.people_of_companies?.per_company).toBe(3);

    const reqUnspecified = "عايز شركتين مقاولات في القاهرة ومعاهم المديرين";
    const uUnspec = withCheckedPerCompany(uTemplate({ companiesTotal: 2, companiesText: "شركتين", perCompany: 1, perCompanyText: "المديرين" }), [reqUnspecified]);
    expect(uUnspec.people_of_companies?.per_company).toBeNull();
  });
});

describe("c1-(a)/(b): Must-Pass #1 (memory restart + mixed 402/422 + saved people call) and Counter cases", () => {
  it("Must-Pass #1: memory restart preserves saved calls; unserved proposal gets 1 evidence-based repair naming saved call_id; repaired plan binds 2x1, 0 charge before approval, 0 repeated paid calls", async () => {
    const store = createMemoryStore();
    const money = fakeMoneyClient();
    const rec = fakeRecorder();
    const plannerCalls: string[] = [];

    const understanding = rawUnderstandTemplate({ perCompany: 1, perCompanyText: "مدير", companiesTotal: 2, companiesText: "شركتين" });
    const plannerModel = async ({ tool }: { tool: { name: string } }) =>
      tool.name === UNDERSTAND_TOOL ? { input: JSON.parse(JSON.stringify(understanding)), costUsd: 0.001 } : null;

    // Run 1: companies call succeeds (5 rows), 2 people sources fail with 402/422, 1 compatible people call succeeds (6 rows), then worker hits memory stop -> requeue
    const run1Steps: FakeStep[] = [
      { tool: "catalog_search", args: { words: ["companies", "search"], limit: 5 } },
      { tool: "treg_call", args: { endpoint_id: COMPANIES, params: { query: "contracting", page: 1 }, why } },
      { tool: "treg_call", args: { endpoint_id: ALT, params: { company_linkedin_url: linkedinOf("orascom-em"), max_results: 5 }, why } },
      { tool: "treg_call", args: { endpoint_id: "aviato.companies.employees", params: { website: "orascom-em.com.eg", perPage: 5, page: 0 }, why } },
      { tool: "treg_call", args: { endpoint_id: PEOPLE, params: { company_linkedin_url: linkedinOf("orascom-em"), cascade: [{ include_title: ["Chief Executive Officer", "Managing Director"] }], max_results: 10 }, why } },
    ];
    const memoryDriver: ModelDriver = {
      async run(input) {
        await createFakeDriver(run1Steps).run(input);
        return { llmCostUsd: 0.002, turns: 5, stop: "memory" };
      },
    };

    const callMock1 = vi.fn(async (o: TregCallOptions): Promise<TregCallResult> => {
      plannerCalls.push(o.endpointId);
      if (o.endpointId === COMPANIES) return tregResult(constructionCompaniesPage, 0.0005);
      if (o.endpointId === ALT) return { ok: false, httpStatus: 402, costUsd: 0, error: "route_max_cost", errorCode: "payment_required" } as unknown as TregCallResult;
      if (o.endpointId === "aviato.companies.employees") return { ok: false, httpStatus: 422, costUsd: 0, error: "Expected an array, got a string" } as unknown as TregCallResult;
      if (o.endpointId === PEOPLE) return tregResult(peopleOfCompany("orascom-em"), 0.0005);
      throw new Error(`Unexpected endpoint: ${o.endpointId}`);
    });

    const m = newMission({ id: "msn_r1_mp1", user_id: USER_ID, status: "planning", request_text: LIVE_REQ });
    store.missions.set(m.id, m);

    const deps1: RunnerDeps = {
      store, client: money.client, catalog, driver: memoryDriver, recorder: rec.recorder, commit: rec.commit,
      call: callMock1 as never, plannerModel: plannerModel as never,
      models: { planning: "claude-haiku-5-5", execution: "claude-haiku-5-5" }, resolveAccess: async () => NOT_ADMIN, notify: async () => undefined,
    };
    await runPlanning(deps1, store.missions.get(m.id)!);
    expect(store.missions.get(m.id)!.status).toBe("queued");
    const savedCallsAfterRun1 = await store.listCalls(m.id);
    const savedPeopleRow = savedCallsAfterRun1.find((c) => c.endpoint_id === PEOPLE && c.status === "ok")!;
    expect(savedPeopleRow).toBeDefined();
    const savedPeopleCallId = savedPeopleRow.id.slice(m.id.length + 1);
    const savedCompaniesCallId = savedCallsAfterRun1.find((c) => c.endpoint_id === COMPANIES && c.status === "ok")!.id.slice(m.id.length + 1);

    // Run 2 after memory restart: NO repeated paid treg_call! Proposes unserved_steps first -> gets exact saved call id repair -> maps saved call -> proposes 5 companies + people -> bound to 2 companies x 1 manager
    const run2Steps: FakeStep[] = [
      { tool: "run_code", args: { code: `return inputs.${savedCompaniesCallId}.data.companies.map(r => ({ id: r.linkedin_url, name: r.name, industry: r.industry || '', city: r.city || '', website: r.website_url || '', linkedin: r.linkedin_url || '' }))`, files: [savedCompaniesCallId] } },
      {
        tool: "propose_plan",
        args: (res: Results) => ({
          summary_ar: "ستحصل على شركتي مقاولات في القاهرة.",
          stages: [
            {
              key: "companies", title_ar: "شركات المقاولات في القاهرة", endpoint_id: COMPANIES, expected_rows: 5, parent_key: null, deliver: true,
              columns: ccolumns, measured_by: [savedCompaniesCallId], yield_from: firstOutputId(res),
            },
          ],
          unserved_steps: [{ reason_ar: "المصادر لم ترجع مديرين لهذه الشركات" }],
        }),
      },
      { tool: "run_code", args: { code: `return inputs.${savedPeopleCallId}.results.map(r => { const p = r.person || {}; const exp = (p.experiences && p.experiences[0]) || {}; return { id: p.linkedin_url, full_name: p.full_name, job_title: exp.job_title || '', company: exp.company_name || '', linkedin: p.linkedin_url, email: '', phone: '' }; })`, files: [savedPeopleCallId] } },
      {
        tool: "propose_plan",
        args: (res: Results) => ({
          summary_ar: "ستحصل على شركتي مقاولات في القاهرة ومدير واحد من كل شركة.",
          stages: [
            {
              key: "companies", title_ar: "شركات المقاولات في القاهرة", endpoint_id: COMPANIES, expected_rows: 5, parent_key: null, deliver: true,
              columns: ccolumns, measured_by: [savedCompaniesCallId], yield_from: firstOutputId(res),
            },
            {
              key: "people", title_ar: "مدير كل شركة", endpoint_id: PEOPLE, expected_rows: 5, parent_key: "companies", per_parent_rows: 1, deliver: true,
              columns: pcolumns, measured_by: [savedPeopleCallId], yield_from: lastOutputId(res),
            },
          ],
        }),
      },
    ];
    const run2Driver = createFakeDriver(run2Steps);
    const callMock2 = vi.fn(async () => { throw new Error("must not repeat paid treg_call after saved people call exists"); });
    const deps2: RunnerDeps = {
      ...deps1,
      driver: run2Driver,
      call: callMock2 as never,
    };
    await runPlanning(deps2, { ...store.missions.get(m.id)!, status: "planning" });

    // Repair message named the saved call id and did not trigger a repeated paid call
    const firstProposalToolResult = JSON.stringify(run2Driver.results.find((h) => h.tool === "propose_plan")?.result ?? {});
    expect(firstProposalToolResult).toContain(savedPeopleCallId);
    expect(firstProposalToolResult).toContain(PEOPLE);
    expect(firstProposalToolResult).toMatch(/6 rows|ALREADY returned rows/i);
    expect(callMock2).not.toHaveBeenCalled();

    const finalMission = store.missions.get(m.id)!;
    expect(finalMission.status).toBe("plan_ready");
    const plan = finalMission.plan as any;
    expect(plan.stages.find((s: any) => s.key === "companies")?.planned_rows).toBe(2);
    expect(plan.stages.find((s: any) => s.key === "people")).toMatchObject({ per_parent_rows: 1, planned_rows: 2, measured_from_calls: [savedPeopleCallId] });
    expect(plan.price.deliveredRows).toBe(4);
    expect(money.calls).toHaveLength(0);
  });

  it("Counter #2: all people failed -> people-unavailable (PEOPLE_UNAVAILABLE_AR)", async () => {
    const store = createMemoryStore();
    const money = fakeMoneyClient();
    const rec = fakeRecorder();
    const understanding = rawUnderstandTemplate({ perCompany: 1, perCompanyText: "مدير", companiesTotal: 2, companiesText: "شركتين" });
    const plannerModel = async ({ tool }: { tool: { name: string } }) =>
      tool.name === UNDERSTAND_TOOL ? { input: JSON.parse(JSON.stringify(understanding)), costUsd: 0.001 } : null;

    const callMock = vi.fn(async (o: TregCallOptions): Promise<TregCallResult> => {
      if (o.endpointId === COMPANIES) return tregResult(constructionCompaniesPage, 0.0005);
      throw new Error("provider down");
    });

    const steps: FakeStep[] = [
      { tool: "catalog_search", args: { words: ["companies", "search"], limit: 5 } },
      { tool: "treg_call", args: { endpoint_id: COMPANIES, params: { query: "contracting", page: 1 }, why } },
      { tool: "treg_call", args: { endpoint_id: PEOPLE, params: { company_linkedin_url: linkedinOf("orascom-em"), cascade: [{ include_title: ["CEO"] }], max_results: 5 }, why } },
      { tool: "finish", args: { outcome: "cannot_serve", kind: "unsupported", summary_ar: "تعذّر الوصول لمصادر الأشخاص." } },
      { tool: "finish", args: { outcome: "cannot_serve", kind: "unsupported", summary_ar: "تعذّر الوصول لمصادر الأشخاص." } },
      { tool: "finish", args: { outcome: "cannot_serve", kind: "unsupported", summary_ar: "تعذّر الوصول لمصادر الأشخاص." } },
    ];
    const m = newMission({ id: "msn_r1_fail", user_id: USER_ID, status: "planning", request_text: LIVE_REQ });
    store.missions.set(m.id, m);
    const deps: RunnerDeps = {
      store, client: money.client, catalog, driver: createFakeDriver(steps), recorder: rec.recorder, commit: rec.commit,
      call: callMock as never, plannerModel: plannerModel as never,
      models: { planning: "claude-haiku-5-5", execution: "claude-haiku-5-5" }, resolveAccess: async () => NOT_ADMIN, notify: async () => undefined,
    };
    await runPlanning(deps, m);
    const ended = store.missions.get(m.id)!;
    expect(ended.status).toBe("failed");
    expect(ended.summary_ar).toBe(PEOPLE_UNAVAILABLE_AR);
    expect(ended.error).toMatch(/reason=people_sources_failed/);
  });

  it("Counter #3 (#584 regression): empty-only people samples + estimate -> accepted after 1 repair; stubborn repeated unserved stops cleanly after bounded repair (not 10x) with safe categories/counts", async () => {
    const understanding = rawUnderstandTemplate({ perCompany: 1, perCompanyText: "مدير", companiesTotal: 2, companiesText: "شركتين" });
    const plannerModel = async ({ tool }: { tool: { name: string } }) =>
      tool.name === UNDERSTAND_TOOL ? { input: JSON.parse(JSON.stringify(understanding)), costUsd: 0.001 } : null;

    const emptyCallMock = vi.fn(async (o: TregCallOptions): Promise<TregCallResult> => {
      if (o.endpointId === COMPANIES) return tregResult(constructionCompaniesPage, 0.0005);
      return tregResult({ results: [] }, 0.0005);
    });

    // (A) Repaired on 2nd proposal -> accepted cleanly after 1 repair
    const storeOk = createMemoryStore();
    const moneyOk = fakeMoneyClient();
    const recOk = fakeRecorder();
    storeOk.missions.set("msn_584_ok", newMission({ id: "msn_584_ok", user_id: USER_ID, status: "planning", request_text: LIVE_REQ }));
    const repairSteps: FakeStep[] = [
      { tool: "catalog_search", args: { words: ["companies", "search"], limit: 5 } },
      { tool: "treg_call", args: { endpoint_id: COMPANIES, params: { query: "contracting", page: 1 }, why } },
      { tool: "run_code", args: (r: Results) => ({ code: `return inputs.${callIds(r)[0]}.data.companies.map(r => ({ id: r.linkedin_url, name: r.name, industry: r.industry || '', city: r.city || '', website: r.website_url || '', linkedin: r.linkedin_url || '' }))`, files: [callIds(r)[0]] }) },
      { tool: "treg_call", args: { endpoint_id: PEOPLE, params: { company_linkedin_url: linkedinOf("orascom-em"), cascade: [{ include_title: ["CEO"] }], max_results: 5 }, why } },
      {
        tool: "propose_plan",
        args: (res: Results) => ({
          summary_ar: "ستحصل على شركتي مقاولات في القاهرة.",
          stages: [{ key: "companies", title_ar: "شركات المقاولات في القاهرة", endpoint_id: COMPANIES, expected_rows: 5, parent_key: null, deliver: true, columns: ccolumns, measured_by: [callIds(res)[0]], yield_from: firstOutputId(res) }],
          unserved_steps: [{ reason_ar: "مصادر الأشخاص لم ترجع نتائج" }],
        }),
      },
      {
        tool: "propose_plan",
        args: (res: Results) => ({
          summary_ar: "ستحصل على شركتي مقاولات في القاهرة ومدير من كل شركة.",
          stages: [
            { key: "companies", title_ar: "شركات المقاولات في القاهرة", endpoint_id: COMPANIES, expected_rows: 5, parent_key: null, deliver: true, columns: ccolumns, measured_by: [callIds(res)[0]], yield_from: firstOutputId(res) },
            { key: "people", title_ar: "مدير كل شركة", endpoint_id: ALT, expected_rows: 2, parent_key: "companies", per_parent_rows: 1, deliver: true, columns: pcolumns, measured_by: [] },
          ],
        }),
      },
    ];
    const driverOk = createFakeDriver(repairSteps);
    await runPlanning({
      store: storeOk, client: moneyOk.client, catalog, driver: driverOk, recorder: recOk.recorder, commit: recOk.commit,
      call: emptyCallMock as never, plannerModel: plannerModel as never,
      models: { planning: "claude-haiku-5-5", execution: "claude-haiku-5-5" }, resolveAccess: async () => NOT_ADMIN, notify: async () => undefined,
    }, storeOk.missions.get("msn_584_ok")!);
    expect(storeOk.missions.get("msn_584_ok")!.status).toBe("plan_ready");
    const planOk = storeOk.missions.get("msn_584_ok")!.plan as any;
    expect(planOk.stages.find((s: any) => s.key === "people")).toMatchObject({ estimated: true, per_parent_rows: 1, planned_rows: 2, measured_by: [] });

    // (B) Stubborn 10x unserved repeat must STOP after bounded repair (<= 3 rejections, not 10!)
    const storeLoop = createMemoryStore();
    const moneyLoop = fakeMoneyClient();
    const recLoop = fakeRecorder();
    storeLoop.missions.set("msn_584_loop", newMission({ id: "msn_584_loop", user_id: USER_ID, status: "planning", request_text: LIVE_REQ }));
    const unservedProposal: FakeStep = {
      tool: "propose_plan",
      args: (res: Results) => ({
        summary_ar: "ستحصل على شركتي مقاولات في القاهرة.",
        stages: [{ key: "companies", title_ar: "شركات المقاولات في القاهرة", endpoint_id: COMPANIES, expected_rows: 5, parent_key: null, deliver: true, columns: ccolumns, measured_by: [callIds(res)[0]], yield_from: firstOutputId(res) }],
        unserved_steps: [{ reason_ar: "مصادر الأشخاص لم ترجع نتائج" }],
      }),
    };
    const driverLoop = createFakeDriver([
      { tool: "catalog_search", args: { words: ["companies", "search"], limit: 5 } },
      { tool: "treg_call", args: { endpoint_id: COMPANIES, params: { query: "contracting", page: 1 }, why } },
      { tool: "run_code", args: (r: Results) => ({ code: `return inputs.${callIds(r)[0]}.data.companies.map(r => ({ id: r.linkedin_url, name: r.name, industry: r.industry || '', city: r.city || '', website: r.website_url || '', linkedin: r.linkedin_url || '' }))`, files: [callIds(r)[0]] }) },
      { tool: "treg_call", args: { endpoint_id: PEOPLE, params: { company_linkedin_url: linkedinOf("orascom-em"), cascade: [{ include_title: ["CEO"] }], max_results: 5 }, why } },
      ...Array.from({ length: 10 }, () => unservedProposal),
    ]);
    await runPlanning({
      store: storeLoop, client: moneyLoop.client, catalog, driver: driverLoop, recorder: recLoop.recorder, commit: recLoop.commit,
      call: emptyCallMock as never, plannerModel: plannerModel as never,
      models: { planning: "claude-haiku-5-5", execution: "claude-haiku-5-5" }, resolveAccess: async () => NOT_ADMIN, notify: async () => undefined,
    }, storeLoop.missions.get("msn_584_loop")!);

    const proposalsMade = driverLoop.results.filter((h) => h.tool === "propose_plan").length;
    expect(proposalsMade).toBeLessThanOrEqual(3);
    const loopMission = storeLoop.missions.get("msn_584_loop")!;
    expect(loopMission.status).toBe("failed");
    expect(loopMission.error).toMatch(/^admin: planning_failed class=internal reason=plan_invalid_after_[23]_rejections/);
    const admFlag = storeLoop.events.find((e) => e.counts?.adm_flag === 1);
    expect(admFlag?.counts).toMatchObject({ adm_flag: 1, issue_people_estimate_unserved: proposalsMade });
  });

  it("Counter #4 & #5: (4) one empty + one failed and no estimate -> unserved accepted; (5) incompatible people rows -> no fabricated measured card", async () => {
    // Counter #4: no understoodPeople (so no peopleEstimate), 1 empty + 1 failed -> unserved_steps accepted
    const calls = new Map([
      ["call_0001", { id: "call_0001", endpointId: COMPANIES, ok: true, costUsd: 0.0005, rows: 5, params: { query: "contracting" } }],
    ]);
    const lookup4: PlanLookup = {
      call: (id) => calls.get(id) ?? null,
      evidenceText: () => `${linkedinOf("orascom-em")} Orascom Contracting`,
      endpointAllowed: () => true,
      requestText: "عايز ٥ شركات مقاولات في القاهرة ومن كل شركة مدير",
      childStepSources: () => peopleSourcesForCompanies(catalog, allowed),
      endpointsCalled: () => new Map([[PEOPLE, { rows: 0 }], [ALT, { rows: 0 }]]),
    };
    const r4 = validateAndPricePlan({
      summary_ar: "ستحصل على شركتي مقاولات في القاهرة.",
      stages: [{ key: "companies", title_ar: "شركات المقاولات في القاهرة", endpoint_id: COMPANIES, expected_rows: 2, parent_key: null, deliver: true, columns: ccolumns, sample_rows: [{ id: linkedinOf("orascom-em"), name: "Orascom Contracting", industry: "Construction & Contracting", city: "Cairo", website: "orascom-em.com.eg", linkedin: linkedinOf("orascom-em") }], measured_by: ["call_0001"] }],
      unserved_steps: [{ reason_ar: "لم تُرجع المصادر المتاحة أسماء مديرين لهذه الشركات" }],
    }, lookup4);
    expect(r4.ok, JSON.stringify(r4)).toBe(true);
    if (r4.ok) expect(r4.plan.unserved_steps).toHaveLength(1);

    // Counter #5: saved people rows are empty/malformed/missing mapped person fields -> no fabricated measured card
    // Tested end-to-end through runPlanning: incompatible run_code output -> propose_plan rejects (deriveEngineSpecsChecked),
    // and repeated cannot_serve ends without producing a card while recording safe issue categories/counts.
    const store5 = createMemoryStore();
    const money5 = fakeMoneyClient();
    const rec5 = fakeRecorder();
    store5.missions.set("msn_r1_incompat", newMission({ id: "msn_r1_incompat", user_id: USER_ID, status: "planning", request_text: LIVE_REQ }));
    const callMock5 = vi.fn(async (o: TregCallOptions): Promise<TregCallResult> => {
      if (o.endpointId === COMPANIES) return tregResult(constructionCompaniesPage, 0.0005);
      return tregResult({ results: [{ unrelated: "blob" }] }, 0.0005);
    });
    const understanding5 = rawUnderstandTemplate({ perCompany: 1, perCompanyText: "مدير", companiesTotal: 2, companiesText: "شركتين" });
    const plannerModel5 = async ({ tool }: { tool: { name: string } }) =>
      tool.name === UNDERSTAND_TOOL ? { input: JSON.parse(JSON.stringify(understanding5)), costUsd: 0.001 } : null;
    const incompatSteps: FakeStep[] = [
      { tool: "catalog_search", args: { words: ["companies", "search"], limit: 5 } },
      { tool: "treg_call", args: { endpoint_id: COMPANIES, params: { query: "contracting", page: 1 }, why } },
      { tool: "run_code", args: (r: Results) => ({ code: `return inputs.${callIds(r)[0]}.data.companies.map(r => ({ id: r.linkedin_url, name: r.name, industry: r.industry || '', city: r.city || '', website: r.website_url || '', linkedin: r.linkedin_url || '' }))`, files: [callIds(r)[0]] }) },
      { tool: "treg_call", args: { endpoint_id: PEOPLE, params: { company_linkedin_url: linkedinOf("orascom-em"), cascade: [{ include_title: ["CEO"] }], max_results: 5 }, why } },
      { tool: "run_code", args: (r: Results) => ({ code: `return inputs.${callIds(r)[1]}.results.map(r => ({ id: 'bad_1', unrelated: r.unrelated }))`, files: [callIds(r)[1]] }) },
      {
        tool: "propose_plan",
        args: (res: Results) => ({
          summary_ar: "ستحصل على شركتي مقاولات في القاهرة ومدير من كل شركة.",
          stages: [
            { key: "companies", title_ar: "شركات المقاولات في القاهرة", endpoint_id: COMPANIES, expected_rows: 2, parent_key: null, deliver: true, columns: ccolumns, measured_by: [callIds(res)[0]], yield_from: firstOutputId(res) },
            { key: "people", title_ar: "مدير كل شركة", endpoint_id: PEOPLE, expected_rows: 2, parent_key: "companies", per_parent_rows: 1, deliver: true, columns: pcolumns, measured_by: [callIds(res)[1]], yield_from: lastOutputId(res) },
          ],
        }),
      },
      { tool: "finish", args: { outcome: "cannot_serve", kind: "unsupported", summary_ar: "البيانات لا تكفي." } },
      { tool: "finish", args: { outcome: "cannot_serve", kind: "unsupported", summary_ar: "البيانات لا تكفي." } },
      { tool: "finish", args: { outcome: "cannot_serve", kind: "unsupported", summary_ar: "البيانات لا تكفي." } },
    ];
    await runPlanning({
      store: store5, client: money5.client, catalog, driver: createFakeDriver(incompatSteps), recorder: rec5.recorder, commit: rec5.commit,
      call: callMock5 as never, plannerModel: plannerModel5 as never,
      models: { planning: "claude-haiku-5-5", execution: "claude-haiku-5-5" }, resolveAccess: async () => NOT_ADMIN, notify: async () => undefined,
    }, store5.missions.get("msn_r1_incompat")!);
    const m5 = store5.missions.get("msn_r1_incompat")!;
    expect(m5.plan ?? null).toBeNull();
    expect(m5.status).toBe("failed");
    expect(m5.error).toMatch(/^admin: planning_failed class=internal reason=plan_invalid_after_1_rejections/);
    expect(store5.events.find((e) => e.counts?.adm_flag === 1)?.counts).toMatchObject({ adm_flag: 1, issue_missing_column_or_mapping: 1 });
  });
});
