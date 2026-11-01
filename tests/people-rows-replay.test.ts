import { describe, expect, it } from "vitest";
import { assertReplayInvariants, readWorkbook, replay } from "./helpers/agentReplay";
import { callIds, tregResult, type Results } from "./helpers/agentFakeWorld";
import { firstOutputId } from "./helpers/agentRelevance";
import { readSnapshot } from "../agent/src/items/itemStore";
import type { FakeStep } from "../agent/src/fakeDriver";
import { countWorkbookSheets } from "../agent/src/finalize";
import { settlementCharge } from "../src/lib/agentMission/price";
import type { TregCallOptions } from "../src/functions/shared/tregClient";

/**
 * REPLAY OF THE LIVE RETEST OF 2026-10-31 16:20 (A1 «٥ شركات كهروميكانيكا + صناع القرار», A2 petroleum). The people source gave role mailboxes (info@, customer_care@, webmaster@, a «Petro Consultants») beside the named people of some companies;
 * they were saved as people, counted as delivered people and charged (A1: 14 of 15 delivered, 187 points, while ONE row was a named person).
 *
 * Now: a row that is not a person goes to the COMPANY sheet as a company e-mail; it is not a person row, is not counted as a decision maker and is not charged. The count the settlement reads is the people sheet's, so the charge follows.
 */
