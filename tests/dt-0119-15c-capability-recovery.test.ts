import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeDriver } from "../agent/src/fakeDriver";
import { createMemoryStore, newMission } from "../agent/src/memoryStore";
import { runPlanning } from "../agent/src/runMission";
import { readRunState, updateRunState } from "../agent/src/runState";
import { UNDERSTAND_TOOL } from "../agent/src/llmPlanner/prompts";
import { CAPABILITY_DISCOVERY_FLAG_KEY, REGISTRY_ROUTER_FLAG_KEY, researchNeedOf } from "../src/lib/agentMission/capabilities";
import { briefItemNouns, numbersWritten, parseBrief, storedBriefOf, validateBrief, type ResearchBrief } from "../src/lib/agentMission/researchBrief";
import { setChatModelForTesting } from "../src/lib/agentMission/chatModel";
import { EMPTY_SOURCE_AR, INTERNAL_PLANNING_AR } from "../src/lib/agentMission/refusal";
import { customerPlanView, type PricedPlan } from "../src/lib/agentMission/plan";
import { isInternalEvent } from "../src/lib/agentMission/eventText";
import { buildInspection } from "../src/lib/server/adminMissionInspector";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import type { TregCallOptions, TregCallResult } from "../src/functions/shared/tregClient";
import { NOT_ADMIN, USER_ID, fakeRecorder, tregResult } from "./helpers/agentHarness";
import { fakeMoneyClient } from "./helpers/agentMoney";

/**
 * DT-20261119-15c: LLM-First Brief Continuity + Real CapabilityDiscovery + Real Live-R2 Shapes Recovery & Diagnostics.
 * Strictly offline with fakes, zero real network, zero spend.
 */
vi.stubGlobal("fetch", () => { throw new Error("a real network call was attempted"); });

afterEach(() => {
  setChatModelForTesting(null);
});

const catalog = loadTregCatalog();
const allSkip = Object.fromEntries(catalog.endpoints.map((e) => [e.id, "other"]));

function validatedBrief(raw: Record<string, unknown>, customerTurns: string[]): ResearchBrief {
  const parsed = parseBrief({
    status: "ready",
    platforms: [],
    content: ["companies", "people"],
    count: null,
    topic: "برمجيات",
    period: null,
    country: "مصر",
    language: null,
    ...raw,
  });
  if (!parsed.ok) throw new Error(`parseBrief failed: ${parsed.issue}`);
  const v = validateBrief(parsed.brief, { customerTurns });
  if (!v.ok) throw new Error(`validateBrief failed: ${v.reason}`);
  return v.brief;
}

const tombaPage1OtherCompanies = {
  data: {
    companies: Array.from({ length: 50 }, (_, i) => ({
      name: `Alpha Tech ${i}`,
      website_url: `alphatech${i}.com`,
      linkedin_url: `https://linkedin.com/company/alphatech-${i}`,
      street_address: "",
      phone_number: false,
      city: "Cairo",
      country: "EG",
      industry: "Software Development",
      company_size: "11-50",
      founded: 2018,
      total_emails: 6,
    })),
  },
};

const tombaPage2WithCloudSoft5 = {
  data: {
    companies: Array.from({ length: 50 }, (_, i) =>
      i === 5
        ? {
            name: "CloudSoft5",
            website_url: "cloudsoft5.com",
            linkedin_url: "https://linkedin.com/company/cloudsoft5",
            street_address: "",
            phone_number: false,
            city: "Cairo",
            country: "EG",
            industry: "Software Development",
            company_size: "11-50",
            founded: 2015,
            total_emails: 8,
          }
        : {
            name: `Beta Soft ${i}`,
            website_url: `betasoft${i}.com`,
            linkedin_url: `https://linkedin.com/company/betasoft-${i}`,
            street_address: "",
            phone_number: false,
            city: "Cairo",
            country: "EG",
            industry: "Software Development",
            company_size: "11-50",
            founded: 2017,
            total_emails: 5,
          },
    ),
  },
};

const tombaPageWithCarLog = {
  data: {
    companies: Array.from({ length: 50 }, (_, i) =>
      i === 3
        ? {
            name: "CarLog",
            website_url: "carlog.com",
            linkedin_url: "https://linkedin.com/company/357338",
            street_address: "",
            phone_number: false,
            city: "Cairo",
            country: "EG",
            industry: "Software Development",
            company_size: "11-50",
            founded: 2020,
            total_emails: 4,
          }
        : {
            name: `Delta Soft ${i}`,
            website_url: `deltasoft${i}.com`,
            linkedin_url: `https://linkedin.com/company/${900100 + i}`,
            street_address: "",
            phone_number: false,
            city: "Cairo",
            country: "EG",
            industry: "Software Development",
            company_size: "11-50",
            founded: 2019,
            total_emails: 3,
          },
    ),
  },
};

const realAviatoCloudSoft5Page = {
  employees: [
    {
      companyName: "CloudSoft5",
      companyID: "aviato_cs5",
      linkedinNumID: 18125389,
      startDate: "2015-01-01T00:00:00.000Z",
      endDate: "2017-12-01T00:00:00.000Z",
      positionList: [{ title: "Engineering Manager", startDate: "2015-01-01", endDate: "2017-12-01", department: "Engineering", seniorityScore: 7 }],
      person: {
        fullName: "Khaled Samir",
        firstName: "Khaled",
        lastName: "Samir",
        location: "Cairo, Egypt",
        URLs: { linkedin: "linkedin.com/in/khaled-samir-cs5" },
      },
    },
  ],
};

