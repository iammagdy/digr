import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  calculateBalance,
  reserveCreditsAtomic,
  releaseCredits,
  releaseReservation,
  chargeCredits,
  completeJobWithRelFirst,
  applyTopup,
} from "../src/lib/supabase/ledger";
import { createQuoteRecord } from "../src/lib/supabase/quotes";
import { acceptQuoteSupabase } from "../src/lib/supabase/quoteAccept";
import crypto from "crypto";


describe("Supabase Ledger DAL & Invariants", () => {
  let mockSupabase: any;
  let storedLedgerRows: any[];

  beforeEach(() => {
    storedLedgerRows = [];

    mockSupabase = {
      from: vi.fn((table: string) => {
        if (table === "credit_ledger") {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(async (col: string, val: string) => {
                const matched = storedLedgerRows.filter((r) => r.user_id === val);
                return { data: matched, error: null };
              }),
            })),
            insert: vi.fn((newRow: any) => ({
              select: vi.fn(() => ({
                single: vi.fn(async () => {
                  const duplicate = storedLedgerRows.find((r) => r.id === newRow.id);
                  if (duplicate) {
                    const err: any = new Error("duplicate key value violates unique constraint");
                    err.code = "23505";
                    return { data: null, error: err };
                  }
                  storedLedgerRows.push(newRow);
                  return { data: newRow, error: null };
                }),
              })),
            })),
          };
        }
        if (table === "plans_quotes") {
          return {
            insert: vi.fn((newQuote: any) => ({
              select: vi.fn(() => ({
                single: vi.fn(async () => {
                  return { data: newQuote, error: null };
                }),
              })),
            })),
          };
        }
        return {};
      }),
      rpc: vi.fn(async (fnName: string, params: any) => {
        if (fnName === "reserve_credits_atomic") {
          const { p_user_id, p_job_id, p_amount } = params;
          const resId = `res_${p_job_id}`;
          const currentBal = storedLedgerRows
            .filter((r) => r.user_id === p_user_id)
            .reduce((sum, r) => sum + r.delta, 0);

          if (storedLedgerRows.some((r) => r.id === resId)) {
            return {
              data: { success: true, already_reserved: true, balance: currentBal },
              error: null,
            };
          }

          if (currentBal < p_amount) {
            return {
              data: { success: false, error: "insufficient_balance", balance: currentBal },
              error: null,
            };
          }

          storedLedgerRows.push({
            id: resId,
            user_id: p_user_id,
            delta: -p_amount,
            type: "reserve",
            job_id: p_job_id,
          });

          return {
            data: { success: true, already_reserved: false, balance: currentBal - p_amount },
            error: null,
          };
        }
        return { data: null, error: new Error("Unknown RPC") };
      }),
    };
  });

  it("calculates user balance across all ledger rows", async () => {
    storedLedgerRows.push(
      { id: "top_1", user_id: "user-1", delta: 100, type: "topup" },
      { id: "res_1", user_id: "user-1", delta: -40, type: "reserve" },
      { id: "rel_1", user_id: "user-1", delta: 40, type: "release" },
      { id: "chg_1", user_id: "user-1", delta: -30, type: "charge" }
    );

    const balance = await calculateBalance(mockSupabase, "user-1");
    expect(balance).toBe(70);
  });

  it("calls reserve_credits_atomic with deterministic ID and balance lock", async () => {
    storedLedgerRows.push({ id: "grt_1", user_id: "user-1", delta: 50, type: "grant" });

    const res = await reserveCreditsAtomic(mockSupabase, "user-1", "job-100", 30);
    expect(res.success).toBe(true);
    expect(res.already_reserved).toBe(false);
    expect(res.balance).toBe(20);

    const row = storedLedgerRows.find((r) => r.id === "res_job-100");
    expect(row).toBeDefined();
    expect(row.delta).toBe(-30);
  });

  it("reserve_credits_atomic returns already_reserved for idempotent calls", async () => {
    storedLedgerRows.push({ id: "grt_1", user_id: "user-1", delta: 50, type: "grant" });

    await reserveCreditsAtomic(mockSupabase, "user-1", "job-100", 30);
    const retry = await reserveCreditsAtomic(mockSupabase, "user-1", "job-100", 30);

    expect(retry.success).toBe(true);
    expect(retry.already_reserved).toBe(true);
    expect(retry.balance).toBe(20);
    // Exactly one reservation row exists
    const matching = storedLedgerRows.filter((r) => r.id === "res_job-100");
    expect(matching).toHaveLength(1);
  });

  it("releaseCredits creates deterministic rel_<jobId> with positive delta", async () => {
    await releaseCredits(mockSupabase, "user-1", "job-200", 25);
    const row = storedLedgerRows.find((r) => r.id === "rel_job-200");
    expect(row).toBeDefined();
    expect(row.delta).toBe(25);
    expect(row.type).toBe("release");
  });

  it("releaseReservation handles 23505 duplicate key idempotently without error", async () => {
    const res1 = await releaseReservation(mockSupabase, "user-1", "job-300", 15);
    expect(res1.released).toBe(true);
    expect(res1.alreadyReleased).toBe(false);

    const res2 = await releaseReservation(mockSupabase, "user-1", "job-300", 15);
    expect(res2.released).toBe(false);
    expect(res2.alreadyReleased).toBe(true);
  });

  it("chargeCredits caps final charged credits at reservedCredits", async () => {
    // Attempting to charge 50 when reservedCredits is 40
    await chargeCredits(mockSupabase, "user-1", "job-400", 50, 40);
    const row = storedLedgerRows.find((r) => r.id === "chg_job-400");
    expect(row).toBeDefined();
    expect(row.delta).toBe(-40); // Strictly capped
  });

  it("completeJobWithRelFirst follows release-first order and charges delivered units", async () => {
    const res = await completeJobWithRelFirst(mockSupabase, "user-1", "job-500", 60, 45);
    expect(res.released).toBe(true);
    expect(res.charged).toBe(true);
    expect(res.finalCharged).toBe(45);

    const relRow = storedLedgerRows.find((r) => r.id === "rel_job-500");
    const chgRow = storedLedgerRows.find((r) => r.id === "chg_job-500");
    expect(relRow.delta).toBe(60);
    expect(chgRow.delta).toBe(-45);
  });

  it("applyTopup creates deterministic top_<topupId>", async () => {
    await applyTopup(mockSupabase, "user-1", "tp-999", 500);
    const row = storedLedgerRows.find((r) => r.id === "top_tp-999");
    expect(row).toBeDefined();
    expect(row.delta).toBe(500);
    expect(row.type).toBe("topup");
  });

  it("createQuoteRecord creates quote record in plans_quotes with quote_hash and 30m expiry", async () => {
    const items = [{ capabilitySlug: "fb-comments", targetVolumeMax: 100, unitCostUsd: 0.05 }];
    const quote = await createQuoteRecord(mockSupabase, {
      userId: "user-1",
      items,
      totalReservedCredits: 115,
    });

    expect(quote.id).toMatch(/^quote_/);
    expect(quote.status).toBe("quoted");
    expect(quote.total_reserved_credits).toBe(115);
    expect(quote.quote_hash).toBeDefined();
    expect(new Date(quote.expires_at).getTime()).toBeGreaterThan(Date.now());
  });

  describe("acceptQuoteSupabase strict validations", () => {
    let mockClient: any;
    let quoteStore: Record<string, any>;
    let jobsStore: any[];
    let reservedCalls: any[];

    beforeEach(() => {
      quoteStore = {};
      jobsStore = [];
      reservedCalls = [];

      mockClient = {
        from: vi.fn((table: string) => {
          if (table === "plans_quotes") {
            return {
              select: vi.fn(() => ({
                eq: vi.fn((col: string, val: string) => ({
                  single: vi.fn(async () => {
                    const found = quoteStore[val];
                    return { data: found || null, error: found ? null : { message: "not found" } };
                  }),
                })),
              })),
              update: vi.fn((data: any) => ({
                eq: vi.fn(async (col: string, val: string) => {
                  if (quoteStore[val]) quoteStore[val] = { ...quoteStore[val], ...data };
                  return { data: null, error: null };
                }),
              })),
            };
          }
          if (table === "jobs") {
            return {
              select: vi.fn(() => ({
                eq: vi.fn(() => ({
                  in: vi.fn(async () => ({ count: 0, error: null })),
                })),
              })),
              insert: vi.fn(async (job: any) => {
                jobsStore.push(job);
                return { data: job, error: null };
              }),
            };
          }
          if (table === "job_events") {
            return {
              insert: vi.fn(async () => ({ data: null, error: null })),
            };
          }
          return {};
        }),
        rpc: vi.fn(async (fnName: string, params: any) => {
          if (fnName === "reserve_credits_atomic") {
            reservedCalls.push(params);
            return { data: { success: true, balance: 100 }, error: null };
          }
          return { data: null, error: null };
        }),
      };
    });

    it("rejects and reserves NOTHING if unitPricePoints is missing from the quote item", async () => {
      const quoteId = "quote-missing-price";
      const items = [{ capabilitySlug: "tiktok-profile", targetVolumeMin: 1, targetVolumeMax: 10 }]; // No unitPricePoints!
      const quoteHash = crypto.createHash("sha256").update(JSON.stringify({ items, outputFormats: ["xlsx"] })).digest("hex");

      quoteStore[quoteId] = {
        id: quoteId,
        user_id: "user-1",
        status: "quoted",
        items,
        total_reserved_credits: 20,
        quote_hash: quoteHash,
        output_formats: ["xlsx"],
        expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      };

      const result = await acceptQuoteSupabase(mockClient, {
        userId: "user-1",
        quoteId,
      });

      expect(result.success).toBe(false);
      expect(result.statusCode).toBe(400);
      expect(result.errorAr).toContain("سعر الوحدة غير محدد");
      expect(reservedCalls.length).toBe(0); // ZERO reservations!
      expect(jobsStore.length).toBe(0); // ZERO jobs created!
    });

    it("rejects and reserves NOTHING if quote has multiple items (strictly limits to 1 item)", async () => {
      const quoteId = "quote-multi-items";
      const items = [
        { capabilitySlug: "tiktok-profile", unitPricePoints: 2, targetVolumeMin: 1, targetVolumeMax: 10 },
        { capabilitySlug: "facebook-comments", unitPricePoints: 3, targetVolumeMin: 1, targetVolumeMax: 20 },
      ];
      const quoteHash = crypto.createHash("sha256").update(JSON.stringify({ items, outputFormats: ["xlsx"] })).digest("hex");

      quoteStore[quoteId] = {
        id: quoteId,
        user_id: "user-1",
        status: "quoted",
        items,
        total_reserved_credits: 80,
        quote_hash: quoteHash,
        output_formats: ["xlsx"],
        expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      };

      const result = await acceptQuoteSupabase(mockClient, {
        userId: "user-1",
        quoteId,
      });

      expect(result.success).toBe(false);
      expect(result.statusCode).toBe(400);
      expect(result.errorAr).toContain("قدرة بحثية واحدة لكل طلب");
      expect(reservedCalls.length).toBe(0); // ZERO reservations!
      expect(jobsStore.length).toBe(0);
    });

    it("accepts valid single-item quote with unitPricePoints and writes unit_price into jobs", async () => {
      const quoteId = "quote-valid";
      const items = [{ capabilitySlug: "tiktok-profile", unitPricePoints: 2.5, targetVolumeMin: 1, targetVolumeMax: 10 }];
      const quoteHash = crypto.createHash("sha256").update(JSON.stringify({ items, outputFormats: ["xlsx"] })).digest("hex");

      quoteStore[quoteId] = {
        id: quoteId,
        user_id: "user-1",
        status: "quoted",
        items,
        total_reserved_credits: 25,
        quote_hash: quoteHash,
        output_formats: ["xlsx"],
        expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      };

      const result = await acceptQuoteSupabase(mockClient, {
        userId: "user-1",
        quoteId,
      });

      expect(result.success).toBe(true);
      expect(reservedCalls.length).toBe(1);
      expect(reservedCalls[0].p_amount).toBe(25);
      expect(jobsStore.length).toBe(1);
      expect(jobsStore[0].unit_price).toBe(2.5); // Exact unit price without buffer!
    });
  });
});

