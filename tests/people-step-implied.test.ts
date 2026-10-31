import { describe, expect, it } from "vitest";
import { loadTregCatalog, isSellable } from "../src/lib/treg/catalog";
import { blockedEndpointReason } from "../src/lib/treg/blockList";
import { DEFAULT_PEOPLE_PER_PARENT, perParentQuantities, requestedStageIndexes } from "../src/lib/agentMission/quantity";
import { childStepSourcesFor, isPeopleNoun, peopleSourcesForCompanies } from "../src/lib/agentMission/childSources";
import { validateAndPricePlan, type PlanLookup } from "../src/lib/agentMission/plan";
import { buildTools } from "../agent/src/tools";
import { assumptionLinesOf, planEditorView, type PricedPlan } from "../src/lib/agentMission/plan";
import { applyPlanEdits } from "../src/lib/agentMission/planEdit";
import { editsFromState, initialState } from "../src/components/mission/PlanEditor";
import { makeHarness } from "./helpers/agentHarness";
import { tregResult } from "./helpers/agentFakeWorld";

/**
 * LIVE INCIDENT 2026-10-31 15:46 (Cairo): «عايز ٥ شركات مصرية في قطاع الكهروميكانيكا، ومعاهم صناع القرار: اسم المدير، المسمى الوظيفي، الإيميل، ورقم التليفون» got a plan WITHOUT the decision makers: the request names people but gives no number, so
 * the per-parent check never applied and one free sentence (contacts_note_ar) dropped them; the planner's only people call was a source dearer than the planning budget, refused once, and it stopped there. Now any people noun of the companies is a STEP
 * (a default count per company, shown on the card and editable); the step is dropped only after two catalog sources were really tried; one over-budget refusal points to the cheapest people sources instead of ending the search.
 */
const OWNER = "عايز ٥ شركات مصرية في قطاع الكهروميكانيكا، ومعاهم صناع القرار: اسم المدير، المسمى الوظيفي، الإيميل، ورقم التليفون";
const catalog = loadTregCatalog();
const allowed = (id: string) => isSellable(id, catalog) && !blockedEndpointReason(id);

describe("a people noun of the companies is a step even with no number", () => {
  it("the owner's request: ONE per-company ask for the decision makers, with the default count, marked as implied", () => {
    const asks = perParentQuantities(OWNER);
    expect(asks).toHaveLength(1);
    expect(asks[0]).toMatchObject({ value: DEFAULT_PEOPLE_PER_PARENT, perEach: true, implied: true });
    expect(isPeopleNoun(asks[0].noun ?? "")).toBe(true);
  });
  it.each([
    "عايز ١٠ شركات مقاولات ومعاهم المديرين",
    "عايز ٣ شركات في مصر مع أسماء الموظفين وإيميلاتهم",
    "هات ٥ شركات بترول ومعاهم المسمى الوظيفي لصناع القرار",
  ])("%s", (text) => {
    const asks = perParentQuantities(text);
    expect(asks).toHaveLength(1);
    expect(asks[0].implied).toBe(true);
  });
  it("no people step when the request names no people, asks only for the company's own contacts, or counts people at the top", () => {
    for (const text of ["عايز ٥ شركات مصرية في قطاع البترول", "عايز ٥ شركات مقاولات وإيميلاتهم وأرقامهم", "هات ٥٠ مدير تسويق في شركات مصر", "عايز ٣٠ تغريدة عن محمد صلاح"]) expect(perParentQuantities(text), text).toEqual([]);
  });
  it("the customer's own number wins: «من كل شركة ٣ مديرين» is 3, not implied", () => {
    const asks = perParentQuantities("عايز ٥ شركات مقاولات، ومن كل شركة ٣ مديرين");
    expect(asks).toHaveLength(1);
    expect(asks[0]).toMatchObject({ value: 3, perEach: true });
    expect(asks[0].implied).toBeFalsy();
  });
  it("the people stage is one the customer asked for: it is delivered by code", () => {
    const stages = [{ index: 0, title_ar: "الشركات", parent_key: null }, { index: 1, title_ar: "صناع القرار في كل شركة", parent_key: "companies" }];
    expect([...requestedStageIndexes(OWNER, stages as never)].sort()).toEqual([0, 1]);
  });
});

