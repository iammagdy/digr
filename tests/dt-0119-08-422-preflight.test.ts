import { describe, expect, it, vi } from "vitest";
import { loadTregCatalog, type CatalogEndpoint } from "../src/lib/treg/catalog";
import { toolDescribeEndpoint } from "../src/lib/modelPlanner/tools";
import { buildTools, newRunState, validateInputShape, type ToolContext } from "../agent/src/tools";
import { createMemoryStore, newMission } from "../agent/src/memoryStore";
import { createGateway } from "../agent/src/gateway";
import { createJobCallBudget } from "../src/lib/server/callBudget";
import { NOT_ADMIN, USER_ID, fakeRecorder, tregResult } from "./helpers/agentHarness";
import { fakeMoneyClient } from "./helpers/agentMoney";

/**
 * DT-20261119-08 c2: Generic schema-driven preflight for nested array/object inputs (e.g. company.linkedin_url).
 *  - No hard-coded provider or endpoint names in tool validation/describe logic.
 *  - Scalar sent where nested field expects array -> refused pre-gateway with actionable correction, 0 upstream calls.
 *  - Existing multi-URL array + filters -> passed through unchanged to gateway.
 *  - Unrelated endpoint accepting string input -> passed through unchanged to gateway.
 */
vi.stubGlobal("fetch", () => { throw new Error("a real network call was attempted"); });

const catalog = loadTregCatalog();

function makeTregCallTool(callMock: ReturnType<typeof vi.fn<(o: { params?: unknown }) => Promise<unknown>>>) {
  const store = createMemoryStore();
  const mission = newMission({ id: "msn_c2", user_id: USER_ID, status: "planning", request_text: "عايز شركتين" });
  store.missions.set(mission.id, mission);
  const rec = fakeRecorder();
  const gateway = createGateway({
    store,
    client: fakeMoneyClient().client,
    missionId: mission.id,
    userId: USER_ID,
    jobId: null,
    phase: "planning",
    access: NOT_ADMIN,
    catalog,
    budget: createJobCallBudget({ ceilingUsd: 1, spentUsd: 0 }),
    recorder: rec.recorder,
    commit: rec.commit,
    call: callMock as never,
    defaultPurpose: mission.request_text,
    counter: { seq: 0 },
    priorCalls: [],
  });
  const state = newRunState();
  const ctx: ToolContext = {
    phase: "planning",
    mission,
    plan: null,
    store,
    gateway,
    catalog,
    access: NOT_ADMIN,
    state,
  };
  const tools = buildTools(ctx);
  return {
    tregCall: tools.find((t) => t.name === "treg_call")!,
    describe: tools.find((t) => t.name === "describe_endpoint")!,
    state,
  };
}

describe("c2: generic nested object/array schema metadata and preflight check", () => {
  it("describe_endpoint exposes nested fields & example for object inputs expecting an array", () => {
    const res = toolDescribeEndpoint({ id: "blitzapi.people.search" }, NOT_ADMIN, catalog);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const companyInput = (res.endpoint.inputs as any[]).find((i) => i.name === "company");
    expect(companyInput).toBeDefined();
    expect(companyInput.fields?.linkedin_url).toMatchObject({ type: "array[string]" });
    expect(Array.isArray(companyInput.fields?.linkedin_url?.example)).toBe(true);
    expect(Array.isArray(companyInput.example?.linkedin_url)).toBe(true);
  });

  it("rejects a scalar sent where nested schema expects an array BEFORE calling the gateway (0 calls, state.tried free)", async () => {
    const callMock = vi.fn(async (_o: { params?: unknown }) => tregResult({ results: [] }, 0.001));
    const { tregCall, state } = makeTregCallTool(callMock);
    const out = await tregCall.handler({
      endpoint_id: "blitzapi.people.search",
      params: {
        company: { linkedin_url: "https://www.linkedin.com/company/orascom" },
        people: { job_title: { include: ["Director"] } },
        max_results: 5,
      },
      why: "testing scalar preflight",
    });
    expect(callMock).not.toHaveBeenCalled();
    expect(out.ok).toBe(false);
    expect(out.refused).toBe("invalid_params");
    expect(String(out.message)).toContain("company.linkedin_url");
    expect(String(out.message)).toMatch(/array/i);
    expect(state.tried.has("blitzapi.people.search")).toBe(false);
  });

  it("keeps existing multi-URL arrays and sibling filters unchanged", async () => {
    const callMock = vi.fn(async (_o: { params?: unknown }) => tregResult({ results: [{ full_name: "Test" }] }, 0.001));
    const { tregCall } = makeTregCallTool(callMock);
    const params = {
      company: { linkedin_url: ["https://www.linkedin.com/company/orascom", "https://www.linkedin.com/company/elsewedy"] },
      people: { job_title: { include: ["Director", "CEO"] } },
      max_results: 5,
    };
    const out = await tregCall.handler({ endpoint_id: "blitzapi.people.search", params, why: "valid multi-url array" });
    expect(out.ok).toBe(true);
    expect(callMock).toHaveBeenCalledTimes(1);
    expect(callMock.mock.calls[0]?.[0].params).toEqual(params);
  });

  it("leaves unrelated endpoints accepting a string untouched", async () => {
    const callMock = vi.fn(async (_o: { params?: unknown }) => tregResult({ results: [{ full_name: "Test" }] }, 0.001));
    const { tregCall } = makeTregCallTool(callMock);
    const params = {
      company_linkedin_url: "https://www.linkedin.com/company/orascom",
      cascade: [{ include_title: ["CEO"] }],
      max_results: 5,
    };
    const out = await tregCall.handler({ endpoint_id: "blitzapi.people.waterfall-icp", params, why: "string input" });
    expect(out.ok).toBe(true);
    expect(callMock).toHaveBeenCalledTimes(1);
    expect(callMock.mock.calls[0]?.[0].params).toEqual(params);
  });

  it("is strictly schema-driven (D-0086): works on any synthetic endpoint with nested fields metadata without naming providers or endpoints in tool logic", () => {
    const synthetic = {
      id: "generic.mock.search",
      inputs: [
        {
          name: "filter",
          in: "body",
          type: "object",
          required: false,
          enum: null,
          minimum: null,
          maximum: null,
          default: null,
          example: { urls: ["https://x.test"] },
          note: null,
          fields: { urls: { type: "array[string]", example: ["https://x.test"] } },
        },
      ],
    } as unknown as CatalogEndpoint;
    expect(validateInputShape(synthetic, { filter: { urls: "https://x.test" } })).toMatch(/filter\.urls.*array\[string\]/);
    expect(validateInputShape(synthetic, { filter: { urls: ["https://x.test"] } })).toBeNull();
  });
});
