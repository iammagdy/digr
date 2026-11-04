import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildB2BAsk } from "../src/lib/agentMission/stage3/b2bAsk";
import {
  B2B_NOT_SEARCHED_AR,
  compileB2BPlan,
  fillColumn,
  gapLineAr,
  markCellAr,
  removeExactDuplicates,
  resolveField,
  type Attempt,
} from "../src/lib/agentMission/stage3/b2bCompile";
import { NOT_AVAILABLE_AR, COMPANY_EMAIL_TITLE_AR, COMPANY_PHONE_TITLE_AR } from "../src/lib/agentMission/taskContracts";
import { checkCustomerLabel, checkCustomerText } from "../src/lib/agentMission/text";

/**
 * STAGE 3 (docs/STAGE-3.md), THE B2B COMPILER: the column plan (the company's general e-mail and HQ phone as columns; people with their e-mail and mobile; a condition no chosen tool carries
 * as a MARK column, never a filter), the fallthrough chain (every relevant tool tried before «غير متوفر»), exact-duplicate removal only, and the gaps written in the file.
 * Rows: the committed, clearly fake rows of tests/fixtures/extraction/companies-electricity-eg.json (example.eg sites), extended here with fake values only.
 */
const companies = (JSON.parse(readFileSync(new URL("./fixtures/extraction/companies-electricity-eg.json", import.meta.url), "utf8")) as { rows: Array<{ row: Record<string, unknown> }> }).rows.map((r) => r.row);
const LIVE_7539 = "عايز ٥ شركات مصرية في قطاع الكهروميكانيكا، ومعاهم صناع القرار";

describe("no verified card for a role: nothing is offered to a customer", () => {
  it("a request whose role has only unverified cards is not planned, and the unverified tools are named for the admin (a people request: the people search has no verified card)", () => {
    const r = compileB2BPlan(buildB2BAsk("هات ١٥ مدير تسويق في مصر مع الإيميل والموبايل")!);
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.reason).toBe("no_verified_card"); expect(r.role).toBe("people.search"); expect(r.unverified.length).toBeGreaterThan(0); }
  });
  it("with no card at all, the first role is the one named", () => {
    const r = compileB2BPlan(buildB2BAsk(LIVE_7539)!, { cards: [] });
    expect(r.ok === false && r.reason === "no_verified_card" && r.role === "companies.search").toBe(true);
  });
});

describe("the column plan (test switch: unverified cards allowed, never on a customer path)", () => {
  const plan = compileB2BPlan(buildB2BAsk(LIVE_7539)!, { allowUnverified: true });
  if (!plan.ok) throw new Error(plan.reason);
  it("the company sheet: the owner's reference columns, the HQ beside them, the general e-mail and the HQ phone as columns", () => {
    expect(plan.columns.company.map((c) => c.titleAr)).toEqual(["م", "اسم الشركة", "النشاط والتخصص", "الموقع الإلكتروني", "المقر الرئيسي", COMPANY_EMAIL_TITLE_AR, COMPANY_PHONE_TITLE_AR, "ملاحظات"]);
  });
  it("the people sheet: name, title, the decision-maker mark, e-mail and mobile", () => {
    expect(plan.columns.person!.map((c) => c.titleAr)).toEqual(["م", "اسم صانع القرار", "المسمى الوظيفي", "صانع قرار", "إيميل المسؤول المباشر", "هاتف / محمول المسؤول", "ملاحظات"]);
  });
  it("every column title passes the customer-label rules", () => {
    for (const c of [...plan.columns.company, ...(plan.columns.person ?? [])]) expect(checkCustomerLabel(c.titleAr).issues, c.titleAr).toEqual([]);
  });
  it("the chain of each contact column: every relevant tool, cheapest first, the search's own field before a lookup", () => {
    // the companies tool gives no HQ phone (its `phone_number` is a boolean flag on the real pages), so the chain is the maps lookups only
    expect(plan.chains.hq_phone).toEqual(["crawl4ai.google.serp.maps", "anyapi.google.serp.maps"]);
    expect(plan.peopleCard).toBe("blitzapi.people.employee-finder");
    expect(plan.chains.email).toEqual(["blitzapi.people.email.find", "treg.people.email.find", "tomba.people.email.find", "hunter.people.email.find"]);
    expect(plan.chains.mobile).toEqual(["blitzapi.people.phone.find", "treg.people.phone.find", "aiark.people.phone.find", "tomba.people.phone.find"]);
    expect(plan.chains.general_email).toEqual(["tomba.companies.emails.list"]);
  });
  it("the companies tool is the one that carries the most conditions of the Ask, then the cheapest", () => {
    expect(plan.companiesCard).toBe("tomba.companies.search.reveal");
  });
});

