import { describe, expect, it } from "vitest";
import { validateAndPricePlan, type PlanLookup } from "../src/lib/agentMission/plan";

/**
 * DT-20261119-15 P02b (ORDER 05 + ORDER 07 FINAL count rule regression):
 * Preserves فزاع's r1/r2/r3 probes + ORDER 05 Rules A–D + ORDER 07 comma/thousands/decimal deltas (`validateAndPricePlan` offline, fakes only).
 */
function makeLookup(opts: {
  requestText?: string;
  answerText?: string;
  answerForQuantityQuestion?: boolean;
  costUsd?: number;
  withManager?: boolean;
  understoodCompanies?: number;
}): PlanLookup {
  const row = { id: "co_1", name: "Nile Soft Egypt", industry: "Software", city: "Cairo", country: "EG", website: "nilesoft.com.eg", phone: "+20223456700", address: "10 Tahrir St" };
  return {
    requestText: opts.requestText ?? "عايز 100 شركة برمجيات في مصر",
    ...(opts.answerText !== undefined ? { answerText: opts.answerText } : {}),
    ...(opts.answerForQuantityQuestion !== undefined ? { answerForQuantityQuestion: opts.answerForQuantityQuestion } : {}),
    ...(opts.withManager
      ? { understoodPeople: { noun_ar: "المديرين", parent_ar: "شركة", per_parent: 1, ...(opts.understoodCompanies !== undefined ? { companies: opts.understoodCompanies } : {}) } }
      : {}),
    call: (id) => ({
      id,
      endpointId: id === "call_0002" ? "fake.people.ep" : "fake.companies.ep",
      ok: true,
      costUsd: opts.costUsd ?? 0.002,
      rows: 1,
      params: {},
    }),
    evidenceText: () => JSON.stringify([row]),
    endpointCapability: (ep) => (ep === "fake.people.ep" ? "people.search" : "companies.search"),
    endpointAllowed: () => true,
  };
}

function makePlanInput(withManager = false, expectedCompanies = 100) {
  return {
    summary_ar: "ستحصل على شركات برمجيات في مصر.",
    stages: [
      {
        key: "companies",
        title_ar: "شركات برمجيات في مصر",
        endpoint_id: "fake.companies.ep",
        expected_rows: expectedCompanies,
        parent_key: null,
        deliver: true,
        columns: [
          { key: "name", title_ar: "اسم الشركة" },
          { key: "industry", title_ar: "النشاط والتخصص" },
          { key: "city", title_ar: "المدينة" },
          { key: "country", title_ar: "الدولة" },
          { key: "website", title_ar: "الموقع الإلكتروني" },
          { key: "phone", title_ar: "هاتف المقر الرئيسي" },
          { key: "address", title_ar: "العنوان" },
        ],
        measured_by: ["call_0001"],
        yield_from: "out_0001",
      },
      ...(withManager
        ? [
            {
              key: "people",
              title_ar: "مدير كل شركة",
              endpoint_id: "fake.people.ep",
              expected_rows: expectedCompanies,
              parent_key: "companies",
              per_parent_rows: 1,
              deliver: true,
              columns: [
                { key: "full_name", title_ar: "الاسم الكامل" },
                { key: "job_title", title_ar: "المسمى الوظيفي" },
              ],
              measured_by: ["call_0002"],
              yield_from: "out_0002",
            },
          ]
        : []),
    ],
  };
}

