import ExcelJS from "exceljs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runEngine } from "../agent/src/engine/run";
import { RAW_PATH, type Gateway } from "../agent/src/gateway";
import { ingestRows } from "../agent/src/items/ingest";
import { ItemStore } from "../agent/src/items/itemStore";
import { createMemoryStore, newMission } from "../agent/src/memoryStore";
import { advanceMissionDelivery } from "../agent/src/missionSettlement";
import { runExecution, type RunnerDeps } from "../agent/src/runMission";
import { createSourceGateway, stageScopeOf } from "../agent/src/engine/sourceGateway";
import { buildMissionFiles } from "../agent/src/workbook";
import { COMPANY_EVIDENCE_KEY, COMPANY_UNCERTAIN_KEY, companyEvidenceOf, companyRelationship, withCompanyQuality } from "../src/lib/agentMission/companyQuality";
import type { PricedPlan, PricedStage } from "../src/lib/agentMission/plan";
import { createJobCallBudget } from "../src/lib/server/callBudget";
import { fakeMoneyClient, quoteJobId } from "./helpers/agentMoney";

const USER = "dedupe-user";
const MISSION = "msn_fx_m3_dedupe";
const QUOTE = "quote_fx_m3_dedupe";
const JOB = quoteJobId(QUOTE);
const START = Date.parse("2026-11-22T06:00:00Z");
const HASH = "b".repeat(64);
const ident = async (_code: string, inputs: Record<string, unknown>) => ({ ok: true as const, resultJson: JSON.stringify(Object.values(inputs)[0] ?? []), logs: [] });

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(START); });
afterEach(() => vi.useRealTimers());

function makePlan(perCompany = 1, plannedCompanies = 2): PricedPlan {
  const companies: PricedStage = {
    key: "companies", title_ar: "الشركات", endpoint_id: "fixture.companies.search", expected_rows: plannedCompanies, planned_rows: plannedCompanies,
    parent_key: null, deliver: true,
    columns: [
      { key: "name", title_ar: "الاسم" },
      { key: "website", title_ar: "الموقع الإلكتروني" },
      { key: "city", title_ar: "المدينة" },
      { key: "street_address", title_ar: "العنوان" },
      { key: "linkedin_url", title_ar: "صفحة الشركة على لينكدإن" },
    ],
    sample_rows: [], measured_by: [], measured_from_calls: [], measured_cost_per_row_usd: 0.001,
    engine: { endpoint_id: "fixture.companies.search", params: { q: "retail" }, cursor_param: "cursor", map_code: "return inputs.page", map_file_id: "page", parent_binding: null },
  };
  const contacts: PricedStage = {
    key: "contacts", title_ar: "جهات الاتصال", endpoint_id: "fixture.branch.contacts", expected_rows: 2 * perCompany, planned_rows: 2 * perCompany,
    parent_key: "companies", per_parent_rows: perCompany, deliver: true,
    columns: [{ key: "contact_email", title_ar: "الإيميل", kind: "work_email" }, { key: "branch_code", title_ar: "الفرع" }],
    sample_rows: [], measured_by: [], measured_from_calls: [], measured_cost_per_row_usd: 0.001,
    engine: { endpoint_id: "fixture.branch.contacts", params: {}, cursor_param: null, map_code: "return inputs.page", map_file_id: "page", parent_binding: { param: "branch_id", from: "branch_id" } },
  };
  return {
    summary_ar: "شركات وفروعها",
    stages: [companies, contacts],
    price: { deliveredRows: 2 + 2 * perCompany, unitPricePoints: 100, reservePoints: 460, maxChargePoints: 400, totalCostUsd: 0.004, costPerFinalRowUsd: 0.001, overCap: false },
  } as unknown as PricedPlan;
}

