import { describe, expect, it, vi } from "vitest";
import { createFakeDriver, type FakeStep } from "../agent/src/fakeDriver";
import { createMemoryStore, newMission } from "../agent/src/memoryStore";
import { runPlanning, type RunnerDeps } from "../agent/src/runMission";
import { readRunState } from "../agent/src/runState";
import { UNDERSTAND_TOOL } from "../agent/src/llmPlanner/prompts";
import { capabilitiesOf } from "../agent/src/llmPlanner/catalogView";
import { PEOPLE_OF_COMPANY_CAPABILITIES } from "../src/lib/agentMission/childSources";
import { EMPTY_SOURCE_AR, INTERNAL_PLANNING_AR, PEOPLE_UNAVAILABLE_AR } from "../src/lib/agentMission/refusal";
import { MISSION_PRICING_SETTING_KEY } from "../src/lib/missionPricing";
import { checkCustomerText } from "../src/lib/agentMission/text";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { NOT_ADMIN, USER_ID, fakeRecorder, tregResult } from "./helpers/agentHarness";
import { fakeMoneyClient } from "./helpers/agentMoney";
import { COMPANIES, PEOPLE, SLUGS, ccolumns, linkedinOf, pcolumns, peopleOfCompany, why } from "./helpers/a1World";
import { callIds, lastOutputId, type Results } from "./helpers/agentFakeWorld";
import { firstOutputId } from "./helpers/agentRelevance";
import type { TregCallOptions, TregCallResult } from "../src/functions/shared/tregClient";

/**
 * DT-20261119-10b (P0 + D-0140): shared saved-evidence recovery before EVERY terminal no-card decision
 * (repeated formal/child cap, engine derivation rejection, model finish, SDK stop), plus 50/100/200 scale
 * and all counter-cases.
 */
vi.stubGlobal("fetch", () => { throw new Error("a real network call was attempted"); });

const catalog = loadTregCatalog();
const COMPANIES_CAP = [...capabilitiesOf(catalog, NOT_ADMIN, "companies")].sort().find((c) => !PEOPLE_OF_COMPANY_CAPABILITIES.has(c))!;
const R2_REQ = "عايز شركتين برمجيات في القاهرة ومن كل شركة مدير";
const R4_REQ = "عايز شركتين تسويق في القاهرة ومدير كل شركة بالإيميل ورقم التليفون";
const R3_REQ = "٥ شركات شحن في مصر بالإيميل والتليفون";

const swCompaniesPage = {
  data: {
    companies: SLUGS.slice(0, 2).map((slug, i) => ({
      id: linkedinOf(slug),
      name: `${i === 0 ? "Nile Soft" : "Cairo Dev"} Technologies`,
      website_url: `${slug}.com.eg`,
      linkedin_url: linkedinOf(slug),
      country: "EG",
      city: "Cairo",
      industry: "Software Development",
      description: "B2B software and marketing technology company in Cairo Egypt",
    })),
  },
};

function understandPayload(over: {
  total?: number;
  companiesText?: string;
  perCompany?: number | null;
  perCompanyText?: string;
  contactKinds?: Array<"email" | "phone">;
  topic?: string;
  titleAr?: string;
}) {
  return {
    decision: "plan",
    understanding_ar: `${over.titleAr ?? "شركات في القاهرة"} ومدير من كل شركة.`,
    accepts_available: false,
    steps: [
      {
        key: "companies",
        title_ar: over.titleAr ?? "شركات برمجيات في القاهرة",
        platform: "companies",
        capability: COMPANIES_CAP,
        parent: "",
        deliver: true,
        count: { total: over.total ?? 2, all: false },
        topic: over.topic ?? "software",
        search_terms: [over.topic ?? "software"],
        country: "EG",
      },
    ],
    people_of_companies: {
      asked: true,
      title_ar: "المديرين",
      per_company: over.perCompany === undefined ? 1 : (over.perCompany ?? 0),
      per_company_text: over.perCompanyText ?? "مدير",
      companies_text: over.companiesText ?? "شركتين",
      contact_kinds: over.contactKinds ?? [],
    },
  };
}

function assertCleanPlanCopy(plan: Record<string, any>) {
  const texts = [
    plan.summary_ar,
    ...(plan.assumptions_ar ?? []),
    ...(plan.notes_ar ?? []),
    ...((plan.stages ?? []).flatMap((s: any) => [s.title_ar, s.how_ar].filter(Boolean))),
  ].filter((t): t is string => typeof t === "string" && t.length > 0);
  for (const t of texts) {
    expect(checkCustomerText(t).issues, t).toEqual([]);
    expect(t).not.toMatch(/blitzapi|tomba|apollo|aviato|enrichlayer|treg_call|run_code|402|422/i);
  }
}

async function runScenario(opts: {
  id: string;
  requestText: string;
  answerText?: string | null;
  steps: FakeStep[];
  callHandler: (o: TregCallOptions) => Promise<TregCallResult>;
  understanding: ReturnType<typeof understandPayload>;
  budgetUsd?: number;
  settings?: Record<string, unknown>;
}) {
  const store = createMemoryStore();
  if (opts.settings) Object.assign(store.settings, opts.settings);
  const money = fakeMoneyClient();
  const rec = fakeRecorder();
  const m = newMission({
    id: opts.id,
    user_id: USER_ID,
    status: "planning",
    request_text: opts.requestText,
    ...(opts.answerText ? { answer_text: opts.answerText } : {}),
  });
  store.missions.set(m.id, m);
  const call = vi.fn(opts.callHandler);
  const plannerModel = async ({ tool }: { tool: { name: string } }) =>
    tool.name === UNDERSTAND_TOOL ? { input: JSON.parse(JSON.stringify(opts.understanding)), costUsd: 0.001 } : null;
  const driver = createFakeDriver(opts.steps);
  const logs: string[] = [];
  await runPlanning({
    store, client: money.client, catalog, driver, recorder: rec.recorder, commit: rec.commit,
    call: call as never, plannerModel: plannerModel as never,
    models: { planning: "claude-haiku-5-5", execution: "claude-haiku-5-5" },
    resolveAccess: async () => NOT_ADMIN, notify: async () => undefined, log: (l) => logs.push(l),
  }, m);
  return { mission: store.missions.get(m.id)!, store, money, call, driver, logs };
}

