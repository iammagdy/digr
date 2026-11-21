import { describe, expect, it } from "vitest";
import { countedQuantities, perParentQuantities } from "../src/lib/agentMission/quantity";
import { customerPlanView, validateAndPricePlan, type PlanLookup } from "../src/lib/agentMission/plan";
import { checkCustomerText } from "../src/lib/agentMission/text";
import { roleLineAr } from "../src/lib/agentMission/roles";
import { loadTregCatalog } from "../src/lib/treg/catalog";

const catalog = loadTregCatalog();

const companiesStage = {
  key: "companies",
  title_ar: "شركات التسويق في القاهرة",
  endpoint_id: "tomba.companies.search.reveal",
  expected_rows: 3,
  parent_key: null,
  deliver: true,
  columns: [
    { key: "name", title_ar: "اسم الشركة" },
    { key: "website", title_ar: "الموقع" },
  ],
  sample_rows: [{ id: "c-1", name: "شركة تسويق", website: "marketing.eg" }],
  measured_by: ["call_0001"],
};

const peopleStage = {
  key: "people",
  title_ar: "مدير في كل شركة",
  endpoint_id: "aviato.companies.employees",
  expected_rows: 3,
  parent_key: "companies",
  per_parent_rows: 1,
  deliver: true,
  columns: [
    { key: "name", title_ar: "اسم المدير" },
    { key: "title", title_ar: "المسمى الوظيفي" },
  ],
  sample_rows: [{ id: "p-1", name: "أحمد علي", title: "Managing Director" }],
  measured_by: ["call_0002"],
};

const calls = new Map<string, unknown>([
  ["call_0001", { id: "call_0001", endpointId: "tomba.companies.search.reveal", ok: true, costUsd: 0.000178, rows: 50, params: { query: "marketing" } }],
  ["call_0002", { id: "call_0002", endpointId: "aviato.companies.employees", ok: true, costUsd: 0.001, rows: 2, params: { website: "marketing.eg", perPage: 2, page: 0 } }],
]);

const lookupFor = (requestText: string): PlanLookup => ({
  call: (id) => (calls.get(id) as never) ?? null,
  evidenceText: () => "c-1 marketing.eg https://marketing.eg p-1 p-2",
  endpointAllowed: () => true,
  requestText,
  endpointCapability: (id: string) => catalog.byId.get(id)?.capability ?? null,
  endpointsCalled: () => new Map([["aviato.companies.employees", { rows: 2 }]]),
  now: Date.now(),
  noRelevance: true,
});

