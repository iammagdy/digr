import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replay } from "./helpers/agentReplay";
import { COMPANIES, PEOPLE, SLUGS, columnsOf, linkedinOf, personOf, why, request } from "./helpers/a1World";
import { callIds, lastOutputId } from "./helpers/agentFakeWorld";
import { tregResult } from "./helpers/agentHarness";
import type { TregCallOptions } from "../src/functions/shared/tregClient";
import { firstOutputId } from "./helpers/agentRelevance";
import { dispatcher, PHONES, SECTOR_WORLD } from "./helpers/g1World";
import type { Results } from "./helpers/agentFakeWorld";
import { PEOPLE_ESTIMATE_MAX_USD, PEOPLE_ESTIMATE_NOTE_AR, peopleAnswersOf, peopleEstimateOf } from "../src/lib/agentMission/peopleEstimate";
import { checkCustomerText } from "../src/lib/agentMission/text";
import { validateAndPricePlan } from "../src/lib/agentMission/plan";
import { withPromiseCaps } from "../src/lib/agentMission/repliesCard";
import { applyPlanEdits } from "../src/lib/agentMission/planEdit";
import { approveMission } from "../src/lib/agentMission/lifecycle";
import { fakeMoneyClient } from "./helpers/agentMoney";
import { settlementChargeByStage, stageUnitsOf } from "../src/lib/agentMission/stageUnits";
import { unbilledLineAr } from "../src/lib/agentMission/billableRows";
import type { FakeStep } from "../agent/src/fakeDriver";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { PEOPLE_OF_COMPANY_CAPABILITIES, peopleSourcesForCompanies } from "../src/lib/agentMission/childSources";
import { capabilitiesOf } from "../agent/src/llmPlanner/catalogView";
import { UNDERSTAND_TOOL } from "../agent/src/llmPlanner/prompts";
import type { PlannerModel } from "../agent/src/llmPlanner/planner";
import { NOT_ADMIN } from "./helpers/agentHarness";

const catalog = loadTregCatalog();
const COMPANIES_CAP = [...capabilitiesOf(catalog, NOT_ADMIN, "companies")].sort().find((c) => !PEOPLE_OF_COMPANY_CAPABILITIES.has(c))!;
/** The planning model's UNDERSTANDING (scripted): companies, and the people of the companies asked for (two per company, e-mail and phone). Code acts on this answer, never on the words. */
const understanding = { decision: "plan", understanding_ar: "شركات كهروميكانيكا ومعها العاملون فيها.", accepts_available: false,
  steps: [{ key: "companies", title_ar: "شركات الكهروميكانيكا", platform: "companies", capability: COMPANIES_CAP, parent: "", deliver: true, count: { total: 5, all: false }, search_terms: ["electromechanical"] }],
  people_of_companies: { asked: true, title_ar: "العاملون", per_company: 2, per_company_text: "اتنين", companies_text: "٥", contact_kinds: ["email", "phone"] } };
const plannerModel: PlannerModel = async ({ tool }) => (tool.name === UNDERSTAND_TOOL ? { input: JSON.parse(JSON.stringify(understanding)), costUsd: 0.001 } : null);
const withUnderstanding = (base: any) => ({ ...base, plannerModel });

const ALT = "blitzapi.people.employee-finder";
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-19T10:00:00Z"), shouldAdvanceTime: true }); });
afterEach(() => { vi.useRealTimers(); });