describe("DT-20261119-10b P0: saved-evidence recovery on ALL no-card terminal paths", () => {
  const invalidChildProposal: FakeStep = {
    tool: "propose_plan",
    args: (r: Results) => ({
      summary_ar: "ستحصل على شركتي برمجيات في القاهرة ومدير من كل شركة.",
      stages: [
        { key: "companies", title_ar: "شركات برمجيات في القاهرة", endpoint_id: COMPANIES, expected_rows: 2, parent_key: null, deliver: true, columns: ccolumns, measured_by: [callIds(r)[0]], yield_from: firstOutputId(r) },
        { key: "people", title_ar: "مدير كل شركة", endpoint_id: PEOPLE, expected_rows: 2, parent_key: "companies", per_parent_rows: 1, deliver: true, columns: pcolumns, measured_by: ["call_9999"] },
      ],
    }),
  };

  it("Bypass 1 (LIVE3 RCA repro): repeated invalid child proposal (missing_measured_call) for R2 & R4 -> plan_ready card (2x1, R4 email+phone), never INTERNAL_PLANNING_AR", async () => {
    const r2 = await runScenario({
      id: "msn_10b_r2_cap",
      requestText: R2_REQ,
      understanding: understandPayload({ perCompany: 1, perCompanyText: "مدير", companiesText: "شركتين" }),
      callHandler: async (o) => (o.endpointId === COMPANIES ? tregResult(swCompaniesPage, 0.0005) : tregResult(peopleOfCompany("orascom-em"), 0.0005)),
      steps: [
        { tool: "catalog_search", args: { words: ["companies", "search"], limit: 5 } },
        { tool: "treg_call", args: { endpoint_id: COMPANIES, params: { query: "software", page: 1 }, why } },
        { tool: "run_code", args: (r: Results) => ({ code: `return inputs.${callIds(r)[0]}.data.companies.map(r => ({ id: r.linkedin_url, name: r.name, industry: r.industry || '', city: r.city || '', website: r.website_url || '', linkedin: r.linkedin_url || '' }))`, files: [callIds(r)[0]] }) },
        { tool: "treg_call", args: { endpoint_id: PEOPLE, params: { company_linkedin_url: linkedinOf("orascom-em"), cascade: [{ include_title: ["CEO"] }], max_results: 10 }, why } },
        invalidChildProposal, invalidChildProposal, invalidChildProposal,
      ],
    });
    expect(r2.mission.status).toBe("plan_ready");
    expect(r2.mission.summary_ar).not.toBe(INTERNAL_PLANNING_AR);
    expect(r2.call).toHaveBeenCalledTimes(2);
    expect(r2.money.calls).toHaveLength(0);
    const p2 = r2.mission.plan as any;
    expect(p2.stages.find((s: any) => s.key === "companies")?.planned_rows).toBe(2);
    expect(p2.stages.find((s: any) => s.key === "people")).toMatchObject({ parent_key: "companies", per_parent_rows: 1, planned_rows: 2, deliver: true });
    assertCleanPlanCopy(p2);

    const r4 = await runScenario({
      id: "msn_10b_r4_cap",
      requestText: R4_REQ,
      understanding: understandPayload({ perCompany: 1, perCompanyText: "ومدير كل شركة", companiesText: "شركتين", contactKinds: ["email", "phone"], topic: "marketing", titleAr: "شركات تسويق في القاهرة" }),
      callHandler: async (o) => (o.endpointId === COMPANIES ? tregResult(swCompaniesPage, 0.0005) : tregResult(peopleOfCompany("orascom-em"), 0.0005)),
      steps: [
        { tool: "catalog_search", args: { words: ["companies", "search"], limit: 5 } },
        { tool: "treg_call", args: { endpoint_id: COMPANIES, params: { query: "marketing", page: 1 }, why } },
        { tool: "run_code", args: (r: Results) => ({ code: `return inputs.${callIds(r)[0]}.data.companies.map(r => ({ id: r.linkedin_url, name: r.name, industry: r.industry || '', city: r.city || '', website: r.website_url || '', linkedin: r.linkedin_url || '' }))`, files: [callIds(r)[0]] }) },
        { tool: "treg_call", args: { endpoint_id: PEOPLE, params: { company_linkedin_url: linkedinOf("orascom-em"), cascade: [{ include_title: ["CEO"] }], max_results: 10 }, why } },
        invalidChildProposal, invalidChildProposal, invalidChildProposal,
      ],
    });
    expect(r4.mission.status).toBe("plan_ready");
    expect(r4.call).toHaveBeenCalledTimes(2);
    expect(r4.money.calls).toHaveLength(0);
    const p4 = r4.mission.plan as any;
    const kinds = new Set((p4.contact_steps ?? []).map((s: any) => s.kind));
    expect(kinds.has("email")).toBe(true);
    expect(kinds.has("phone")).toBe(true);
    assertCleanPlanCopy(p4);
  });

  it("Bypass 2: engine derivation rejection cap -> recovers validated 2x1 card, zero extra call", async () => {
    const brokenEngineProposal: FakeStep = {
      tool: "propose_plan",
      args: (r: Results) => ({
        summary_ar: "ستحصل على شركتي برمجيات في القاهرة ومدير من كل شركة.",
        stages: [
          { key: "companies", title_ar: "شركات برمجيات في القاهرة", endpoint_id: COMPANIES, expected_rows: 2, parent_key: null, deliver: true, columns: ccolumns, measured_by: [callIds(r)[0]], yield_from: firstOutputId(r) },
          // missing required `id` field in yield_from mapping -> fails deriveEngineSpecsChecked!
          { key: "people", title_ar: "مدير كل شركة", endpoint_id: PEOPLE, expected_rows: 2, parent_key: "companies", per_parent_rows: 1, deliver: true, columns: pcolumns, measured_by: [callIds(r)[1]], yield_from: lastOutputId(r) },
        ],
      }),
    };
    const r = await runScenario({
      id: "msn_10b_engine_reject",
      requestText: R2_REQ,
      understanding: understandPayload({}),
      callHandler: async (o) => (o.endpointId === COMPANIES ? tregResult(swCompaniesPage, 0.0005) : tregResult(peopleOfCompany("orascom-em"), 0.0005)),
      steps: [
        { tool: "catalog_search", args: { words: ["companies", "search"], limit: 5 } },
        { tool: "treg_call", args: { endpoint_id: COMPANIES, params: { query: "software", page: 1 }, why } },
        { tool: "run_code", args: (r: Results) => ({ code: `return inputs.${callIds(r)[0]}.data.companies.map(r => ({ id: r.linkedin_url, name: r.name, industry: r.industry || '', city: r.city || '', website: r.website_url || '', linkedin: r.linkedin_url || '' }))`, files: [callIds(r)[0]] }) },
        { tool: "treg_call", args: { endpoint_id: PEOPLE, params: { company_linkedin_url: linkedinOf("orascom-em"), cascade: [{ include_title: ["CEO"] }], max_results: 10 }, why } },
        // mapping drops `id` field -> deriveEngineSpecsChecked rejects!
        { tool: "run_code", args: (r: Results) => ({ code: `return inputs.${callIds(r)[1]}.results.map(r => ({ full_name: r.person.full_name, job_title: r.person.experiences[0].job_title, company: r.person.experiences[0].company_name, linkedin: r.person.linkedin_url, email: '', phone: '' }))`, files: [callIds(r)[1]] }) },
        brokenEngineProposal, brokenEngineProposal, brokenEngineProposal,
      ],
    });
    expect(r.mission.status).toBe("plan_ready");
    expect(r.call).toHaveBeenCalledTimes(2);
    expect(r.money.calls).toHaveLength(0);
    expect((r.mission.plan as any).stages.find((s: any) => s.key === "people")?.engine?.map_file_id).toBeTruthy();
  });

  it("Bypass 3 & 4: model finish(cannot_serve) OR silent SDK stop with saved company + linked people evidence -> recovers validated plan_ready card", async () => {
    const modelFinish = await runScenario({
      id: "msn_10b_model_finish",
      requestText: R2_REQ,
      understanding: understandPayload({}),
      callHandler: async (o) => (o.endpointId === COMPANIES ? tregResult(swCompaniesPage, 0.0005) : tregResult(peopleOfCompany("orascom-em"), 0.0005)),
      steps: [
        { tool: "catalog_search", args: { words: ["companies", "search"], limit: 5 } },
        { tool: "treg_call", args: { endpoint_id: COMPANIES, params: { query: "software", page: 1 }, why } },
        { tool: "treg_call", args: { endpoint_id: PEOPLE, params: { company_linkedin_url: linkedinOf("orascom-em"), cascade: [{ include_title: ["CEO"] }], max_results: 1 }, why } },
        { tool: "finish", args: { outcome: "cannot_serve", kind: "unsupported", summary_ar: "تعذر إعداد الخطة." } },
        { tool: "finish", args: { outcome: "cannot_serve", kind: "unsupported", summary_ar: "تعذر إعداد الخطة." } },
        { tool: "finish", args: { outcome: "cannot_serve", kind: "unsupported", summary_ar: "تعذر إعداد الخطة." } },
      ],
    });
    expect(modelFinish.mission.status).toBe("plan_ready");
    expect(modelFinish.call).toHaveBeenCalledTimes(2);

    const sdkStop = await runScenario({
      id: "msn_10b_sdk_stop",
      requestText: R4_REQ,
      understanding: understandPayload({ perCompany: 1, perCompanyText: "ومدير كل شركة", companiesText: "شركتين", contactKinds: ["email", "phone"], topic: "marketing", titleAr: "شركات تسويق في القاهرة" }),
      callHandler: async (o) => (o.endpointId === COMPANIES ? tregResult(swCompaniesPage, 0.0005) : tregResult(peopleOfCompany("orascom-em"), 0.0005)),
      steps: [
        { tool: "catalog_search", args: { words: ["companies", "search"], limit: 5 } },
        { tool: "treg_call", args: { endpoint_id: COMPANIES, params: { query: "marketing", page: 1 }, why } },
        { tool: "treg_call", args: { endpoint_id: PEOPLE, params: { company_linkedin_url: linkedinOf("orascom-em"), cascade: [{ include_title: ["CEO"] }], max_results: 1 }, why } },
        // no propose_plan, no finish -> driver stops (`end` / sdk_stop) while worker owns mission
      ],
    });
    expect(sdkStop.mission.status).toBe("plan_ready");
    expect(sdkStop.call).toHaveBeenCalledTimes(2);
    const pSdk = sdkStop.mission.plan as any;
    expect(new Set((pSdk.contact_steps ?? []).map((s: any) => s.kind))).toEqual(new Set(["email", "phone"]));
  });

  it("Question persistence across resumes + already-answered counter-case: asks AT MOST ONCE across worker resumes", async () => {
    const store = createMemoryStore();
    const money = fakeMoneyClient();
    const rec = fakeRecorder();
    const m = newMission({ id: "msn_10b_q_resume", user_id: USER_ID, status: "planning", request_text: R2_REQ });
    store.missions.set(m.id, m);
    const uModel = async ({ tool }: { tool: { name: string } }) =>
      tool.name === UNDERSTAND_TOOL ? { input: understandPayload({}), costUsd: 0.001 } : null;
    const callMock = vi.fn(async (o: TregCallOptions) =>
      o.endpointId === COMPANIES
        ? tregResult(swCompaniesPage, 0.0005)
        : tregResult({ results: [{ id: "p_other", full_name: "Ali Hassan", job_title: "Director", company: "Unrelated Corp", linkedin: "https://linkedin.com/in/ali" }] }, 0.0005));

    // Run 1: wrong/unlinked company rows -> asks ONE specific contextual question & persists asked in run_state
    await runPlanning({
      store, client: money.client, catalog,
      driver: createFakeDriver([
        { tool: "catalog_search", args: { words: ["companies", "search"], limit: 5 } },
        { tool: "treg_call", args: { endpoint_id: COMPANIES, params: { query: "software", page: 1 }, why } },
        { tool: "treg_call", args: { endpoint_id: "blitzapi.people.search", params: { company_linkedin_url: "https://linkedin.example/company/other-co", max_results: 1 }, why } },
      ]),
      recorder: rec.recorder, commit: rec.commit, call: callMock as never, plannerModel: uModel as never,
      models: { planning: "claude-haiku-5-5", execution: "claude-haiku-5-5" }, resolveAccess: async () => NOT_ADMIN, notify: async () => undefined,
    }, store.missions.get(m.id)!);

    const after1 = store.missions.get(m.id)!;
    expect(after1.status).toBe("needs_input");
    expect(after1.question_ar).toBeTruthy();
    expect((await readRunState(store, m.id)).peopleRecoveryAsked).toBe(true);

    // Run 2 (resume after question answered -> even if SDK stops with no card, MUST NOT ask a second question!)
    store.missions.set(m.id, { ...after1, status: "planning", question_ar: null, answer_text: "تحديد شركات أو مجال آخر" });
    await runPlanning({
      store, client: money.client, catalog,
      driver: createFakeDriver([]),
      recorder: rec.recorder, commit: rec.commit, call: callMock as never, plannerModel: uModel as never,
      models: { planning: "claude-haiku-5-5", execution: "claude-haiku-5-5" }, resolveAccess: async () => NOT_ADMIN, notify: async () => undefined,
    }, store.missions.get(m.id)!);

    const after2 = store.missions.get(m.id)!;
    expect(after2.status).not.toBe("needs_input");
  });
});