describe("M6 branch-first company deduplication and child binding", () => {
  it.each(["distinct_raw_ids", "shared_raw_id"] as const)(
    "keeps two distinct outlets, excludes a true duplicate, binds children per branch across restart, and settles once (%s)",
    async (mode) => {
      const plan = makePlan(1);
      const store = createMemoryStore();
      const money = fakeMoneyClient({ balance: 2_000 });
      await money.client.rpc("create_quote_atomic", {
        p_quote_id: QUOTE, p_user_id: USER, p_quote_hash: HASH, p_total_points: plan.price.reservePoints,
        p_items: [{ endpointId: "agent-mission", missionId: MISSION, unitPricePoints: plan.price.unitPricePoints, targetVolumeMin: 1, targetVolumeMax: plan.price.deliveredRows }],
        p_output_formats: ["xlsx", "csv"], p_expires_at: new Date(START + 3_600_000).toISOString(),
      });
      await money.client.rpc("accept_quote_atomic", { p_quote_id: QUOTE, p_user_id: USER, p_expected_quote_hash: HASH });
      await money.client.rpc("claim_job_chunk", { p_job_id: JOB, p_expected_step: 0, p_lease_seconds: 21_600 });
      store.missions.set(MISSION, newMission({
        id: MISSION, user_id: USER, request_text: "عايز شركتين وفروعهما", plan, status: "executing",
        worker_id: "first", job_id: JOB, quote_id: QUOTE,
        lease_until: new Date(START + 120_000).toISOString(),
        reserved_points: plan.price.reservePoints, unit_price_points: plan.price.unitPricePoints,
      }));
      money.bindDeliveryMissions({
        get: (id) => store.missions.get(id),
        park: (id, due) => Object.assign(store.missions.get(id)!, { status: "approved", worker_id: null, lease_until: due }),
      });

      const sharedCompany = {
        name: "Nile Retail", website: "https://nileretail.example", registration_number: "CR-7788",
        country: "EG", city: "Cairo", linkedin_url: "https://linkedin.com/company/nile-retail",
      };
      const rawParentA = mode === "shared_raw_id" ? "co_shared" : "co_a";
      const rawParentB = mode === "shared_raw_id" ? "co_shared" : "co_b";
      const page1 = [
        { ...sharedCompany, id: rawParentA, branch_id: "br_nasr", street_address: "10 Abbas El Akkad St" },
        { ...sharedCompany, id: rawParentB, branch_id: "br_maadi", street_address: "25 Road 9" },
      ];
      const page2Duplicate = [
        { ...sharedCompany, id: mode === "shared_raw_id" ? "co_shared" : "co_a_dup", branch_id: "br_nasr", street_address: "10 Abbas El Akkad St" },
      ];

      let companyPageCalls = 0;
      const childRequests: Array<Record<string, unknown>> = [];
      let callSeq = 0;
      const gateway = {
        async tregCall(input: { endpoint_id?: unknown; params?: Record<string, unknown> }) {
          const call_id = `call_${String(++callSeq).padStart(4, "0")}`;
          if (input.endpoint_id === "fixture.companies.search") {
            companyPageCalls += 1;
            const rows = companyPageCalls === 1 ? page1 : page2Duplicate;
            await store.putFile(MISSION, RAW_PATH(call_id), JSON.stringify(rows), "application/json");
            return { ok: true as const, call_id, http_status: 200, rows_in_page: rows.length, has_more: companyPageCalls === 1, next_cursor: companyPageCalls === 1 ? "p2" : null, shape: null, first_rows: [], warnings: [], saved: "" };
          }
          childRequests.push({ ...(input.params ?? {}) });
          const branchId = String(input.params?.branch_id ?? "");
          const rows = [{ id: `ct_${branchId}`, contact_email: `${branchId}@nileretail.example`, branch_code: branchId }];
          await store.putFile(MISSION, RAW_PATH(call_id), JSON.stringify(rows), "application/json");
          return { ok: true as const, call_id, http_status: 200, rows_in_page: rows.length, has_more: false, next_cursor: null, shape: null, first_rows: [], warnings: [], saved: "" };
        },
      } as unknown as Gateway;

      const items1 = await ItemStore.open(store, MISSION);
      // Ingest page 1, then page 2 duplicate, then restart via ItemStore.open.
      await ingestRows({ items: items1, plan, addEvent: async () => undefined }, plan.stages[0], page1);
      await ingestRows({ items: items1, plan, addEvent: async () => undefined }, plan.stages[0], page2Duplicate);

      const itemsRestarted = await ItemStore.open(store, MISSION);
      const companiesAfterRestart = itemsRestarted.acceptedRows("companies");
      expect(companiesAfterRestart).toHaveLength(2);
      expect(new Set(companiesAfterRestart.map((r) => r.id)).size).toBe(2);
      expect(companiesAfterRestart.map((r) => r.branch_id)).toEqual(["br_nasr", "br_maadi"]);

      const budget = createJobCallBudget({ ceilingUsd: 5, spentUsd: 0 });
      const sources = createSourceGateway({ gateway, scope: stageScopeOf(plan), budget });
      const engineResult = await runEngine({
        items: itemsRestarted, store, plan, missionId: MISSION, gateway, sandbox: ident,
        addEvent: async () => undefined, deadlineMs: Date.now() + 60_000, sleep: async () => undefined, sources,
      });
      expect(engineResult).toMatchObject({ aborted: null, stops: { companies: "target_reached", contacts: "target_reached" } });
      expect(childRequests.map((p) => p.branch_id).sort()).toEqual(["br_maadi", "br_nasr"]);
      const savedContacts = itemsRestarted.acceptedRows("contacts");
      expect(savedContacts).toHaveLength(2);
      for (const co of companiesAfterRestart) {
        const ownChildren = savedContacts.filter((ct) => ct.parent_id === co.id);
        expect(ownChildren).toHaveLength(1);
        expect(ownChildren[0].branch_code).toBe(co.branch_id);
      }

      // Seal workbook and verify duplicate settlement debits once.
      const deps = {
        store, client: money.client, ownerId: "first",
        catalog: { endpoints: [], byId: new Map() },
        resolveAccess: async () => ({ sensitive: true, blockedCategories: [] }),
        recorder: { reserve: async () => ({ allowed: true, costId: "c1" }) },
        commit: vi.fn(), call: vi.fn(), sandbox: ident,
        driver: { run: vi.fn() }, models: { planning: "fixture", execution: "fixture" },
      } as unknown as RunnerDeps;
      await runExecution(deps, { ...store.missions.get(MISSION)! });
      expect(store.missions.get(MISSION)).toMatchObject({ status: "completed", delivered_units: 4, charged_points: 400 });
      expect(money.balance()).toBe(1_600);
      expect(money.ledger.filter((e) => e.job_id === JOB && e.type === "charge")).toHaveLength(1);
      expect(money.ledger.filter((e) => e.job_id === JOB && e.type === "release")).toHaveLength(1);
      const xlsx = await store.getFileBytes(MISSION, "result/result.xlsx");
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(xlsx as never);
      expect(wb.worksheets.slice(1).map((s) => s.rowCount - 1)).toEqual([2, 2]);
    },
  );

  it("excludes identity conflicts, separates homonyms with conflicting registration, and keeps uncertain branches annotated", async () => {
    const plan = makePlan(1, 10);
    const items = await ItemStore.open(createMemoryStore(), "msn_conflicts");
    const homonym1 = { id: "h1", name: "Delta Logistics", website: "https://delta.example", registration_number: "CR-111", country: "EG", city: "Cairo" };
    const homonym2 = { id: "h2", name: "Delta Logistics", website: "https://delta.example", registration_number: "CR-222", country: "EG", city: "Cairo" };
    expect(companyRelationship(companyEvidenceOf(homonym1, plan.stages[0]), companyEvidenceOf(homonym2, plan.stages[0]))).toBe("different");

    const conflicting = {
      id: "conflict_1", name: "Omega Foods", website: "https://omegafoods.example",
      description: "Alpha Beverages is a leading drinks producer",
      linkedin_url: "https://linkedin.com/company/alpha-beverages",
    };
    const branchUnknownA = { id: "u1", name: "Nile Group", website: "https://nilegroup.example", city: "Cairo" };
    const branchUnknownB = { id: "u2", name: "Nile Group", website: "https://nilegroup.example", city: "Alexandria" };

    const res = await ingestRows({ items, plan, addEvent: async () => undefined }, plan.stages[0], [homonym1, homonym2, conflicting, branchUnknownA, branchUnknownB]);
    expect(res.newlyAccepted).toBe(4);
    const rows = items.acceptedRows("companies");
    expect(rows.some((r) => r.id === "conflict_1")).toBe(false);
    expect(rows.find((r) => r.id === "u2")?.[COMPANY_UNCERTAIN_KEY]).toBe("yes");
    expect(rows.every((r) => Boolean(r[COMPANY_EVIDENCE_KEY]))).toBe(true);

    const quality = withCompanyQuality(plan, { companies: rows });
    expect(quality.reports[0]?.possibleDuplicates).toContain("u2");
  });

  it("never assigns children to one branch by order when only a shared parent identity is available", async () => {
    const store = createMemoryStore();
    const items = await ItemStore.open(store, "msn_shared_parent");
    const plan: PricedPlan = {
      summary_ar: "x",
      stages: [
        {
          key: "companies", title_ar: "الشركات", expected_rows: 2, planned_rows: 2, parent_key: null, deliver: true,
          columns: [{ key: "name", title_ar: "الاسم" }, { key: "website", title_ar: "الموقع" }],
          sample_rows: [], measured_by: [], measured_from_calls: [], measured_cost_per_row_usd: 0.001,
          engine: { endpoint_id: "fixture.companies.search", params: { q: "x" }, cursor_param: null, map_code: "return inputs.page", map_file_id: "page", parent_binding: null },
        },
        {
          key: "contacts", title_ar: "الإيميلات", expected_rows: 2, planned_rows: 2, parent_key: "companies", per_parent_rows: 1, deliver: true,
          columns: [{ key: "email", title_ar: "الإيميل", kind: "work_email" }],
          sample_rows: [], measured_by: [], measured_from_calls: [], measured_cost_per_row_usd: 0.001,
          engine: { endpoint_id: "fixture.company.contacts", params: {}, cursor_param: null, map_code: "return inputs.page", map_file_id: "page", parent_binding: { param: "domain", from: "website" } },
        },
      ],
      price: { deliveredRows: 4, unitPricePoints: 100, reservePoints: 460, maxChargePoints: 400, totalCostUsd: 0.004, costPerFinalRowUsd: 0.001, overCap: false },
    } as unknown as PricedPlan;
    await ingestRows({ items, plan, addEvent: async () => undefined }, plan.stages[0], [
      { id: "p_a", name: "Shared Co", website: "https://shared.example", branch_id: "b1", city: "Cairo" },
      { id: "p_b", name: "Shared Co", website: "https://shared.example", branch_id: "b2", city: "Giza" },
    ]);
    const calls: unknown[] = [];
    const gateway = {
      async tregCall(input: { endpoint_id?: unknown; params?: unknown }) {
        calls.push(input);
        return { ok: true as const, call_id: "c_unused", http_status: 200, rows_in_page: 0, has_more: false, next_cursor: null, shape: null, first_rows: [], warnings: [], saved: "" };
      },
    } as unknown as Gateway;
    const sources = createSourceGateway({ gateway, scope: stageScopeOf(plan), budget: createJobCallBudget({ ceilingUsd: 5, spentUsd: 0 }) });
    await runEngine({
      items, store, plan, missionId: "msn_shared_parent", gateway, sandbox: ident,
      addEvent: async () => undefined, deadlineMs: Date.now() + 60_000, sleep: async () => undefined, sources,
    });
    expect(calls).toHaveLength(0);
    expect(items.acceptedRows("contacts")).toHaveLength(0);
    const built = await buildMissionFiles(plan, { companies: items.acceptedRows("companies"), contacts: [] });
    expect(built.xlsx.byteLength).toBeGreaterThan(0);
  });
});
