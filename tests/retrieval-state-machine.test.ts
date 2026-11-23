import { describe, expect, it, vi } from "vitest";
import {
  freezeTimeWindow,
  isRowDateInWindow,
  shouldStopChronologicalScan,
  initPaginationState,
  stepPagination,
  buildHonestShortfallQuestion,
  canAskShortfallQuestion,
} from "../agent/src/llmPlanner/retrievalContract";
import { clampOutgoingPageSize, tregCallBoundOf } from "../agent/src/gateway";
import { loadTregCatalog, type CatalogEndpoint, type TregCatalog } from "../src/lib/treg/catalog";
import { makeHarness, POSTS_ENDPOINT, tregResult } from "./helpers/agentHarness";

vi.stubGlobal("fetch", () => {
  throw new Error("offline unit test - no network calls allowed");
});

describe("Point 3.1: Universal Retrieval Contract & Pagination State Machine", () => {
  describe("freezeTimeWindow", () => {
    it("freezes window deterministically with startUtc, endUtc, and customerTz", () => {
      const ref = new Date("2026-11-23T12:00:00.000Z");
      const window = freezeTimeWindow(3, "Africa/Cairo", ref);

      expect(window.endUtc).toBe("2026-11-23T12:00:00.000Z");
      expect(window.startUtc).toBe("2026-08-23T12:00:00.000Z");
      expect(window.customerTz).toBe("Africa/Cairo");
    });

    it("defaults customerTz to Africa/Cairo when omitted", () => {
      const ref = new Date("2026-11-23T12:00:00.000Z");
      const window = freezeTimeWindow(6, undefined, ref);
      expect(window.customerTz).toBe("Africa/Cairo");
      expect(window.startUtc).toBe("2026-05-23T12:00:00.000Z");
    });

    it("throws on invalid referenceDate", () => {
      expect(() => freezeTimeWindow(3, "UTC", new Date("invalid"))).toThrow("Invalid referenceDate");
    });
  });

  describe("isRowDateInWindow", () => {
    const window = {
      startUtc: "2026-08-01T00:00:00.000Z",
      endUtc: "2026-11-01T00:00:00.000Z",
      customerTz: "Africa/Cairo",
    };

    it("accepts Date, ISO string, and numeric timestamp within window", () => {
      expect(isRowDateInWindow(new Date("2026-09-15T10:00:00.000Z"), window)).toBe(true);
      expect(isRowDateInWindow("2026-10-01T00:00:00.000Z", window)).toBe(true);
      expect(isRowDateInWindow(new Date("2026-08-01T00:00:00.000Z").getTime(), window)).toBe(true);
      expect(isRowDateInWindow(new Date("2026-11-01T00:00:00.000Z").getTime(), window)).toBe(true);
    });

    it("rejects dates older than startUtc or newer than endUtc", () => {
      expect(isRowDateInWindow("2026-07-31T23:59:59.000Z", window)).toBe(false);
      expect(isRowDateInWindow("2026-11-01T00:00:01.000Z", window)).toBe(false);
      expect(isRowDateInWindow("2025-01-01T00:00:00.000Z", window)).toBe(false);
    });

    it("rejects invalid dates safely", () => {
      expect(isRowDateInWindow("not-a-date", window)).toBe(false);
      expect(isRowDateInWindow(NaN, window)).toBe(false);
    });
  });

  describe("shouldStopChronologicalScan (Pinned post invariant)", () => {
    const window = {
      startUtc: "2026-08-01T00:00:00.000Z",
      endUtc: "2026-11-01T00:00:00.000Z",
      customerTz: "Africa/Cairo",
    };

    it("does NOT terminate on a single old post at index 0 (pinned post)", () => {
      const feedDates = [
        "2025-01-01T00:00:00.000Z", // Pinned old post!
        "2026-10-20T00:00:00.000Z", // In window
        "2026-10-15T00:00:00.000Z", // In window
      ];
      expect(shouldStopChronologicalScan(feedDates, window)).toBe(false);
    });

    it("terminates when consecutive posts past window reaches threshold (default 2)", () => {
      const feedDates = [
        "2026-08-05T00:00:00.000Z", // In window
        "2026-07-25T00:00:00.000Z", // Past window (1)
        "2026-07-20T00:00:00.000Z", // Past window (2) -> STOP!
      ];
      expect(shouldStopChronologicalScan(feedDates, window)).toBe(true);
    });

    it("does not terminate if only 1 post is past window and threshold is 2", () => {
      const feedDates = [
        "2026-08-05T00:00:00.000Z", // In window
        "2026-07-25T00:00:00.000Z", // Past window (1)
      ];
      expect(shouldStopChronologicalScan(feedDates, window)).toBe(false);
    });

    it("terminates on non-pinned post past cutoff when minConsecutivePastWindow is 1", () => {
      const feedDates = [
        "2026-08-05T00:00:00.000Z", // In window (pinned or recent)
        "2026-07-25T00:00:00.000Z", // Index 1 is past window -> stops
      ];
      expect(shouldStopChronologicalScan(feedDates, window, 1)).toBe(true);
    });

    it("does not terminate if feed is empty", () => {
      expect(shouldStopChronologicalScan([], window)).toBe(false);
    });
  });

  describe("Pagination State Machine (initPaginationState & stepPagination)", () => {
    const window = {
      startUtc: "2026-08-01T00:00:00.000Z",
      endUtc: "2026-11-01T00:00:00.000Z",
      customerTz: "Africa/Cairo",
    };

    it("initializes pagination state correctly", () => {
      const state = initPaginationState({
        endpointId: "test.endpoint",
        provider: "test-provider",
        queryHash: "hash123",
        window,
        initialCursor: null,
      });

      expect(state.pagesFetched).toBe(0);
      expect(state.acceptedCount).toBe(0);
      expect(state.seenCanonicalIds.size).toBe(0);
      expect(state.stopReason).toBeNull();
      expect(state.cursor).toBeNull();
    });

    it("transitions normally across pages and deduplicates canonical IDs", () => {
      const state = initPaginationState({
        endpointId: "test.endpoint",
        window,
      });

      // Page 1
      const step1 = stepPagination({
        state,
        nextCursor: "cursor_p2",
        canonicalIds: ["id_1", "id_2", "id_3"],
        acceptedRowsCount: 3,
        targetRows: 10,
        maxPages: 5,
      });
      expect(step1.shouldContinue).toBe(true);
      expect(step1.stopReason).toBeNull();
      expect(state.pagesFetched).toBe(1);
      expect(state.acceptedCount).toBe(3);
      expect(state.seenCanonicalIds.size).toBe(3);
      expect(state.cursor).toBe("cursor_p2");

      // Page 2 with one duplicate ID
      const step2 = stepPagination({
        state,
        nextCursor: "cursor_p3",
        canonicalIds: ["id_3", "id_4"], // id_3 is duplicate
        acceptedRowsCount: 1,
        targetRows: 10,
        maxPages: 5,
      });
      expect(step2.shouldContinue).toBe(true);
      expect(state.pagesFetched).toBe(2);
      expect(state.acceptedCount).toBe(4);
      expect(state.seenCanonicalIds.size).toBe(4);
    });

    it("stops with repeated_cursor when cursor loops", () => {
      const state = initPaginationState({ endpointId: "test.endpoint", window });
      stepPagination({ state, nextCursor: "cursor_abc" });
      const step2 = stepPagination({ state, nextCursor: "cursor_abc" }); // Repeated!

      expect(step2.shouldContinue).toBe(false);
      expect(step2.stopReason).toBe("repeated_cursor");
      expect(state.stopReason).toBe("repeated_cursor");
    });

    it("stops with terminal_cursor when cursor is exhausted", () => {
      const state = initPaginationState({ endpointId: "test.endpoint", window });
      const step = stepPagination({ state, nextCursor: null });

      expect(step.shouldContinue).toBe(false);
      expect(step.stopReason).toBe("terminal_cursor");
    });

    it("stops with terminal_cursor when hasMore is explicitly false", () => {
      const state = initPaginationState({ endpointId: "test.endpoint", window });
      const step = stepPagination({ state, nextCursor: "dummy_cursor", hasMore: false });

      expect(step.shouldContinue).toBe(false);
      expect(step.stopReason).toBe("terminal_cursor");
    });

    it("stops with target_reached when accepted count reaches targetRows", () => {
      const state = initPaginationState({ endpointId: "test.endpoint", window });
      const step = stepPagination({
        state,
        nextCursor: "next_cur",
        acceptedRowsCount: 50,
        targetRows: 50,
      });

      expect(step.shouldContinue).toBe(false);
      expect(step.stopReason).toBe("target_reached");
    });

    it("stops with budget_reached when pagesFetched reaches maxPages", () => {
      const state = initPaginationState({ endpointId: "test.endpoint", window });
      stepPagination({ state, nextCursor: "p2", maxPages: 2 });
      const step2 = stepPagination({ state, nextCursor: "p3", maxPages: 2 });

      expect(step2.shouldContinue).toBe(false);
      expect(step2.stopReason).toBe("budget_reached");
    });

    it("stops with window_crossed when feed crosses chronological cutoff", () => {
      const state = initPaginationState({ endpointId: "test.endpoint", window });
      const step = stepPagination({
        state,
        nextCursor: "next_cur",
        rowDates: ["2026-07-20T00:00:00.000Z", "2026-07-15T00:00:00.000Z"], // older than window start 2026-08-01
        minConsecutivePastWindow: 2,
      });

      expect(step.shouldContinue).toBe(false);
      expect(step.stopReason).toBe("window_crossed");
    });
  });

  describe("Deep Account Timeline Scanning Contract (Honest wording & shortfall rules)", () => {
    it("generates honest Arabic shortfall wording with examined count, account, and platform", () => {
      const question = buildHonestShortfallQuestion({
        examinedCount: 80,
        account: "@SaudiMOH",
        platform: "X",
        noun: "تغريدة",
      });

      expect(question).toBe(
        "«جرّبنا البحث في 80 تغريدة من @SaudiMOH على X بالشروط التي كتبتها ولم نجد نتائج متطابقة. تحب نسلّمك الموجود، ولا نوسّع البحث؟»"
      );
    });

    it("forbids shortfall question before budgeted pages are read when account has more posts", () => {
      // 1 page read, budget allows 4 pages, hasMore is true, 0 on-topic matches
      const canAsk = canAskShortfallQuestion({
        pagesRead: 1,
        maxBudgetedPages: 4,
        hasMore: true,
        onTopicMatches: 0,
      });
      expect(canAsk).toBe(false);
    });

    it("allows shortfall question once all budgeted pages have been read", () => {
      const canAsk = canAskShortfallQuestion({
        pagesRead: 4,
        maxBudgetedPages: 4,
        hasMore: true,
        onTopicMatches: 0,
      });
      expect(canAsk).toBe(true);
    });

    it("allows shortfall question if source has ended before budget", () => {
      const canAsk = canAskShortfallQuestion({
        pagesRead: 2,
        maxBudgetedPages: 4,
        hasMore: false,
        onTopicMatches: 0,
      });
      expect(canAsk).toBe(true);
    });
  });
});

