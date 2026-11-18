import { describe, expect, it } from "vitest";
import { loadTregCatalog, isSellable } from "../src/lib/treg/catalog";
import { blockedEndpointReason } from "../src/lib/treg/blockList";
import { policyVerdict } from "../src/lib/treg/dataPolicy";
import { NOT_ADMIN } from "./helpers/agentHarness";
import { validateAndPricePlan, priceIncludesLinesAr, type PlanLookup } from "../src/lib/agentMission/plan";
import { createMemoryStore } from "../agent/src/memoryStore";
import { ItemStore } from "../agent/src/items/itemStore";
import { runContactEnrichment } from "../agent/src/engine/contacts";
import { buildMissionFiles } from "../agent/src/workbook";
import { createJobCallBudget } from "../src/lib/server/callBudget";
import { bindCompanySteps, withContractColumns } from "../src/lib/agentMission/taskContracts";
import { buildCompanySteps, companyPhoneSourcesOf, finderSourcesOf, mailboxListerSourcesOf, validatorSourcesOf, verifierSourcesOf, withContactColumns } from "../src/lib/agentMission/contactFinders";

/**
 * DT-20261118-03 F2-a (live, chat B): «١٠ شركات مقاولات في القاهرة بالإيميل والتليفون» delivered 10 of 10 with phones and NO e-mail column. Code added the company's e-mail step only under a people stage, and the plan check took a phone
 * column for the e-mail ask. Now a companies-only request that asks for an e-mail gets the company e-mail step and its two columns by code; with no way to find one, the plan says why or is refused.
 */
const catalog = loadTregCatalog();
const allowed = (id: string) => isSellable(id, catalog) && !blockedEndpointReason(id) && policyVerdict(id, NOT_ADMIN).allowed;
const lister = mailboxListerSourcesOf(catalog, allowed);
const aidsOf = (kind: "email" | "phone") => (kind === "email" ? { verifiers: verifierSourcesOf(catalog, allowed) } : { validators: validatorSourcesOf(catalog, allowed), company_phone: companyPhoneSourcesOf(catalog, allowed) });
const company = { key: "companies", title_ar: "شركات المقاولات", parent_key: null, deliver: true, endpoint_id: "tomba.companies.search.reveal", columns: [{ key: "name" }] };
const people = { key: "people", title_ar: "صناع القرار في كل شركة", parent_key: "companies", deliver: true, endpoint_id: "aviato.companies.employees", role_preference: { role: "manager" }, columns: [{ key: "name" }] };
const EMAIL_COLUMNS = [{ key: "company_email", title_ar: "الإيميل العام للشركة" }, { key: "company_email_status", title_ar: "حالة توثيق الإيميل العام للشركة", status_of: "company_email" }];

describe("DT-20261118-03 F2-a: the company e-mail of a companies-only request", () => {
  it("an e-mail ask gives ONE company e-mail step with its own columns (no phone step); no ask, no step; a companies and people plan is unchanged", () => {
    const steps = buildCompanySteps([company], lister, aidsOf, { email: true });
    expect(steps.map((s) => [s.kind, s.level, s.stage_key, s.own_columns])).toEqual([["email", "company", "companies", true]]);
    expect(buildCompanySteps([company], lister, aidsOf, { email: false })).toEqual([]);
    expect(buildCompanySteps([company, people], lister, aidsOf, { email: true }).map((s) => [s.kind, s.own_columns])).toEqual([["email", undefined], ["phone", undefined]]);
  });
  it("its two columns are added to a stage with no e-mail column, after the stage's own; a stage that has one is left as it is", () => {
    const steps = buildCompanySteps([company], lister, aidsOf, { email: true });
    expect(withContactColumns("companies", [{ key: "name", title_ar: "اسم الشركة" }], steps)).toEqual([{ key: "name", title_ar: "اسم الشركة" }, ...EMAIL_COLUMNS]);
    expect(withContactColumns("companies", [{ key: "name", title_ar: "اسم الشركة" }, { key: "email", title_ar: "الإيميل" }], steps)).toEqual([{ key: "name", title_ar: "اسم الشركة" }, { key: "email", title_ar: "الإيميل" }]);
  });
});

