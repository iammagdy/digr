import { callIds, tregResult, type Results } from "./agentFakeWorld";
import { firstOutputId } from "./agentRelevance";
import type { FakeStep } from "../../agent/src/fakeDriver";
import type { TregCallOptions } from "../../src/functions/shared/tregClient";

/**
 * THE A1 WORLD (live re-test 2026-10-31, msn_e750…: «٥ شركات كهروميكانيكا + صناع القرار»): five companies, 31 people with names and titles and no contact, and the plan flow that samples both stages and proposes the plan.
 * Shared by the replay tests of the people stage and of the planning budget.
 */
export const COMPANIES = "tomba.companies.search.reveal";
export const PEOPLE = "blitzapi.people.waterfall-icp";
export const why = "the cheaper sources return no author or link fields in their catalog description";
export const request = "عايز ٥ شركات مصرية في قطاع الكهروميكانيكا، ومعاهم صناع القرار: اسم المدير، المسمى الوظيفي، الإيميل، ورقم التليفون";

export const SLUGS = ["orascom-em", "nile-em", "delta-em", "cairo-em", "suez-em"] as const;
export const linkedinOf = (slug: string) => `https://linkedin.example/company/${slug}`;
export const company = (slug: string, i: number) => ({ id: linkedinOf(slug), name: `${["Orascom", "Nile", "Delta", "Cairo", "Suez"][i]} Electromechanical`, website_url: `${slug}.com.eg`, linkedin_url: linkedinOf(slug), country: "EG", city: "Cairo", industry: "Electrical Equipment Manufacturing", company_size: "51-200", description: "Electromechanical works and contracting" });
export const companiesPage = { data: { companies: SLUGS.map(company) } };

/** The 31 people the source gave for the five companies (live: 31 read), decision makers NOT first, none with an e-mail or a phone. */
export const TITLES: Record<(typeof SLUGS)[number], string[]> = {
  "orascom-em": ["Site Engineer", "Project Engineer", "Chief Executive Officer", "Chairman", "Procurement Officer", "Accountant"],
  "nile-em": ["Sales Representative", "Managing Director", "General Manager", "Electrical Engineer", "Technician", "HR Specialist", "Consultant"],
  "delta-em": ["Director of Operations", "Operations Manager", "Engineer", "Mechanical Engineer", "Site Supervisor", "Admin Assistant"],
  "cairo-em": ["Founder & CEO", "Head of Projects", "Quality Engineer", "Quality Inspector", "Driver", "Receptionist"],
  "suez-em": ["Engineer", "Engineer II", "Technical Office Engineer", "Plant Manager", "Finance Manager", "Accountant"],
};
export const personOf = (slug: (typeof SLUGS)[number], i: number, title: string) => ({ person: { full_name: `${["Hossam", "Mona", "Ahmed", "Salma", "Karim", "Nadia", "Tamer"][i]} ${slug.split("-")[0]}`, linkedin_url: `https://www.linkedin.example/in/${slug}-${i}`, experiences: [{ job_title: title, company_name: `${slug} co` }] } });
export const peopleOfCompany = (slug: (typeof SLUGS)[number]) => ({ results: TITLES[slug].map((t, i) => personOf(slug, i, t)) });
export const pickCompany = (o: TregCallOptions) => SLUGS.find((s) => JSON.stringify(o.params ?? {}).includes(s));
export const peopleAnswer = (o: TregCallOptions) => { const s = pickCompany(o); return tregResult(s ? peopleOfCompany(s) : { results: [] }, 0.0005); };

export const columnsOf = (...c: Array<[string, string, string?]>) => c.map(([key, title_ar, kind]) => ({ key, title_ar, ...(kind ? { kind } : {}) }));
// CHANGED (PR 1 part b, reference A column 3): the source gives `industry`, so the companies stage must have a column for it (the contract check refuses a plan that drops a field the source gave)
export const ccolumns = columnsOf(["name", "اسم الشركة"], ["industry", "النشاط والتخصص"], ["city", "المدينة"], ["website", "الموقع الإلكتروني"], ["linkedin", "صفحة الشركة على الشبكة المهنية"]);
/** The approved plan's people columns: name, title, company, professional page, and the e-mail and phone MARKED with a kind. */
export const pcolumns = columnsOf(["full_name", "الاسم"], ["job_title", "المسمى الوظيفي"], ["company", "الشركة"], ["linkedin", "الملف المهني للشخص"], ["email", "الإيميل", "work_email"], ["phone", "رقم التليفون", "phone"]);