describe("Point 3.4: Runtime Page-Size Clamping", () => {
  it("Must-Pass Case 1 (Asked > Max): clamps requested limit to contract max_page_size", () => {
    const mockEndpoint = {
      id: "test.provider.search",
      adapter_contract: {
        endpoint_id: "test.provider.search",
        pagination: {
          max_page_size: 100,
          page_size_param: "limit",
          default_page_size: 50,
          automated_paging_ready: true,
          stop_rule: null,
          cursor_in_param: null,
          cursor_out_path_rest: null,
          cursor_out_path_mcp: null,
          max_page_size_semantics: null,
        } as any,
      },
      inputs: [{ name: "query", required: true }, { name: "limit", required: false }],
    } as unknown as CatalogEndpoint;

    const clamped = clampOutgoingPageSize(mockEndpoint, { query: "hello", limit: 200 });
    expect(clamped).toEqual({ query: "hello", limit: 100 });
  });

  it("Must-Pass Case 2 (Asked <= Max): leaves limit unchanged when within contract max_page_size", () => {
    const mockEndpoint = {
      id: "test.provider.search",
      adapter_contract: {
        endpoint_id: "test.provider.search",
        pagination: {
          max_page_size: 100,
          page_size_param: "limit",
        } as any,
      },
      inputs: [{ name: "query", required: true }, { name: "limit", required: false }],
    } as unknown as CatalogEndpoint;

    const clamped = clampOutgoingPageSize(mockEndpoint, { query: "hello", limit: 50 });
    expect(clamped).toEqual({ query: "hello", limit: 50 });
  });

  it("Must-Pass Case 3 (No Contract / Uncapped): leaves parameters unchanged when no contract exists", () => {
    const mockEndpoint = {
      id: "test.provider.uncapped",
      adapter_contract: null,
      inputs: [{ name: "query", required: true }, { name: "limit", required: false }],
    } as unknown as CatalogEndpoint;

    const clamped = clampOutgoingPageSize(mockEndpoint, { query: "hello", limit: 500 });
    expect(clamped).toEqual({ query: "hello", limit: 500 });
  });

  it("Must-Pass Case 4 (Max without param): leaves parameters unchanged when contract lacks page_size_param", () => {
    const mockEndpoint = {
      id: "test.no.param",
      adapter_contract: {
        endpoint_id: "test.no.param",
        pagination: { max_page_size: 100, page_size_param: null } as any,
      },
      inputs: [{ name: "query", required: true }, { name: "limit", required: false }],
    } as unknown as CatalogEndpoint;

    const clamped = clampOutgoingPageSize(mockEndpoint, { query: "hello", limit: 200 });
    expect(clamped).toEqual({ query: "hello", limit: 200 });
  });

  it("Must-Pass Case 5 (Arbitrary field count/num): leaves count and num unchanged when contract has no page_size_param", () => {
    const mockEndpoint = {
      id: "test.field.name",
      adapter_contract: {
        endpoint_id: "test.field.name",
        pagination: { max_page_size: 20, page_size_param: null } as any,
      },
    } as unknown as CatalogEndpoint;

    expect(clampOutgoingPageSize(mockEndpoint, { count: 100, num: 50 })).toEqual({ count: 100, num: 50 });
  });

  it("clamps alternative page-size parameter names (pageSize, count, max_results)", () => {
    const epCount = {
      id: "test.count",
      adapter_contract: {
        endpoint_id: "test.count",
        pagination: { max_page_size: 30, page_size_param: "count" } as any,
      },
    } as unknown as CatalogEndpoint;
    expect(clampOutgoingPageSize(epCount, { count: 50 })).toEqual({ count: 30 });

    const epMaxResults = {
      id: "test.max_results",
      adapter_contract: {
        endpoint_id: "test.max_results",
        pagination: { max_page_size: 25, page_size_param: "max_results" } as any,
      },
    } as unknown as CatalogEndpoint;
    expect(clampOutgoingPageSize(epMaxResults, { max_results: 100 })).toEqual({ max_results: 25 });
  });

  it("handles string numeric inputs gracefully", () => {
    const mockEndpoint = {
      id: "test.string.limit",
      adapter_contract: {
        endpoint_id: "test.string.limit",
        pagination: { max_page_size: 50, page_size_param: "limit" } as any,
      },
    } as unknown as CatalogEndpoint;

    expect(clampOutgoingPageSize(mockEndpoint, { limit: "150" })).toEqual({ limit: 50 });
  });

  it("clamps outgoing calls in gateway.tregCall execution path", async () => {
    const h = makeHarness({
      budgetUsd: 1.0,
      responses: [tregResult({ data: [{ id: 1 }] }, 0.01)],
    });

    // Attach adapter contract to POSTS_ENDPOINT with max_results param
    const ep = h.catalog.byId.get(POSTS_ENDPOINT);
    if (ep) {
      ep.adapter_contract = {
        endpoint_id: POSTS_ENDPOINT,
        pagination: {
          max_page_size: 100,
          page_size_param: "max_results",
          default_page_size: 50,
          automated_paging_ready: true,
          stop_rule: null,
          cursor_in_param: null,
          cursor_out_path_rest: null,
          cursor_out_path_mcp: null,
          max_page_size_semantics: null,
        } as any,
      };
    }

    const res = await h.gateway.tregCall({
      endpoint_id: POSTS_ENDPOINT,
      params: { query: "test", max_results: 250 },
    });

    expect(res.ok).toBe(true);
    expect(h.call).toHaveBeenCalledTimes(1);
    const callArgs = h.call.mock.calls[0][0];
    // Verified: Outgoing call dispatched with clamped max_results 100
    expect(callArgs.params.max_results).toBe(100);
  });

  it("tregCallBoundOf estimates on clamped parameters", () => {
    const catalog = loadTregCatalog();
    const ep = catalog.byId.get(POSTS_ENDPOINT)!;

    // Set contract max_page_size to 100 with page_size_param
    ep.adapter_contract = {
      endpoint_id: ep.id,
      pagination: {
        max_page_size: 100,
        page_size_param: "max_results",
        default_page_size: 50,
        automated_paging_ready: true,
        stop_rule: null,
        cursor_in_param: null,
        cursor_out_path_rest: null,
        cursor_out_path_mcp: null,
        max_page_size_semantics: null,
      } as any,
    };

    const bound = tregCallBoundOf(POSTS_ENDPOINT, { query: "test", max_results: 500 }, catalog);
    expect(typeof bound).toBe("number");
    expect(bound).toBe(0.5); // 100 rows * 0.005/row = 0.5, clamped down from 500 rows (2.5)
  });

  it("tools.ts treg_call clamps parameters before execution and state recording", async () => {
    const h = makeHarness({
      budgetUsd: 1.0,
      responses: [tregResult({ data: [{ id: 1 }] }, 0.01)],
    });

    const ep = h.catalog.byId.get(POSTS_ENDPOINT);
    if (ep) {
      ep.adapter_contract = {
        endpoint_id: POSTS_ENDPOINT,
        pagination: {
          max_page_size: 100,
          page_size_param: "max_results",
          default_page_size: 50,
          automated_paging_ready: true,
          stop_rule: null,
          cursor_in_param: null,
          cursor_out_path_rest: null,
          cursor_out_path_mcp: null,
          max_page_size_semantics: null,
        } as any,
      };
    }

    const { buildTools } = await import("../agent/src/tools");
    const tools = buildTools(h.ctx);
    const tregCallTool = tools.find((t) => t.name === "treg_call")!;

    const res = await tregCallTool.handler({
      endpoint_id: POSTS_ENDPOINT,
      params: { query: "test", max_results: 300 },
      why: "explicit test reason for dearer source",
    });

    expect((res as any).ok).toBe(true);
    expect(h.call).toHaveBeenCalledTimes(1);
    expect(h.call.mock.calls[0][0].params.max_results).toBe(100);

    // Verify state.callParams recorded clamped value
    const callId = (res as any).call_id;
    const recorded = h.ctx.state.callParams.get(callId);
    expect(recorded?.max_results).toBe(100);
  });
});

