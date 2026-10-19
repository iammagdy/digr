import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ call: vi.fn() }));

vi.mock("../src/functions/shared/catalogClient", () => ({
  getEndpointDetails: vi.fn(async () => null),
}));
vi.mock("../src/lib/server/providerGate", () => ({
  getLiveProviderGateStatus: () => ({ isReady: true, reasonCode: "ready", messageAr: "" }),
}));
vi.mock("../src/functions/shared/tregClient", () => ({
  executeTregCall: mocks.call,
}));

import { KEYWORDS_ONLY_CURSOR_PREFIX, defaultTregAdapter, normalizeIcypeasCompanyParams } from "../src/lib/server/tregAdapter";

/** The plan of «عايز شركتين كهرباء في مصر» as the planner stores it. */
const ELECTRICITY_PARAMS = {
  query: {
    location: { include: ["Egypt"] },
    industry: { include: ["Electrical/Electronic Manufacturing", "Utilities"] },
    keyword: { include: ["electrical", "electricity", "electrical engineering"] },
  },
  country: "Egypt",
};

const reply = (rows: Array<Record<string, unknown>>, token?: string) => ({
  ok: true, httpStatus: 200, tregCallId: "call", costMicro: rows.length * 380, latencyMs: 1,
  data: { results: rows, pagination: token ? { token } : {} }, isRouteMaxCost: false, isPlatformBalanceLow: false,
});

const input = (over: Record<string, unknown> = {}) => ({
  jobId: "job_kw", userId: "user_kw", step: 0,
  endpointId: "icypeas.companies.search", capabilitySlug: "icypeas-companies-search",
  method: "POST" as const, params: ELECTRICITY_PARAMS, paginationStrategy: "cursor" as const, cursor: null as string | null,
  pageSize: 6, remainingNeeded: 2, targetVolumeMax: 2, deliveredSoFar: 0, ...over,
});

const sent = () => mocks.call.mock.calls.map(([call]) => call);

describe("company query: industry AND activity keywords together", () => {
  beforeEach(() => mocks.call.mockReset());

  it("the narrow request carries both industry.include and keyword.include", () => {
    const body = normalizeIcypeasCompanyParams(ELECTRICITY_PARAMS, 6);
    expect(body.query.location).toEqual({ include: ["Egypt"] });
    expect(body.query.industry).toEqual({ include: ["Electrical/Electronic Manufacturing", "Utilities"] });
    expect(body.query.keyword).toEqual({ include: ["electrical", "electricity", "electrical engineering"] });
  });

  it("a plan with only the label gets the sector's keywords; «Utilities» is never sent alone", () => {
    const labelOnly = normalizeIcypeasCompanyParams({ query: { location: { include: ["Egypt"] }, industry: { include: ["Electrical/Electronic Manufacturing", "Utilities"] } }, country: "Egypt", industry: "كهرباء" }, 6);
    expect(labelOnly.query.keyword?.include?.length).toBeGreaterThan(0);
    const utilitiesOnly = normalizeIcypeasCompanyParams({ query: { location: { include: ["Egypt"] }, industry: { include: ["Utilities"] } }, country: "Egypt" }, 6);
    // Either the label is dropped or it travels with keywords; it is never the only activity filter.
    const labels: string[] = utilitiesOnly.query.industry?.include || [];
    if (labels.includes("Utilities")) expect(utilitiesOnly.query.keyword?.include?.length).toBeGreaterThan(0);
  });

  it("the keywords-only variant has the same country and no industry labels at all", () => {
    const body = normalizeIcypeasCompanyParams(ELECTRICITY_PARAMS, 6, null, { keywordsOnly: true });
    expect(body.query.location).toEqual({ include: ["Egypt"] });
    expect(body.query.industry).toBeUndefined();
    expect(body.query.keyword).toEqual({ include: ["electrical", "electricity", "electrical engineering"] });
  });
});

