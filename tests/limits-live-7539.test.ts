import { describe, expect, it } from "vitest";
import { buildMethodology, type MissionFacts, type StageRecord } from "../agent/src/methodology";
import type { PricedPlan } from "../src/lib/agentMission/plan";

/**
 * THE LIMITS ROW OF THE DELIVERED FILE, LIVE SHAPE OF msn_7539ea17512cf58aa0e7 (2026-11-01 11:38 Cairo): 5 companies, 8 of 10 people delivered. Four companies gave 5 candidates each (2 delivered, 3 left out as «زاد عن العدد المعتمد»: 12 people); «Alu Misr» gave NO people
 * (the people source answered «not found» for it). The row said «سُلّم ٨ من ١٠ لأن المصدر لم يعد يعطي نتائج أخرى لهذا الطلب» although the source had given 12 more people. And some delivered people were not decision makers.
 */
const person = { key: "people", title_ar: "موظفو كل شركة", endpoint_id: "aviato.companies.employees", expected_rows: 10, planned_rows: 10, parent_key: "companies", per_parent_rows: 2, deliver: true, sample_rows: [], measured_by: [], measured_from_calls: [], measured_cost_per_row_usd: 0.001, columns: [{ key: "name", title_ar: "الاسم" }, { key: "title", title_ar: "المسمى الوظيفي" }], role_preference: { role: "manager" } };
const companies = { key: "companies", title_ar: "شركات مصرية في قطاع الكهروميكانيكا", endpoint_id: "tomba.companies.search.reveal", expected_rows: 5, planned_rows: 5, parent_key: null, deliver: true, sample_rows: [], measured_by: [], measured_from_calls: [], measured_cost_per_row_usd: 0.00001, columns: [{ key: "name", title_ar: "اسم الشركة" }] };
const plan = { summary_ar: "x", stages: [companies, person] as any, price: { totalCostUsd: 0, deliveredRows: 15, costPerFinalRowUsd: 0.0001, unitPricePoints: 24.8, reservePoints: 429, maxChargePoints: 373, overCap: false } as any } as PricedPlan;
const record = (over: Partial<StageRecord> = {}): StageRecord => ({ found: 0, duplicates: 0, accepted: 0, excluded: 0, pending: 0, unchecked: 0, acceptedByRule: 0, acceptedByModel: 0, excludedByReason: {}, stop: "source_exhausted", ...over });
const facts = (people: StageRecord): MissionFacts => ({ requestText: "عايز ٥ شركات مصرية في قطاع الكهروميكانيكا، ومعاهم صناع القرار", deliveredAt: new Date("2026-11-01T09:40:00Z"), reviewStop: null, stages: { companies: record({ found: 50, accepted: 5, excluded: 4, pending: 41, stop: "target_reached" }), people }, });
const companyRows = ["alumisr", "365ecology", "kahromika", "melcomec", "ateco"].map((id) => ({ id }));
const p = (parent: string, name: string, title: string) => ({ id: `${parent}-${name}`, parent_id: parent, name, title });
const LIVE_PEOPLE_FACTS = record({ found: 20, accepted: 8, excluded: 12, excludedByReason: { target_reached: 12 }, stop: "source_exhausted" });
const limitsOf = (people: ReturnType<typeof p>[], f: MissionFacts = facts(LIVE_PEOPLE_FACTS)): string[] => {
  const m = buildMethodology({ plan, layouts: [], rowsByStage: { companies: companyRows, people }, facts: f });
  return m.items.find((i) => i.label === "حدود هذا التسليم")!.values;
};

describe("ITEM 3: the limits row says when people who are not decision makers fill the count", () => {
  const all = [p("365ecology", "A", "Operations Manager"), p("365ecology", "B", "Head of Projects"), p("kahromika", "C", "Director"), p("kahromika", "D", "General Manager"), p("melcomec", "E", "Sales Representative"), p("melcomec", "F", "Consultant"), p("ateco", "G", "Chairman"), p("ateco", "H", "عامل")];
  it("three of the eight are not decision makers, in two companies: the row says so, with Arabic-Indic digits", () => {
    const v = limitsOf(all).join("\n");
    expect(v).toContain("لم يوجد في المصدر عدد كافٍ من صناع القرار في شركتين");
    expect(v).toContain("٣ أشخاص");
    expect(v).not.toMatch(/[0-9]/);
  });
  it("when every delivered person is a decision maker the row does not say it", () => {
    const dms = all.map((r, i) => ({ ...r, title: i % 2 ? "Director" : "Manager" }));
    expect(limitsOf(dms).join("\n")).not.toContain("صناع القرار");
  });
});
