import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { PEOPLE_OF_COMPANY_CAPABILITIES, understoodPeopleOf } from "../src/lib/agentMission/childSources";
import { capabilitiesOf } from "../agent/src/llmPlanner/catalogView";
import { acceptOf } from "../agent/src/llmPlanner/run";
import * as planner from "../agent/src/llmPlanner/planner";
import { planWithLlm, understandRequest, type LlmPlannerDeps, type PlannerModel, type UnderstoodStep, type Understanding } from "../agent/src/llmPlanner/planner";
import { UNDERSTAND_TOOL } from "../agent/src/llmPlanner/prompts";
import { NOT_ADMIN } from "./helpers/agentHarness";
import { replay } from "./helpers/agentReplay";
import { COMPANIES, PEOPLE, SLUGS, columnsOf, linkedinOf, personOf, request as A1_REQUEST, why } from "./helpers/a1World";
import { callIds, lastOutputId } from "./helpers/agentFakeWorld";
import { firstOutputId } from "./helpers/agentRelevance";
import { dispatcher, PHONES, SECTOR_WORLD } from "./helpers/g1World";
import type { Results } from "./helpers/agentFakeWorld";
import type { FakeStep } from "../agent/src/fakeDriver";
import type { TregCallOptions } from "../src/functions/shared/tregClient";
import { tregResult } from "./helpers/agentHarness";
import { customerPlanView } from "../src/lib/agentMission/plan";

vi.stubGlobal("fetch", () => { throw new Error("a real network call was attempted"); });

const catalog = loadTregCatalog();
const COMPANIES_CAP = [...capabilitiesOf(catalog, NOT_ADMIN, "companies")].sort().find((c) => !PEOPLE_OF_COMPANY_CAPABILITIES.has(c))!;
const PEOPLE_CAP = [...PEOPLE_OF_COMPANY_CAPABILITIES].sort().find((c) => capabilitiesOf(catalog, NOT_ADMIN, c.split(".")[0]).has(c))!;

const LIVE = "عايز شركتين صغيرتين ومن كل شركة المديرين وإيميل وتليفون كل مدير";

// Access withCheckedCompaniesCount gracefully so tests can execute and fail-first on main before implementation
const withCheckedCompaniesCount: (u: Understanding, said: ReadonlyArray<string>) => Understanding =
  (planner as any).withCheckedCompaniesCount ?? ((u: Understanding) => u);

const peopleAsk = (
  asked: boolean,
  companies_text: string = "",
  title_ar: string = asked ? "المديرين" : "",
  extra: Record<string, unknown> = {}
) => ({
  asked,
  title_ar,
  per_company: null as number | null,
  per_company_text: "",
  companies_text,
  contact_kinds: (asked ? ["email", "phone"] : []) as ("email" | "phone")[],
  ...extra,
});

const companiesStep: UnderstoodStep = {
  key: "companies",
  title_ar: "شركات المقاولات",
  platform: "companies",
  capability: COMPANIES_CAP,
  parent: null,
  deliver: true,
  count: { total: 2, per_parent: null, all: false },
  search_terms: ["مقاولات"],
  source: null,
  topic: null,
  period: null,
};

const peopleStep: UnderstoodStep = {
  key: "pp",
  title_ar: "المديرين",
  platform: PEOPLE_CAP.split(".")[0],
  capability: PEOPLE_CAP,
  parent: "companies",
  deliver: true,
  count: { total: null, per_parent: 2, all: false },
  search_terms: [],
  source: null,
  topic: null,
  period: null,
};

const askAnswer = (over: Record<string, unknown> = {}) => ({
  decision: "ask",
  understanding_ar: "شركتان مقاولات.",
  question_ar: "تحب نجيب إيه بالظبط؟",
  options_ar: ["المديرين", "الشركات فقط"],
  accepts_available: false,
  steps: [],
  people_of_companies: peopleAsk(true, "شركتين"),
  missing: [],
  ...over,
});

const planAnswer = (over: Record<string, unknown> = {}) => ({
  decision: "plan",
  understanding_ar: "شركتان مقاولات.",
  accepts_available: false,
  missing: [],
  steps: [companiesStep],
  people_of_companies: peopleAsk(false),
  ...over,
});

function U(steps: UnderstoodStep[] = [], ask?: any, extra: Record<string, unknown> = {}): Understanding {
  return {
    decision: "plan",
    understanding_ar: "شركتان",
    accepts_available: false,
    steps,
    ...(ask !== undefined ? { people_of_companies: ask } : {}),
    ...extra,
  } as Understanding;
}

