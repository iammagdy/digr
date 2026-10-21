import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Approving a NEW quote from the plan card of a conversation whose previous job failed and was fully released. The in-memory
 * database mirrors accept_quote_atomic as deployed (quote must be «quoted» and unexpired, one job per quote id, active-job limit
 * counts only queued/running, the reserve equals the quote total); the route, the accept function and the history update are real.
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
    state.messages = [
      { id: "m1", user_id: "user_1", request_quote_id: "q_failed", request_status: "accepted" },
      { id: "m2", user_id: "user_1", request_quote_id: "q_retry_old", request_status: "quoted" },
      { id: "m3", user_id: "user_1", request_quote_id: "q_retry_new", request_status: "quoted" },
    ];
    state.dispatched = [];
    state.events = [];
    state.dispatch = "ok";
    state.recordFailureThrows = false;
  });
  afterEach(() => { process.env = { ...env }; });

  it("creates the job and reserves exactly the quote total, like the first time", async () => {
    const { status, json } = await approve("q_retry_new");
    expect(status).toBe(200);
    expect(json).toMatchObject({ success: true, jobId: "job_quote_q_retry_new", reservedCredits: 207 });
    const reserves = state.ledger.filter((row) => row.type === "reserve" && row.job_id === "job_quote_q_retry_new");
    expect(reserves).toEqual([expect.objectContaining({ id: "res_job_quote_q_retry_new", delta: -207 })]);
    expect(state.jobs.find((job) => job.id === "job_quote_q_retry_new")?.status).toBe("queued");
    expect(state.dispatched).toEqual(["job_quote_q_retry_new"]);
    expect(state.messages.find((m) => m.id === "m3")?.request_status).toBe("accepted");
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

  describe("a start that does not go through says what is true and records a reason code", () => {
    const startLines = () => state.events.filter((e) => e.job_id === "job_quote_q_retry_new").map((e) => `${e.event_type}|${e.message}`);

    it.each([
      ["http_503", "١٤"], ["html", "١٢"], ["auth", "١١"], ["throws", "١٦"], ["timeout", "١٧"],
    ] as const)("worker %s: the request stays reserved and queued for an automatic retry, the answer is a success with the retry sentence, and the activity carries code %s", async (mode, code) => {
      state.dispatch = mode;
      const { status, json } = await approve("q_retry_new");
      expect(status).toBe(200);
      expect(json).toMatchObject({ success: true, jobId: "job_quote_q_retry_new", reservedCredits: 207 });
      expect(json.workerDispatch.started).toBe(false);
      expect(json.messageAr).toBe("تعذر بدء البحث الآن. ستتم إعادة المحاولة تلقائياً.");
      expect(json.messageAr).not.toContain("رصيد");
      const line = startLines().find((entry) => entry.includes("رمز السبب"));
      expect(line).toBe(`warning|تعثر بدء المعالجة مؤقتاً، وستُعاد المحاولة تلقائياً، ولن يُخصم من رصيدك إلا ما يُسلَّم (رمز السبب ${code}).`);
      expect(line!.split("|")[1]).not.toMatch(/[A-Za-z]/);
      // the reserve is exactly the quote's, made once, and nothing was released by this path
      expect(state.ledger.filter((row) => row.job_id === "job_quote_q_retry_new")).toEqual([expect.objectContaining({ type: "reserve", delta: -207 })]);
    });

    it("a failure while recording the attempt never turns an accepted request into an error", async () => {
      state.dispatch = "http_503";
      state.recordFailureThrows = true;
      const { status, json } = await approve("q_retry_new");
      expect(status).toBe(200);
      expect(json.success).toBe(true);
      expect(state.jobs.find((job) => job.id === "job_quote_q_retry_new")?.status).toBe("queued");
    });

    it("a started request writes no start-failure line", async () => {
      await approve("q_retry_new");
      expect(startLines().some((entry) => entry.includes("رمز السبب"))).toBe(false);
    });

    it("insufficient balance is the only start failure that talks about the balance, in the server's own sentence", async () => {
      const { acceptQuoteSupabase } = await import("../src/lib/supabase/quoteAccept");
      const rpc = async () => ({ data: { success: false, error: "insufficient_balance", balance: 50 }, error: null });
      const result = await acceptQuoteSupabase({ from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: null, error: new Error("x") }) }) }) }), rpc } as any, { userId: "user_1", quoteId: "q", expectedPlanHash: HASH });
      expect(result.statusCode).toBe(402);
      expect(result.errorAr).toBe("رصيدك الحالي (٥٠ نقطة) لا يكفي لحجز كامل هذا الطلب. اشحن رصيدك من صفحة الشحن ثم عُد لتوافق على الخطة.");
    });
  });
});
