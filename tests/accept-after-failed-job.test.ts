import { AGENT_CAPABILITY_SLUG } from "../src/lib/agentMission/constants";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAdminClient } from "../src/lib/supabase/server";
import { acceptQuoteSupabase } from "../src/lib/supabase/quoteAccept";

// The legacy DAL is exercised directly against a stand-in for its atomic SQL boundary.
const state = vi.hoisted(() => ({
  quotes: [] as any[],
  jobs: [] as any[],
  ledger: [] as any[],
}));

vi.mock("../src/lib/supabase/server", () => ({
  createAdminClient: vi.fn(() => ({
    from: (table: string) => {
      if (table === "plans_quotes") {
        return {
          select: () => ({
            eq: (_c: string, id: string) => {
              const row = state.quotes.find((q) => q.id === id) ?? null;
              return { single: async () => (row ? { data: row, error: null } : { data: null, error: new Error("x") }), maybeSingle: async () => ({ data: row, error: null }) };
            },
          }),
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    },
    rpc: async (name: string, args: any) => {
      if (name !== "accept_quote_atomic") return { data: { success: true }, error: null };
      const q = state.quotes.find((item) => item.id === args.p_quote_id);
      if (!q) return { data: { success: false, error: "quote_not_found" }, error: null };
      if (q.user_id !== args.p_user_id) return { data: { success: false, error: "quote_user_mismatch" }, error: null };
      if (q.quote_hash !== args.p_expected_quote_hash) return { data: { success: false, error: "quote_hash_mismatch" }, error: null };
      const jobId = `job_quote_${q.id}`;
      if (q.status === "accepted") return { data: { success: true, already_accepted: true, quote_id: q.id, job_id: jobId, reserved_credits: q.total_reserved_credits }, error: null };
      if (q.status !== "quoted") return { data: { success: false, error: "invalid_quote_status", status: q.status }, error: null };
      if (new Date(q.expires_at).getTime() <= Date.now()) return { data: { success: false, error: "quote_expired" }, error: null };
      const active = state.jobs.filter((j) => j.user_id === q.user_id && ["queued", "running"].includes(j.status)).length;
      if (active >= 2) return { data: { success: false, error: "concurrency_limit" }, error: null };
      state.ledger.push({ id: `res_${jobId}`, user_id: q.user_id, delta: -q.total_reserved_credits, type: "reserve", job_id: jobId });
      state.jobs.push({ id: jobId, user_id: q.user_id, status: "queued", reserved_credits: q.total_reserved_credits });
      q.status = "accepted";
      return { data: { success: true, already_accepted: false, quote_id: q.id, job_id: jobId, reserved_credits: q.total_reserved_credits }, error: null };
    },
  })),
}));

const HASH = "a".repeat(64);
const future = () => new Date(Date.now() + 20 * 60_000).toISOString();
const item = { capabilitySlug: "social-tiktok-comments", endpointId: AGENT_CAPABILITY_SLUG, unitPricePoints: 6, targetVolumeMin: 1, targetVolumeMax: 30, unitCostUsd: 0.001, params: { query: "كرة القدم" } };

async function approve(quoteId: string, userId = "user_1") {
  const result = await acceptQuoteSupabase(createAdminClient(), { userId, quoteId, expectedPlanHash: HASH });
  return { status: result.statusCode ?? 200, json: { ...result, error: result.errorAr } };
}

describe("approving a new quote after a failed, fully released job in the same conversation", () => {
  const env = { ...process.env };
  beforeEach(() => {
    process.env.ENABLE_MOCK_PROVIDER = "true";
    (process.env as any).NODE_ENV = "test";
    state.quotes = [
      { id: "q_failed", user_id: "user_1", status: "accepted", quote_hash: HASH, total_reserved_credits: 207, expires_at: future(), items: [item] },
      { id: "q_retry_old", user_id: "user_1", status: "expired", quote_hash: HASH, total_reserved_credits: 207, expires_at: future(), items: [item] },
      { id: "q_retry_new", user_id: "user_1", status: "quoted", quote_hash: HASH, total_reserved_credits: 207, expires_at: future(), items: [item] },
    ];
    state.jobs = [{ id: "job_quote_q_failed", user_id: "user_1", status: "failed", reserved_credits: 207 }];
    state.ledger = [
      { id: "res_job_quote_q_failed", user_id: "user_1", delta: -207, type: "reserve", job_id: "job_quote_q_failed" },
      { id: "rel_job_quote_q_failed", user_id: "user_1", delta: 207, type: "release", job_id: "job_quote_q_failed" },
    ];
  });
  afterEach(() => { process.env = { ...env }; });

  it("creates the job and reserves exactly the quote total, like the first time", async () => {
    const { status, json } = await approve("q_retry_new");
    expect(status).toBe(200);
    expect(json).toMatchObject({ success: true, jobId: "job_quote_q_retry_new", reservedCredits: 207 });
    const reserves = state.ledger.filter((row) => row.type === "reserve" && row.job_id === "job_quote_q_retry_new");
    expect(reserves).toEqual([expect.objectContaining({ id: "res_job_quote_q_retry_new", delta: -207 })]);
    expect(state.jobs.find((job) => job.id === "job_quote_q_retry_new")?.status).toBe("queued");
  });

  it("the new job id is its own: it never collides with the failed job, even though the plan hash is identical", async () => {
    const { json } = await approve("q_retry_new");
    expect(json.jobId).not.toBe("job_quote_q_failed");
    expect(state.jobs.filter((job) => job.id === "job_quote_q_failed")).toHaveLength(1);
    expect(state.jobs.find((job) => job.id === "job_quote_q_failed")?.status).toBe("failed");
  });

  it("pressing twice reserves once", async () => {
    await approve("q_retry_new");
    const again = await approve("q_retry_new");
    expect(again.status).toBe(409);
    expect(again.json.error).toBe("تم بدء تنفيذ هذا العرض مسبقاً ولا يمكن تكراره.");
    expect(state.ledger.filter((row) => row.id === "res_job_quote_q_retry_new")).toHaveLength(1);
  });

  it("the card of a superseded quote is refused, with nothing reserved", async () => {
    const { status, json } = await approve("q_retry_old");
    expect(status).toBeGreaterThanOrEqual(400);
    expect(json.success).toBe(false);
    expect(state.ledger.some((row) => row.job_id === "job_quote_q_retry_old")).toBe(false);
  });

  it("a failed job does not count against the active-job limit", async () => {
    state.jobs.push({ id: "job_a", user_id: "user_1", status: "failed" }, { id: "job_b", user_id: "user_1", status: "failed" }, { id: "job_c", user_id: "user_1", status: "completed" });
    expect((await approve("q_retry_new")).status).toBe(200);
  });

    it("insufficient balance is the only start failure that talks about the balance, in the server's own sentence", async () => {
      const { acceptQuoteSupabase } = await import("../src/lib/supabase/quoteAccept");
      const rpc = async () => ({ data: { success: false, error: "insufficient_balance", balance: 50 }, error: null });
      const result = await acceptQuoteSupabase({ from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: { quote_hash: HASH, items: [{ capabilitySlug: "treg-companies-research-basic", endpointId: "treg.companies.research.basic", unitCostUsd: 0.02 }] }, error: null }) }) }) }), rpc } as any, { userId: "user_1", quoteId: "q", expectedPlanHash: HASH });
      expect(result.statusCode).toBe(402);
      expect(result.errorAr).toBe("رصيدك الحالي (٥٠ نقطة) غير كافٍ لتغطية تكلفة هذا العرض. يرجى شحن الرصيد أولاً.");
    });
});
