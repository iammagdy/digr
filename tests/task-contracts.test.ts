import { describe, expect, it } from "vitest";
import { usefulFieldsOfPage, uncoveredFields, classOfField } from "../src/lib/agentMission/fields";
import {
  COMPANY_SHEET_ORDER, PERSON_SHEET_ORDER, OWNER_SHEET_HEADERS_AR, TASK_CONTRACTS, contractTypeOf, contractIssuesFor, withContractColumns, requiredSourceClasses,
} from "../src/lib/agentMission/taskContracts";

/**
 * AUDIT 2026-11 §1 and §6 PR 1 (a): THE REFERENCE AS DATA. What a delivery must contain is written once (taskContracts.ts); the plan check refuses a plan that drops a class the source gives and the workbook builder reads the same table.
 */

/** The page of the free companies source, as the catalog describes it (tomba.companies.search.reveal): a phone, a street address and a count of e-mails per company. */
const COMPANIES_PAGE = JSON.stringify({ companies: [
  { name: "ESWECO", website_url: "https://esweco.com", industry: "Electrical", country: "EG", city: "Cairo", street_address: "12 Industrial Zone, 10th of Ramadan", postal_code: "11111", phone_number: "+20 15 3636 000", total_emails: 4, linkedin_url: "https://linkedin.com/company/esweco" },
  { name: "ELSEWEDY", website_url: "https://elsewedy.com", industry: "Cables", country: "EG", city: "Cairo", street_address: "Nasr City", phone_number: "+20 2 2222 2222", total_emails: 9 },
] });
const PLACES_PAGE = JSON.stringify({ places: [
  { name: "صيدلية العزبي", address: "شارع عباس العقاد، مدينة نصر", phone: "+20 2 2402 1111", rating: 4.6, review_count: 311, url: "https://maps.google.com/?cid=1", website: "https://elezaby.com" },
] });

describe("the reference of audit section 1, as data", () => {
  it("the owner's hand-built sheet is the reference: the company sheet then the person sheet give its columns in its order", () => {
    expect(OWNER_SHEET_HEADERS_AR).toEqual(["م", "اسم الشركة", "النشاط والتخصص", "الموقع الإلكتروني", "الإيميل العام للشركة", "هاتف المقر الرئيسي", "اسم صانع القرار", "المسمى الوظيفي", "إيميل المسؤول المباشر", "هاتف / محمول المسؤول", "ملاحظات"]);
    // the company sheet has its own notes column too; in the one-table sheet of the owner the notes are the last column
    const order = [...COMPANY_SHEET_ORDER.filter((c) => c.cls !== "notes"), ...PERSON_SHEET_ORDER].map((c) => c.title_ar);
    const withoutExtras = order.filter((t, i) => order.indexOf(t) === i && t !== "صانع قرار");
    expect(withoutExtras).toEqual(OWNER_SHEET_HEADERS_AR);
  });
  it("every task type of the audit has a contract; a plan with a company stage that is the parent of a people stage is «companies and decision makers»", () => {
    expect(Object.keys(TASK_CONTRACTS).sort()).toEqual(["comments", "companies", "companies_people", "places", "posts"]);
    const company = { key: "companies", title_ar: "شركات مصرية", parent_key: null, deliver: true, endpoint_id: "tomba.companies.search.reveal", columns: [] };
    const people = { key: "people", title_ar: "صناع القرار في كل شركة", parent_key: "companies", deliver: true, endpoint_id: "aviato.companies.employees", role_preference: { role: "manager" }, columns: [] };
    expect(contractTypeOf([company, people])).toBe("companies_people");
    expect(contractTypeOf([company])).toBe("companies");
  });
  it("the comments contract carries the parent's title and link on every row, and the places contract has the six columns of the audit", () => {
    expect(TASK_CONTRACTS.comments.child.map((c) => c.cls)).toEqual(expect.arrayContaining(["parent_title", "parent_link"]));
    expect(TASK_CONTRACTS.places.item.map((c) => c.cls)).toEqual(["place_name", "place_address", "place_phone", "place_rating", "place_reviews", "place_link"]);
  });
});