interface Seen { user: string; schemaDecision: string }
function sequence(answers: unknown[]): { model: PlannerModel; seen: Seen[] } {
  const seen: Seen[] = [];
  let i = 0;
  const model: PlannerModel = async ({ tool, user }) => {
    if (tool.name !== UNDERSTAND_TOOL) return null;
    seen.push({ user, schemaDecision: ((tool.schema as any).properties?.decision?.enum as unknown[] ?? []).join("|") });
    const next = answers[Math.min(i, answers.length - 1)];
    i += 1;
    return { input: JSON.parse(JSON.stringify(next)), costUsd: 0.001 };
  };
  return { model, seen };
}

const depsOf = (model: PlannerModel): LlmPlannerDeps => ({
  model,
  catalog,
  access: NOT_ADMIN,
  today: "2026-11-19",
  probe: async () => { throw new Error("no paid call"); },
  readPage: async () => null,
  accept: acceptOf(catalog, NOT_ADMIN),
});

const understood = async (answers: unknown[], words = LIVE) => {
  const m = sequence(answers);
  const got = await understandRequest(
    { words: [words], request: "" },
    { model: m.model, catalog, access: NOT_ADMIN, today: "2026-11-19" }
  );
  if (!got.ok) return got;
  return {
    ok: true as const,
    value: got.value,
    seen: m.seen,
    people: understoodPeopleOf(got.value.steps, got.value.people_of_companies, (got.value as any).companies_count),
  };
};