const COMPANIES = "tomba.companies.search.reveal";
const PEOPLE = "aviato.companies.employees";
const why = "the cheaper sources return no author or link fields in their catalog description";
const co = (name: string, site: string, city: string, description: string) => ({ id: site, name, website_url: site, country: "EG", city, company_size: "51-200", industry: "Electrical", description });
const companies = { companies: [
  co("Orascom Electromechanical", "orascom-em.com.eg", "Cairo", "Electromechanical works and contracting"),
  co("Nile Electromechanical Systems", "nile-em.com.eg", "Giza", "Electromechanical installations"),
  co("Delta Electromechanical Works", "delta-em.com.eg", "Giza", "Electromechanical contractors"),
] };
const row = (site: string, i: number, name: string, title: string, email: string) => ({ id: `${site}-p${i}`, full_name: name, job_title: title, email, profile_url: name ? `https://linkedin.example/in/${site}-${i}` : "" });
/** What the source gave for each company: named people mixed with role mailboxes, as in the live files. */
const PAGES: Record<string, Array<ReturnType<typeof row>>> = {
  "orascom-em.com.eg": [row("orascom-em.com.eg", 0, "Hossam Fathy", "General Manager", "hossam@orascom-em.com.eg"), row("orascom-em.com.eg", 1, "", "", "info@orascom-em.com.eg"), row("orascom-em.com.eg", 2, "Mona Said", "Director of Projects", "mona.said@orascom-em.com.eg")],
  "nile-em.com.eg": [row("nile-em.com.eg", 0, "", "", "customer_care@nile-em.com.eg"), row("nile-em.com.eg", 1, "", "", "webmaster@nile-em.com.eg")],
  "delta-em.com.eg": [row("delta-em.com.eg", 0, "Petro Consultants", "", "petro.consultants@delta-em.com.eg"), row("delta-em.com.eg", 1, "Ahmed Nabil", "Owner", "ahmed@delta-em.com.eg")],
};
const request = "عايز ٣ شركات كهروميكانيكا، ومن كل شركة اتنين من المديرين بالاسم والمسمى والإيميل";
const columnsOf = (...c: Array<[string, string, string?]>) => c.map(([key, title_ar, kind]) => ({ key, title_ar, ...(kind ? { kind } : {}) }));
const ccolumns = columnsOf(["name", "اسم الشركة"], ["city", "المدينة"], ["website", "الموقع الإلكتروني"], ["description", "نبذة عن الشركة"]);
const pcolumns = columnsOf(["name", "الاسم"], ["title", "المسمى الوظيفي"], ["email", "الإيميل", "work_email"]);
const pad = (n: number) => String(n).padStart(6, "0");
void pad;
const planFlow = (): FakeStep[] => [
  { tool: "report_progress", args: { message_ar: "أبحث عن الشركات ومسؤوليها", counts: { sources: 2 } } },
  { tool: "catalog_search", args: { words: ["companies", "search"], limit: 5 } },
  { tool: "describe_endpoint", args: { id: COMPANIES } },
  { tool: "treg_call", args: { endpoint_id: COMPANIES, params: { query: "electromechanical", page: 1 }, why } },
  { tool: "run_code", args: (r: Results) => ({ code: "return inputs.call_0001.companies.map(c => ({ id: c.id, name: c.name, website: 'https://' + c.website_url, city: c.city || '', description: c.description }))", files: [callIds(r)[0]] }) },
  { tool: "describe_endpoint", args: { id: PEOPLE } },
  { tool: "treg_call", args: { endpoint_id: PEOPLE, params: { website: "https://orascom-em.com.eg", perPage: 10, page: 1 }, why } },
  { tool: "run_code", args: (r: Results) => ({ code: "return inputs.call_0002.rows.map(p => ({ id: p.id, name: p.full_name, title: p.job_title, email: p.email }))", files: [callIds(r)[1]] }) },
  {
    tool: "propose_plan",
    args: (res: Results) => ({
      summary_ar: "ستحصل على شركات كهروميكانيكا مصرية مع بياناتها الأساسية، ومن كل شركة شخصان من مسؤوليها مع مسمياتهم وإيميلاتهم.",
      stages: [
        { key: "companies", title_ar: "شركات كهروميكانيكا مصرية", endpoint_id: COMPANIES, expected_rows: 3, parent_key: null, deliver: true, columns: ccolumns,
          sample_rows: [{ id: "orascom-em.com.eg", name: "Orascom Electromechanical", website: "https://orascom-em.com.eg", city: "Cairo", description: "Electromechanical works and contracting" }], measured_by: [callIds(res)[0], firstOutputId(res)] },
        { key: "people", title_ar: "مسؤولو الشركات ومسمياتهم وإيميلاتهم", endpoint_id: PEOPLE, expected_rows: 6, parent_key: "companies", per_parent_rows: 2, deliver: true, columns: pcolumns,
          sample_rows: [{ id: "orascom-em.com.eg-p0", name: "Hossam Fathy", title: "General Manager", email: "hossam@orascom-em.com.eg" }], measured_by: [callIds(res)[1]] },
      ],
    }),
  },
];
const page = (site: string) => ({ rows: PAGES[site] });
/** The source answers for the company that was asked, whatever the order of the calls (a company with no person is asked again through its next input, and is told the same). */
const peopleOf = (o: TregCallOptions) => { const site = Object.keys(PAGES).find((s) => JSON.stringify(o.params ?? {}).includes(s)); return tregResult(site ? page(site) : { rows: [] }, 0.0005); };
async function run() {
  return replay({
    request,
    planning: planFlow(),
    execution: () => [],
    answers: [tregResult(companies, 0.0005), tregResult(page("orascom-em.com.eg"), 0.0005), tregResult(companies, 0.0005), ...Array.from({ length: 12 }, () => peopleOf)],
  });
}

