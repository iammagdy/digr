import { describe, expect, it } from "vitest";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { rankPeopleByRole, roleEnded } from "../src/lib/agentMission/roles";
import { customerPlanView, validateAndPricePlan, type PlanLookup } from "../src/lib/agentMission/plan";

/**
 * DT-20261119-03 R3 and R4. R3: a source that returns the people with the END DATE of their position (live run 3): the current positions come first inside their title tier and the past ones are still delivered; read from
 * the field's structure (a key that says «end» holding a date), never from a list of values. R4: the headline of a people stage the code does NOT filter by role never names a role (live run 2: «موظفيها القياديين، وإيميل المدير التنفيذي» over «تُجمع الموظفون … دون تصفية»).
 */
describe("R3: current positions first, past positions kept (pure)", () => {
  it("roleEnded: a key that says end/ended/until/to_date holding a date, a year or a timestamp; «Present», empty, null and unrelated fields are not", () => {
    expect(roleEnded({ end_date: "2019-05-01" })).toBe(true);
    expect(roleEnded({ ended_at: "2020-01-01T00:00:00Z" })).toBe(true);
    expect(roleEnded({ until: "2018" })).toBe(true);
    expect(roleEnded({ to_date: 2021 })).toBe(true);
    expect(roleEnded({ endDate: "2022-03-04" })).toBe(true);
    expect(roleEnded({ end_date: "Present" })).toBe(false);
    expect(roleEnded({ end_date: "" })).toBe(false);
    expect(roleEnded({ end_date: null })).toBe(false);
    expect(roleEnded({ start_date: "2019-05-01" })).toBe(false);
    expect(roleEnded({ title: "Director", name: "Ali" })).toBe(false);
  });
  const row = (name: string, title: string, extra: Record<string, unknown> = {}) => ({ name, title, ...extra });
  it("inside one title tier the ended ones come after the current ones, order otherwise stable; the ranking by title tier still wins over the end date", () => {
    const rows = [row("a", "Director", { end_date: "2019-01-01" }), row("b", "Manager"), row("c", "Director", { end_date: "Present" }), row("d", "Consultant"), row("e", "Manager", { end_date: "2020-02-02" })];
    expect(rankPeopleByRole(rows, "manager").rows.map((r) => r.name)).toEqual(["b", "c", "a", "e", "d"]);
  });
  it("rows with no end field: byte-identical to the old order (golden)", () => {
    const rows = [row("a", "Accountant"), row("b", "Manager"), row("c", "Engineer"), row("d", "Director")];
    expect(rankPeopleByRole(rows, "manager").rows.map((r) => r.name)).toEqual(["b", "d", "c", "a"]);
  });
});

describe("R4: the headline of an unfiltered people stage names no role the stage does not enforce (card level)", () => {
  const catalog = loadTregCatalog();
  const companies = (title = "شركات التسويق في القاهرة") => ({ key: "companies", title_ar: title, endpoint_id: "tomba.companies.search.reveal", expected_rows: 2, parent_key: null, deliver: true, columns: [{ key: "name", title_ar: "اسم الشركة" }, { key: "website", title_ar: "الموقع" }], sample_rows: [{ id: "k.com", name: "شركة أ", website: "k.com" }], measured_by: ["call_0001"] });
  const people = { key: "people", title_ar: "الأشخاص في كل شركة", endpoint_id: "aviato.companies.employees", expected_rows: 4, parent_key: "companies", per_parent_rows: 2, deliver: true, columns: [{ key: "name", title_ar: "الاسم" }, { key: "title", title_ar: "المسمى الوظيفي" }], sample_rows: [{ id: "person-1", name: "شخص", title: "Director" }], measured_by: ["call_0002"] };
  const calls = new Map([
    ["call_0001", { id: "call_0001", endpointId: "tomba.companies.search.reveal", ok: true, costUsd: 0.000178, rows: 50, params: { query: "marketing" } }],
    ["call_0002", { id: "call_0002", endpointId: "aviato.companies.employees", ok: true, costUsd: 0.001, rows: 2, params: { website: "k.com", perPage: 2, page: 0 } }],
  ]);
  const lookup = (requestText: string): PlanLookup => ({ call: (id) => calls.get(id) ?? null, evidenceText: () => "k.com https://k.com person-1", endpointAllowed: () => true, requestText, endpointCapability: (id: string) => catalog.byId.get(id)?.capability ?? null, endpointsCalled: () => new Map([["aviato.companies.employees", { rows: 2 }]]) });
  const summaryOf = (summary_ar: string, parentTitle?: string) => {
    const r = validateAndPricePlan({ summary_ar, stages: [companies(parentTitle), people] }, lookup("عايز شركتين تسويق في القاهرة ومعاهم الموظفين"));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) throw new Error("refused");
    expect(r.plan.stages.find((s) => s.key === "people")!.role_preference).toBeUndefined();
    return { summary: r.plan.summary_ar, card: customerPlanView(r.plan) };
  };
  it("the live run-2 headline is replaced by the code's sentence about who is delivered; the card's rule line («دون تصفية») is unchanged", () => {
    const { summary, card } = summaryOf("شركتان تسويق في القاهرة مع موظفيها القياديين، وإيميل المدير التنفيذي لكل شركة.");
    expect(summary).not.toMatch(/قيادي|مدير/);
    expect(summary).toContain("شركات التسويق في القاهرة");
    expect(summary).toContain("من العاملين في كل شركة");
    expect(JSON.stringify(card.notes_ar ?? [])).toContain("دون تصفية");
  });
  it("a role of the code's own table other than «manager» is read too (engineers, sales, HR, accountants)", () => {
    for (const claim of ["مع مهندسيها", "مع مندوبي مبيعاتها", "مع مسؤولي الموارد البشرية فيها", "مع محاسبيها"]) {
      expect(summaryOf(`شركتان تسويق في القاهرة ${claim}.`).summary, claim).not.toMatch(/مهندس|مندوب|الموارد|محاسب/);
    }
  });
  it("a sentence about the COMPANIES' own trade is not a role claim (Gate 1 P2-2): a parent title that already names the trade keeps its sentence; a summary with no role word is untouched", () => {
    const trade = summaryOf("شركات مبيعات عقارية في القاهرة.", "شركات المبيعات العقارية في القاهرة");
    expect(trade.summary).toBe("شركات مبيعات عقارية في القاهرة.");
    const eng = summaryOf("شركات مهندسين استشاريين في القاهرة.", "شركات المهندسين الاستشاريين في القاهرة");
    expect(eng.summary).toBe("شركات مهندسين استشاريين في القاهرة.");
    expect(summaryOf("شركتان تسويق في القاهرة ومعهما موظفوهما.").summary).toBe("شركتان تسويق في القاهرة ومعهما موظفوهما.");
  });
});
