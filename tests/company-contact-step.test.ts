import { describe, expect, it } from "vitest";
import { loadTregCatalog, isSellable } from "../src/lib/treg/catalog";
import { blockedEndpointReason } from "../src/lib/treg/blockList";
import { policyVerdict } from "../src/lib/treg/dataPolicy";
import { NOT_ADMIN } from "./helpers/agentHarness";
import { childStepSourcesFor } from "../src/lib/agentMission/childSources";
import { validateAndPricePlan, priceIncludesLinesAr, type PlanLookup } from "../src/lib/agentMission/plan";
import { buildCompanySteps, companyPhoneSourcesOf, companyMailboxIn, finderSourcesOf, mailboxListerSourcesOf, validatorSourcesOf, verifierSourcesOf, withContactColumns } from "../src/lib/agentMission/contactFinders";
import { checkCustomerText } from "../src/lib/agentMission/text";
import { usefulFieldsOfPage } from "../src/lib/agentMission/fields";

/**
 * AUDIT 2026-11 §6 PR 1 part b: THE COMPANY'S OWN E-MAIL AND HQ PHONE ARE COLUMNS OF THE COMPANY, found by a priced step beside the people's. The company e-mail and HQ phone are the owner's top priority (reference A, columns 5 and 6).
 */
const catalog = loadTregCatalog();
const allowed = (id: string) => isSellable(id, catalog) && !blockedEndpointReason(id) && policyVerdict(id, NOT_ADMIN).allowed;

describe("the company-level helpers of the catalog", () => {
  it("the mailbox listers (a domain's e-mail addresses) are offered cheapest first, only the ones that answer at once and take a domain", () => {
    const listers = mailboxListerSourcesOf(catalog, allowed);
    expect(listers.length).toBeGreaterThan(0);
    expect(listers[0].id).toBe("tomba.companies.emails.list");
    for (const l of listers) { expect(l.usd).toBeLessThanOrEqual(0.02); expect(l.inputs.some((i) => /domain/i.test(i.name))).toBe(true); }
  });
  it("the page of a lister gives the company's OWN role mailbox: info@ first, then the other role mailboxes of its domain; never a person's address, never another domain's", () => {
    const page = (emails: string[]) => ({ data: { domain: "esweco.com", emails: emails.map((email) => ({ email, type: email.startsWith("ahmed") ? "personal" : "generic" })) } });
    expect(companyMailboxIn(page(["ahmed@esweco.com", "sales@esweco.com", "info@esweco.com", "info@other.com", "webmaster@esweco.com"]), "esweco.com")).toBe("info@esweco.com");
    expect(companyMailboxIn(page(["ahmed@esweco.com", "sales@esweco.com"]), "esweco.com")).toBe("sales@esweco.com");
    expect(companyMailboxIn(page(["ahmed@esweco.com", "info@other.com"]), "esweco.com")).toBeNull();
    expect(companyMailboxIn({ data: { emails: [] } }, "esweco.com")).toBeNull();
    expect(companyMailboxIn(page(["INFO@WWW.esweco.com"]), "esweco.com")).toBe("info@www.esweco.com");
  });
});

