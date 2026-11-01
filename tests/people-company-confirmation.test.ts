import { describe, expect, it, vi } from "vitest";
import { readWorkbook, replay } from "./helpers/agentReplay";
import { COMPANIES, PEOPLE, SLUGS, company, planFlow, request } from "./helpers/a1World";
import { tregResult } from "./helpers/agentFakeWorld";
import type { TregCallOptions } from "../src/functions/shared/tregClient";

vi.stubGlobal("fetch", () => { throw new Error("a real network call was attempted"); });

/**
 * ITEM 1 (live test A1, TEST account, 2026-11-01 ~09:26 Cairo): the company «falcon misr» (falconmisr.com) carried the company page link https://linkedin.com/company/mycompany (a placeholder). The people source answered for a company that is literally named «mycompany»:
 * a person in the US (with a phone marked «موثّق») and one in Italy. Wrong people, delivered and charged. Rules (owner direction, benchmark step 2):
 *   - a placeholder or generic company page link is never used as the key to ask for people;
 *   - a person is delivered under a company only when one of the person's experiences is CURRENT (job_is_current true, or no end date) AND names the company (its domain, or its name);
 *   - a person who does not match is not delivered, not counted, not charged; the company gets the next people who match.
 */
const PLACEHOLDER = "https://linkedin.com/company/mycompany";
const PEOPLE_PER_COMPANY = 2;
const cell = (v: unknown) => String(v ?? "").trim();
const slugOf = (o: TregCallOptions) => SLUGS.find((s) => JSON.stringify(o.params ?? {}).includes(s));
const exp = (company_name: string, company_domain: string, extra: Record<string, unknown> = {}) => ({ job_title: "Manager", company_name, company_domain, job_is_current: true, ...extra });
const person = (name: string, slug: string, i: number, experiences: unknown[]) => ({ person: { full_name: name, linkedin_url: `https://www.linkedin.example/in/${slug}-${i}`, headline: "Manager", experiences } });

/** The world: the third company is «falcon misr» with the placeholder page link; the source answers for «mycompany» with people of a company of that name. nile-em's list is mixed: a wrong-company person ranks first, a former employee second. */
const companiesPage = () => {
  const list = SLUGS.map(company);
  list[2] = { ...list[2], name: "Falcon Misr Electromechanical", website_url: "falconmisr.com", linkedin_url: PLACEHOLDER, id: PLACEHOLDER } as any;
  return { data: { companies: list } };
};
const peopleFor = (o: TregCallOptions) => {
  const text = JSON.stringify(o.params ?? {});
  if (text.includes("mycompany")) return { results: [person("John Smith", "mycompany", 0, [exp("mycompany", "mycompany.com")]), person("Luca Rossi", "mycompany", 1, [exp("mycompany", "mycompany.com")])] };
  const s = slugOf(o);
  if (!s) return { results: [] };
  const domain = `${s}.com.eg`;
  if (s === "nile-em") {
    return { results: [
      person("Wrong Place", s, 0, [exp("Some Other Holding", "otherholding.com")]),
      person("Former Employee", s, 1, [exp(`${s} co`, domain, { job_is_current: false, job_end_date: "2021-03-01" })]),
      person("Right One", s, 2, [exp("Old Job", "old.com", { job_is_current: false }), exp(`${s} co`, domain)]),
      person("Right Two", s, 3, [exp(`${s} co`, domain, { job_is_current: undefined, job_end_date: null })]),
      person("Right Three", s, 4, [exp(`${s} co`, domain)]),
    ] };
  }
  return { results: [0, 1, 2].map((i) => person(`Person ${s} ${i}`, s, i, [exp(`${s} co`, domain)])) };
};
const dispatcher = (calls: TregCallOptions[]) => (o: TregCallOptions) => {
  calls.push(o);
  if (o.endpointId === COMPANIES) return tregResult(companiesPage(), 0.0005);
  if (o.endpointId === PEOPLE) return tregResult(peopleFor(o), 0.0005);
  return tregResult({ found: false }, 0);
};
const run = async () => {
  const calls: TregCallOptions[] = [];
  const r = await replay({ request, planning: planFlow(), execution: () => [], answers: Array.from({ length: 140 }, () => dispatcher(calls)) });
  return { r, calls };
};
async function peopleSheet(r: Awaited<ReturnType<typeof replay>>) {
  const sheet = (await readWorkbook(r)).worksheets[2];
  const header = (sheet.getRow(1).values as unknown[]).map(cell);
  const rows = Array.from({ length: sheet.rowCount - 1 }, (_, i) => sheet.getRow(i + 2));
  return { header, col: (title: string) => rows.map((row) => cell(row.getCell(header.indexOf(title)).value)), n: rows.length };
}