/** g1 where the people source of the sample ANSWERS EMPTY and the plan carries the people stage priced by an estimate (the stage reads another source of the table). */
function planFlow(peopleEndpoint: string = ALT, peopleCalls: "empty" | "rows" = "empty", o: { invented?: boolean; second?: string } = {}): FakeStep[] {
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
    ...(o.second ? [{ tool: "treg_call", args: { endpoint_id: o.second, params: { company_linkedin_url: linkedinOf("orascom-em"), cascade: [{ include_title: ["Chief Executive Officer", "Managing Director"] }], max_results: 10 }, why } } as FakeStep] : []),
    { tool: "propose_plan", args: (res: Results) => ({
      summary_ar: "ستحصل على ٥ شركات مصرية في الكهروميكانيكا، ومع كل شركة اثنين من العاملين فيها بالاسم والمسمى الوظيفي وصفحتهم المهنية.",
      stages: [
        { key: "companies", title_ar: "شركات مصرية في المعدات الكهربائية والميكانيكية", endpoint_id: COMPANIES, expected_rows: 5, parent_key: null, deliver: true, columns: ccols,
          sample_rows: [{ id: linkedinOf("orascom-em"), name: world.names[0], activity: world.industry, city: "Cairo", website: "orascom-em.com.eg", phone: PHONES[0], address: "1 Industrial Zone, Cairo", linkedin: linkedinOf("orascom-em") }], measured_by: [callIds(res)[0], firstOutputId(res)] },
        { key: "people", title_ar: "موظفو كل شركة", endpoint_id: peopleEndpoint, expected_rows: 10, parent_key: "companies", per_parent_rows: 2, deliver: true, columns: pcols, measured_by: peopleCalls === "empty" ? [] : [callIds(res)[1]], ...(o.invented ? { sample_rows: [{ id: "https://www.linkedin.example/in/invented", full_name: "Invented Person", job_title: "CEO", company: "x", linkedin: "https://www.linkedin.example/in/invented", email: "", phone: "" }] } : {}) },
      ],
    }) },
  ];
}
const person = (slug: (typeof SLUGS)[number], j: number) => personOf(slug, j, "Managing Director");
/** The provider's answers: the people source of the sample answers EMPTY; the source the estimated stage reads gives `counts[i]` people for company i; everything else as in the g1 world. */
let finderSeq = 0;
const firstSeen = new Map<string, string>();
const answers = (counts: number[] = [2, 2, 2, 2, 2], hasContact: (slug: string, first: boolean) => boolean = () => true) => Array.from({ length: 300 }, () => {
  const base = dispatcher({});
  return (o: TregCallOptions) => {
    if (o.endpointId === PEOPLE) return tregResult({ results: [] }, 0.0005);
    if (o.endpointId === ALT) { const i = SLUGS.findIndex((x) => JSON.stringify(o.params ?? {}).includes(x)); return tregResult({ results: Array.from({ length: i >= 0 ? counts[i] : 0 }, (_, j) => person(SLUGS[i], j)) }, 0.0005); }
    // D-0117 (DT-20261119-06 B): a person is CHARGED only if a contact the customer asked for reached the file. These worlds test the per-stage settlement arithmetic, so every person's e-mail finder answers with ONE distinct address (nothing in the assertions below changes)
    const capability = catalog.byId.get(o.endpointId)?.capability ?? "";
    if (capability === "people.email.find") {
      const at = /in\/([a-z]+-em)-(\d)/.exec(JSON.stringify(o.params ?? {}));
      if (at && !firstSeen.has(at[1])) firstSeen.set(at[1], at[2]);
      if (!at || !hasContact(at[1], firstSeen.get(at[1]) === at[2])) return base(o);
      return tregResult({ email: `person${(finderSeq += 1)}@orascom-em.com.eg` }, 0);
    }
    return base(o);
  };
});
/** The execution of the model-carried mission (an estimated stage has no recipe, so the model carries every stage): companies, then the people of each company through the estimate's source, saved stage by stage. */
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
const world = (counts: number[]) => replay({ request, planning: planFlow(), execution: execution(), answers: answers(counts) as any, deps: withUnderstanding });

const money = (r: any) => ({ names: r.money.calls.map((c: any) => c.name) as string[], ledger: r.money.ledger as Array<{ type: string; delta: number }> });
const planOf = (r: any) => r.mission.plan as any;

