import ExcelJS from "exceljs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeDriver } from "../agent/src/fakeDriver";
import { createMemoryStore, newMission } from "../agent/src/memoryStore";
import { fundedEstimateNote } from "../agent/src/llmPlanner/planner";
import { runExecution, runPlanning, type RunnerDeps } from "../agent/src/runMission";
import { executeTregCall } from "../src/functions/shared/tregClient";
import { parseCatalog } from "../src/lib/treg/catalog";
import { setValidatedAdditionsForTest, validateCatalogAdditions } from "../src/lib/treg/blockList";
import { runSampleCall } from "../src/lib/modelPlanner/exploration";
import { NOT_ADMIN, USER_ID, fakeRecorder } from "./helpers/agentHarness";
import { approveMission } from "../src/lib/agentMission/lifecycle";
import { settlementCharge } from "../src/lib/agentMission/price";
import { fakeMoneyClient } from "./helpers/agentMoney";

const delivery = "synthetic.company.delivery";
const count = "synthetic.company.count";
const schema = "synthetic.company.schema";
const capability = "companies.firmographics";
const criteria = { country: ["EG"] };

function fixture() {
  const input = { name: "criteria", type: "object", required: true };
  const common = { provider: "synthetic", platform: "companies", category: "companies", capability, method: "POST", kind: "direct", scope: "read" };
  const paid = { usd: 0.001, unit: "record", type: "per_result" };
  const free = { usd: 0, unit: "call", type: "free" };
  const verdict = validateCatalogAdditions({ version: 1, entries: [
    { endpoint: { ...common, id: delivery, name: "Synthetic delivery", inputs: [input], pagination: ["offset", "limit"], cost: paid },
      policy: "public", contract: { endpoint_id: delivery, role: "delivery", dispatch: "funded", helpers: { count, schema },
        request: { filterKey: "criteria", filterBindings: { country: "string" }, pageSizeKey: "limit", positionKey: "offset", minPageSize: 1, maxPageSize: 10 },
        result: { rowsPath: "companies", identityKey: "domain", fields: ["domain", "name", "city"], morePath: "more", positionPath: "next" } } },
    { endpoint: { ...common, id: count, name: "Synthetic count", inputs: [input], cost: free },
      policy: "public", contract: { endpoint_id: count, role: "count", result: { countPath: "estimatedCount" } } },
    { endpoint: { ...common, id: schema, name: "Synthetic schema", method: "GET", inputs: [], cost: free },
      policy: "public", contract: { endpoint_id: schema, role: "schema", result: { schemaPath: "columns", schemaFilterKeysPath: "aliases" } } },
  ] });
  expect(verdict.valid).toBe(true);
  return verdict;
}

