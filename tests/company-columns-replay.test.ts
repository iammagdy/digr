import { describe, expect, it, vi } from "vitest";
import { assertReplayInvariants, readWorkbook, replay } from "./helpers/agentReplay";
import { COMPANIES, PEOPLE, SLUGS, company, linkedinOf, peopleAnswer, peopleOfCompany, request, why, columnsOf } from "./helpers/a1World";
import { callIds, tregResult, type Results } from "./helpers/agentFakeWorld";
import { firstOutputId } from "./helpers/agentRelevance";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { executionBudgetUsd } from "../src/lib/agentMission/price";
import type { FakeStep } from "../agent/src/fakeDriver";
import type { TregCallOptions } from "../src/functions/shared/tregClient";

vi.stubGlobal("fetch", () => { throw new Error("a real network call was attempted"); });

/**
 * GOLDEN PROMPT G1 (docs/AUDIT-2026-11.md section 7), OFFLINE REPLAY, PART b: the company's own e-mail and HQ phone are COLUMNS OF THE COMPANY (reference A, columns 5 and 6, the owner's top priority).
 * The five companies of the A1 world now carry what the free companies source really gives (a phone and a street address for three of them, none for two). BEFORE: no company e-mail column, no HQ phone column (msn_7539…, msn_4969…).
 * AFTER: the HQ phone is the source's own value (zero extra cost); a role mailbox found anywhere (the people source, then a lister) is the company e-mail, verified «موثّق» / «غير موثّق»; the phone of a company whose own data has none is looked up once on a map search;
 * what is not found is «غير متوفر». The delivered count and the charge do not move.
 */
const catalog = loadTregCatalog();
const cell = (v: unknown) => String(v ?? "").trim();
const PHONES = ["+20 2 2574 0001", "+20 2 2574 0002", "+20 2 2574 0003", "", ""];
const co = (slug: string, i: number) => ({ ...company(slug, i), website_url: `${slug}.com.eg`, phone_number: PHONES[i], street_address: `${i + 1} Industrial Zone, Cairo` });
const companiesPage = { data: { companies: SLUGS.map(co) } };
/** Nile's people source also lists its role mailbox (info@): not a person, kept as the company's own e-mail. */
const peopleWithMailbox = (slug: (typeof SLUGS)[number]) => {
  const page = peopleOfCompany(slug) as { results: unknown[] };
  return slug === "nile-em" ? { results: [...page.results, { person: { full_name: "", linkedin_url: "https://www.linkedin.example/in/nile-mailbox", email: "info@nile-em.com.eg", experiences: [] } }] } : page;
};
const domainOf = (o: TregCallOptions) => String((o.params as Record<string, unknown> | undefined)?.domain ?? (o.params as Record<string, unknown> | undefined)?.domainOrCompany ?? "");

const LISTER_ANSWERS: Record<string, unknown> = {
  "orascom-em.com.eg": { data: { emails: [{ email: "sales@orascom-em.com.eg" }, { email: "info@orascom-em.com.eg" }, { email: "hossam@orascom-em.com.eg" }] } },
  "delta-em.com.eg": { data: { emails: [{ email: "webmaster@delta-em.com.eg" }] } },
  "cairo-em.com.eg": { data: { emails: [] } },
  "suez-em.com.eg": { data: { emails: [{ email: "info@other-domain.com" }] } },
};
function dispatcher() {
  return (o: TregCallOptions) => {
    const capability = catalog.byId.get(o.endpointId)?.capability ?? "";
    const who = JSON.stringify(o.params ?? {});
    if (o.endpointId === COMPANIES) return tregResult(companiesPage, 0.0005);
    if (o.endpointId === PEOPLE) { const s = SLUGS.find((x) => who.includes(x)); return tregResult(s ? peopleWithMailbox(s) : { results: [] }, 0.0005); }
    if (capability === "companies.emails.list") return tregResult(LISTER_ANSWERS[domainOf(o)] ?? { data: { emails: [] } }, 0.0089);
    if (capability === "people.email.verify") return tregResult(who.includes("delta-em") ? { status: "invalid", deliverable: false } : { status: "safe", deliverable: true, is_catch_all: false }, 0.00178);
    if (capability === "google.serp.maps") return tregResult(who.includes("Cairo Electromechanical") ? { rows: [{ name: "Cairo Electromechanical", phone: "+20 2 2777 0005", website: "https://cairo-em.com.eg", address: "Cairo" }] } : { rows: [] }, 0.00015);
    if (capability === "people.phone.verify") return tregResult({ valid: true, is_valid: true, country_code: "EG" }, 0);
    // the people's own finders find nothing in this replay (their cells are the people-step replays' business)
    return tregResult({ found: false }, 0);
  };
}

