import { describe, expect, it } from "vitest";
import { decisionMakersLeftOutAr, rankPeopleByRole, titleTierOf } from "../src/lib/agentMission/roles";

/**
 * ITEM 3 OF THE 2026-11-01 11:38 LIVE TEST (msn_7539ea17512cf58aa0e7): «عايز ٥ شركات … ومعاهم صناع القرار»: the file held people with the titles «عامل» and «محاسب». The source (aviato, 5 people a page) gives no decision maker for some companies; the ranking put titles it
 * cannot read («unclear») and titles of another role («other») in one group, in the page's order, so a worker or an accountant took a place of two when the page had nothing better. Owner direction: with more candidates than the count, NEVER a worker, accountant, intern,
 * junior or similar over a manager / director / head; the count is filled with non-decision makers only when no decision maker exists, and the limits text says so.
 */
const row = (name: string, title: string) => ({ name, title, company: "365 Ecology" });
const pick = (rows: Array<Record<string, unknown>>, n: number) => rankPeopleByRole(rows, "manager").rows.slice(0, n).map((r) => String(r.title));

describe("the tiers of a title for decision makers", () => {
  it("manager, director, head, chief, owner are decision makers (tier 0), including Arabic", () => {
    for (const t of ["Operations Manager", "Director Of Business Development", "Head of Projects", "CEO", "Founder", "مدير مالى", "رئيس مجلس الإدارة", "General Manager"]) expect(titleTierOf(t, "manager")).toBe(0);
  });
  it("a title it cannot read is tier 1; another role is tier 2; worker, accountant, intern, junior and the like are tier 3", () => {
    expect(titleTierOf("Consultant", "manager")).toBe(1);
    expect(titleTierOf("", "manager")).toBe(1);
    expect(titleTierOf("Sales Representative", "manager")).toBe(2);
    expect(titleTierOf("Electrical Engineer", "manager")).toBe(2);
    for (const t of ["عامل", "محاسب", "Accountant", "Senior Accountant", "Intern", "Marketing Intern", "Junior Engineer", "Trainee", "Worker", "Driver", "Receptionist", "متدرب", "سائق"]) expect(titleTierOf(t, "manager")).toBe(3);
  });
  it("a junior or an intern with «manager» in the title is not a decision maker", () => {
    expect(titleTierOf("Junior Manager", "manager")).toBe(3);
    expect(titleTierOf("Intern Project Manager", "manager")).toBe(3);
  });
  it("the tiers apply to decision makers only: for another role the old three-way verdict stands", () => {
    expect(titleTierOf("Accountant", "accountant")).toBe(0);
    expect(titleTierOf("Driver", "engineer")).toBe(2);
  });
});

describe("LIVE SHAPE: five candidates of one company, two to deliver", () => {
  it("the worker and the accountant never beat a manager or a director", () => {
    const page = [row("Hassan Mohamed", "عامل"), row("A B", "محاسب"), row("C D", "Operations Manager"), row("E F", "Sales Representative"), row("G H", "Director Of Engineering")];
    expect(pick(page, 2)).toEqual(["Operations Manager", "Director Of Engineering"]);
  });
  it("with one decision maker the second place goes to the best of the rest, never the worker, accountant or intern", () => {
    const page = [row("Hassan Mohamed", "عامل"), row("A B", "محاسب"), row("C D", "Intern"), row("E F", "Head of Projects"), row("G H", "Sales Representative"), row("I J", "Consultant")];
    const top = pick(page, 2);
    expect(top[0]).toBe("Head of Projects");
    expect(["عامل", "محاسب", "Intern"]).not.toContain(top[1]);
  });
  it("with NO decision maker the count is still filled (the order inside a tier is the page's), and the lowest tier comes last", () => {
    const page = [row("Hassan Mohamed", "عامل"), row("A B", "محاسب"), row("E F", "Sales Representative"), row("I J", "Consultant"), row("K L", "Electrical Engineer")];
    expect(pick(page, 3)).toEqual(["Consultant", "Sales Representative", "Electrical Engineer"]);
    expect(pick(page, 5).slice(-2)).toEqual(["عامل", "محاسب"]);
  });
  it("the order inside a tier is the source's order", () => {
    const page = [row("a", "Manager A"), row("b", "عامل"), row("c", "Manager C"), row("d", "Manager D")];
    expect(pick(page, 3)).toEqual(["Manager A", "Manager C", "Manager D"]);
  });
});

describe("the limits sentence for companies whose people are not decision makers", () => {
  it("is built from the delivered people's titles: how many are not decision makers, in how many companies", () => {
    const people = [
      { parent_id: "c1", title: "Operations Manager" }, { parent_id: "c1", title: "Head of Projects" },
      { parent_id: "c2", title: "Sales Representative" }, { parent_id: "c2", title: "Consultant" },
      { parent_id: "c3", title: "Director" }, { parent_id: "c3", title: "عامل" },
    ];
    const text = decisionMakersLeftOutAr(people, "manager");
    expect(text).toContain("٣");          // three people are not decision makers
    expect(text).toContain("شركتين");     // in two companies
    expect(text).toMatch(/صناع القرار/);
    expect(text).not.toMatch(/[0-9]/);    // Arabic-Indic digits only
  });
  it("is null when every delivered person is a decision maker, or when no title is known", () => {
    expect(decisionMakersLeftOutAr([{ parent_id: "c1", title: "CEO" }, { parent_id: "c1", title: "Manager" }], "manager")).toBeNull();
    expect(decisionMakersLeftOutAr([{ parent_id: "c1" }, { parent_id: "c2" }], "manager")).toBeNull();
  });
});
