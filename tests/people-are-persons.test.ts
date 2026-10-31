import { describe, expect, it } from "vitest";
import { isRoleMailbox, personVerdict } from "../src/lib/agentMission/people";
import { createMemoryStore } from "../agent/src/memoryStore";
import { ItemStore } from "../agent/src/items/itemStore";
import { ingestRows } from "../agent/src/items/ingest";
import { companyMailboxesOf } from "../agent/src/runMission";
import type { PricedPlan } from "../src/lib/agentMission/plan";

/**
 * LIVE RETEST 2026-10-31 16:20 (Cairo), A1 «٥ شركات كهروميكانيكا + صناع القرار»: the people sheet held 9 rows; 8 had no name, all 9 had no job title, and most were role mailboxes (info@, customer_care@, totaline@, webmaster@, cs@, em.sales@).
 * They were counted as delivered PEOPLE and charged (14 of 15 -> 187 points). A2 (petroleum): «Petro Consultants» (petro.consultants@...) was a role mailbox counted as a person.
 * A person row must be a person: a name that is a person's, and not a role mailbox. Anything else is a company e-mail (it goes to the company's sheet), never a decision maker and never a charged item.
 */
const columns = [
  { key: "name", title_ar: "الاسم" },
  { key: "title", title_ar: "المسمى الوظيفي" },
  { key: "email", title_ar: "الإيميل", kind: "work_email" as const },
];

describe("a role or generic mailbox is not a person", () => {
  it.each([
    "info@x.com", "sales@x.com", "cs@x.com", "support@x.com", "webmaster@x.com", "customer_care@x.com", "customer.care@x.com", "customer-service@x.com", "hr@x.com", "contact@x.com", "admin@x.com",
    "office@x.com", "hello@x.com", "marketing@x.com", "careers@x.com", "enquiries@x.com", "noreply@x.com", "INFO@X.COM", "sales.egypt@x.com", "info2@x.com",
  ])("%s", (email) => {
    expect(isRoleMailbox(email)).toBe(true);
  });
  it.each(["osama@x.com", "osama.abou.shady@x.com", "hventer@x.com", "m.salah@x.com", "salesman.ahmed@x.com", "ahmed.hr@x.com", "totaline@x.com", "dkwarteng@x.com"])("%s is a personal-looking address (a name decides the rest)", (email) => {
    expect(isRoleMailbox(email)).toBe(false);
  });
});

describe("personVerdict: the verdict is by code, from the row", () => {
  const v = (row: Record<string, unknown>) => personVerdict(row, columns);
  it("A1's rows: no name at all is not a person, whatever the mailbox is", () => {
    expect(v({ name: "", title: "", email: "info@esweco.com" })).toEqual({ person: false, reason: "no_name" });
    expect(v({ name: "", title: "", email: "totaline@alexfaneg.com" })).toEqual({ person: false, reason: "no_name" });
    expect(v({ name: "", title: "", email: "em.sales@miraco.com.eg" })).toEqual({ person: false, reason: "no_name" });
    expect(v({ name: null, title: null, email: "cs@x.com" })).toEqual({ person: false, reason: "no_name" });
    expect(v({ title: "", email: "webmaster@x.com" })).toEqual({ person: false, reason: "no_name" });
  });
  it("A2's «Petro Consultants»: a name made from the mailbox, or from the company's own words, is not a person", () => {
    expect(v({ name: "Petro Consultants", title: "", email: "petro.consultants@petro.example.com" }).person).toBe(false);
    expect(v({ name: "Customer Care", title: "", email: "customer_care@x.com" }).person).toBe(false);
    expect(v({ name: "Sales Team", title: "", email: "team@x.com" }).person).toBe(false);
    expect(v({ name: "Info", title: "", email: "" }).person).toBe(false);
    expect(v({ name: "قسم المبيعات", title: "", email: "" }).person).toBe(false);
    expect(v({ name: "خدمة العملاء", title: "", email: "" }).person).toBe(false);
  });
  it("a role mailbox is not a person even when a person's name is written next to it", () => {
    expect(v({ name: "John Smith", title: "Sales", email: "sales@x.com" })).toEqual({ person: false, reason: "role_mailbox" });
  });
  it("real people are people: Latin and Arabic names, with or without a title or an e-mail", () => {
    expect(v({ name: "Osama Abou Shady", title: "Chairman", email: "osama@esweco.com" })).toEqual({ person: true });
    expect(v({ name: "Hendus Venter", title: "Group Chief Information Officer (CIO)", email: "hventer@mantracgroup.com" })).toEqual({ person: true });
    expect(v({ name: "Dickson Kwarteng", title: "", email: "dkwarteng@mantracgroup.com" })).toEqual({ person: true });
    expect(v({ name: "أحمد محمد علي", title: "", email: "" })).toEqual({ person: true });
    expect(v({ name: "محمد", title: "مدير عام", email: "" })).toEqual({ person: true });
    expect(v({ name: "Mona Said", title: "Director", email: "" })).toEqual({ person: true });
  });
  it("a first name and a last name in two columns are one name", () => {
    const cols = [{ key: "first_name", title_ar: "الاسم الأول" }, { key: "last_name", title_ar: "اسم العائلة" }, { key: "email", title_ar: "الإيميل", kind: "work_email" as const }];
    expect(personVerdict({ first_name: "Mona", last_name: "Said", email: "mona@x.com" }, cols)).toEqual({ person: true });
    expect(personVerdict({ first_name: "", last_name: "", email: "info@x.com" }, cols)).toEqual({ person: false, reason: "no_name" });
  });
  it("a row with no name column at all is judged by its e-mail only (a role mailbox is not a person; anything else passes)", () => {
    const cols = [{ key: "email", title_ar: "الإيميل", kind: "work_email" as const }];
    expect(personVerdict({ email: "info@x.com" }, cols).person).toBe(false);
    expect(personVerdict({ email: "mona@x.com" }, cols).person).toBe(true);
  });
});

