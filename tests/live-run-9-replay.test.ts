import { describe, expect, it } from "vitest";
import { assertReplayInvariants, readWorkbook, replay } from "./helpers/agentReplay";
import { callIds, tregResult, type Results } from "./helpers/agentFakeWorld";
import { firstOutputId } from "./helpers/agentRelevance";
import type { FakeStep } from "../agent/src/fakeDriver";

/**
 * REPLAY OF THE LIVE RETEST OF 2026-10-29 20:50-21:03 CAIRO (after #295, test account, `msn_3dd7b48db38221d4b68f`; the stored plan was read with SELECT). The people stage's mapping code, as the model wrote it and the plan stores it, copies the
 * FIRST sample's input into every row (`website: 'orascom.com'`) and writes the start date as a label plus a date («تاريخ البداية: 2022-03-01»); a missing field is an empty text. The file the customer opened had the first company's website on all
 * six people and «02:00» on every start date. The data below is ordered like the live source: the three companies, then two people of each.
 */
const why = "the cheaper sources return no author or link fields in their catalog description";
const planFlow = (o: { progress: string; words: string[]; calls: Array<{ endpoint: string; params: Record<string, unknown>; code: string }>; plan: (res: Results) => unknown }): FakeStep[] => [
  { tool: "report_progress", args: { message_ar: o.progress, counts: { sources: 3 } } },
  { tool: "catalog_search", args: { words: o.words, limit: 5 } },
  ...o.calls.flatMap((c, i): FakeStep[] => [
    { tool: "describe_endpoint", args: { id: c.endpoint } },
    { tool: "treg_call", args: { endpoint_id: c.endpoint, params: c.params, why } },
    { tool: "run_code", args: (r: Results) => ({ code: c.code, files: [callIds(r)[i]] }) },
  ]),
  { tool: "propose_plan", args: (r: Results) => o.plan(r) as Record<string, unknown> },
];
const columnsOf = (...c: Array<[string, string]>) => c.map(([key, title_ar]) => ({ key, title_ar }));

const COMPANIES = "tomba.companies.search.reveal";
const PEOPLE = "aviato.companies.employees";
const co = (name: string, site: string, city: string, description: string) => ({ name, website_url: site, country: "EG", city, company_size: "201-500", description, linkedin_url: `linkedin.com/company/${site.split(".")[0]}` });
const companies = { data: { companies: [
  co("Orascom Construction", "orascom.com", "Cairo", "Engineering and construction"),
  co("The Arab Contractors", "arabcont.com", "Cairo", "Contracting company"),
  co("El Hazek Contracting", "elhazek.com", "Giza", "Building and infrastructure works"),
  co("Nile Contracting Group", "nilegroup.example.com", "Giza", "Contractors"),
] } };
/** The people of a company as the source gives them: a position list with a start date WITHOUT a time, some missing fields. */
const person = (id: string, name: string, title: string, location: string, startDate: string | null) => ({ personID: id, person: { id, fullName: name, location, URLs: { linkedin: `linkedin.com/in/${id}` } }, positionList: [{ title, ...(startDate ? { startDate } : {}) }] });
const people = (site: string) => ({ employees: [
  person(`${site}-1`, `Manager One ${site}`, "Projects Manager", "Cairo, Egypt", "2022-03-01"),
  person(`${site}-2`, `Director Two ${site}`, "Regional Director", "", site === "elhazek.com" ? null : "2019-11-15"),
] });

