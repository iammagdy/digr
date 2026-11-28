import { afterEach, describe, expect, it, vi } from "vitest";
import { createGateway, readFundedExposure, type FundedSchedule } from "../agent/src/gateway";
import { createMemoryStore, newMission } from "../agent/src/memoryStore";

import { bindFundedTregTransport, executeControlProbe, executeTregCall } from "../src/functions/shared/tregClient";
import { setValidatedAdditionsForTest, validateCatalogAdditions } from "../src/lib/treg/blockList";
import { loadTregCatalog, parseCatalog } from "../src/lib/treg/catalog";
import { createJobCallBudget } from "../src/lib/server/callBudget";
import { NOT_ADMIN, POSTS_ENDPOINT, fakeRecorder } from "./helpers/agentHarness";

import { createFakeDriver } from "../agent/src/fakeDriver";
import { runPlanning } from "../agent/src/runMission";

const missionId = "synthetic-mission";
const folder = "funded-journal/planning";
const slot = {
  version: 1,
  phase: "planning",
  ordinal: 1,
  requestDigest: "a".repeat(32),
  grantDigest: "b".repeat(32),
  callId: "call_0040",
  providerCostId: 41,
  reservedMicros: 5_000,
};

describe("funded journal recovery", () => {
  it.each([
    ["proven empty", undefined, 0, true, true],
    ["claimed with no terminal record", null, 5_000, false, true],
    ["valid terminal charge with missing call row", 2_000, 2_000, true, true],
    ["charge above the reservation", 6_000, 5_000, false, false],
  ] as const)("%s", async (_scenario, chargedMicros, outstandingMicros, taggedAllowed, proven) => {
    const store = createMemoryStore();
    if (chargedMicros !== undefined) {
      await store.putNewStrict(missionId, `${folder}/000001.claim.json`, JSON.stringify(slot), "application/json");
    }
    if (typeof chargedMicros === "number") {
      await store.putNewStrict(missionId, `${folder}/000001.receipt.json`, JSON.stringify({
        ...slot, chargedMicros, outcome: "failed", projection: null,
      }), "application/json");
    }
    const result = await readFundedExposure(store, missionId, "planning", []);
    expect(result).toMatchObject({
      additionalMicros: outstandingMicros,
      taggedAllowed,
      proven,
      lastSequence: chargedMicros === undefined ? 0 : 40,
    });
  });

  it("treats an unreadable journal as unproven without changing the other phase", async () => {
    const store = createMemoryStore();
    const list = store.listFiles;
    store.listFiles = async (id, path) => {
      if (path === folder) throw new Error("private storage unavailable");
      return list(id, path);
    };
    expect(await readFundedExposure(store, missionId, "planning", [])).toMatchObject({ proven: false, taggedAllowed: false });
    expect(await readFundedExposure(store, missionId, "execution", [])).toMatchObject({ proven: true, taggedAllowed: true, additionalMicros: 0 });
  });
});

const endpointId = "synthetic.company.search";
const synthetic = {
  id: endpointId, provider: "synthetic", platform: "companies", category: "companies", capability: "companies.search",
  name: "Synthetic company search", method: "POST", kind: "direct", scope: "read",
  inputs: [{ name: "criteria", type: "object", required: true }],
  pagination: ["offset", "limit"],
  cost: { usd: 0.001, unit: "record", type: "per_record" },
};
const contract = {
  endpoint_id: endpointId, role: "delivery", dispatch: "funded",
  request: { pageSizeKey: "limit", positionKey: "offset", minPageSize: 1, maxPageSize: 10 },
  result: { rowsPath: "companies", identityKey: "website", fields: ["website", "name"], morePath: "more", positionPath: "next" },
};
const schedule: FundedSchedule = {
  endpointId, params: { criteria: { name: "Acme" } }, pageSize: 5, maxPages: 2, maxPerCallMicros: 5_000, maxTotalMicros: 10_000,
};
const params = { ...schedule.params, limit: 5, offset: 0 };

function activateFixture() {
  const validated = validateCatalogAdditions({ version: 1, entries: [{ endpoint: synthetic, contract, policy: "public" }] });
  expect(validated.valid).toBe(true);
  setValidatedAdditionsForTest(validated);
  const untagged = loadTregCatalog().byId.get(POSTS_ENDPOINT)!;
  return parseCatalog({ endpoints: [synthetic, untagged] }, [], [contract]);
}

afterEach(() => {
  vi.unstubAllGlobals();
  setValidatedAdditionsForTest(null);
});