const realAviatoCarLogPage = {
  employees: [
    {
      companyName: "CarLog",
      companyID: "aviato_carlog",
      linkedinNumID: 357338,
      positionList: [{ title: "Managing Director", startDate: "2020-01-01", department: "Executive" }],
      person: {
        fullName: "Sherif Nabil",
        firstName: "Sherif",
        lastName: "Nabil",
        location: "Cairo, Egypt",
        URLs: { linkedin: "linkedin.com/in/sherif-nabil-carlog" },
      },
    },
  ],
};

const realBlitzWaterfallPage = {
  company_linkedin_url: "https://www.linkedin.com/company/cloudsoft5",
  results: [
    {
      icp: 1,
      ranking: 1,
      person: {
        first_name: "Karim",
        last_name: "Hassan",
        full_name: "Karim Hassan",
        headline: "Managing Director at CloudSoft5",
        location: { city: null, country_code: null },
        linkedin_url: "https://www.linkedin.com/in/karim-hassan-cs5",
        experiences: [
          {
            company_name: "CloudSoft5",
            job_title: "Managing Director",
            company_linkedin_url: "https://www.linkedin.com/company/cloudsoft5",
            company_linkedin_id: "18125389",
            company_domain: null,
            job_is_current: true,
          },
        ],
      },
    },
  ],
};

const realIcypeasCase1Page = {
  total: 3,
  success: true,
  leads: [
    {
      firstname: "Tamer",
      lastname: "Adel",
      headline: "Operations Manager at CloudSoft5",
      profileUrl: "https://www.linkedin.com/in/tamer-adel-cs5",
      lastJobTitle: "Operations Manager",
      lastCompanyName: "CloudSoft5",
      lastCompanyUrn: "urn:li:fs_salesCompany:18125389",
      lastCompanyUrl: "https://www.linkedin.com/company/cloudsoft5/",
      lastCompanyWebsite: "http://cloudsoft5.com",
      address: "مصر",
    },
    {
      firstname: "Heba",
      lastname: "Gamal",
      headline: "Product Director at CloudSoft5",
      profileUrl: "https://www.linkedin.com/in/heba-gamal-cs5",
      lastJobTitle: "Product Director",
      lastCompanyName: "CloudSoft5",
      lastCompanyUrn: "urn:li:fs_salesCompany:18125389",
      lastCompanyUrl: "https://www.linkedin.com/company/cloudsoft5/",
      lastCompanyWebsite: "http://cloudsoft5.com",
      address: "مصر",
    },
    {
      firstname: "Nour",
      lastname: "Ehab",
      headline: "Engineering Manager at CloudSoft5",
      profileUrl: "https://www.linkedin.com/in/nour-ehab-cs5",
      lastJobTitle: "Engineering Manager",
      lastCompanyName: "CloudSoft5",
      lastCompanyUrn: "urn:li:fs_salesCompany:18125389",
      lastCompanyUrl: "https://www.linkedin.com/company/cloudsoft5/",
      lastCompanyWebsite: "http://cloudsoft5.com",
      address: "مصر",
    },
  ],
};

const realBlitzEmployeeFinderCase2Page = {
  results: [
    {
      first_name: "Youssef",
      last_name: "Mostafa",
      full_name: "Youssef Mostafa",
      headline: "General Manager",
      linkedin_url: "https://www.linkedin.com/in/youssef-mostafa-carlog",
      location: { city: "Egypt", country_code: "EG" },
    },
  ],
};

const realIcypeasCase2Page = {
  total: 1,
  success: true,
  leads: [
    {
      firstname: "Maged",
      lastname: "Farouk",
      headline: "Managing Director at CarLog",
      profileUrl: "https://www.linkedin.com/in/maged-farouk-carlog",
      lastJobTitle: "Managing Director",
      lastCompanyName: "CarLog",
      lastCompanyUrn: "urn:li:fs_salesCompany:357338",
      lastCompanyUrl: "https://www.linkedin.com/company/carlog/",
      lastCompanyWebsite: "http://carlog.com",
      address: "مصر",
    },
  ],
};

async function runDiscoveryReplay(opts: {
  id: string;
  requestText: string;
  answerText?: string | null;
  storedBrief?: ResearchBrief | null;
  understanding: Record<string, unknown>;
  callHandler: (o: TregCallOptions) => Promise<TregCallResult>;
  steps: Parameters<typeof createFakeDriver>[0];
  routerOn?: boolean;
  withWebEmpty?: boolean;
  peopleRecoveryAsked?: boolean;
  store?: ReturnType<typeof createMemoryStore>;
}) {
  const store = opts.store ?? createMemoryStore();
  store.settings[CAPABILITY_DISCOVERY_FLAG_KEY] = { user_ids: [USER_ID] };
  if (opts.routerOn) {
    store.settings[REGISTRY_ROUTER_FLAG_KEY] = { user_ids: [USER_ID] };
    store.readUserEmail = async () => "iam.magdy+1@outlook.com";
  }
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
  if (opts.peopleRecoveryAsked) {
    await updateRunState(store, m.id, (s) => ({ ...s, peopleRecoveryAsked: true }));
  }
  const logs: string[] = [];
  const call = vi.fn(opts.callHandler);
  const web = opts.withWebEmpty
    ? {
        parsePage: async ({ parser, url }: { parser: string; url: string }) => ({ ok: true, parser, url, rows: [], data: { emails: [] } }),
        webSearch: async () => ({ ok: true, rows_in_page: 0, first_rows: [] }),
        webScrape: async () => ({ ok: true, first_rows: [{ characters: 0 }] }),
        peopleSearch: async () => ({ ok: true, rows_in_page: 0, first_rows: [] }),
      }
    : undefined;

  const storedBrief = opts.storedBrief;
  await runPlanning(
    {
      store,
      client: money.client,
      catalog,
      driver: createFakeDriver(opts.steps),
      recorder: rec.recorder,
      commit: rec.commit,
      call: call as never,
      ...(web ? { web: web as never, webAvailable: { firecrawl: false, contextdev: true } } : {}),
      ...(storedBrief !== undefined ? { readMissionBrief: async () => storedBrief } : {}),
      plannerModel: (async ({ tool }: { tool: { name: string } }) =>
        tool.name === UNDERSTAND_TOOL ? { input: JSON.parse(JSON.stringify(opts.understanding)), costUsd: 0.001 } : null) as never,
      models: { planning: "claude-haiku-5-5", execution: "claude-haiku-5-5" },
      resolveAccess: async () => NOT_ADMIN,
      notify: async () => undefined,
      log: (l) => logs.push(l),
    },
    m,
  );
  return { mission: store.missions.get(m.id)!, store, events: store.events.filter((e) => e.mission_id === m.id), money, call, logs };
}