describe("the people stage priced by an estimate: the card", () => {
  it("the sample's people source answered EMPTY (code reads the calls of this planning): the plan reaches a card whose people stage is estimated, priced from the table, with no sample rows, and says so in the code's own words", async () => {
    const r = await world([2, 2, 2, 2, 2]);
    const plan = planOf(r);
    const people = plan.stages.find((s: any) => s.key === "people");
    expect(people).toMatchObject({ estimated: true, planned_rows: 10, measured_by: [], measured_from_calls: [], sample_rows: [] });
    // the estimate: the dearest of the next three sources of the table after the one that answered empty (0.0005001 USD), exactly as peopleEstimate.ts derives it from the catalog
    expect(people.measured_cost_per_row_usd).toBeCloseTo(0.0005001, 6);
    expect(plan.stages.find((s: any) => s.key === "companies").estimated).toBeUndefined();
    expect(plan.assumptions_ar).toContain(PEOPLE_ESTIMATE_NOTE_AR);
    expect(r.planView.assumptionsAr).toContain(PEOPLE_ESTIMATE_NOTE_AR);
    expect(checkCustomerText(PEOPLE_ESTIMATE_NOTE_AR, { maxChars: 400 }).issues).toEqual([]);
    expect(JSON.stringify(r.planView)).not.toMatch(/blitzapi|aviato|waterfall|employee-finder/i);
    expect(stageUnitsOf(plan)).toMatchObject({ rows: { base: 5, estimated: 10 } });
  }, 120_000);
  it("T6/C2: a people source that FAILED, was never tried, or GAVE a person: no estimate (the measured path or the honest end, unchanged); the stage that cites no call is refused with the way out", async () => {
    // the sample gave a person: the people source of the sample is measured, no estimate is offered and a stage with no call is refused
    const rows = await replay({ request, planning: planFlow(ALT, "empty"), execution: () => [], deps: withUnderstanding,
      answers: Array.from({ length: 50 }, () => (o: TregCallOptions) => (o.endpointId === PEOPLE ? tregResult({ results: [person("orascom-em", 0)] }, 0.0005) : dispatcher({})(o))) as any }).catch((e: Error) => e);
    expect(rows).not.toBeInstanceOf(Error);
    const peopleStage = planOf(rows).stages.find((x: any) => x.key === "people");
    expect(peopleStage).toBeDefined();
    expect(peopleStage.estimated).toBeFalsy();
    expect(peopleStage.measured_by.length).toBeGreaterThan(0);
  }, 120_000);
  it("(d) a people source that FAILED in the sample is not an answer: no estimate, no card, the stage that cites no call is refused (DT-09 F2 unchanged)", async () => {
    const r = await replay({ request, planning: planFlow(ALT, "empty"), execution: () => [], deps: withUnderstanding,
      answers: Array.from({ length: 50 }, () => (o: TregCallOptions) => { if (o.endpointId === PEOPLE) throw new Error("the provider is down"); return dispatcher({})(o); }) as any }).catch((e: Error) => e);
    expect(r).toBeInstanceOf(Error);
    expect((r as Error).message).toMatch(/stage «people»: measured_by must cite the calls that measured it/);
    expect((r as Error).message).not.toMatch(/answered empty: a PEOPLE stage may be given/);
  }, 120_000);
  it("a stage that reads a source OUTSIDE the table (the one that answered empty, or any other) is refused; rows the model invented for an estimated stage never reach the card", async () => {
    const outside = await replay({ request, planning: planFlow(PEOPLE, "empty"), execution: () => [], deps: withUnderstanding, answers: answers() as any }).catch((e: Error) => e);
    expect(outside).toBeInstanceOf(Error);
    expect((outside as Error).message).toMatch(/measured_by must cite the calls that measured it.*a PEOPLE stage may be given with measured_by \[\]/);
    const invented = await replay({ request, planning: planFlow(ALT, "empty", { invented: true }), execution: () => [], deps: withUnderstanding, answers: answers() as any });
    const people = planOf(invented).stages.find((x: any) => x.key === "people");
    expect(people.estimated).toBe(true);
    expect(people.sample_rows).toEqual([]);
    expect(JSON.stringify(invented.planView)).not.toMatch(/Invented/);
  }, 120_000);
  it("one source gave a person while another answered empty: the people sample is MEASURED, so no estimate is offered (the stage with no call is refused)", async () => {
    const r = await replay({ request, planning: planFlow("aviato.companies.founders", "empty", { second: ALT }), execution: () => [], deps: withUnderstanding,
      answers: Array.from({ length: 50 }, () => (o: TregCallOptions) => (o.endpointId === PEOPLE ? tregResult({ results: [person("orascom-em", 0)] }, 0.0005) : o.endpointId === ALT ? tregResult({ results: [] }, 0.0005) : dispatcher({})(o))) as any }).catch((e: Error) => e);
    expect(r).not.toBeInstanceOf(Error);
    const peopleStage = planOf(r).stages.find((x: any) => x.key === "people");
    expect(peopleStage).toBeDefined();
    expect(peopleStage.estimated).toBeFalsy();
    expect(peopleStage.measured_by.length).toBeGreaterThan(0);
  }, 120_000);
  it("C1: without the planner's understanding of the people of the companies (the structure it read, never the wording) no estimate is offered, whatever the sample says", async () => {
    const r = await replay({ request, planning: planFlow(), execution: () => [], answers: answers() as any }).catch((e: Error) => e);
    expect(r).toBeInstanceOf(Error);
    expect((r as Error).message).toMatch(/stage «people»: measured_by must cite the calls that measured it/);
    expect((r as Error).message).not.toMatch(/a PEOPLE stage may be given with measured_by \[\]/);
  }, 120_000);
  it("what code counts as an ANSWER of a people source: ok with no rows, or empty; a failed or refused call is not one; one source that gave a row ends the estimate", () => {
    const ids = new Set(["p.a", "p.b"]);
    expect(peopleAnswersOf([{ endpoint_id: "p.a", status: "empty", rows_returned: 0 }], ids)).toEqual({ answeredEmpty: new Set(["p.a"]), gaveRows: false });
    expect(peopleAnswersOf([{ endpoint_id: "p.a", status: "ok", rows_returned: 0 }], ids).answeredEmpty).toEqual(new Set(["p.a"]));
    expect(peopleAnswersOf([{ endpoint_id: "p.a", status: "failed", rows_returned: null }, { endpoint_id: "p.b", status: "refused", rows_returned: null }], ids)).toEqual({ answeredEmpty: new Set(), gaveRows: false });
    expect(peopleAnswersOf([{ endpoint_id: "p.a", status: "empty", rows_returned: 0 }, { endpoint_id: "p.b", status: "ok", rows_returned: 3 }], ids).gaveRows).toBe(true);
    expect(peopleAnswersOf([{ endpoint_id: "c.x", status: "ok", rows_returned: 5 }], ids)).toEqual({ answeredEmpty: new Set(), gaveRows: false });
  });
  it("the table: the real catalog's people sources ranked as the planner ranks them, those above 0.02 USD per person left out, the estimate the dearest of the next three not tried empty (T1-T4)", () => {
    const ranked = peopleSourcesForCompanies(catalog, () => true);
    const ids = ranked.map((x) => x.id);
    const e0 = peopleEstimateOf(ranked, new Set())!;
    expect(e0.endpointIds.length).toBe(13);
    expect(e0.endpointIds).toEqual(ids.slice(0, 13));
    expect(ids.slice(13).every((id) => ranked.find((x) => x.id === id)!.effectiveUsd > PEOPLE_ESTIMATE_MAX_USD)).toBe(true);
    expect(e0.ceilingPersonUsd).toBeCloseTo(0.0196, 6);
    // 0 / 1 / 3 / 5 sources tried empty: the estimate follows the next three (USD per person)
    expect(peopleEstimateOf(ranked, new Set(ids.slice(0, 0)))!.costPerPersonUsd).toBeCloseTo(0.000495, 6);
    expect(peopleEstimateOf(ranked, new Set(ids.slice(0, 1)))!.costPerPersonUsd).toBeCloseTo(0.0005001, 6);
    expect(peopleEstimateOf(ranked, new Set(ids.slice(0, 3)))!.costPerPersonUsd).toBeCloseTo(0.002, 6);
    expect(peopleEstimateOf(ranked, new Set(ids.slice(0, 5)))!.costPerPersonUsd).toBeCloseTo(0.0063647, 6);
    // every source of the table tried empty (or none left under the ceiling): no estimate, no card
    expect(peopleEstimateOf(ranked, new Set(ids.slice(0, 13)))).toBeNull();
    expect(peopleEstimateOf(ranked.slice(13), new Set())).toBeNull();
    expect(peopleEstimateOf([], new Set())).toBeNull();
    // a source tried empty is never the endpoint of the estimated stage
    expect(peopleEstimateOf(ranked, new Set([ids[0]]))!.endpointIds).not.toContain(ids[0]);
  });
  it("the estimate is never offered without the planner's understanding of the people of the companies, to a stage that reads a source outside the table, or to a stage with parent none", () => {
    const base = { stages: [{ key: "companies", title_ar: "شركات", endpoint_id: COMPANIES, expected_rows: 5, parent_key: null, deliver: true, columns: [{ key: "name", title_ar: "الاسم" }], sample_rows: [], measured_by: [] }] };
    const r = validateAndPricePlan({ summary_ar: "ستحصل على شركات.", stages: base.stages } as any, { call: () => null, evidenceText: () => null, endpointAllowed: () => true, peopleEstimate: { endpointIds: [COMPANIES], costPerPersonUsd: 0.001, ceilingPersonUsd: 0.0196 } });
    expect(r.ok).toBe(false);
  });
});