describe("A1/A2 replay: role mailboxes and nameless rows are company e-mails, not people", () => {
  it("delivered: 3 companies + the 3 real people (not the 9 rows the source gave), charged for 6 by the one unit price", async () => {
    const r = await run();
    assertReplayInvariants(r, { expectDelivered: 6, expectStatus: "partial" });
    const snap = await readSnapshot(r.store, r.missionId);
    const people = snap.acceptedRows("people").map((p) => String(p.name)).sort();
    expect(people).toEqual(["Ahmed Nabil", "Hossam Fathy", "Mona Said"]);
    // the four rows that are not people are kept with their reason (and their address), never delivered as people
    expect(snap.counts("people").excludedByReason.not_a_person).toBe(4);
    const unit = r.plannedPlan.price.unitPricePoints;
    expect(Number(r.mission.charged_points)).toBe(settlementCharge({ deliveredUnits: 6, unitPricePoints: unit, reservedPoints: r.plannedPlan.price.reservePoints }).chargedPoints);
    expect(r.mission.delivered_units).toBe(6);
  });

  it("the file: the people sheet holds only people; the mailboxes are in a column of the COMPANY sheet; the settlement's count of the file is 3 + 3", async () => {
    const r = await run();
    const wb = await readWorkbook(r);
    expect(wb.worksheets).toHaveLength(3);
    const [, companiesSheet, peopleSheet] = wb.worksheets;
    expect(peopleSheet.rowCount).toBe(4);
    const peopleText = JSON.stringify(peopleSheet.getSheetValues());
    for (const mailbox of ["info@", "customer_care@", "webmaster@", "petro.consultants@"]) expect(peopleText).not.toContain(mailbox);
    expect(peopleText).toContain("hossam@orascom-em.com.eg");
    const header = (companiesSheet.getRow(1).values as unknown[]).map((v) => String(v ?? ""));
    // CHANGED (PR 1 part b, reference A column 5): the best role mailbox of each company is its «الإيميل العام للشركة»; any OTHER mailbox found for it stays in «إيميلات عامة للشركة» (a found value is never dropped)
    const col = header.findIndex((h) => h === "إيميلات عامة للشركة");
    const mainCol = header.findIndex((h) => h === "الإيميل العام للشركة");
    expect(col).toBeGreaterThan(0);
    expect(mainCol).toBeGreaterThan(0);
    const cell = (n: number) => `${String(companiesSheet.getRow(n).getCell(mainCol).value ?? "")}|${String(companiesSheet.getRow(n).getCell(col).value ?? "")}`;
    const mailboxes = [2, 3, 4].map(cell);
    expect(mailboxes.join("|")).toContain("info@orascom-em.com.eg");
    expect(mailboxes.join("|")).toContain("customer_care@nile-em.com.eg");
    expect(mailboxes.join("|")).toContain("webmaster@nile-em.com.eg");
    expect(mailboxes.join("|")).toContain("petro.consultants@delta-em.com.eg");
    // the column adds no row: the count the settlement reads is the rows of the sheets after the first
    const stored = await r.store.getFileBytes(r.missionId, "result/result.xlsx");
    expect(await countWorkbookSheets(stored as never)).toEqual([3, 3]);
  });

  it("«المنصات والمصادر المستخدمة» says what kind of source each stage read, not «غير مسجّل», and never a provider's name", async () => {
    const r = await run();
    const wb = await readWorkbook(r);
    const rows = wb.worksheets[0].getSheetValues() as unknown[][];
    const row = rows.find((v) => Array.isArray(v) && v[1] === "المنصات والمصادر المستخدمة")!;
    expect(row).toBeTruthy();
    const text = String(row[2]);
    expect(text).toContain("قاعدة بيانات الشركات");
    expect(text).toContain("مصدر بيانات الموظفين والمسؤولين");
    expect(text).not.toContain("غير مسجّل");
    expect(text).not.toMatch(/tomba|aviato|blitz/i);
  });

  it("the methodology says what left out the four rows, in Arabic, with no provider name", async () => {
    const r = await run();
    const wb = await readWorkbook(r);
    const summary = JSON.stringify(wb.worksheets[0].getSheetValues());
    expect(summary).toContain("بريد عام");
    expect(summary).not.toMatch(/aviato|tomba|blitz/i);
  });
});

