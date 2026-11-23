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
