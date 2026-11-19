import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { withCheckedCompaniesCount, withCheckedPerCompany, type Understanding } from "../agent/src/llmPlanner/planner";
import { UNDERSTAND_TOOL } from "../agent/src/llmPlanner/prompts";
import { createFakeDriver, type FakeStep } from "../agent/src/fakeDriver";
import { createMemoryStore, newMission } from "../agent/src/memoryStore";
import { runPlanning, type RunnerDeps } from "../agent/src/runMission";
import { buildTools } from "../agent/src/tools";
import { PEOPLE_OF_COMPANY_CAPABILITIES } from "../src/lib/agentMission/childSources";
import { isSingularPerParentCitation } from "../src/lib/agentMission/numberWords";
import { smallChildPlanningSampleParams } from "../src/lib/agentMission/pageLimit";
import { validateAndPricePlan, type PlanLookup } from "../src/lib/agentMission/plan";
import { EMPTY_SOURCE_AR, PEOPLE_UNAVAILABLE_AR } from "../src/lib/agentMission/refusal";
import { checkCustomerText } from "../src/lib/agentMission/text";
import { capabilitiesOf } from "../agent/src/llmPlanner/catalogView";
import { blockedEndpointReason } from "../src/lib/treg/blockList";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { policyVerdict } from "../src/lib/treg/dataPolicy";
import { buildInspection } from "../src/lib/server/adminMissionInspector";
import { MissionInspector } from "../src/components/admin/MissionInspector";
import { NOT_ADMIN, USER_ID, fakeRecorder, makeHarness, tregResult } from "./helpers/agentHarness";
import { fakeMoneyClient } from "./helpers/agentMoney";
import { COMPANIES, PEOPLE, SLUGS, ccolumns, companiesPage, linkedinOf, peopleOfCompany, why } from "./helpers/a1World";
import { callIds, type Results } from "./helpers/agentFakeWorld";
import { firstOutputId } from "./helpers/agentRelevance";
import type { TregCallOptions, TregCallResult } from "../src/functions/shared/tregClient";

/**
 * DT-20261119-10 (C1–C5): offline proof for R2/R4 saved-evidence recovery, omitted-without-reason repair,
 * bounded formal repair + finishOrigin/issue-subtype diagnostics, «ومدير كل شركة» singular count,
 * and small planning child sample size from catalog metadata.
 */
vi.stubGlobal("fetch", () => { throw new Error("a real network call was attempted"); });

const catalog = loadTregCatalog();
const allowed = (id: string) => policyVerdict(id, NOT_ADMIN).allowed && !blockedEndpointReason(id) && catalog.byId.has(id);
const COMPANIES_CAP = [...capabilitiesOf(catalog, NOT_ADMIN, "companies")].sort().find((c) => !PEOPLE_OF_COMPANY_CAPABILITIES.has(c))!;
const NO_SIZE_PEOPLE_EP = "enrichlayer.company.employees.count"; // endpoint without limit/size input in metadata
const R2_REQ = "عايز شركتين برمجيات في القاهرة ومن كل شركة مدير";
const R4_REQ = "عايز شركتين تسويق في القاهرة ومدير كل شركة بالإيميل ورقم التليفون";
const R3_REQ = "٥ شركات شحن في مصر بالإيميل والتليفون";