describe("Point 3.2: System Prompts & Semantic Discrimination (D-0086)", () => {
  it("TOOL_CHOICE_SYSTEM instructs query_syntax, neutral placeholder in more_params, and timeline priority", async () => {
    const { TOOL_CHOICE_SYSTEM } = await import("../agent/src/llmPlanner/prompts");
    expect(TOOL_CHOICE_SYSTEM).toContain("query_syntax");
    expect(TOOL_CHOICE_SYSTEM).toContain("more_params_json");
    expect(TOOL_CHOICE_SYSTEM).toContain("morphology-rich languages");
    expect(TOOL_CHOICE_SYSTEM).toContain("<account filter from query_syntax>");
    expect(TOOL_CHOICE_SYSTEM).not.toContain("from:Account شائعة");
    expect(TOOL_CHOICE_SYSTEM).toContain("account timeline or posts endpoint");
  });

  it("REVIEW_SYSTEM explicitly distinguishes rumors/misinformation from FAQs and administrative policies", async () => {
    const { REVIEW_SYSTEM } = await import("../agent/src/review");
    expect(REVIEW_SYSTEM).toContain("الأسئلة الشائعة");
    expect(REVIEW_SYSTEM).toContain("administrative policies");
    expect(REVIEW_SYSTEM).toContain("preventative health procedures");
    expect(REVIEW_SYSTEM).toContain("rumors/misinformation");
  });
});

