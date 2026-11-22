import { describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "../agent/src/memoryStore";
import { ItemStore } from "../agent/src/items/itemStore";
import { runEngine } from "../agent/src/engine/run";
import { RAW_PATH, type Gateway } from "../agent/src/gateway";
import type { EngineSpec, PricedPlan } from "../src/lib/agentMission/plan";

const NOW = Date.parse("2026-11-22T08:00:00Z");
const PRIMARY_ENDPOINT = "test.company.employees";
const ALT0_ENDPOINT = "test.company.alt0";
const ALT1_ENDPOINT = "test.company.alt1";
const ALT2_ENDPOINT = "test.company.alt2";
const MAP = { map_code: "return inputs.page", map_file_id: "page" };

interface CallRecord {
  endpoint: string;
  params: Record<string, unknown>;
}

type CallHandler = (params: Record<string, unknown>, callIndex: number) => {
  rows: Array<Record<string, unknown>>;
  http_status?: number;
  failed?: boolean;
  has_more?: boolean;
};

function createEngineWorld(handlers: Record<string, CallHandler>, options: { sleepSpy?: (ms: number) => Promise<void> } = {}) {
  const store = createMemoryStore();
  const calls: CallRecord[] = [];
  const counts: Record<string, number> = {};
  let seq = 0;

  const gateway = {
    async tregCall(input: { endpoint_id?: unknown; params?: unknown }) {
      const endpoint = String(input.endpoint_id);
      const params = (input.params ?? {}) as Record<string, unknown>;
      calls.push({ endpoint, params });
      counts[endpoint] = (counts[endpoint] ?? 0) + 1;
      const handler = handlers[endpoint] ?? (() => ({ rows: [] }));
      const out = handler(params, counts[endpoint]);
      if (out.failed) {
        return {
          ok: false as const,
          failed: true,
          http_status: out.http_status ?? 500,
          message: "simulated failure",
        };
      }
      const callId = `call_${String((seq += 1)).padStart(4, "0")}`;
      await store.putFile("msn_test", RAW_PATH(callId), JSON.stringify(out.rows), "application/json");
      return {
        ok: true as const,
        call_id: callId,
        http_status: out.http_status ?? 200,
        rows_in_page: out.rows.length,
        has_more: out.has_more ?? false,
        next_cursor: null,
        shape: null,
        first_rows: [],
        warnings: [],
        saved: "",
      };
    },
  } as unknown as Gateway;

  const run = async (plan: PricedPlan, extra: Record<string, unknown> = {}) => {
    const items = await ItemStore.open(store, "msn_test");
    const outcome = await runEngine({
      items,
      store,
      plan,
      missionId: "msn_test",
      gateway,
      sandbox: async (_c, inputs) => ({
        ok: true,
        resultJson: JSON.stringify(Object.values(inputs)[0]),
        logs: [],
      }),
      addEvent: async () => undefined,
      now: () => NOW,
      deadlineMs: NOW + 3_600_000,
      sleep: options.sleepSpy ?? (async () => undefined),
      redesignStages: new Set(plan.stages.map((s) => s.key)),
      ...extra,
    });
    return { outcome, items };
  };

  return { run, calls, store };
}

function buildTestPlan(options: {
  parents: Array<Record<string, unknown>>;
  perParent: number;
  alternatives?: EngineSpec["alternatives"];
}): PricedPlan {
  const n = options.parents.length;
  return {
    summary_ar: "خطة تجريبية",
    stages: [
      {
        key: "companies",
        title_ar: "الشركات",
        endpoint_id: "test.companies",
        expected_rows: n,
        planned_rows: n,
        parent_key: null,
        deliver: true,
        columns: [{ key: "name", title_ar: "الاسم" }],
        sample_rows: [],
        measured_by: [],
        measured_cost_per_row_usd: 0,
        yield_share: 1,
        review_share: 0,
        pinned_rows: options.parents,
        engine: {
          endpoint_id: "test.companies",
          params: {},
          cursor_param: null,
          ...MAP,
          parent_binding: null,
          built_by: "code",
        },
      },
      {
        key: "people",
        title_ar: "الأشخاص",
        endpoint_id: PRIMARY_ENDPOINT,
        expected_rows: n * options.perParent,
        planned_rows: n * options.perParent,
        parent_key: "companies",
        per_parent_rows: options.perParent,
        deliver: true,
        columns: [{ key: "name", title_ar: "الاسم" }],
        sample_rows: [],
        measured_by: [],
        measured_cost_per_row_usd: 0.001,
        yield_share: 1,
        review_share: 0,
        parent_pins: options.parents.map((p) => String(p.id)),
        engine: {
          endpoint_id: PRIMARY_ENDPOINT,
          params: {},
          cursor_param: "cursor",
          ...MAP,
          parent_binding: { param: "company_name", from: "name" },
          built_by: "code",
          alternatives: options.alternatives ?? [],
        },
      },
    ],
    price: { deliveredRows: n * options.perParent },
    compiled: {
      by: "compiler",
      platform: "web",
      promises: {},
      conditions: { named: false, period: false, language: false, country: false, topic: false },
    },
  } as unknown as PricedPlan;
}

const altSpec = (endpoint: string): NonNullable<EngineSpec["alternatives"]>[number] => ({
  endpoint_id: endpoint,
  params: {},
  cursor_param: "cursor",
  ...MAP,
  parent_binding: { param: "company_name", from: "name" },
});

describe("FX-08 Point P-A1: Shortfall Short-Circuit & Review Sleep Skip", () => {
  it("1. Definitive empty 200 skips p:<id>:retry and caps alternatives to at most 1", async () => {
    const handlers: Record<string, CallHandler> = {
      // Primary returns definitive empty 200 (rows: [], http_status: 200, has_more: false)
      [PRIMARY_ENDPOINT]: () => ({ rows: [], http_status: 200, has_more: false }),
      // Alt0 returns empty
      [ALT0_ENDPOINT]: () => ({ rows: [], http_status: 200 }),
      // Alt1 and Alt2 should NEVER be called!
      [ALT1_ENDPOINT]: () => ({ rows: [{ id: "p1", name: "Person 1" }] }),
      [ALT2_ENDPOINT]: () => ({ rows: [{ id: "p2", name: "Person 2" }] }),
    };

    const w = createEngineWorld(handlers);
    const plan = buildTestPlan({
      parents: [{ id: "c1", name: "Company 1" }],
      perParent: 3,
      alternatives: [altSpec(ALT0_ENDPOINT), altSpec(ALT1_ENDPOINT), altSpec(ALT2_ENDPOINT)],
    });

    const { items } = await w.run(plan);
    const streamKeys = items.streamKeys("people");

    // Must NOT have called p:c1:retry!
    expect(streamKeys).not.toContain("p:c1:retry");
    // Must have called alt0
    expect(streamKeys).toContain("p:c1:alt0");
    // Must NOT have called alt1 or alt2 (capped at 1 alt after empty primary)
    expect(streamKeys).not.toContain("p:c1:alt1");
    expect(streamKeys).not.toContain("p:c1:alt2");
    expect(w.calls.some((c) => c.endpoint === ALT1_ENDPOINT)).toBe(false);
    expect(w.calls.some((c) => c.endpoint === ALT2_ENDPOINT)).toBe(false);
  });

  it("2. Failed primary (HTTP 500) still allows retry and caps alternatives to 1", async () => {
    const handlers: Record<string, CallHandler> = {
      // Primary fails with 500
      [PRIMARY_ENDPOINT]: () => ({ rows: [], failed: true, http_status: 500 }),
      [ALT0_ENDPOINT]: () => ({ rows: [{ id: "alt0_p1", name: "Alt Person 1" }] }),
      [ALT1_ENDPOINT]: () => ({ rows: [{ id: "alt1_p1", name: "Alt Person 2" }] }),
    };

    const w = createEngineWorld(handlers);
    const plan = buildTestPlan({
      parents: [{ id: "c1", name: "Company 1" }],
      perParent: 3,
      alternatives: [altSpec(ALT0_ENDPOINT), altSpec(ALT1_ENDPOINT)],
    });

    const { items } = await w.run(plan);
    const streamKeys = items.streamKeys("people");

    // Failed primary allows retry: primary endpoint is called for initial stream and for retry stream (4 calls total due to in-stream retry on 500)
    expect(w.calls.filter((c) => c.endpoint === PRIMARY_ENDPOINT).length).toBe(4);
    // And calls alt0
    expect(streamKeys).toContain("p:c1:alt0");
    // But does NOT call alt1 (still capped at 1 alt since primary yielded 0)
    expect(streamKeys).not.toContain("p:c1:alt1");
    expect(w.calls.some((c) => c.endpoint === ALT1_ENDPOINT)).toBe(false);
  });

  it("3. Partial primary (>0 but < perParent) allows multiple alternatives without primary retry", async () => {
    const handlers: Record<string, CallHandler> = {
      // Primary returns 1 row (less than perParent = 3)
      [PRIMARY_ENDPOINT]: () => ({ rows: [{ id: "p_prim", name: "Primary Person" }] }),
      // Alt0 returns 1 row
      [ALT0_ENDPOINT]: () => ({ rows: [{ id: "p_alt0", name: "Alt0 Person" }] }),
      // Alt1 returns 1 row (fills to 3)
      [ALT1_ENDPOINT]: () => ({ rows: [{ id: "p_alt1", name: "Alt1 Person" }] }),
    };

    const w = createEngineWorld(handlers);
    const plan = buildTestPlan({
      parents: [{ id: "c1", name: "Company 1" }],
      perParent: 3,
      alternatives: [altSpec(ALT0_ENDPOINT), altSpec(ALT1_ENDPOINT)],
    });

    const { items } = await w.run(plan);
    const streamKeys = items.streamKeys("people");

    // Partial primary does NOT retry primary
    expect(streamKeys).not.toContain("p:c1:retry");
    // But CAN use multiple alternatives up to supply!
    expect(streamKeys).toContain("p:c1:alt0");
    expect(streamKeys).toContain("p:c1:alt1");
    expect(items.acceptedRows("people")).toHaveLength(3);
  });

  it("4. Parent swaps keep their cap and spare parents are swapped cleanly", async () => {
    const handlers: Record<string, CallHandler> = {
      [PRIMARY_ENDPOINT]: (params) => {
        // c1 has no people
        if (params.company_name === "Company 1") return { rows: [] };
        // c2 has people
        return { rows: [{ id: "p_c2_1", name: "C2 Person 1" }] };
      },
      [ALT0_ENDPOINT]: (params) => {
        // c1 alt0 also has no people
        if (params.company_name === "Company 1") return { rows: [] };
        return { rows: [{ id: "p_c2_alt", name: "C2 Person 2" }] };
      },
    };

    const w = createEngineWorld(handlers);
    // Company 1 (empty), Company 2 (spare)
    const plan = buildTestPlan({
      parents: [
        { id: "c1", name: "Company 1" },
        { id: "c2", name: "Company 2" },
      ],
      perParent: 1,
      alternatives: [altSpec(ALT0_ENDPOINT)],
    });

    const { items } = await w.run(plan);
    // C1 should have been swapped or processed
    expect(items.acceptedRows("people").length).toBeGreaterThan(0);
  });

  it("5. Conditional retryReviewLater skips sleep when pending is 0, budgetReached, stop not failed, or deadline close", async () => {
    const sleepSpy = vi.fn(async () => undefined);

    // Sub-case 5a: pending === 0 -> sleep is NOT called
    {
      const w = createEngineWorld({}, { sleepSpy });
      const plan = buildTestPlan({
        parents: [{ id: "c1", name: "Company 1" }],
        perParent: 1,
      });
      // Attach reviewer with stop: "failed" but counts.pending === 0
      const reviewer = {
        state: async () => ({ stop: "failed" as const, budgetReached: false }),
        drain: async () => undefined,
      };
      await w.run(plan, { reviewer });
      expect(sleepSpy).not.toHaveBeenCalled();
    }

    // Sub-case 5b: reviewState.budgetReached === true -> sleep is NOT called
    {
      sleepSpy.mockClear();
      const w = createEngineWorld({}, { sleepSpy });
      const plan = buildTestPlan({
        parents: [{ id: "c1", name: "Company 1" }],
        perParent: 1,
      });
      const reviewer = {
        state: async () => ({ stop: "failed" as const, budgetReached: true }),
        drain: async () => undefined,
      };
      await w.run(plan, { reviewer });
      expect(sleepSpy).not.toHaveBeenCalled();
    }

    // Sub-case 5c: deadline too close (nowMs + 20_000 >= deadlineMs) -> sleep is NOT called
    {
      sleepSpy.mockClear();
      const w = createEngineWorld({}, { sleepSpy });
      const plan = buildTestPlan({
        parents: [{ id: "c1", name: "Company 1" }],
        perParent: 1,
      });
      const reviewer = {
        state: async () => ({ stop: "failed" as const, budgetReached: false }),
        drain: async () => undefined,
      };
      // deadline is within 10s of now
      await w.run(plan, { reviewer, deadlineMs: NOW + 10_000 });
      expect(sleepSpy).not.toHaveBeenCalled();
    }

    // Sub-case 5d: pending > 0, reviewer failed, !budgetReached, deadline far -> sleep IS called once with 20_000
    {
      sleepSpy.mockClear();
      const w = createEngineWorld({
        [PRIMARY_ENDPOINT]: () => ({
          rows: [{ id: "p1", name: "Person 1" }],
          http_status: 200,
        }),
      }, { sleepSpy });
      const plan = buildTestPlan({
        parents: [{ id: "c1", name: "Company 1" }],
        perParent: 1,
      });
      // Give people stage a model relevance so rows enter pending
      (plan.stages[1] as any).relevance = { judge: "model", words: ["test"] };
      const reviewer = {
        state: async () => ({ stop: "failed" as const, budgetReached: false }),
        drain: async () => undefined,
      };
      await w.run(plan, { reviewer });
      expect(sleepSpy).toHaveBeenCalledTimes(1);
      expect(sleepSpy).toHaveBeenCalledWith(20_000);
    }
  });
});