describe("the company steps of a plan", () => {
  const lister = mailboxListerSourcesOf(catalog, allowed);
  const aidsOf = (kind: "email" | "phone") => (kind === "email" ? { verifiers: verifierSourcesOf(catalog, allowed) } : { validators: validatorSourcesOf(catalog, allowed), company_phone: companyPhoneSourcesOf(catalog, allowed) });
  const company = { key: "companies", title_ar: "شركات مصرية", parent_key: null, deliver: true, endpoint_id: "tomba.companies.search.reveal", columns: [{ key: "name" }] };
  const people = { key: "people", title_ar: "صناع القرار في كل شركة", parent_key: "companies", deliver: true, endpoint_id: "aviato.companies.employees", role_preference: { role: "manager" }, columns: [{ key: "name" }] };
  it("a delivered company stage with a delivered people stage under it gets an e-mail step (listers, then the verifiers) and a phone step (the map searches), both at company level", () => {
    const steps = buildCompanySteps([company, people], lister, aidsOf);
    expect(steps.map((s) => [s.kind, s.level, s.stage_key])).toEqual([["email", "company", "companies"], ["phone", "company", "companies"]]);
    const email = steps[0];
    expect(email.finders[0].id).toBe("tomba.companies.emails.list");
    expect(email.verifiers!.length).toBeGreaterThan(0);
    // the cap of ONE company is the first lister and the verifier, not the whole chain: a dearer fallback never runs past it
    expect(email.max_person_usd).toBeCloseTo(email.finders[0].usd + Math.max(...email.verifiers!.slice(0, 2).map((v) => v.usd)), 6);
    expect(email.max_person_usd!).toBeLessThan(0.02);
    const phone = steps[1];
    expect(phone.company_phone!.length).toBeGreaterThan(0);
    expect(phone.max_person_usd!).toBeLessThan(0.01);
    expect(steps.every((s) => s.per_person_usd > 0 && s.per_person_usd <= s.max_person_usd!)).toBe(true);
  });
  it("no step for a plan without a delivered people stage, or when the catalog has no lister and no map search (the columns still exist: the source's own fields fill them)", () => {
    expect(buildCompanySteps([company], lister, aidsOf)).toEqual([]);
    expect(buildCompanySteps([company, { ...people, deliver: false }], lister, aidsOf)).toEqual([]);
    expect(buildCompanySteps([company, people], [], () => ({}))).toEqual([]);
  });
  it("the contact columns of a people stage are never added to the company stage by a company step", () => {
    const steps = buildCompanySteps([company, people], lister, aidsOf);
    expect(withContactColumns("companies", [{ key: "name", title_ar: "الشركة" }], steps)).toEqual([{ key: "name", title_ar: "الشركة" }]);
  });
});

/** The standard request, priced with the catalog's own helpers (the fixture of tests/standard-request-price.test.ts, with the source page given as JSON so the plan check sees its fields). */
const OWNER = "عايز ٥ شركات مصرية في قطاع الكهروميكانيكا، ومعاهم صناع القرار: اسم المدير، المسمى الوظيفي، الإيميل، ورقم التليفون";
const PAGE = JSON.stringify({ companies: [{ name: "ESWECO", website_url: "esweco.com", industry: "Electrical Equipment", country: "EG", street_address: "10th of Ramadan", phone_number: "+20 15 3636 000" }] });
const calls = new Map([
  ["call_0001", { id: "call_0001", endpointId: "tomba.companies.search.reveal", ok: true, costUsd: 0.000178, rows: 50, params: { query: "electromechanical" } }],
  ["call_0002", { id: "call_0002", endpointId: "aviato.companies.employees", ok: true, costUsd: 0.005, rows: 5, params: { website: "esweco.com", perPage: 5, page: 1 } }],
]);
const lookup = (withListers: boolean): PlanLookup => ({
  call: (id) => calls.get(id) ?? null,
  evidenceText: (id) => (id === "call_0001" ? PAGE : "esweco.com https://esweco.com person-1 person-2 Osama Abou Shady CIO https://linkedin.com/in/osama-abou-shady-90966540 ESWECO Electrical Equipment +20 15 3636 000 10th of Ramadan"),
  endpointAllowed: () => true, requestText: OWNER,
  childStepSources: (noun) => childStepSourcesFor(noun, catalog, allowed),
  endpointsCalled: () => new Map([["aviato.companies.employees", { rows: 5 }]]),
  isContactSource: (id) => /email/i.test(id),
  contactFinders: (kind) => finderSourcesOf(kind, catalog, allowed),
  contactAids: aidsOf2,
  ...(withListers ? { mailboxListers: () => mailboxListerSourcesOf(catalog, allowed) } : {}),
});
function aidsOf2(kind: "email" | "phone") { return kind === "email" ? { verifiers: verifierSourcesOf(catalog, allowed) } : { validators: validatorSourcesOf(catalog, allowed), company_phone: companyPhoneSourcesOf(catalog, allowed) }; }
const cols = (...c: Array<[string, string]>) => c.map(([key, title_ar]) => ({ key, title_ar }));
const companies = (columns: Array<{ key: string; title_ar: string }>) => ({ key: "companies", title_ar: "الشركات المصرية في قطاع الكهروميكانيكا", endpoint_id: "tomba.companies.search.reveal", expected_rows: 5, parent_key: null, deliver: true, columns, sample_rows: [{ id: "esweco.com", name: "ESWECO", activity: "Electrical Equipment", website: "esweco.com", phone: "+20 15 3636 000", address: "10th of Ramadan" }], measured_by: ["call_0001"] });
const people = { key: "people", title_ar: "صناع القرار في كل شركة", endpoint_id: "aviato.companies.employees", expected_rows: 10, parent_key: "companies", per_parent_rows: 2, deliver: true, columns: cols(["name", "اسم المدير"], ["title", "المسمى الوظيفي"], ["linkedin", "الملف المهني"]), sample_rows: [{ id: "person-1", name: "Osama Abou Shady", title: "CIO", linkedin: "https://linkedin.com/in/osama-abou-shady-90966540" }], measured_by: ["call_0002"], role_preference: { role: "manager" } };
const full = cols(["name", "اسم الشركة"], ["activity", "القطاع"], ["website", "الموقع"], ["phone", "التليفون"], ["address", "العنوان"]);
const plan = (withListers: boolean, columns = full) => { const c = validateAndPricePlan({ summary_ar: "٥ شركات مصرية في قطاع الكهروميكانيكا ومعهم صناع القرار.", stages: [companies(columns), people] }, lookup(withListers)); if (!c.ok) throw new Error(JSON.stringify(c)); return c.plan; };