describe("Point 3.5: Canonical Platform ID Deduplication in Ingest", () => {
  it("deduplicates rows with identical platform canonical ID before title/URL checks", async () => {
    const { ingestRows } = await import("../agent/src/items/ingest");
    const { ItemStore } = await import("../agent/src/items/itemStore");
    const { createMemoryStore } = await import("../agent/src/memoryStore");
    const { loadTregCatalog } = await import("../src/lib/treg/catalog");

    const cat = loadTregCatalog();
    const ep = cat.byId.get("anyapi.x.user.posts");
    expect(ep?.adapter_contract?.dedupe_key).toBe("id");

    const rawStore = createMemoryStore();
    const items = await ItemStore.open(rawStore as any, "test_job");

    const stage: any = {
      key: "s1",
      title_ar: "تغريدات",
      endpoint_id: "anyapi.x.user.posts",
      capability: "user_posts",
      expected_rows: 10,
      planned_rows: 10,
      parent_key: null,
      columns: [{ key: "row_id" }, { key: "id" }, { key: "text" }, { key: "title" }, { key: "url" }],
    };

    const row1 = {
      row_id: "r1",
      id: "tweet_canonical_999",
      url: "https://x.com/user/status/tweet_canonical_999",
      text: "First version of post about health",
      title: "Health Post",
    };

    const row2 = {
      row_id: "r2",
      id: "tweet_canonical_999", // Same platform ID
      url: "https://x.com/user/status/tweet_canonical_999?s=20", // Different URL query string
      text: "Completely different text that would pass fuzzy text comparison",
      title: "Different Title",
    };

    const reviewer: any = {
      budgetUsd: 10,
      state: async () => ({ stop: null }),
      review: async () =>
        new Map<string, boolean>([
          [row1.row_id, true],
          [row2.row_id, true],
        ]),
    };

    await ingestRows(
      { items, plan: { stages: [stage] } as any, reviewer, addEvent: async () => {} },
      stage,
      [row1, row2],
      { idField: "row_id" }
    );

    const counts = items.counts("s1");
    // Row 1 accepted, Row 2 dropped as duplicate by platform canonical ID
    expect(counts.accepted).toBe(1);
    expect(counts.duplicates).toBe(1);
  });
});