describe("DT-20261119-15c LLM-First Brief + Capability-Bound Company+People Recovery (Real Discovery + Live R2 Shapes)", () => {
  it.each([false, true])("Must-pass 1 (Case 1, routerOn=%s): dual «شركتين» brief validates and drives company_people discovery -> prefers eligible aviato -> 2x1 card", async (routerOn) => {
    const req = "عايز شركتين برمجيات في مصر ومدير كل شركة";
    // Case 1 fix (b): Arabic feminine dual («شركتين» = 2) with count=2 MUST pass validateBrief (was rejected as number_not_written!)
    const case1Brief = validatedBrief(
      {
        request: req,
        count: 2,
        objectives: [
          { id: "o1", operation: "companies.discover" },
          { id: "o2", operation: "people.discover", parent: "o1" },
        ],
      },
      [req],
    );
    expect(storedBriefOf({ researchBrief: case1Brief })).not.toBeNull();

    let tombaCall = 0;
    const badMissingCols = () => ({
      summary_ar: "ستحصل على شركتين من شركات البرمجيات في مصر.",
      stages: [
        {
          key: "companies",
          title_ar: "شركات البرمجيات في مصر",
          endpoint_id: "tomba.companies.search.reveal",
          expected_rows: 2,
          parent_key: null,
          deliver: true,
          columns: [{ key: "name", title_ar: "اسم الشركة" }],
          measured_by: ["call_0002"],
          yield_from: "out_0001",
        },
      ],
    });
    const badIneligiblePeople = () => ({
      summary_ar: "ستحصل على شركتين برمجيات في مصر ومدير كل شركة.",
      stages: [
        {
          key: "companies",
          title_ar: "شركات البرمجيات في مصر",
          endpoint_id: "tomba.companies.search.reveal",
          expected_rows: 2,
          parent_key: null,
          deliver: true,
          columns: [{ key: "name", title_ar: "اسم الشركة" }],
          measured_by: ["call_0003"],
        },
        {
          key: "people",
          title_ar: "مدير كل شركة",
          endpoint_id: "blitzapi.people.waterfall-icp",
          parent_key: "companies",
          per_parent_rows: 1,
          expected_rows: 2,
          deliver: true,
          columns: [{ key: "full_name", title_ar: "الاسم الكامل" }],
          measured_by: ["call_0005"],
        },
      ],
    });

    const res = await runDiscoveryReplay({
      id: `msn_dt15c_case1_r_${routerOn}`,
      requestText: req,
      storedBrief: case1Brief,
      routerOn,
      understanding: {
        decision: "plan",
        understanding_ar: "قائمة بشركتين برمجيات في مصر، ومعهما مدير كل شركة.",
        accepts_available: false,
        steps: [
          { key: "companies", title_ar: "شركات البرمجيات في مصر", platform: "companies", capability: "companies.search", parent: "", deliver: true, count: { total: 2, all: false }, topic: "software", search_terms: ["software", "Egypt"], country: "EG" },
        ],
        people_of_companies: { asked: true, title_ar: "المديرين", per_company: 1, per_company_text: "مدير", companies_text: "شركتين", contact_kinds: [] },
      },
      callHandler: async (o) => {
        if (o.endpointId === "tomba.companies.search.reveal") {
          tombaCall += 1;
          if (tombaCall === 1) return tregResult({ data: { companies: [] } }, 0.0002);
          if (tombaCall === 2) return tregResult(tombaPage1OtherCompanies, 0.0002);
          return tregResult(tombaPage2WithCloudSoft5, 0.0002);
        }
        if (o.endpointId === "aviato.companies.employees") return tregResult(realAviatoCloudSoft5Page, 0.005);
        if (o.endpointId === "blitzapi.people.waterfall-icp") return tregResult(realBlitzWaterfallPage, 0.001);
        return tregResult(realIcypeasCase1Page, 0.00114);
      },
      steps: [
        { tool: "treg_call", args: { endpoint_id: "tomba.companies.search.reveal", params: { filters: { country: "EG", industry: "software" }, page: 1 }, why: "search", skip: allSkip } },
        { tool: "treg_call", args: { endpoint_id: "tomba.companies.search.reveal", params: { filters: { country: "EG" }, page: 1 }, why: "search", skip: allSkip } },
        { tool: "treg_call", args: { endpoint_id: "tomba.companies.search.reveal", params: { filters: { country: "EG" }, page: 2 }, why: "search", skip: allSkip } },
        { tool: "run_code", args: { code: "return inputs.call_0002.data.companies.map(c => ({ id: c.linkedin_url, name: c.name, industry: c.industry, city: c.city, country: c.country, website: c.website_url }))", files: ["call_0002"] } },
        { tool: "treg_call", args: { endpoint_id: "aviato.companies.employees", params: { linkedinURL: "https://www.linkedin.com/company/cloudsoft5/", website: "http://cloudsoft5.com", page: 1, perPage: 1 }, why: "people", skip: allSkip } },
        { tool: "treg_call", args: { endpoint_id: "blitzapi.people.waterfall-icp", params: { cascade: [{ include_title: ["CEO"] }], company_linkedin_url: "https://www.linkedin.com/company/cloudsoft5", max_results: 1 }, why: "people", skip: allSkip } },
        { tool: "treg_call", args: { endpoint_id: "icypeas.people.search", params: { pagination: { page: 0, size: 3 }, query: "CloudSoft5 manager Egypt" }, why: "people", skip: allSkip } },
        { tool: "propose_plan", args: badIneligiblePeople },
        { tool: "propose_plan", args: badMissingCols },
        { tool: "propose_plan", args: badMissingCols },
        { tool: "propose_plan", args: badMissingCols },
        { tool: "propose_plan", args: badMissingCols },
      ],
    });

    expect(res.mission.status, `logs=${res.logs.join(" | ")} error=${res.mission.error ?? ""}`).toBe("plan_ready");
    expect(res.mission.summary_ar).not.toBe(INTERNAL_PLANNING_AR);
    expect(res.money.calls).toHaveLength(0);
    const plan = res.mission.plan as PricedPlan;
    expect(plan.stages.find((s) => s.key === "companies")?.planned_rows).toBe(2);
    const pStage = plan.stages.find((s) => s.key === "company_people");
    expect(pStage).toMatchObject({ parent_key: "companies", planned_rows: 2, per_parent_rows: 1, endpoint_id: "aviato.companies.employees" });
    expect(plan.capability_selection?.stages.every((s) => s.source === "discovery")).toBe(true);
    expect(plan.stages.some((s) => s.endpoint_id === "blitzapi.people.waterfall-icp" || s.endpoint_id === "icypeas.people.search")).toBe(false);
  }, 30_000);

  it("Must-pass 2A (Case 2, 10 companies via stored brief kept across answer «…نبدأ بـ 10»): plan_ready for 10 × 1 with manager + email, phones «غير متوفر»", async () => {
    const req = "عايز 100 شركة ومدير كل شركة بالإيميل والتليفون";
    const case2Brief = validatedBrief(
      {
        request: req,
        count: 100,
        topic: null,
        country: null,
        objectives: [
          { id: "o1", operation: "companies.discover" },
          { id: "o2", operation: "people.discover", parent: "o1" },
          { id: "o3", operation: "company.contacts", parent: "o1", contacts: ["email", "phone"] },
        ],
      },
      [req],
    );

    let tombaCall = 0;
    const badProp = () => ({
      summary_ar: "ستحصل على 10 شركات برمجيات في مصر ومدير كل شركة بالإيميل فقط.",
      contacts_note_ar: "أرقام التليفون غير متوفرة",
      stages: [
        {
          key: "companies",
          title_ar: "شركات البرمجيات في مصر",
          endpoint_id: "tomba.companies.search.reveal",
          expected_rows: 10,
          parent_key: null,
          deliver: true,
          columns: [{ key: "name", title_ar: "اسم الشركة" }],
          measured_by: ["call_0002"],
        },
      ],
    });

    const res = await runDiscoveryReplay({
      id: "msn_dt15c_case2a_eligible",
      requestText: req,
      answerText: "مصر - شركات برمجيات - نبدأ بـ 10",
      storedBrief: case2Brief,
      withWebEmpty: true,
      understanding: {
        decision: "plan",
        understanding_ar: "قائمة بعشر شركات برمجيات في مصر، ومعها مدير كل شركة مع الإيميل والتليفون.",
        accepts_available: false,
        steps: [
          { key: "companies", title_ar: "شركات البرمجيات في مصر", platform: "companies", capability: "companies.search", parent: "", deliver: true, count: { total: 10, all: false }, topic: "software", search_terms: ["software", "Egypt"], country: "EG" },
        ],
        people_of_companies: { asked: true, title_ar: "المديرين", per_company: 1, per_company_text: "مدير", companies_text: "١٠ شركات", contact_kinds: ["email", "phone"] },
      },
      callHandler: async (o) => {
        if (o.endpointId === "tomba.companies.search.reveal") {
          tombaCall += 1;
          return tombaCall === 1 ? tregResult({ data: { companies: [] } }, 0.0002) : tregResult(tombaPageWithCarLog, 0.0002);
        }
        if (o.endpointId === "aviato.companies.employees") return tregResult(realAviatoCarLogPage, 0.005);
        if (o.endpointId === "blitzapi.people.employee-finder") return tregResult(realBlitzEmployeeFinderCase2Page, 0.000495);
        if (o.endpointId === "icypeas.people.search") return tregResult(realIcypeasCase2Page, 0.00038);
        return tregResult({ data: { emails: [{ email: "info@carlog.com" }] } }, 0.0089);
      },
      steps: [
        { tool: "treg_call", args: { endpoint_id: "tomba.companies.search.reveal", params: { filters: { country: "EG", industry: "software" }, page: 1 }, why: "companies", skip: allSkip } },
        { tool: "treg_call", args: { endpoint_id: "tomba.companies.search.reveal", params: { filters: { country: "EG" }, page: 1 }, why: "companies", skip: allSkip } },
        { tool: "treg_call", args: { endpoint_id: "aviato.companies.employees", params: { website: "carlog.com", page: 1, perPage: 1 }, why: "people", skip: allSkip } },
        { tool: "treg_call", args: { endpoint_id: "blitzapi.people.employee-finder", params: { company_linkedin_url: "https://www.linkedin.com/company/carlog.com", job_level: ["C-Team", "Manager"], max_results: 1 }, why: "people", skip: allSkip } },
        { tool: "treg_call", args: { endpoint_id: "icypeas.people.search", params: { pagination: { page: 0, size: 1 }, query: "CarLog manager Egypt" }, why: "people", skip: allSkip } },
        { tool: "treg_call", args: { endpoint_id: "tomba.companies.emails.list", params: { domain: "carlog.com", limit: 10 }, why: "emails", skip: allSkip } },
        { tool: "propose_plan", args: badProp },
        { tool: "propose_plan", args: badProp },
        { tool: "propose_plan", args: badProp },
        { tool: "propose_plan", args: badProp },
      ],
    });

    expect(res.mission.status, `logs=${res.logs.join(" | ")} error=${res.mission.error ?? ""}`).toBe("plan_ready");
    expect(res.money.calls).toHaveLength(0);
    const plan = res.mission.plan as PricedPlan;
    expect(plan.stages.find((s) => s.key === "companies")?.planned_rows).toBe(10);
    expect(plan.stages.find((s) => s.key === "company_people")).toMatchObject({ parent_key: "companies", planned_rows: 10, per_parent_rows: 1, endpoint_id: "aviato.companies.employees" });
    expect(new Set((plan.contact_steps ?? []).map((c) => c.kind)).has("email")).toBe(true);
    expect(plan.capability_selection?.stages.every((s) => s.source === "discovery")).toBe(true);
    const card = customerPlanView(plan);
    expect((card.notes_ar ?? []).join("\n")).toContain("غير متوفر");
    expect(plan.stages.some((s) => s.endpoint_id === "blitzapi.people.employee-finder" || s.endpoint_id === "icypeas.people.search")).toBe(false);
  }, 30_000);

  it("Must-pass 2B + Counter-case (only non-eligible people endpoints have rows, aviato 404): never plans ineligible endpoint, never «حد من جانبنا», asks ONE honest question + records capability issue text for inspector", async () => {
    const req = "عايز 100 شركة ومدير كل شركة";
    const storedBrief = validatedBrief(
      {
        request: req,
        count: 100,
        topic: null,
        country: null,
        objectives: [
          { id: "o1", operation: "companies.discover" },
          { id: "o2", operation: "people.discover", parent: "o1" },
        ],
      },
      [req],
    );
    let tombaCall = 0;
    const callsFn = async (o: TregCallOptions) => {
      if (o.endpointId === "aviato.companies.employees") {
        return { ok: false, httpStatus: 404, tregCallId: "t_404", costMicro: 0, latencyMs: 10, error: "Not", data: null, isRouteMaxCost: false, isPlatformBalanceLow: false };
      }
      if (o.endpointId === "tomba.companies.search.reveal") {
        tombaCall += 1;
        return tombaCall === 1 ? tregResult({ data: { companies: [] } }, 0.0002) : tregResult(tombaPageWithCarLog, 0.0002);
      }
      if (o.endpointId === "blitzapi.people.employee-finder") return tregResult(realBlitzEmployeeFinderCase2Page, 0.000495);
      return tregResult(realIcypeasCase2Page, 0.00038);
    };
    const steps: Parameters<typeof createFakeDriver>[0] = [
      { tool: "treg_call", args: { endpoint_id: "tomba.companies.search.reveal", params: { filters: { country: "EG", industry: "software" }, page: 1 }, why: "companies", skip: allSkip } },
      { tool: "treg_call", args: { endpoint_id: "tomba.companies.search.reveal", params: { filters: { country: "EG" }, page: 1 }, why: "companies", skip: allSkip } },
      { tool: "treg_call", args: { endpoint_id: "aviato.companies.employees", params: { website: "carlog.com", page: 1, perPage: 1 }, why: "people", skip: allSkip } },
      { tool: "treg_call", args: { endpoint_id: "blitzapi.people.employee-finder", params: { company_linkedin_url: "https://www.linkedin.com/company/carlog.com", job_level: ["C-Team", "Manager"], max_results: 1 }, why: "people", skip: allSkip } },
      { tool: "treg_call", args: { endpoint_id: "icypeas.people.search", params: { pagination: { page: 0, size: 1 }, query: "CarLog manager Egypt" }, why: "people", skip: allSkip } },
    ];
    const understanding = {
      decision: "plan",
      understanding_ar: "قائمة بعشر شركات برمجيات في مصر، ومعها مدير كل شركة.",
      accepts_available: false,
      steps: [
        { key: "companies", title_ar: "شركات البرمجيات في مصر", platform: "companies", capability: "companies.search", parent: "", deliver: true, count: { total: 10, all: false }, topic: "software", search_terms: ["software", "Egypt"], country: "EG" },
      ],
      people_of_companies: { asked: true, title_ar: "المديرين", per_company: 1, per_company_text: "مدير", companies_text: "١٠ شركات", contact_kinds: [] },
    };

    const first = await runDiscoveryReplay({
      id: "msn_dt15c_inelig_first",
      requestText: req,
      answerText: "مصر - شركات برمجيات - نبدأ بـ 10",
      storedBrief,
      understanding,
      callHandler: callsFn,
      steps,
    });

    expect(first.mission.plan ?? null).toBeNull();
    expect(first.mission.status).toBe("needs_input");
    expect(first.mission.summary_ar ?? "").not.toBe(INTERNAL_PLANNING_AR);
    expect(first.mission.question_ar).toBeTruthy();
    expect((await readRunState(first.store, first.mission.id)).peopleRecoveryAsked).toBe(true);
    const diagEvent1 = first.events.find((e) => (e.counts as Record<string, number> | undefined)?.issue_rec_sampled_people_not_eligible === 1);
    expect(diagEvent1).toBeDefined();
    expect(isInternalEvent(diagEvent1!)).toBe(true);

    const badCapPlan = () => ({
      summary_ar: "ستحصل على 10 شركات ومدير كل شركة.",
      stages: [
        { key: "companies", title_ar: "شركات", endpoint_id: "tomba.companies.search.reveal", expected_rows: 10, parent_key: null, deliver: true, columns: [{ key: "name", title_ar: "الاسم" }], measured_by: ["call_0002"], sample_rows: [{ id: "1", name: "CarLog" }] },
        { key: "people", title_ar: "المديرين", endpoint_id: "icypeas.people.search", expected_rows: 10, parent_key: "companies", per_parent_rows: 1, deliver: true, columns: [{ key: "full_name", title_ar: "الاسم" }], measured_by: ["call_0005"], sample_rows: [{ id: "2", full_name: "Maged Farouk" }] },
      ],
    });
    const second = await runDiscoveryReplay({
      id: "msn_dt15c_inelig_second",
      requestText: req,
      answerText: "مصر - شركات برمجيات - نبدأ بـ 10",
      storedBrief,
      peopleRecoveryAsked: true,
      understanding,
      callHandler: callsFn,
      steps: [
        ...steps,
        { tool: "propose_plan", args: badCapPlan },
        { tool: "propose_plan", args: badCapPlan },
        { tool: "propose_plan", args: badCapPlan },
      ],
    });
    expect(second.mission.plan ?? null).toBeNull();
    expect(second.mission.status).toBe("failed");
    expect(second.mission.error).toContain("cap_issues=");
    expect(second.mission.error).toMatch(/stage (?:people|company_people)/);
    expect(second.mission.error).toMatch(/icypeas\.people\.search|blitzapi\.people\.employee-finder/);
    expect(second.mission.error).not.toMatch(/[\u0600-\u06FF]|CarLog|CloudSoft5/);
    const inspected = buildInspection({ mission: second.mission, events: second.events as never, calls: [], callTotal: 0, now: new Date() });
    expect(inspected.mission.error).toMatch(/stage (?:people|company_people)/);
    expect(inspected.mission.error).not.toMatch(/[\u0600-\u06FF]|CarLog|CloudSoft5/);
  }, 30_000);

  it("Counter-case (ORDER 02 LLM-first): answer «شركات بس من غير مديرين» via chat LLM brief builder drops people objective -> NO people stage; plus absent-brief (c) asks honestly", async () => {
    const req = "عايز 10 شركات ومدير كل شركة";
    const storedBrief = validatedBrief(
      {
        request: req,
        count: 10,
        objectives: [
          { id: "o1", operation: "companies.discover" },
          { id: "o2", operation: "people.discover", parent: "o1" },
        ],
      },
      [req],
    );

    // Fake the existing chat LLM brief builder (decideTurn) revising objectives when user drops managers
    setChatModelForTesting(async () => ({
      ok: true,
      text: JSON.stringify({
        type: "edit_of_open_request",
        reason: "user dropped people",
        reply: "",
        count: 10,
        count_text: "10",
        brief: {
          status: "ready",
          request: "عايز 10 شركات برمجيات في مصر فقط",
          platforms: [],
          content: ["companies"],
          count: 10,
          topic: "شركات برمجيات",
          period: null,
          country: "مصر",
          language: null,
          objectives: [{ id: "o1", operation: "companies.discover" }],
        },
      }),
      usage: { inputTokens: 400, outputTokens: 120 },
    }));

    const droppedPeople = await runDiscoveryReplay({
      id: "msn_dt15c_drop_people",
      requestText: req,
      answerText: "شركات بس من غير مديرين",
      storedBrief,
      understanding: {
        decision: "plan",
        understanding_ar: "شركات برمجيات في مصر فقط.",
        accepts_available: false,
        steps: [
          { key: "companies", title_ar: "شركات البرمجيات في مصر", platform: "companies", capability: "companies.search", parent: "", deliver: true, count: { total: 10, all: false }, topic: "software", search_terms: ["software", "Egypt"], country: "EG" },
        ],
        people_of_companies: { asked: false, title_ar: "", per_company: null, per_company_text: "", companies_text: "", contact_kinds: [] },
      },
      callHandler: async () => tregResult(tombaPageWithCarLog, 0.0002),
      steps: [
        { tool: "treg_call", args: { endpoint_id: "tomba.companies.search.reveal", params: { filters: { country: "EG", industry: "software" }, page: 1 }, why: "companies", skip: allSkip } },
        { tool: "run_code", args: { code: "return inputs.call_0001.data.companies.slice(0,3).map(c => ({ id: c.linkedin_url, name: c.name, industry: c.industry, city: c.city, country: c.country, website: c.website_url }))", files: ["call_0001"] } },
        {
          tool: "propose_plan",
          args: {
            summary_ar: "ستحصل على 10 شركات برمجيات في مصر بالاسم والنشاط والموقع.",
            stages: [
              {
                key: "companies",
                title_ar: "شركات البرمجيات في مصر",
                endpoint_id: "tomba.companies.search.reveal",
                expected_rows: 10,
                parent_key: null,
                deliver: true,
                columns: [
                  { key: "name", title_ar: "اسم الشركة" },
                  { key: "industry", title_ar: "النشاط والتخصص" },
                  { key: "city", title_ar: "المدينة" },
                  { key: "country", title_ar: "الدولة" },
                  { key: "website", title_ar: "الموقع الإلكتروني" },
                  { key: "linkedin", title_ar: "صفحة الشركة على الشبكة المهنية" },
                ],
                measured_by: ["call_0001"],
                yield_from: "out_0001",
                relevance: { subject_ar: "شركات البرمجيات في مصر", terms: ["software", "برمجيات"], text_columns: ["name", "industry"], min_own_words: 0, review: true },
              },
            ],
          },
        },
      ],
    });

    expect(droppedPeople.logs.find((l) => l.startsWith("capability_discovery"))).not.toContain("company_people");
    expect(droppedPeople.mission.status).toBe("plan_ready");
    const droppedPlan = droppedPeople.mission.plan as PricedPlan;
    expect(droppedPlan.stages).toHaveLength(1);
    expect(droppedPlan.stages[0].key).toBe("companies");

    // ORDER 02 (c): when brief is truly absent (`storedBrief: null`) and PEOPLE_WORDS has no «مدير» match,
    // discovery has no company_people stage; with saved companies + people rows, recovery never ends in «حد من جانبنا» and asks ONE honest question.
    setChatModelForTesting(null);
    let tomba2 = 0;
    const noBrief = await runDiscoveryReplay({
      id: "msn_dt15c_absent_brief",
      requestText: "عايز شركتين برمجيات في مصر ومدير كل شركة",
      storedBrief: null,
      understanding: {
        decision: "plan",
        understanding_ar: "شركتين برمجيات في مصر ومدير كل شركة.",
        accepts_available: false,
        steps: [
          { key: "companies", title_ar: "شركات البرمجيات في مصر", platform: "companies", capability: "companies.search", parent: "", deliver: true, count: { total: 2, all: false }, topic: "software", search_terms: ["software", "Egypt"], country: "EG" },
        ],
        people_of_companies: { asked: true, title_ar: "المديرين", per_company: 1, per_company_text: "مدير", companies_text: "شركتين", contact_kinds: [] },
      },
      callHandler: async (o) => {
        if (o.endpointId === "tomba.companies.search.reveal") {
          tomba2 += 1;
          return tomba2 === 1 ? tregResult(tombaPage2WithCloudSoft5, 0.0002) : tregResult({ data: { companies: [] } }, 0.0002);
        }
        return tregResult(realAviatoCloudSoft5Page, 0.005);
      },
      steps: [
        { tool: "treg_call", args: { endpoint_id: "tomba.companies.search.reveal", params: { filters: { country: "EG", industry: "software" }, page: 2 }, why: "companies", skip: allSkip } },
        { tool: "treg_call", args: { endpoint_id: "aviato.companies.employees", params: { linkedinURL: "https://www.linkedin.com/company/cloudsoft5/", website: "http://cloudsoft5.com", page: 1, perPage: 1 }, why: "people", skip: allSkip } },
      ],
    });
    expect(noBrief.mission.status).toBe("needs_input");
    expect(noBrief.mission.summary_ar ?? "").not.toBe(INTERNAL_PLANNING_AR);
  }, 30_000);

  it("Counter-cases: companies-only unchanged with real discovery + empty run -> honest end", async () => {
    const coNeed = researchNeedOf({ request: "عايز 10 شركات برمجيات في مصر" });
    expect(coNeed.kind).toBe("companies");
    expect(coNeed.people).toBe(false);

    const companiesOnly = await runDiscoveryReplay({
      id: "msn_dt15c_companies_only",
      requestText: "عايز 10 شركات برمجيات في مصر",
      understanding: {
        decision: "plan",
        understanding_ar: "عشر شركات برمجيات في مصر.",
        accepts_available: false,
        steps: [
          { key: "companies", title_ar: "شركات البرمجيات في مصر", platform: "companies", capability: "companies.search", parent: "", deliver: true, count: { total: 10, all: false }, topic: "software", search_terms: ["software", "Egypt"], country: "EG" },
        ],
        people_of_companies: { asked: false, title_ar: "", per_company: null, per_company_text: "", companies_text: "", contact_kinds: [] },
      },
      callHandler: async () => tregResult(tombaPageWithCarLog, 0.0002),
      steps: [
        { tool: "treg_call", args: { endpoint_id: "tomba.companies.search.reveal", params: { filters: { country: "EG", industry: "software" }, page: 1 }, why: "companies", skip: allSkip } },
        { tool: "run_code", args: { code: "return inputs.call_0001.data.companies.slice(0,3).map(c => ({ id: c.linkedin_url, name: c.name, industry: c.industry, city: c.city, country: c.country, website: c.website_url }))", files: ["call_0001"] } },
        {
          tool: "propose_plan",
          args: {
            summary_ar: "ستحصل على 10 شركات برمجيات في مصر بالاسم والنشاط والموقع.",
            stages: [
              {
                key: "companies",
                title_ar: "شركات البرمجيات في مصر",
                endpoint_id: "tomba.companies.search.reveal",
                expected_rows: 10,
                parent_key: null,
                deliver: true,
                columns: [
                  { key: "name", title_ar: "اسم الشركة" },
                  { key: "industry", title_ar: "النشاط والتخصص" },
                  { key: "city", title_ar: "المدينة" },
                  { key: "country", title_ar: "الدولة" },
                  { key: "website", title_ar: "الموقع الإلكتروني" },
                  { key: "linkedin", title_ar: "صفحة الشركة على الشبكة المهنية" },
                ],
                measured_by: ["call_0001"],
                yield_from: "out_0001",
                relevance: { subject_ar: "شركات البرمجيات في مصر", terms: ["software", "برمجيات"], text_columns: ["name", "industry"], min_own_words: 0, review: true },
              },
            ],
          },
        },
      ],
    });
    expect(companiesOnly.mission.status).toBe("plan_ready");
    const coPlan = companiesOnly.mission.plan as PricedPlan;
    expect(coPlan.stages).toHaveLength(1);
    expect(coPlan.stages[0].key).toBe("companies");

    const emptyRes = await runDiscoveryReplay({
      id: "msn_dt15c_empty_run",
      requestText: "عايز شركتين برمجيات في مصر ومدير كل شركة",
      understanding: {
        decision: "plan",
        understanding_ar: "شركتين برمجيات في مصر ومدير كل شركة.",
        accepts_available: false,
        steps: [
          { key: "companies", title_ar: "شركات البرمجيات في مصر", platform: "companies", capability: "companies.search", parent: "", deliver: true, count: { total: 2, all: false }, topic: "software", search_terms: ["software", "Egypt"], country: "EG" },
        ],
        people_of_companies: { asked: true, title_ar: "المديرين", per_company: 1, per_company_text: "مدير", companies_text: "شركتين", contact_kinds: [] },
      },
      callHandler: async () => tregResult({ data: { companies: [] } }, 0.0002),
      steps: [
        { tool: "treg_call", args: { endpoint_id: "tomba.companies.search.reveal", params: { filters: { country: "EG" }, page: 1 }, why: "companies", skip: allSkip } },
        { tool: "finish", args: { outcome: "cannot_serve", kind: "empty", summary_ar: "لم نجد شركات." } },
      ],
    });
    expect(emptyRes.mission.status).toBe("unserved");
    expect(emptyRes.mission.summary_ar).toBe(EMPTY_SOURCE_AR);
    expect(emptyRes.mission.summary_ar).not.toBe(INTERNAL_PLANNING_AR);
  }, 30_000);

  it("ORDER 04 dual-rule delta: brief-anchored noun («شركة») matches «شركتين»/proclitics; counter-cases and un-anchored nouns give no 2", () => {
    const req = "عايز شركتين برمجيات في مصر ومدير كل شركة";
    const parsedCase1 = parseBrief({
      status: "ready",
      request: req,
      platforms: [],
      content: ["companies", "people"],
      count: 2,
      topic: "برمجيات",
      period: null,
      country: "مصر",
      language: null,
      objectives: [
        { id: "o1", operation: "companies.discover" },
        { id: "o2", operation: "people.discover", parent: "o1" },
      ],
    });
    expect(parsedCase1.ok).toBe(true);
    if (!parsedCase1.ok) return;
    expect(briefItemNouns(parsedCase1.brief)).toContain("شركة");

    // Must pass with brief noun «شركة» + optional proclitics و/ف/ب/ل/ك
    for (const token of ["شركتين", "وشركتين", "فشركتين", "بشركتين", "لشركتين", "كشركتين", "وبشركتين", "شركتان"]) {
      expect([...numbersWritten(token, ["شركة"])]).toEqual([2]);
    }

    // No brief noun -> no dual read (old behaviour)
    expect([...numbersWritten("شركتين")]).toEqual([]);
    expect([...numbersWritten("شركتين", [])]).toEqual([]);
    const noNounBrief = parseBrief({
      status: "ready",
      request: "عايز شركتين برمجيات في مصر",
      platforms: [],
      content: ["companies"],
      count: 2,
      topic: "برمجيات",
      period: null,
      country: "مصر",
      language: null,
      objectives: [{ id: "o1", operation: "companies.discover" }],
    });
    expect(noNounBrief.ok).toBe(true);
    if (noNounBrief.ok) {
      expect(briefItemNouns(noNounBrief.brief)).toEqual([]);
      expect(validateBrief(noNounBrief.brief, { customerTurns: ["عايز شركتين برمجيات في مصر"] })).toEqual({ ok: false, reason: "number_not_written" });
    }

    // Required ORDER 04 counter-cases: never read 2 with or without «شركة»
    for (const phrase of ["شركات في باكستان", "أفغانستان", "بساتين", "حيتان", "الشركتين", "والشركتين", "مدرستين"]) {
      expect(numbersWritten(phrase).has(2)).toBe(false);
      expect(numbersWritten(phrase, ["شركة"]).has(2)).toBe(false);
    }
    expect([...numbersWritten("ستين")]).toEqual([60]);
    expect([...numbersWritten("ستين", ["شركة"])]).toEqual([60]);

    // validateBrief rejects «مدرستين» and non-number suffixes when brief noun is «شركة»
    for (const badReq of [
      "عايز مدرستين في مصر",
      "شركات في باكستان وأفغانستان وبساتين وحيتان الشركتين",
    ]) {
      const b = parseBrief({
        status: "ready",
        request: badReq,
        platforms: [],
        content: ["companies"],
        count: 2,
        topic: "شركة",
        period: null,
        country: "مصر",
        language: null,
        objectives: [{ id: "o1", operation: "companies.discover", what: "شركة" }],
      });
      expect(b.ok).toBe(true);
      if (b.ok) {
        expect(validateBrief(b.brief, { customerTurns: [badReq] })).toEqual({ ok: false, reason: "number_not_written" });
      }
    }
  });
});