describe("DT-20261119-10b D-0140 Scale (50, 100, 200 companies × 1–2 managers, with & without email/phone) + R3", () => {
  it.each([
    { companies: 50, perParent: 1, contacts: [] as Array<"email" | "phone"> },
    { companies: 50, perParent: 2, contacts: ["email", "phone"] as Array<"email" | "phone"> },
    { companies: 100, perParent: 1, contacts: ["email", "phone"] as Array<"email" | "phone"> },
    { companies: 100, perParent: 2, contacts: [] as Array<"email" | "phone"> },
    { companies: 200, perParent: 1, contacts: [] as Array<"email" | "phone"> },
    { companies: 200, perParent: 2, contacts: ["email", "phone"] as Array<"email" | "phone"> },
  ])("scale $companies companies × $perParent managers (contacts: $contacts): small child sample stays $perParent, card delivers full counts, ZERO spend", async ({ companies, perParent, contacts }) => {
    const contactPhrase = contacts.length > 0 ? " بالإيميل ورقم التليفون" : "";
    const managerPhrase = perParent === 1 ? "ومدير كل شركة" : "ومن كل شركة اتنين من المديرين";
    const req = `عايز ${companies} شركة برمجيات في القاهرة ${managerPhrase}${contactPhrase}`;
    const res = await runScenario({
      id: `msn_scale_${companies}_${perParent}_${contacts.length}`,
      requestText: req,
      // Under current read-only JOB_MAX_POINTS_CAP (25,000), markup=1 keeps 100/200+email+phone within cap so we verify full-count recovery card end-to-end (DT-11 owns cap/pricing scaling); default markup overCap is tested separately below.
      ...(contacts.length > 0 && companies >= 100 ? { settings: { [MISSION_PRICING_SETTING_KEY]: { markup: 1, min_charge_points: 0 } } } : {}),
      understanding: understandPayload({
        total: companies,
        companiesText: `${companies} شركة`,
        perCompany: perParent,
        perCompanyText: perParent === 1 ? "ومدير كل شركة" : "اتنين من المديرين",
        contactKinds: contacts,
      }),
      callHandler: async (o) => (o.endpointId === COMPANIES ? tregResult(swCompaniesPage, 0.0005) : tregResult(peopleOfCompany("orascom-em"), 0.0005)),
      steps: [
        { tool: "catalog_search", args: { words: ["companies", "search"], limit: 5 } },
        { tool: "treg_call", args: { endpoint_id: COMPANIES, params: { query: "software", page: 1 }, why } },
        { tool: "run_code", args: (r: Results) => ({ code: `return inputs.${callIds(r)[0]}.data.companies.map(r => ({ id: r.linkedin_url, name: r.name, industry: r.industry || '', city: r.city || '', website: r.website_url || '', linkedin: r.linkedin_url || '' }))`, files: [callIds(r)[0]] }) },
        { tool: "treg_call", args: { endpoint_id: PEOPLE, params: { company_linkedin_url: linkedinOf("orascom-em"), cascade: [{ include_title: ["CEO"] }], max_results: 10 }, why } },
        // Scripted planner stops with repeated invalid child proposal (missing_measured_call)
        ...Array.from({ length: 3 }, (): FakeStep => ({
          tool: "propose_plan",
          args: (r: Results) => ({
            summary_ar: `ستحصل على ${companies} شركة برمجيات في القاهرة.`,
            stages: [
              { key: "companies", title_ar: "شركات برمجيات في القاهرة", endpoint_id: COMPANIES, expected_rows: companies, parent_key: null, deliver: true, columns: ccolumns, measured_by: [callIds(r)[0]], yield_from: firstOutputId(r) },
              { key: "people", title_ar: "مدير كل شركة", endpoint_id: PEOPLE, expected_rows: companies * perParent, parent_key: "companies", per_parent_rows: perParent, deliver: true, columns: pcolumns, measured_by: ["call_9999"] },
            ],
          }),
        })),
      ],
    });

    expect(res.mission.status, `${res.mission.error ?? ""} | ${res.logs.filter(l => l.includes("company_people_recovery") || l.includes("no_card")).join(" || ")}`).toBe("plan_ready");
    expect(res.mission.summary_ar).not.toBe(INTERNAL_PLANNING_AR);
    expect(res.money.calls).toHaveLength(0); // zero holds/charges before approval
    // C5: planning sample stayed small (per_parent = 1 or 2), did NOT grow with 50/100/200!
    const peopleSampleCall = res.call.mock.calls.find(([c]) => c.endpointId === PEOPLE)?.[0];
    expect((peopleSampleCall?.params as any)?.max_results).toBe(perParent);
    expect(res.call).toHaveBeenCalledTimes(2); // no extra paid call from recovery
    const plan = res.mission.plan as any;
    expect(plan.stages.find((s: any) => s.key === "companies")?.planned_rows).toBe(companies);
    expect(plan.stages.find((s: any) => s.key === "people")).toMatchObject({ parent_key: "companies", per_parent_rows: perParent, planned_rows: companies * perParent });
    if (contacts.length > 0) {
      const kinds = new Set((plan.contact_steps ?? []).map((s: any) => s.kind));
      expect(kinds.has("email")).toBe(true);
      expect(kinds.has("phone")).toBe(true);
    }
    assertCleanPlanCopy(plan);
  });

  it("scale 200 companies × 2 managers + contacts under default markup (hits read-only 25k cap) -> asks 1 capacity question, never INTERNAL_PLANNING_AR", async () => {
    const req = "عايز 200 شركة برمجيات في القاهرة ومن كل شركة اتنين من المديرين بالإيميل ورقم التليفون";
    const res = await runScenario({
      id: "msn_scale_200_overcap_question",
      requestText: req,
      understanding: understandPayload({ total: 200, companiesText: "200 شركة", perCompany: 2, perCompanyText: "اتنين من المديرين", contactKinds: ["email", "phone"] }),
      callHandler: async (o) => (o.endpointId === COMPANIES ? tregResult(swCompaniesPage, 0.0005) : tregResult(peopleOfCompany("orascom-em"), 0.0005)),
      steps: [
        { tool: "catalog_search", args: { words: ["companies", "search"], limit: 5 } },
        { tool: "treg_call", args: { endpoint_id: COMPANIES, params: { query: "software", page: 1 }, why } },
        { tool: "run_code", args: (r: Results) => ({ code: `return inputs.${callIds(r)[0]}.data.companies.map(r => ({ id: r.linkedin_url, name: r.name, industry: r.industry || '', city: r.city || '', website: r.website_url || '', linkedin: r.linkedin_url || '' }))`, files: [callIds(r)[0]] }) },
        { tool: "treg_call", args: { endpoint_id: PEOPLE, params: { company_linkedin_url: linkedinOf("orascom-em"), cascade: [{ include_title: ["CEO"] }], max_results: 2 }, why } },
        ...Array.from({ length: 3 }, (): FakeStep => ({
          tool: "propose_plan",
          args: (r: Results) => ({
            summary_ar: "ستحصل على 200 شركة برمجيات في القاهرة.",
            stages: [
              { key: "companies", title_ar: "شركات برمجيات في القاهرة", endpoint_id: COMPANIES, expected_rows: 200, parent_key: null, deliver: true, columns: ccolumns, measured_by: [callIds(r)[0]], yield_from: firstOutputId(r) },
              { key: "people", title_ar: "مدير كل شركة", endpoint_id: PEOPLE, expected_rows: 400, parent_key: "companies", per_parent_rows: 2, deliver: true, columns: pcolumns, measured_by: ["call_9999"] },
            ],
          }),
        })),
      ],
    });
    expect(res.mission.status).toBe("needs_input");
    expect(res.mission.summary_ar ?? "").not.toBe(INTERNAL_PLANNING_AR);
    expect(res.mission.question_ar).toMatch(/الحد الأقصى/);
  });

  it("LIVE3 scale repro (msn_02e769c04471282310b5): 100×1 email+phone under default markup -> 1 capacity question, never plan_invalid_after_N / INTERNAL_PLANNING_AR", async () => {
    const req = "١٠٠ شركة برمجيات في مصر ومن كل شركة مدير بالإيميل والتليفون";
    const res = await runScenario({
      id: "msn_100x1_live_repro",
      requestText: req,
      understanding: understandPayload({ total: 100, companiesText: "١٠٠ شركة", perCompany: 1, perCompanyText: "مدير", contactKinds: ["email", "phone"] }),
      callHandler: async (o) => (o.endpointId === COMPANIES ? tregResult(swCompaniesPage, 0.0005) : tregResult(peopleOfCompany("orascom-em"), 0.0005)),
      steps: [
        { tool: "catalog_search", args: { words: ["companies", "search"], limit: 5 } },
        { tool: "treg_call", args: { endpoint_id: COMPANIES, params: { query: "software", page: 1 }, why } },
        { tool: "run_code", args: (r: Results) => ({ code: `return inputs.${callIds(r)[0]}.data.companies.map(r => ({ id: r.linkedin_url, name: r.name, industry: r.industry || '', city: r.city || '', website: r.website_url || '', linkedin: r.linkedin_url || '' }))`, files: [callIds(r)[0]] }) },
        { tool: "treg_call", args: { endpoint_id: PEOPLE, params: { company_linkedin_url: linkedinOf("orascom-em"), cascade: [{ include_title: ["CEO"] }], max_results: 1 }, why } },
        ...Array.from({ length: 3 }, (): FakeStep => ({
          tool: "propose_plan",
          args: (r: Results) => ({
            summary_ar: "ستحصل على ١٠٠ شركة برمجيات في مصر.",
            stages: [
              { key: "companies", title_ar: "شركات برمجيات في مصر", endpoint_id: COMPANIES, expected_rows: 100, parent_key: null, deliver: true, columns: ccolumns, measured_by: [callIds(r)[0]], yield_from: firstOutputId(r) },
              { key: "people", title_ar: "مدير كل شركة", endpoint_id: PEOPLE, expected_rows: 100, parent_key: "companies", per_parent_rows: 1, deliver: true, columns: pcolumns, measured_by: ["call_9999"] },
            ],
          }),
        })),
      ],
    });
    expect(["plan_ready", "needs_input"]).toContain(res.mission.status);
    expect(res.mission.summary_ar ?? "").not.toBe(INTERNAL_PLANNING_AR);
    expect(res.mission.error ?? "").not.toMatch(/plan_invalid_after/);
    expect(res.money.calls).toHaveLength(0);
  });

  it("Planning deferral resume from saved samples: resumed worker builds card from saved evidence without re-calling paid providers", async () => {
    const store = createMemoryStore();
    const money = fakeMoneyClient();
    const rec = fakeRecorder();
    const m = newMission({ id: "msn_10b_deferral_resume", user_id: USER_ID, status: "planning", request_text: R2_REQ });
    store.missions.set(m.id, m);
    const uModel = async ({ tool }: { tool: { name: string } }) =>
      tool.name === UNDERSTAND_TOOL ? { input: understandPayload({}), costUsd: 0.001 } : null;

    // Turn 1: worker collects samples then defers (simulated worker restart / stop without calling propose_plan -> wait: simulate restart before completion by writing calls/raw or stopping mid-run)
    const turn1Calls = vi.fn(async (o: TregCallOptions) => (o.endpointId === COMPANIES ? tregResult(swCompaniesPage, 0.0005) : tregResult(peopleOfCompany("orascom-em"), 0.0005)));
    await runPlanning({
      store, client: money.client, catalog,
      driver: {
        async run() {
          // Simulate SDK saving calls in Run 1, then hit load/restart requeue (`stop: "error", error: "SIGTERM"`)
          await store.addCall({ id: `${m.id}:call_0001`, mission_id: m.id, phase: "planning", endpoint_id: COMPANIES, status: "ok", refused_reason: null, http_status: 200, rows_returned: 2, estimate_usd: 0.0005, cost_usd: 0.0005, duration_ms: 10, provider_cost_id: null, storage_path: "raw/call_0001.json", params_digest: { query: "software" } });
          await store.putFile(m.id, "raw/call_0001.json", JSON.stringify(swCompaniesPage), "application/json");
          await store.addCall({ id: `${m.id}:call_0002`, mission_id: m.id, phase: "planning", endpoint_id: PEOPLE, status: "ok", refused_reason: null, http_status: 200, rows_returned: 6, estimate_usd: 0.0005, cost_usd: 0.0005, duration_ms: 10, provider_cost_id: null, storage_path: "raw/call_0002.json", params_digest: { company_linkedin_url: linkedinOf("orascom-em") } });
          await store.putFile(m.id, "raw/call_0002.json", JSON.stringify(peopleOfCompany("orascom-em")), "application/json");
          return { stop: "error" as const, error: "SIGTERM exit code 143", turns: 1, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 }, llmCostUsd: 0.001 };
        },
      } as never,
      recorder: rec.recorder, commit: rec.commit, call: turn1Calls as never, plannerModel: uModel as never,
      models: { planning: "claude-haiku-5-5", execution: "claude-haiku-5-5" }, resolveAccess: async () => NOT_ADMIN, notify: async () => undefined,
    }, m);

    expect(store.missions.get(m.id)!.status).toBe("queued");

    // Turn 2: resumed worker starts with ZERO new paid calls (empty driver) -> recovers validated card directly from saved calls & raw files!
    const turn2Calls = vi.fn(async () => { throw new Error("must not re-sample after deferral"); });
    await runPlanning({
      store, client: money.client, catalog,
      driver: createFakeDriver([]),
      recorder: rec.recorder, commit: rec.commit, call: turn2Calls as never, plannerModel: uModel as never,
      models: { planning: "claude-haiku-5-5", execution: "claude-haiku-5-5" }, resolveAccess: async () => NOT_ADMIN, notify: async () => undefined,
    }, { ...store.missions.get(m.id)!, status: "planning" });

    const finalM = store.missions.get(m.id)!;
    expect(turn2Calls).not.toHaveBeenCalled();
    expect(finalM.status).toBe("plan_ready");
    expect(finalM.summary_ar).not.toBe(INTERNAL_PLANNING_AR);
    expect(money.calls).toHaveLength(0);
  });
});