describe("people are delivered only under the company they currently work at", () => {
  it("the placeholder company page link is never the key: no call is made with it, and nobody of a company named «mycompany» is delivered", async () => {
    const { r, calls } = await run();
    expect(calls.filter((c) => JSON.stringify(c.params ?? {}).includes("mycompany")).length).toBe(0);
    const s = await peopleSheet(r);
    const names = s.col("اسم صانع القرار");
    expect(names.some((n) => /John Smith|Luca Rossi/.test(n))).toBe(false);
    expect(s.col("الشركة").some((c) => /mycompany/i.test(c))).toBe(false);
  });

  it("a person whose current job is at another company, or whose job at the company ended, is not delivered; the company gets the next people who match", async () => {
    const { r, calls } = await run();
    const s = await peopleSheet(r);
    const names = s.col("اسم صانع القرار");
    expect(names).not.toContain("Wrong Place");
    expect(names).not.toContain("Former Employee");
    // nile-em: its two places are filled by the first two people who match (job_is_current true, or no end date), in the source's order
    expect(names.filter((n) => /Right/.test(n))).toEqual(["Right One", "Right Two"]);
    expect(names).not.toContain("Right Three");
  });

  it("not delivered, not counted, not charged: the delivered count is the people of the file and the charge follows it", async () => {
    const { r } = await run();
    const s = await peopleSheet(r);
    // 4 companies with a usable page link x 2 people = 8 (the placeholder company has none); the 5 companies are delivered as before
    expect(s.n).toBe(4 * PEOPLE_PER_COMPANY);
    expect(Number(r.mission.delivered_units)).toBe(5 + 4 * PEOPLE_PER_COMPANY);
    expect(Number(r.mission.charged_points)).toBeLessThanOrEqual(Number(r.mission.reserved_points));
  });
});

// ------------------------------------------------------------------------------------------------ the pure rules, on the shapes of the owner's benchmark (blitzapi.people.employee-finder rows)
import { companyIdentityOf, isPlaceholderCompanyUrl, peopleEvidenceOf, personAtCompany, registrableDomain, sameCompanyName } from "../src/lib/agentMission/companyIdentity";
// CHANGED (PR 1 part c): the people sheet of «companies and their decision makers» uses the owner's titles (taskContracts.ts): «اسم صانع القرار», «إيميل المسؤول المباشر», «هاتف / محمول المسؤول» and the statuses beside them

describe("placeholder and generic company links", () => {
  it.each([
    "https://linkedin.com/company/mycompany", "https://www.linkedin.com/company/mycompany/", "linkedin.com/company/your-company", "https://eg.linkedin.com/company/company-name", "https://linkedin.com/company/example", "https://linkedin.com/company/", "https://linkedin.com",
    "https://linkedin.com/company/my-company-2", "https://example.com", "mycompany.com", "http://localhost",
  ])("%s is a placeholder", (url) => expect(isPlaceholderCompanyUrl(url)).toBe(true));
  it.each(["https://linkedin.com/company/falcon-misr", "https://www.linkedin.com/company/elaraby-group/", "falconmisr.com", "https://linkedin.com/in/someone", "", null, undefined, 5])("%s is not", (url) => expect(isPlaceholderCompanyUrl(url)).toBe(false));
});

