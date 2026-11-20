import { afterEach, expect, it, vi } from "vitest";
import { createGateway } from "../agent/src/gateway";
import { createMemoryStore, newMission } from "../agent/src/memoryStore";
import { executeTregCall } from "../src/functions/shared/tregClient";
import { createJobCallBudget } from "../src/lib/server/callBudget";
import { loadTregCatalog, loadTregPriceBaseline } from "../src/lib/treg/catalog";
import { fakeRecorder, NOT_ADMIN, USER_ID } from "./helpers/agentHarness";

const endpointId = "blitzapi.companies.search";
const input = { max_results: 50, company: { name: { include: ["example"] } } };

afterEach(() => vi.unstubAllGlobals());

it.each([
  { name: "old catalog, affordable", afterSync: false, providerUsd: 0.02475, dailyCapUsd: 0.055, expectedHeader: ["0.0375"], spentUsd: 0.02475, expectedResult: { ok: true } },
  { name: "synced catalog, affordable", afterSync: true, providerUsd: 0.05, dailyCapUsd: 0.055, expectedHeader: ["0.05"], spentUsd: 0.05, expectedResult: { ok: true } },
  { name: "synced catalog, over the daily cap", afterSync: true, providerUsd: 0.05, dailyCapUsd: 0.04, expectedHeader: [], spentUsd: 0, expectedResult: { ok: false, refused: "daily_cap" } },
])("admits a 50-row page only when it fits the daily cap ($name)", async ({ afterSync, providerUsd, dailyCapUsd, expectedHeader, spentUsd, expectedResult }) => {
  const store = createMemoryStore();
  const mission = newMission({ id: "msn_price12", user_id: USER_ID, request_text: "test", status: "executing", job_id: "job_price12" });
  store.missions.set(mission.id, mission);
  const budget = createJobCallBudget({ ceilingUsd: 0.15, spentUsd: 0 });
  const { recorder, commit } = fakeRecorder({ dailyCapUsd });
  const wire: string[] = [];
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    const header = new Headers(init.headers).get("X-Treg-Route-Max-Cost")!;
    wire.push(header);
    // The fake bills a rate independent of the catalog used by the gateway.
    if (Number(header) < providerUsd) return Response.json({ error: "route_max_cost" }, { status: 402 });
    return Response.json({ results: Array.from({ length: 50 }, (_, index) => ({ name: `company ${index}` })) }, {
      headers: { "x-treg-cost-micro": String(Math.round(providerUsd * 1e6)) },
    });
  });
  const gateway = createGateway({
    store, client: {}, missionId: mission.id, userId: USER_ID, jobId: mission.job_id, phase: "execution",
    access: NOT_ADMIN, catalog: afterSync ? loadTregCatalog() : loadTregPriceBaseline(), budget, recorder, commit,
    call: (options) => executeTregCall({ ...options, token: "fake-token", baseUrl: "https://provider.example" }),
    defaultPurpose: "test", counter: { seq: 0 },
  });
  const result = await gateway.tregCall({ endpoint_id: endpointId, params: input });
  expect(wire).toEqual(expectedHeader);
  expect(budget.spentUsd()).toBe(spentUsd);
  expect(result).toMatchObject(expectedResult);
});