const PEOPLE_MAP = "const rows = inputs.call_0002.employees || [];\nreturn rows.map(r => {\n  const p = r.person || {};\n  const pos = (r.positionList||[]).filter(x => !x.endDate);\n  const current = pos.length ? pos : (r.positionList||[]);\n  const titles = current.map(x => x.title).filter(Boolean);\n  const first = current.find(x => x.startDate) || (r.positionList||[]).find(x => x.startDate) || {};\n  const sd = first.startDate || r.startDate || '';\n  return {\n    id: String(r.personID || p.id || ''),\n    name: p.fullName || '',\n    title: titles.join(' | '),\n    location: p.location || '',\n    start_date: sd ? 'تاريخ البداية: ' + String(sd).split('T')[0] : '',\n    linkedin: p.URLs?.linkedin ? 'https://' + p.URLs.linkedin : '',\n    website: 'orascom.com'\n  };\n});";
const COMPANIES_MAP = "const rows = inputs.call_0001.data.companies || [];\nreturn rows.map(r => ({ id: String(r.website_url || r.name), name: r.name || '', country: r.country || '', city: r.city || '', website: r.website_url || '', company_size: r.company_size || '', description: r.description || '', linkedin: r.linkedin_url ? 'https://' + r.linkedin_url : '' }));";

const request = "عايز ٣ شركات مقاولات في مصر، ومن كل شركة اتنين من المديرين";
async function run() {
  return replay({
    request,
    planning: planFlow({
      progress: "أبحث عن شركات المقاولات ومديريها", words: ["companies", "search"],
      calls: [
        { endpoint: COMPANIES, params: { filters: { industry: { include: ["Construction"] }, location_country: { include: ["EG"] } } }, code: COMPANIES_MAP },
        { endpoint: PEOPLE, params: { website: "orascom.com", page: 1, perPage: 20 }, code: PEOPLE_MAP },
      ],
      plan: (res) => ({
        summary_ar: "ستحصل على شركات مقاولات مصرية مع بياناتها الأساسية، ومن كل شركة شخصان من موظفيها مع مسمياتهم الوظيفية.",
        stages: [
          { key: "companies", title_ar: "شركات مقاولات في مصر", endpoint_id: COMPANIES, expected_rows: 3, parent_key: null, deliver: true,
            columns: columnsOf(["name", "اسم الشركة"], ["city", "المدينة"], ["website", "الموقع الإلكتروني"], ["company_size", "حجم الشركة"], ["description", "نبذة عن الشركة"], ["linkedin", "رابط لينكدإن"]),
            sample_rows: [{ id: "orascom.com", name: "Orascom Construction", country: "EG", city: "Cairo", website: "orascom.com", company_size: "201-500", description: "Engineering and construction", linkedin: "https://linkedin.com/company/orascom" }], measured_by: [callIds(res)[0], firstOutputId(res)] },
          { key: "people", title_ar: "موظفون في كل شركة مقاولات مع مسمياتهم الوظيفية", endpoint_id: PEOPLE, expected_rows: 6, parent_key: "companies", per_parent_rows: 2, deliver: false,
            columns: columnsOf(["name", "الاسم"], ["title", "المسمى الوظيفي"], ["location", "المكان"], ["start_date", "تاريخ البداية في الوظيفة"], ["linkedin", "رابط لينكدإن"], ["website", "موقع الشركة"]),
            sample_rows: [{ id: "orascom.com-1", name: "Manager One orascom.com", title: "Projects Manager", location: "Cairo, Egypt", start_date: "تاريخ البداية: 2022-03-01", linkedin: "https://linkedin.com/in/orascom.com-1", website: "orascom.com" }], measured_by: [callIds(res)[1], "out_0002"] },
        ],
      }),
    }),
    execution: () => [],
    // planning: companies page, the first company's people; execution: companies page, then the people of each of the three companies (two come back, the page ends)
    answers: [tregResult(companies, 0.0005), tregResult(people("orascom.com"), 0.0005), tregResult(companies, 0.0005), ...["orascom.com", "arabcont.com", "elhazek.com"].map((s) => tregResult(people(s), 0.0005))],
  });
}