describe("the new field classes: a company's phone and address, a place's phone, rating and review count", () => {
  it("the page of the companies source gives a phone and an address, which no earlier class knew", () => {
    const classes = usefulFieldsOfPage(COMPANIES_PAGE).map((f) => f.cls);
    expect(classes).toEqual(expect.arrayContaining(["phone", "address"]));
    expect(classOfField("phone_number", "+20 15 3636 000")).toBe("phone");
    expect(classOfField("street_address", "12 Industrial Zone")).toBe("address");
    expect(classOfField("total_emails", 4)).toBeNull();
  });
  it("a place's review count is its own class (it used to read as «views»), and a rating stays a rating", () => {
    expect(classOfField("review_count", 311)).toBe("review_count");
    expect(classOfField("reviewCount", 311)).toBe("review_count");
    expect(classOfField("rating", 4.6)).toBe("rating");
    const classes = usefulFieldsOfPage(PLACES_PAGE).map((f) => f.cls);
    expect(classes).toEqual(expect.arrayContaining(["phone", "address", "rating", "review_count", "link"]));
    expect(classes).not.toContain("view");
  });
  it("a column holds the class by its Arabic title or its key", () => {
    const fields = usefulFieldsOfPage(COMPANIES_PAGE);
    const without = [{ key: "name", title_ar: "اسم الشركة" }, { key: "website", title_ar: "الموقع الإلكتروني" }];
    expect(uncoveredFields(fields, without).map((f) => f.cls)).toEqual(expect.arrayContaining(["phone", "address"]));
    const withThem = [...without, { key: "phone", title_ar: "هاتف المقر الرئيسي" }, { key: "address", title_ar: "العنوان" }];
    expect(uncoveredFields(fields, withThem).map((f) => f.cls)).not.toContain("phone");
    expect(uncoveredFields(fields, withThem).map((f) => f.cls)).not.toContain("address");
  });
});

describe("the plan check refuses a plan that drops a class the source gives", () => {
  const company = (columns: Array<{ key: string; title_ar: string }>) => ({ key: "companies", title_ar: "شركات مصرية", parent_key: null, deliver: true, endpoint_id: "tomba.companies.search.reveal", columns });
  const fields = usefulFieldsOfPage(COMPANIES_PAGE);
  it("a company stage that leaves out the HQ phone or the address the source gave is refused, naming each in Arabic", () => {
    const issues = contractIssuesFor(company([{ key: "name", title_ar: "اسم الشركة" }, { key: "website", title_ar: "الموقع" }]), fields, "company");
    expect(issues.length).toBe(1);
    expect(issues[0]).toContain("رقم الهاتف");
    expect(issues[0]).toContain("العنوان");
    expect(issues[0]).toContain("phone_number");
  });
  it("with a column for each, nothing is refused", () => {
    // (CHANGED in part b: the reference's third column, the sector and activity, is a required class of a company stage too: the source gives `industry`)
    const cols = [{ key: "name", title_ar: "اسم الشركة" }, { key: "industry", title_ar: "النشاط والتخصص" }, { key: "website", title_ar: "الموقع" }, { key: "phone", title_ar: "هاتف المقر الرئيسي" }, { key: "address", title_ar: "العنوان" }];
    expect(contractIssuesFor(company(cols), fields, "company")).toEqual([]);
  });
  it("the new classes are required only where the contract says so (a company, a place), never on a stage of posts or people", () => {
    expect(requiredSourceClasses("company")).toEqual(expect.arrayContaining(["phone", "address", "email"]));
    expect(requiredSourceClasses("place")).toEqual(expect.arrayContaining(["phone", "address", "rating", "review_count"]));
    expect(requiredSourceClasses("other")).toEqual([]);
    expect(contractIssuesFor(company([{ key: "name", title_ar: "الاسم" }]), fields, "other")).toEqual([]);
  });
  it("a place stage that drops the review count or the rating the source gave is refused", () => {
    const place = { key: "places", title_ar: "صيدليات", parent_key: null, deliver: true, endpoint_id: "crawl4ai.google.serp.maps", columns: [{ key: "name", title_ar: "الاسم" }, { key: "address", title_ar: "العنوان" }, { key: "phone", title_ar: "التليفون" }, { key: "url", title_ar: "الرابط" }] };
    const issues = contractIssuesFor(place, usefulFieldsOfPage(PLACES_PAGE), "place");
    expect(issues.length).toBe(1);
    expect(issues[0]).toContain("التقييم");
    expect(issues[0]).toContain("عدد التقييمات");
  });
});