const REQUEST = "عايز ١٠ شركات مقاولات في القاهرة بالإيميل والتليفون";
const PAGE = JSON.stringify({ companies: [{ name: "Cairo Build", website_url: "cairobuild.com.eg", industry: "Construction", country: "EG", street_address: "مدينة نصر، القاهرة", phone_number: "+20 2 2222 3333" }] });
const calls = new Map([["call_0001", { id: "call_0001", endpointId: "tomba.companies.search.reveal", ok: true, costUsd: 0.000178, rows: 50, params: { query: "construction cairo" } }]]);
const lookup = (withListers: boolean): PlanLookup => ({
  call: (id) => calls.get(id) ?? null,
  evidenceText: () => PAGE,
  endpointAllowed: () => true, requestText: REQUEST,
  endpointsCalled: () => new Map(),
  isContactSource: (id) => /email/i.test(id),
  contactFinders: (kind) => finderSourcesOf(kind, catalog, allowed),
  contactAids: aidsOf,
  ...(withListers ? { mailboxListers: () => lister } : {}),
});
const stage = { key: "companies", title_ar: "شركات المقاولات في القاهرة", endpoint_id: "tomba.companies.search.reveal", expected_rows: 10, parent_key: null, deliver: true, measured_by: ["call_0001"],
  columns: [{ key: "name", title_ar: "اسم الشركة" }, { key: "activity", title_ar: "النشاط" }, { key: "website", title_ar: "الموقع" }, { key: "phone", title_ar: "التليفون", kind: "phone" }, { key: "address", title_ar: "العنوان" }],
  sample_rows: [{ id: "cairobuild.com.eg", name: "Cairo Build", activity: "Construction", website: "cairobuild.com.eg", phone: "+20 2 2222 3333", address: "مدينة نصر، القاهرة" }] };

describe("DT-20261118-03 F2-a: the plan of «١٠ شركات مقاولات في القاهرة بالإيميل والتليفون»", () => {
  it("a phone-only companies plan gets the company e-mail step by code, and the card says the price includes it", () => {
    const c = validateAndPricePlan({ summary_ar: "شركات مقاولات في القاهرة.", stages: [stage] }, lookup(true));
    expect(c.ok, JSON.stringify(c)).toBe(true);
    if (!c.ok) return;
    expect((c.plan.contact_steps ?? []).filter((s) => s.level === "company").map((s) => [s.kind, s.own_columns])).toEqual([["email", true]]);
    expect(priceIncludesLinesAr(c.plan)).toContain("السعر يشمل أيضًا البحث عن الإيميل العام للشركة لكل شركة؛ وما لا نجده نكتب مكانه «غير متوفر».");
  });
  it("with no way to find an e-mail the plan is refused until it says why (contacts_note_ar), and then the card shows that sentence", () => {
    const c = validateAndPricePlan({ summary_ar: "شركات مقاولات في القاهرة.", stages: [stage] }, lookup(false));
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.issues.join(" | ")).toContain("no stage of the plan gives one");
    const note = "لا يتوفر لدينا مصدر يعطي الإيميل العام لهذه الشركات، فالملف بالتليفون فقط.";
    const d = validateAndPricePlan({ summary_ar: "شركات مقاولات في القاهرة.", stages: [stage], contacts_note_ar: note }, lookup(false));
    expect(d.ok, JSON.stringify(d)).toBe(true);
    if (d.ok) expect(d.plan.notes_ar ?? []).toContain(note);
  });
  it("P1-A: when the company stage already has an e-mail column, skip company e-mail step and do not charge or show line", () => {
    const stageWithEmail = {
      ...stage,
      columns: [...stage.columns, { key: "work_email", title_ar: "الإيميل", kind: "work_email" as const }],
    };
    const c = validateAndPricePlan({ summary_ar: "شركات مقاولات في القاهرة.", stages: [stageWithEmail] }, lookup(true));
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect((c.plan.contact_steps ?? []).filter((s) => s.level === "company")).toEqual([]);
    // QA wave-1 FAIL #572: the control plan must succeed, so the price comparison always runs
    const cNoListers = validateAndPricePlan({ summary_ar: "شركات مقاولات في القاهرة.", stages: [stageWithEmail] }, lookup(false));
    expect(cNoListers.ok, JSON.stringify(cNoListers)).toBe(true);
    if (!cNoListers.ok) return;
    expect(c.plan.price.reservePoints).toBe(cNoListers.plan.price.reservePoints);
    expect(priceIncludesLinesAr(c.plan)).not.toContain("السعر يشمل أيضًا البحث عن الإيميل العام للشركة لكل شركة؛ وما لا نجده نكتب مكانه «غير متوفر».");
  });
});