describe("PR #649 Follow-up: Control Probe Accounting & Generic 1-Probe Limit", () => {
  it("counts 400 control probe in step attempts and enforces generic max 1 probe per step", async () => {
    const { executeTregCall, getStepAttempts, getStepProbes } = await import("../src/functions/shared/tregClient");
    const { createJobCallBudget } = await import("../src/lib/server/callBudget");
    const { EndpointCircuitBreaker } = await import("../src/lib/treg/circuitBreaker");

    const cb = new EndpointCircuitBreaker({ "anyapi.x.search.posts": "working" });
    const budget = createJobCallBudget({ ceilingUsd: 1.0, spentUsd: 0 });
    const stepId = "step_timeline_scan";
    const expectedStepKey = `test_job:${stepId}:1`;

    const originalFetch = globalThis.fetch;
    let fetchCount = 0;
    // Always return 400 for queries, return 200 for control probe
    globalThis.fetch = vi.fn(async (_url: any, opts: any) => {
      fetchCount++;
      const body = opts?.body ? JSON.parse(opts.body) : {};
      if (body.query === "from:test") {
        // Control probe request succeeded
        return new Response(JSON.stringify({ data: { items: [] } }), {
          status: 200,
          headers: { "x-treg-cost-micro": "1000" },
        });
      }
      return new Response(JSON.stringify({ error: "Invalid query syntax" }), {
        status: 400,
        headers: { "x-treg-cost-micro": "0" },
      });
    }) as any;

    try {
      // First call for stepId: fails with 400 -> fires control probe (probe #1)
      const res1 = await executeTregCall({
        endpointId: "anyapi.x.search.posts",
        userId: "test_user",
        jobId: "test_job",
        stepId,
        page: 1,
        callBudget: budget,
        circuitBreaker: cb,
      });

      expect(res1.ok).toBe(false);
      expect(res1.httpStatus).toBe(400);
      expect(fetchCount).toBe(2); // 1 initial + 1 control probe
      // Both the original attempt and the control probe increment step attempts!
      expect(getStepAttempts(budget).get(expectedStepKey)).toBe(2);
      expect(getStepProbes(budget).get(expectedStepKey)).toBe(1);

      // Second call in the same stepId/page: fails with 400
      // Because getStepProbes(budget).get(expectedStepKey) >= 1, NO second control probe fires!
      const res2 = await executeTregCall({
        endpointId: "anyapi.x.search.posts",
        userId: "test_user",
        jobId: "test_job",
        stepId,
        page: 1,
        callBudget: budget,
        circuitBreaker: cb,
      });

      expect(res2.ok).toBe(false);
      expect(res2.httpStatus).toBe(400);
      expect(fetchCount).toBe(3); // 1 extra call only, NO second control probe
      expect(getStepAttempts(budget).get(expectedStepKey)).toBe(3);
      expect(getStepProbes(budget).get(expectedStepKey)).toBe(1); // Still 1 probe
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("Point 3.3 & Point 3.6: Timeline Scan, Budget Guard, Honest Shortfall & R6 Replay", () => {
  it("scoutFallbackAr generates honest Arabic phrasing with exact examinedCount and stage item noun", async () => {
    const { scoutFallbackAr } = await import("../agent/src/llmPlanner/planner");

    // X / Tweets
    const xFinding: any = {
      step: {
        key: "s1",
        title_ar: "تغريدات وزارة الصحة",
        platform: "x",
        capability: "user_posts",
        source: { kind: "account", value: "@SaudiMOH" },
        count: { total: 20 },
      },
      requested: 20,
      found: 0,
      exhausted: true,
      sets: 1,
      examinedCount: 80,
      stopReason: "window_crossed",
    };
    const xFallback = scoutFallbackAr([xFinding], ["@SaudiMOH", "شائعات"]);
    expect(xFallback.question_ar).toContain("جرّبنا البحث في ٨٠ تغريدة من @SaudiMOH على إكس بالشروط التي كتبتها ولم نجد نتائج متطابقة");
    expect(xFallback.question_ar).toContain("تحب نسلّمك الموجود، ولا نوسّع البحث؟");
    expect(xFallback.options_ar[0]).toBe("سلّمني الموجود فقط");
    expect(xFallback.options_ar[1]).toContain("منصات ومصادر أخرى");

    // YouTube / Videos
    const ytFinding: any = {
      step: {
        key: "s2",
        title_ar: "فيديوهات القناة الرسمية",
        platform: "youtube",
        capability: "channel_videos",
        source: { kind: "account", value: "SaudiMOH" },
        count: { total: 50 },
      },
      requested: 50,
      found: 0,
      exhausted: true,
      sets: 1,
      examinedCount: 50,
      stopReason: "window_crossed",
    };
    const ytFallback = scoutFallbackAr([ytFinding], ["SaudiMOH", "فيديوهات"]);
    expect(ytFallback.question_ar).toContain("جرّبنا البحث في ٥٠ فيديو من SaudiMOH على يوتيوب بالشروط التي كتبتها ولم نجد نتائج متطابقة");

    // Facebook / Posts
    const fbFinding: any = {
      step: {
        key: "s3",
        title_ar: "منشورات الصفحة",
        platform: "facebook",
        capability: "page_posts",
        source: { kind: "account", value: "SaudiMOH" },
        count: { total: 30 },
      },
      requested: 30,
      found: 0,
      exhausted: true,
      sets: 1,
      examinedCount: 30,
      stopReason: "window_crossed",
    };
    const fbFallback = scoutFallbackAr([fbFinding], ["SaudiMOH", "منشورات"]);
    expect(fbFallback.question_ar).toContain("جرّبنا البحث في ٣٠ منشورًا من SaudiMOH على فيسبوك بالشروط التي كتبتها ولم نجد نتائج متطابقة");

    // Must-pass A: R6 text (no digits) + step with default total=200 → no «طلبت» and no 200 in fallback sentence
    const r6Finding: any = {
      step: {
        key: "s4",
        title_ar: "تغريدات وزارة الصحة",
        platform: "x",
        capability: "user_posts",
        source: { kind: "account", value: "@SaudiMOH" },
        count: { total: 200 }, // default total, NOT from customer
      },
      requested: 200,
      found: 7,
      exhausted: true,
      sets: 1,
      examinedCount: 200,
      stopReason: "window_crossed",
    };
    // Customer said no number at all (R6 text)
    const r6Fallback = scoutFallbackAr([r6Finding], ["@SaudiMOH", "شائعات"]);
    expect(r6Fallback.question_ar).not.toContain("200");
    expect(r6Fallback.question_ar).not.toContain("٢٠٠");
    expect(r6Fallback.question_ar).not.toContain("طلبت");

    // Must-pass B: customer said «عايز ٥٠» + total=50 → «طلبتها» may appear
    const count50Finding: any = {
      step: {
        key: "s5",
        title_ar: "تغريدات وزارة الصحة",
        platform: "x",
        capability: "user_posts",
        source: { kind: "account", value: "@SaudiMOH" },
        count: { total: 50 }, // matches customer-given count
      },
      requested: 50,
      found: 7,
      exhausted: true,
      sets: 1,
      examinedCount: 50,
      stopReason: "window_crossed",
    };
    const count50Fallback = scoutFallbackAr([count50Finding], ["عايز ٥٠ تغريدة من @SaudiMOH"]);
    expect(count50Fallback.question_ar).toContain("طلبتها");
  });

  it("scoutQuestion rejects model-invented requested count and invented period when customer gave none", async () => {
    const { scoutQuestion } = await import("../agent/src/llmPlanner/planner");
    const u: any = {
      understanding_ar: "جمع تغريدات وزارة الصحة عن الشائعات",
      steps: [],
    };
    const weak: any = [
      {
        step: {
          key: "s1",
          title_ar: "تغريدات وزارة الصحة",
          platform: "x",
          capability: "user_posts",
          source: { kind: "account", value: "@SaudiMOH" },
          count: { total: null }, // Customer gave no count
          period: null, // Customer gave no period
        },
        requested: 200, // Default filled
        found: 0,
        exhausted: true,
        sets: 1,
        examinedCount: 50,
        stopReason: "window_crossed",
      },
    ];
    const input: any = {
      words: ["تغريدات حساب @SaudiMOH عن الشائعات"], // No count, no period in customer text
      request: "",
      scoutAllowed: true,
    };

    // Case 1: Model hallucinates 200, «اللي طلبتهم», and «في آخر سنتين»
    const mockModelHallucinated: any = vi.fn(async () => ({
      input: {
        message_ar: "ومالقيتش ولا تغريدة مطابقة من الـ٢٠٠ اللي طلبتهم في آخر سنتين، تحب نسلّمك الموجود ولا نوسّع؟",
        options_ar: ["سلّمني الموجود فقط", "وسّع البحث إلى مصادر أخرى"],
      },
      costUsd: 0.001,
    }));
    const cost = { usd: 0 };
    const resHallucinated = await scoutQuestion(
      u,
      weak,
      input,
      { model: mockModelHallucinated, log: () => {} },
      cost
    );
    // Must fall back to honest code-built question
    expect(resHallucinated.question_ar).not.toContain("٢٠٠");
    expect(resHallucinated.question_ar).not.toContain("طلبتهم");
    expect(resHallucinated.question_ar).not.toContain("سنتين");
    expect(resHallucinated.question_ar).toContain("جرّبنا البحث في ٥٠ تغريدة من @SaudiMOH على إكس بالشروط التي كتبتها ولم نجد نتائج متطابقة");

    // Case 2: Customer DID give a count: «عايز ٥٠ تغريدة»
    const inputWithCount: any = {
      words: ["عايز ٥٠ تغريدة من حساب @SaudiMOH عن الشائعات"],
      request: "",
      scoutAllowed: true,
    };
    const weakWithCount: any = [
      {
        ...weak[0],
        step: { ...weak[0].step, count: { total: 50 } },
        requested: 50,
        found: 7,
      },
    ];
    const mockModelWithCount: any = vi.fn(async () => ({
      input: {
        message_ar: "بحثنا في الحساب ولقينا ٧ من الـ٥٠ اللي طلبتهم، تحب نسلّمك الـ٧ ولا نوسّع البحث؟",
        options_ar: ["سلّمني الـ٧", "وسّع البحث إلى مصادر أخرى"],
      },
      costUsd: 0.001,
    }));
    const resWithCount = await scoutQuestion(
      u,
      weakWithCount,
      inputWithCount,
      { model: mockModelWithCount, log: () => {} },
      cost
    );
    // Permitted because 50 is in customer messages
    expect(resWithCount.question_ar).toContain("٥٠");
    expect(resWithCount.question_ar).toContain("طلبتهم");

    // Case 3: Customer DID give a period: «في آخر سنتين»
    const inputWithPeriod: any = {
      words: ["تغريدات حساب @SaudiMOH عن الشائعات في آخر سنتين"],
      request: "",
      scoutAllowed: true,
    };
    const mockModelWithPeriod: any = vi.fn(async () => ({
      input: {
        message_ar: "جرّبنا البحث في آخر سنتين من حساب @SaudiMOH ووجدنا ٧، تحب نسلّمك الـ٧؟",
        options_ar: ["سلّمني الـ٧", "وسّع البحث"],
      },
      costUsd: 0.001,
    }));
    const resWithPeriod = await scoutQuestion(
      u,
      weakWithCount,
      inputWithPeriod,
      { model: mockModelWithPeriod, log: () => {} },
      cost
    );
    // Permitted because period was stated by customer
    expect(resWithPeriod.question_ar).toContain("في آخر سنتين");
  });

  it("canAskShortfallQuestion strictly forbids shortfall if unread pages exist within budget", () => {
    // 0 matches found on page 1 of 4 budgeted pages, but source has more: FORBIDDEN
    expect(canAskShortfallQuestion({
      pagesRead: 1,
      maxBudgetedPages: 4,
      hasMore: true,
      onTopicMatches: 0,
    })).toBe(false);

    // 0 matches found after all 4 budgeted pages read: ALLOWED
    expect(canAskShortfallQuestion({
      pagesRead: 4,
      maxBudgetedPages: 4,
      hasMore: true,
      onTopicMatches: 0,
    })).toBe(true);

    // Terminal cursor (no more pages): ALLOWED
    expect(canAskShortfallQuestion({
      pagesRead: 2,
      maxBudgetedPages: 4,
      hasMore: false,
      onTopicMatches: 0,
    })).toBe(true);

    // Matches were found: ALLOWED
    expect(canAskShortfallQuestion({
      pagesRead: 1,
      maxBudgetedPages: 4,
      hasMore: true,
      onTopicMatches: 5,
    })).toBe(true);
  });

  it("replays R6 account case: reads page 2+ when page 1 has 0 matches within call budget", async () => {
    const { planWithLlm } = await import("../agent/src/llmPlanner/planner");
    const { loadTregCatalog } = await import("../src/lib/treg/catalog");

    const cat = loadTregCatalog();
    const timelineEp = cat.byId.get("anyapi.x.user.posts")!;
    let pageProbeCount = 0;
    const probedCursors: string[] = [];

    const mockProbe = vi.fn(async (_endpointId: string, params: Record<string, unknown>) => {
      pageProbeCount++;
      const cursor = params.cursor as string | undefined;
      probedCursors.push(cursor ?? "initial");

      if (!cursor) {
        // Page 1: has more, returns next_cursor cursor_page_2
        return {
          ok: true,
          rows_in_page: 2,
          call_id: "call_page_1",
          items: [{ id: "t1", text: "General announcement" }, { id: "t2", text: "Health tips" }],
          has_more: true,
          next_cursor: "cursor_page_2",
          charge_usd: 0.001,
        };
      } else if (cursor === "cursor_page_2") {
        // Page 2: has more, returns on-topic posts!
        return {
          ok: true,
          rows_in_page: 2,
          call_id: "call_page_2",
          items: [{ id: "t3", text: "نفي شائعة منتشرة حول اللقاح" }, { id: "t4", text: "توضيح شائعة أخرى" }],
          has_more: false,
          next_cursor: null,
          charge_usd: 0.001,
        };
      }
      return {
        ok: true,
        rows_in_page: 0,
        call_id: "call_page_3",
        items: [],
        has_more: false,
        next_cursor: null,
        charge_usd: 0.001,
      };
    });

    const mockReadPage = vi.fn(async (callId: string) => {
      if (callId === "call_page_1") {
        return {
          output: {
            data: {
              tweets: [
                { id: "t1", text: "General announcement", published_at: "2026-11-20T10:00:00Z" },
                { id: "t2", text: "Health tips", published_at: "2026-11-19T10:00:00Z" },
              ],
            },
          },
        };
      }
      if (callId === "call_page_2") {
        return {
          output: {
            data: {
              tweets: [
                { id: "t3", text: "نفي شائعة منتشرة حول اللقاح", published_at: "2026-11-18T10:00:00Z" },
                { id: "t4", text: "توضيح شائعة أخرى", published_at: "2026-11-17T10:00:00Z" },
              ],
            },
          },
        };
      }
      return { output: { data: { tweets: [] } } };
    });

    let judgeCount = 0;
    const mockModel: any = vi.fn(async ({ tool }: any) => {
      if (tool?.name === "request_plan") {
        return {
          input: {
            decision: "plan",
            understanding_ar: "جمع تغريدات وزارة الصحة عن الشائعات",
            steps: [
              {
                key: "s1",
                platform: "x",
                capability: timelineEp.capability,
                source: { kind: "account", value: "@SaudiMOH" },
                topic: "شائعات",
                count: { total: 20 },
                deliver: true,
                title_ar: "تغريدات وزارة الصحة",
              },
            ],
          },
          costUsd: 0.001,
        };
      }
      if (tool?.name === "tool_choice") {
        return {
          input: {
            options: [
              {
                endpoint_id: timelineEp.id,
                params_json: JSON.stringify({ handle: "SaudiMOH", limit: 20 }),
                cursor_input: "cursor",
                more_params_json: [],
              },
            ],
          },
          costUsd: 0.001,
        };
      }
      if (tool?.name === "field_map") {
        return {
          input: {
            fields: { id: ["id"], text: ["text"] },
            extra: [],
          },
          costUsd: 0.001,
        };
      }
      if (tool?.name === "judge_sample") {
        judgeCount++;
        if (judgeCount === 1) {
          // Page 1: 0 matches
          return { input: { matching_indices: [] }, costUsd: 0.001 };
        }
        // Page 2: matches indices 0 and 1
        return { input: { matching_indices: [0, 1] }, costUsd: 0.001 };
      }
      return { input: {}, costUsd: 0.001 };
    });

    const logs: string[] = [];
    const res = await planWithLlm(
      {
        words: ["تغريدات حساب @SaudiMOH عن الشائعات"],
        request: "",
        scoutAllowed: false,
      },
      {
        model: mockModel,
        probe: mockProbe as any,
        readPage: mockReadPage as any,
        catalog: cat,
        access: null,
        today: "2026-11-23",
        log: (msg) => logs.push(msg),
      }
    );

    expect(res.kind).toBe("plan");
    // Verified that it traversed to page 2 because page 1 had 0 matches
    expect(probedCursors).toContain("initial");
    expect(probedCursors).toContain("cursor_page_2");
    expect(pageProbeCount).toBe(2);
    // Total call budget respected (<= 4 calls per step)
    expect(pageProbeCount).toBeLessThanOrEqual(4);

    // Verified that timeline scan log shows stopped reason with accepted count
    const scanLog = logs.find((l) => l.startsWith("llm_planner_timeline_scan"));
    expect(scanLog).toBeDefined();
    expect(scanLog).toContain("accepted=2");
  });
});