describe("FX-01B: Plan Faithfulness (Count, Role & Impersonal Card)", () => {
  it("Live Replay msn_062084aa04eed7777bef: «مدير من كل شركة من ٣ شركات تسويق في القاهرة» -> 3 companies + 1 person each = 3 total, role مدير preserved", () => {
    const text = "مدير من كل شركة من ٣ شركات تسويق في القاهرة";
    const counted = countedQuantities(text);
    expect(counted).toHaveLength(1);
    expect(counted[0].value).toBe(3);
    expect(counted[0].noun).toBe("شركات");
    expect(counted[0].perEach).toBe(false);

    const perParent = perParentQuantities(text);
    expect(perParent).toHaveLength(1);
    expect(perParent[0].value).toBe(1);
    expect(perParent[0].noun).toBe("مدير");
    expect(perParent[0].perEach).toBe(true);

    const res = validateAndPricePlan(
      {
        summary_ar: "استخراج ٣ شركات تسويق في القاهرة ومدير كل شركة.",
        stages: [
          { ...companiesStage, expected_rows: 3 },
          { ...peopleStage, per_parent_rows: 1, expected_rows: 3, role_preference: { role: "manager" } },
        ],
      },
      lookupFor(text)
    );

    expect(res.ok, JSON.stringify(res)).toBe(true);
    if (!res.ok) throw new Error("Plan validation failed");
    const pStage = res.plan.stages.find((s) => s.key === "people")!;
    expect(pStage.expected_rows).toBe(3);
    expect(pStage.title_ar).toMatch(/مدير/);
    expect(pStage.title_ar).not.toContain("شخص واحد من العاملين");
    expect(pStage.title_ar).not.toContain("موظفو كل شركة");
    expect(res.plan.summary_ar).toMatch(/مدير/);
  });

  it("Live Replay msn_b712e0220f73d7279a5e: «عايز 3 شركات عقارات في القاهرة ومدير كل شركة بالإيميل والتليفون» -> names مدير, card never says «العميل عايز»", () => {
    const text = "عايز 3 شركات عقارات في القاهرة ومدير كل شركة بالإيميل والتليفون";
    const counted = countedQuantities(text);
    expect(counted).toHaveLength(1);
    expect(counted[0].value).toBe(3);

    const perParent = perParentQuantities(text);
    expect(perParent).toHaveLength(1);
    expect(perParent[0].value).toBe(1);
    expect(perParent[0].noun).toBe("مدير");

    const res = validateAndPricePlan(
      {
        summary_ar: "العميل عايز ٣ شركات عقارات في القاهرة ومدير كل شركة.",
        stages: [
          { ...companiesStage, title_ar: "شركات العقارات في القاهرة", expected_rows: 3 },
          { ...peopleStage, per_parent_rows: 1, expected_rows: 3, role_preference: { role: "manager" } },
        ],
      },
      lookupFor(text)
    );

    expect(res.ok, JSON.stringify(res)).toBe(true);
    if (!res.ok) throw new Error("Plan validation failed");
    expect(res.plan.summary_ar).not.toContain("العميل عايز");
    expect(res.plan.summary_ar).toMatch(/^المطلوب:/);
    expect(res.plan.summary_ar).toMatch(/مدير/);

    const card = customerPlanView(res.plan);
    const cardStr = JSON.stringify(card);
    expect(cardStr).not.toContain("العميل عايز");
    expect(cardStr).toContain("نستخرج مديرون في كل شركة");

    const note = roleLineAr("manager", "شركة");
    const check = checkCustomerText(note);
    expect(check.issues).toHaveLength(0);
    expect(note).toContain("يُستكمل من أقرب مسمى قيادي متاح");
  });

  it("Mandatory Counter-Case 1: «٣ مديرين من كل شركة من ٥ شركات» -> 5 companies, 3 per company, total 15, role مدير", () => {
    const text = "٣ مديرين من كل شركة من ٥ شركات";
    const counted = countedQuantities(text);
    expect(counted).toHaveLength(1);
    expect(counted[0].value).toBe(5);
    expect(counted[0].noun).toBe("شركات");

    const perParent = perParentQuantities(text);
    expect(perParent).toHaveLength(1);
    expect(perParent[0].value).toBe(3);
    expect(perParent[0].noun).toBe("مديرين");

    const res = validateAndPricePlan(
      {
        summary_ar: "استخراج ٥ شركات و٣ مديرين من كل شركة.",
        stages: [
          { ...companiesStage, expected_rows: 5 },
          { ...peopleStage, per_parent_rows: 3, expected_rows: 15, role_preference: { role: "manager" } },
        ],
      },
      lookupFor(text)
    );

    expect(res.ok, JSON.stringify(res)).toBe(true);
    if (!res.ok) throw new Error("Plan validation failed");
    const pStage = res.plan.stages.find((s) => s.key === "people")!;
    expect(pStage.expected_rows).toBe(15);
  });

  it("Mandatory Counter-Case 2: «موظفين من كل شركة» without specific role -> keeps generic/neutral behavior", () => {
    const text = "عايز ٣ شركات برمجة وموظفين من كل شركة";
    const res = validateAndPricePlan(
      {
        summary_ar: "استخراج ٣ شركات برمجة مع ثلاثة من مديريها.",
        stages: [
          { ...companiesStage, expected_rows: 3 },
          { ...peopleStage, title_ar: "الأشخاص في كل شركة", per_parent_rows: 2, expected_rows: 6, role_preference: undefined },
        ],
      },
      lookupFor(text)
    );

    expect(res.ok, JSON.stringify(res)).toBe(true);
    if (!res.ok) throw new Error("Plan validation failed");
    // Since role_preference is undefined, headline role claims must be neutralized
    expect(res.plan.summary_ar).not.toContain("مديريها");
  });

  it("Mandatory Counter-Case 3: Public business contacts request «عايز إيميلات وتليفونات مديري شركات التسويق في القاهرة» is allowed", () => {
    const text = "عايز إيميلات وتليفونات مديري شركات التسويق في القاهرة";
    const res = validateAndPricePlan(
      {
        summary_ar: "استخراج شركات التسويق في القاهرة ومديريها مع بيانات التواصل.",
        stages: [
          { ...companiesStage, expected_rows: 5 },
          { ...peopleStage, per_parent_rows: 1, expected_rows: 5, role_preference: { role: "manager" } },
        ],
      },
      lookupFor(text)
    );
    expect(res.ok, JSON.stringify(res)).toBe(true);
  });
});
