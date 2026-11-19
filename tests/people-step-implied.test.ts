import { finderSourcesOf } from "../src/lib/agentMission/contactFinders";
import { describe, expect, it } from "vitest";
import { loadTregCatalog, isSellable } from "../src/lib/treg/catalog";
import { blockedEndpointReason } from "../src/lib/treg/blockList";
import { DEFAULT_PEOPLE_PER_PARENT, perParentQuantities, requestedStageIndexes } from "../src/lib/agentMission/quantity";
import { childStepSourcesFor, isPeopleNoun, peopleSourcesForCompanies } from "../src/lib/agentMission/childSources";
import { validateAndPricePlan, type PlanLookup } from "../src/lib/agentMission/plan";
import { buildTools } from "../agent/src/tools";
import { assumptionLinesOf, customerPlanView, planEditorView, type PricedPlan } from "../src/lib/agentMission/plan";
import { applyPlanEdits } from "../src/lib/agentMission/planEdit";
import { editsFromState, initialState } from "../src/components/mission/PlanEditor";
import { makeHarness } from "./helpers/agentHarness";
import { tregResult } from "./helpers/agentFakeWorld";
import { priceMissionByCode } from "../src/lib/agentMission/price";
import { stagePriceInputs } from "../src/lib/agentMission/plan";
const readingAlone = (plan: { stages: any[]; price: { settings?: any } }): number => priceMissionByCode(stagePriceInputs(plan.stages, undefined, { withoutDepth: true }), { settings: plan.price.settings }).reservePoints;

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

  // DT-20261118-05 (live: «هات لي شركتين مقاولات في القاهرة ومسؤولي الإدارة فيها بأرقامهم وإيميلاتهم» got ONE stage and «the people are unavailable»): the people of the companies are a step because the PLANNER UNDERSTOOD them, whatever the wording
  // (a count written in words, a title no list knows); the check never reads the customer's words for it
  describe.each([
    ["شركتين + مسؤولي الإدارة", "هات لي شركتين مقاولات في القاهرة ومسؤولي الإدارة فيها بأرقامهم وإيميلاتهم", "مسؤولي الإدارة"],
    ["شركتين + الإدارة العليا", "هات لي شركتين مقاولات في القاهرة مع الإدارة العليا بأرقامهم وإيميلاتهم", "الإدارة العليا"],
    ["٢ شركات + الإدارة العليا", "هات لي ٢ شركات مقاولات في القاهرة مع الإدارة العليا بأرقامهم وإيميلاتهم", "الإدارة العليا"],
  ])("understood people step: %s", (_n, request, noun) => {
    const structured = (): PlanLookup => ({ ...lookupOf([]), requestText: request, endpointCapability: (id: string) => catalog.byId.get(id)?.capability ?? null, understoodPeople: { noun_ar: noun, parent_ar: "الشركات", per_parent: null }, childStepSources: () => peopleSourcesForCompanies(catalog, allowed) });
    it("a plan of the companies only, with the excuse note, is REFUSED and names the sources that can serve the step", () => {
      const checked = validateAndPricePlan({ summary_ar: "شركتان مقاولات في القاهرة.", stages: [{ ...companies, expected_rows: 2 }], contacts_note_ar: "لم يتح لنا تجربة مصدر لصناع القرار ضمن ميزانية هذه المهمة." }, structured());
      expect(checked.ok).toBe(false);
      if (!checked.ok) expect(checked.issues.join(" ")).toMatch(/CAN be served|The catalog HAS sources/);
    });
    // DT-20261118-05 P2: the model's «unavailable» is never trusted by itself: the catalog is asked whether finders exist for what the customer asked
    it("P2: the excuse note is refused by itself when the catalog has finders for the people's e-mails and phones", () => {
      const checked = validateAndPricePlan({ summary_ar: "شركتان مقاولات في القاهرة.", stages: [{ ...companies, expected_rows: 2 }], contacts_note_ar: "لم يتح لنا تجربة مصدر لصناع القرار ضمن ميزانية هذه المهمة." }, { ...structured(), contactFinders: (kind: "email" | "phone") => finderSourcesOf(kind, catalog, allowed) });
      expect(checked.ok).toBe(false);
      if (!checked.ok) expect(checked.issues.join(" ")).toContain("the note is not a reason");
    });
    it("a plan with the people stage is accepted, the stage is delivered and the e-mail and phone finder steps are added by code, even when its title names no known people word", () => {
      const checked = validateAndPricePlan({ summary_ar: "شركتان ومعهما الإدارة العليا.", stages: [{ ...companies, expected_rows: 2 }, { ...people(2), title_ar: `${noun} في كل شركة`, expected_rows: 4 }] }, { ...structured(), endpointsCalled: () => new Map([["aviato.companies.employees", { rows: 2 }]]) });
      expect(checked.ok, JSON.stringify(checked)).toBe(true);
      if (!checked.ok) return;
      expect(checked.plan.stages.find((s) => s.key === "people")!.deliver).toBe(true);
      expect((checked.plan.contact_steps ?? []).filter((c) => c.level === undefined).map((c) => c.kind).sort()).toEqual(["email", "phone"]);
    });
  });
  it("the live plan (companies only, the managers dropped by contacts_note_ar) is REFUSED and the refusal names the sources that can serve the step", () => {
    const checked = validateAndPricePlan({ summary_ar: "٥ شركات مصرية في قطاع الكهروميكانيكا.", stages: [companies], contacts_note_ar: "لم يتح لنا تجربة مصدر لصناع القرار ضمن ميزانية هذه المهمة." }, lookupOf([]));
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.issues.join(" ")).toMatch(/CAN be served|The catalog HAS sources/);
  });
  it("the step «unserved» with one source tried (or none) is refused; two sources really tried that gave no rows allow the honest sentence, shown on the card", () => {
    const given = { summary_ar: "٥ شركات مصرية في قطاع الكهروميكانيكا.", stages: [companies], contacts_note_ar: "لم تتوفر مصادر موثقة للإيميلات وأرقام التليفون ضمن ميزانية هذه المهمة.", unserved_steps: [{ reason_ar: "لم تُرجع المصادر المتاحة أسماء مديرين لهذه الشركات" }] };
    expect(validateAndPricePlan(given, lookupOf([])).ok).toBe(false);
    expect(validateAndPricePlan(given, lookupOf([["aviato.companies.employees", 0]])).ok).toBe(false);
    const accepted = validateAndPricePlan(given, lookupOf([["aviato.companies.employees", 0], ["limadata.people.employees.search", 0]]));
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
  // CHANGED (DT-20261118-03 O-1, Megz D-0082 «في كل شركه مديرين»): the default count is no longer lowered for the price of the reading; only the job cap lowers it (before: 1 per company, 5 people)
  it("a plan whose reading alone is dearer than 600 points KEEPS the default count of 2 (only the job cap lowers it); the card says which count it used", () => {
    // 0.012 USD per person: the reading of 10 people is above 600 points
    const dear = calls(0.024, 2);
    const checked = validateAndPricePlan({ summary_ar: "٥ شركات مصرية في قطاع الكهروميكانيكا ومعهم صناع القرار.", stages: [companies, people(2)], contacts_note_ar: "لم تتوفر مصادر موثقة للإيميلات وأرقام التليفون ضمن ميزانية هذه المهمة.", }, lookupOf([["aviato.companies.employees", 2]], dear));
    expect(checked.ok, JSON.stringify(checked)).toBe(true);
    if (!checked.ok) return;
    const stage = checked.plan.stages.find((s) => s.key === "people")!;
    expect(stage.per_parent_rows).toBe(2);
    expect(stage.planned_rows).toBe(10);
    expect(readingAlone(checked.plan)).toBeGreaterThan(600);
    expect((checked.plan.assumptions_ar ?? []).join(" ")).toMatch(/لم تحدد عدد/);
  });
  // QA wave-1 FAIL #570: the card line is pinned word for word, as the customer sees it (customerPlanView), cheap and dear alike
  it("the card says, word for word, the count code used for the people the customer did not count: «فاعتمدنا ٢», also when the reading is dear", () => {
    const LINE = "لم تحدد عدد صناع القرار لكل شركة، فاعتمدنا ٢؛ تقدر تغيّره من «عدّل الطلب».";
    for (const people_calls of [calls(0.001, 2), calls(0.024, 2)]) {
      const checked = validateAndPricePlan({ summary_ar: "٥ شركات مصرية في قطاع الكهروميكانيكا ومعهم صناع القرار.", stages: [companies, people(1)], contacts_note_ar: "لم تتوفر مصادر موثقة للإيميلات وأرقام التليفون ضمن ميزانية هذه المهمة.", }, lookupOf([["aviato.companies.employees", 2]], people_calls));
      expect(checked.ok, JSON.stringify(checked)).toBe(true);
      if (!checked.ok) return;
      const card = customerPlanView(checked.plan).assumptions_ar ?? [];
      expect(card).toContain(LINE);
      expect(card.filter((l) => l.startsWith("لم تحدد عدد"))).toEqual([LINE]);
    }
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

  // DT-20261119-05: T2 (1-10) companies count binding and estimate protection from «unserved»
  describe("DT-20261119-05: companies count binding and estimate protection", () => {
    const LIVE = "عايز شركتين صغيرتين ومن كل شركة المديرين وإيميل وتليفون كل مدير";
    const handed = (c?: number): PlanLookup => ({
      ...lookupOf([["aviato.companies.employees", 2]]),
      noRelevance: true,
      requestText: LIVE,
      endpointCapability: (id) => catalog.byId.get(id)?.capability ?? null,
      understoodPeople: { noun_ar: "الأشخاص", parent_ar: "الشركات", per_parent: null, ...(c ? { companies: c } : {}) },
      childStepSources: () => peopleSourcesForCompanies(catalog, allowed),
    });

    // F1
    it("1) companies expected_rows 8 + people, handed(2): ok, companies planned_rows 2, people planned_rows = 2 * per_parent_rows, deliveredRows consistent, reserve below the handed() run's; control handed(): companies planned_rows 8", () => {
      const comp8 = { ...companies, expected_rows: 8 };
      const ppl = people(2);
      const r2 = validateAndPricePlan({ summary_ar: "شركتان", stages: [comp8, ppl] }, handed(2));
      expect(r2.ok, JSON.stringify(r2)).toBe(true);
      if (!r2.ok) return;
      const cStage = r2.plan.stages.find((s) => s.key === "companies")!;
      const pStage = r2.plan.stages.find((s) => s.key === "people")!;
      expect(cStage.planned_rows).toBe(2);
      expect(pStage.planned_rows).toBe(2 * (pStage.per_parent_rows ?? 2));
      expect(r2.plan.price.deliveredRows).toBe(cStage.planned_rows + pStage.planned_rows);

      const rControl = validateAndPricePlan({ summary_ar: "شركات", stages: [comp8, ppl] }, handed());
      expect(rControl.ok, JSON.stringify(rControl)).toBe(true);
      if (!rControl.ok) return;
      expect(rControl.plan.stages.find((s) => s.key === "companies")!.planned_rows).toBe(8);
      expect(r2.plan.price.reservePoints).toBeLessThan(rControl.plan.price.reservePoints);
    });

    it("2) counter a: requestText «عايز ٥ شركات ومن كل شركة المديرين», expected_rows 8, handed(2) -> 5", () => {
      const lookup = { ...handed(2), requestText: "عايز ٥ شركات ومن كل شركة المديرين" };
      const r = validateAndPricePlan({ summary_ar: "٥ شركات", stages: [{ ...companies, expected_rows: 8 }, people(2)] }, lookup);
      expect(r.ok, JSON.stringify(r)).toBe(true);
      if (!r.ok) return;
      expect(r.plan.stages.find((s) => s.key === "companies")!.planned_rows).toBe(5);
    });

    it("3) live card shape: [companies expected_rows 8] + unserved_steps with two attempted calls of rows 0, handed(2) -> ok, planned_rows 2, 1 unserved", () => {
      const given = {
        summary_ar: "شركتان",
        stages: [{ ...companies, expected_rows: 8 }],
        contacts_note_ar: "لم تتوفر مصادر موثقة للإيميلات وأرقام التليفون ضمن ميزانية هذه المهمة.",
        unserved_steps: [{ reason_ar: "لم ترجع المصادر نتائج" }],
      };
      const lookup = {
        ...handed(2),
        endpointsCalled: () => new Map([["aviato.companies.employees", { rows: 0 }], ["blitzapi.people.employee-finder", { rows: 0 }]]),
      };
      const r = validateAndPricePlan(given, lookup);
      expect(r.ok, JSON.stringify(r)).toBe(true);
      if (!r.ok) return;
      expect(r.plan.stages.find((s) => s.key === "companies")!.planned_rows).toBe(2);
      expect(r.plan.unserved_steps).toHaveLength(1);
    });

    it("4) counter e: expected_rows 1 + valid target_reason_ar (no number), handed(2) -> plan quantity = {requested 2, target 1, reason}", () => {
      const r = validateAndPricePlan({
        summary_ar: "شركة واحدة",
        stages: [{ ...companies, expected_rows: 1, target_reason_ar: "لم نجد سوى شركة واحدة مطابقة" }, people(2)],
      }, handed(2));
      expect(r.ok, JSON.stringify(r)).toBe(true);
      if (!r.ok) return;
      expect(r.plan.quantity).toMatchObject({ requested: 2, stage_key: "companies", target: 1, reason_ar: "لم نجد سوى شركة واحدة مطابقة" });
    });

    it("5) counter d: requestText «عايز شركات ومن كل شركة المديرين», handed() -> rows as written", () => {
      const lookup = { ...handed(), requestText: "عايز شركات ومن كل شركة المديرين" };
      const r = validateAndPricePlan({ summary_ar: "شركات", stages: [{ ...companies, expected_rows: 8 }, people(2)] }, lookup);
      expect(r.ok, JSON.stringify(r)).toBe(true);
      if (!r.ok) return;
      expect(r.plan.stages.find((s) => s.key === "companies")!.planned_rows).toBe(8);
    });

    it("6) M19 two roots: stages [{ ...companies, key: 'other', title_ar: 'عناصر أخرى', expected_rows: 3, deliver: false }, companies (8), people], handed(2) -> companies planned_rows 2 AND 'other' stays 3", () => {
      const other = { ...companies, key: "other", title_ar: "عناصر أخرى", expected_rows: 3, deliver: false };
      const comp8 = { ...companies, expected_rows: 8 };
      const ppl = { ...people(2), parent_key: "companies" };
      const r = validateAndPricePlan({ summary_ar: "شركتان", stages: [other, comp8, ppl] }, handed(2));
      expect(r.ok, JSON.stringify(r)).toBe(true);
      if (!r.ok) return;
      expect(r.plan.stages.find((s) => s.key === "companies")!.planned_rows).toBe(2);
      expect(r.plan.stages.find((s) => s.key === "other")!.planned_rows).toBe(3);
    });

    it("7) M18: companies stage given deliver: false, handed(2) -> stage deliver is not changed by the bound (named:false)", () => {
      const comp8 = { ...companies, expected_rows: 8, deliver: false };
      const ppl = { ...people(2), deliver: true };
      const r = validateAndPricePlan({ summary_ar: "شركتان", stages: [comp8, ppl] }, handed(2));
      expect(r.ok, JSON.stringify(r)).toBe(true);
      if (!r.ok) return;
      expect(r.plan.stages.find((s) => s.key === "companies")!.deliver).toBe(false);
    });

    // F2
    it("8) peopleEstimate + understoodPeople + [companies] + unserved_steps + two attempted calls -> NOT ok, issues match /priced by an ESTIMATE/ and contain endpoint id; control without peopleEstimate -> ok", () => {
      const estimate = { endpointIds: ["limadata.people.employees.search"], costPerPersonUsd: 0.0005, ceilingPersonUsd: 0.001 };
      const given = {
        summary_ar: "شركات",
        stages: [{ ...companies, expected_rows: 5 }],
        contacts_note_ar: "لم تتوفر مصادر موثقة للإيميلات وأرقام التليفون ضمن ميزانية هذه المهمة.",
        unserved_steps: [{ reason_ar: "لم نجد موظفين في المصادر المجربة" }],
      };
      const withEst = {
        ...handed(),
        peopleEstimate: estimate,
        endpointsCalled: () => new Map([["aviato.companies.employees", { rows: 0 }], ["blitzapi.people.employee-finder", { rows: 0 }]]),
      };
      const rWithEst = validateAndPricePlan(given, withEst);
      expect(rWithEst.ok).toBe(false);
      if (!rWithEst.ok) {
        expect(rWithEst.issues.join(" ")).toMatch(/priced by an ESTIMATE/);
        expect(rWithEst.issues.join(" ")).toContain("limadata.people.employees.search");
      }

      const control = {
        ...handed(),
        endpointsCalled: () => new Map([["aviato.companies.employees", { rows: 0 }], ["blitzapi.people.employee-finder", { rows: 0 }]]),
      };
      const rControl = validateAndPricePlan(given, control);
      expect(rControl.ok, JSON.stringify(rControl)).toBe(true);
    });

    it("9) the loop corner: no estimate, endpointsCalled = two attempted people sources with rows 0 -> ok with 1 unserved (honest card, not a re-refusal)", () => {
      const given = {
        summary_ar: "شركات",
        stages: [{ ...companies, expected_rows: 5 }],
        contacts_note_ar: "لم تتوفر مصادر موثقة للإيميلات وأرقام التليفون ضمن ميزانية هذه المهمة.",
        unserved_steps: [{ reason_ar: "لم نجد موظفين" }],
      };
      const lookup = {
        ...handed(),
        endpointsCalled: () => new Map([["aviato.companies.employees", { rows: 0 }], ["blitzapi.people.employee-finder", { rows: 0 }]]),
      };
      const r = validateAndPricePlan(given, lookup);
      expect(r.ok, JSON.stringify(r)).toBe(true);
      if (!r.ok) return;
      expect(r.plan.unserved_steps).toHaveLength(1);
    });

    it("10) one attempted source only, no estimate -> NOT ok (today's rule unchanged)", () => {
      const given = {
        summary_ar: "شركات",
        stages: [{ ...companies, expected_rows: 5 }],
        contacts_note_ar: "لم تتوفر مصادر موثقة للإيميلات وأرقام التليفون ضمن ميزانية هذه المهمة.",
        unserved_steps: [{ reason_ar: "لم نجد موظفين" }],
      };
      const lookup = {
        ...handed(),
        endpointsCalled: () => new Map([["aviato.companies.employees", { rows: 0 }]]),
      };
      const r = validateAndPricePlan(given, lookup);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.issues.join(" ")).toMatch(/CAN be served/);
    });
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
    // CHANGED (owner decision after #321): the holds now carry the deeper search (up to 3 pages of the people source for each company, priced at the measuring call's cost); before: 202 / 361 / 503 and 200 / 314 / 438. The default count of people is still lowered for the price of the READING alone.
    // CHANGED (PR 1 part c): each hold carries the names request's estimate (0.00003 USD per decision maker, plan.ts namesAreWritten); before: 328 / 285, 804 / 699, 2322 / 2019
    // CHANGED (PR 2 price): planning is priced by the plan's shape (two stages 0.016, was a flat 0.012), the names step 0.00007 a person: holds and charges move by about 8%
    [0.00099, 2, 15, 357, 311],
    [0.0035, 2, 15, 834, 725],
    // CHANGED (DT-20261118-03 O-1): the dearest case keeps 2 per company (before: [0.0115, 1, 10, 2349, 2043])
    [0.0115, 2, 15, 2352, 2045],
  ];
  it.each(OWNER_PRICES)("%f USD per person: %i per company, %i items, hold %i points, at most %i charged", (perPerson, per, rows, hold, max) => {
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
  });
});