describe("zero rows on the narrow request: exactly one keywords-only retry", () => {
  beforeEach(() => mocks.call.mockReset());

  it("zero rows triggers exactly one more call: keywords only, no taxonomy, a new idempotency step, a prefixed cursor", async () => {
    mocks.call
      .mockResolvedValueOnce(reply([]))
      .mockResolvedValueOnce(reply([{ name: "Nile Electrical Contracting", industry: "Electrical/Electronic Manufacturing" }], "next-token"));
    const result = await defaultTregAdapter(input());
    expect(mocks.call).toHaveBeenCalledTimes(2);
    const [narrow, retry] = sent();
    expect(narrow.params.query.industry).toBeDefined();
    expect(narrow.params.query.keyword).toBeDefined();
    expect(narrow.stepId).toBe("step_0");
    expect(retry.params.query.industry).toBeUndefined();
    expect(retry.params.query.keyword.include).toContain("electrical");
    expect(retry.params.query.location).toEqual({ include: ["Egypt"] });
    expect(retry.params.pagination.token).toBeUndefined();
    expect(retry.stepId).toBe("step_0_kw");
    expect(retry.stepId).not.toBe(narrow.stepId);
    expect(result.rows).toHaveLength(1);
    expect(result.nextCursor).toBe(`${KEYWORDS_ONLY_CURSOR_PREFIX}next-token`);
    expect(result.providerCallCount).toBe(2);
    expect(result.costMicro).toBe(380);
  });

  it("zero rows on the retry too: no third call, no taxonomy-only request ever", async () => {
    mocks.call.mockResolvedValue(reply([]));
    const result = await defaultTregAdapter(input());
    expect(mocks.call).toHaveBeenCalledTimes(2);
    expect(result.rows).toHaveLength(0);
    for (const call of sent()) expect(call.params.query.keyword?.include?.length).toBeGreaterThan(0);
  });

  it("a first call with rows never triggers the retry", async () => {
    mocks.call.mockResolvedValueOnce(reply([{ name: "Delta Power", industry: "Utilities" }], "tok"));
    const result = await defaultTregAdapter(input());
    expect(mocks.call).toHaveBeenCalledTimes(1);
    expect(result.providerCallCount).toBe(1);
    expect(result.nextCursor).toBe("tok");
  });

  it("a failed first call is not retried with a different query", async () => {
    mocks.call.mockResolvedValue({ ok: false, httpStatus: 400, tregCallId: "x", costMicro: 0, data: {}, error: "bad", isRouteMaxCost: false, isPlatformBalanceLow: false });
    await defaultTregAdapter(input());
    for (const call of sent()) expect(call.params.query.industry).toBeDefined();
  });
});

describe("pagination never changes its query", () => {
  beforeEach(() => mocks.call.mockReset());

  it("a later page of the narrow query keeps industry AND keywords and never retries", async () => {
    mocks.call.mockResolvedValueOnce(reply([]));
    await defaultTregAdapter(input({ step: 1, cursor: "narrow-token" }));
    expect(mocks.call).toHaveBeenCalledTimes(1);
    expect(sent()[0].params.query.industry).toBeDefined();
    expect(sent()[0].params.query.keyword).toBeDefined();
    expect(sent()[0].params.pagination.token).toBe("narrow-token");
  });

  it("a page whose cursor came from the keywords-only query keeps that query: keywords only, the provider's own token", async () => {
    mocks.call.mockResolvedValueOnce(reply([{ name: "Cairo Power Systems" }], "kw-next"));
    const result = await defaultTregAdapter(input({ step: 1, cursor: `${KEYWORDS_ONLY_CURSOR_PREFIX}kw-token` }));
    expect(mocks.call).toHaveBeenCalledTimes(1);
    const call = sent()[0];
    expect(call.params.query.industry).toBeUndefined();
    expect(call.params.query.keyword.include).toContain("electrical");
    expect(call.params.pagination.token).toBe("kw-token");
    expect(call.stepId).toBe("step_1_kw");
    expect(result.nextCursor).toBe(`${KEYWORDS_ONLY_CURSOR_PREFIX}kw-next`);
  });

  it("a keywords-only page with no rows does not retry or widen to the labels", async () => {
    mocks.call.mockResolvedValueOnce(reply([]));
    await defaultTregAdapter(input({ step: 2, cursor: `${KEYWORDS_ONLY_CURSOR_PREFIX}kw-token` }));
    expect(mocks.call).toHaveBeenCalledTimes(1);
    expect(sent()[0].params.query.industry).toBeUndefined();
  });
});
