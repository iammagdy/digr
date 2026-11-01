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
 * REPLAY OF THE LIVE RE-TEST OF 2026-10-31 21:40-22:10 CAIRO, AFTER #316 (test account; `missions`, `mission_events` and `mission_calls` read with SELECT).
 *
 *   A1 «٥ شركات كهروميكانيكا + صناع القرار (اسم، مسمى، إيميل، تليفون)»  (msn_e750…): companies 5 of 5, NO people sheet; the people stage read 31 rows and delivered 0.
 *   A2 petroleum (msn_6fe6…): the same.
 *
 * THE DATA SHAPE (from the approved plan's people stage and the recorded calls): the people source (a company's decision makers by title) gives a NAME, a JOB TITLE and the person's professional page, never an e-mail or a phone; the mapping of the
 * approved plan writes `email: ''` and `phone: ''`; the stage's e-mail and phone columns are marked with a kind (the planner is told to), and the engine threw away every row of a contact stage with no verified e-mail or phone
 * (`rejected_no_verified_contact`: 31 read, 31 excluded, 0 delivered). The owner's rule: verification may decide whether an e-mail or phone CELL is filled, never whether the PERSON row is delivered.
 */
const COMPANIES = "tomba.companies.search.reveal";
const PEOPLE = "blitzapi.people.waterfall-icp";
const why = "the cheaper sources return no author or link fields in their catalog description";
const request = "عايز ٥ شركات مصرية في قطاع الكهروميكانيكا، ومعاهم صناع القرار: اسم المدير، المسمى الوظيفي، الإيميل، ورقم التليفون";

const SLUGS = ["orascom-em", "nile-em", "delta-em", "cairo-em", "suez-em"] as const;
const linkedinOf = (slug: string) => `https://linkedin.example/company/${slug}`;
const company = (slug: string, i: number) => ({ id: linkedinOf(slug), name: `${["Orascom", "Nile", "Delta", "Cairo", "Suez"][i]} Electromechanical`, website_url: `${slug}.com.eg`, linkedin_url: linkedinOf(slug), country: "EG", city: "Cairo", industry: "Electrical Equipment Manufacturing", company_size: "51-200", description: "Electromechanical works and contracting" });
const companiesPage = { data: { companies: SLUGS.map(company) } };

/** The 31 people the source gave for the five companies (live: 31 read), decision makers NOT first, none with an e-mail or a phone. */
const TITLES: Record<(typeof SLUGS)[number], string[]> = {
  "orascom-em": ["Site Engineer", "Project Engineer", "Chief Executive Officer", "Chairman", "Procurement Officer", "Accountant"],
  "nile-em": ["Sales Representative", "Managing Director", "General Manager", "Electrical Engineer", "Technician", "HR Specialist", "Consultant"],
  "delta-em": ["Director of Operations", "Operations Manager", "Engineer", "Mechanical Engineer", "Site Supervisor", "Admin Assistant"],
  "cairo-em": ["Founder & CEO", "Head of Projects", "Quality Engineer", "Quality Inspector", "Driver", "Receptionist"],
  "suez-em": ["Engineer", "Engineer II", "Technical Office Engineer", "Plant Manager", "Finance Manager", "Accountant"],
};
const personOf = (slug: (typeof SLUGS)[number], i: number, title: string) => ({ person: { full_name: `${["Hossam", "Mona", "Ahmed", "Salma", "Karim", "Nadia", "Tamer"][i]} ${slug.split("-")[0]}`, linkedin_url: `https://www.linkedin.example/in/${slug}-${i}`, experiences: [{ job_title: title, company_name: `${slug} co` }] } });
const peopleOfCompany = (slug: (typeof SLUGS)[number]) => ({ results: TITLES[slug].map((t, i) => personOf(slug, i, t)) });
const pickCompany = (o: TregCallOptions) => SLUGS.find((s) => JSON.stringify(o.params ?? {}).includes(s));
const peopleAnswer = (o: TregCallOptions) => { const s = pickCompany(o); return tregResult(s ? peopleOfCompany(s) : { results: [] }, 0.0005); };