describe("T1: companies count reaches the planner and hand-over", () => {
  describe("MUST BIND (fails on main: no export / undefined)", () => {
    it("a. LIVE, cited «شركتين» -> companies_count 2 (also with total 8, and total null / steps [] / decision cannot)", () => {
      const u1 = U([companiesStep], peopleAsk(true, "شركتين", "المديرين"));
      expect(withCheckedCompaniesCount(u1, [LIVE]).companies_count).toBe(2);

      const comp8 = { ...companiesStep, count: { total: 8, per_parent: null, all: false } };
      const u2 = U([comp8], peopleAsk(true, "شركتين", "المديرين"));
      expect(withCheckedCompaniesCount(u2, [LIVE]).companies_count).toBe(2);

      const uCannot = U([], peopleAsk(true, "شركتين", "المديرين"), { decision: "cannot", cannot_ar: "لا يمكن" });
      expect(withCheckedCompaniesCount(uCannot, [LIVE]).companies_count).toBe(2);
    });

    it("b. «عايز ٣ شركات ومن كل شركة المديرين», cited «٣ شركات» -> 3; «اتنين شركات» -> 2", () => {
      const msg3 = "عايز ٣ شركات ومن كل شركة المديرين";
      const u3 = U([companiesStep], peopleAsk(true, "٣ شركات", "المديرين"));
      expect(withCheckedCompaniesCount(u3, [msg3]).companies_count).toBe(3);

      const msg2 = "عايز اتنين شركات ومن كل شركة المديرين";
      const u2 = U([companiesStep], peopleAsk(true, "اتنين شركات", "المديرين"));
      expect(withCheckedCompaniesCount(u2, [msg2]).companies_count).toBe(2);
    });

    it("c. «عايز ٣ شركات ومن كل شركة ٣ مديرين», cited «٣ شركات», per 3 with per_company_text «٣ مديرين» -> 3 (written twice)", () => {
      const msg = "عايز ٣ شركات ومن كل شركة ٣ مديرين";
      const u = U([companiesStep], peopleAsk(true, "٣ شركات", "المديرين", { per_company: 3, per_company_text: "٣ مديرين" }));
      expect(withCheckedCompaniesCount(u, [msg]).companies_count).toBe(3);
    });
  });

  describe("MUST NOT BIND (Gate 1 P1-1; all companies_count undefined)", () => {
    it("d. a year: message «شركات تأسست من 2010 ومن كل شركة المديرين», model total 2010, cited «» -> none; and cited «2010» -> none", () => {
      const msg = "شركات تأسست من 2010 ومن كل شركة المديرين";
      const comp2010 = { ...companiesStep, count: { total: 2010, per_parent: null, all: false } };
      const uEmpty = U([comp2010], peopleAsk(true, "", "المديرين"));
      expect(withCheckedCompaniesCount(uEmpty, [msg]).companies_count).toBeUndefined();

      const uYear = U([comp2010], peopleAsk(true, "2010", "المديرين"));
      expect(withCheckedCompaniesCount(uYear, [msg]).companies_count).toBeUndefined();
    });

    it("e. «3M»: message «شركات زي 3M ومن كل شركة المديرين», total 3, cited «» -> none; cited «3M» -> none", () => {
      const msg = "شركات زي 3M ومن كل شركة المديرين";
      const comp3 = { ...companiesStep, count: { total: 3, per_parent: null, all: false } };
      const uEmpty = U([comp3], peopleAsk(true, "", "المديرين"));
      expect(withCheckedCompaniesCount(uEmpty, [msg]).companies_count).toBeUndefined();

      const u3M = U([comp3], peopleAsk(true, "3M", "المديرين"));
      expect(withCheckedCompaniesCount(u3M, [msg]).companies_count).toBeUndefined();
    });

    it("f. a phone number: message with «01001234567», total 1001234567, cited «» -> none; cited the number -> none", () => {
      const msg = "شركات رقمها 01001234567 ومن كل شركة المديرين";
      const compPhone = { ...companiesStep, count: { total: 1001234567, per_parent: null, all: false } };
      const uEmpty = U([compPhone], peopleAsk(true, "", "المديرين"));
      expect(withCheckedCompaniesCount(uEmpty, [msg]).companies_count).toBeUndefined();

      const uPhone = U([compPhone], peopleAsk(true, "01001234567", "المديرين"));
      expect(withCheckedCompaniesCount(uPhone, [msg]).companies_count).toBeUndefined();
    });

    it("g. the per-company number: message «عايز شركات في أسوان ومن كل شركة ٣ مديرين», total 3, per_company null, cited «» -> none; cited «٣ مديرين» -> none. Cited «اتنين مديرين» -> none", () => {
      const msg = "عايز شركات في أسوان ومن كل شركة ٣ مديرين";
      const comp3 = { ...companiesStep, count: { total: 3, per_parent: null, all: false } };
      const uEmpty = U([comp3], peopleAsk(true, "", "المديرين", { per_company: null }));
      expect(withCheckedCompaniesCount(uEmpty, [msg]).companies_count).toBeUndefined();

      const uPer = U([comp3], peopleAsk(true, "٣ مديرين", "المديرين", { per_company: null }));
      expect(withCheckedCompaniesCount(uPer, [msg]).companies_count).toBeUndefined();

      const msg2 = "عايز شركات في أسوان ومن كل شركة اتنين مديرين";
      const uPer2 = U([companiesStep], peopleAsk(true, "اتنين مديرين", "المديرين", { per_company: null }));
      expect(withCheckedCompaniesCount(uPer2, [msg2]).companies_count).toBeUndefined();
    });

    it("h. cited not in the message («شركتان» for LIVE) -> none; empty cited -> none; no people ask and no people step -> none; no people title anywhere with cited «شركتين» -> none", () => {
      const uNotIn = U([companiesStep], peopleAsk(true, "شركتان", "المديرين"));
      expect(withCheckedCompaniesCount(uNotIn, [LIVE]).companies_count).toBeUndefined();

      const uEmpty = U([companiesStep], peopleAsk(true, "", "المديرين"));
      expect(withCheckedCompaniesCount(uEmpty, [LIVE]).companies_count).toBeUndefined();

      const uNoAsk = U([companiesStep], peopleAsk(false, "شركتين", "المديرين"));
      expect(withCheckedCompaniesCount(uNoAsk, [LIVE]).companies_count).toBeUndefined();

      const uNoTitle = U([companiesStep], peopleAsk(true, "شركتين", ""));
      expect(withCheckedCompaniesCount(uNoTitle, [LIVE]).companies_count).toBeUndefined();
    });

    it("i. total 8 invented with cited «» for LIVE -> none (must-pass 3)", () => {
      const comp8 = { ...companiesStep, count: { total: 8, per_parent: null, all: false } };
      const u = U([comp8], peopleAsk(true, "", "المديرين"));
      expect(withCheckedCompaniesCount(u, [LIVE]).companies_count).toBeUndefined();
    });
  });

  describe("THROUGH THE PLANNER", () => {
    it("j. understandRequest -> value.companies_count 2 and understoodPeopleOf has companies: 2; first answer a refused ask then plan -> still 2; ask refused twice -> understanding.companies_count 2", async () => {
      const planWithDual = planAnswer({
        people_of_companies: peopleAsk(true, "شركتين", "المديرين"),
      });
      const r1 = await understood([planWithDual]);
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;
      expect((r1.value as any).companies_count).toBe(2);
      expect(r1.people).toMatchObject({ companies: 2 });

      // RCA5 flow: first answer a refused ask, second answer a plan
      const r2 = await understood([
        askAnswer({ people_of_companies: peopleAsk(true, "شركتين", "المديرين") }),
        planAnswer({ people_of_companies: peopleAsk(true, "شركتين", "المديرين") }),
      ]);
      expect(r2.ok).toBe(true);
      if (!r2.ok) return;
      expect((r2.value as any).companies_count).toBe(2);
      expect(r2.people).toMatchObject({ companies: 2 });

      // Ask refused twice -> returns { ok: false, error: "ask_refused", understanding }
      const r3 = await understood([
        askAnswer({ people_of_companies: peopleAsk(true, "شركتين", "المديرين") }),
        askAnswer({ people_of_companies: peopleAsk(true, "شركتين", "المديرين") }),
      ]);
      expect(r3.ok).toBe(false);
      if (r3.ok) return;
      expect((r3 as any).understanding?.companies_count).toBe(2);
    });

    it("k. understoodPeopleOf(steps, ask) and (..., null) and (..., 0) -> toEqual today's shape (no companies key); with 2 -> companies: 2", () => {
      const base = understoodPeopleOf([peopleStep], peopleAsk(true));
      expect(base).not.toBeNull();
      expect("companies" in (base ?? {})).toBe(false);

      const withNull = understoodPeopleOf([peopleStep], peopleAsk(true), null);
      expect(withNull).toEqual(base);

      const withZero = understoodPeopleOf([peopleStep], peopleAsk(true), 0);
      expect(withZero).toEqual(base);

      const with2 = understoodPeopleOf([peopleStep], peopleAsk(true), 2);
      expect(with2).toMatchObject({ companies: 2 });
    });

    describe("l. E2E (must-pass 1+2)", () => {
      const E2E_REQUEST = "عايز شركتين مصريتين في قطاع الكهروميكانيكا ومن كل شركة المديرين وإيميل وتليفون كل مدير";
      const ALT = "blitzapi.people.employee-finder";

      beforeEach(() => {
        vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-19T10:00:00Z"), shouldAdvanceTime: true });
      });
      afterEach(() => {
        vi.useRealTimers();
      });

      function planFlowWithRows(companiesExpectedRows: number): FakeStep[] {
        const world = SECTOR_WORLD.electromechanical;
        const ccols = columnsOf(["name", "اسم الشركة"], ["activity", "القطاع"], ["city", "المدينة"], ["website", "الموقع الإلكتروني"], ["phone", "التليفون"], ["address", "العنوان"], ["linkedin", "صفحة الشركة على الشبكة المهنية"]);
        const pcols = columnsOf(["full_name", "الاسم"], ["job_title", "المسمى الوظيفي"], ["company", "الشركة"], ["linkedin", "الملف المهني للشخص"], ["email", "الإيميل", "work_email"], ["phone", "رقم التليفون", "phone"]);
        return [
          { tool: "report_progress", args: { message_ar: "أبحث عن الشركات ومسؤوليها", counts: { sources: 2 } } },
          { tool: "catalog_search", args: { words: ["companies", "search"], limit: 5 } },
          { tool: "describe_endpoint", args: { id: COMPANIES } },
          { tool: "treg_call", args: { endpoint_id: COMPANIES, params: { query: "electromechanical", page: 1 }, why } },
          { tool: "run_code", args: (r: Results) => ({ code: `return inputs.${callIds(r)[0]}.data.companies.map(r => ({ id: r.linkedin_url, name: r.name, activity: r.industry || '', city: r.city || '', website: r.website_url || '', phone: r.phone_number || '', address: r.street_address || '', linkedin: r.linkedin_url || '' }))`, files: [callIds(r)[0]] }) },
          { tool: "describe_endpoint", args: { id: PEOPLE } },
          { tool: "treg_call", args: { endpoint_id: PEOPLE, params: { company_linkedin_url: linkedinOf("orascom-em"), cascade: [{ include_title: ["Chief Executive Officer", "Managing Director"] }], max_results: 10 }, why } },
          { tool: "propose_plan", args: (res: Results) => ({
            summary_ar: "ستحصل على الشركات والعاملين فيها.",
            stages: [
              { key: "companies", title_ar: "شركات مصرية في المعدات الكهربائية والميكانيكية", endpoint_id: COMPANIES, expected_rows: companiesExpectedRows, parent_key: null, deliver: true, columns: ccols,
                sample_rows: [{ id: linkedinOf("orascom-em"), name: world.names[0], activity: world.industry, city: "Cairo", website: "orascom-em.com.eg", phone: PHONES[0], address: "1 Industrial Zone, Cairo", linkedin: linkedinOf("orascom-em") }], measured_by: [callIds(res)[0], firstOutputId(res)] },
              { key: "people", title_ar: "موظفو كل شركة", endpoint_id: ALT, expected_rows: companiesExpectedRows * 2, parent_key: "companies", per_parent_rows: 2, deliver: true, columns: pcols, measured_by: [] },
            ],
          }) },
        ];
      }

      const person = (slug: (typeof SLUGS)[number], j: number) => personOf(slug, j, "Managing Director");
      const answers = (counts: number[] = [2, 2, 2, 2, 2]) => Array.from({ length: 300 }, () => {
        const base = dispatcher({});
        return (o: TregCallOptions) => {
          if (o.endpointId === PEOPLE) return tregResult({ results: [] }, 0.0005);
          if (o.endpointId === ALT) {
            const i = SLUGS.findIndex((x) => JSON.stringify(o.params ?? {}).includes(x));
            return tregResult({ results: Array.from({ length: i >= 0 ? counts[i] : 0 }, (_, j) => person(SLUGS[i], j)) }, 0.0005);
          }
          return base(o);
        };
      });

      const execution = () => (): FakeStep[] => [
        { tool: "report_progress", args: { message_ar: "بدأت جمع الشركات", counts: { target: 5 } } },
        { tool: "treg_call", args: { endpoint_id: COMPANIES, params: { query: "electromechanical", page: 1 }, why } },
        { tool: "run_code", args: (r: Results) => ({ code: `return inputs.${callIds(r)[0]}.data.companies.map(r => ({ id: r.linkedin_url, name: r.name, activity: r.industry || '', city: r.city || '', website: r.website_url || '', phone: r.phone_number || '', address: r.street_address || '', linkedin: r.linkedin_url || '' }))`, files: [callIds(r)[0]] }) },
        { tool: "save_rows", args: (r: Results) => ({ stage_key: "companies", from_output: lastOutputId(r) }) },
        ...SLUGS.map((slug): FakeStep => ({ tool: "treg_call", args: { endpoint_id: ALT, params: { company_linkedin_url: linkedinOf(slug), cascade: [{ include_title: ["Managing Director"] }], max_results: 2 }, why } })),
        { tool: "run_code", args: (r: Results) => { const ids = callIds(r); return { code: `const out = []; ${SLUGS.map((slug, k) => `(inputs.${ids[k + 1]}.results || []).forEach((x) => { const p = x.person || {}; const e = (p.experiences && p.experiences[0]) || {}; out.push({ id: p.linkedin_url, parent_id: ${JSON.stringify(linkedinOf(slug))}, full_name: p.full_name, job_title: e.job_title || '', company: e.company_name || '', linkedin: p.linkedin_url, email: '', phone: '' }); });`).join(" ")} return out;`, files: ids.slice(1, 6) }; } },
        { tool: "save_rows", args: (r: Results) => ({ stage_key: "people", from_output: lastOutputId(r) }) },
        { tool: "finish", args: { outcome: "delivered", summary_ar: "سُلّمت الشركات وأشخاصها." } },
      ];

      const makeDeps = (companies_text: string, countTotal = 2) => {
        const under = {
          decision: "plan",
          understanding_ar: "شركتان كهروميكانيكا ومعها العاملون فيها.",
          accepts_available: false,
          steps: [{
            key: "companies",
            title_ar: "شركات الكهروميكانيكا",
            platform: "companies",
            capability: COMPANIES_CAP,
            parent: null,
            deliver: true,
            count: { total: countTotal, all: false },
            search_terms: ["electromechanical"],
          }],
          people_of_companies: {
            asked: true,
            title_ar: "المديرين",
            per_company: 2,
            per_company_text: "اتنين",
            companies_text,
            contact_kinds: ["email", "phone"],
          },
        };
        const plannerModel: PlannerModel = async ({ tool }) =>
          tool.name === UNDERSTAND_TOOL ? { input: JSON.parse(JSON.stringify(under)), costUsd: 0.001 } : null;
        return (base: any) => ({ ...base, plannerModel });
      };

      it("E2E: proposed 5 companies with understanding cited «شركتين» binds planned_rows to 2, reserve matches a 2-companies run, and card has no «٥ شركات»; control with cited «» stays 5", async () => {
        // Run where model proposed 5, but understanding has companies_text: "شركتين"
        const rBound = await replay({
          request: E2E_REQUEST,
          planning: planFlowWithRows(5),
          execution: execution(),
          answers: answers([2, 2, 2, 2, 2]) as any,
          deps: makeDeps("شركتين", 2),
        });
        const planBound = rBound.mission.plan as any;
        const compBound = planBound.stages.find((s: any) => s.key === "companies");
        expect(compBound.planned_rows).toBe(2);

        // Reference run where model proposed 2 directly
        const rDirect2 = await replay({
          request: E2E_REQUEST,
          planning: planFlowWithRows(2),
          execution: execution(),
          answers: answers([2, 2, 2, 2, 2]) as any,
          deps: makeDeps("شركتين", 2),
        });
        const planDirect2 = rDirect2.mission.plan as any;
        expect(planBound.price.reservePoints).toBe(planDirect2.price.reservePoints);

        const cardText = JSON.stringify(customerPlanView(planBound));
        expect(cardText).not.toContain("٥ شركات");

        // Control: companies_text: "" -> unsupported count is not bound, stays at model's 5
        const rControl = await replay({
          request: E2E_REQUEST,
          planning: planFlowWithRows(5),
          execution: execution(),
          answers: answers([2, 2, 2, 2, 2]) as any,
          deps: makeDeps("", 2),
        });
        const planControl = rControl.mission.plan as any;
        const compControl = planControl.stages.find((s: any) => s.key === "companies");
        expect(compControl.planned_rows).toBe(5);
      });

      // FIX2 (فزاع Gate 2 r2, P0): the managers per company («٨ مديرين») must never become the number of COMPANIES, whatever the model wrote in its titles: the span of the per-company citation is never evidence, and the cited noun must be the root entity's own (not a people noun, not a later word of a mixed root title)
      const mixedDeps = (cited: string, per: number, perText: string) => {
        const under = {
          decision: "plan",
          understanding_ar: "شركات كهروميكانيكا ومعها مديروها.",
          accepts_available: false,
          steps: [{ key: "companies", title_ar: "شركات الكهروميكانيكا وبيانات المديرين", platform: "companies", capability: COMPANIES_CAP, parent: null, deliver: true, count: { total: 5, all: false }, search_terms: ["electromechanical"] }],
          people_of_companies: { asked: true, title_ar: "الأشخاص", per_company: per, per_company_text: perText, companies_text: cited, contact_kinds: ["email", "phone"] },
        };
        const plannerModel: PlannerModel = async ({ tool }) => (tool.name === UNDERSTAND_TOOL ? { input: JSON.parse(JSON.stringify(under)), costUsd: 0.001 } : null);
        return (base: any) => ({ ...base, plannerModel });
      };
      const moneyOf = (r: any) => {
        const plan = r.mission.plan as any;
        return { companies: plan.stages.find((s: any) => s.key === "companies").planned_rows, hold: r.mission.reserved_points, max: plan.price.maxChargePoints, charged: r.mission.charged_points };
      };
      it.each([[8], [3]])("P0: a false company citation «%i مديرين» (the per-company span, a mixed root title) leaves the company target, the hold, the max charge and the settled charge EXACTLY as with an empty citation", async (per) => {
        const request = `عايز شركات مصرية في قطاع الكهروميكانيكا ومن كل شركة ${per === 8 ? "٨" : "٣"} مديرين`;
        const text = `${per === 8 ? "٨" : "٣"} مديرين`;
        const run = (cited: string) => replay({ request, planning: planFlowWithRows(5), execution: execution(), answers: answers([2, 2, 2, 2, 2]) as any, deps: mixedDeps(cited, per, text) });
        const withFalseCite = moneyOf(await run(text));
        const control = moneyOf(await run(""));
        expect(control.companies).toBe(5);
        expect(withFalseCite).toEqual(control);
      }, 180_000);
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// FIX1 (DT-20261119-05, فزاع Gate 2 P1-1 / M4 / M8a and QA's must-pass): the cited noun is the COMPANIES' own noun; the people's generic title cannot let a people word through
describe("FIX1: the cited noun must match the companies' own noun (a generic people title is not a reason to bind)", () => {
  const GENERIC = "الأشخاص";
  it.each([
    ["اتنين مديرين", "عايز شركات ومن كل شركة اتنين مديرين"],
    ["مهندسين", "عايز شركات ومن كل شركة مهندسين"],
    ["موظف", "عايز شركات ومن كل شركة موظف"],
    ["مدن", "عايز شركات ومن كل شركة مدن"],
    ["٥٠ موظف", "عايز شركات فيها ٥٠ موظف ومن كل شركة المديرين"],
  ])("people title «الأشخاص», cited «%s» -> no companies_count", (cited, message) => {
    const u = U([companiesStep], peopleAsk(true, cited, GENERIC));
    expect(withCheckedCompaniesCount(u, [message]).companies_count).toBeUndefined();
  });
  it("«شركتين» binds 2 with the generic title, with a generic companies title (the fixed label of the parent), and with no companies step at all", () => {
    expect(withCheckedCompaniesCount(U([companiesStep], peopleAsk(true, "شركتين", GENERIC)), [LIVE]).companies_count).toBe(2);
    expect(withCheckedCompaniesCount(U([{ ...companiesStep, title_ar: "النتائج" }], peopleAsk(true, "شركتين", GENERIC)), [LIVE]).companies_count).toBe(2);
    expect(withCheckedCompaniesCount(U([], peopleAsk(true, "شركتين", GENERIC), { decision: "cannot", cannot_ar: "x" }), [LIVE]).companies_count).toBe(2);
  });
  it("M4: a per-company count of 2 (even one the customer never wrote) does not block the companies' own «شركتين»; «أسوان» in the message changes nothing (the per-company guard was removed: after the noun check it only ever blocked a correct bind)", () => {
    const msg = "عايز شركتين في أسوان ومن كل شركة المديرين";
    const u = U([companiesStep], peopleAsk(true, "شركتين", "المديرين", { per_company: 2, per_company_text: "اتنين" }));
    expect(withCheckedCompaniesCount(u, [msg]).companies_count).toBe(2);
    const u2 = U([companiesStep], peopleAsk(true, "اتنين شركات", "المديرين", { per_company: 2, per_company_text: "اتنين" }));
    expect(withCheckedCompaniesCount(u2, ["عايز اتنين شركات في أسوان ومن كل شركة مدير"]).companies_count).toBe(2);
  });
  it("M8a: understoodPeopleOf carries `companies` on the STEPS path (a people STEP, no ask), and through understandRequest with a people step", async () => {
    const withStep = understoodPeopleOf([companiesStep, peopleStep], undefined, 2);
    expect(withStep).toMatchObject({ noun_ar: "الأشخاص", parent_ar: "الشركات", per_parent: 2, companies: 2 });
    expect(understoodPeopleOf([companiesStep, peopleStep], undefined)).not.toHaveProperty("companies");
    const r = await understood([planAnswer({ steps: [companiesStep, peopleStep], people_of_companies: peopleAsk(true, "شركتين", GENERIC) })]);
    if (!r.ok) throw new Error("understood failed");
    expect((r.value as any).companies_count).toBe(2);
    expect(r.people).toMatchObject({ companies: 2 });
  });
});

describe("FIX1 (QA must-pass): one people source answered with no row, another FAILED, no estimate: the honest unserved card, through the real call mapping of tools.ts", () => {
  const ALT = "blitzapi.people.employee-finder";
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-19T10:00:00Z"), shouldAdvanceTime: true }); });
  afterEach(() => { vi.useRealTimers(); });
  const flow = (): FakeStep[] => {
    const world = SECTOR_WORLD.electromechanical;
    const ccols = columnsOf(["name", "اسم الشركة"], ["activity", "القطاع"], ["city", "المدينة"], ["website", "الموقع الإلكتروني"], ["phone", "التليفون"], ["address", "العنوان"], ["linkedin", "صفحة الشركة على الشبكة المهنية"]);
    return [
      { tool: "report_progress", args: { message_ar: "أبحث عن الشركات ومسؤوليها", counts: { sources: 2 } } },
      { tool: "catalog_search", args: { words: ["companies", "search"], limit: 5 } },
      { tool: "describe_endpoint", args: { id: COMPANIES } },
      { tool: "treg_call", args: { endpoint_id: COMPANIES, params: { query: "electromechanical", page: 1 }, why } },
      { tool: "run_code", args: (r: Results) => ({ code: `return inputs.${callIds(r)[0]}.data.companies.map(r => ({ id: r.linkedin_url, name: r.name, activity: r.industry || '', city: r.city || '', website: r.website_url || '', phone: r.phone_number || '', address: r.street_address || '', linkedin: r.linkedin_url || '' }))`, files: [callIds(r)[0]] }) },
      { tool: "describe_endpoint", args: { id: PEOPLE } },
      { tool: "treg_call", args: { endpoint_id: PEOPLE, params: { company_linkedin_url: linkedinOf("orascom-em"), cascade: [{ include_title: ["Chief Executive Officer"] }], max_results: 10 }, why } },
      { tool: "treg_call", args: { endpoint_id: ALT, params: { company_linkedin_url: linkedinOf("orascom-em"), cascade: [{ include_title: ["Managing Director"] }], max_results: 10 }, why } },
      { tool: "propose_plan", args: (res: Results) => ({
        summary_ar: "ستحصل على الشركات المصرية في الكهروميكانيكا.",
        stages: [{ key: "companies", title_ar: "شركات مصرية في المعدات الكهربائية والميكانيكية", endpoint_id: COMPANIES, expected_rows: 5, parent_key: null, deliver: true, columns: ccols,
          sample_rows: [{ id: linkedinOf("orascom-em"), name: world.names[0], activity: world.industry, city: "Cairo", website: "orascom-em.com.eg", phone: PHONES[0], address: "1 Industrial Zone, Cairo", linkedin: linkedinOf("orascom-em") }], measured_by: [callIds(res)[0], firstOutputId(res)] }],
        contacts_note_ar: "لم تتوفر مصادر موثقة للإيميلات وأرقام التليفون ضمن ميزانية هذه المهمة.",
        unserved_steps: [{ reason_ar: "لم تُرجع المصادر المتاحة أسماء مديرين لهذه الشركات" }],
      }) },
    ];
  };
  const worldAnswers = (peopleFails: boolean) => Array.from({ length: 300 }, () => {
    const base = dispatcher({});
    return (o: TregCallOptions) => {
      if (o.endpointId === PEOPLE) return tregResult({ results: [] }, 0.0005);
      if (o.endpointId === ALT) { if (peopleFails) throw new Error("the provider is down"); return tregResult({ results: [] }, 0.0005); }
      return base(o);
    };
  });
  it("no planner understanding (so no estimate): the people step is declared unserved after two ATTEMPTED sources (one answered with no row, one failed): the plan is accepted with ONE unserved step and says so on the card", async () => {
    const r = await replay({ request: A1_REQUEST, planning: flow(), execution: () => [], answers: worldAnswers(true) as any });
    const plan = r.mission.plan as any;
    expect(plan.unserved_steps).toHaveLength(1);
    expect(plan.stages).toHaveLength(1);
    expect(JSON.stringify(r.planView)).toMatch(/لم تُضَف إلى الخطة/);
  }, 120_000);
});

describe("FIX2 (P0): the per-company citation is never evidence for the companies' count; the cited noun identifies the root entity", () => {
  const mixedRoot = { ...companiesStep, title_ar: "شركات الكهروميكانيكا وبيانات المديرين", count: { total: 5, per_parent: null, all: false } };
  it.each([
    ["٨ مديرين", 8, "عايز شركات مصرية في قطاع الكهروميكانيكا ومن كل شركة ٨ مديرين"],
    ["٣ مديرين", 3, "عايز شركات مصرية في قطاع الكهروميكانيكا ومن كل شركة ٣ مديرين"],
  ])("mixed root title, people title «الأشخاص», cited «%s» (also the per-company span) -> no companies_count", (cited, per, message) => {
    const u = U([mixedRoot], peopleAsk(true, cited, "الأشخاص", { per_company: per, per_company_text: cited }));
    expect(withCheckedCompaniesCount(u, [message]).companies_count).toBeUndefined();
    // (b) alone: the per-company span is not even written in the citation field of the people count
    const u2 = U([mixedRoot], peopleAsk(true, cited, "الأشخاص"));
    expect(withCheckedCompaniesCount(u2, [message]).companies_count).toBeUndefined();
  });
  it("(a) the per-company span is never evidence, even when it names the companies' noun («٣ شركات» written as the per-company text)", () => {
    const u = U([companiesStep], peopleAsk(true, "٣ شركات", "الأشخاص", { per_company: 3, per_company_text: "٣ شركات" }));
    expect(withCheckedCompaniesCount(u, ["عايز ٣ شركات ومن كل شركة مدير"]).companies_count).toBeUndefined();
  });
  it("(b) the cited noun matches the HEAD of the root title, not a later word: «٣ محافظات» with the title «شركات المحافظات الجنوبية» does not bind (it counts governorates)", () => {
    const u = U([{ ...companiesStep, title_ar: "شركات المحافظات الجنوبية" }], peopleAsk(true, "٣ محافظات", "الأشخاص"));
    expect(withCheckedCompaniesCount(u, ["عايز شركات في ٣ محافظات ومن كل شركة المديرين"]).companies_count).toBeUndefined();
  });
  it("(b) a root title that starts with a people noun: the cited people noun never binds, the companies' own noun still does through the fixed label", () => {
    const peopleFirst = { ...companiesStep, title_ar: "المديرين وشركاتهم" };
    expect(withCheckedCompaniesCount(U([peopleFirst], peopleAsk(true, "٨ مديرين", "الأشخاص")), ["عايز شركات ومن كل شركة ٨ مديرين"]).companies_count).toBeUndefined();
    expect(withCheckedCompaniesCount(U([peopleFirst], peopleAsk(true, "شركتين", "الأشخاص")), [LIVE]).companies_count).toBe(2);
  });
  it("counters: distinct spans «٣ شركات ومن كل شركة ٣ مديرين» -> 3; «شركتين» with «أسوان» in the request -> 2 (M4 stays killed); the mixed root title does not stop the real «شركتين»", () => {
    expect(withCheckedCompaniesCount(U([companiesStep], peopleAsk(true, "٣ شركات", "الأشخاص", { per_company: 3, per_company_text: "٣ مديرين" })), ["عايز ٣ شركات ومن كل شركة ٣ مديرين"]).companies_count).toBe(3);
    expect(withCheckedCompaniesCount(U([companiesStep], peopleAsk(true, "شركتين", "المديرين", { per_company: 2, per_company_text: "اتنين" })), ["عايز شركتين في أسوان ومن كل شركة المديرين"]).companies_count).toBe(2);
    expect(withCheckedCompaniesCount(U([mixedRoot], peopleAsk(true, "شركتين", "الأشخاص")), [LIVE]).companies_count).toBe(2);
  });
});
