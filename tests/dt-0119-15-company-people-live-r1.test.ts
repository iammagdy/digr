import { describe, expect, it, vi } from "vitest";
import { createFakeDriver } from "../agent/src/fakeDriver";
import { createMemoryStore, newMission } from "../agent/src/memoryStore";
import { runPlanning } from "../agent/src/runMission";
import { UNDERSTAND_TOOL } from "../agent/src/llmPlanner/prompts";
import { INTERNAL_PLANNING_AR, EMPTY_SOURCE_AR, classifyNoCardEnd } from "../src/lib/agentMission/refusal";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import type { TregCallOptions, TregCallResult } from "../src/functions/shared/tregClient";
import { NOT_ADMIN, USER_ID, fakeRecorder, tregResult } from "./helpers/agentHarness";
import { fakeMoneyClient } from "./helpers/agentMoney";

/**
 * DT-20261119-15: Offline replays of live r1 Case 1 & Case 2 (f488e999) + terminal recovery paths + counter-cases.
 * Strictly offline with fakes, zero real network, zero spend.
 */
vi.stubGlobal("fetch", () => { throw new Error("a real network call was attempted"); });

const catalog = loadTregCatalog();
const allSkip = Object.fromEntries(catalog.endpoints.map((e) => [e.id, "other"]));

const tombaCompaniesPage = {
  data: {
    companies: Array.from({ length: 50 }, (_, i) => ({
      name: i === 0 ? "Nile Soft Egypt" : `Cairo Tech ${i}`,
      description: "B2B Software Development and IT company in Cairo, Egypt",
      country: "EG",
      city: "Cairo",
      street_address: `${10 + i} Tahrir St, Cairo`,
      postal_code: "11511",
      industry: "Software Development",
      website_url: `https://nilesoft${i}.com.eg`,
      phone_number: `+20223456${700 + i}`,
      linkedin_url: `https://linkedin.com/company/nilesoft-${i}`,
      total_emails: 12,
    })),
  },
};

const aviatoPeoplePage = {
  employees: [
    {
      startDate: "2021-03-01T00:00:00.000Z",
      companyName: "Nile Soft Egypt",
      person: {
        fullName: "Hossam El-Din",
        headline: "CEO & Managing Director",
        URLs: { linkedin: "https://www.linkedin.com/in/hossam-eldin" },
      },
    },
  ],
};

const blitzWaterfallPage = {
  results: [
    {
      first_name: "Tarek",
      last_name: "Mansour",
      full_name: "Tarek Mansour",
      headline: "Engineering Director",
      linkedin_url: "https://www.linkedin.com/in/tarek-mansour",
      experiences: [{ company_name: "Nile Soft Egypt", company_domain: "nilesoft0.com.eg", job_title: "Engineering Director" }],
    },
  ],
};

const findymailPeoplePage = [
  {
    name: "Salma Nabil",
    linkedinUrl: "https://www.linkedin.com/in/salma-nabil",
    companyWebsite: "nilesoft0.com.eg",
    companyName: "Nile Soft Egypt",
    jobTitle: "General Manager",
  },
];

const tombaEmailsPage = {
  data: {
    emails: Array.from({ length: 10 }, (_, i) => ({ email: `info${i}@nilesoft0.com.eg`, type: "generic" })),
  },
};