const columnsOf = (...c: Array<[string, string, string?]>) => c.map(([key, title_ar, kind]) => ({ key, title_ar, ...(kind ? { kind } : {}) }));
const ccolumns = columnsOf(["name", "اسم الشركة"], ["city", "المدينة"], ["website", "الموقع الإلكتروني"], ["linkedin", "صفحة الشركة على الشبكة المهنية"]);
/** The approved plan's people columns: name, title, company, professional page, and the e-mail and phone MARKED with a kind. */
const pcolumns = columnsOf(["full_name", "الاسم"], ["job_title", "المسمى الوظيفي"], ["company", "الشركة"], ["linkedin", "الملف المهني للشخص"], ["email", "الإيميل", "work_email"], ["phone", "رقم التليفون", "phone"]);

const planArgs = (res: Results, assumptions?: string[]) => ({
      summary_ar: "ستحصل على ٥ شركات مصرية في الكهروميكانيكا، ومع كل شركة أبرز صناع القرار فيها بالاسم والمسمى الوظيفي وصفحتهم المهنية.",
      assumptions_ar: assumptions ?? ["صناع القرار: المدير التنفيذي والمدير العام والعضو المنتدب أولًا، ثم المديرون ورؤساء الأقسام."],
      stages: [
        { key: "companies", title_ar: "شركات مصرية في المعدات الكهربائية والميكانيكية", endpoint_id: COMPANIES, expected_rows: 5, parent_key: null, deliver: true, columns: ccolumns,
          sample_rows: [{ id: linkedinOf("orascom-em"), name: "Orascom Electromechanical", city: "Cairo", website: "orascom-em.com.eg", linkedin: linkedinOf("orascom-em") }], measured_by: [callIds(res)[0], firstOutputId(res)] },
        { key: "people", title_ar: "موظفو كل شركة", endpoint_id: PEOPLE, expected_rows: 10, parent_key: "companies", per_parent_rows: 2, deliver: true, columns: pcolumns,
          sample_rows: [{ id: "https://www.linkedin.example/in/orascom-em-2", full_name: "Karim orascom", job_title: "Chief Executive Officer", company: "orascom-em co", linkedin: "https://www.linkedin.example/in/orascom-em-2", email: "", phone: "" }], measured_by: [callIds(res)[1]] },
      ],
});
const planFlow = (firstAttempt?: { assumptions_ar: string[] }): FakeStep[] => [
  { tool: "report_progress", args: { message_ar: "أبحث عن الشركات ومسؤوليها", counts: { sources: 2 } } },
  { tool: "catalog_search", args: { words: ["companies", "search"], limit: 5 } },
  { tool: "describe_endpoint", args: { id: COMPANIES } },
  { tool: "treg_call", args: { endpoint_id: COMPANIES, params: { query: "electromechanical", page: 1 }, why } },
  { tool: "run_code", args: (r: Results) => ({ code: "return inputs.call_0001.data.companies.map(r => ({ id: r.linkedin_url, name: r.name, city: r.city || '', website: r.website_url || '', linkedin: r.linkedin_url || '' }))", files: [callIds(r)[0]] }) },
  { tool: "describe_endpoint", args: { id: PEOPLE } },
  { tool: "treg_call", args: { endpoint_id: PEOPLE, params: { company_linkedin_url: linkedinOf("orascom-em"), cascade: [{ include_title: ["Chief Executive Officer", "Managing Director", "General Manager", "Chairman"] }, { include_title: ["Director", "Head of", "Manager"] }], max_results: 10 }, why } },
  { tool: "run_code", args: (r: Results) => ({ code: "return inputs.call_0002.results.map(r => { const p = r.person || {}; const exp = (p.experiences && p.experiences[0]) || {}; return { id: p.linkedin_url, full_name: p.full_name, job_title: exp.job_title || '', company: exp.company_name || '', linkedin: p.linkedin_url, email: '', phone: '' }; })", files: [callIds(r)[1]] }) },
  ...(firstAttempt ? [{ tool: "propose_plan", args: (res: Results) => planArgs(res, firstAttempt.assumptions_ar) }] : []),
  { tool: "propose_plan", args: (res: Results) => planArgs(res) },
];
async function run(firstAttempt?: { assumptions_ar: string[] }) {
  return replay({
    request,
    planning: planFlow(firstAttempt),
    execution: () => [],
    answers: [tregResult(companiesPage, 0.0005), tregResult(peopleOfCompany("orascom-em"), 0.0005), tregResult(companiesPage, 0.0005), ...Array.from({ length: 12 }, () => peopleAnswer)],
  });
}