describe("DT-20261119-15 ORDER 05 & ORDER 07 FINAL count rule regression suite", () => {
  it.each([
    // Rule A: explicit quantity phrases + trailing punctuation + noun-bound
    { label: "ORDER05 live reply: مصر - شركات برمجيات - نبدأ بـ 10", answerText: "مصر - شركات برمجيات - نبدأ بـ 10", expected: 10 },
    { label: "ORDER05 trailing period (Faza'a r2 #4): مصر - شركات برمجيات - نبدأ بـ 10.", answerText: "مصر - شركات برمجيات - نبدأ بـ 10.", expected: 10 },
    { label: "ORDER05 explicit + Arabic punctuation: نبدأ بـ 10؟", answerText: "نبدأ بـ 10؟", expected: 10 },
    { label: "ORDER05 نبدأ بـ 10", answerText: "نبدأ بـ 10", expected: 10 },
    { label: "ORDER05 نبدأ بـ ١٠", answerText: "نبدأ بـ ١٠", expected: 10 },
    { label: "ORDER05 خليهم 25!", answerText: "خليهم 25!", expected: 25 },
    { label: "ORDER05 عدد 15", answerText: "عدد 15", expected: 15 },
    { label: "ORDER05 noun-bound: 10 شركات بس", answerText: "10 شركات بس", expected: 10 },
    { label: "ORDER05 noun-bound keep 100: عايز 100 شركة", answerText: "عايز 100 شركة", expected: 100 },
    { label: "ORDER05 explicit phrase wins over year in other segment: القاهرة 2025 - نبدأ بـ 10", answerText: "القاهرة 2025 - نبدأ بـ 10", expected: 10 },

    // ORDER 07 deltas: commas / thousands / decimals / grouped nouns
    { label: "ORDER07 thousands price: نبدأ بـ 1,000 جنيه", answerText: "نبدأ بـ 1,000 جنيه", expected: 100 },
    { label: "ORDER07 thousands Arabic price: نبدأ بـ ١٬٠٠٠ جنيه", answerText: "نبدأ بـ ١٬٠٠٠ جنيه", expected: 100 },
    { label: "ORDER07 comma decimal: نبدأ بـ 50,5", answerText: "نبدأ بـ 50,5", expected: 100 },
    { label: "ORDER07 comma decimal with noun: 50,5 شركة", answerText: "50,5 شركة", expected: 100 },
    { label: "ORDER07 thousands item noun: نبدأ بـ 1,000 شركة", answerText: "نبدأ بـ 1,000 شركة", expected: 1000 },
    { label: "ORDER07 thousands Arabic item noun: نبدأ بـ ١٬٠٠٠ شركة", answerText: "نبدأ بـ ١٬٠٠٠ شركة", expected: 1000 },

    // FU-15a per-clause decimal guard: decimal budget in another clause never cancels explicit quantity
    { label: "FU-15a dash clauses with decimal budget: مصر - شركات برمجيات - نبدأ بـ 10 - الميزانية 50.5 جنيه", answerText: "مصر - شركات برمجيات - نبدأ بـ 10 - الميزانية 50.5 جنيه", expected: 10 },
    { label: "FU-15a comma clauses with comma decimal budget: نبدأ بـ 10، الميزانية 50,5 جنيه", answerText: "نبدأ بـ 10، الميزانية 50,5 جنيه", expected: 10 },
    { label: "FU-15a budget first with decimal: مصر - شركات برمجيات - الميزانية 50.5 جنيه - نبدأ بـ 10", answerText: "مصر - شركات برمجيات - الميزانية 50.5 جنيه - نبدأ بـ 10", expected: 10 },

    // Rule B: bare number NEVER overrides inside a multi-part reply
    { label: "ORDER05 / Faza'a r2 budget segment: مصر - شركات برمجيات - الميزانية - 500", answerText: "مصر - شركات برمجيات - الميزانية - 500", expected: 100 },
    { label: "ORDER05 / Faza'a r2 founding year segment: مصر - شركات برمجيات - سنة التأسيس - 2025", answerText: "مصر - شركات برمجيات - سنة التأسيس - 2025", expected: 100 },

    // Rule C: bare number alone ONLY overrides with trusted quantity-question flag
    { label: "ORDER05 bare 10 with NO flag -> keeps original 100", answerText: "10", expected: 100 },
    { label: "ORDER05 bare ١٠ with NO flag -> keeps original 100", answerText: "١٠", expected: 100 },
    { label: "ORDER05 bare 10 WITH quantity flag -> 10", answerText: "10", answerForQuantityQuestion: true, expected: 10 },
    { label: "ORDER05 bare ١٠ WITH quantity flag -> 10", answerText: "١٠", answerForQuantityQuestion: true, expected: 10 },

    // Rule A/D: prices, decimals, dates, phones, plain ack keep 100
    { label: "ORDER05 price: نبدأ بـ 500 جنيه", answerText: "نبدأ بـ 500 جنيه", expected: 100 },
    { label: "ORDER05 decimal: نبدأ بـ 50.5", answerText: "نبدأ بـ 50.5", expected: 100 },
    { label: "ORDER05 decimal price: نبدأ بـ 50.5 جنيه", answerText: "نبدأ بـ 50.5 جنيه", expected: 100 },
    { label: "ORDER05 decimal noun: 50.5 شركات", answerText: "50.5 شركات", expected: 100 },
    { label: "ORDER05 date: نبدأ بـ 2024-01-01", answerText: "نبدأ بـ 2024-01-01", expected: 100 },
    { label: "ORDER05 formatted phone: نبدأ بـ 123-456-7890", answerText: "نبدأ بـ 123-456-7890", expected: 100 },
    { label: "ORDER05 labeled phone: رقم التواصل 01012345678", answerText: "رقم التواصل 01012345678", expected: 100 },
    { label: "ORDER05 bare phone: 01012345678", answerText: "01012345678", answerForQuantityQuestion: true, expected: 100 },
    { label: "ORDER05 year mention: سنة 2024", answerText: "سنة 2024", expected: 100 },
    { label: "ORDER05 no numbers: مصر - شركات برمجيات", answerText: "مصر - شركات برمجيات", expected: 100 },
    { label: "ORDER05 plain ack: تمام", answerText: "تمام", expected: 100 },
  ])("$label -> $expected companies", ({ answerText, answerForQuantityQuestion, expected }) => {
    const res = validateAndPricePlan(
      makePlanInput(false, 100),
      makeLookup({ answerText, ...(answerForQuantityQuestion !== undefined ? { answerForQuantityQuestion } : {}) }),
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.plan.stages[0].planned_rows).toBe(expected);
  });

  it("Faza'a #11: budget «الميزانية 500 جنيه» with understoodPeople.companies=500 keeps original 100 + 100", () => {
    const res = validateAndPricePlan(
      makePlanInput(true, 100),
      makeLookup({
        requestText: "عايز 100 شركة برمجيات في مصر ومدير كل شركة",
        answerText: "الميزانية 500 جنيه",
        withManager: true,
        understoodCompanies: 500,
      }),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.plan.stages[0].planned_rows).toBe(100);
      expect(res.plan.stages[1].planned_rows).toBe(100);
    }
  });

  it("Faza'a #12: genuine «نبدأ بـ 500» applies 500 and is still gated by the existing job hold cap", () => {
    const underCap = validateAndPricePlan(
      makePlanInput(false, 100),
      { ...makeLookup({ answerText: "نبدأ بـ 500", costUsd: 0.0001 }), pricingSettings: { markup: 1, minChargePoints: 0 } },
    );
    expect(underCap.ok).toBe(true);
    if (underCap.ok) expect(underCap.plan.stages[0].planned_rows).toBe(500);

    const overCap = validateAndPricePlan(makePlanInput(false, 100), makeLookup({ answerText: "نبدأ بـ 500", costUsd: 0.02 }));
    expect(overCap.ok).toBe(false);
    if (!overCap.ok) expect(overCap.issues.join(" ")).toMatch(/more than the job limit/i);
  });
});