describe("the plan check: the decision makers are never dropped by one sentence", () => {
  const calls = (peopleCost: number, peopleRows: number) => new Map([
    ["call_0001", { id: "call_0001", endpointId: "tomba.companies.search.reveal", ok: true, costUsd: 0.000178, rows: 50, params: { query: "electromechanical" } }],
    ["call_0002", { id: "call_0002", endpointId: "aviato.companies.employees", ok: true, costUsd: peopleCost, rows: peopleRows, params: { website: "kahromika-co.com", perPage: 2, page: 0 } }],
  ]);
  const lookupOf = (called: Array<[string, number]>, people = calls(0.001, 2)): PlanLookup => ({
    call: (id) => people.get(id) ?? null, evidenceText: () => "kahromika-co.com https://kahromika-co.com person-1 person-2", endpointAllowed: () => true, requestText: OWNER,
    childStepSources: (noun) => childStepSourcesFor(noun, catalog, allowed),
    endpointsCalled: () => new Map(called.map(([id, rows]) => [id, { rows }])),
    isContactSource: (id) => /email/i.test(id),
  });
  const companies = { key: "companies", title_ar: "الشركات المصرية في قطاع الكهروميكانيكا", endpoint_id: "tomba.companies.search.reveal", expected_rows: 5, parent_key: null, deliver: true, columns: [{ key: "name", title_ar: "اسم الشركة" }, { key: "website", title_ar: "الموقع" }, { key: "country", title_ar: "الدولة" }], sample_rows: [{ id: "kahromika-co.com", name: "KAHROMIKA", website: "https://kahromika-co.com", country: "EG" }], measured_by: ["call_0001"] };
  const people = (per: number) => ({ key: "people", title_ar: "صناع القرار في كل شركة", endpoint_id: "aviato.companies.employees", expected_rows: per * 5, parent_key: "companies", per_parent_rows: per, deliver: true, columns: [{ key: "name", title_ar: "اسم المدير" }, { key: "title", title_ar: "المسمى الوظيفي" }], sample_rows: [{ id: "person-1", name: "Example Person", title: "Director" }], measured_by: ["call_0002"] });

  it("the live plan (companies only, the managers dropped by contacts_note_ar) is REFUSED and the refusal names the sources that can serve the step", () => {
    const checked = validateAndPricePlan({ summary_ar: "٥ شركات مصرية في قطاع الكهروميكانيكا.", stages: [companies], contacts_note_ar: "لم يتح لنا تجربة مصدر لصناع القرار ضمن ميزانية هذه المهمة." }, lookupOf([]));
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.issues.join(" ")).toMatch(/CAN be served|The catalog HAS sources/);
  });
  it("the step «unserved» with one source tried (or none) is refused; two sources really tried that gave no rows allow the honest sentence, shown on the card", () => {
    const given = { summary_ar: "٥ شركات مصرية في قطاع الكهروميكانيكا.", stages: [companies], contacts_note_ar: "لم تتوفر مصادر موثقة للإيميلات وأرقام التليفون ضمن ميزانية هذه المهمة.", unserved_steps: [{ reason_ar: "لم تُرجع المصادر المتاحة أسماء مديرين لهذه الشركات" }] };
    expect(validateAndPricePlan(given, lookupOf([])).ok).toBe(false);
    expect(validateAndPricePlan(given, lookupOf([["aviato.companies.employees", 0]])).ok).toBe(false);
    const accepted = validateAndPricePlan(given, lookupOf([["aviato.companies.employees", 0], ["tomba.companies.emails.list", 0]]));
    expect(accepted.ok, JSON.stringify(accepted)).toBe(true);
  });
  it("a plan WITH the people stage is accepted whatever per-company number the model wrote: the default count is code's, the card says so and the price is under the job limit", () => {
    const checked = validateAndPricePlan({ summary_ar: "٥ شركات مصرية في قطاع الكهروميكانيكا ومعهم صناع القرار.", stages: [companies, people(1)], contacts_note_ar: "لم تتوفر مصادر موثقة للإيميلات وأرقام التليفون ضمن ميزانية هذه المهمة.", }, lookupOf([["aviato.companies.employees", 2]]));
    expect(checked.ok, JSON.stringify(checked)).toBe(true);
    if (!checked.ok) return;
    const stage = checked.plan.stages.find((s) => s.key === "people")!;
    expect(stage.per_parent_rows).toBe(DEFAULT_PEOPLE_PER_PARENT);
    expect(stage.planned_rows).toBe(5 * DEFAULT_PEOPLE_PER_PARENT);
    expect(stage.deliver).toBe(true);
    expect((checked.plan.assumptions_ar ?? []).join(" ")).toMatch(/لم تحدد عدد/);
    expect(checked.plan.price.reservePoints).toBeLessThanOrEqual(600);
    expect(checked.plan.price.deliveredRows).toBe(5 + 5 * DEFAULT_PEOPLE_PER_PARENT);
  });
  it("a plan that the default count would make dearer than 600 points gets a LOWER count from code (the job cap is never touched); the card says which count it used", () => {
    // 0.012 USD per person: 10 people do not fit under 600 points, 5 do
    const dear = calls(0.024, 2);
    const checked = validateAndPricePlan({ summary_ar: "٥ شركات مصرية في قطاع الكهروميكانيكا ومعهم صناع القرار.", stages: [companies, people(2)], contacts_note_ar: "لم تتوفر مصادر موثقة للإيميلات وأرقام التليفون ضمن ميزانية هذه المهمة.", }, lookupOf([["aviato.companies.employees", 2]], dear));
    expect(checked.ok, JSON.stringify(checked)).toBe(true);
    if (!checked.ok) return;
    const stage = checked.plan.stages.find((s) => s.key === "people")!;
    expect(stage.per_parent_rows).toBe(1);
    expect(stage.planned_rows).toBe(5);
    expect(checked.plan.price.reservePoints).toBeLessThanOrEqual(600);
    expect((checked.plan.assumptions_ar ?? []).join(" ")).toMatch(/لم تحدد عدد/);
  });
  it("a number the customer gave is never lowered by code, however dear the plan (the job cap itself is untouched)", () => {
    const dear = calls(0.024, 2);
    const own = { ...lookupOf([["aviato.companies.employees", 2]], dear), requestText: "عايز ٥ شركات مقاولات، ومن كل شركة ٥ مديرين" };
    const checked = validateAndPricePlan({ summary_ar: "٥ شركات ومعهم مديرون.", stages: [companies, people(5)] }, own);
    expect(checked.ok, JSON.stringify(checked)).toBe(true);
    if (!checked.ok) return;
    expect(checked.plan.stages.find((s) => s.key === "people")!.per_parent_rows).toBe(5);
    expect(checked.plan.price.reservePoints).toBeGreaterThan(600);
    expect((checked.plan.assumptions_ar ?? []).join(" ")).not.toMatch(/لم تحدد عدد/);
  });
});