describe("registrable domains and company names", () => {
  it("subdomains and two-level suffixes", () => {
    expect(registrableDomain("mail.falconmisr.com")).toBe("falconmisr.com");
    expect(registrableDomain("https://www.saudisicli.com.sa/x")).toBe("saudisicli.com.sa");
    expect(registrableDomain("Person@Orascom-EM.com.eg")).toBe("orascom-em.com.eg");
    expect(registrableDomain("not a domain")).toBeNull();
  });
  it("names", () => {
    expect(sameCompanyName("Falcon Misr", "Falcon Misr Co.")).toBe(true);
    expect(sameCompanyName("falconmisr", "Falcon Misr Co")).toBe(true);
    expect(sameCompanyName("Falcon Misr", "mycompany")).toBe(false);
    expect(sameCompanyName("Nile Electromechanical", "Delta Electromechanical")).toBe(false);
  });
});

describe("a person at a company, from the source's own experiences", () => {
  const falcon = companyIdentityOf({ id: "x", name: "Falcon Misr", website: "https://www.falconmisr.com/", linkedin: "https://linkedin.com/company/mycompany" });
  it("the company's identity ignores the placeholder page and keeps its name and domain", () => expect(falcon).toEqual({ names: ["Falcon Misr"], domain: "falconmisr.com" }));
  it("a current job whose domain or name is the company's matches", () => {
    expect(personAtCompany([{ job_title: "CEO", company_name: "Falcon Misr", company_domain: "falconmisr.com", job_is_current: true }], falcon)).toBe("match");
    expect(personAtCompany([{ company_name: "Falcon Misr Co", job_is_current: undefined, job_end_date: null }], falcon)).toBe("match");
    expect(personAtCompany([{ company_domain: "www.falconmisr.com", job_is_current: true }], falcon)).toBe("match");
  });
  it("the people of a company named «mycompany», a former job, or only other current jobs do not match", () => {
    expect(personAtCompany([{ company_name: "mycompany", company_domain: "mycompany.com", job_is_current: true }], falcon)).toBe("mismatch");
    expect(personAtCompany([{ company_name: "Falcon Misr", company_domain: "falconmisr.com", job_is_current: false, job_end_date: "2020-05-01" }], falcon)).toBe("mismatch");
    expect(personAtCompany([{ company_name: "Falcon Misr", job_end_date: "2020-05-01" }], falcon)).toBe("mismatch");
  });
  it("no experiences, or no way to judge, is not a mismatch", () => {
    expect(personAtCompany([], falcon)).toBe("unknown");
    expect(personAtCompany([{ job_title: "CEO", job_is_current: true }], falcon)).toBe("unknown");
    expect(personAtCompany([{ company_name: "Anything", job_is_current: true }], { names: [], domain: null })).toBe("unknown");
  });
  it("the evidence of a raw page is found by profile link or name, for a flat result and for a result with a `person`", () => {
    const page = { results: [
      { full_name: "Mona Adel", linkedin_url: "https://www.linkedin.com/in/mona-adel", experiences: [{ company_name: "Falcon Misr", job_is_current: true }] },
      { person: { full_name: "Karim Said", linkedin_url: "https://linkedin.com/in/karim-said/", experiences: [{ company_name: "mycompany", job_is_current: true }] } },
    ] };
    const ev = peopleEvidenceOf(page);
    expect(ev.any).toBe(true);
    expect(personAtCompany(ev.of({ linkedin: "https://linkedin.com/in/mona-adel/" }, [])!, falcon)).toBe("match");
    expect(personAtCompany(ev.of({ full_name: "karim  said" }, ["full_name"])!, falcon)).toBe("mismatch");
    expect(ev.of({ full_name: "Nobody" }, ["full_name"])).toBeNull();
    expect(peopleEvidenceOf({ results: [{ full_name: "A" }] }).any).toBe(false);
  });
});
