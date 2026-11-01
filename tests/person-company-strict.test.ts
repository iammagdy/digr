import { describe, expect, it } from "vitest";
import { companyIdentityOf, companyNameMatch, confirmPersonAtCompany, peopleEvidenceOf, personAtCompany } from "../src/lib/agentMission/companyIdentity";

/**
 * ITEM 2 OF THE 2026-11-01 11:38 LIVE TEST (msn_7539ea17512cf58aa0e7). Under «365 Ecology» (365ecology.com) the file held «Hassan Mohamed», title «عامل», current company «Ecologi», in Beni Suef: a person of ANOTHER company, delivered and charged.
 * The people source of that mission (aviato.companies.employees) answers `{ employees: [{ personID, companyName, person: { fullName, location, URLs: { linkedin } }, positionList: [...] }] }`: it has no `experiences` list, so the page carried NO evidence the confirmation could read
 * and the person was never judged. Owner direction: the person's current company must match the target by DOMAIN or by the NORMALISED FULL NAME (never a partial / prefix match like «Ecologi» vs «365 Ecology»); a location in another governorate is allowed only when the name or domain match is exact.
 */
const eco = companyIdentityOf({ id: "c2", name: "365 Ecology", website: "https://365ecology.com/", city: "الجيزة" });
const employee = (name: string, slug: string, companyName: string, location: string, extra: Record<string, unknown> = {}) => ({
  personID: slug, companyName,
  person: { id: slug, fullName: name, location, URLs: { linkedin: `linkedin.com/in/${slug}` } },
  positionList: [{ title: "عامل", location, startDate: "2022-01-01T00:00:00.000Z", ...extra }],
});
const page = { employees: [
  employee("Hassan Mohamed", "hassan-mohamed-670695379", "Ecologi", "Beni Suef, Egypt"),
  employee("Mohamed Saied", "mohamed-saied-ba7ba9238", "365 Ecology", "Cairo, Egypt"),
  employee("Former Hand", "former-hand-1", "365 Ecology", "Giza, Egypt", { endDate: "2021-03-01T00:00:00.000Z" }),
] };
const rowOf = (name: string, slug: string, company: string, location: string) => ({ id: slug, name, title: "عامل", company, location, linkedin: `https://linkedin.com/in/${slug}`, email: "", phone: "" });

describe("the live person: «Ecologi» is not «365 Ecology»", () => {
  const evidence = peopleEvidenceOf(page);
  it("the source's own position list (`positionList`, the company at the employee level) is evidence", () => {
    expect(evidence.any).toBe(true);
    expect(evidence.of(rowOf("Hassan Mohamed", "hassan-mohamed-670695379", "Ecologi", "Beni Suef, Egypt"), ["name"])).not.toBeNull();
  });
  it("Hassan Mohamed (current company «Ecologi», Beni Suef) is NOT at 365 Ecology", () => {
    const row = rowOf("Hassan Mohamed", "hassan-mohamed-670695379", "Ecologi", "Beni Suef, Egypt");
    expect(confirmPersonAtCompany(row, { nameKeys: ["name"], evidence, company: eco, companyPlace: "الجيزة" })).toBe("mismatch");
  });
  it("Mohamed Saied (company «365 Ecology», another governorate than the company's city) IS at 365 Ecology: the name match is exact", () => {
    const row = rowOf("Mohamed Saied", "mohamed-saied-ba7ba9238", "365 Ecology", "Cairo, Egypt");
    expect(confirmPersonAtCompany(row, { nameKeys: ["name"], evidence, company: eco, companyPlace: "الجيزة" })).toBe("match");
  });
  it("a former job at the company (an end date) is no match", () => {
    const row = rowOf("Former Hand", "former-hand-1", "365 Ecology", "Giza, Egypt");
    expect(confirmPersonAtCompany(row, { nameKeys: ["name"], evidence, company: eco, companyPlace: "الجيزة" })).toBe("mismatch");
  });
  it("a page with no evidence at all: the person's own «company» cell is compared the same way", () => {
    const none = peopleEvidenceOf({ rows: [{ name: "X" }] });
    expect(confirmPersonAtCompany(rowOf("Hassan Mohamed", "h1", "Ecologi", "Beni Suef"), { nameKeys: ["name"], evidence: none, company: eco, companyPlace: "الجيزة" })).toBe("mismatch");
    expect(confirmPersonAtCompany(rowOf("Mohamed Saied", "m1", "365 Ecology Co.", "Cairo"), { nameKeys: ["name"], evidence: none, company: eco, companyPlace: "الجيزة" })).toBe("match");
    // nothing to judge with: not a mismatch (the rule needs evidence to contradict)
    expect(confirmPersonAtCompany({ id: "z", name: "Z", title: "Manager" }, { nameKeys: ["name"], evidence: none, company: eco, companyPlace: "الجيزة" })).toBe("unknown");
  });
});

describe("the name match is the full normalised name; a partial match needs the same governorate; the domain is exact", () => {
  it("the match levels", () => {
    expect(companyNameMatch("365 Ecology", "365 Ecology Co.")).toBe("exact");
    expect(companyNameMatch("Falcon Misr", "falconmisr")).toBe("exact");
    expect(companyNameMatch("365 Ecology", "Ecologi")).toBe("none");
    expect(companyNameMatch("365 Ecology", "Ecology")).toBe("partial");
    expect(companyNameMatch("Nile Electromechanical", "Nile Electromechanical Egypt")).toBe("partial");
    expect(companyNameMatch("Nile Electromechanical", "Delta Electromechanical")).toBe("none");
  });
  const exp = (company_name: string, extra: Record<string, unknown> = {}) => ({ company_name, job_is_current: true, ...extra });
  it("a partial name match is accepted only when the person is in the company's governorate", () => {
    expect(personAtCompany([exp("Ecology")], eco, { personPlace: "Giza, Egypt", companyPlace: "الجيزة" })).toBe("match");
    expect(personAtCompany([exp("Ecology")], eco, { personPlace: "Beni Suef, Egypt", companyPlace: "الجيزة" })).toBe("mismatch");
    expect(personAtCompany([exp("Ecology")], eco, { personPlace: "Cairo, Egypt", companyPlace: "الجيزة" })).toBe("mismatch");
    // no place on either side: a partial match alone is not enough
    expect(personAtCompany([exp("Ecology")], eco)).toBe("mismatch");
  });
  it("an exact name match, or the company's domain, is accepted whatever the place", () => {
    expect(personAtCompany([exp("365 Ecology Co")], eco, { personPlace: "Beni Suef, Egypt", companyPlace: "الجيزة" })).toBe("match");
    expect(personAtCompany([{ company_domain: "www.365ecology.com", job_is_current: true }], eco, { personPlace: "Aswan", companyPlace: "الجيزة" })).toBe("match");
  });
  it("a company domain label inside a longer name is only a partial match", () => {
    expect(personAtCompany([exp("365ecology Trading Egypt")], eco, { personPlace: "Aswan", companyPlace: "الجيزة" })).toBe("mismatch");
  });
  it("the names of a combined company name are each a name of the company", () => {
    const melco = companyIdentityOf({ id: "c4", name: "mitsubishi elevators \\ melco-mec egypt", website: "melcomec.net" });
    expect(melco.names).toEqual(expect.arrayContaining(["mitsubishi elevators", "melco-mec egypt"]));
    expect(personAtCompany([exp("Melco-Mec Egypt")], melco, { personPlace: "Aswan", companyPlace: "الجيزة" })).toBe("match");
  });
});