async function replay(options: { rows?: number; balance?: number; unavailable?: boolean; rollback?: boolean } = {}) {
  const entries = fixture();
  setValidatedAdditionsForTest(options.rollback ? null : entries);
  const catalog = parseCatalog({ endpoints: entries.endpoints }, [], { endpoints: entries.contracts });
  const rows = options.rows ?? 3;
  const mission = newMission({ id: "msn_synthetic_funded", user_id: USER_ID, status: "planning", request_text: `اجمع ${rows} شركة في مصر` });
  const store = createMemoryStore([mission]);
  const money = fakeMoneyClient({ balance: options.balance });
  const ledgerClient = {
    ...money.client,
    from: (table: string) => ({
      select: () => ({
        eq: (column: string, userId: string) => {
          if (table !== "credit_ledger" || column !== "user_id" || userId !== USER_ID || options.unavailable) {
            return Promise.resolve({ error: { message: "unavailable" } });
          }
          return Promise.resolve({ data: money.ledger });
        },
      }),
    }),
  };
  const costs = fakeRecorder();
  const driver = createFakeDriver([]);
  const fetch = vi.fn(async (url: string, _init?: RequestInit) => {
    const id = url.split("/").pop();
    const data = id === count ? { estimatedCount: 11 }
      : id === schema ? { columns: [{ key: "country", type: "string", searchable: true, label: "DO_NOT_FORWARD" }] }
      : { companies: Array.from({ length: Math.min(rows, 10) }, (_, i) => ({ domain: `company-${i}.example`, name: `Company ${i}`, city: "First city", personal: "DO_NOT_STORE" })), more: true, next: 10 };
    return new Response(JSON.stringify(data), { headers: { "x-treg-cost-micro": id === delivery ? String(Math.min(rows, 10) * 1_000) : "0" } });
  });
  vi.stubGlobal("fetch", fetch);
  const modelText: unknown[] = [];
  const deps: RunnerDeps = {
    store, catalog, driver, token: "fake", call: executeTregCall, resolveAccess: async () => NOT_ADMIN,
    client: ledgerClient,
    recorder: costs.recorder, commit: costs.commit, models: { planning: "fake-model", execution: "fake-model" },
    plannerModel: async ({ tool, system, user }) => {
      modelText.push(system, user);
      const input = tool.name === "request_plan" ? {
        decision: "plan", understanding_ar: "جمع الشركات المطلوبة", steps: [{
          key: "companies", title_ar: "الشركات", platform: "companies", capability, deliver: true, count: { total: rows },
        }],
      } : tool.name === "tool_choice" ? { options: [{ endpoint_id: delivery, params: { criteria } }] }
        : { fields: { id: ["domain"] }, extra: [{ key: "city", title_ar: "المدينة", path: ["city"] }] };
      return { input, costUsd: 0 };
    },
  };
  await runPlanning(deps, mission);
  return { mission: store.missions.get(mission.id), store, fetch, modelText, deps, money };
}

afterEach(() => {
  vi.unstubAllGlobals();
  setValidatedAdditionsForTest(null);
});

describe("production planning entry point", () => {
  it.each([
    ["zero balance", { balance: 0 }],
    ["whole paged schedule above the effective cap", { rows: 450 }],
    ["wallet read failed", { unavailable: true }],
    ["rollback", { rollback: true }],
  ] as const)("makes zero sends when %s", async (_scenario, options) => {
    const result = await replay(options);
    expect(result.fetch).not.toHaveBeenCalled();
    expect(result.mission?.status).not.toBe("plan_ready");
    expect(await result.store.listFiles("msn_synthetic_funded", "state/funded-plan")).toEqual([]);
  });

  it("publishes a matching private recipe, identical count and search filters and one Arabic estimate", async () => {
    const { mission, store, fetch, modelText } = await replay();
    expect(mission?.status).toBe("plan_ready");
    expect(mission?.plan?.stages[0]?.engine?.funded_recipe_version).toBe(1);
    expect(mission?.plan?.notes_ar).toContain(fundedEstimateNote(11));
    expect(await store.listFiles(mission!.id, "state/funded-plan")).toHaveLength(1);
    const sends = fetch.mock.calls.map(([url, init]) => ({
      endpoint: url.split("/").pop(), params: init?.body ? JSON.parse(String(init.body)) : {},
      cap: new Headers(init?.headers).get("X-Treg-Route-Max-Cost"),
    }));
    expect(sends).toEqual([
      { endpoint: schema, params: {}, cap: "0" },
      { endpoint: count, params: { criteria }, cap: "0" },
      { endpoint: delivery, params: { criteria, limit: 3, offset: 0 }, cap: "0.003" },
    ]);
    expect(JSON.stringify(modelText)).not.toContain("DO_NOT_FORWARD");
    expect(JSON.stringify([...store.files.values()])).not.toContain("DO_NOT_STORE");
    expect(store.calls.map(({ endpoint_id }) => endpoint_id)).toEqual([delivery]);
  });
});