describe("the standard request carries the company steps and their price", () => {
  it("the plan check refuses a companies stage that leaves out the sector, the HQ phone or the address the source gave", () => {
    const c = validateAndPricePlan({ summary_ar: "٥ شركات مصرية في قطاع الكهروميكانيكا ومعهم صناع القرار.", stages: [companies(cols(["name", "اسم الشركة"], ["website", "الموقع"])), people] }, lookup(true));
    expect(c.ok).toBe(false);
    if (!c.ok) { const text = c.issues.join(" | "); expect(text).toContain("رقم الهاتف"); expect(text).toContain("العنوان"); expect(text).toContain("القطاع والنشاط"); }
    expect(usefulFieldsOfPage(PAGE).map((f) => f.cls)).toContain("activity");
  });
  it("with the listers, the plan has the two company steps; the price is higher by what they cost (the company steps are part of the price by code, never charged on top)", () => {
    const without = plan(false);
    const withSteps = plan(true);
    expect((withSteps.contact_steps ?? []).filter((s) => s.level === "company").map((s) => s.kind)).toEqual(["email", "phone"]);
    // without a lister in the catalog only the HQ phone's map search is a step (the e-mail column still exists: role mailboxes the people source gives fill it)
    expect((without.contact_steps ?? []).filter((s) => s.level === "company").map((s) => s.kind)).toEqual(["phone"]);
    expect(withSteps.price.reservePoints).toBeGreaterThan(without.price.reservePoints);
    expect(withSteps.price.providerCostUsd!).toBeGreaterThan(without.price.providerCostUsd!);
    // five companies x the expected cost of the steps
    const extra = withSteps.price.providerCostUsd! - without.price.providerCostUsd!;
    const perCompany = (withSteps.contact_steps ?? []).filter((s) => s.level === "company" && s.kind === "email").reduce((n, s) => n + s.per_person_usd, 0);
    expect(extra).toBeCloseTo(5 * perCompany, 6);
    expect(withSteps.price.overCap).toBe(false);
  });
  it("the card says, in plain Arabic with no digit, that the price includes the company's e-mail and HQ phone", () => {
    const line = priceIncludesLinesAr(plan(true)).find((l) => l.includes("الإيميل العام للشركة"));
    expect(line, JSON.stringify(priceIncludesLinesAr(plan(true)))).toBeTruthy();
    expect(line).toContain("هاتف المقر الرئيسي");
    expect(line).toContain("السعر يشمل");
    expect(checkCustomerText(line!).issues).toEqual([]);
    expect(line).not.toMatch(/[0-9]/);
  });
});