describe("companyMailboxesOf: a company's mailboxes are gathered by company, and only for the stage whose rows ARE the companies", () => {
  const stage = (over: Record<string, unknown>) => ({ endpoint_id: "e", expected_rows: 10, planned_rows: 10, deliver: true, sample_rows: [], measured_by: [], ...over });
  const plan = () => ({
    summary_ar: "x", price: { deliveredRows: 10 },
    stages: [
      stage({ key: "companies", title_ar: "شركات كهروميكانيكا", parent_key: null, columns: [{ key: "name", title_ar: "اسم الشركة" }] }),
      stage({ key: "people", title_ar: "مسؤولو الشركات ومسمياتهم وإيميلاتهم", parent_key: "companies", per_parent_rows: 2, columns }),
      // the e-mail finder step of each person: also a title that names people, but its parent is a PEOPLE stage
      stage({ key: "emails", title_ar: "إيميلات المسؤولين", parent_key: "people", per_parent_rows: 1, columns: [{ key: "email", title_ar: "الإيميل", kind: "work_email" }] }),
    ],
  }) as unknown as PricedPlan;
  it("the mailboxes of the people stage go to the companies' stage; those of a step under a person do not", async () => {
    const store = createMemoryStore();
    const items = await ItemStore.open(store, "msn_people01");
    const p = plan();
    const deps = { items, plan: p, addEvent: async () => undefined };
    await ingestRows(deps, p.stages[0], [{ id: "c1", name: "Orascom" }, { id: "c2", name: "Nile" }], { silent: true, idField: null });
    await ingestRows(deps, p.stages[1], [
      { id: "c1-p0", parent_id: "c1", name: "Hossam Fathy", title: "General Manager", email: "hossam@orascom-em.com.eg" },
      { id: "c1-p1", parent_id: "c1", name: "", title: "", email: "info@orascom-em.com.eg" },
      { id: "c1-p2", parent_id: "c1", name: "", title: "", email: "info@orascom-em.com.eg" },
      { id: "c2-p0", parent_id: "c2", name: "", title: "", email: "customer_care@nile-em.com.eg" },
    ], { silent: true, idField: null });
    await ingestRows(deps, p.stages[2], [{ id: "c1-p0-e", parent_id: "c1-p0", email: "support@orascom-em.com.eg" }], { silent: true, idField: null });
    const mailboxes = companyMailboxesOf(p, items.snapshotOfMemory());
    expect(Object.keys(mailboxes)).toEqual(["companies"]);
    expect(mailboxes.companies.get("c1")).toEqual(["info@orascom-em.com.eg"]);
    expect(mailboxes.companies.get("c2")).toEqual(["customer_care@nile-em.com.eg"]);
    expect(items.counts("people").accepted).toBe(1);
    expect(items.counts("people").excludedByReason.not_a_person).toBe(3);
  });
});