export const planArgs = (res: Results, assumptions?: string[]) => ({
      summary_ar: "ستحصل على ٥ شركات مصرية في الكهروميكانيكا، ومع كل شركة أبرز صناع القرار فيها بالاسم والمسمى الوظيفي وصفحتهم المهنية.",
      assumptions_ar: assumptions ?? ["صناع القرار: المدير التنفيذي والمدير العام والعضو المنتدب أولًا، ثم المديرون ورؤساء الأقسام."],
      stages: [
        { key: "companies", title_ar: "شركات مصرية في المعدات الكهربائية والميكانيكية", endpoint_id: COMPANIES, expected_rows: 5, parent_key: null, deliver: true, columns: ccolumns,
          sample_rows: [{ id: linkedinOf("orascom-em"), name: "Orascom Electromechanical", industry: "Electrical Equipment Manufacturing", city: "Cairo", website: "orascom-em.com.eg", linkedin: linkedinOf("orascom-em") }], measured_by: [callIds(res)[0], firstOutputId(res)] },
        { key: "people", title_ar: "موظفو كل شركة", endpoint_id: PEOPLE, expected_rows: 10, parent_key: "companies", per_parent_rows: 2, deliver: true, columns: pcolumns,
          sample_rows: [{ id: "https://www.linkedin.example/in/orascom-em-2", full_name: "Karim orascom", job_title: "Chief Executive Officer", company: "orascom-em co", linkedin: "https://www.linkedin.example/in/orascom-em-2", email: "", phone: "" }], measured_by: [callIds(res)[1]] },
      ],
});
export const planFlow = (firstAttempt?: { assumptions_ar: string[] }): FakeStep[] => [
  { tool: "report_progress", args: { message_ar: "أبحث عن الشركات ومسؤوليها", counts: { sources: 2 } } },
  { tool: "catalog_search", args: { words: ["companies", "search"], limit: 5 } },
  { tool: "describe_endpoint", args: { id: COMPANIES } },
  { tool: "treg_call", args: { endpoint_id: COMPANIES, params: { query: "electromechanical", page: 1 }, why } },
  { tool: "run_code", args: (r: Results) => ({ code: `return inputs.${callIds(r)[0]}.data.companies.map(r => ({ id: r.linkedin_url, name: r.name, industry: r.industry || '', city: r.city || '', website: r.website_url || '', linkedin: r.linkedin_url || '' }))`, files: [callIds(r)[0]] }) },
  { tool: "describe_endpoint", args: { id: PEOPLE } },
  { tool: "treg_call", args: { endpoint_id: PEOPLE, params: { company_linkedin_url: linkedinOf("orascom-em"), cascade: [{ include_title: ["Chief Executive Officer", "Managing Director", "General Manager", "Chairman"] }, { include_title: ["Director", "Head of", "Manager"] }], max_results: 10 }, why } },
  { tool: "run_code", args: (r: Results) => ({ code: `return inputs.${callIds(r)[1]}.results.map(r => { const p = r.person || {}; const exp = (p.experiences && p.experiences[0]) || {}; return { id: p.linkedin_url, full_name: p.full_name, job_title: exp.job_title || '', company: exp.company_name || '', linkedin: p.linkedin_url, email: '', phone: '' }; })`, files: [callIds(r)[1]] }) },
  ...(firstAttempt ? [{ tool: "propose_plan", args: (res: Results) => planArgs(res, firstAttempt.assumptions_ar) }] : []),
  { tool: "propose_plan", args: (res: Results) => planArgs(res) },
];
