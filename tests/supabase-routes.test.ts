import { describe, it, expect, vi, beforeEach } from "vitest";
import { acceptQuoteSupabase } from "../src/lib/supabase/quoteAccept";

const authMockState = vi.hoisted(() => ({
  user: null as any,
  authError: null as any,
  adminClient: null as any,
}));

// The old planner path is the ROLLBACK path and these tests cover it: the rollback constant (AGENT_SERVES_CHAT) is pinned to «old path» here. The agent path has its own tests (agent-chat-handler, agent-replay-phase1).
vi.mock("../src/lib/agentMission/constants", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/lib/agentMission/constants")>()), AGENT_SERVES_CHAT: false }));
vi.mock("../src/lib/supabase/server", () => ({
  createServerSideClient: vi.fn(async () => ({
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: authMockState.user },
        error: authMockState.authError,
      })),
    },
  })),
  createAdminClient: vi.fn(() => authMockState.adminClient || {}),
}));

describe("Supabase Route Handlers & Business Rules", () => {
  let mockAdminClient: any;
  let mockQuotes: any[];
  let mockJobs: any[];
  let mockEvents: any[];
  let mockLedger: any[];

  beforeEach(() => {
    mockQuotes = [];
    mockJobs = [];
    mockEvents = [];
    mockLedger = [];

    mockAdminClient = {
      from: vi.fn((table: string) => {
        if (table === "plans_quotes") {
          return {
            select: vi.fn(() => ({
              eq: vi.fn((col: string, val: string) => ({
                single: vi.fn(async () => {
                  const q = mockQuotes.find((item) => item.id === val);
                  return q ? { data: q, error: null } : { data: null, error: new Error("Not found") };
                }),
              })),
            })),
            update: vi.fn((updates: any) => ({
              eq: vi.fn(async (col: string, val: string) => {
                const q = mockQuotes.find((item) => item.id === val);
                if (q) Object.assign(q, updates);
                return { data: q, error: null };
              }),
            })),
          };
        }
        if (table === "jobs") {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                in: vi.fn(async () => {
                  const active = mockJobs.filter((j) => ["queued", "running"].includes(j.status));
                  return { count: active.length, data: active, error: null };
                }),
              })),
            })),
            insert: vi.fn(async (newJob: any) => {
              mockJobs.push(newJob);
              return { data: newJob, error: null };
            }),
          };
        }
        if (table === "job_events") {
          return {
            insert: vi.fn(async (newEvent: any) => {
              mockEvents.push(newEvent);
              return { data: newEvent, error: null };
            }),
          };
        }
        return {};
      }),
      rpc: vi.fn(async (fnName: string, params: any) => {
        if (fnName === "accept_quote_atomic") {
          const q = mockQuotes.find((item) => item.id === params.p_quote_id);
          if (!q) return { data: { success: false, error: "quote_not_found" }, error: null };
          if (q.user_id !== params.p_user_id) return { data: { success: false, error: "quote_user_mismatch" }, error: null };
          if (params.p_expected_quote_hash && q.quote_hash !== params.p_expected_quote_hash) {
            return { data: { success: false, error: "quote_hash_mismatch" }, error: null };
          }
          if (q.status === "accepted") {
            return { data: { success: true, already_accepted: true, quote_id: q.id, job_id: `job_quote_${q.id}`, reserved_credits: q.total_reserved_credits }, error: null };
          }
          if (q.status !== "quoted") return { data: { success: false, error: "invalid_quote_status" }, error: null };
          if (new Date(q.expires_at).getTime() <= Date.now()) return { data: { success: false, error: "quote_expired" }, error: null };
          const activeJobs = mockJobs.filter((j) => ["queued", "running"].includes(j.status) && j.user_id === params.p_user_id);
          if (activeJobs.length >= 2) return { data: { success: false, error: "concurrency_limit_exceeded" }, error: null };
          const currentBal = mockLedger
            .filter((r) => r.user_id === params.p_user_id)
            .reduce((sum, r) => sum + r.delta, 0);
          if (currentBal < q.total_reserved_credits) return { data: { success: false, error: "insufficient_balance", balance: currentBal }, error: null };
          q.status = "accepted";
          const jId = `job_quote_${q.id}`;
          mockJobs.push({ id: jId, user_id: q.user_id, status: "queued", reserved_credits: q.total_reserved_credits });
          mockLedger.push({ id: `res_${jId}`, user_id: q.user_id, delta: -q.total_reserved_credits });
          mockEvents.push({ job_id: jId, user_id: q.user_id, message: "accepted", event_type: "progress" });
          return { data: { success: true, quote_id: q.id, job_id: jId, reserved_credits: q.total_reserved_credits }, error: null };
        }
        if (fnName === "reserve_credits_atomic") {
          const currentBal = mockLedger
            .filter((r) => r.user_id === params.p_user_id)
            .reduce((sum, r) => sum + r.delta, 0);

          if (currentBal < params.p_amount) {
            return {
              data: { success: false, error: "insufficient_balance", balance: currentBal },
              error: null,
            };
          }

          mockLedger.push({
            id: `res_${params.p_job_id}`,
            user_id: params.p_user_id,
            delta: -params.p_amount,
          });

          return {
            data: { success: true, already_reserved: false, balance: currentBal - params.p_amount },
            error: null,
          };
        }
        return { data: null, error: new Error("Unknown RPC") };
      }),
    };
  });

  it("acceptQuoteSupabase rejects if quote is not found", async () => {
    const res = await acceptQuoteSupabase(mockAdminClient, {
      userId: "user-1",
      quoteId: "missing-quote",
    });

    expect(res.success).toBe(false);
    expect(res.statusCode).toBe(404);
  });

  it("acceptQuoteSupabase rejects if quote belongs to another user", async () => {
    mockQuotes.push({
      id: "quote-1",
      user_id: "user-2", // different user
      status: "quoted",
      expires_at: new Date(Date.now() + 60000).toISOString(),
      items: [],
      total_reserved_credits: 50,
    });

    const res = await acceptQuoteSupabase(mockAdminClient, {
      userId: "user-1",
      quoteId: "quote-1",
    });

    expect(res.success).toBe(false);
    expect(res.statusCode).toBe(403);
  });

  it("acceptQuoteSupabase rejects if quote is expired", async () => {
    mockQuotes.push({
      id: "quote-expired",
      user_id: "user-1",
      status: "quoted",
      expires_at: new Date(Date.now() - 60000).toISOString(), // expired
      items: [],
      total_reserved_credits: 50,
    });

    const res = await acceptQuoteSupabase(mockAdminClient, {
      userId: "user-1",
      quoteId: "quote-expired",
    });

    expect(res.success).toBe(false);
    expect(res.statusCode).toBe(410);
  });

  it("acceptQuoteSupabase rejects if user already has 2 active jobs", async () => {
    mockQuotes.push({
      id: "quote-busy",
      user_id: "user-1",
      status: "quoted",
      expires_at: new Date(Date.now() + 60000).toISOString(),
      items: [],
      total_reserved_credits: 50,
    });

    mockJobs.push(
      { id: "j1", user_id: "user-1", status: "running" },
      { id: "j2", user_id: "user-1", status: "queued" }
    );

    const res = await acceptQuoteSupabase(mockAdminClient, {
      userId: "user-1",
      quoteId: "quote-busy",
    });

    expect(res.success).toBe(false);
    expect(res.statusCode).toBe(429);
  });

  it("acceptQuoteSupabase rejects if balance is insufficient", async () => {
    mockQuotes.push({
      id: "quote-expensive",
      user_id: "user-1",
      status: "quoted",
      expires_at: new Date(Date.now() + 60000).toISOString(),
      items: [{ endpointId: "test-ep", unitPricePoints: 10, targetVolumeMin: 10, targetVolumeMax: 10 }],
      total_reserved_credits: 100,
    });

    mockLedger.push({ user_id: "user-1", delta: 20 }); // only 20 points

    const res = await acceptQuoteSupabase(mockAdminClient, {
      userId: "user-1",
      quoteId: "quote-expensive",
    });

    expect(res.success).toBe(false);
    expect(res.statusCode).toBe(402);
  });

  it("acceptQuoteSupabase succeeds atomically, creates job, and creates event", async () => {
    mockQuotes.push({
      id: "quote-valid",
      user_id: "user-1",
      status: "quoted",
      expires_at: new Date(Date.now() + 60000).toISOString(),
      items: [{ endpointId: "fb-comments", unitPricePoints: 1.2, targetVolumeMin: 50, targetVolumeMax: 50 }],
      total_reserved_credits: 60,
    });

    mockLedger.push({ user_id: "user-1", delta: 100 }); // 100 points

    const res = await acceptQuoteSupabase(mockAdminClient, {
      userId: "user-1",
      quoteId: "quote-valid",
    });

    expect(res.success).toBe(true);
    expect(res.jobId).toMatch(/^job_/);
    expect(res.reservedCredits).toBe(60);

    // Verify quote updated to accepted
    const q = mockQuotes.find((item) => item.id === "quote-valid");
    expect(q.status).toBe("accepted");

    // Verify job created with status queued
    expect(mockJobs).toHaveLength(1);
    expect(mockJobs[0].status).toBe("queued");
    expect(mockJobs[0].reserved_credits).toBe(60);

    // Verify job event created
    expect(mockEvents).toHaveLength(1);
    expect(mockEvents[0].event_type).toBe("progress");
  });

  it("acceptQuoteSupabase binds quote hash with outputFormats and rejects tampering", async () => {
    const { computePlanHash } = await import("../src/functions/shared/planManager");
    const items = [{ capabilitySlug: "fb-comments", params: {}, targetVolumeMin: 10, targetVolumeMax: 10 }];
    
    // Hash changes when output formats differ
    const hashA = computePlanHash(items, ["csv", "xlsx"]);
    const hashB = computePlanHash(items, ["pdf"]);
    expect(hashA).not.toBe(hashB);

    mockQuotes.push({
      id: "quote-formats",
      user_id: "user-1",
      status: "quoted",
      expires_at: new Date(Date.now() + 60000).toISOString(),
      items,
      output_formats: ["csv", "xlsx"],
      quote_hash: hashA,
      total_reserved_credits: 50,
    });

    // Mismatched expectedPlanHash is rejected with 400
    const tamperRes = await acceptQuoteSupabase(mockAdminClient, {
      userId: "user-1",
      quoteId: "quote-formats",
      expectedPlanHash: hashB, // Tampered hash
    });

    expect(tamperRes.success).toBe(false);
    expect(tamperRes.statusCode).toBe(400);
    expect(tamperRes.errorAr).toContain("تغيرت تفاصيل الخطة");
  });

  it("acceptQuoteSupabase rejects double accept with 409 conflict", async () => {
    mockQuotes.push({
      id: "quote-double",
      user_id: "user-1",
      status: "accepted", // Already accepted
      expires_at: new Date(Date.now() + 60000).toISOString(),
      items: [],
      total_reserved_credits: 50,
    });

    const res = await acceptQuoteSupabase(mockAdminClient, {
      userId: "user-1",
      quoteId: "quote-double",
    });

    expect(res.success).toBe(false);
    expect(res.statusCode).toBe(409);
    expect(res.errorAr).toBe("تم بدء تنفيذ هذا العرض مسبقاً ولا يمكن تكراره.");
  });

  it("verifies 15% buffer on reserve only, and settlement charge capped at reserve", async () => {
    const { calculateQuote, calculateFinalSettlement } = await import("../src/lib/supabase/quotes");
    
    // 15% buffer applied strictly to reserved credits
    const quoteCalc = calculateQuote(100, 0.05, 500);

    // Reserved credits has 15% buffer: ceil(rawPoints * 1.15)
    expect(quoteCalc.quotedPoints).toBeGreaterThanOrEqual(quoteCalc.rawPoints);
    expect(quoteCalc.quotedPoints).toBe(Math.ceil(quoteCalc.rawPoints * 1.15));

    // Settlement: charge = ceil(delivered * unitPrice), strictly capped at reserved
    const unitPrice = 0.5; // points per unit
    const reservedCredits = 40;
    
    // Normal delivery: 50 delivered * 0.5 = 25 points
    const normalSettlement = calculateFinalSettlement(50, unitPrice, reservedCredits);
    expect(normalSettlement.chargePoints).toBe(25);
    expect(normalSettlement.refundPoints).toBe(15);

    // Over-delivery capped at reserve: 100 delivered * 0.5 = 50 points, capped at 40
    const overSettlement = calculateFinalSettlement(100, unitPrice, reservedCredits);
    expect(overSettlement.chargePoints).toBe(40);
    expect(overSettlement.refundPoints).toBe(0);
  });

  it("acceptQuoteSupabase returns 402 with Arabic-Indic numerals on insufficient balance", async () => {
    mockQuotes.push({
      id: "quote-indic-test",
      user_id: "user-1",
      status: "quoted",
      expires_at: new Date(Date.now() + 60000).toISOString(),
      items: [{ endpointId: "test-ep", unitPricePoints: 10, targetVolumeMin: 10, targetVolumeMax: 10 }],
      total_reserved_credits: 100,
    });

    mockLedger.push({ user_id: "user-1", delta: 45 }); // 45 points -> ٤٥ in Arabic-Indic

    const res = await acceptQuoteSupabase(mockAdminClient, {
      userId: "user-1",
      quoteId: "quote-indic-test",
    });

    expect(res.success).toBe(false);
    expect(res.statusCode).toBe(402);
    expect(res.errorAr).toContain("٤٥");
    expect(res.errorAr).not.toMatch(/[0-9]/); // No Western digits in user balance display
  });

  it("acceptQuoteSupabase never leaks database rpc error or SQL text", async () => {
    const brokenClient = {
      ...mockAdminClient,
      rpc: vi.fn(async () => {
        return { data: null, error: new Error("relation public.credit_ledger does not exist at line 42") };
      }),
    };

    const res = await acceptQuoteSupabase(brokenClient, {
      userId: "user-1",
      quoteId: "quote-any",
      expectedPlanHash: "a".repeat(64),
    });

    expect(res.success).toBe(false);
    expect(res.statusCode).toBe(500);
    expect(res.errorAr).not.toContain("relation");
    expect(res.errorAr).not.toContain("credit_ledger");
    expect(res.errorAr).not.toContain("line 42");
    expect(res.errorAr).toContain("حدث خطأ أثناء معالجة اعتماد العرض");
  });
});

