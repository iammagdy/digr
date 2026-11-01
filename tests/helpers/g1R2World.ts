import { COMPANIES, PEOPLE, SLUGS, TITLES, company, columnsOf, linkedinOf, personOf, why } from "./a1World";
import { callIds, tregResult, type Results } from "./agentFakeWorld";
import { firstOutputId } from "./agentRelevance";
import type { FakeStep } from "../../agent/src/fakeDriver";
import type { TregCallOptions } from "../../src/functions/shared/tregClient";

/**
 * THE LIVE SHAPE OF GOLDEN RUN ROUND 2, G1 (msn_9dc8f2db86bc5cf4959b, 2026-11-01 15:35 UTC): the companies source asked for location_country EG, rows with the city in Latin letters («al qahirah»), a country that is empty or free text, no location
 * field at all, and the planner's own place filter {kind: "place", field: "city", values: ["EG"]} with no `places` and no `fields`. Shared by the location regression and the limits-text tests.
 */
// ---------------------------------------------------------------------------------------------------- the mission, replayed with the live shape

export const liveRows = (): Array<Record<string, unknown>> => {
  const base = SLUGS.map((s, i) => company(s, i));
  const place: Array<Record<string, string>> = [
    { city: "al qahirah", country: "EG", street_address: "1234 egypt" },
    { city: "giza", country: "EG", street_address: "24 amer st. dokki" },
    { city: "Faiyum Egypt", country: "", street_address: "" },
    { city: "", country: "egypt", street_address: "" },
    { city: "", country: "", street_address: "" },
  ];
  const egyptian = base.map((c, i) => ({ ...c, ...place[i], phone_number: "" }));
  const german = { ...company("berlin-em", 0), id: linkedinOf("berlin-em"), name: "Berlin Electromechanical", website_url: "berlin-em.de", linkedin_url: linkedinOf("berlin-em"), city: "Berlin", country: "DE", street_address: "1 Hauptstrasse", phone_number: "" };
  return [german, ...egyptian];
};

export const liveDispatcher = (rows: () => Array<Record<string, unknown>> = liveRows) => (call: TregCallOptions) => {
  const who = JSON.stringify(call.params ?? {});
  if (call.endpointId === COMPANIES) return tregResult({ data: { companies: rows() } }, 0.0005);
  if (call.endpointId === PEOPLE) { const s = SLUGS.find((x) => who.includes(x)); return tregResult({ results: s ? TITLES[s].slice(0, 3).map((t, i) => personOf(s, i, t)) : [] }, 0.0005); }
  return tregResult({ found: false }, 0);
};

export const liveFlow = (): FakeStep[] => {
  const ccols = columnsOf(["name", "اسم الشركة"], ["activity", "القطاع"], ["city", "المدينة"], ["website", "الموقع الإلكتروني"], ["phone", "التليفون"], ["address", "العنوان"], ["linkedin", "صفحة الشركة على الشبكة المهنية"], ["country", "الدولة"]);
  const pcols = columnsOf(["full_name", "الاسم"], ["job_title", "المسمى الوظيفي"], ["company", "الشركة"], ["linkedin", "الملف المهني للشخص"], ["email", "الإيميل", "work_email"], ["phone", "رقم التليفون", "phone"]);
  return [
    { tool: "report_progress", args: { message_ar: "أبحث عن الشركات ومسؤوليها", counts: { sources: 2 } } },
    { tool: "catalog_search", args: { words: ["companies", "search"], limit: 5 } },
    { tool: "describe_endpoint", args: { id: COMPANIES } },
    // THE LIVE QUERY: the source was asked for the country itself (location_country EG)
    { tool: "treg_call", args: { endpoint_id: COMPANIES, params: { page: 1, filters: { industry: { include: ["Electrical Equipment"] }, location_country: { include: ["EG"] } } }, why } },
    { tool: "run_code", args: (r: Results) => ({ code: `return inputs.${callIds(r)[0]}.data.companies.map(r => ({ id: r.linkedin_url, name: r.name, activity: r.industry || '', city: r.city || '', website: r.website_url || '', phone: r.phone_number || '', address: r.street_address || '', linkedin: r.linkedin_url || '', country: r.country || '' }))`, files: [callIds(r)[0]] }) },
    { tool: "describe_endpoint", args: { id: PEOPLE } },
    { tool: "treg_call", args: { endpoint_id: PEOPLE, params: { company_linkedin_url: linkedinOf("orascom-em"), cascade: [{ include_title: ["Chief Executive Officer", "Managing Director", "General Manager", "Chairman"] }], max_results: 10 }, why } },
    { tool: "run_code", args: (r: Results) => ({ code: `return inputs.${callIds(r)[1]}.results.map(r => { const p = r.person || {}; const exp = (p.experiences && p.experiences[0]) || {}; return { id: p.linkedin_url, full_name: p.full_name, job_title: exp.job_title || '', company: exp.company_name || '', linkedin: p.linkedin_url, email: p.email || '', phone: '' }; })`, files: [callIds(r)[1]] }) },
    { tool: "propose_plan", args: (res: Results) => ({
      summary_ar: "ستحصل على ٥ شركات مصرية في الكهروميكانيكا، ومع كل شركة أبرز صناع القرار فيها.",
      stages: [
        { key: "companies", title_ar: "الشركات المصرية في قطاع الكهروميكانيكا", endpoint_id: COMPANIES, expected_rows: 5, parent_key: null, deliver: true, columns: ccols,
          // THE LIVE FILTER, as the planner wrote it: no places, no fields, the country's ISO code as the value, on the CITY field
          filters: [{ kind: "place", field: "city", values: ["EG"] }],
          sample_rows: [{ id: linkedinOf("orascom-em"), name: "Orascom Electromechanical", activity: "Electrical Equipment Manufacturing", city: "al qahirah", website: "orascom-em.com.eg", phone: "", address: "1234 egypt", linkedin: linkedinOf("orascom-em"), country: "EG" }], measured_by: [callIds(res)[0], firstOutputId(res)] },
        { key: "people", title_ar: "موظفو كل شركة", endpoint_id: PEOPLE, expected_rows: 10, parent_key: "companies", per_parent_rows: 2, deliver: true, columns: pcols,
          sample_rows: [{ id: "https://www.linkedin.example/in/orascom-em-2", full_name: "Karim orascom", job_title: "Chief Executive Officer", company: "orascom-em co", linkedin: "https://www.linkedin.example/in/orascom-em-2", email: "", phone: "" }], measured_by: [callIds(res)[1]] },
      ],
    }) },
  ];
};