const blitzEmployeeFinderPage = {
  results: [
    {
      first_name: "Mona",
      last_name: "Adel",
      full_name: "Mona Adel",
      headline: "Head of Operations & Director",
      linkedin_url: "https://www.linkedin.com/in/mona-adel",
      experiences: [{ company_name: "Nile Soft Egypt", company_domain: "nilesoft0.com.eg", job_title: "Director" }],
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
        search: async () => ({ results: [] }),
        parse: async () => ({ emails: [], phones: [], text: "" }),
        read: async () => ({ markdown: "", links: [] }),
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
  return { mission: store.missions.get(m.id)!, store, money, call, logs };
}

describe("DT-20261119-15 Live R1 Replays & Recovery", () => {
  it("Must-pass 1 (Case 1 replay): tomba 50 companies + aviato/blitz/findymail 1 person each -> plan_ready card (2 companies × 1 manager), never «حد من جانبنا»", async () => {
    const badProp = () => ({
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
          measured_by: ["call_0001"],
          yield_from: "out_0001",
        },
      ],
    });

    const res = await runReplay({
      id: "msn_dt15_case1",
      requestText: "عايز شركتين برمجيات في مصر ومدير كل شركة",
      understanding: {
        decision: "plan",
        understanding_ar: "قائمة بشركتين من شركات البرمجيات في مصر، ومعهما مدير كل شركة من الشركتين.",
        accepts_available: false,
        steps: [
          { key: "companies", title_ar: "شركات البرمجيات في مصر", platform: "companies", capability: "companies.search", parent: "", deliver: true, count: { total: 2, all: false }, topic: "software", search_terms: ["software", "Egypt"], country: "EG" },
        ],
        people_of_companies: { asked: true, title_ar: "المديرين", per_company: 1, per_company_text: "مدير", companies_text: "شركتين", contact_kinds: [] },
      },
      callHandler: async (o) => {
        if (o.endpointId === "tomba.companies.search.reveal") return tregResult(tombaCompaniesPage, 0.0002);
        if (o.endpointId === "aviato.companies.employees") return tregResult(aviatoPeoplePage, 0.005);
        if (o.endpointId === "blitzapi.people.waterfall-icp") return tregResult(blitzWaterfallPage, 0.001);
        return tregResult(findymailPeoplePage, 0.0198);
      },
      steps: [
        { tool: "treg_call", args: { endpoint_id: "tomba.companies.search.reveal", params: { query: "software Egypt" }, why: "search", skip: allSkip } },
        { tool: "run_code", args: { code: "return inputs.call_0001.data.companies.map(c => ({ id: c.linkedin_url, name: c.name, industry: c.industry, city: c.city, country: c.country, website: c.website_url }))", files: ["call_0001"] } },
        { tool: "treg_call", args: { endpoint_id: "aviato.companies.employees", params: { page: 1, perPage: 1, website: "nilesoft0.com.eg" }, why: "people", skip: allSkip } },
        { tool: "treg_call", args: { endpoint_id: "blitzapi.people.waterfall-icp", params: { cascade: [{ include_title: ["CEO"] }], company_linkedin_url: "https://linkedin.com/company/nilesoft-0", max_results: 1 }, why: "people", skip: allSkip } },
        { tool: "treg_call", args: { endpoint_id: "findymail.search.employees", params: { count: 1, job_titles: ["CEO"], website: "nilesoft0.com.eg" }, why: "people", skip: allSkip } },
        { tool: "propose_plan", args: badProp },
        { tool: "propose_plan", args: badProp },
      ],
    });

    expect(res.mission.status, `logs=${res.logs.join(" | ")}`).toBe("plan_ready");
    expect(res.mission.summary_ar).not.toBe(INTERNAL_PLANNING_AR);
    expect(res.money.calls).toHaveLength(0);
    expect(res.call).toHaveBeenCalledTimes(4); // zero extra paid calls
    const plan = res.mission.plan as { stages: Array<{ key: string; planned_rows: number; per_parent_rows?: number }> };
    expect(plan.stages.find((s) => s.key === "companies")?.planned_rows).toBe(2);
    expect(plan.stages.find((s) => s.key === "people")).toMatchObject({ planned_rows: 2, per_parent_rows: 1 });
  }, 30_000);

  it("Must-pass 2 (Case 2 replay): 10 companies (tomba), blitz people, tomba emails, phones EMPTY, icypeas missing_params, aviato 404 -> plan_ready card or 1 question, never «حد من جانبنا»", async () => {
    const badPropWithNoteAndWrongText = () => ({
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
          columns: [{ key: "name", title_ar: "اسم الشركة" }, { key: "website", title_ar: "الموقع الإلكتروني" }],
          measured_by: ["call_0003"],
        },
      ],
    });

    const res = await runReplay({
      id: "msn_dt15_case2",
      requestText: "عايز 100 شركة ومدير كل شركة بالإيميل والتليفون",
      answerText: "مصر - شركات برمجيات - نبدأ بـ 10",
      withWebEmpty: true,
      understanding: {
        decision: "plan",
        understanding_ar: "قائمة بعشر شركات برمجيات في مصر، ومعها مدير كل شركة مع بريده الإلكتروني ورقم هاتفه.",
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
        if (o.endpointId === "tomba.companies.search.reveal") return tregResult(tombaCompaniesPage, 0.0002);
        if (o.endpointId === "tomba.companies.emails.list") return tregResult(tombaEmailsPage, 0.0089);
        return tregResult(blitzEmployeeFinderPage, 0.001);
      },
      steps: [
        { tool: "treg_call", args: { endpoint_id: "icypeas.companies.emails.role", params: {}, why: "emails", skip: allSkip } },
        { tool: "treg_call", args: { endpoint_id: "aviato.companies.employees", params: { page: 1, perPage: 1, website: "nilesoft0.com.eg" }, why: "people", skip: allSkip } },
        { tool: "treg_call", args: { endpoint_id: "tomba.companies.search.reveal", params: { filters: { country: "EG" }, page: 1 }, why: "companies", skip: allSkip } },
        { tool: "treg_call", args: { endpoint_id: "tomba.companies.emails.list", params: { domain: "nilesoft0.com.eg", limit: 10 }, why: "emails", skip: allSkip } },
        { tool: "treg_call", args: { endpoint_id: "blitzapi.people.employee-finder", params: { company_linkedin_url: "https://linkedin.com/company/nilesoft-0", max_results: 1 }, why: "people", skip: allSkip } },
        { tool: "propose_plan", args: badPropWithNoteAndWrongText },
        { tool: "propose_plan", args: badPropWithNoteAndWrongText },
        { tool: "propose_plan", args: badPropWithNoteAndWrongText },
      ],
    });

    expect(["plan_ready", "needs_input"]).toContain(res.mission.status);
    expect(res.mission.summary_ar).not.toBe(INTERNAL_PLANNING_AR);
    expect(res.money.calls).toHaveLength(0);
    expect(res.call).toHaveBeenCalledTimes(4); // icypeas refused locally before call; aviato+tomba_search+tomba_emails+blitz executed once each
    if (res.mission.status === "plan_ready") {
      const plan = res.mission.plan as { stages: Array<{ key: string; planned_rows: number }>; contact_steps?: Array<{ kind: string }> };
      expect(plan.stages.find((s) => s.key === "companies")?.planned_rows).toBe(10);
      expect(plan.stages.find((s) => s.key === "people")?.planned_rows).toBe(10);
      expect(new Set((plan.contact_steps ?? []).map((c) => c.kind)).has("email")).toBe(true);
    }
  }, 30_000);

  it("Must-pass 1b: sole linked people source with extra non-contract fields (`startDate`) also recovers cleanly via dynamic field columns", async () => {
    const res = await runReplay({
      id: "msn_dt15_aviato_date",
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
        o.endpointId === "tomba.companies.search.reveal" ? tregResult(tombaCompaniesPage, 0.0002) : tregResult(aviatoPeoplePage, 0.005),
      steps: [
        { tool: "treg_call", args: { endpoint_id: "tomba.companies.search.reveal", params: { query: "software Egypt" }, why: "search", skip: allSkip } },
        { tool: "treg_call", args: { endpoint_id: "aviato.companies.employees", params: { page: 1, perPage: 1, website: "nilesoft0.com.eg" }, why: "people", skip: allSkip } },
        { tool: "finish", args: { outcome: "cannot_serve", kind: "unsupported", summary_ar: "تعذر." } },
      ],
    });
    expect(res.mission.status).toBe("plan_ready");
    expect(res.mission.summary_ar).not.toBe(INTERNAL_PLANNING_AR);
    expect(res.money.calls).toHaveLength(0);
  }, 30_000);

  it("Must-pass 3: single-rejection plan_invalid end (`count=1, stop=end`) with saved company+people rows STILL recovers a plan card", async () => {
    const singleInvalid = () => ({
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
          measured_by: ["call_0001"],
          yield_from: "out_0001",
        },
      ],
    });

    const res = await runReplay({
      id: "msn_dt15_single_reject",
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
        o.endpointId === "tomba.companies.search.reveal" ? tregResult(tombaCompaniesPage, 0.0002) : tregResult(blitzWaterfallPage, 0.001),
      steps: [
        { tool: "treg_call", args: { endpoint_id: "tomba.companies.search.reveal", params: { query: "software Egypt" }, why: "search", skip: allSkip } },
        { tool: "run_code", args: { code: "return inputs.call_0001.data.companies.map(c => ({ id: c.linkedin_url, name: c.name, industry: c.industry, city: c.city, country: c.country, website: c.website_url }))", files: ["call_0001"] } },
        { tool: "treg_call", args: { endpoint_id: "blitzapi.people.waterfall-icp", params: { cascade: [{ include_title: ["CEO"] }], company_linkedin_url: "https://linkedin.com/company/nilesoft-0", max_results: 1 }, why: "people", skip: allSkip } },
        { tool: "propose_plan", args: singleInvalid },
      ],
    });

    expect(res.mission.status).toBe("plan_ready");
    expect(res.money.calls).toHaveLength(0);
  }, 30_000);

  it("Counter-cases: empty sources -> honest empty message (not internal); companies-only unchanged; pure missing_params with no saved people stays internal", async () => {
    // 1. All calls empty -> honest empty_source message, never «حد من جانبنا»
    const emptyRes = await runReplay({
      id: "msn_dt15_empty",
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
        { tool: "treg_call", args: { endpoint_id: "tomba.companies.search.reveal", params: { query: "none" }, why: "search", skip: allSkip } },
        { tool: "finish", args: { outcome: "cannot_serve", kind: "empty", summary_ar: "لم نجد شركات مطابقة للطلب." } },
      ],
    });
    expect(emptyRes.mission.status).toBe("unserved");
    expect(emptyRes.mission.summary_ar).toBe(EMPTY_SOURCE_AR);
    expect(emptyRes.mission.summary_ar).not.toBe(INTERNAL_PLANNING_AR);

    // 2. Companies-only mission: no people asked, no people calls -> recovery does nothing
    const compOnly = await runReplay({
      id: "msn_dt15_co_only",
      requestText: "عايز شركتين برمجيات في مصر",
      understanding: {
        decision: "plan",
        understanding_ar: "شركتين برمجيات في مصر.",
        accepts_available: false,
        steps: [
          { key: "companies", title_ar: "شركات البرمجيات في مصر", platform: "companies", capability: "companies.search", parent: "", deliver: true, count: { total: 2, all: false }, topic: "software", search_terms: ["software", "Egypt"], country: "EG" },
        ],
        people_of_companies: { asked: false, title_ar: "", per_company: 0, per_company_text: "", companies_text: "شركتين", contact_kinds: [] },
      },
      callHandler: async () => tregResult(tombaCompaniesPage, 0.0002),
      steps: [
        { tool: "treg_call", args: { endpoint_id: "tomba.companies.search.reveal", params: { query: "software" }, why: "search", skip: allSkip } },
        { tool: "finish", args: { outcome: "cannot_serve", kind: "unsupported", summary_ar: "غير متاح." } },
      ],
    });
    expect(compOnly.mission.plan ?? null).toBeNull();

    // 3. No saved people rows + missing_params refusal stays internal planning_missing_params
    expect(
      classifyNoCardEnd({
        claim: null,
        endedWithoutAnswer: false,
        calls: [{ phase: "planning", endpoint_id: "icypeas.companies.emails.role", status: "refused", refused_reason: "missing_params:domainOrCompany" }],
      }),
    ).toEqual({ cls: "internal", reason: "planning_missing_params" });
  }, 30_000);
});