describe("a condition no chosen tool carries becomes a MARK column, never a filter", () => {
  const ask = buildB2BAsk("هات ٢٠ شركة برمجيات في الإمارات عدد موظفيها أكثر من ٥٠ وتأسست بعد ٢٠١٥")!;
  // the CUSTOMER path (verified cards only). With the unverified switch on, the verified card still ranks first (Part A.4, tests/stage3-b2b-ranking.test.ts).
  const plan = compileB2BPlan(ask);
  if (!plan.ok) throw new Error(plan.reason);
  it("no chosen tool is shown to carry a size or a founding year (the real tomba pages echo only a country and an industry filter), so both are mark columns before the notes", () => {
    expect(plan.companiesCard).toBe("tomba.companies.search.reveal");
    expect(plan.marks.map((m) => m.titleAr)).toEqual(["عدد الموظفين أكثر من ٥٠", "تأسست بعد ٢٠١٥"]);
    expect(plan.columns.company.map((c) => c.titleAr).slice(-3)).toEqual(["عدد الموظفين أكثر من ٥٠", "تأسست بعد ٢٠١٥", "ملاحظات"]);
  });
  it("the mark says «نعم», «لا» or «غير معروف» from the row's own value; no row is removed", () => {
    const m = plan.marks.find((x) => x.condition.kind === "founded_after")!;
    expect(markCellAr(m.condition, { founded: 2018 })).toBe("نعم");
    expect(markCellAr(m.condition, { founded: "2010" })).toBe("لا");
    expect(markCellAr(m.condition, {})).toBe("غير معروف");
    expect(markCellAr({ kind: "size_min", value: 50 }, { employees: "51-200" })).toBe("نعم");
    expect(markCellAr({ kind: "size_min", value: 50 }, { employees: "11-50" })).toBe("لا");
    expect(markCellAr({ kind: "size_min", value: 50 }, { employees: "11-100" })).toBe("غير معروف");
    expect(markCellAr({ kind: "size_max", value: 200 }, { employees: 120 })).toBe("نعم");
  });
});

describe("exact duplicates only", () => {
  it("a row identical in every value is removed once; a row that differs in any value is kept (no fuzzy matching)", () => {
    const rows = [companies[0], { ...companies[0] }, { ...companies[0], website: "https://delta-power.example.eg/" }, { ...companies[0], company_name: "Delta Power Distribution." }, companies[1], { ...companies[1], description: ` ${String(companies[1].description)} ` }];
    const r = removeExactDuplicates(rows);
    expect(r.removed).toBe(2);
    expect(r.rows).toHaveLength(4);
    expect(r.rows[0]).toBe(companies[0]);
  });
});