describe("the planner is sent back from an e-mail lister to a people source, once, and the plan it settles on is the people source's", () => {
  const LISTER = "tomba.companies.emails.list";
  const noPhone = "عايز ٣ شركات كهروميكانيكا، ومن كل شركة اتنين من المديرين بالاسم والمسمى والإيميل";
  const mapCode = (call: string, from: string) => `return inputs.${call}.rows.map(p => ({ id: p.id, name: p.full_name, title: p.job_title, email: p.email }))` + (from ? "" : "");
  const stageOf = (endpoint: string, measured: string) => ({ key: "people", title_ar: "مسؤولو الشركات ومسمياتهم وإيميلاتهم", endpoint_id: endpoint, expected_rows: 6, parent_key: "companies", per_parent_rows: 2, deliver: true, columns: pcolumns,
    sample_rows: [{ id: "orascom-em.com.eg-p0", name: "Hossam Fathy", title: "General Manager", email: "hossam@orascom-em.com.eg" }], measured_by: [measured] });
  const companiesStageOf = (res: Results) => ({ key: "companies", title_ar: "شركات كهروميكانيكا مصرية", endpoint_id: COMPANIES, expected_rows: 3, parent_key: null, deliver: true, columns: ccolumns,
    sample_rows: [{ id: "orascom-em.com.eg", name: "Orascom Electromechanical", website: "https://orascom-em.com.eg", city: "Cairo", description: "Electromechanical works and contracting" }], measured_by: [callIds(res)[0], firstOutputId(res)] });
  const summary = "ستحصل على شركات كهروميكانيكا مصرية مع بياناتها الأساسية، ومن كل شركة شخصان من مسؤوليها مع مسمياتهم وإيميلاتهم.";
  const flow = (): FakeStep[] => [
    { tool: "report_progress", args: { message_ar: "أبحث عن الشركات ومسؤوليها", counts: { sources: 2 } } },
    { tool: "catalog_search", args: { words: ["companies", "search"], limit: 5 } },
    { tool: "describe_endpoint", args: { id: COMPANIES } },
    { tool: "treg_call", args: { endpoint_id: COMPANIES, params: { query: "electromechanical", page: 1 }, why } },
    { tool: "run_code", args: (r: Results) => ({ code: "return inputs.call_0001.companies.map(c => ({ id: c.id, name: c.name, website: 'https://' + c.website_url, city: c.city || '', description: c.description }))", files: [callIds(r)[0]] }) },
    // THE LIVE PLAN: the people from the lister of a domain's mailboxes
    { tool: "describe_endpoint", args: { id: LISTER } },
    { tool: "treg_call", args: { endpoint_id: LISTER, params: { domain: "orascom-em.com.eg", limit: 10 }, why } },
    { tool: "run_code", args: (r: Results) => ({ code: mapCode("call_0002", "x"), files: [callIds(r)[1]] }) },
    { tool: "propose_plan", args: (r: Results) => ({ summary_ar: summary, stages: [companiesStageOf(r), stageOf(LISTER, callIds(r)[1])] }) },
    // after the send-back: a people source
    { tool: "describe_endpoint", args: { id: PEOPLE } },
    { tool: "treg_call", args: { endpoint_id: PEOPLE, params: { website: "https://orascom-em.com.eg", perPage: 10, page: 1 }, why } },
    { tool: "run_code", args: (r: Results) => ({ code: mapCode("call_0003", ""), files: [callIds(r)[2]] }) },
    { tool: "propose_plan", args: (r: Results) => ({ summary_ar: summary, stages: [companiesStageOf(r), stageOf(PEOPLE, callIds(r)[2])] }) },
  ];
  async function run() {
    return replay({
      request: noPhone, planning: flow(), execution: () => [],
      answers: [tregResult(companies, 0.0005), tregResult(page("orascom-em.com.eg"), 0.0005), tregResult(page("orascom-em.com.eg"), 0.0005), tregResult(companies, 0.0005), ...Array.from({ length: 12 }, () => peopleOf)],
    });
  }
  it("the first proposal (the lister) is sent back naming the mailbox problem and the people sources; the second (a people source) is accepted and carried out", async () => {
    const r = await run();
    const proposals = r.planningDriver.results.filter((x) => x.tool === "propose_plan");
    expect(proposals).toHaveLength(2);
    expect(proposals[0].result.ok).toBe(false);
    expect(JSON.stringify(proposals[0].result)).toContain("mailbox");
    expect(JSON.stringify(proposals[0].result)).toContain("aviato.companies.employees");
    expect(proposals[1].result.ok).toBe(true);
    expect(r.plannedPlan.stages.find((s) => s.key === "people")!.endpoint_id).toBe(PEOPLE);
    assertReplayInvariants(r, { expectDelivered: 6, expectStatus: "partial" });
  });
});