describe("DT-20261119-10b Counter-cases (فزاع checklist)", () => {
  it("failed people calls (402 balance / 422 / timeout) even on SDK stop -> honest PEOPLE_UNAVAILABLE_AR, never INTERNAL_PLANNING_AR", async () => {
    for (const [label, errMsg] of [["402", "provider 402 insufficient balance"], ["422", "provider 422 invalid field"], ["timeout", "request timed out"]] as const) {
      const res = await runScenario({
        id: `msn_pfail_${label}`,
        requestText: R2_REQ,
        understanding: understandPayload({}),
        callHandler: async (o) => {
          if (o.endpointId === COMPANIES) return tregResult(swCompaniesPage, 0.0005);
          throw new Error(errMsg);
        },
        steps: [
          { tool: "catalog_search", args: { words: ["companies", "search"], limit: 5 } },
          { tool: "treg_call", args: { endpoint_id: COMPANIES, params: { query: "software", page: 1 }, why } },
          { tool: "treg_call", args: { endpoint_id: PEOPLE, params: { company_linkedin_url: linkedinOf("orascom-em"), cascade: [{ include_title: ["CEO"] }], max_results: 1 }, why } },
          // SDK stop without finish tool!
        ],
      });
      expect(res.mission.status, label).toBe("failed");
      expect(res.mission.summary_ar, label).toBe(PEOPLE_UNAVAILABLE_AR);
      expect(res.mission.summary_ar, label).not.toBe(EMPTY_SOURCE_AR);
      expect(res.mission.summary_ar, label).not.toMatch(/402|422|blitzapi|tomba/i);
    }
  });

  it("wrong job title (all linked saved people have non-manager roles like Driver/Intern) -> never fabricates manager card; asks 1 contextual question once", async () => {
    const store = createMemoryStore();
    const money = fakeMoneyClient();
    const rec = fakeRecorder();
    const m = newMission({ id: "msn_10b_wrong_title", user_id: USER_ID, status: "planning", request_text: R2_REQ });
    store.missions.set(m.id, m);
    const callMock = vi.fn(async (o: TregCallOptions) => o.endpointId === COMPANIES
      ? tregResult(swCompaniesPage, 0.0005)
      : tregResult({
          results: [
            { person: { full_name: "Adel Driver", linkedin_url: "https://www.linkedin.example/in/adel-1", experiences: [{ job_title: "Driver", company_name: "Nile Soft Technologies" }] } },
            { person: { full_name: "Sara Intern", linkedin_url: "https://www.linkedin.example/in/sara-2", experiences: [{ job_title: "Intern", company_name: "Cairo Dev Technologies" }] } },
          ],
        }, 0.0005));
    const uModel = async ({ tool }: { tool: { name: string } }) =>
      tool.name === UNDERSTAND_TOOL ? { input: understandPayload({}), costUsd: 0.001 } : null;

    await runPlanning({
      store, client: money.client, catalog,
      driver: createFakeDriver([
        { tool: "catalog_search", args: { words: ["companies", "search"], limit: 5 } },
        { tool: "treg_call", args: { endpoint_id: COMPANIES, params: { query: "software", page: 1 }, why } },
        { tool: "treg_call", args: { endpoint_id: PEOPLE, params: { company_linkedin_url: linkedinOf("orascom-em"), cascade: [{ include_title: ["CEO"] }], max_results: 1 }, why } },
      ]),
      recorder: rec.recorder, commit: rec.commit, call: callMock as never, plannerModel: uModel as never,
      models: { planning: "claude-haiku-5-5", execution: "claude-haiku-5-5" }, resolveAccess: async () => NOT_ADMIN, notify: async () => undefined,
    }, m);

    const ended = store.missions.get(m.id)!;
    expect(ended.plan ?? null).toBeNull();
    expect(ended.status).toBe("needs_input");
    expect(ended.question_ar).toMatch(/المسمى/);
  });

  it("missing raw evidence on disk (call ok in DB, raw file absent) & incompatible rows -> NO fabricated card", async () => {
    // 1. Missing raw evidence
    const storeMiss = createMemoryStore();
    const moneyMiss = fakeMoneyClient();
    const recMiss = fakeRecorder();
    const mMiss = newMission({ id: "msn_10b_missing_raw", user_id: USER_ID, status: "planning", request_text: R2_REQ });
    storeMiss.missions.set(mMiss.id, mMiss);
    await storeMiss.addCall({ id: `${mMiss.id}:call_0001`, mission_id: mMiss.id, phase: "planning", endpoint_id: COMPANIES, status: "ok", refused_reason: null, http_status: 200, rows_returned: 2, estimate_usd: 0.0005, cost_usd: 0.0005, duration_ms: 10, provider_cost_id: null, storage_path: null, params_digest: { query: "software" } });
    await storeMiss.addCall({ id: `${mMiss.id}:call_0002`, mission_id: mMiss.id, phase: "planning", endpoint_id: PEOPLE, status: "ok", refused_reason: null, http_status: 200, rows_returned: 6, estimate_usd: 0.0005, cost_usd: 0.0005, duration_ms: 10, provider_cost_id: null, storage_path: null, params_digest: { company_linkedin_url: linkedinOf("orascom-em") } });
    const uModel = async ({ tool }: { tool: { name: string } }) =>
      tool.name === UNDERSTAND_TOOL ? { input: understandPayload({}), costUsd: 0.001 } : null;
    await runPlanning({
      store: storeMiss, client: moneyMiss.client, catalog, driver: createFakeDriver([]),
      recorder: recMiss.recorder, commit: recMiss.commit, call: vi.fn() as never, plannerModel: uModel as never,
      models: { planning: "claude-haiku-5-5", execution: "claude-haiku-5-5" }, resolveAccess: async () => NOT_ADMIN, notify: async () => undefined,
    }, mMiss);
    const endedMiss = storeMiss.missions.get(mMiss.id)!;
    expect(endedMiss.plan ?? null).toBeNull();
    expect(endedMiss.status).not.toBe("plan_ready");
    expect(endedMiss.status).not.toBe("needs_input");

    // 2. Incompatible rows
    const incompat = await runScenario({
      id: "msn_10b_incompat",
      requestText: R2_REQ,
      understanding: understandPayload({}),
      callHandler: async (o) => (o.endpointId === COMPANIES ? tregResult(swCompaniesPage, 0.0005) : tregResult({ results: [{ unrelated: "blob" }] }, 0.0005)),
      steps: [
        { tool: "catalog_search", args: { words: ["companies", "search"], limit: 5 } },
        { tool: "treg_call", args: { endpoint_id: COMPANIES, params: { query: "software", page: 1 }, why } },
        { tool: "treg_call", args: { endpoint_id: PEOPLE, params: { company_linkedin_url: linkedinOf("orascom-em"), cascade: [{ include_title: ["CEO"] }], max_results: 1 }, why } },
      ],
    });
    expect(incompat.mission.plan ?? null).toBeNull();
    expect(incompat.mission.status).toBe("failed");
  });

  it("true budget/daily limit stays honest (planning_over_budget / not masked as PEOPLE_UNAVAILABLE_AR)", async () => {
    const store = createMemoryStore();
    const money = fakeMoneyClient();
    const rec = fakeRecorder({ dailyCapUsd: 0.0001 }); // forces daily_cap refusal!
    const m = newMission({ id: "msn_10b_cap_honest", user_id: USER_ID, status: "planning", request_text: R2_REQ });
    store.missions.set(m.id, m);
    const uModel = async ({ tool }: { tool: { name: string } }) =>
      tool.name === UNDERSTAND_TOOL ? { input: understandPayload({}), costUsd: 0.001 } : null;
    await runPlanning({
      store, client: money.client, catalog,
      driver: createFakeDriver([
        { tool: "treg_call", args: { endpoint_id: COMPANIES, params: { query: "software", page: 1 }, why } },
      ]),
      recorder: rec.recorder, commit: rec.commit,
      call: vi.fn(async () => tregResult(swCompaniesPage, 0.0005)) as never,
      plannerModel: uModel as never,
      models: { planning: "claude-haiku-5-5", execution: "claude-haiku-5-5" }, resolveAccess: async () => NOT_ADMIN, notify: async () => undefined,
    }, m);
    const ended = store.missions.get(m.id)!;
    expect(ended.status).toBe("failed");
    expect(ended.error).toMatch(/planning_daily_cap/);
    expect(ended.summary_ar).not.toBe(PEOPLE_UNAVAILABLE_AR);
  });

  it("R3 companies-only 5-company control remains unchanged", async () => {
    const store = createMemoryStore();
    const money = fakeMoneyClient();
    const rec = fakeRecorder();
    const r3Page = {
      data: {
        companies: SLUGS.map((slug, i) => ({
          id: linkedinOf(slug),
          name: `${["Misr", "Delta", "Nile", "RedSea", "Alex"][i]} Shipping & Logistics`,
          website_url: `${slug}.com.eg`,
          linkedin_url: linkedinOf(slug),
          country: "EG",
          city: "Cairo",
          industry: "Freight & Logistics Shipping",
          description: "Freight forwarding and shipping company in Egypt",
        })),
      },
    };
    const r3PlanStep: FakeStep = {
      tool: "propose_plan",
      args: (r: Results) => ({
        summary_ar: "ستحصل على ٥ شركات شحن في مصر مع بيانات التواصل المتاحة.",
        contacts_note_ar: "بيانات البريد والهاتف متاحة حسب ما تنشره كل شركة.",
        stages: [{
          key: "companies", title_ar: "شركات شحن في مصر", endpoint_id: COMPANIES, expected_rows: 5, parent_key: null, deliver: true, columns: ccolumns,
          measured_by: [callIds(r)[0]], yield_from: firstOutputId(r),
          relevance: { subject_ar: "شركات شحن في مصر", terms: ["shipping", "logistics", "freight"], text_columns: ["name", "industry"] },
        }],
      }),
    };
    const m = newMission({ id: "msn_10b_r3", user_id: USER_ID, status: "planning", request_text: R3_REQ });
    store.missions.set(m.id, m);
    await runPlanning({
      store, client: money.client, catalog,
      driver: createFakeDriver([
        { tool: "catalog_search", args: { words: ["companies", "shipping"], limit: 5 } },
        { tool: "treg_call", args: { endpoint_id: COMPANIES, params: { query: "shipping egypt", page: 1 }, why } },
        { tool: "run_code", args: (r: Results) => ({ code: `return inputs.${callIds(r)[0]}.data.companies.map(r => ({ id: r.linkedin_url, name: r.name, industry: r.industry || '', city: r.city || '', website: r.website_url || '', linkedin: r.linkedin_url || '' }))`, files: [callIds(r)[0]] }) },
        r3PlanStep, r3PlanStep, r3PlanStep, r3PlanStep,
      ]),
      recorder: rec.recorder, commit: rec.commit,
      call: vi.fn(async () => tregResult(r3Page, 0.0005)) as never,
      models: { planning: "claude-haiku-5-5", execution: "claude-haiku-5-5" }, resolveAccess: async () => NOT_ADMIN, notify: async () => undefined,
    }, m);
    const ended = store.missions.get(m.id)!;
    expect(ended.status).toBe("plan_ready");
    expect((ended.plan as any).stages).toHaveLength(1);
    expect((ended.plan as any).stages[0].planned_rows).toBe(5);
  });
});