describe("the money end to end: approve -> a model-carried run -> settle per stage, on the money fake (the SQL's rules)", () => {
  // the plan the customer approved: 5 companies + 10 people, hold 2,554, today's blended unit 148.002371, the card's full charge 2,221
  it("(a) every person delivered: charged EXACTLY the card's full charge 2,221, the rest of the hold released; the per-stage function settled, the one-unit function never", async () => {
    const r = await world([2, 2, 2, 2, 2]);
    const m: any = r.mission;
    expect(m).toMatchObject({ status: "completed", delivered_units: 15, charged_points: 2221, reserved_points: 2554, unit_price_points: 148.002371 });
    expect(m.error ?? null).toBeNull();
    expect(planOf(r).price).toMatchObject({ maxChargePoints: 2221, reservePoints: 2554 });
    const x = money(r);
    expect(x.names.filter((n) => n === "settle_job_by_stage_atomic").length).toBe(2); // the approval's probe + the settlement
    expect(x.names).not.toContain("settle_job_atomic");
    expect(x.names.indexOf("settle_job_by_stage_atomic")).toBeLessThan(x.names.indexOf("create_quote_atomic"));
    expect(x.ledger.find((l) => l.type === "charge")!.delta).toBe(-2221);
    expect(x.ledger.find((l) => l.type === "release")!.delta).toBe(2554);
    expect(r.money.balance()).toBe(r.initialBalance - 2221);
  }, 120_000);
  it("(b) NO person delivered: the customer pays the companies at their own unit only (today's rule would charge 5 x 148.002371 = 741), the rest is released, and the customer is told what was charged", async () => {
    const r = await world([0, 0, 0, 0, 0]);
    const m: any = r.mission;
    const units = stageUnitsOf(planOf(r))!;
    expect(units.base * 5).toBeLessThan(741);
    expect(m).toMatchObject({ status: "completed", delivered_units: 5, charged_points: 373 });
    expect(m.error ?? null).toBeNull();
    expect(r.money.balance()).toBe(r.initialBalance - 373);
    expect(money(r).names).not.toContain("settle_job_atomic");
    expect(r.finalView.resultSummaryAr).toMatch(/لم يُخصم إلا مقابل ما سُلّم/);
  }, 120_000);
  it("(c) some people: 2 companies with 2 people, 3 with none: the 5 companies at their unit + the 4 people at theirs (today's rule: 9 x 148.002371 = 1,333)", async () => {
    const r = await world([2, 2, 0, 0, 0]);
    expect(r.mission).toMatchObject({ status: "completed", delivered_units: 9, charged_points: 1112 });
    expect(r.money.balance()).toBe(r.initialBalance - 1112);
  }, 120_000);
  // D-0117 (DT-20261119-06 PART B): the people WITHOUT a requested contact are delivered but not charged, on the per-stage path too: the estimated group's count loses them, the companies' count is untouched, the charge is the lower-of of the billable counts (never above today's)
  it("(e) D-0117: all 10 people delivered, only the first person of three companies carries a contact: the per-stage function settles 5 companies + 3 people (not 10), the charge is the lower-of of those counts, the file keeps every person, the customer is told 7 were not charged", async () => {
    firstSeen.clear();
    const r = await replay({ request, planning: planFlow(), execution: execution(), answers: answers([2, 2, 2, 2, 2], (slug, first) => first && ["orascom-em", "nile-em", "delta-em"].includes(slug)) as any, deps: withUnderstanding });
    const m: any = r.mission;
    const units = stageUnitsOf(planOf(r))!;
    const expected = settlementChargeByStage({ base: 5, estimated: 3 }, units, 148.002371, 2554);
    expect(expected).toBeLessThan(2221);
    expect(m).toMatchObject({ status: "completed", delivered_units: 15, charged_points: expected, reserved_points: 2554 });
    const settle = [...r.money.calls].reverse().find((c) => c.name === "settle_job_by_stage_atomic")!;
    expect((settle.args as any).p_units).toEqual({ base: 5, estimated: 3 });
    expect(money(r).names).not.toContain("settle_job_atomic");
    expect(r.money.balance()).toBe(r.initialBalance - expected);
    expect(JSON.parse((await r.store.getFile(r.missionId, "rows/people.json"))!)).toHaveLength(10);
    expect(r.store.events.some((e) => e.kind === "result" && e.message_ar === unbilledLineAr(7, ["email", "phone"]))).toBe(true);
  }, 120_000);
  it("the units come from the plan the customer APPROVED even when the run widens a stage (an open people stage: the run's own copy of the plan raises its planned rows to what the job may deliver): the charge of 5 companies + 4 people stays 1,112", async () => {
    const r = await replay({ request, planning: planFlow(), execution: execution(), answers: answers([2, 2, 0, 0, 0]) as any, deps: withUnderstanding,
      // the same people stage, now «every person of each company» (children_open, 4 per company): the price inputs are untouched, so the approval still prices the same card
      beforeApproval: async ({ store, missionId }) => {
        const m: any = store.missions.get(missionId);
        const plan = { ...m.plan, stages: m.plan.stages.map((st: any) => (st.key === "people" ? { ...st, children_open: true, per_parent_rows: 4 } : st)) };
        await store.updateMission(missionId, { plan });
      } });
    const m: any = r.mission;
    expect(m).toMatchObject({ status: "completed", delivered_units: 9, charged_points: 1112 });
    // the database charges from the prices of the accepted quote; the run's own expectation (from the APPROVED plan's units) must equal it, or the mission is flagged «charge X differs from the expected Y» for the admin
    expect(m.error ?? null).toBeNull();
    expect(money(r).names).not.toContain("settle_job_atomic");
    // the run's copy of the plan really was wider than the approved one (the premise of this test)
    expect(withPromiseCaps(planOf(r)).stages.find((x: any) => x.key === "people").planned_rows).toBeGreaterThan(10);
  }, 120_000);
  it("the settlement of the approved plan, not of the plan as the run reports it: the run lowers the people stage's planned rows to what it delivered, and the units still come from what the customer approved", async () => {
    const r = await world([0, 0, 0, 0, 0]);
    // after the run the stored plan's people rows are what was delivered (0), so units from THAT plan would not exist; the charge above was settled per stage all the same
    expect(money(r).names.filter((n) => n === "settle_job_by_stage_atomic").length).toBe(2);
    expect((r.mission as any).charged_points).toBe(373);
  }, 120_000);
});