describe("A1 replay: a person with a name and a job title is delivered with empty e-mail and phone cells (live: 31 read, 31 excluded, 0 delivered)", () => {
  it("delivered: 5 companies + 2 decision makers of each (10 people), charged for 15 by the one unit price", async () => {
    const r = await run();
    const snap = await readSnapshot(r.store, r.missionId);
    // the source's people are never excluded for lacking a verified contact
    expect(snap.counts("people").excludedByReason.no_verified_contact ?? 0).toBe(0);
    expect(snap.counts("people").accepted).toBe(10);
    assertReplayInvariants(r, { expectDelivered: 15 });
    const unit = r.plannedPlan.price.unitPricePoints;
    expect(Number(r.mission.charged_points)).toBe(settlementCharge({ deliveredUnits: 15, unitPricePoints: unit, reservedPoints: r.plannedPlan.price.reservePoints }).chargedPoints);
  });

  it("the people are the DECISION MAKERS first (the source gave engineers before the chiefs), two per company", async () => {
    const r = await run();
    const snap = await readSnapshot(r.store, r.missionId);
    const titles = snap.acceptedRows("people").map((p) => String(p.job_title)).sort();
    expect(titles).toEqual([
      "Chairman", "Chief Executive Officer", "Director of Operations", "Finance Manager", "Founder & CEO", "General Manager", "Head of Projects", "Managing Director", "Operations Manager", "Plant Manager",
    ]);
  });

  it("the file: a people sheet with names, titles and professional pages; the e-mail and phone cells are empty (nothing was verified), no row of people is missing; the settlement's count of the file is 5 + 10", async () => {
    const r = await run();
    const wb = await readWorkbook(r);
    expect(wb.worksheets).toHaveLength(3);
    const peopleSheet = wb.worksheets[2];
    expect(peopleSheet.rowCount).toBe(11);
    const header = (peopleSheet.getRow(1).values as unknown[]).map((v) => String(v ?? ""));
    const col = (title: string) => header.findIndex((h) => h === title);
    expect(col("الاسم")).toBeGreaterThan(0);
    expect(col("المسمى الوظيفي")).toBeGreaterThan(0);
    expect(col("الملف المهني للشخص")).toBeGreaterThan(0);
    for (let n = 2; n <= 11; n += 1) {
      const row = peopleSheet.getRow(n);
      expect(String(row.getCell(col("الاسم")).value ?? "").trim(), `name of row ${n}`).not.toBe("");
      expect(String(row.getCell(col("المسمى الوظيفي")).value ?? "").trim(), `title of row ${n}`).not.toBe("");
      expect(String(row.getCell(col("الملف المهني للشخص")).value ?? "").trim(), `page of row ${n}`).not.toBe("");
      expect(row.getCell(col("الإيميل")).value ?? null).toBeNull();
      expect(row.getCell(col("رقم التليفون")).value ?? null).toBeNull();
    }
    const stored = await r.store.getFileBytes(r.missionId, "result/result.xlsx");
    expect(await countWorkbookSheets(stored as never)).toEqual([5, 10]);
  });
});

