import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentMissionCardBody } from "../src/components/mission/AgentMissionCard";
import { approveForCustomer, loadCustomerMission, smallerVersionForCustomer } from "../src/lib/agentMission/customerActions";
import { AGENT_JOB_POINTS_CAP } from "../src/lib/agentMission/constants";
import { publicPlanOf } from "../src/lib/agentMission/overLimit";
import { createMemoryDb } from "./helpers/memoryDb";
import { replayClient } from "./helpers/agentReplay";
import { createFakeDriver } from "../agent/src/fakeDriver";
import { createMemoryStore, newMission } from "../agent/src/memoryStore";
import { runPlanning } from "../agent/src/runMission";
import { updateRunState } from "../agent/src/runState";
import { UNDERSTAND_TOOL } from "../agent/src/llmPlanner/prompts";
import { INTERNAL_PLANNING_AR, EMPTY_SOURCE_AR } from "../src/lib/agentMission/refusal";
import { customerPlanView, type PricedPlan } from "../src/lib/agentMission/plan";
import { isInternalEvent } from "../src/lib/agentMission/eventText";
import { buildInspection } from "../src/lib/server/adminMissionInspector";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import type { TregCallOptions, TregCallResult } from "../src/functions/shared/tregClient";
import { NOT_ADMIN, USER_ID, fakeRecorder, tregResult } from "./helpers/agentHarness";
import { fakeMoneyClient } from "./helpers/agentMoney";

/**
 * DT-20261119-15b: Exact live r2 (d7dd7219) real-shape offline replays + counter-cases + admin diagnostic event checks.
 * Strictly offline with fakes, zero real network, zero spend.
 */
vi.stubGlobal("fetch", () => { throw new Error("a real network call was attempted"); });
afterEach(() => vi.unstubAllEnvs());

const catalog = loadTregCatalog();
const allSkip = Object.fromEntries(catalog.endpoints.map((e) => [e.id, "other"]));

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
    companies: Array.from({ length: 50 }, (_, i) => {
      if (i === 5) {
        return {
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
        };
      }
      if (i === 6) {
        return {
          name: "Fedora",
          website_url: "fedora-eg.com",
          linkedin_url: "https://linkedin.com/company/viewcode",
          street_address: "",
          phone_number: false,
          city: "Giza",
          country: "EG",
          industry: "Software Development",
          company_size: "11-50",
          founded: 2019,
          total_emails: 4,
        };
      }
      return {
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
      };
    }),
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

const realAviatoEmployeesPage = {
  employees: [
    {
      companyName: "CloudSoft5",
      companyID: "aviato_cs5",
      linkedinNumID: 18125389,
      startDate: "2015-01-01T00:00:00.000Z",
      endDate: "2017-12-01T00:00:00.000Z",
      positionList: [
        { title: "Engineering Manager", startDate: "2015-01-01", endDate: "2017-12-01", department: "Engineering", seniorityScore: 7 },
      ],
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
      firstname: "Rami",
      lastname: "Farid",
      headline: "General Manager at CloudSoft5",
      profileUrl: "https://www.linkedin.com/in/rami-farid-cs5",
      lastJobTitle: "General Manager",
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
      first_name: "Omar",
      last_name: "Nabil",
      linkedin_url: "https://www.linkedin.com/in/omar-nabil-carlog",
      location: { city: "Egypt", country_code: "EG" },
    },
  ],
};

const realIcypeasCase2Page = {
  total: 1,
  success: true,
  leads: [
    {
      firstname: "Samer",
      lastname: "Zaki",
      headline: "CEO at CarLog",
      profileUrl: "https://www.linkedin.com/in/samer-zaki-carlog",
      lastJobTitle: "CEO",
      lastCompanyName: "CarLog",
      lastCompanyUrn: "urn:li:fs_salesCompany:357338",
      lastCompanyUrl: "https://www.linkedin.com/company/carlog/",
      lastCompanyWebsite: "http://carlog.com",
      address: "مصر",
    },
  ],
};

