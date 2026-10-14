import { describe, it, expect, vi, beforeEach } from "vitest";
import { calculateBalance } from "../src/lib/supabase/ledger";
import { ChatHandler } from "../src/functions/shared/chatHandler";

describe("Accept-Quote Balance Synchronization, Pagination & Chat Intent Regression Suite", () => {
  describe("Paginated calculateBalance", () => {
    it("sums positive and negative ledger rows accurately for a given user", async () => {
      const mockRows = [
        { delta: 100, user_id: "user-123" },
        { delta: -20, user_id: "user-123" },
        { delta: -6, user_id: "user-123" },
      ];

      const mockClient: any = {
        from: vi.fn(() => ({
          select: vi.fn(() => ({
            eq: vi.fn((col: string, val: string) => ({
              range: vi.fn(async (from: number, to: number) => {
                const filtered = mockRows.filter((r) => r.user_id === val);
                const sliced = filtered.slice(from, to + 1);
                return { data: sliced, error: null };
              }),
            })),
          })),
        })),
      };

      const balance = await calculateBalance(mockClient, "user-123");
      expect(balance).toBe(74);
    });

    it("paginates over 1000 rows in batches without PostgREST 1000-row truncation", async () => {
      // Simulate 2,500 ledger rows of 1 point each
      const totalRows = 2500;
      const allRows = Array.from({ length: totalRows }, (_, i) => ({
        delta: 1,
        user_id: "heavy-user",
      }));

      const rangesCalled: Array<{ from: number; to: number }> = [];

      const mockClient: any = {
        from: vi.fn(() => ({
          select: vi.fn(() => ({
            eq: vi.fn((col: string, val: string) => ({
              range: vi.fn(async (from: number, to: number) => {
                rangesCalled.push({ from, to });
                const userRows = allRows.filter((r) => r.user_id === val);
                const page = userRows.slice(from, to + 1);
                return { data: page, error: null };
              }),
            })),
          })),
        })),
      };

      const balance = await calculateBalance(mockClient, "heavy-user");
      expect(balance).toBe(2500);
      // 2500 rows should require 3 pages: 0-999 (1000), 1000-1999 (1000), 2000-2999 (500)
      expect(rangesCalled.length).toBe(3);
      expect(rangesCalled[0]).toEqual({ from: 0, to: 999 });
      expect(rangesCalled[1]).toEqual({ from: 1000, to: 1999 });
      expect(rangesCalled[2]).toEqual({ from: 2000, to: 2999 });
    });

    it("strictly isolates user balance: never includes other users' rows even if admin client", async () => {
      const mockRows = [
        { delta: 2277, user_id: "other-user" },
        { delta: 50, user_id: "other-user-2" },
        { delta: 0, user_id: "target-user" },
      ];

      const mockClient: any = {
        from: vi.fn(() => ({
          select: vi.fn(() => ({
            eq: vi.fn((col: string, val: string) => ({
              range: vi.fn(async (from: number, to: number) => {
                const filtered = mockRows.filter((r) => r.user_id === val);
                return { data: filtered.slice(from, to + 1), error: null };
              }),
            })),
          })),
        })),
      };

      const balance = await calculateBalance(mockClient, "target-user");
      // Must be strictly 0, not 2277 or 2327
      expect(balance).toBe(0);
    });

    it("falls back gracefully if client mock does not support .range()", async () => {
      const mockRows = [
        { delta: 15, user_id: "simple-user" },
        { delta: 35, user_id: "simple-user" },
      ];

      const mockClient: any = {
        from: vi.fn(() => ({
          select: vi.fn(() => ({
            eq: vi.fn(async (col: string, val: string) => {
              const filtered = mockRows.filter((r) => r.user_id === val);
              return { data: filtered, error: null };
            }),
          })),
        })),
      };

      const balance = await calculateBalance(mockClient, "simple-user");
      expect(balance).toBe(50);
    });
  });

  describe("Balance Synchronization at Accept-Quote Boundary", () => {
    it("accepts quote when server balance is sufficient (50 >= 6)", async () => {
      const userId = "funded-user";
      const ledgerRows = [{ delta: 50, user_id: userId }];

      // Server balance computation
      const mockClient: any = {
        from: vi.fn(() => ({
          select: vi.fn(() => ({
            eq: vi.fn(async (col: string, val: string) => ({
              data: ledgerRows.filter((r) => r.user_id === val),
              error: null,
            })),
          })),
        })),
        rpc: vi.fn(async (fnName: string, params: any) => {
          if (fnName === "accept_quote_atomic") {
            const currentBal = ledgerRows
              .filter((r) => r.user_id === params.p_user_id)
              .reduce((s, r) => s + r.delta, 0);

            if (currentBal < 6) {
              return {
                data: { success: false, error: "insufficient_balance", balance: currentBal },
                error: null,
              };
            }
            ledgerRows.push({ delta: -6, user_id: userId });
            return {
              data: { success: true, balance: currentBal - 6, job_id: "job_xyz" },
              error: null,
            };
          }
          return { data: null, error: null };
        }),
      };

      const initialBalance = await calculateBalance(mockClient, userId);
      expect(initialBalance).toBe(50);

      const rpcResult = await mockClient.rpc("accept_quote_atomic", {
        p_user_id: userId,
        p_quote_id: "q_123",
      });

      expect(rpcResult.data.success).toBe(true);
      expect(rpcResult.data.balance).toBe(44);

      const postAcceptBalance = await calculateBalance(mockClient, userId);
      expect(postAcceptBalance).toBe(44);
    });

    it("rejects quote when server balance is 0 and reports accurate 0-point balance", async () => {
      const userId = "unfunded-owner";
      const allDatabaseRows = [
        { delta: 1000, user_id: "customer-a" },
        { delta: 1277, user_id: "customer-b" },
        // unfunded-owner has 0 rows or net 0
      ];

      const mockClient: any = {
        from: vi.fn(() => ({
          select: vi.fn(() => ({
            eq: vi.fn(async (col: string, val: string) => ({
              data: allDatabaseRows.filter((r) => r.user_id === val),
              error: null,
            })),
          })),
        })),
        rpc: vi.fn(async (fnName: string, params: any) => {
          if (fnName === "accept_quote_atomic") {
            const userBal = allDatabaseRows
              .filter((r) => r.user_id === params.p_user_id)
              .reduce((s, r) => s + r.delta, 0);

            if (userBal < 6) {
              return {
                data: { success: false, error: "insufficient_balance", balance: userBal },
                error: null,
              };
            }
            return { data: { success: true }, error: null };
          }
          return { data: null, error: null };
        }),
      };

      const serverCalculatedBalance = await calculateBalance(mockClient, userId);
      expect(serverCalculatedBalance).toBe(0);

      const rpcResult = await mockClient.rpc("accept_quote_atomic", {
        p_user_id: userId,
        p_quote_id: "q_123",
      });

      expect(rpcResult.data.success).toBe(false);
      expect(rpcResult.data.error).toBe("insufficient_balance");
      expect(rpcResult.data.balance).toBe(0);
      expect(rpcResult.data.balance).toBe(serverCalculatedBalance);
    });
  });

  describe("Chat vs Research Intent Classification", () => {
    let mockSupabase: any;
    let createdMessages: any[];

    beforeEach(() => {
      createdMessages = [];
      mockSupabase = {
        from: vi.fn((table: string) => ({
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              maybeSingle: vi.fn(async () => ({ data: null, error: null })),
              order: vi.fn(() => ({
                limit: vi.fn(async () => ({ data: [], error: null })),
              })),
            })),
          })),
          insert: vi.fn(async (row: any) => {
            createdMessages.push(row);
            return { data: row, error: null };
          }),
          update: vi.fn(() => ({
            eq: vi.fn(async () => ({ data: null, error: null })),
          })),
        })),
      };
    });

    it("returns intent: 'chat' and outputType: 'answer_question' for simple greetings", async () => {
      const handler = new ChatHandler(mockSupabase);
      const res = await handler.handleUserMessage({
        userId: "user-greetings",
        message: "ازيك",
      });

      expect(res.intent).toBe("chat");
      expect(res.outputType).toBe("answer_question");
      expect(res.planQuote).toBeUndefined();
      expect(res.clarificationQuestions).toBeUndefined();
      expect(res.clarificationItems).toBeUndefined();
      expect(res.contentAr.length).toBeGreaterThan(0);
    });

    it("returns intent: 'chat' and outputType: 'answer_question' for 'هاي'", async () => {
      const handler = new ChatHandler(mockSupabase);
      const res = await handler.handleUserMessage({
        userId: "user-greetings",
        message: "هاي",
      });

      expect(res.intent).toBe("chat");
      expect(res.outputType).toBe("answer_question");
      expect(res.planQuote).toBeUndefined();
      expect(res.clarificationQuestions).toBeUndefined();
      expect(res.clarificationItems).toBeUndefined();
    });

    it("returns intent: 'research' with a plan for complete data requests", async () => {
      const handler = new ChatHandler(mockSupabase);
      const res = await handler.handleUserMessage({
        userId: "user-researcher",
        message: "عايز 5 شركات مقاولات في مصر في ملف Excel",
      });

      expect(res.intent).toBe("research");
      expect(res.outputType).toBe("propose_plan");
      expect(res.planQuote).toBeDefined();
      expect(res.planQuote.quotedPoints).toBeGreaterThan(0);
    });
  });
});