it.each([
  ["partial with duplicate domains", false, 1],
  ["no deliverables", true, 0],
] as const)("settles %s from the published file", async (_scenario, empty, delivered) => {
  const { mission, store, deps, fetch, money } = await replay({ rows: 12 });
  expect(mission?.status).toBe("plan_ready");
  const approval = await approveMission(money.client, { id: mission!.id, user_id: USER_ID, plan: mission!.plan! });
  if (!approval.ok) throw new Error(approval.messageAr);
  await store.updateMission(mission!.id, {
    status: "approved", job_id: approval.jobId, quote_id: approval.quoteId,
    reserved_points: approval.reservePoints, unit_price_points: approval.unitPricePoints,
  });
  money.bindDeliveryMissions({
    get: (id) => store.missions.get(id),
    park: (id, due) => Object.assign(store.missions.get(id)!, { status: "approved", worker_id: null, lease_until: due }),
  });
  const claimed = await store.claimMission("worker-fixture", 120);
  if (!claimed) throw new Error("worker did not claim");
  fetch.mockReset();
  fetch.mockImplementation(async (_url, init) => {
    const params = JSON.parse(String(init?.body));
    const first = params.offset === 0;
    const companies = empty ? [] : [{ domain: "same.example", name: first ? "First name" : "Changed name", city: first ? "First city" : "Changed city" }];
    return new Response(JSON.stringify({ companies, more: first && !empty, next: first ? 10 : 9 }),
      { headers: { "x-treg-cost-micro": "1000" } });
  });
  if (!empty) {
    const append = store.addCall;
    store.addCall = async (row) => {
      if (row.phase === "execution" && fetch.mock.calls.length === 2) throw new Error("worker stopped before call row");
      await append(row);
    };
    await expect(runExecution(deps, claimed)).rejects.toThrow("worker stopped");
    store.addCall = append;
  }
  await runExecution(deps, claimed);
  const done = await store.getMission(claimed.id);
  const charge = settlementCharge({
    deliveredUnits: delivered, unitPricePoints: approval.unitPricePoints, reservedPoints: approval.reservePoints,
  });
  expect(done?.delivered_units ?? 0).toBe(delivered);
  expect(done?.charged_points).toBe(charge.chargedPoints);
  expect(done?.execution_treg_usd).toBe(empty ? 0.001 : 0.002);
  expect(money.balance()).toBe(100_000 - charge.chargedPoints);
  expect(fetch).toHaveBeenCalledTimes(empty ? 1 : 2);
  if (delivered) {
    expect(store.published).toHaveLength(1);
    const csv = await store.getFile(claimed.id, "result/result.csv");
    expect(csv?.split(/\r?\n/).filter((line) => line.includes("same.example"))).toHaveLength(1);
    expect(csv).toContain("First city");
    expect(csv).not.toContain("Changed city");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await store.getFileBytes(claimed.id, "result/result.xlsx") as unknown as ArrayBuffer);
    const matchedRows: number[] = [];
    workbook.worksheets[1].eachRow((row) => {
      if (JSON.stringify(row.values).includes("same.example")) matchedRows.push(row.number);
    });
    expect(matchedRows).toHaveLength(1);
  } else {
    expect(store.published).toHaveLength(0);
  }
});

it.each([[1, "شركة واحدة"], [2, "شركتان"], [3, "٣ شركات"], [11, "١١ شركة"]])("renders the frozen estimate for %s", (number, noun) => {
  expect(fundedEstimateNote(number)).toBe(`العدد التقريبي المتاح قبل الفحص هو ${noun}، وقد يقل العدد النهائي بعد التحقق، وتدفع فقط مقابل ما يُسلَّم لك فعلًا.`);
});
it.each([0, -1, "3", 1.5, null])("omits an invalid or empty count %s", (value) => {
  expect(fundedEstimateNote(value)).toBeNull();
});

it("refuses tagged IDs before the legacy sampler uses its transport", async () => {
  const entries = fixture();
  setValidatedAdditionsForTest(entries);
  const catalog = parseCatalog({ endpoints: entries.endpoints }, [], { endpoints: entries.contracts });
  const transport = vi.fn(async () => { throw new Error("unexpected provider transport"); });
  const outcome = await runSampleCall({ id: delivery, params: [] },
    { customerText: "شركات", access: NOT_ADMIN, catalog, samples: new Map() },
    { call: transport } as unknown as Parameters<typeof runSampleCall>[2]);
  expect(outcome).toMatchObject({ ok: false, kind: "refused", costUsd: 0 });
  expect(transport).not.toHaveBeenCalled();
});
