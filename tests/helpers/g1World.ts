import { vi } from "vitest";
import { replay, type ReplayInput } from "./agentReplay";
import { COMPANIES, PEOPLE, SLUGS, TITLES, company, linkedinOf, personOf, request, why, columnsOf } from "./a1World";
import { callIds, tregResult, type Results } from "./agentFakeWorld";
import { firstOutputId } from "./agentRelevance";
import { loadTregCatalog } from "../../src/lib/treg/catalog";
import type { FakeStep } from "../../agent/src/fakeDriver";
import type { TregCallOptions } from "../../src/functions/shared/tregClient";

/**
 * THE G1 WORLD (docs/AUDIT-2026-11.md section 7, golden prompt G1: «٥ شركات مصرية في قطاع الكهروميكانيكا، ومعاهم صناع القرار: اسم المدير، المسمى الوظيفي، الإيميل، ورقم التليفون»), for the offline replays of the reference: the five companies of the A1 world with what the free companies
 * source really gives (a phone and a street address for three of them, none for two), their people (titles overridable per company), a role mailbox the people source returns for one company, and answering mailbox listers, verifiers and map searches.
 */
vi.stubGlobal("fetch", () => { throw new Error("a real network call was attempted"); });

export type Slug = (typeof SLUGS)[number];
export { request, SLUGS };
const catalog = loadTregCatalog();
export const cell = (v: unknown) => String(v ?? "").trim();
export const PHONES = ["+20 2 2574 0001", "+20 2 2574 0002", "+20 2 2574 0003", "", ""];
/** The two sectors of the golden set: G1 (electromechanical, the A1 world) and G2 (petroleum): the same shape, other companies and another request. */
export type Sector = "electromechanical" | "petroleum";
export const SECTOR_WORLD: Record<Sector, { request: string; names: string[]; industry: string }> = {
  electromechanical: { request, names: SLUGS.map((s, i) => company(s, i).name), industry: "Electrical Equipment Manufacturing" },
  petroleum: { request: "عايز ٥ شركات مصرية في قطاع البترول، ومعاهم صناع القرار: اسم المدير، المسمى الوظيفي، الإيميل، ورقم التليفون", names: ["Orascom Petroleum Services", "Nile Oil Field Services", "Delta Gas Systems", "Cairo Energy and Oil", "Suez Petroleum Works"], industry: "Oil and Energy" },
};
const co = (slug: string, i: number, sector: Sector) => ({ ...company(slug, i), name: SECTOR_WORLD[sector].names[i], industry: SECTOR_WORLD[sector].industry, website_url: `${slug}.com.eg`, phone_number: PHONES[i], street_address: `${i + 1} Industrial Zone, Cairo` });
export const companiesPageOf = (sector: Sector = "electromechanical") => ({ data: { companies: SLUGS.map((s, i) => co(s, i, sector)) } });
export const companiesPage = companiesPageOf();
export interface G1Options { /** The titles the people source gives for a company (default: the A1 world's). */ titles?: Partial<Record<Slug, string[]>>; deps?: ReplayInput["deps"]; /** G2 is the petroleum sector (default: electromechanical, G1). */ sector?: Sector }

/** The people of a company; Nile's people source also lists its role mailbox (info@): not a person, kept as the company's own e-mail. */
const peopleWith = (slug: Slug, o: G1Options) => {
  const results: unknown[] = (o.titles?.[slug] ?? TITLES[slug]).map((t, i) => personOf(slug, i, t));
  if (slug === "nile-em") results.push({ person: { full_name: "", linkedin_url: "https://www.linkedin.example/in/nile-mailbox", email: "info@nile-em.com.eg", experiences: [] } });
  return { results };
};
const domainOf = (o: TregCallOptions) => String((o.params as Record<string, unknown> | undefined)?.domain ?? (o.params as Record<string, unknown> | undefined)?.domainOrCompany ?? "");
export const LISTER_ANSWERS: Record<string, unknown> = {
  "orascom-em.com.eg": { data: { emails: [{ email: "sales@orascom-em.com.eg" }, { email: "info@orascom-em.com.eg" }, { email: "hossam@orascom-em.com.eg" }] } },
  "delta-em.com.eg": { data: { emails: [{ email: "webmaster@delta-em.com.eg" }] } },
  "cairo-em.com.eg": { data: { emails: [] } },
  "suez-em.com.eg": { data: { emails: [{ email: "info@other-domain.com" }] } },
};
export function dispatcher(o: G1Options = {}) {
  return (call: TregCallOptions) => {
    const capability = catalog.byId.get(call.endpointId)?.capability ?? "";
    const who = JSON.stringify(call.params ?? {});
    if (call.endpointId === COMPANIES) return tregResult(companiesPageOf(o.sector), 0.0005);
    if (call.endpointId === PEOPLE) { const s = SLUGS.find((x) => who.includes(x)); return tregResult(s ? peopleWith(s, o) : { results: [] }, 0.0005); }
    if (capability === "companies.emails.list") return tregResult(LISTER_ANSWERS[domainOf(call)] ?? { data: { emails: [] } }, 0.0089);
    if (capability === "people.email.verify") return tregResult(who.includes("delta-em") ? { status: "invalid", deliverable: false } : { status: "safe", deliverable: true, is_catch_all: false }, 0.00178);
    if (capability === "google.serp.maps") return tregResult(who.includes(SECTOR_WORLD[o.sector ?? "electromechanical"].names[3]) ? { rows: [{ name: SECTOR_WORLD[o.sector ?? "electromechanical"].names[3], phone: "+20 2 2777 0005", website: "https://cairo-em.com.eg", address: "Cairo" }] } : { rows: [] }, 0.00015);
    if (capability === "people.phone.verify") return tregResult({ valid: true, is_valid: true, country_code: "EG" }, 0);
    // the people's own finders find nothing in this replay (their cells are the people-step replays' business)
    return tregResult({ found: false }, 0);
  };
}

