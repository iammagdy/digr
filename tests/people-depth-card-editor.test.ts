import { describe, expect, it } from "vitest";
import { customerPlanView, planEditorView, stagePriceInputs, type PricedPlan, type PricedStage } from "../src/lib/agentMission/plan";
import { applyPlanEdits } from "../src/lib/agentMission/planEdit";
import { buildContactSteps, type FinderInfo } from "../src/lib/agentMission/contactFinders";
import { priceMissionByCode } from "../src/lib/agentMission/price";
import { depthPagesOf } from "../agent/src/engine/run";
import { editsFromState, initialState } from "../src/components/mission/PlanEditor";
import { checkCustomerText } from "../src/lib/agentMission/text";

/**
 * ITEM 3 (owner decision after #321): the plan card tells the customer, in plain Arabic, that the price includes the deeper search and the contact lookup, and the plan editor lets them LOWER the depth (people per company, pages) to reduce the price, or raise it. The price is computed by code from these settings.
 */
const F = (id: string, usd: number, name: string): FinderInfo => ({ id, usd, bill: "success", inputs: [{ name, required: true }] });
const columns = [{ key: "name", title_ar: "اسم المدير" }, { key: "title", title_ar: "المسمى الوظيفي" }, { key: "linkedin", title_ar: "الملف المهني" }, { key: "email", title_ar: "الإيميل", kind: "work_email" as const }, { key: "phone", title_ar: "رقم التليفون", kind: "phone" as const }];
const stage = (over: Partial<PricedStage>): PricedStage => ({ key: "x", title_ar: "x", endpoint_id: "e", expected_rows: 5, parent_key: null, deliver: true, columns: [], sample_rows: [], measured_by: [], planned_rows: 5, measured_cost_per_row_usd: 0.0001, measured_from_calls: [], ...over } as PricedStage);
function fixture(): PricedPlan {
  const stages = [
    stage({ key: "companies", title_ar: "شركات مصرية في قطاع الكهروميكانيكا", columns: [{ key: "name", title_ar: "اسم الشركة" }] }),
    stage({ key: "people", title_ar: "صناع القرار في كل شركة", parent_key: "companies", per_parent_rows: 2, planned_rows: 10, expected_rows: 10, role_preference: { role: "manager" }, measured_cost_per_row_usd: 0.001, pages_per_parent: 3, page_cost_usd: 0.005, columns }),
  ];
  const steps = buildContactSteps(stages as any, "عايز ٥ شركات مصرية ومعاهم صناع القرار: الإيميل ورقم التليفون", (kind) => (kind === "email" ? [F("blitzapi.people.email.find", 0.000495, "person_linkedin_url"), F("anyapi.linkedin.email.work.find", 0.011, "profileUrl")] : [F("blitzapi.people.phone.find", 0.000495, "person_linkedin_url")]), (kind) => (kind === "email" ? { verifiers: [F("millionverifier.people.email.verify", 0.00178, "email")] } : {}));
  return { summary_ar: "٥ شركات مصرية ومعهم صناع القرار.", stages, contact_steps: steps, price: priceMissionByCode(stagePriceInputs(stages, steps)) } as PricedPlan;
}

describe("the plan card says what the price includes", () => {
  it("a plan read in depth with contact steps carries ONE plain sentence: deeper search for decision makers and the e-mail and phone lookup; Arabic digits, no provider, no USD", () => {
    const view = customerPlanView(fixture());
    const line = (view.notes_ar ?? []).find((n) => n.includes("بحثًا أعمق"));
    expect(line, JSON.stringify(view.notes_ar)).toBeTruthy();
    expect(line).toContain("٣ صفحات");
    expect(line).toContain("الإيميل");
    expect(line).toContain("رقم التليفون");
    expect(line).toContain("السعر يشمل");
    expect(checkCustomerText(line!).issues).toEqual([]);
    expect(line).not.toMatch(/[0-9]/);
  });
  it("without contact steps the sentence names the deeper search alone; with the depth lowered to one page there is no depth sentence", () => {
    const p = fixture();
    delete p.contact_steps;
    const only = (customerPlanView(p).notes_ar ?? []).find((n) => n.includes("السعر يشمل"));
    expect(only).toContain("بحثًا أعمق");
    expect(only).not.toContain("الإيميل");
    p.stages[1].pages_per_parent = 1;
    expect((customerPlanView(p).notes_ar ?? []).some((n) => n.includes("بحثًا أعمق"))).toBe(false);
  });
});

describe("the editor offers the depth and the price follows it", () => {
  it("the editor view carries the pages of a stage read in depth, with a plain label and the maximum", () => {
    const row = planEditorView(fixture()).stages.find((s) => s.key === "people")!;
    expect(row.pages).toBe(3);
    expect(row.pages_max).toBe(10);
    expect(row.pages_label_ar).toContain("صفحات");
    expect(planEditorView(fixture()).stages.find((s) => s.key === "companies")!.pages).toBeUndefined();
  });
  it("lowering the pages to 1 lowers the price; raising them raises it; the price is the code's (the same function as the plan's)", () => {
    const p = fixture();
    const one = applyPlanEdits(p, { stages: [{ key: "people", pages: 1 }] });
    const five = applyPlanEdits(p, { stages: [{ key: "people", pages: 5 }] });
    expect(one.ok && five.ok).toBe(true);
    if (!one.ok || !five.ok) return;
    expect(one.plan.stages[1].pages_per_parent).toBe(1);
    expect(five.plan.stages[1].pages_per_parent).toBe(5);
    expect(one.plan.price.reservePoints).toBeLessThan(p.price.reservePoints);
    expect(five.plan.price.reservePoints).toBeGreaterThan(p.price.reservePoints);
    expect(one.plan.price.reservePoints).toBe(priceMissionByCode(stagePriceInputs(one.plan.stages, one.plan.contact_steps), { settings: p.price.settings }).reservePoints);
  });
  it("fewer people per company lowers it too (the existing count edit): 1 per company costs less than 2", () => {
    const p = fixture();
    const r = applyPlanEdits(p, { stages: [{ key: "people", per_parent: 1 }] });
    expect(r.ok && r.plan.price.reservePoints < p.price.reservePoints).toBe(true);
  });
  it("a depth that is not a whole number from 1 to the maximum, or on a stage with no depth, is refused in Arabic", () => {
    const p = fixture();
    for (const bad of [0, -1, 2.5, 11]) {
      const r = applyPlanEdits(p, { stages: [{ key: "people", pages: bad }] });
      expect(r.ok, String(bad)).toBe(false);
      if (!r.ok) expect(r.errorAr).toMatch(/[؀-ۿ]/);
    }
    expect(applyPlanEdits(p, { stages: [{ key: "companies", pages: 2 }] }).ok).toBe(false);
  });
  it("the editor collects it: only a changed value is sent", () => {
    const view = planEditorView(fixture());
    const state = initialState(view);
    expect(editsFromState(view, state).stages).toBeUndefined();
    state.pages.people = "٢";
    expect(editsFromState(view, state).stages).toEqual([{ key: "people", pages: 2 }]);
  });
  it("the engine reads exactly the pages the plan says: 1 means the first page only", () => {
    const people: any = { parent_key: "companies", per_parent_rows: 2, role_preference: { role: "manager" }, pages_per_parent: 1 };
    expect(depthPagesOf(people, { cursor_param: "page" } as any)).toBe(1);
    expect(depthPagesOf({ ...people, pages_per_parent: 3 }, { cursor_param: "page" } as any)).toBe(3);
    expect(depthPagesOf({ ...people, pages_per_parent: 3 }, { cursor_param: null } as any)).toBe(1);
  });
});