// QA wave-1 FAIL #572: the delivered file is observed, not only the plan. The approved plan runs through the real contact engine (fake provider answers) and the real workbook builder.
describe("DT-20261118-03 F2-a: the company e-mail reaches the delivered file", () => {
  it("the engine writes the company's mailbox into the company row, and the delivered CSV has the e-mail column and that address", async () => {
    const c = validateAndPricePlan({ summary_ar: "شركات مقاولات في القاهرة.", stages: [stage] }, lookup(true));
    expect(c.ok, JSON.stringify(c)).toBe(true);
    if (!c.ok) return;
    // the columns the approved plan gets after the check, by the same production calls, in the same order, as the plan tool (agent/src/tools.ts:745-750)
    const plan = c.plan;
    for (const st of plan.stages) st.columns = withContactColumns(st.key, st.columns, plan.contact_steps);
    const contracted = withContractColumns(plan.stages);
    plan.stages.forEach((st, i) => { st.columns = contracted[i].columns as typeof st.columns; });
    plan.contact_steps = bindCompanySteps(plan.stages, plan.contact_steps ?? []);
    const MISSION = "msn_dt03_f2";
    const store = createMemoryStore();
    const items = await ItemStore.open(store, MISSION);
    await items.commit([{ t: "item", stage: "companies", id: "cairobuild.com.eg", state: "accepted", by: "rule", row: { ...stage.sample_rows[0] } }]);
    const budget = createJobCallBudget({ ceilingUsd: 1, spentUsd: 0 });
    const called: string[] = [];
    let n = 0;
    const gateway: any = {
      async tregCall(a: { endpoint_id: string; params: Record<string, unknown> }) {
        called.push(a.endpoint_id);
        const id = `call_${String(++n).padStart(4, "0")}`;
        await store.putFile(MISSION, `raw/${id}.json`, JSON.stringify({ data: { domain: "cairobuild.com.eg", emails: [{ email: "info@cairobuild.com.eg", type: "generic" }] } }), "application/json");
        budget.settle(0, 0.001);
        return { ok: true, call_id: id, http_status: 200, rows_in_page: 1, has_more: false, next_cursor: null };
      },
    };
    await runContactEnrichment({ items, store, plan, missionId: MISSION, gateway, addEvent: async () => {}, budget, deadlineMs: Date.now() + 60_000 } as any);
    const row = items.acceptedRows("companies").find((r) => r.id === "cairobuild.com.eg")!;
    const emailKey = plan.contact_steps!.find((x) => x.level === "company" && x.kind === "email")!.column_key;
    expect(row[emailKey]).toBe("info@cairobuild.com.eg");
    expect(called.length).toBeGreaterThan(0);
    const files = await buildMissionFiles(plan, { companies: items.acceptedRows("companies") }, undefined, undefined, { completeContract: false });
    const lines = files.csv.split(/\r?\n/);
    const header = lines.findIndex((l) => l.includes("الإيميل العام للشركة"));
    expect(header, files.csv.slice(0, 800)).toBeGreaterThanOrEqual(0);
    expect(lines.slice(header + 1).some((l) => l.includes("info@cairobuild.com.eg"))).toBe(true);
  });
});