describe("A2 shape (petroleum): 41 rows read, 9 repeats, 32 distinct people with names and titles and no contact: all are people, none is dropped for a missing contact", () => {
  const stage = (over: Record<string, unknown> = {}) => ({ key: "people", title_ar: "صناع القرار في كل شركة (المديرون)", endpoint_id: "blitzapi.people.employee-finder", expected_rows: 10, planned_rows: 10, parent_key: "companies", per_parent_rows: 2, deliver: true, columns: pcolumns, sample_rows: [], measured_by: [], ...over });
  const companiesStage = { key: "companies", title_ar: "شركات مصرية في قطاع البترول", endpoint_id: "parallel.companies.search", expected_rows: 5, planned_rows: 5, parent_key: null, deliver: true, columns: ccolumns, sample_rows: [], measured_by: [] };
  const person = (parent: string, n: number, title: string) => ({ id: `${parent}-p${n}`, parent_id: parent, full_name: `Person ${parent} ${n}`, job_title: title, company: parent, linkedin: `https://www.linkedin.example/in/${parent}-${n}`, email: "", phone: "" });
  async function open() {
    const { createMemoryStore } = await import("../agent/src/memoryStore");
    const { ItemStore } = await import("../agent/src/items/itemStore");
    const { ingestRows } = await import("../agent/src/items/ingest");
    const store = createMemoryStore();
    const items = await ItemStore.open(store, "msn_people_a2");
    return { items, ingestRows };
  }

  it("the people of five companies: 41 read (9 repeats), 32 distinct, ALL delivered up to the approved two per company, none excluded as «no verified contact»", async () => {
    const { items, ingestRows } = await open();
    const plan = { summary_ar: "x", price: { deliveredRows: 15 }, stages: [companiesStage, stage()] } as never;
    const deps = { items, plan, addEvent: async () => undefined };
    const parents = ["pc1", "pc2", "pc3", "pc4", "pc5"];
    await ingestRows(deps, (plan as any).stages[0], parents.map((id) => ({ id, name: `Petro ${id}` })), { silent: true, idField: null });
    let read = 0;
    for (const [i, parent] of parents.entries()) {
      // 32 distinct people over the five companies (7, 7, 6, 6, 6); nine of the rows the source gave are repeats of an earlier row of the same company
      const n = [7, 7, 6, 6, 6][i];
      const rows = Array.from({ length: n }, (_, k) => person(parent, k, k === 3 ? "Managing Director" : k === 4 ? "General Manager" : "Petroleum Engineer"));
      const repeats = [2, 2, 2, 2, 1][i];
      const given = [...rows, ...rows.slice(0, repeats)];
      read += given.length;
      await ingestRows(deps, (plan as any).stages[1], given, { silent: true, idField: null, acceptCap: 2 });
    }
    expect(read).toBe(41);
    const c = items.counts("people");
    expect(c.duplicates).toBe(9);
    expect(c.excludedByReason.no_verified_contact ?? 0).toBe(0);
    expect(c.accepted).toBe(10);
    const delivered = items.acceptedRows("people");
    expect(delivered.every((p) => String(p.full_name).startsWith("Person") && String(p.job_title) !== "" && String(p.linkedin) !== "")).toBe(true);
    expect(delivered.every((p) => p.email === "" && p.phone === "")).toBe(true);
  });

  // CHANGED (owner direction 2026-11-01: never drop a found contact value for being unverified): the personal address is KEPT in the cell with «غير موثّق» beside it; the work address is «موثّق»
  it("a personal address is kept in the cell marked «غير موثّق» and the person stays; a well-formed work address is kept too, «غير موثّق» until a verifier says otherwise", async () => {
    const { items, ingestRows } = await open();
    const plan = { summary_ar: "x", price: { deliveredRows: 4 }, stages: [companiesStage, stage()] } as never;
    const deps = { items, plan, addEvent: async () => undefined };
    await ingestRows(deps, (plan as any).stages[0], [{ id: "pc1", name: "Petro one" }], { silent: true, idField: null });
    await ingestRows(deps, (plan as any).stages[1], [
      { ...person("pc1", 0, "General Manager"), email: "mona@gmail.com" },
      { ...person("pc1", 1, "Managing Director"), email: "karim@petro-one.com.eg", phone: "+20 100 123 4567" },
    ], { silent: true, idField: null });
    const rows = items.acceptedRows("people");
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.job_title === "General Manager")!.email).toBe("mona@gmail.com");
    expect(rows.find((r) => r.job_title === "General Manager")!.email_status).toBe("غير موثّق");
    // CHANGED (item 2, owner direction): ingest never writes «موثّق» for an e-mail (a code check says the address is well formed, not that a mailbox exists); the contact step writes it on a verifier's answer
    expect(rows.find((r) => r.job_title === "Managing Director")!.email_status).toBe("غير موثّق");
    expect(rows.find((r) => r.job_title === "Managing Director")!.email).toBe("karim@petro-one.com.eg");
    expect(String(rows.find((r) => r.job_title === "Managing Director")!.phone)).toMatch(/^\+?20/);
  });

  it("what is NOT a person is still left out: a row with no name and no contact, a role mailbox with a name beside it, and an e-mail finder's row with no verified address", async () => {
    const { items, ingestRows } = await open();
    const emailStage = { key: "emails", title_ar: "إيميلات المسؤولين", endpoint_id: "blitzapi.people.email.find", expected_rows: 10, planned_rows: 10, parent_key: "people", per_parent_rows: 1, deliver: true, columns: columnsOf(["email", "الإيميل", "work_email"]), sample_rows: [], measured_by: [] };
    const plan = { summary_ar: "x", price: { deliveredRows: 8 }, stages: [companiesStage, stage(), emailStage] } as never;
    const deps = { items, plan, addEvent: async () => undefined };
    await ingestRows(deps, (plan as any).stages[0], [{ id: "pc1", name: "Petro one" }], { silent: true, idField: null });
    await ingestRows(deps, (plan as any).stages[1], [
      { ...person("pc1", 0, ""), full_name: "", linkedin: "" },
      { ...person("pc1", 1, "Sales"), full_name: "John Smith", email: "sales@petro-one.com.eg" },
      { ...person("pc1", 2, "Chairman") },
    ], { silent: true, idField: null });
    expect(items.counts("people").accepted).toBe(1);
    expect(items.counts("people").excludedByReason.no_verified_contact).toBe(1);
    expect(items.counts("people").excludedByReason.not_a_person).toBe(1);
    await ingestRows(deps, (plan as any).stages[2], [{ id: "e1", parent_id: "pc1-p2", email: "someone@gmail.com" }], { silent: true, idField: null });
    expect(items.counts("emails").accepted).toBe(0);
    expect(items.counts("emails").excludedByReason.no_verified_contact).toBe(1);
  });
});

describe("the planner's first plan said the people come only with a verified contact: it is sent back, and the plan that settles keeps every person", () => {
  it("the conditional sentence is refused by the plan check; the corrected plan is accepted and delivers the 10 people", async () => {
    const r = await run({ assumptions_ar: ["نسلّم المديرين فقط إذا ظهر لهم إيميل أو تليفون تحقق منه النظام."] });
    const proposals = r.planningDriver.results.filter((x) => x.tool === "propose_plan");
    expect(proposals).toHaveLength(2);
    expect(proposals[0].result.ok).toBe(false);
    expect(JSON.stringify(proposals[0].result)).toMatch(/conditional on a verified e-mail or phone/);
    expect(proposals[1].result.ok).toBe(true);
    const snap = await readSnapshot(r.store, r.missionId);
    expect(snap.counts("people").accepted).toBe(10);
    expect(r.mission.delivered_units).toBe(15);
  });
});
