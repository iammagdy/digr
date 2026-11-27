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
      const balance = state.ledger.filter((row) => row.user_id === q.user_id).reduce((sum, row) => sum + row.delta, 0);
      if (balance < q.total_reserved_credits) return { data: { success: false, error: "insufficient_balance", balance }, error: null };
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

async function approveMany(quoteIds: string[]) {
  return Promise.all(quoteIds.map((id) => approve(id)));
}

const quoteRow = (id: string, user = "user_1", total = 207) => ({ id, user_id: user, status: "quoted", quote_hash: HASH, total_reserved_credits: total, expires_at: future(), items: [item] });
const credit = (user: string, delta: number) => ({ id: `top_${user}`, user_id: user, delta, type: "topup" });

describe("approvals at the same moment", () => {
  const env = { ...process.env };
  beforeEach(() => {
    process.env.ENABLE_MOCK_PROVIDER = "true";
    (process.env as any).NODE_ENV = "test";
    state.quotes = [];
    state.jobs = [];
    state.ledger = [];
  });
  afterEach(() => { process.env = { ...env }; });

  it("the same quote approved 20 times at once reserves once, makes one job and never goes above the quote total", async () => {
    state.quotes = [quoteRow("q_one")];
    state.ledger = [credit("user_1", 1000)];
    const results = await approveMany(Array.from({ length: 20 }, () => "q_one"));
    // exactly one approval starts the job; the other nineteen are told it was already started (409), none reserves again
    expect(results.filter((r) => r.status === 200 && r.json.success === true)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(19);
    const reserves = state.ledger.filter((row) => row.type === "reserve");
    expect(reserves).toHaveLength(1);
    expect(reserves[0]).toMatchObject({ id: "res_job_quote_q_one", delta: -207 });
    expect(state.jobs.filter((job) => job.id === "job_quote_q_one")).toHaveLength(1);
    expect(results.find((r) => r.status === 200)?.json.jobId).toBe("job_quote_q_one");
    const balance = state.ledger.reduce((sum, row) => sum + row.delta, 0);
    expect(balance).toBe(1000 - 207);
  });

  it("three different quotes of one account approved at once: the balance never goes negative and every reserve has its own job", async () => {
    state.quotes = [quoteRow("q_a"), quoteRow("q_b"), quoteRow("q_c")];
    state.ledger = [credit("user_1", 450)];
    const results = await approveMany(["q_a", "q_b", "q_c"]);
    const accepted = results.filter((r) => r.status === 200);
    expect(accepted).toHaveLength(2);
    expect(results.filter((r) => r.status !== 200).every((r) => r.status === 402 || r.status === 429)).toBe(true);
    const reserves = state.ledger.filter((row) => row.type === "reserve");
    expect(reserves).toHaveLength(2);
    expect(state.jobs).toHaveLength(2);
    expect(reserves.map((row) => row.job_id).sort()).toEqual(state.jobs.map((job) => job.id).sort());
    expect(state.ledger.reduce((sum, row) => sum + row.delta, 0)).toBeGreaterThanOrEqual(0);
  });

  it("twenty accounts approving their own quote at once: twenty reserves, none touches another account", async () => {
    const users = Array.from({ length: 20 }, (_u, i) => `user_${i + 10}`);
    state.quotes = users.map((u) => quoteRow(`q_${u}`, u));
    state.ledger = users.map((u) => credit(u, 300));
    const results = await Promise.all(users.map((u) => approve(`q_${u}`, u)));
    // Each request's own account reaches the atomic boundary.
    for (const u of users) {
      const mine = state.ledger.filter((row) => row.user_id === u);
      expect(mine.filter((row) => row.type === "reserve")).toHaveLength(1);
      expect(mine.reduce((sum, row) => sum + row.delta, 0)).toBeGreaterThanOrEqual(0);
    }
    expect(results.every((r) => r.status === 200)).toBe(true);
  });
});