const rawUnderstand = (over: {
  total?: number | null;
  companiesText?: string;
  perCompany?: number | null;
  perCompanyText?: string;
  contactKinds?: Array<"email" | "phone">;
  topic?: string;
}) => ({
  decision: "plan",
  understanding_ar: "شركات في القاهرة ومدير واحد من كل شركة.",
  accepts_available: false,
  steps: [
    {
      key: "companies",
      title_ar: "الشركات في القاهرة",
      platform: "companies",
      capability: COMPANIES_CAP,
      parent: "",
      deliver: true,
      count: { ...(over.total !== null ? { total: over.total ?? 2 } : {}), all: false },
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
});

const uTemplate = (perCompany: number | null, perCompanyText: string, companiesTotal: number | null = 2, companiesText = "شركتين"): Understanding => ({
  decision: "plan",
  missing: [],
  understanding_ar: "شركات في القاهرة ومدير واحد من كل شركة.",
  question_ar: "",
  options_ar: [],
  cannot_ar: "",
  assumptions_ar: [],
  no_repeat: false,
  accepts_available: false,
  steps: [
    {
      key: "companies",
      title_ar: "شركات التسويق في القاهرة",
      platform: "companies",
      capability: COMPANIES_CAP,
      parent: null,
      deliver: true,
      count: { total: companiesTotal, per_parent: null, all: false },
      source: null,
      topic: "marketing",
      search_terms: ["marketing"],
      period: null,
      language: null,
      country: "EG",
      order: null,
      fields_wanted: [],
    },
  ],
  people_of_companies: {
    asked: true,
    title_ar: "المديرين",
    per_company: perCompany,
    per_company_text: perCompanyText,
    companies_text: companiesText,
    contact_kinds: ["email", "phone"],
  },
});

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

function assertCleanCustomerTexts(plan: Record<string, any>) {
  const texts = [
    plan.summary_ar,
    ...(plan.assumptions_ar ?? []),
    ...(plan.notes_ar ?? []),
    ...((plan.stages ?? []).flatMap((s: any) => [s.title_ar, s.how_ar].filter(Boolean))),
  ].filter((t): t is string => typeof t === "string" && t.length > 0);
  for (const t of texts) {
    expect(checkCustomerText(t).issues, t).toEqual([]);
    expect(t).not.toMatch(/blitzapi|tomba|apollo|aviato|enrichlayer|treg_call|run_code/i);
  }
}

describe("DT-20261119-10 C4: «ومدير كل شركة» singular count with optional leading conjunction & role-before-كل", () => {
  it("recognizes role BEFORE «كل <parent>» and preserves 1 while keeping counters strict", () => {
    expect(isSingularPerParentCitation(R4_REQ, "مدير")).toBe(true);
    expect(isSingularPerParentCitation(R4_REQ, "ومدير")).toBe(true);
    expect(isSingularPerParentCitation(R4_REQ, "ومدير كل شركة")).toBe(true);
    expect(isSingularPerParentCitation("عايز شركتين ومن كل شركة مدير", "مدير")).toBe(true);
    expect(isSingularPerParentCitation("عايز ٥ شركات ومديرين من كل شركة", "مديرين")).toBe(false);
    expect(isSingularPerParentCitation("عايز ٣ مديرين من كل شركة", "٣ مديرين")).toBe(false);

    const r4Checked = withCheckedPerCompany(uTemplate(1, "ومدير كل شركة"), [R4_REQ]);
    expect(r4Checked.people_of_companies?.per_company).toBe(1);

    const threeManagers = withCheckedPerCompany(uTemplate(3, "٣ مديرين"), ["عايز شركتين برمجيات في القاهرة ومن كل شركة ٣ مديرين"]);
    expect(threeManagers.people_of_companies?.per_company).toBe(3);

    const fiveCompanies = withCheckedCompaniesCount(uTemplate(null, "", 5, "٥ شركات"), [R3_REQ]);
    expect(fiveCompanies.steps[0].count.total).toBe(5);

    const noCount = withCheckedPerCompany(uTemplate(1, "مدير"), ["عايز شركتين ومش محدد عدد المديرين"]);
    expect(noCount.people_of_companies?.per_company).toBeNull();
  });
});

describe("DT-20261119-10 C5: planning child sample uses generic catalog size input = per_parent count (default 1)", () => {
  it("caps planning child sample to asked/default size without affecting parent, execution, or sizeless endpoints", () => {
    const peopleEp = catalog.byId.get(PEOPLE)!;
    const companyEp = catalog.byId.get(COMPANIES)!;
    const sizelessEp = { ...peopleEp, id: NO_SIZE_PEOPLE_EP, inputs: peopleEp.inputs.filter((i) => !/max_results|limit|count|per_page|perPage/i.test(i.name)) };

    // R2 / R4 child sample: asks size 1 even if planner omitted or passed default 10
    expect(smallChildPlanningSampleParams(peopleEp, { company_linkedin_url: linkedinOf("orascom-em"), max_results: 10 }, { perParent: 1 })).toMatchObject({ max_results: 1 });
    expect(smallChildPlanningSampleParams(peopleEp, { company_linkedin_url: linkedinOf("orascom-em") }, { perParent: null })).toMatchObject({ max_results: 1 });
    expect(smallChildPlanningSampleParams(peopleEp, { company_linkedin_url: linkedinOf("orascom-em"), max_results: 10 }, { perParent: 3 })).toMatchObject({ max_results: 3 });

    // Endpoints without size input unaffected
    expect(smallChildPlanningSampleParams(sizelessEp, { company_linkedin_url: linkedinOf("orascom-em") }, { perParent: 1 })).toEqual({ company_linkedin_url: linkedinOf("orascom-em") });
    // Company (parent) catalog endpoint unaffected by child helper when invoked through tools
    expect(companyEp.capability).toBe("companies.search");
  });

  it("enforces small child sample in treg_call planning while leaving parent 20-row sample and execution untouched", async () => {
    const PARENT_WITH_LIMIT = "moltsets.companies.search";
    const h = makeHarness({
      phase: "planning",
      budgetUsd: 5,
      mission: { id: "msn_c5", request_text: R2_REQ },
      responses: [tregResult(swCompaniesPage, 0.0005), tregResult(peopleOfCompany("orascom-em"), 0.0005), tregResult(peopleOfCompany("nile-em"), 0.0005)],
    });
    const toolsPlanning = buildTools({
      ...h.ctx,
      understoodPeople: { noun_ar: "مدير", parent_ar: "شركة", per_parent: 1, companies: 2 },
    });
    const tregTool = toolsPlanning.find((t) => t.name === "treg_call")!;
    const rParent = await tregTool.handler({ endpoint_id: PARENT_WITH_LIMIT, params: { query: "software cairo", limit: 20 }, why });
    expect(rParent.ok, JSON.stringify(rParent)).toBe(true);
    const rChild = await tregTool.handler({ endpoint_id: PEOPLE, params: { company_linkedin_url: linkedinOf("orascom-em"), cascade: [{ include_title: ["CEO"] }], max_results: 10 }, why });
    expect(rChild.ok, JSON.stringify(rChild)).toBe(true);

    expect(h.call.mock.calls[0][0].params.limit).toBe(20); // parent company sample unchanged
    expect(h.call.mock.calls[1][0].params.max_results).toBe(1); // R2/R4 child sample forced to 1

    const toolsExec = buildTools({ ...h.ctx, phase: "execution", plan: { stages: [], price: { deliveredRows: 4, unitPricePoints: 1, reservePoints: 4 } } as never });
    const tregExec = toolsExec.find((t) => t.name === "treg_call")!;
    await tregExec.handler({ endpoint_id: PEOPLE, params: { company_linkedin_url: linkedinOf("nile-em"), cascade: [{ include_title: ["CEO"] }], max_results: 10 } });
    expect(h.call.mock.calls[2][0].params.max_results).toBe(10); // execution size unchanged
  });
});

describe("DT-20261119-10 C1: R2, R4, missing-stage-no-reason, R3 & counter-cases", () => {
  it("R2 exact: saved people evidence + twice-declared unserved -> assembled validated 2×1 card, zero extra call, zero plan_invalid refusal", async () => {
    const store = createMemoryStore();
    const money = fakeMoneyClient();
    const rec = fakeRecorder();
    const understanding = rawUnderstand({ perCompany: 1, perCompanyText: "مدير", companiesText: "شركتين" });
    const plannerModel = async ({ tool }: { tool: { name: string } }) =>
      tool.name === UNDERSTAND_TOOL ? { input: JSON.parse(JSON.stringify(understanding)), costUsd: 0.001 } : null;

    const callMock = vi.fn(async (o: TregCallOptions): Promise<TregCallResult> => {
      if (o.endpointId === COMPANIES) return tregResult(swCompaniesPage, 0.0005);
      return tregResult(peopleOfCompany("orascom-em"), 0.0005);
    });

    const steps: FakeStep[] = [
      { tool: "catalog_search", args: { words: ["companies", "search"], limit: 5 } },
      { tool: "treg_call", args: { endpoint_id: COMPANIES, params: { query: "software", page: 1 }, why } },
      { tool: "run_code", args: (r: Results) => ({ code: `return inputs.${callIds(r)[0]}.data.companies.map(r => ({ id: r.linkedin_url, name: r.name, industry: r.industry || '', city: r.city || '', website: r.website_url || '', linkedin: r.linkedin_url || '' }))`, files: [callIds(r)[0]] }) },
      { tool: "treg_call", args: { endpoint_id: PEOPLE, params: { company_linkedin_url: linkedinOf("orascom-em"), cascade: [{ include_title: ["CEO"] }], max_results: 10 }, why } },
      ...Array.from({ length: 2 }, (): FakeStep => ({
        tool: "propose_plan",
        args: (res: Results) => ({
          summary_ar: "ستحصل على شركتي برمجيات في القاهرة.",
          stages: [{ key: "companies", title_ar: "شركات برمجيات في القاهرة", endpoint_id: COMPANIES, expected_rows: 2, parent_key: null, deliver: true, columns: ccolumns, measured_by: [callIds(res)[0]], yield_from: firstOutputId(res) }],
          unserved_steps: [{ reason_ar: "لم يتم إرفاق مرحلة الأشخاص في هذه المحاولة" }],
        }),
      })),
    ];

    const m = newMission({ id: "msn_r2_c1", user_id: USER_ID, status: "planning", request_text: R2_REQ });
    store.missions.set(m.id, m);
    await runPlanning({
      store, client: money.client, catalog, driver: createFakeDriver(steps), recorder: rec.recorder, commit: rec.commit,
      call: callMock as never, plannerModel: plannerModel as never,
      models: { planning: "claude-haiku-5-5", execution: "claude-haiku-5-5" }, resolveAccess: async () => NOT_ADMIN, notify: async () => undefined,
    }, m);

    const ended = store.missions.get(m.id)!;
    const rejectEv = store.events.find((e) => e.message_ar.includes("تعذّر") || e.counts?.adm_flag);
    expect(ended.status, `${ended.error ?? ""} ${ended.summary_ar ?? ""} ${JSON.stringify(rejectEv ?? {})}`).toBe("plan_ready");
    expect(callMock).toHaveBeenCalledTimes(2); // no extra paid call during repair/assembly
    const plan = ended.plan as any;
    expect(plan.stages.find((s: any) => s.key === "companies")?.planned_rows).toBe(2);
    expect(plan.stages.find((s: any) => s.key === "people")).toMatchObject({ parent_key: "companies", per_parent_rows: 1, planned_rows: 2, deliver: true });
    expect(plan.stages.find((s: any) => s.key === "people")?.engine?.map_file_id).toBeTruthy();
    expect(money.calls).toHaveLength(0);
    assertCleanCustomerTexts(plan);
  });

  it("R4 exact: «ومدير كل شركة بالإيميل ورقم التليفون» + saved evidence -> 2×1 card with email & phone contact steps", async () => {
    const store = createMemoryStore();
    const money = fakeMoneyClient();
    const rec = fakeRecorder();
    const understanding = rawUnderstand({ perCompany: 1, perCompanyText: "ومدير كل شركة", companiesText: "شركتين", contactKinds: ["email", "phone"], topic: "marketing" });
    const plannerModel = async ({ tool }: { tool: { name: string } }) =>
      tool.name === UNDERSTAND_TOOL ? { input: JSON.parse(JSON.stringify(understanding)), costUsd: 0.001 } : null;

    const callMock = vi.fn(async (o: TregCallOptions): Promise<TregCallResult> => {
      if (o.endpointId === COMPANIES) return tregResult(swCompaniesPage, 0.0005);
      return tregResult(peopleOfCompany("orascom-em"), 0.0005);
    });

    const steps: FakeStep[] = [
      { tool: "catalog_search", args: { words: ["companies", "search"], limit: 5 } },
      { tool: "treg_call", args: { endpoint_id: COMPANIES, params: { query: "marketing", page: 1 }, why } },
      { tool: "run_code", args: (r: Results) => ({ code: `return inputs.${callIds(r)[0]}.data.companies.map(r => ({ id: r.linkedin_url, name: r.name, industry: r.industry || '', city: r.city || '', website: r.website_url || '', linkedin: r.linkedin_url || '' }))`, files: [callIds(r)[0]] }) },
      { tool: "treg_call", args: { endpoint_id: PEOPLE, params: { company_linkedin_url: linkedinOf("orascom-em"), cascade: [{ include_title: ["CEO"] }], max_results: 10 }, why } },
      ...Array.from({ length: 2 }, (): FakeStep => ({
        tool: "propose_plan",
        args: (res: Results) => ({
          summary_ar: "ستحصل على شركتي تسويق في القاهرة.",
          stages: [{ key: "companies", title_ar: "شركات تسويق في القاهرة", endpoint_id: COMPANIES, expected_rows: 2, parent_key: null, deliver: true, columns: ccolumns, measured_by: [callIds(res)[0]], yield_from: firstOutputId(res) }],
          unserved_steps: [{ reason_ar: "تعذّر إعداد مرحلة الأشخاص الآن" }],
        }),
      })),
    ];

    const m = newMission({ id: "msn_r4_c1", user_id: USER_ID, status: "planning", request_text: R4_REQ });
    store.missions.set(m.id, m);
    await runPlanning({
      store, client: money.client, catalog, driver: createFakeDriver(steps), recorder: rec.recorder, commit: rec.commit,
      call: callMock as never, plannerModel: plannerModel as never,
      models: { planning: "claude-haiku-5-5", execution: "claude-haiku-5-5" }, resolveAccess: async () => NOT_ADMIN, notify: async () => undefined,
    }, m);

    const ended = store.missions.get(m.id)!;
    const rejectEv = store.events.find((e) => e.message_ar.includes("تعذّر") || e.counts?.adm_flag);
    expect(ended.status, `${ended.error ?? ""} ${ended.summary_ar ?? ""} ${JSON.stringify(rejectEv ?? {})}`).toBe("plan_ready");
    expect(callMock).toHaveBeenCalledTimes(2);
    const plan = ended.plan as any;
    expect(plan.stages.find((s: any) => s.key === "people")).toMatchObject({ parent_key: "companies", per_parent_rows: 1, planned_rows: 2 });
    const kinds = new Set((plan.contact_steps ?? []).map((s: any) => s.kind));
    expect(kinds.has("email")).toBe(true);
    expect(kinds.has("phone")).toBe(true);
    expect(money.calls).toHaveLength(0);
    assertCleanCustomerTexts(plan);
  });

  it("missing people stage WITHOUT reason (plan.ts:878 branch) gets unified saved-evidence repair, never re-sample", () => {
    const lookup: PlanLookup = {
      call: (id) => (id === "call_0001" ? { id, endpointId: COMPANIES, ok: true, costUsd: 0.0005, rows: 5 } : null),
      evidenceText: () => `${linkedinOf("orascom-em")} Nile Soft`,
      endpointAllowed: () => true,
      requestText: R2_REQ,
      understoodPeople: { noun_ar: "مدير", parent_ar: "شركة", per_parent: 1, companies: 2 },
      childStepSources: () => [{ id: PEOPLE, accepts: ["linkedin"] }],
      endpointsCalled: () => new Map([[PEOPLE, { rows: 6 }]]),
      savedCallsByEndpoint: () => new Map([[PEOPLE, [{ callId: "call_0002", rows: 6, rowPath: "inputs.call_0002.results", parentKey: "companies", linkedToParent: true }]]]),
    };
    const res = validateAndPricePlan({
      summary_ar: "ستحصل على شركتي برمجيات في القاهرة.",
      stages: [{
        key: "companies", title_ar: "شركات برمجيات في القاهرة", endpoint_id: COMPANIES, expected_rows: 2, parent_key: null, deliver: true, columns: ccolumns,
        sample_rows: [{ id: linkedinOf("orascom-em"), name: "Nile Soft", industry: "Software", city: "Cairo", website: "orascom-em.com.eg", linkedin: linkedinOf("orascom-em") }], measured_by: ["call_0001"],
      }],
    }, lookup);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      const joined = res.issues.join("\n");
      expect(joined).toContain("call_0002");
      expect(joined).toContain("inputs.call_0002.results");
      expect(joined).toMatch(/Do NOT repeat paid sample calls/i);
      expect(joined).not.toMatch(/sample one with a company of your first sample/i);
    }
  });

  it("R3 unchanged: companies-only 5-company plan succeeds cleanly", async () => {
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
    const steps: FakeStep[] = [
      { tool: "catalog_search", args: { words: ["companies", "shipping"], limit: 5 } },
      { tool: "treg_call", args: { endpoint_id: COMPANIES, params: { query: "shipping egypt", limit: 20, page: 1 }, why } },
      { tool: "run_code", args: (r: Results) => ({ code: `return inputs.${callIds(r)[0]}.data.companies.map(r => ({ id: r.linkedin_url, name: r.name, industry: r.industry || '', city: r.city || '', website: r.website_url || '', linkedin: r.linkedin_url || '' }))`, files: [callIds(r)[0]] }) },
      // R3 runs with phone/email send-back advisory check first, then settles cleanly when no phone/email sample changed
      r3PlanStep, r3PlanStep, r3PlanStep, r3PlanStep,
    ];
    const driverR3 = createFakeDriver(steps);
    const m = newMission({ id: "msn_r3", user_id: USER_ID, status: "planning", request_text: R3_REQ });
    store.missions.set(m.id, m);
    await runPlanning({
      store, client: money.client, catalog, driver: driverR3, recorder: rec.recorder, commit: rec.commit,
      call: vi.fn(async () => tregResult(r3Page, 0.0005)) as never,
      models: { planning: "claude-haiku-5-5", execution: "claude-haiku-5-5" }, resolveAccess: async () => NOT_ADMIN, notify: async () => undefined,
    }, m);
    const ended = store.missions.get(m.id)!;
    expect(ended.status, JSON.stringify(driverR3.results)).toBe("plan_ready");
    expect((ended.plan as any).stages).toHaveLength(1);
    expect((ended.plan as any).stages[0].planned_rows).toBe(5);
  });

  it("Counter-cases: truly empty -> sample_empty; positive unlinked people -> one needs_input question (ask_question stays blocked for planner); incompatible people -> no fabricated stage", async () => {
    // 1. Truly empty
    const storeEmpty = createMemoryStore();
    storeEmpty.missions.set("msn_empty", newMission({ id: "msn_empty", user_id: USER_ID, status: "planning", request_text: R2_REQ }));
    await runPlanning({
      store: storeEmpty, client: fakeMoneyClient().client, catalog,
      driver: createFakeDriver([
        { tool: "treg_call", args: { endpoint_id: COMPANIES, params: { query: "software" }, why } },
        { tool: "finish", args: { outcome: "cannot_serve", kind: "empty", summary_ar: "لم نجد نتائج." } },
      ]),
      recorder: fakeRecorder().recorder, commit: fakeRecorder().commit,
      call: vi.fn(async () => tregResult({ data: { companies: [] } }, 0.0005)) as never,
      models: { planning: "claude-haiku-5-5", execution: "claude-haiku-5-5" }, resolveAccess: async () => NOT_ADMIN, notify: async () => undefined,
    }, storeEmpty.missions.get("msn_empty")!);
    const mEmpty = storeEmpty.missions.get("msn_empty")!;
    expect(mEmpty.status).toBe("unserved");
    expect(mEmpty.summary_ar).toBe(EMPTY_SOURCE_AR);

    // 2. Positive usable people rows that CANNOT link to parent companies -> ONE needs_input question (never plan_invalid refusal)
    const storeUnlinked = createMemoryStore();
    storeUnlinked.missions.set("msn_unlinked", newMission({ id: "msn_unlinked", user_id: USER_ID, status: "planning", request_text: R2_REQ }));
    const uModel = async ({ tool }: { tool: { name: string } }) =>
      tool.name === UNDERSTAND_TOOL ? { input: rawUnderstand({ perCompany: 1, perCompanyText: "مدير", companiesText: "شركتين" }), costUsd: 0.001 } : null;
    const driverUnlinked = createFakeDriver([
      { tool: "catalog_search", args: { words: ["companies", "search"], limit: 5 } },
      { tool: "treg_call", args: { endpoint_id: COMPANIES, params: { query: "software", page: 1 }, why } },
      { tool: "run_code", args: (r: Results) => ({ code: `return inputs.${callIds(r)[0]}.data.companies.map(r => ({ id: r.linkedin_url, name: r.name, industry: r.industry || '', city: r.city || '', website: r.website_url || '', linkedin: r.linkedin_url || '' }))`, files: [callIds(r)[0]] }) },
      { tool: "treg_call", args: { endpoint_id: "blitzapi.people.search", params: { company_linkedin_url: "https://linkedin.example/company/other-unrelated", max_results: 10 }, why } },
      ...Array.from({ length: 2 }, (): FakeStep => ({
        tool: "propose_plan",
        args: (res: Results) => ({
          summary_ar: "ستحصل على شركتي برمجيات في القاهرة.",
          stages: [{ key: "companies", title_ar: "شركات برمجيات في القاهرة", endpoint_id: COMPANIES, expected_rows: 2, parent_key: null, deliver: true, columns: ccolumns, measured_by: [callIds(res)[0]], yield_from: firstOutputId(res) }],
          unserved_steps: [{ reason_ar: "تعذّر ربط نتائج الأشخاص بالشركات" }],
        }),
      })),
    ]);
    await runPlanning({
      store: storeUnlinked, client: fakeMoneyClient().client, catalog,
      driver: driverUnlinked,
      recorder: fakeRecorder().recorder, commit: fakeRecorder().commit,
      call: vi.fn(async (o: TregCallOptions) => o.endpointId === COMPANIES
        ? tregResult(swCompaniesPage, 0.0005)
        : tregResult({ results: [{ id: "p_other", full_name: "Ali Hassan", job_title: "Director", company: "Unrelated Corp", linkedin: "https://linkedin.com/in/ali" }] }, 0.0005)) as never,
      plannerModel: uModel as never,
      models: { planning: "claude-haiku-5-5", execution: "claude-haiku-5-5" }, resolveAccess: async () => NOT_ADMIN, notify: async () => undefined,
    }, storeUnlinked.missions.get("msn_unlinked")!);
    const mUnlinked = storeUnlinked.missions.get("msn_unlinked")!;
    expect(mUnlinked.status, JSON.stringify(driverUnlinked.results)).toBe("needs_input");
    expect(mUnlinked.question_ar).toBeTruthy();
    expect(mUnlinked.error ?? "").not.toMatch(/plan_invalid_after/);

    // 3. Incompatible positive people rows -> NO fabricated measured stage
    const storeIncompat = createMemoryStore();
    storeIncompat.missions.set("msn_incompat", newMission({ id: "msn_incompat", user_id: USER_ID, status: "planning", request_text: R2_REQ }));
    await runPlanning({
      store: storeIncompat, client: fakeMoneyClient().client, catalog,
      driver: createFakeDriver([
        { tool: "catalog_search", args: { words: ["companies", "search"], limit: 5 } },
        { tool: "treg_call", args: { endpoint_id: COMPANIES, params: { query: "software", page: 1 }, why } },
        { tool: "run_code", args: (r: Results) => ({ code: `return inputs.${callIds(r)[0]}.data.companies.map(r => ({ id: r.linkedin_url, name: r.name, industry: r.industry || '', city: r.city || '', website: r.website_url || '', linkedin: r.linkedin_url || '' }))`, files: [callIds(r)[0]] }) },
        { tool: "treg_call", args: { endpoint_id: PEOPLE, params: { company_linkedin_url: linkedinOf("orascom-em"), max_results: 1 }, why } },
        ...Array.from({ length: 2 }, (): FakeStep => ({
          tool: "propose_plan",
          args: (res: Results) => ({
            summary_ar: "ستحصل على شركتي برمجيات في القاهرة.",
            stages: [{ key: "companies", title_ar: "شركات برمجيات في القاهرة", endpoint_id: COMPANIES, expected_rows: 2, parent_key: null, deliver: true, columns: ccolumns, measured_by: [callIds(res)[0]], yield_from: firstOutputId(res) }],
            unserved_steps: [{ reason_ar: "بيانات الأشخاص غير متوافقة مع الشركات" }],
          }),
        })),
      ]),
      recorder: fakeRecorder().recorder, commit: fakeRecorder().commit,
      call: vi.fn(async (o: TregCallOptions) => o.endpointId === COMPANIES
        ? tregResult(swCompaniesPage, 0.0005)
        : tregResult({ results: [{ unrelated: "blob" }] }, 0.0005)) as never,
      plannerModel: uModel as never,
      models: { planning: "claude-haiku-5-5", execution: "claude-haiku-5-5" }, resolveAccess: async () => NOT_ADMIN, notify: async () => undefined,
    }, storeIncompat.missions.get("msn_incompat")!);
    const mIncompat = storeIncompat.missions.get("msn_incompat")!;
    expect(mIncompat.plan ?? null).toBeNull();
    expect(mIncompat.status).toBe("failed");

    // 4. ask_question remains locked for planner-understood requests (tools.ts:708-710 regression)
    const hQ = makeHarness({ phase: "planning", mission: { id: "msn_q_guard", request_text: "شركات في القاهرة" } });
    const qTool = buildTools({ ...hQ.ctx, plannerRan: true }).find((t) => t.name === "ask_question")!;
    const qRes = await qTool.handler({ question_ar: "ما نوع الشركات؟", options_ar: ["برمجيات", "تسويق"] });
    expect(qRes.ok).toBe(false);
    expect(String(qRes.error)).toMatch(/already understood/i);

    // 5. All people calls failed -> people_sources_failed + PEOPLE_UNAVAILABLE_AR
    const storePeopleFail = createMemoryStore();
    storePeopleFail.missions.set("msn_pfail", newMission({ id: "msn_pfail", user_id: USER_ID, status: "planning", request_text: R2_REQ }));
    const driverPfail = createFakeDriver([
      { tool: "catalog_search", args: { words: ["companies", "search"], limit: 5 } },
      { tool: "treg_call", args: { endpoint_id: COMPANIES, params: { query: "software", page: 1 }, why } },
      { tool: "treg_call", args: { endpoint_id: PEOPLE, params: { company_linkedin_url: linkedinOf("orascom-em"), cascade: [{ include_title: ["CEO"] }], max_results: 1 }, why } },
      { tool: "finish", args: { outcome: "cannot_serve", kind: "unsupported", summary_ar: "تعذّر الوصول لمصادر الأشخاص." } },
      { tool: "finish", args: { outcome: "cannot_serve", kind: "unsupported", summary_ar: "تعذّر الوصول لمصادر الأشخاص." } },
      { tool: "finish", args: { outcome: "cannot_serve", kind: "unsupported", summary_ar: "تعذّر الوصول لمصادر الأشخاص." } },
    ]);
    await runPlanning({
      store: storePeopleFail, client: fakeMoneyClient().client, catalog,
      driver: driverPfail,
      recorder: fakeRecorder().recorder, commit: fakeRecorder().commit,
      call: vi.fn(async (o: TregCallOptions) => {
        if (o.endpointId === COMPANIES) return tregResult(swCompaniesPage, 0.0005);
        throw new Error("provider 402");
      }) as never,
      plannerModel: uModel as never,
      models: { planning: "claude-haiku-5-5", execution: "claude-haiku-5-5" }, resolveAccess: async () => NOT_ADMIN, notify: async () => undefined,
    }, storePeopleFail.missions.get("msn_pfail")!);
    const mPfail = storePeopleFail.missions.get("msn_pfail")!;
    expect(mPfail.status, `${mPfail.error ?? ""} ${JSON.stringify(driverPfail.results)}`).toBe("failed");
    expect(mPfail.summary_ar, mPfail.error ?? "").toBe(PEOPLE_UNAVAILABLE_AR);
    expect(mPfail.error).toMatch(/people_sources_failed/);
    expect(storePeopleFail.events.find((e) => e.counts?.adm_flag === 1)?.counts).toMatchObject({ adm_flag: 1, finish_model_finish: 1 });
  });
});

describe("DT-20261119-10 C2 & C3: bounded formal repeat + finishOrigin + inspector sub-type counts", () => {
  it("records finish_code_forced_cap & sub-type counts and displays numbers in MissionInspector without leaking secrets", async () => {
    const store = createMemoryStore();
    store.missions.set("msn_c2_cap", newMission({ id: "msn_c2_cap", user_id: USER_ID, status: "planning", request_text: R2_REQ }));
    const repeatedInvalidPlan: FakeStep = {
      tool: "propose_plan",
      args: (r: Results) => ({
        summary_ar: "خطة غير صالحة بسبب عدم وجود رابط.",
        stages: [{
          key: "companies", title_ar: "الشركات", endpoint_id: COMPANIES, expected_rows: 2, parent_key: null, deliver: true, columns: ccolumns,
          sample_rows: [{ id: linkedinOf("orascom-em"), name: "Nile Soft Technologies", industry: "Software Development", city: "Cairo", website: "orascom-em.com.eg", linkedin: linkedinOf("orascom-em") }],
          relevance: { subject_ar: "شركات برمجيات", terms: ["software"], text_columns: ["name", "industry"] },
          measured_by: [callIds(r)[0]], yield_from: "out_9999",
        }],
      }),
    };
    const driver = createFakeDriver([
      { tool: "catalog_search", args: { words: ["companies", "search"], limit: 5 } },
      { tool: "treg_call", args: { endpoint_id: COMPANIES, params: { query: "software", page: 1 }, why } },
      repeatedInvalidPlan, repeatedInvalidPlan, repeatedInvalidPlan, repeatedInvalidPlan, repeatedInvalidPlan,
    ]);
    await runPlanning({
      store, client: fakeMoneyClient().client, catalog, driver, recorder: fakeRecorder().recorder, commit: fakeRecorder().commit,
      call: vi.fn(async () => tregResult(swCompaniesPage, 0.0005)) as never,
      models: { planning: "claude-haiku-5-5", execution: "claude-haiku-5-5" }, resolveAccess: async () => NOT_ADMIN, notify: async () => undefined,
    }, store.missions.get("msn_c2_cap")!);

    const proposals = driver.results.filter((x) => x.tool === "propose_plan").length;
    expect(proposals).toBeLessThanOrEqual(3);
    const admFlag = store.events.find((e) => e.counts?.adm_flag === 1);
    expect(admFlag?.counts).toMatchObject({ adm_flag: 1, finish_code_forced_cap: 1, issue_invalid_yield_from: proposals });

    // Admin inspector renders numeric counts on internal events cleanly
    const data = buildInspection({
      now: new Date("2026-11-19T12:00:00Z"),
      mission: { id: "msn_c2_cap", status: "failed", created_at: "2026-11-19T11:00:00Z", updated_at: "2026-11-19T11:01:00Z", request_text: R2_REQ, error: "admin: planning_failed class=internal reason=plan_invalid_after_3_rejections" },
      calls: [], callTotal: 0,
      events: [{ id: 1, kind: "call", message_ar: "علامة للمشرف: تعذّر التخطيط من جانبنا.", counts: admFlag!.counts!, created_at: "2026-11-19T11:01:00Z" }],
    });
    const markup = renderToStaticMarkup(createElement(MissionInspector, { data }));
    expect(markup).toContain("finish_code_forced_cap=1");
    expect(markup).toContain(`issue_invalid_yield_from=${proposals}`);
    const inspSrc = readFileSync(path.resolve(__dirname, "../src/components/admin/MissionInspector.tsx"), "utf8");
    expect(inspSrc).not.toMatch(/\b(?:ml|mr|pl|pr)-\d|text-(?:left|right)\b/);
  });
});