export const planFlow = (sector: Sector = "electromechanical"): FakeStep[] => {
  const world = SECTOR_WORLD[sector];
  const ccols = columnsOf(["name", "اسم الشركة"], ["activity", "القطاع"], ["city", "المدينة"], ["website", "الموقع الإلكتروني"], ["phone", "التليفون"], ["address", "العنوان"], ["linkedin", "صفحة الشركة على الشبكة المهنية"]);
  const pcols = columnsOf(["full_name", "الاسم"], ["job_title", "المسمى الوظيفي"], ["company", "الشركة"], ["linkedin", "الملف المهني للشخص"], ["email", "الإيميل", "work_email"], ["phone", "رقم التليفون", "phone"]);
  return [
    { tool: "report_progress", args: { message_ar: "أبحث عن الشركات ومسؤوليها", counts: { sources: 2 } } },
    { tool: "catalog_search", args: { words: ["companies", "search"], limit: 5 } },
    { tool: "describe_endpoint", args: { id: COMPANIES } },
    { tool: "treg_call", args: { endpoint_id: COMPANIES, params: { query: "electromechanical", page: 1 }, why } },
    { tool: "run_code", args: (r: Results) => ({ code: `return inputs.${callIds(r)[0]}.data.companies.map(r => ({ id: r.linkedin_url, name: r.name, activity: r.industry || '', city: r.city || '', website: r.website_url || '', phone: r.phone_number || '', address: r.street_address || '', linkedin: r.linkedin_url || '' }))`, files: [callIds(r)[0]] }) },
    { tool: "describe_endpoint", args: { id: PEOPLE } },
    { tool: "treg_call", args: { endpoint_id: PEOPLE, params: { company_linkedin_url: linkedinOf("orascom-em"), cascade: [{ include_title: ["Chief Executive Officer", "Managing Director", "General Manager", "Chairman"] }, { include_title: ["Director", "Head of", "Manager"] }], max_results: 10 }, why } },
    { tool: "run_code", args: (r: Results) => ({ code: `return inputs.${callIds(r)[1]}.results.map(r => { const p = r.person || {}; const exp = (p.experiences && p.experiences[0]) || {}; return { id: p.linkedin_url, full_name: p.full_name, job_title: exp.job_title || '', company: exp.company_name || '', linkedin: p.linkedin_url, email: p.email || '', phone: '' }; })`, files: [callIds(r)[1]] }) },
    { tool: "propose_plan", args: (res: Results) => ({
      summary_ar: "ستحصل على ٥ شركات مصرية في الكهروميكانيكا، ومع كل شركة أبرز صناع القرار فيها بالاسم والمسمى الوظيفي وصفحتهم المهنية.",
      assumptions_ar: ["صناع القرار: المدير التنفيذي والمدير العام والعضو المنتدب أولًا، ثم المديرون ورؤساء الأقسام."],
      stages: [
        { key: "companies", title_ar: "شركات مصرية في المعدات الكهربائية والميكانيكية", endpoint_id: COMPANIES, expected_rows: 5, parent_key: null, deliver: true, columns: ccols,
          sample_rows: [{ id: linkedinOf("orascom-em"), name: world.names[0], activity: world.industry, city: "Cairo", website: "orascom-em.com.eg", phone: PHONES[0], address: "1 Industrial Zone, Cairo", linkedin: linkedinOf("orascom-em") }], measured_by: [callIds(res)[0], firstOutputId(res)] },
        { key: "people", title_ar: "موظفو كل شركة", endpoint_id: PEOPLE, expected_rows: 10, parent_key: "companies", per_parent_rows: 2, deliver: true, columns: pcols,
          sample_rows: [{ id: "https://www.linkedin.example/in/orascom-em-2", full_name: "Karim orascom", job_title: "Chief Executive Officer", company: "orascom-em co", linkedin: "https://www.linkedin.example/in/orascom-em-2", email: "", phone: "" }], measured_by: [callIds(res)[1]] },
      ],
    }) },
  ];
};
/** The whole mission of the standard request G1, through the same code the site and the worker run, with no real call. */
export const g1 = (o: G1Options = {}) => replay({ request: SECTOR_WORLD[o.sector ?? "electromechanical"].request, planning: planFlow(o.sector), execution: () => [], answers: Array.from({ length: 200 }, () => dispatcher(o)), ...(o.deps ? { deps: o.deps } : {}) });