async function runReplay(opts: {
  id: string;
  requestText: string;
  answerText?: string | null;
  understanding: Record<string, unknown>;
  callHandler: (o: TregCallOptions) => Promise<TregCallResult>;
  steps: Parameters<typeof createFakeDriver>[0];
  withWebEmpty?: boolean;
}) {
  const store = createMemoryStore();
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

describe("DT-20261119-15b Live R2 Real-Shape Replays & Diagnostics", () => {
  it("Must-pass 1 (Case 1 exact real shapes): CloudSoft5 in tomba page 2 + aviato/blitz/icypeas -> plan_ready (2 companies × 1 manager)", async () => {
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
    const badUnserved = () => ({
      ...badMissingCols(),
      unserved_steps: [{ reason_ar: "تعذر الوصول للمديرين" }],
    });

    const res = await runReplay({
      id: "msn_dt15b_case1",
      requestText: "عايز شركتين برمجيات في مصر ومدير كل شركة",
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
        if (o.endpointId === "aviato.companies.employees") return tregResult(realAviatoEmployeesPage, 0.005);
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
        { tool: "propose_plan", args: badUnserved },
        { tool: "propose_plan", args: badMissingCols },
        { tool: "propose_plan", args: badMissingCols },
        { tool: "propose_plan", args: badMissingCols },
        { tool: "propose_plan", args: badMissingCols },
      ],
    });

    expect(res.mission.status, `logs=${res.logs.join(" | ")} error=${res.mission.error ?? ""}`).toBe("plan_ready");
    expect(res.mission.summary_ar).not.toBe(INTERNAL_PLANNING_AR);
    expect(res.money.calls).toHaveLength(0);
    const plan = res.mission.plan as { stages: Array<{ key: string; planned_rows: number; per_parent_rows?: number }> };
    expect(plan.stages.find((s) => s.key === "companies")?.planned_rows).toBe(2);
    expect(plan.stages.find((s) => s.key === "people")).toMatchObject({ planned_rows: 2, per_parent_rows: 1 });
  }, 30_000);

  it("Must-pass 2 (Case 2 exact real shapes): CarLog numeric linkedin /company/357338 vs blitz company_linkedin_url carlog.com + answer «…نبدأ بـ 10» -> plan_ready (10 companies × 1 manager, email)", async () => {
    let tombaCall = 0;
    let blitzCall = 0;
    let icypeasPeopleCall = 0;
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
          measured_by: ["call_0004"],
        },
      ],
    });

    const res = await runReplay({
      id: "msn_dt15b_case2",
      requestText: "عايز 100 شركة ومدير كل شركة بالإيميل والتليفون",
      answerText: "مصر - شركات برمجيات - نبدأ بـ 10",
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
        if (o.endpointId === "aviato.companies.employees") {
          return { ok: false, httpStatus: 404, tregCallId: "t_404", costMicro: 0, latencyMs: 12, error: "Not", data: null, isRouteMaxCost: false, isPlatformBalanceLow: false };
        }
        if (o.endpointId === "blitzapi.people.employee-finder") {
          blitzCall += 1;
          if (blitzCall === 1) {
            return { ok: false, httpStatus: 422, tregCallId: "t_422", costMicro: 0, latencyMs: 12, error: "Invalid job_level", data: null, isRouteMaxCost: false, isPlatformBalanceLow: false };
          }
          return tregResult(realBlitzEmployeeFinderCase2Page, 0.000495);
        }
        if (o.endpointId === "tomba.companies.search.reveal") {
          tombaCall += 1;
          return tombaCall === 1 ? tregResult({ data: { companies: [] } }, 0.0002) : tregResult(tombaPageWithCarLog, 0.0002);
        }
        if (o.endpointId === "icypeas.people.search") {
          icypeasPeopleCall += 1;
          return icypeasPeopleCall === 1 ? tregResult({ total: 0, success: true, leads: [] }, 0.00038) : tregResult(realIcypeasCase2Page, 0.00038);
        }
        if (o.endpointId === "icypeas.companies.emails.role") {
          return tregResult({ emails: [{ email: "contact@carlog.com" }] }, 0.019);
        }
        return tregResult({ data: { emails: [{ email: "info@carlog.com" }, { email: "omar@carlog.com" }] } }, 0.0089);
      },
      steps: [
        { tool: "treg_call", args: { endpoint_id: "aviato.companies.employees", params: { page: 1, perPage: 1, website: "http://carlog.com" }, why: "people", skip: allSkip } },
        { tool: "treg_call", args: { endpoint_id: "blitzapi.people.employee-finder", params: { company_linkedin_url: "https://www.linkedin.com/company/carlog.com", job_level: ["CXO", "Owner", "Partner"], max_results: 1 }, why: "people", skip: allSkip } },
        { tool: "treg_call", args: { endpoint_id: "icypeas.companies.emails.role", params: {}, why: "emails", skip: allSkip } },
        { tool: "treg_call", args: { endpoint_id: "tomba.companies.search.reveal", params: { filters: { country: "EG", industry: "software" }, page: 1 }, why: "companies", skip: allSkip } },
        { tool: "treg_call", args: { endpoint_id: "tomba.companies.search.reveal", params: { filters: { country: "EG" }, page: 1 }, why: "companies", skip: allSkip } },
        { tool: "parse_page", args: { parser: "emails", url: "https://carlog.com", why: "emails" } },
        { tool: "parse_page", args: { parser: "phones", url: "https://carlog.com", why: "phones" } },
        { tool: "treg_call", args: { endpoint_id: "icypeas.people.search", params: { pagination: { page: 0, size: 1 }, query: "CarLog CEO" }, why: "people", skip: allSkip } },
        { tool: "treg_call", args: { endpoint_id: "icypeas.people.search", params: { pagination: { page: 0, size: 1 }, query: "CarLog manager Egypt" }, why: "people", skip: allSkip } },
        { tool: "treg_call", args: { endpoint_id: "blitzapi.people.employee-finder", params: { company_linkedin_url: "https://www.linkedin.com/company/carlog.com", job_level: ["C-Team", "Manager"], max_results: 1 }, why: "people", skip: allSkip } },
        { tool: "treg_call", args: { endpoint_id: "icypeas.companies.emails.role", params: { domainOrCompany: "carlog.com" }, why: "emails", skip: allSkip } },
        { tool: "treg_call", args: { endpoint_id: "tomba.companies.emails.list", params: { domain: "carlog.com", limit: 10 }, why: "emails", skip: allSkip } },
        { tool: "propose_plan", args: badProp },
        { tool: "propose_plan", args: badProp },
        { tool: "propose_plan", args: badProp },
        { tool: "propose_plan", args: badProp },
      ],
    });

    expect(res.mission.status, `logs=${res.logs.join(" | ")} error=${res.mission.error ?? ""}`).toBe("plan_ready");
    expect(res.mission.summary_ar).not.toBe(INTERNAL_PLANNING_AR);
    expect(res.money.calls).toHaveLength(0);
    const plan = res.mission.plan as PricedPlan;
    expect(plan.stages.find((s) => s.key === "companies")?.planned_rows).toBe(10);
    expect(plan.stages.find((s) => s.key === "people")?.planned_rows).toBe(10);
    expect(new Set((plan.contact_steps ?? []).map((c) => c.kind)).has("email")).toBe(true);
    const card = customerPlanView(plan);
    expect((card.notes_ar ?? []).join("\n")).toContain("غير متوفر");
    const coStage = plan.stages.find((s) => s.key === "companies");
    if (coStage?.yield_from) {
      const mappedText = String(res.store.files.get(`msn_dt15b_case2/out/${coStage.yield_from}.json`) ?? "[]");
      const mapped = JSON.parse(mappedText) as Array<Record<string, unknown>>;
      expect(mapped.some((r) => r.phone === false || r.phone === "false")).toBe(false);
    }
  }, 30_000);

  it("Must-pass 1b (icypeas query-only) & 1c (aviato linkedinNumID-only): both link and recover plan_ready independently", async () => {
    const icypeasOnly = await runReplay({
      id: "msn_dt15b_icypeas_only",
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
      callHandler: async (o) =>
        o.endpointId === "tomba.companies.search.reveal" ? tregResult(tombaPage2WithCloudSoft5, 0.0002) : tregResult(realIcypeasCase1Page, 0.00114),
      steps: [
        { tool: "treg_call", args: { endpoint_id: "tomba.companies.search.reveal", params: { filters: { country: "EG" }, page: 2 }, why: "companies", skip: allSkip } },
        { tool: "treg_call", args: { endpoint_id: "icypeas.people.search", params: { pagination: { page: 0, size: 3 }, query: "manager Egypt" }, why: "people", skip: allSkip } },
        { tool: "finish", args: { outcome: "cannot_serve", kind: "unsupported", summary_ar: "تعذر." } },
      ],
    });
    expect(icypeasOnly.mission.status, `logs=${icypeasOnly.logs.join(" | ")}`).toBe("plan_ready");
    expect((icypeasOnly.mission.plan as PricedPlan).stages.find((s) => s.key === "people")?.planned_rows).toBe(2);

    const aviatoNumericOnly = await runReplay({
      id: "msn_dt15b_aviato_numid",
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
      callHandler: async (o) =>
        o.endpointId === "tomba.companies.search.reveal"
          ? tregResult({
              data: {
                companies: [
                  { name: "Other Numeric Co", website_url: "other-num.eg", linkedin_url: "https://linkedin.com/company/18125389", street_address: "", phone_number: false, city: "Cairo", country: "EG", industry: "Software" },
                  { name: "Second Co", website_url: "second.eg", linkedin_url: "https://linkedin.com/company/second-co", street_address: "", phone_number: false, city: "Cairo", country: "EG", industry: "Software" },
                ],
              },
            }, 0.0002)
          : tregResult({
              employees: [
                {
                  companyName: "Completely Different Display",
                  linkedinNumID: 18125389,
                  startDate: "2016-01-01T00:00:00.000Z",
                  positionList: [{ title: "CEO" }],
                  person: { fullName: "Hossam Adel", URLs: { linkedin: "linkedin.com/in/hossam-num" } },
                },
              ],
            }, 0.005),
      steps: [
        { tool: "treg_call", args: { endpoint_id: "tomba.companies.search.reveal", params: { filters: { country: "EG" }, page: 1 }, why: "companies", skip: allSkip } },
        { tool: "treg_call", args: { endpoint_id: "aviato.companies.employees", params: { linkedinID: 18125389, page: 1, perPage: 1 }, why: "people", skip: allSkip } },
        { tool: "finish", args: { outcome: "cannot_serve", kind: "unsupported", summary_ar: "تعذر." } },
      ],
    });
    expect(aviatoNumericOnly.mission.status, `logs=${aviatoNumericOnly.logs.join(" | ")}`).toBe("plan_ready");
  }, 30_000);

  it("Counter-cases + Admin Diagnostic Event: unrelated company never attached, truly empty stays unserved, rejected/skipped recovery emits ONE admin-only diagnostic with exact codes", async () => {
    // 1. People rows from unrelated company ("Delta Solutions Corp" vs saved "Delta Tech") must NOT attach -> no plan_ready, AND emits ONE admin-only diagnostic event
    const unrelatedRes = await runReplay({
      id: "msn_dt15b_unrelated",
      requestText: "عايز شركتين برمجيات في مصر ومدير كل شركة",
      answerText: "مصر - شركات برمجيات - نبدأ بـ 2",
      understanding: {
        decision: "plan",
        understanding_ar: "شركتين برمجيات في مصر ومدير كل شركة.",
        accepts_available: false,
        steps: [
          { key: "companies", title_ar: "شركات البرمجيات في مصر", platform: "companies", capability: "companies.search", parent: "", deliver: true, count: { total: 2, all: false }, topic: "software", search_terms: ["software", "Egypt"], country: "EG" },
        ],
        people_of_companies: { asked: true, title_ar: "المديرين", per_company: 1, per_company_text: "مدير", companies_text: "شركتين", contact_kinds: [] },
      },
      callHandler: async (o) =>
        o.endpointId === "tomba.companies.search.reveal"
          ? tregResult({
              data: {
                companies: [
                  { name: "Delta Tech", website_url: "deltatech.eg", linkedin_url: "https://linkedin.com/company/delta-tech-eg", street_address: "", phone_number: false, city: "Cairo", country: "EG", industry: "Software" },
                  { name: "CloudSoft5", website_url: "cloudsoft5.com", linkedin_url: "https://linkedin.com/company/cloudsoft5", street_address: "", phone_number: false, city: "Cairo", country: "EG", industry: "Software" },
                ],
              },
            }, 0.0002)
          : tregResult({
              total: 1,
              success: true,
              leads: [
                {
                  firstname: "Nader",
                  lastname: "Sami",
                  profileUrl: "https://www.linkedin.com/in/nader-unrelated",
                  lastJobTitle: "CEO",
                  lastCompanyName: "Delta Solutions Corp",
                  lastCompanyUrn: "urn:li:fs_salesCompany:999888777",
                  lastCompanyUrl: "https://www.linkedin.com/company/delta-solutions-99/",
                  lastCompanyWebsite: "http://deltasolutions.io",
                },
              ],
            }, 0.00038),
      steps: [
        { tool: "treg_call", args: { endpoint_id: "tomba.companies.search.reveal", params: { filters: { country: "EG" }, page: 1 }, why: "companies", skip: allSkip } },
        { tool: "treg_call", args: { endpoint_id: "icypeas.people.search", params: { pagination: { page: 0, size: 1 }, query: "Delta CEO" }, why: "people", skip: allSkip } },
        { tool: "finish", args: { outcome: "cannot_serve", kind: "unsupported", summary_ar: "تعذر." } },
      ],
    });
    expect(unrelatedRes.mission.status).toBe("failed");
    expect(unrelatedRes.mission.plan ?? null).toBeNull();
    const diagEvents1 = unrelatedRes.events.filter((e) => (e.counts as Record<string, number> | undefined)?.issue_rec_skipped_after_no_linked_people === 1 || (e.counts as Record<string, number> | undefined)?.issue_rec_no_linked_people === 1);
    expect(diagEvents1).toHaveLength(1);
    expect(isInternalEvent(diagEvents1[0])).toBe(true);
    const inspected1 = buildInspection({ mission: unrelatedRes.mission, events: unrelatedRes.events as never, calls: [], callTotal: 0, now: new Date() });
    expect(inspected1.events.filter((e) => e.internal).length).toBeGreaterThanOrEqual(1);

    // 2. Truly empty run -> honest unserved end
    const emptyRes = await runReplay({
      id: "msn_dt15b_empty",
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

    // 3. Saved evidence recovers a locked preview after the earlier question.
    vi.stubEnv("JOB_MAX_POINTS_CAP", "");
    const storeOverCap = createMemoryStore();
    const moneyOverCap = fakeMoneyClient();
    const recOverCap = fakeRecorder();
    const mOver = newMission({
      id: "msn_dt15b_overcap_diag",
      user_id: USER_ID,
      status: "planning",
      request_text: "عايز 200 شركة برمجيات في مصر ومدير كل شركة",
      answer_text: "مصر - شركات برمجيات",
    });
    storeOverCap.missions.set(mOver.id, mOver);
    await updateRunState(storeOverCap, mOver.id, (s) => ({ ...s, peopleRecoveryAsked: true }));
    await runPlanning(
      {
        store: storeOverCap,
        client: moneyOverCap.client,
        catalog,
        driver: createFakeDriver([
          { tool: "treg_call", args: { endpoint_id: "tomba.companies.search.reveal", params: { filters: { country: "EG" }, page: 2 }, why: "companies", skip: allSkip } },
          { tool: "treg_call", args: { endpoint_id: "aviato.companies.employees", params: { linkedinURL: "https://www.linkedin.com/company/cloudsoft5/", website: "http://cloudsoft5.com", page: 1, perPage: 1 }, why: "people", skip: allSkip } },
          { tool: "treg_call", args: { endpoint_id: "aviato.companies.employees", params: { page: 1, perPage: 1, website: "http://cloudsoft5.com" }, why: "people", skip: allSkip } },
        ]),
        recorder: recOverCap.recorder,
        commit: recOverCap.commit,
        call: (async (o: TregCallOptions) =>
          o.endpointId === "tomba.companies.search.reveal" ? tregResult(tombaPage2WithCloudSoft5, 0.01) : tregResult(realAviatoEmployeesPage, 0.05)) as never,
        plannerModel: (async ({ tool }: { tool: { name: string } }) =>
          tool.name === UNDERSTAND_TOOL
            ? {
                input: {
                  decision: "plan",
                  understanding_ar: "٢٠٠ شركة ومدير كل شركة.",
                  accepts_available: false,
                  steps: [{ key: "companies", title_ar: "شركات البرمجيات في مصر", platform: "companies", capability: "companies.search", parent: "", deliver: true, count: { total: 200, all: false }, topic: "software", search_terms: ["software", "Egypt"], country: "EG" }],
                  people_of_companies: { asked: true, title_ar: "المديرين", per_company: 1, per_company_text: "مدير", companies_text: "٢٠٠ شركة", contact_kinds: [] },
                },
                costUsd: 0.001,
              }
            : null) as never,
        models: { planning: "claude-haiku-5-5", execution: "claude-haiku-5-5" },
        resolveAccess: async () => NOT_ADMIN,
        notify: async () => undefined,
      },
      mOver,
    );
    const previewMission = storeOverCap.missions.get(mOver.id)!;
    const plan = previewMission.plan;
    if (!plan) throw new Error("expected the recovery preview to be saved");
    expect(previewMission.status).toBe("plan_ready");
    expect(plan.hold_cap_preview).toBe(true);
    expect(plan.price.reservePoints).toBeGreaterThan(AGENT_JOB_POINTS_CAP);
    const db = createMemoryDb();
    db.seed("missions", [{ ...previewMission, plan_public: publicPlanOf(plan), updated_at: previewMission.created_at }]);
    const { client } = replayClient(db, moneyOverCap);
    const owner = { id: previewMission.id, userId: USER_ID };
    const preview = await loadCustomerMission(client, owner);
    if (!preview.ok || !preview.view.affordability?.offer) throw new Error("expected a valid capped offer for the preview");
    const offer = preview.view.affordability.offer;
    expect(offer.reservePoints).toBeLessThanOrEqual(AGENT_JOB_POINTS_CAP);
    const html = renderToStaticMarkup(createElement(AgentMissionCardBody, { view: preview.view, isGuest: false, authoritative: true }));
    expect(html).not.toContain('data-testid="agent-approve"');

    const approve = (approvalVersion: unknown) => approveForCustomer(client, {
      ...owner, isGuest: false, emailVerified: true, approvalVersion,
    });
    const holds = () => moneyOverCap.ledger.filter((row) => row.type === "reserve").map((row) => -row.delta);
    expect(await approve(preview.view.approvalVersion)).toMatchObject({ ok: false, status: 409, code: "affordability_changed" });
    expect(moneyOverCap.quotes.size).toBe(0);
    expect(moneyOverCap.jobs.size).toBe(0);
    expect(holds()).toEqual([]);
    const selected = await smallerVersionForCustomer(client, { ...owner, approvalVersion: preview.view.approvalVersion, offer });
    expect(selected).toMatchObject({ ok: true, status: "plan_ready" });
    const ready = await loadCustomerMission(client, owner);
    if (!ready.ok) throw new Error(ready.error);
    expect(ready.view.affordability).toMatchObject({ mode: "ready", reservePoints: offer.reservePoints });
    expect(await approve(ready.view.approvalVersion)).toMatchObject({ ok: true, reservePoints: offer.reservePoints });
    expect(moneyOverCap.quotes.size).toBe(1);
    expect(moneyOverCap.jobs.size).toBe(1);
    expect(holds()).toEqual([offer.reservePoints]);
  }, 30_000);
});