describe("the plan editor on an estimated plan (Gate 1 P2-1): the flag stays, both prices follow the new counts, the approval of the edited card works", () => {
  it("fewer people per company, then fewer companies: still estimated, units re-derived by code (the people's unit follows the new number of people), the edited plan approves and settles per stage", async () => {
    const r = await replay({ request, planning: planFlow(), execution: () => [], answers: answers() as any, deps: withUnderstanding });
    const plan = planOf(r);
    const perParent = applyPlanEdits(plan, { stages: [{ key: "people", per_parent: 1 }] });
    expect(perParent.ok).toBe(true);
    if (!perParent.ok) return;
    const p1 = perParent.plan as any;
    expect(p1.stages.find((x: any) => x.key === "people")).toMatchObject({ estimated: true, planned_rows: 5, per_parent_rows: 1 });
    const u1 = stageUnitsOf(p1)!;
    expect(u1.rows).toEqual({ base: 5, estimated: 5 });
    expect(u1.base).toBe(stageUnitsOf(plan)!.base); // the companies' own unit does not move when the people's number does
    // fewer companies: both groups shrink together, the flag survives
    const fewer = applyPlanEdits(p1, { count: 3 });
    expect(fewer.ok).toBe(true);
    if (!fewer.ok) return;
    const p2 = fewer.plan as any;
    expect(p2.stages.find((x: any) => x.key === "people").estimated).toBe(true);
    expect(stageUnitsOf(p2)!.rows).toEqual({ base: 3, estimated: 3 });
    for (const edited of [p1, p2]) {
      const bank = fakeMoneyClient({ balance: 100_000 });
      const approved = await approveMission(bank.client, { id: "m_edit", user_id: "u1", plan: edited });
      expect(approved.ok).toBe(true);
      const item = bank.calls.find((c) => c.name === "create_quote_atomic")!.args.p_items[0];
      expect(item.stageRowsPlanned).toEqual(stageUnitsOf(edited)!.rows);
      expect(item.stageUnitsPoints).toEqual({ base: stageUnitsOf(edited)!.base, estimated: stageUnitsOf(edited)!.estimated });
    }
  }, 120_000);
});
