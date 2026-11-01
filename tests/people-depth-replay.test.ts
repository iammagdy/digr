import { describe, expect, it } from "vitest";
import { tregResult, callIds, type Results } from "./helpers/agentFakeWorld";
import { firstOutputId } from "./helpers/agentRelevance";
import { assertReplayInvariants, replay } from "./helpers/agentReplay";
import { readSnapshot } from "../agent/src/items/itemStore";
import type { FakeStep } from "../agent/src/fakeDriver";

/**
 * ITEM 2 (owner decision after #321): the people source returns 5 people per page (aviato.companies.employees, perPage 5, 0.005 USD a page), so a decision maker beyond page 1 was never seen (msn_7539…: «عامل» and «محاسب» delivered because the first page held no manager).
 * Now up to 3 pages are read per company, stopping early once enough decision makers are found for that company, and a decision maker of a later page takes the place of a lower title of page 1.
 */
const COMPANIES = "parallel.companies.search";
const EMPLOYEES = "aviato.companies.employees";
const REQUEST = "عايز ٤ شركات مقاولات في مصر، ومن كل شركة اتنين من المديرين";
const why = "the cheaper sources are searches by hiring or by people, not by sector and place";
const cols = (...c: Array<[string, string]>) => c.map(([key, title_ar]) => ({ key, title_ar }));
const entity = (i: number) => ({ name: `Nile Construction Company ${i}`, url: `https://linkedin.com/company/co-${i}`, description: `Website Url: https://co${i}.eg | Location Country: Egypt | Short Description: Provider of engineering, construction, and project management services. | Primary Sector: Construction` });
const POOL = Array.from({ length: 4 }, (_, i) => entity(i + 1));
const MAP_CO = "const rows = inputs.call_0001.entities || []; return rows.map(r => { const d = r.description || ''; const web = d.match(/Website Url:\\s*(https?:\\/\\/[^\\s|]+)/); const loc = (d.match(/Location Country:\\s*([^|]+)/)||[])[1] || ''; const sd = (d.match(/Short Description:\\s*([^|]+)/)||[])[1] || ''; return { id: web ? web[1].replace(/^https?:\\/\\//,'') : r.url, name: r.name, website: web ? web[1] : '', country: loc.trim(), linkedin: r.url, description: sd.trim() }; })";
const MAP_EMP = "const rows = inputs.call_0002.employees || []; return rows.map(r => { const p = r.person || {}; const pos = (r.positionList && r.positionList[0]) || {}; return { id: r.personID, company: r.companyName || '', name: p.fullName || '', title: pos.title || '', linkedin: p.URLs && p.URLs.linkedin ? p.URLs.linkedin : '' }; })";