describe("accept-quote Route Handler (POST /api/chat/accept-quote)", () => {
  it("rejects unauthenticated requests with 401", async () => {
    const { POST } = await import("../src/app/api/chat/accept-quote/route");
    const { NextRequest } = await import("next/server");

    authMockState.user = null;
    authMockState.authError = new Error("No session");

    const req = new NextRequest("http://localhost:3000/api/chat/accept-quote", {
      method: "POST",
      body: JSON.stringify({ quoteId: "q-1" }),
    });

    const res = await POST(req);
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toContain("غير مصرح");
  });

  it("rejects unverified email with 403 (Phase A guardrail preserved)", async () => {
    const { POST } = await import("../src/app/api/chat/accept-quote/route");
    const { NextRequest } = await import("next/server");

    authMockState.user = {
      id: "user-unverified",
      email: "unverified@example.com",
      email_confirmed_at: null,
      user_metadata: { email_verified: false },
    };
    authMockState.authError = null;

    const req = new NextRequest("http://localhost:3000/api/chat/accept-quote", {
      method: "POST",
      body: JSON.stringify({ quoteId: "q-1" }),
    });

    const res = await POST(req);
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toBe("فعّل بريدك الإلكتروني أولًا لبدء البحث.");
  });

  it("does not accept a quote unless the explicit plan approval action is present", async () => {
    const { POST } = await import("../src/app/api/chat/accept-quote/route");
    const { NextRequest } = await import("next/server");
    authMockState.user = {
      id: "user-verified-1",
      email: "verified@example.com",
      email_confirmed_at: "2026-10-12T00:00:00Z",
      user_metadata: { email_verified: true },
    };
    authMockState.authError = null;

    const req = new NextRequest("http://localhost:3000/api/chat/accept-quote", {
      method: "POST",
      body: JSON.stringify({ quoteId: "q-1" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ success: false, error: "اضغط زر الموافقة على الخطة لبدء البحث." });
  });

  it("A1 Safety Guard: refuses to silently reserve credits or start fake work when TREG_LIVE is disabled", async () => {
    const { POST } = await import("../src/app/api/chat/accept-quote/route");
    const { NextRequest } = await import("next/server");

    const prevLive = process.env.TREG_LIVE;
    const prevMock = process.env.ENABLE_MOCK_PROVIDER;
    try {
      delete process.env.TREG_LIVE;
      delete process.env.ENABLE_MOCK_PROVIDER;

      authMockState.user = {
        id: "user-verified-1",
        email: "verified@example.com",
        email_confirmed_at: "2026-10-12T00:00:00Z",
        user_metadata: { email_verified: true },
      };
      authMockState.authError = null;

      const req = new NextRequest("http://localhost:3000/api/chat/accept-quote", {
        method: "POST",
        body: JSON.stringify({ quoteId: "q-1", explicitApproval: true }),
      });

      const res = await POST(req);
      expect(res.status).toBe(503);
      const data = await res.json();
      expect(data.success).toBe(false);
      expect(data.error).toContain("لم يتم حجز أو خصم أي نقاط");
    } finally {
      if (prevLive === undefined) delete process.env.TREG_LIVE;
      else process.env.TREG_LIVE = prevLive;
      if (prevMock === undefined) delete process.env.ENABLE_MOCK_PROVIDER;
      else process.env.ENABLE_MOCK_PROVIDER = prevMock;
    }
  });
});

describe("Top-up Approval Atomic Logic (approves twice, credits once)", () => {
  it("approving twice credits once and never duplicates points", async () => {
    const mockLedger: any[] = [];
    const mockTopups: any[] = [
      {
        id: "tp-race-1",
        user_id: "user-topup-test",
        amount_egp: 100,
        status: "pending",
        reference: "ref-12345",
      },
    ];

    // Simulated atomic function logic
    async function simulateApproveTopupAtomic(topupId: string, confirmedAmount?: number) {
      const topup = mockTopups.find((t) => t.id === topupId);
      if (!topup) return { success: false, error: "topup_not_found" };

      if (topup.status === "approved") {
        const bal = mockLedger.filter((l) => l.user_id === topup.user_id).reduce((s, l) => s + l.delta, 0);
        return { success: true, already_approved: true, credits: topup.credits, balance: bal };
      }

      if (topup.status !== "pending") {
        return { success: false, error: "invalid_status" };
      }

      const effectiveAmount = confirmedAmount || topup.amount_egp;
      const creditValueEgp = 0.1;
      const credits = Math.floor(effectiveAmount / creditValueEgp);
      const ledgerId = `top_${topupId}`;

      const existingLedger = mockLedger.find((l) => l.id === ledgerId);
      if (existingLedger) {
        if (existingLedger.user_id !== topup.user_id || existingLedger.delta !== credits) {
          throw new Error("ledger_conflict");
        }
      } else {
        mockLedger.push({
          id: ledgerId,
          user_id: topup.user_id,
          delta: credits,
          type: "topup",
        });
      }

      topup.status = "approved";
      topup.credits = credits;

      const newBal = mockLedger.filter((l) => l.user_id === topup.user_id).reduce((s, l) => s + l.delta, 0);
      return { success: true, already_approved: false, credits, balance: newBal };
    }

    // First approval: grants 1000 credits
    const firstRes = await simulateApproveTopupAtomic("tp-race-1");
    expect(firstRes.success).toBe(true);
    expect(firstRes.already_approved).toBe(false);
    expect(firstRes.credits).toBe(1000);
    expect(firstRes.balance).toBe(1000);

    // Second approval retry: returns already_approved, zero extra credits
    const secondRes = await simulateApproveTopupAtomic("tp-race-1");
    expect(secondRes.success).toBe(true);
    expect(secondRes.already_approved).toBe(true);
    expect(secondRes.balance).toBe(1000);

    // Verify ledger has strictly 1 entry
    const matchingLedger = mockLedger.filter((l) => l.id === "top_tp-race-1");
    expect(matchingLedger).toHaveLength(1);
    expect(matchingLedger[0].delta).toBe(1000);
  });
});

describe("Step D: POST /api/chat on Preview with Supabase Admin Client & Structured Error Logging", () => {
  it("succeeds end-to-end when only the 6 production/preview env vars are set and createAdminClient returns a pure Supabase (.from) client", async () => {
    const { POST } = await import("../src/app/api/chat/route");
    const { NextRequest } = await import("next/server");

    const conversationsTable: any[] = [];
    const messagesTable: any[] = [];
    const llmUsageTable: any[] = [];
    const providerCostsTable: any[] = [];

    const pureSupabaseClient = {
      from: vi.fn((table: string) => {
        if (table === "llm_usage") {
          return {
            select: vi.fn(() => ({
              gte: vi.fn(async () => ({ data: llmUsageTable, error: null })),
            })),
            insert: vi.fn(async (row: any) => {
              llmUsageTable.push(row);
              return { data: row, error: null };
            }),
          };
        }
        if (table === "messages") {
          return {
            select: vi.fn((_cols?: string, opts?: any) => {
              if (opts?.head) {
                return {
                  eq: vi.fn(() => ({
                    eq: vi.fn(() => ({
                      gte: vi.fn(async () => ({ count: 0, error: null })),
                    })),
                  })),
                };
              }
              return {
                eq: vi.fn((_col: string, convId: string) => ({
                  order: vi.fn(() => ({
                    limit: vi.fn(async () => ({
                      data: messagesTable.filter((m) => m.conversation_id === convId),
                      error: null,
                    })),
                  })),
                })),
              };
            }),
            insert: vi.fn(async (row: any) => {
              messagesTable.push({ ...row });
              return { data: row, error: null };
            }),
            update: vi.fn((patch: any) => ({
              eq: vi.fn(async (_col: string, id: string) => {
                const target = messagesTable.find((m) => m.id === id);
                if (target) Object.assign(target, patch);
                return { data: target, error: null };
              }),
            })),
          };
        }
        if (table === "conversations") {
          return {
            insert: vi.fn(async (row: any) => {
              conversationsTable.push({ ...row });
              return { data: row, error: null };
            }),
            select: vi.fn(() => ({
              eq: vi.fn((_col: string, id: string) => ({
                maybeSingle: vi.fn(async () => ({
                  data: conversationsTable.find((c) => c.id === id) || null,
                  error: null,
                })),
              })),
            })),
            update: vi.fn((patch: any) => ({
              eq: vi.fn(async (_col: string, id: string) => {
                const target = conversationsTable.find((c) => c.id === id);
                if (target) Object.assign(target, patch);
                return { data: target, error: null };
              }),
            })),
          };
        }
        if (table === "credit_ledger") {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(async () => ({ data: [{ delta: 250 }], error: null })),
            })),
          };
        }
        if (table === "profiles") {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                maybeSingle: vi.fn(async () => ({
                  data: { id: "user-preview-1", name: "مستخدم تجريبي" },
                  error: null,
                })),
              })),
            })),
          };
        }
        if (table === "capability_registry") {
          return {
            select: vi.fn(() => {
              const chain: any = Promise.resolve({ data: [], error: null });
              chain.eq = vi.fn(async () => ({ data: [], error: null }));
              return chain;
            }),
          };
        }
        if (table === "provider_costs") {
          return {
            select: vi.fn(() => ({
              gte: vi.fn(async () => ({ data: providerCostsTable, error: null })),
            })),
            insert: vi.fn(async (row: any) => {
              providerCostsTable.push(row);
              return { data: row, error: null };
            }),
          };
        }
        return {
          select: vi.fn(async () => ({ data: [], error: null })),
          insert: vi.fn(async () => ({ data: null, error: null })),
          update: vi.fn(() => ({ eq: vi.fn(async () => ({ data: null, error: null })) })),
        };
      }),
    };

    authMockState.user = {
      id: "user-preview-1",
      email: "preview@diger.tech",
      email_confirmed_at: "2026-10-13T00:00:00Z",
      user_metadata: { email_verified: true },
    };
    authMockState.authError = null;
    authMockState.adminClient = pureSupabaseClient;

    const req = new NextRequest("http://localhost:3000/api/chat", {
      method: "POST",
      body: JSON.stringify({ message: "أهلاً، ما هي خدمات ديجر؟" }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.requestId).toMatch(/^req_/);
    expect(typeof body.contentAr).toBe("string");
    expect(body.contentAr.length).toBeGreaterThan(0);
    expect(conversationsTable.length).toBe(1);
    expect(messagesTable.length).toBe(2);
  });

  it("logs [chat:request_failed] with requestId, step, and safe reason code when a DB step fails", async () => {
    const { POST } = await import("../src/app/api/chat/route");
    const { NextRequest } = await import("next/server");

    const failingSupabaseClient = {
      from: vi.fn((table: string) => {
        if (table === "llm_usage") {
          return {
            select: vi.fn(() => ({
              gte: vi.fn(async () => ({ data: [], error: null })),
            })),
          };
        }
        if (table === "messages") {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                eq: vi.fn(() => ({
                  gte: vi.fn(async () => ({ count: 0, error: null })),
                })),
              })),
            })),
          };
        }
        if (table === "conversations") {
          return {
            insert: vi.fn(async () => ({
              data: null,
              error: { code: "23503", message: "foreign key violation on user_id" },
            })),
          };
        }
        return {};
      }),
    };

    authMockState.user = {
      id: "user-preview-err",
      email: "preview-err@diger.tech",
      email_confirmed_at: "2026-10-13T00:00:00Z",
      user_metadata: { email_verified: true },
    };
    authMockState.authError = null;
    authMockState.adminClient = failingSupabaseClient;

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const req = new NextRequest("http://localhost:3000/api/chat", {
        method: "POST",
        body: JSON.stringify({ message: "اختبار خطأ" }),
      });

      const res = await POST(req);
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.requestId).toMatch(/^req_/);
      expect(body.step).toBe("conversation_init");
      expect(body.reason).toBe("23503");
      expect(body.error).toBe("حدث خطأ أثناء معالجة المحادثة. يرجى المحاولة مرة أخرى.");
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringMatching(/^\[chat:request_failed\] requestId=req_[0-9a-f-]+ step=conversation_init reason=23503$/),
      );
    } finally {
      errSpy.mockRestore();
      authMockState.adminClient = null;
    }
  });
});