describe("the fallthrough: every relevant tool is tried before «غير متوفر»", () => {
  const chain = ["a.cheap", "b.mid", "c.dear"];
  const A = (endpointId: string, outcome: Attempt["outcome"], value?: string): Attempt => (outcome === "value" ? { endpointId, outcome, value: value! } : { endpointId, outcome } as Attempt);
  it("the first tool of the chain that gives a value wins; a failure or an empty answer passes to the next", () => {
    expect(resolveField(chain, [A("a.cheap", "empty"), A("b.mid", "failed"), A("c.dear", "value", "info@example.eg")])).toEqual({ kind: "value", value: "info@example.eg", by: "c.dear" });
    expect(resolveField(chain, [A("b.mid", "value", "x@example.eg"), A("a.cheap", "value", "y@example.eg")])).toEqual({ kind: "value", value: "y@example.eg", by: "a.cheap" });
  });
  it("«غير متوفر» only when every tool of the chain answered with nothing or failed", () => {
    expect(resolveField(chain, [A("a.cheap", "empty"), A("b.mid", "failed"), A("c.dear", "empty")])).toEqual({ kind: "unavailable", tried: chain });
  });
  it("a tool not tried (or refused by the daily cap) means the search is INCOMPLETE, never «غير متوفر»", () => {
    expect(resolveField(chain, [A("a.cheap", "empty"), A("b.mid", "refused")])).toEqual({ kind: "incomplete", missing: ["b.mid", "c.dear"] });
    expect(resolveField([], [])).toEqual({ kind: "incomplete", missing: [] });
  });
  it("a column of five companies: cells and the gap, written in the file", () => {
    const ids = ["co_1", "co_2", "co_3", "co_4", "co_5"];
    const attempts: Record<string, Attempt[]> = {
      co_1: [A("a.cheap", "value", "info@one.example.eg")],
      co_2: [A("a.cheap", "empty"), A("b.mid", "value", "contact@two.example.eg")],
      co_3: [A("a.cheap", "empty"), A("b.mid", "empty"), A("c.dear", "empty")],
      co_4: [A("a.cheap", "failed"), A("b.mid", "empty"), A("c.dear", "failed")],
      co_5: [A("a.cheap", "empty")],
    };
    const r = fillColumn(ids, chain, attempts);
    expect(ids.map((id) => r.cells[id])).toEqual(["info@one.example.eg", "contact@two.example.eg", NOT_AVAILABLE_AR, NOT_AVAILABLE_AR, B2B_NOT_SEARCHED_AR]);
    expect(r.gap).toEqual({ total: 5, found: 2, unavailable: 2, incomplete: 1, tools: 3 });
    const line = gapLineAr(COMPANY_EMAIL_TITLE_AR, r.gap, "company");
    expect(line).toBe("الإيميل العام للشركة: وُجد لشركتين من ٥ شركات، وغير متوفر لشركتين بعد تجربة ٣ مصادر، ولم يكتمل البحث لشركة واحدة.");
    expect(checkCustomerText(line).issues).toEqual([]);
    expect(checkCustomerText(B2B_NOT_SEARCHED_AR).issues).toEqual([]);
  });
  it("S7 wording: a column where NOTHING was found never says «لم يوجد» for a search that was not completed", () => {
    // every source tried and nothing found: «غير متوفر»
    expect(gapLineAr(COMPANY_EMAIL_TITLE_AR, { total: 5, found: 0, unavailable: 5, incomplete: 0, tools: 3 }, "company")).toBe("الإيميل العام للشركة: غير متوفر لكل الشركات (٥ شركات) بعد تجربة ٣ مصادر.");
    // no source was tried (none verified, or the cap refused them all): the search is INCOMPLETE, not a negative answer
    expect(gapLineAr(COMPANY_EMAIL_TITLE_AR, { total: 5, found: 0, unavailable: 0, incomplete: 5, tools: 0 }, "company")).toBe("الإيميل العام للشركة: لم يكتمل البحث لكل الشركات (٥ شركات).");
    // nothing found, some tried to the end and some not
    expect(gapLineAr(COMPANY_PHONE_TITLE_AR, { total: 5, found: 0, unavailable: 2, incomplete: 3, tools: 2 }, "company")).toBe("هاتف المقر الرئيسي: غير متوفر لشركتين بعد تجربة مصدرين، ولم يكتمل البحث لـ ٣ شركات.");
    // one company
    expect(gapLineAr(COMPANY_PHONE_TITLE_AR, { total: 1, found: 0, unavailable: 1, incomplete: 0, tools: 1 }, "company")).toBe("هاتف المقر الرئيسي: غير متوفر للشركة بعد تجربة مصدر واحد.");
    for (const g of [{ total: 5, found: 0, unavailable: 5, incomplete: 0, tools: 3 }, { total: 5, found: 0, unavailable: 0, incomplete: 5, tools: 0 }, { total: 5, found: 0, unavailable: 2, incomplete: 3, tools: 2 }, { total: 1, found: 0, unavailable: 1, incomplete: 0, tools: 1 }]) {
      const line = gapLineAr(COMPANY_PHONE_TITLE_AR, g, "company");
      expect(checkCustomerText(line).issues, line).toEqual([]);
      expect(line, line).not.toContain("لم يوجد");
    }
  });
  it("no gap: the line says every one was found", () => {
    expect(gapLineAr(COMPANY_PHONE_TITLE_AR, { total: 3, found: 3, unavailable: 0, incomplete: 0, tools: 2 }, "company")).toBe("هاتف المقر الرئيسي: وُجد لكل الشركات (٣ شركات).");
  });
});