describe("planning: one over-budget refusal does not end the search", () => {
  const tool = (h: ReturnType<typeof makeHarness>, name: string) => buildTools(h.ctx).find((t) => t.name === name)!;
  it("a people source dearer than the planning budget is refused once; the answer names the cheapest people sources and says the search goes on", async () => {
    const h = makeHarness({ budgetUsd: 0.01, mission: { request_text: OWNER }, responses: [tregResult({ data: [] }, 0)] });
    await tool(h, "catalog_search").handler({ words: ["companies", "search"], limit: 5 });
    const refused = await tool(h, "treg_call").handler({ endpoint_id: "lusha.x.buying-group", params: { companies: ["kahromika-co.com"], contactsLimit: 1 }, why: "the source for decision makers of a company" }) as any;
    expect(refused).toMatchObject({ ok: false, refused: "over_budget" });
    const cheapest = peopleSourcesForCompanies(catalog, allowed).slice(0, 3).map((p) => p.id);
    expect(refused.next_sources).toEqual(cheapest);
    expect(String(refused.next_step)).toContain("does not end the search");
  });
});

describe("the default count is on the card and the customer edits it", () => {
  const catalogCalls = new Map([
    ["call_0001", { id: "call_0001", endpointId: "tomba.companies.search.reveal", ok: true, costUsd: 0.000178, rows: 50, params: { query: "electromechanical" } }],
    ["call_0002", { id: "call_0002", endpointId: "aviato.companies.employees", ok: true, costUsd: 0.002, rows: 2, params: { website: "kahromika-co.com", perPage: 2, page: 0 } }],
  ]);
  const lookup: PlanLookup = { call: (id) => catalogCalls.get(id) ?? null, evidenceText: () => "kahromika-co.com https://kahromika-co.com person-1 person-2", endpointAllowed: () => true, requestText: OWNER, childStepSources: (noun) => childStepSourcesFor(noun, catalog, allowed), endpointsCalled: () => new Map([["aviato.companies.employees", { rows: 2 }]]), isContactSource: (id) => /email/i.test(id) };
  const stages = [
    { key: "companies", title_ar: "الشركات المصرية في قطاع الكهروميكانيكا", endpoint_id: "tomba.companies.search.reveal", expected_rows: 5, parent_key: null, deliver: true, columns: [{ key: "name", title_ar: "اسم الشركة" }, { key: "website", title_ar: "الموقع" }, { key: "country", title_ar: "الدولة" }], sample_rows: [{ id: "kahromika-co.com", name: "KAHROMIKA", website: "https://kahromika-co.com", country: "EG" }], measured_by: ["call_0001"] },
    { key: "people", title_ar: "صناع القرار في كل شركة", endpoint_id: "aviato.companies.employees", expected_rows: 10, parent_key: "companies", per_parent_rows: 2, deliver: true, columns: [{ key: "name", title_ar: "اسم المدير" }, { key: "title", title_ar: "المسمى الوظيفي" }], sample_rows: [{ id: "person-1", name: "Example Person", title: "Director" }], measured_by: ["call_0002"] },
  ];
  const plan = (): PricedPlan => {
    const checked = validateAndPricePlan({ summary_ar: "٥ شركات مصرية في قطاع الكهروميكانيكا ومعهم صناع القرار.", stages, contacts_note_ar: "لم تتوفر مصادر موثقة للإيميلات وأرقام التليفون ضمن ميزانية هذه المهمة." }, lookup);
    if (!checked.ok) throw new Error(JSON.stringify(checked));
    return checked.plan;
  };

  it("the card says the count was chosen by code, and the editor offers the count per company", () => {
    const p = plan();
    expect(assumptionLinesOf(p).join(" ")).toContain("لم تحدد عدد");
    const view = planEditorView(p);
    const row = view.stages.find((s) => s.key === "people")!;
    expect(row.per_parent).toBe(2);
    expect(view.stages.find((s) => s.key === "companies")!.per_parent).toBeUndefined();
    const state = initialState(view);
    expect(editsFromState(view, state)).toEqual({});
    state.perParent.people = "٣";
    expect(editsFromState(view, state)).toEqual({ stages: [{ key: "people", per_parent: 3 }] });
  });
  it("saving a new count per company: 5 companies x 3, priced again by code, the card's line becomes the customer's", () => {
    const p = plan();
    const r = applyPlanEdits(p, { stages: [{ key: "people", per_parent: 3 }] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const people = r.plan.stages.find((s) => s.key === "people")!;
    expect(people.per_parent_rows).toBe(3);
    expect(people.planned_rows).toBe(15);
    expect(r.plan.price.deliveredRows).toBe(20);
    expect(r.plan.price.reservePoints).toBeGreaterThanOrEqual(p.price.reservePoints);
    const lines = assumptionLinesOf(r.plan).join(" ");
    expect(lines).not.toContain("لم تحدد عدد");
    expect(lines).toContain("حسب تعديلك");
  });
  it("a count that is not a whole number from 1, or on a stage with no parent, is refused", () => {
    const p = plan();
    for (const bad of [0, -1, 2.5, 101]) expect(applyPlanEdits(p, { stages: [{ key: "people", per_parent: bad }] }).ok, String(bad)).toBe(false);
    expect(applyPlanEdits(p, { stages: [{ key: "companies", per_parent: 2 }] }).ok).toBe(false);
  });
});

describe("the price of «5 Egyptian electromechanical companies + decision makers», computed by the planner (measured costs of the live runs)", () => {
  // companies: tomba, 0.000178 USD per 50 companies (live 2026-10-31). People per person: 0.00099 (employee finder + e-mail finder, the cheapest chain measured live), 0.0035 (a middle chain), 0.0115 (the dearest measured: employee finder + a 0.011 e-mail finder)
  const OWNER_PRICES: Array<[number, number, number, number, number]> = [
    // [USD per person, people per company the plan ends with, delivered rows, hold in points, the most that can be charged]
    [0.00099, 2, 15, 202, 200],
    [0.0035, 2, 15, 361, 314],
    [0.0115, 1, 10, 503, 438],
  ];
  it.each(OWNER_PRICES)("%f USD per person: %i per company, %i items, hold %i points (never above 600), at most %i charged", (perPerson, per, rows, hold, max) => {
    const calls = new Map([
      ["call_0001", { id: "call_0001", endpointId: "tomba.companies.search.reveal", ok: true, costUsd: 0.000178, rows: 50, params: { query: "electromechanical" } }],
      ["call_0002", { id: "call_0002", endpointId: "aviato.companies.employees", ok: true, costUsd: perPerson * 2, rows: 2, params: { website: "kahromika-co.com", perPage: 2, page: 0 } }],
    ]);
    const lookup: PlanLookup = { call: (id) => calls.get(id) ?? null, evidenceText: () => "kahromika-co.com https://kahromika-co.com person-1 person-2", endpointAllowed: () => true, requestText: OWNER, childStepSources: (n) => childStepSourcesFor(n, catalog, allowed), endpointsCalled: () => new Map([["aviato.companies.employees", { rows: 2 }]]), isContactSource: (id) => /email/i.test(id) };
    const stages = [
      { key: "companies", title_ar: "الشركات المصرية في قطاع الكهروميكانيكا", endpoint_id: "tomba.companies.search.reveal", expected_rows: 5, parent_key: null, deliver: true, columns: [{ key: "name", title_ar: "اسم الشركة" }, { key: "website", title_ar: "الموقع" }, { key: "country", title_ar: "الدولة" }], sample_rows: [{ id: "kahromika-co.com", name: "KAHROMIKA", website: "https://kahromika-co.com", country: "EG" }], measured_by: ["call_0001"] },
      { key: "people", title_ar: "صناع القرار في كل شركة", endpoint_id: "aviato.companies.employees", expected_rows: 10, parent_key: "companies", per_parent_rows: 2, deliver: true, columns: [{ key: "name", title_ar: "اسم المدير" }, { key: "title", title_ar: "المسمى الوظيفي" }], sample_rows: [{ id: "person-1", name: "Example Person", title: "Director" }], measured_by: ["call_0002"] },
    ];
    const checked = validateAndPricePlan({ summary_ar: "٥ شركات مصرية في قطاع الكهروميكانيكا ومعهم صناع القرار.", stages, contacts_note_ar: "لم تتوفر مصادر موثقة للإيميلات وأرقام التليفون ضمن ميزانية هذه المهمة." }, lookup);
    expect(checked.ok, JSON.stringify(checked)).toBe(true);
    if (!checked.ok) return;
    expect(checked.plan.stages[1].per_parent_rows).toBe(per);
    expect(checked.plan.price.deliveredRows).toBe(rows);
    expect(checked.plan.price.reservePoints).toBe(hold);
    expect(checked.plan.price.maxChargePoints).toBe(max);
    expect(checked.plan.price.reservePoints).toBeLessThanOrEqual(600);
  });
});