/** The live shape of aviato: 5 people a page. co1: nobody senior on page 1, a manager on page 2, a chief on page 3. co2: two managers on page 1. co3: a manager on page 2 only. co4: nobody senior on any page. */
const LOW = ["Worker", "Accountant", "Driver", "Sales Representative", "Electrical Engineer"];
const TITLES: Record<string, string[][]> = {
  "co1.eg": [LOW, ["Operations Manager", "Receptionist", "Intern", "Technician", "Surveyor"], ["Chief Executive Officer", "Clerk", "Helper", "Engineer II", "Cleaner"]],
  "co2.eg": [["Managing Director", "General Manager", ...LOW.slice(0, 3)], ["Head of Projects", ...LOW.slice(0, 4)], LOW],
  "co3.eg": [LOW, ["Plant Manager", ...LOW.slice(0, 4)], LOW],
  "co4.eg": [LOW, ["Consultant", "Technician", "Surveyor", "Intern", "Worker"], ["Engineer II", "Clerk", "Driver", "Helper", "Cleaner"]],
};
const employeesOf = (site: string, page: number) => ({ employees: (TITLES[site]?.[page - 1] ?? []).map((title, k) => ({ personID: `${site}-p${page}-${k}`, companyName: `Nile Construction Company ${site.slice(2, 3)}`, positionList: [{ title }], person: { fullName: `Person ${site} ${page} ${k}`, URLs: { linkedin: `linkedin.com/in/${site}-${page}-${k}` } } })) });
const answerFor = (o: { endpointId?: string; params?: unknown }) => {
  const p = (o.params ?? {}) as Record<string, unknown>;
  if (o.endpointId === COMPANIES) return tregResult({ entities: POOL }, 0.005);
  const site = String(p.website ?? "co1.eg").replace(/^www\./, "");
  return tregResult(employeesOf(site, Number(p.page ?? 1)), 0.005);
};
const flow = (): FakeStep[] => [
  { tool: "catalog_search", args: { words: ["companies", "search"], limit: 5 } },
  { tool: "describe_endpoint", args: { id: COMPANIES } },
  { tool: "treg_call", args: { endpoint_id: COMPANIES, params: { objective: "construction contractor companies headquartered in Egypt", entity_type: "companies", match_limit: 4 }, why } },
  { tool: "run_code", args: (r: Results) => ({ code: MAP_CO, files: [callIds(r)[0]] }) },
  { tool: "describe_endpoint", args: { id: EMPLOYEES } },
  { tool: "treg_call", args: { endpoint_id: EMPLOYEES, params: { page: 1, perPage: 5, website: "co1.eg" }, why } },
  { tool: "run_code", args: (r: Results) => ({ code: MAP_EMP, files: [callIds(r)[1]] }) },
  { tool: "propose_plan", args: (r: Results) => ({
    summary_ar: "نجمع شركات مقاولات مصرية، ومن كل شركة اثنين من مديريها.",
    stages: [
      { key: "companies", title_ar: "شركات مقاولات في مصر", endpoint_id: COMPANIES, expected_rows: 4, parent_key: null, deliver: true,
        columns: cols(["name", "اسم الشركة"], ["website", "الموقع الإلكتروني"], ["country", "البلد"], ["description", "نشاط الشركة"], ["linkedin", "رابط الشركة"]),
        filters: [{ kind: "place", field: "country", fields: ["country", "website"], places: ["EG"], values: ["مصر"] }],
        sample_rows: [1, 2, 3].map((n) => ({ id: `co${n}.eg`, name: POOL[n - 1].name, website: `https://co${n}.eg`, country: "Egypt", linkedin: POOL[n - 1].url, description: "Provider of engineering, construction, and project management services." })),
        measured_by: [callIds(r)[0]], yield_from: firstOutputId(r),
        relevance: { subject_ar: "شركات مقاولات وبناء مصرية", terms: ["construction company", "construction services", "engineering construction", "contracting company", "general contractor", "شركة مقاولات"], text_columns: ["name", "description"], min_own_words: 2, entity: true, review: true } },
      { key: "employees", title_ar: "مديرو كل شركة", endpoint_id: EMPLOYEES, expected_rows: 8, parent_key: "companies", per_parent_rows: 2, deliver: true,
        columns: cols(["name", "اسم الموظف"], ["title", "المسمى الوظيفي"], ["company", "الشركة"], ["linkedin", "رابط الملف الشخصي"]),
        sample_rows: [{ id: "co1.eg-p1-0", name: "Person co1.eg 1 0", title: "Worker", company: "Nile Construction Company 1", linkedin: "linkedin.com/in/co1.eg-1-0" }], measured_by: [callIds(r)[1]] },
    ],
  }) },
];
async function run() {
  return replay({
    request: REQUEST, planning: flow(), execution: () => [],
    answers: [answerFor({ endpointId: COMPANIES, params: { match_limit: 4 } }), answerFor({ endpointId: EMPLOYEES, params: { website: "co1.eg", page: 1 } }), ...Array.from({ length: 100 }, () => (o: { endpointId: string; params: unknown }) => answerFor(o))] as never,
  });
}
const peopleOf = async (r: Awaited<ReturnType<typeof run>>) => {
  const snap = await readSnapshot(r.store, r.missionId);
  const byCompany = new Map<string, string[]>();
  for (const p of snap.acceptedRows("employees")) { const k = String(p.parent_id); byCompany.set(k, [...(byCompany.get(k) ?? []), String(p.title)]); }
  return byCompany;
};

describe("people depth: up to 3 pages a company, decision makers of later pages come first", () => {
  it("a manager on page 2 and a chief on page 3 beat the five lower titles of page 1 (before: the page-1 titles were delivered)", async () => {
    const r = await run();
    const people = await peopleOf(r);
    expect(people.get("co1.eg")!.sort()).toEqual(["Chief Executive Officer", "Operations Manager"]);
    expect(people.get("co2.eg")!.sort()).toEqual(["General Manager", "Managing Director"]);
    const co3 = people.get("co3.eg")!;
    expect(co3).toHaveLength(2);
    expect(co3).toContain("Plant Manager");
    expect(co3.filter((t) => ["Worker", "Accountant", "Driver", "Intern", "Clerk", "Cleaner", "Helper"].includes(t))).toHaveLength(0);
    // nobody senior anywhere: the count is filled with the best of the rest, never the lowest titles while a better one was read
    const co4 = people.get("co4.eg")!;
    expect(co4).toHaveLength(2);
    expect(co4.filter((t) => ["Worker", "Intern", "Clerk", "Cleaner", "Helper", "Driver"].includes(t))).toHaveLength(0);
  });
  it("it stops early (co2: two managers on page 1, ONE page read) and never reads a fourth page", async () => {
    const r = await run();
    const calls = (r.call.mock.calls as Array<[{ endpointId: string; params: Record<string, unknown> }]>).map((c) => c[0]).slice(2).filter((c) => c.endpointId === EMPLOYEES);
    const pagesOf = (site: string) => calls.filter((c) => String(c.params.website ?? "").replace(/^www\./, "") === site).map((c) => Number(c.params.page ?? 1)).sort();
    expect(pagesOf("co2.eg")).toEqual([1]);
    expect(pagesOf("co1.eg")).toEqual([1, 2, 3]);
    expect(pagesOf("co3.eg")).toEqual([1, 2, 3]);
    expect(pagesOf("co4.eg")).toEqual([1, 2, 3]);
    expect(Math.max(...calls.map((c) => Number(c.params.page ?? 1)))).toBe(3);
    assertReplayInvariants(r, { expectDelivered: 12, expectStatus: "completed" });
  });
});
