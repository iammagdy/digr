import { describe, expect, it } from "vitest";
import { loadTregCatalog, isSellable } from "../src/lib/treg/catalog";
import { blockedEndpointReason } from "../src/lib/treg/blockList";
import { peopleSourcesForCompanies } from "../src/lib/agentMission/childSources";
import { phoneSourcesOf, peopleAndContactAdvice, type PeopleCheckInput } from "../src/lib/agentMission/peopleCheck";

/**
 * LIVE RETEST 2026-10-31 16:20 (A1, A2). The plan's people stage read «a company's e-mails by its domain» (a MAILBOX lister: `companies.emails.list`) and was delivered as people: eight of nine rows had no name, none had a title. The catalog's real people
 * sources (employee finders: a name, a title, a profile link) were sampled and given up (A1: one gave five named people and was not used; A2: three people sources were refused for the planning budget and never read). Phones were dropped with a sentence
 * («التليفونات لم تُظهر أرقاما في المصادر») although no phone source had been sampled for the people found.
 *
 * Names and titles come from a PEOPLE source; the e-mail and the phone are separate contact steps; at least two people sources are tried before a plan settles for anything else; phone sources are tried for the people found within the budget, and a phone
 * that no source gave is said honestly on the card. Code checks it from what the mission REALLY called.
 */
const catalog = loadTregCatalog();
const allowed = (id: string) => isSellable(id, catalog) && !blockedEndpointReason(id);

describe("the catalog's people sources", () => {
  const people = peopleSourcesForCompanies(catalog, allowed).map((p) => p.id);
  it("an e-mail lister is NOT a people source: its rows are mailboxes", () => {
    expect(people).not.toContain("tomba.companies.emails.list");
    expect(people).not.toContain("icypeas.companies.emails.role");
  });
  it("the employee finders are, cheapest first, whatever company field they take", () => {
    expect(people).toContain("blitzapi.people.employee-finder");
    expect(people).toContain("aviato.companies.employees");
    expect(people).toContain("anyapi.linkedin.company.people");
    expect(people.indexOf("blitzapi.people.employee-finder")).toBeLessThan(people.indexOf("anyapi.linkedin.company.people"));
  });
  it("the phone sources are the catalog's phone finders, cheapest first", () => {
    const phones = phoneSourcesOf(catalog, allowed).map((p) => p.id);
    expect(phones).toContain("blitzapi.people.phone.find");
    expect(phones).toContain("quickenrich.people.phone.find");
    expect(phones.length).toBeGreaterThan(3);
  });
});