const planFlow = (): FakeStep[] => {
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
          sample_rows: [{ id: linkedinOf("orascom-em"), name: "Orascom Electromechanical", activity: "Electrical Equipment Manufacturing", city: "Cairo", website: "orascom-em.com.eg", phone: PHONES[0], address: "1 Industrial Zone, Cairo", linkedin: linkedinOf("orascom-em") }], measured_by: [callIds(res)[0], firstOutputId(res)] },
        { key: "people", title_ar: "موظفو كل شركة", endpoint_id: PEOPLE, expected_rows: 10, parent_key: "companies", per_parent_rows: 2, deliver: true, columns: pcols,
          sample_rows: [{ id: "https://www.linkedin.example/in/orascom-em-2", full_name: "Karim orascom", job_title: "Chief Executive Officer", company: "orascom-em co", linkedin: "https://www.linkedin.example/in/orascom-em-2", email: "", phone: "" }], measured_by: [callIds(res)[1]] },
      ],
    }) },
  ];
};
const g1 = () => replay({ request, planning: planFlow(), execution: () => [], answers: Array.from({ length: 200 }, () => dispatcher()) });

async function companySheet(r: Awaited<ReturnType<typeof g1>>) {
  const sheet = (await readWorkbook(r)).worksheets[1];
  const header = (sheet.getRow(1).values as unknown[]).map(cell);
  const rows = Array.from({ length: sheet.rowCount - 1 }, (_, i) => sheet.getRow(i + 2));
  const col = (title: string) => { const at = header.indexOf(title); expect(at, `column «${title}» in ${JSON.stringify(header)}`).toBeGreaterThan(0); return rows.map((row) => cell(row.getCell(at).value)); };
  return { header, rows, col };
}

describe("G1 replay, part b: the company sheet", () => {
  it("the company sheet carries the reference columns in the reference order: name, sector, website, e-mail with its status, HQ phone", async () => {
    const r = await g1();
    const { header } = await companySheet(r);
    const order = ["اسم الشركة", "النشاط والتخصص", "الموقع الإلكتروني", "الإيميل العام للشركة", "حالة توثيق الإيميل العام للشركة", "هاتف المقر الرئيسي"];
    const at = order.map((t) => header.indexOf(t));
    expect(at.every((i) => i > 0), JSON.stringify(header)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    // the planner's other columns follow the reference's, the system columns stay last, and the old by-product column is gone (its addresses ARE the company e-mail now)
    expect(header).not.toContain("إيميلات عامة للشركة");
    expect(header.indexOf("المدينة")).toBeGreaterThan(at[at.length - 1]);
  });

  it("the HQ phone is the source's own value for the three companies that have one; the two that have none are looked up on a map search (the chain stops at the first answer): one is found (written in the normalized form the people's phones are), one is «غير متوفر»", async () => {
    const r = await g1();
    const s = await companySheet(r);
    expect(s.col("هاتف المقر الرئيسي")).toEqual([PHONES[0], PHONES[1], PHONES[2], "+20227770005", "غير متوفر"]);
    const maps = (await r.store.listCalls(r.missionId)).filter((c) => c.phase === "execution" && catalog.byId.get(c.endpoint_id)?.capability === "google.serp.maps");
    // the company step asks once for Cairo (found) and walks the chain for Suez (three searches, nothing); the people's step does not pay for the same search again
    expect(maps.length).toBe(4);
    expect(new Set(maps.map((c) => JSON.stringify((c.params_digest as Record<string, unknown>).q ?? (c.params_digest as Record<string, unknown>).query))).size).toBe(2);
  });

  it("the company e-mail: the people source's role mailbox (nile), then a lister's (orascom: info@ before sales@, delta), verified «موثّق» / «غير موثّق»; nothing found or another domain's: «غير متوفر»; never a person's address", async () => {
    const r = await g1();
    const s = await companySheet(r);
    expect(s.col("الإيميل العام للشركة")).toEqual(["info@orascom-em.com.eg", "info@nile-em.com.eg", "webmaster@delta-em.com.eg", "غير متوفر", "غير متوفر"]);
    expect(s.col("حالة توثيق الإيميل العام للشركة")).toEqual(["موثّق", "موثّق", "غير موثّق", "", ""]);
    // nile's mailbox came with the people source: no lister call for it; the other four companies were looked up once each
    const listerCalls = (await r.store.listCalls(r.missionId)).filter((c) => c.phase === "execution" && catalog.byId.get(c.endpoint_id)?.capability === "companies.emails.list");
    expect(listerCalls.length).toBe(4);
  });

  it("nothing moves in the money: 5 companies + 10 people delivered, the charge is ceil(delivered x unit) inside the reserve, the spend inside the job budget; no provider, endpoint id or dollar amount in the customer's view", async () => {
    const r = await g1();
    assertReplayInvariants(r, { expectDelivered: 15, expectStatus: "completed" });
    expect(Number(r.mission.charged_points)).toBeLessThanOrEqual(Number(r.mission.reserved_points));
    expect(Number(r.mission.execution_treg_usd)).toBeLessThanOrEqual(executionBudgetUsd(Number(r.mission.reserved_points)) + 1e-9);
    const view = JSON.stringify(r.planView);
    expect(view).toContain("الإيميل العام للشركة");
    expect(r.plannedPlan.contact_steps!.filter((x) => x.level === "company").map((x) => x.kind)).toEqual(["email", "phone"]);
  });
});
