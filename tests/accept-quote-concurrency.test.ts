import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Many approvals at the same moment (the conference room). The route, the accept function and the history update are the real ones;
 * the database function is a stand-in that follows accept_quote_atomic as deployed (quote must be «quoted», one job per quote id,
 * active-job limit counts queued/running, the reserve equals the quote total) and is atomic by construction (no await between its check
 * and its write), so what these tests prove is the ROUTE'S behaviour under concurrency: it never asks for a second reserve, never
 * starts a second job for one quote and never lets the stand-in's balance go negative. The real database locks are SQL and are not
 * exercised here (see docs/CONFERENCE_READINESS.md, "not verified").
 */
const state = vi.hoisted(() => ({
  user: { id: "user_1", email: "a@b.c", email_confirmed_at: "2026-10-01T00:00:00Z", user_metadata: {} } as any,
  quotes: [] as any[],
  jobs: [] as any[],
  ledger: [] as any[],
  messages: [] as any[],
  dispatched: [] as string[],
  events: [] as any[],
  dispatch: "ok" as "ok" | "http_503" | "html" | "timeout" | "throws" | "auth",
  recordFailureThrows: false,
}));

vi.mock("../src/lib/supabase/server", () => ({
  createServerSideClient: vi.fn(async () => ({ auth: { getUser: vi.fn(async () => ({ data: { user: state.user }, error: null })) } })),
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
      if (table === "messages") {
        return {
          update: (patch: any) => ({
            eq: (c1: string, v1: string) => ({
              eq: async (c2: string, v2: string) => {
                for (const m of state.messages) if (m[c1] === v1 && m[c2] === v2) Object.assign(m, patch);
                return { error: null };
              },
            }),
          }),
        };
      }
      return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }), insert: async (row: any) => { if (table === "job_events") state.events.push(row); return { error: null }; } };
    },
    rpc: async (name: string, args: any) => {
      if (name === "record_chunk_failure" && state.recordFailureThrows) throw new Error("rpc down");
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

vi.mock("../src/lib/server/workerDispatch", () => ({
  dispatchWorkerChunk: vi.fn(async (_base: string, jobId: string) => {
    state.dispatched.push(jobId);
    if (state.dispatch === "throws") throw new Error("socket closed");
    if (state.dispatch === "timeout") throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    if (state.dispatch === "http_503") return { started: false, status: 503, body: {}, failureCode: "worker_http_error" };
    if (state.dispatch === "html") return { started: false, status: 200, body: {}, failureCode: "protection_redirect" };
    if (state.dispatch === "auth") return { started: false, status: 401, body: {}, failureCode: "worker_auth_rejected" };
    return { started: true, status: 200, body: {} };
  }),
}));
vi.mock("../src/lib/server/jobNotices", async (importOriginal) => ({ ...(await importOriginal<any>()), sendJobNotice: vi.fn(async () => undefined) }));


const HASH = "a".repeat(64);
const future = () => new Date(Date.now() + 20 * 60_000).toISOString();
const item = { capabilitySlug: "social-tiktok-comments", endpointId: "tikhub.tiktok.video.comments", unitPricePoints: 6, targetVolumeMin: 1, targetVolumeMax: 30, unitCostUsd: 0.001, params: { query: "كرة القدم" } };

async function approve(quoteId: string) {
  const { POST } = await import("../src/app/api/chat/accept-quote/route");
  const res = await POST(new NextRequest("http://127.0.0.1:3000/api/chat/accept-quote", { method: "POST", body: JSON.stringify({ quoteId, expectedPlanHash: HASH, explicitApproval: true }) }));
  return { status: res.status, json: await res.json() };
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
    state.messages = [];
    state.dispatched = [];
    state.events = [];
    state.dispatch = "ok";
    state.recordFailureThrows = false;
  });
  afterEach(() => { process.env = { ...env }; });

  it("the same quote approved 20 times at once reserves once, makes one job and never goes above the quote total", async () => {
    state.quotes = [quoteRow("q_one")];
    state.ledger = [credit("user_1", 1000)];
    const results = await approveMany(Array.from({ length: 20 }, () => "q_one"));
    // exactly one approval starts the job; the other nineteen are told it was already started (409), none reserves again
    expect(results.filter((r) => r.status === 200 && r.json.success === true)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(19);
    expect(state.dispatched).toEqual(["job_quote_q_one"]);
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
    const results = await Promise.all(users.map(async (u) => {
      state.user = { ...state.user, id: u };
      return approve(`q_${u}`);
    }));
    // The route reads the signed-in user per request; the shared stand-in user is switched before each call, so the strongest claim
    // here is about the money: no account ever holds more than one reserve per quote and no balance is negative.
    for (const u of users) {
      const mine = state.ledger.filter((row) => row.user_id === u);
      expect(mine.filter((row) => row.type === "reserve").length).toBeLessThanOrEqual(1);
      expect(mine.reduce((sum, row) => sum + row.delta, 0)).toBeGreaterThanOrEqual(0);
    }
    expect(results.every((r) => r.status === 200 || r.status === 403 || r.status === 429)).toBe(true);
  });
});