describe("the contract columns of a company and its people, by code", () => {
  const companyStage = { key: "companies", title_ar: "شركات مصرية", parent_key: null, deliver: true, endpoint_id: "tomba.companies.search.reveal", columns: [
    { key: "name", title_ar: "الشركة" }, { key: "city", title_ar: "المدينة" }, { key: "website", title_ar: "موقع" }, { key: "industry", title_ar: "القطاع" }, { key: "phone_number", title_ar: "التليفون" },
  ] };
  const peopleStage = { key: "people", title_ar: "صناع القرار في كل شركة", parent_key: "companies", deliver: true, endpoint_id: "aviato.companies.employees", role_preference: { role: "manager" }, columns: [
    { key: "linkedin", title_ar: "الملف المهني" }, { key: "title", title_ar: "الوظيفة" }, { key: "name", title_ar: "الاسم" },
    { key: "email", title_ar: "الإيميل", kind: "work_email" as const }, { key: "email_status", title_ar: "حالة توثيق الإيميل", status_of: "email" },
    { key: "phone", title_ar: "رقم التليفون", kind: "phone" as const }, { key: "phone_status", title_ar: "حالة توثيق رقم التليفون", status_of: "phone" },
  ] };
  it("the company sheet gets the reference columns in the reference order, the planner's other columns after them", () => {
    const [c] = withContractColumns([companyStage, peopleStage]);
    const titles = c.columns.map((x) => x.title_ar);
    expect(titles.slice(0, 6)).toEqual(["اسم الشركة", "النشاط والتخصص", "الموقع الإلكتروني", "الإيميل العام للشركة", "حالة توثيق الإيميل العام للشركة", "هاتف المقر الرئيسي"]);
    expect(titles).toContain("المدينة");
    expect(titles.indexOf("المدينة")).toBeGreaterThan(titles.indexOf("هاتف المقر الرئيسي"));
    expect(new Set(titles).size).toBe(titles.length);
  });
  it("the person sheet is in the reference order: name, title, the decision-maker marker, e-mail with status, phone with status", () => {
    const [, p] = withContractColumns([companyStage, peopleStage]);
    const titles = p.columns.map((x) => x.title_ar);
    expect(titles.slice(0, 3)).toEqual(["اسم صانع القرار", "المسمى الوظيفي", "صانع قرار"]);
    expect(titles.indexOf("إيميل المسؤول المباشر")).toBeGreaterThan(2);
    expect(titles.indexOf("حالة توثيق إيميل المسؤول المباشر")).toBe(titles.indexOf("إيميل المسؤول المباشر") + 1);
    expect(titles.indexOf("هاتف / محمول المسؤول")).toBeGreaterThan(titles.indexOf("إيميل المسؤول المباشر"));
  });
  it("it is idempotent, and the planner's own keys are kept (the engine and the mapping still fill them)", () => {
    const once = withContractColumns([companyStage, peopleStage]);
    const twice = withContractColumns(once);
    expect(twice.map((s) => s.columns)).toEqual(once.map((s) => s.columns));
    expect(once[0].columns.find((c) => c.key === "phone_number")?.title_ar).toBe("هاتف المقر الرئيسي");
    expect(once[1].columns.find((c) => c.key === "email")?.title_ar).toBe("إيميل المسؤول المباشر");
    expect(once[1].columns.find((c) => c.key === "name")?.title_ar).toBe("اسم صانع القرار");
  });
  it("a plan of employees (no decision-maker role) gets the order but neither the marker nor a notes column: there is no such finding to note", () => {
    const employees = { ...peopleStage, role_preference: undefined };
    const [c, p] = withContractColumns([companyStage, employees]);
    expect(c.columns.map((x) => (x as { computed?: string }).computed)).not.toContain("notes");
    expect(p.columns.map((x) => (x as { computed?: string }).computed ?? null).filter(Boolean)).toEqual([]);
    expect(p.columns.map((x) => x.title_ar)).not.toContain("صانع قرار");
    // the planner's own titles are kept for people who are not «decision makers»
    expect(p.columns.find((x) => x.key === "name")?.title_ar).toBe("الاسم");
  });
  it("a plan with no people stage, or a stage of posts, is not touched", () => {
    const posts = { key: "posts", title_ar: "تغريدات", parent_key: null, deliver: true, endpoint_id: "x.search", columns: [{ key: "text", title_ar: "النص" }] };
    expect(withContractColumns([posts])[0].columns).toEqual(posts.columns);
    const companiesOnly = withContractColumns([companyStage])[0].columns;
    expect(companiesOnly.map((c) => c.title_ar)).toEqual(companyStage.columns.map((c) => c.title_ar));
  });
});
