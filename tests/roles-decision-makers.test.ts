import { describe, expect, it } from "vitest";
import { rankPeopleByRole, roleOfNoun, titleRoleVerdict } from "../src/lib/agentMission/roles";

/**
 * LIVE RETEST 2026-10-31 (A1): «ومعاهم صناع القرار: اسم المدير، المسمى الوظيفي...». The people of each company came in the source's order: a «Group Talent Acquisition Senior Associate» before the Chairman. «صناع القرار» (the decision makers) named
 * no role in the table, so no title ranking applied at all, and a title that names an owner or a founder was only «unclear». The decision makers are the owner, the founders, the chairman, the CEO and the other chiefs, the general manager, the directors,
 * the managers and the heads: their titles come first (never excluded: when fewer match, the count is completed from the company's other people, titles as the source gave them).
 */
describe("decision makers are the manager role", () => {
  it.each(["صناع القرار", "صانع القرار", "المديرين", "مدراء", "مسؤولين", "decision makers"])("«%s» asks for the manager role", (noun) => {
    expect(roleOfNoun(noun)?.key).toBe("manager");
  });
  it.each([
    "Owner", "Founder & CEO", "Co-Founder", "Chairman", "Chairwoman of the Board", "General Manager", "Managing Director", "Director of Projects", "Head of Sales", "Group Chief Information Officer (CIO)", "CEO",
    "المدير العام", "رئيس مجلس الإدارة", "مالك الشركة", "المؤسس",
  ])("«%s» is a decision maker's title", (title) => {
    expect(titleRoleVerdict(title, "manager")).toBe("match");
  });
  it.each(["Group Talent Acquisition Senior Associate", "Accountant", "Civil Engineer", "Sales Representative", "Receptionist"])("«%s» is another role", (title) => {
    expect(titleRoleVerdict(title, "manager")).toBe("other");
  });
  it("an empty or a generic title stays unclear (never guessed, never excluded)", () => {
    expect(titleRoleVerdict("", "manager")).toBe("unclear");
    expect(titleRoleVerdict("Employee", "manager")).toBe("unclear");
    expect(titleRoleVerdict("Consultant", "manager")).toBe("unclear");
  });
  it("the people of a company come decision makers first, the source's order inside each group, and nobody is dropped", () => {
    const rows = [
      { name: "A", title: "Group Talent Acquisition Senior Associate" },
      { name: "B", title: "" },
      { name: "C", title: "Owner" },
      { name: "D", title: "Accountant" },
      { name: "E", title: "General Manager" },
      { name: "F", title: "Founder & CEO" },
    ];
    const ranked = rankPeopleByRole(rows, "manager");
    expect(ranked.rows.map((r) => r.name)).toEqual(["C", "E", "F", "B", "A", "D"]);
    expect(ranked.matching).toBe(3);
  });
});