it.each(["same", "different"])("requires one immutable claim when concurrent workers submit %s requests", async (variant) => {
  const catalog = activateFixture();
  const store = createMemoryStore();
  const costs = fakeRecorder();
  const fetch = vi.fn(async () => new Response(JSON.stringify({
    companies: [{ website: "ACME.example", name: "Acme", personal_email: "private@example.test" }],
    more: true, next: 5,
  }), { headers: { "x-treg-cost-micro": "1000" } }));
  vi.stubGlobal("fetch", fetch);
  const gateway = () => createGateway({
    catalog, store, missionId, userId: "synthetic-user", jobId: null, client: {},
    phase: "planning", access: NOT_ADMIN, budget: createJobCallBudget({ ceilingUsd: 0.01, spentUsd: 0 }),
    recorder: costs.recorder, commit: costs.commit, call: executeTregCall, defaultPurpose: "", counter: { seq: 0 }, token: "fake",
  });
  const a = gateway();
  const b = gateway();
  const other = variant === "same" ? schedule : { ...schedule, params: { criteria: { name: "Other" } } };
  const otherParams = { ...params, ...other.params };
  const [first, second] = await Promise.all([
    a.fundedCaller(schedule)({ endpoint_id: endpointId, params }),
    b.fundedCaller(other)({ endpoint_id: endpointId, params: otherParams }),
  ]);
  expect([first, second].some((result) => result.ok)).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(JSON.stringify([...store.files.values()])).not.toContain("private@example.test");
  const resumed = await gateway().fundedCaller(first.ok ? schedule : other)({ endpoint_id: endpointId, params: first.ok ? params : otherParams });
  expect(resumed).toMatchObject({ ok: true, first_rows: [{ website: "acme.example", name: "Acme" }] });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("does not send after a strict claim with an uncertain result", async () => {
  const catalog = activateFixture();
  const store = createMemoryStore();
  const original = store.putNewStrict;
  store.putNewStrict = async (id, path, body, type) => {
    const result = await original(id, path, body, type);
    if (path.endsWith(".claim.json")) throw new Error("the reply was lost");
    return result;
  };
  const costs = fakeRecorder();
  const fetch = vi.fn(async () => new Response("{}"));
  vi.stubGlobal("fetch", fetch);
  const gateway = createGateway({
    catalog, store, missionId, userId: "synthetic-user", jobId: null, client: {},
    phase: "planning", access: NOT_ADMIN, budget: createJobCallBudget({ ceilingUsd: 0.01, spentUsd: 0 }),
    recorder: costs.recorder, commit: costs.commit, call: executeTregCall, defaultPurpose: "", counter: { seq: 0 }, token: "fake",
  });
  expect(await gateway.fundedCaller(schedule)({ endpoint_id: endpointId, params })).toMatchObject({ ok: false, refused: "recording_unavailable" });
  expect(fetch).not.toHaveBeenCalled();
});

it("requires the bound wire request, consumes authorization once, and never exposes or retries a tagged error", async () => {
  activateFixture();
  const capture = vi.fn();
  const fetch = vi.fn(async () => new Response(JSON.stringify({ error: "private@example.test" }), {
    status: 429, headers: { "retry-after": "0", "x-treg-cost-micro": "0" },
  }));
  vi.stubGlobal("fetch", fetch);
  const options = {
    endpointId, params, userId: "synthetic-user", jobId: `agent_${missionId}`, method: "POST" as const,
    idempotencyKey: "synthetic-idempotency", token: "fake", rawCapture: capture,
  };
  const binding = { missionId, phase: "planning" as const, maxMicros: 5_000 };
  const wire = bindFundedTregTransport(options, binding);
  const wrong = bindFundedTregTransport(options, binding);
  wrong.params = { ...params, offset: 5 };
  for (const result of [
    await executeTregCall(options),
    await executeTregCall({ ...options, endpointId: `${endpointId}?ignored=1` }),
    await executeTregCall({ ...wire }),
    await executeTregCall(wrong),
    await executeControlProbe(endpointId, options),
  ]) expect(result).toMatchObject({ ok: false, blocked: "funded_transport_required" });
  expect(fetch).not.toHaveBeenCalled();
  const response = await executeTregCall(wire);
  expect(response).toMatchObject({ ok: false, httpStatus: 429, data: null });
  expect(JSON.stringify(response)).not.toContain("private@example.test");
  expect(await executeTregCall(wire)).toMatchObject({ ok: false, blocked: "funded_transport_required" });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(capture).not.toHaveBeenCalled();
});

it("blocks ordinary, web, and tagged sends when a restarted phase cannot prove its funded exposure", async () => {
  const catalog = activateFixture();
  const mission = newMission({ id: missionId, user_id: "synthetic-user", status: "planning", request_text: "اجمع شركات في مصر" });
  const store = createMemoryStore([mission]);
  const costs = fakeRecorder();
  const fetch = vi.fn(async () => new Response(JSON.stringify({
    companies: [{ website: "firm.example", name: "Firm" }], more: true, next: 5,
  }), { headers: { "x-treg-cost-micro": "1000" } }));
  vi.stubGlobal("fetch", fetch);
  const common = { catalog, store, client: {}, recorder: costs.recorder, commit: costs.commit, call: executeTregCall, token: "synthetic-key" };
  const gateway = () => createGateway({
    ...common, missionId, userId: mission.user_id, jobId: null, phase: "planning", access: NOT_ADMIN,
    budget: createJobCallBudget({ ceilingUsd: 0.05, spentUsd: 0 }), defaultPurpose: "", counter: { seq: 0 },
  });
  const add = store.addCall;
  store.addCall = async () => { throw new Error("worker stopped before the call row"); };
  await expect(gateway().fundedCaller(schedule)({ endpoint_id: endpointId, params })).rejects.toThrow("worker stopped");
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(store.calls).toHaveLength(0);
  store.addCall = add;

  const list = store.listFiles;
  store.listFiles = async (id, path) => {
    if (path === folder) throw new Error("journal listing unavailable");
    return list(id, path);
  };
  fetch.mockClear();
  expect(await gateway().fundedCaller(schedule)({ endpoint_id: endpointId, params })).toMatchObject({ ok: false });
  setValidatedAdditionsForTest(null);
  store.settings.llm_planner_v1 = false;
  const driver = createFakeDriver([
    { tool: "treg_call", args: { endpoint_id: POSTS_ENDPOINT, params: { query: "synthetic" } } },
    { tool: "web_search", args: { provider: "firecrawl", query: "synthetic", limit: 10 } },
  ], { stopAfterTerminal: false });
  const webFetch = vi.fn(async () => new Response("{}"));
  await runPlanning({
    ...common, driver, providerKey: async () => "synthetic-key", fetchFn: webFetch,
    resolveAccess: async () => NOT_ADMIN, models: { planning: "fake-model", execution: "fake-model" },
  }, mission);
  expect(driver.results.map(({ result }) => result.ok)).toEqual([false, false]);
  expect(fetch).not.toHaveBeenCalled();
  expect(webFetch).not.toHaveBeenCalled();
});

it.each([
  ["verified match", true, "firm.example", 1, 2_000],
  ["different domain", true, "other.example", 0, 2_000],
  ["miss", false, "firm.example", 0, 0],
  ["non-boolean success", "true", "firm.example", 0, 0],
] as const)("keeps lookup delivery and provider spend independent for a %s", async (_scenario, found, domain, rows, chargedMicros) => {
  const lookup = {
    ...synthetic, id: "synthetic.company.lookup", method: "GET", pagination: [],
    inputs: [{ name: "domain", type: "string", required: true }],
    cost: { usd: 0.002, unit: "call", type: "per_success" },
  };
  const lookupContract = {
    endpoint_id: lookup.id, role: "delivery", dispatch: "funded",
    request: { exactlyOne: true },
    result: { objectPath: "company", successPath: "found", matchInput: "domain", identityKey: "website", fields: ["name", "website"] },
  };
  const admission = validateCatalogAdditions({ version: 1, entries: [{ endpoint: lookup, contract: lookupContract, policy: "public" }] });
  expect(admission.valid).toBe(true);
  setValidatedAdditionsForTest(admission);
  const store = createMemoryStore();
  const recorder = fakeRecorder();
  const fetch = vi.fn(async () => new Response(JSON.stringify({
    found, company: { website: domain, name: "Synthetic company", phone: "DO_NOT_STORE" },
  }), { headers: { "x-treg-cost-micro": String(chargedMicros) } }));
  vi.stubGlobal("fetch", fetch);
  const catalog = parseCatalog({ endpoints: [lookup] }, [], { endpoints: [lookupContract] });
  const gateway = createGateway({
    catalog, store, missionId, userId: "synthetic-user", jobId: null, client: {},
    phase: "planning", access: NOT_ADMIN, budget: createJobCallBudget({ ceilingUsd: 0.01, spentUsd: 0 }),
    recorder: recorder.recorder, commit: recorder.commit, call: executeTregCall, defaultPurpose: "", counter: { seq: 0 }, token: "fake",
  });
  const identity = { domain: "firm.example" };
  const response = await gateway.fundedCaller({
    endpointId: lookup.id, params: identity, pageSize: null, maxPages: 1, maxPerCallMicros: 2_000, maxTotalMicros: 2_000,
  })({ endpoint_id: lookup.id, params: identity });
  expect(response).toMatchObject({ ok: true, rows_in_page: rows, charge_usd: chargedMicros / 1_000_000 });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(JSON.stringify([...store.files.values()])).not.toContain("DO_NOT_STORE");
});