describe("peopleAndContactAdvice", () => {
  const people = peopleSourcesForCompanies(catalog, allowed).map((p) => p.id);
  const phones = phoneSourcesOf(catalog, allowed).map((p) => p.id);
  const col = (key: string, title_ar: string, kind?: string) => ({ key, title_ar, ...(kind ? { kind } : {}) });
  const companiesStage = { key: "companies", title_ar: "الشركات المصرية في قطاع الكهروميكانيكا", endpoint_id: "tomba.companies.search.reveal", parent_key: null, deliver: true, columns: [col("name", "اسم الشركة"), col("website", "الموقع")] };
  const peopleStage = (endpoint: string, columns = [col("name", "الاسم"), col("title", "المسمى الوظيفي"), col("email", "الإيميل", "work_email")]) => ({ key: "people", title_ar: "مسؤولو الشركات ومسمياتهم وإيميلاتهم", endpoint_id: endpoint, parent_key: "companies", deliver: true, columns });
  const input = (o: { stages: unknown[]; request?: string; called?: Array<[string, number]>; assumptions?: string[]; evidence?: Record<string, string> }): PeopleCheckInput => ({
    plan: { stages: o.stages as never, ...(o.assumptions ? { assumptions_ar: o.assumptions } : {}) },
    requestText: o.request ?? "عايز ٥ شركات مصرية في قطاع الكهروميكانيكا، ومعاهم صناع القرار: اسم المدير، المسمى الوظيفي، الإيميل، ورقم التليفون",
    capabilityOf: (id) => catalog.byId.get(id)?.capability ?? null,
    peopleSources: people,
    phoneSources: phones,
    calls: new Map((o.called ?? []).map(([id, rows]) => [id, { rows }] as const)),
    evidenceOf: (key) => o.evidence?.[key] ?? null,
  });
  const text = (xs: string[]) => xs.join(" | ");

  it("A1: the people stage reads a mailbox lister while a people source gave five named people: refused, naming the people sources", () => {
    const issues = peopleAndContactAdvice(input({ stages: [companiesStage, peopleStage("tomba.companies.emails.list")], called: [["blitzapi.people.employee-finder", 5], ["anyapi.linkedin.company.people", 0]] }));
    expect(text(issues)).toContain("mailbox");
    expect(text(issues)).toContain("blitzapi.people.employee-finder");
  });
  it("A2: only one people source was ever tried (the others were refused for the budget): refused, sample another", () => {
    const issues = peopleAndContactAdvice(input({ stages: [companiesStage, peopleStage("tomba.companies.emails.list")], called: [["anyapi.linkedin.company.people", 0]] }));
    expect(text(issues)).toMatch(/at least two/);
  });
  it("two people sources were really tried and gave no rows: the lister is accepted (code then keeps only the persons)", () => {
    const issues = peopleAndContactAdvice(input({ stages: [companiesStage, peopleStage("tomba.companies.emails.list")], request: "عايز ٥ شركات مصرية في قطاع الكهروميكانيكا، ومعاهم المديرين", called: [["blitzapi.people.employee-finder", 0], ["aviato.companies.employees", 0]] }));
    expect(issues).toEqual([]);
  });
  it("a plan whose people stage is a people source is not questioned about it", () => {
    const issues = peopleAndContactAdvice(input({ stages: [companiesStage, peopleStage("blitzapi.people.employee-finder")], request: "عايز ٥ شركات مصرية في قطاع الكهروميكانيكا، ومعاهم المديرين", called: [["blitzapi.people.employee-finder", 5]] }));
    expect(issues).toEqual([]);
  });
  it("a request with no people asks nothing of the people stage", () => {
    const issues = peopleAndContactAdvice(input({ stages: [companiesStage], request: "عايز ٥ شركات مصرية في قطاع البترول" }));
    expect(issues).toEqual([]);
  });

  it("phones asked, no phone column, no phone source ever sampled: refused, naming the phone sources", () => {
    const issues = peopleAndContactAdvice(input({ stages: [companiesStage, peopleStage("blitzapi.people.employee-finder")], called: [["blitzapi.people.employee-finder", 5]] }));
    expect(text(issues)).toContain("phone");
    expect(text(issues)).toContain("blitzapi.people.phone.find");
  });
  it("a phone source gave a number: the phone is in the plan, not dropped", () => {
    const issues = peopleAndContactAdvice(input({ stages: [companiesStage, peopleStage("blitzapi.people.employee-finder")], called: [["blitzapi.people.employee-finder", 5], ["blitzapi.people.phone.find", 1], ["quickenrich.people.phone.find", 0]], assumptions: ["التليفونات غير متاحة"] }));
    expect(text(issues)).toMatch(/gave (a number|rows)/);
  });
  it("two phone sources tried and none gave a number, and the plan says so honestly: accepted", () => {
    const issues = peopleAndContactAdvice(input({ stages: [companiesStage, peopleStage("blitzapi.people.employee-finder")], called: [["blitzapi.people.employee-finder", 5], ["blitzapi.people.phone.find", 0], ["quickenrich.people.phone.find", 0]], assumptions: ["لم يعطِ أي مصدر جرّبناه أرقام تليفون لهؤلاء المسؤولين، فلن تظهر في الملف"] }));
    expect(issues).toEqual([]);
  });
  it("two phone sources tried, none gave a number, and the card does not say so: refused until it does (never dropped silently)", () => {
    const issues = peopleAndContactAdvice(input({ stages: [companiesStage, peopleStage("blitzapi.people.employee-finder")], called: [["blitzapi.people.employee-finder", 5], ["blitzapi.people.phone.find", 0], ["quickenrich.people.phone.find", 0]] }));
    expect(text(issues)).toContain("say honestly");
  });
  it("a phone column in the plan (a people stage's or the company's own) satisfies the request", () => {
    const withPhone = peopleStage("blitzapi.people.employee-finder", [col("name", "الاسم"), col("title", "المسمى"), col("phone", "التليفون", "phone")]);
    expect(peopleAndContactAdvice(input({ stages: [companiesStage, withPhone], called: [["blitzapi.people.employee-finder", 5]] }))).toEqual([]);
    const companyPhone = { ...companiesStage, columns: [...companiesStage.columns, col("phone", "تليفون الشركة", "phone")] };
    expect(peopleAndContactAdvice(input({ stages: [companyPhone, peopleStage("blitzapi.people.employee-finder")], called: [["blitzapi.people.employee-finder", 5]] }))).toEqual([]);
  });
  it("no personal number, but the companies' own page carries a company phone: it goes in the company sheet", () => {
    const issues = peopleAndContactAdvice(input({
      stages: [{ ...companiesStage, measured_by: ["call_0001"] }, peopleStage("blitzapi.people.employee-finder")],
      called: [["blitzapi.people.employee-finder", 5], ["blitzapi.people.phone.find", 0], ["quickenrich.people.phone.find", 0]],
      assumptions: ["لم يعطِ أي مصدر أرقام تليفون لهؤلاء المسؤولين"],
      evidence: { companies: '{"companies":[{"name":"ESWECO","phone":"+20 3 4567890","website":"esweco.com"}]}' },
    }));
    expect(text(issues)).toContain("company phone");
  });
  it("a request that asks for no phone is never asked about phones", () => {
    const issues = peopleAndContactAdvice(input({ stages: [companiesStage, peopleStage("blitzapi.people.employee-finder")], request: "عايز ٥ شركات مصرية في قطاع الكهروميكانيكا، ومعاهم المديرين بالاسم والإيميل", called: [["blitzapi.people.employee-finder", 5]] }));
    expect(issues).toEqual([]);
  });
});