describe("Companies and their managers: the file's parent columns, dates and empty cells (live: the first company's website on every person; «02:00» on every start date; empty texts)", () => {
  async function peopleSheet() {
    const r = await run();
    const wb = await readWorkbook(r);
    expect(wb.worksheets).toHaveLength(3);
    const sheet = wb.worksheets[2];
    const header = (sheet.getRow(1).values as unknown[]).map((v) => String(v ?? ""));
    const col = (title: string) => { const i = header.findIndex((h) => h === title); expect(i, `column «${title}»`).toBeGreaterThan(0); return i; };
    const rows = Array.from({ length: sheet.rowCount - 1 }, (_, i) => sheet.getRow(i + 2));
    return { r, wb, sheet, col, rows };
  }

  it("delivered: three companies and two people each, the people in their own sheet", async () => {
    const r = await run();
    assertReplayInvariants(r, { expectDelivered: 9 });
  });

  it("«موقع الشركة» of every person is the website of ITS OWN company (the parent link), not the first company's", async () => {
    const { col, rows } = await peopleSheet();
    const site = col("موقع الشركة");
    const parent = col("معرّف الأصل");
    const parentLink = (row: any) => { const v = row.getCell(parent).value as any; return String(v?.text ?? v); };
    expect(rows.map(parentLink)).toEqual(["orascom.com", "orascom.com", "arabcont.com", "arabcont.com", "elhazek.com", "elhazek.com"]);
    expect(rows.map((row) => { const v = row.getCell(site).value as any; return String(v?.text ?? v); })).toEqual(["orascom.com", "orascom.com", "arabcont.com", "arabcont.com", "elhazek.com", "elhazek.com"]);
    // the columns that were already right stay right: the company's name next to each person
    const company = col("اسم الشركة");
    expect(rows.map((row) => String(row.getCell(company).value))).toEqual(["Orascom Construction", "Orascom Construction", "The Arab Contractors", "The Arab Contractors", "El Hazek Contracting", "El Hazek Contracting"]);
  });

  it("the fix is the admin's only: the mission carries an internal flag and a count of the rows repaired; the customer's view says nothing about it", async () => {
    const r = await run();
    const flag = r.store.events.find((e) => e.counts && (e.counts as Record<string, number>).adm_parent_fixed !== undefined);
    expect(flag).toBeTruthy();
    expect((flag!.counts as Record<string, number>).adm_parent_fixed).toBe(4);
    expect(String(r.mission.error)).toContain("parent_column_fixed");
    expect(JSON.stringify(r.finalView)).not.toMatch(/parent_column|adm_|أُصلح/);
  });

  it("a date with no time stays a date: no time of day, no zone shift (live: «2022-03-01 02:00»), the label of the mapping is not part of it", async () => {
    const { col, rows } = await peopleSheet();
    const start = col("تاريخ البداية في الوظيفة");
    const first = rows[0].getCell(start);
    expect(first.value).toBeInstanceOf(Date);
    const d = first.value as Date;
    expect([d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes()]).toEqual([2022, 3, 1, 0, 0]);
    expect(first.numFmt).toBe("yyyy-mm-dd");
    expect(String(first.numFmt)).not.toMatch(/hh|mm:/);
  });

  it("a missing value is an EMPTY cell, not an empty text (no location, no start date)", async () => {
    const { col, rows } = await peopleSheet();
    const location = col("المكان");
    const start = col("تاريخ البداية في الوظيفة");
    // the second person of every company has no location; the second person of «elhazek.com» has no start date either
    expect(rows.map((row) => row.getCell(location).value)).toEqual(["Cairo, Egypt", null, "Cairo, Egypt", null, "Cairo, Egypt", null]);
    expect(rows[5].getCell(start).value).toBeNull();
    expect(rows[1].getCell(start).value).toBeInstanceOf(Date);
  });

  it("the CSV (the same sheet) writes the date as «2022-03-01», with no time and no label", async () => {
    const r = await run();
    const csv = new TextDecoder().decode(await r.store.getFileBytes(r.missionId, "result/result.csv") as any);
    expect(csv).toContain("2022-03-01");
    expect(csv).toContain("2019-11-15");
    expect(csv).not.toMatch(/2022-03-01 \d{2}:\d{2}/);
    expect(csv).not.toContain("تاريخ البداية: ");
  });
});
