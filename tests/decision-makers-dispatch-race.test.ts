import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { readFileSync } from "node:fs";

/**
 * The live job of 14:59 UTC (PR #253): the accept-quote dispatcher gave up on the worker after 45 s (reason code ١٧), recorded a START failure although the worker
 * had the job, which turned the job from `running` to `queued`; the worker then refused to settle and released the hold. SIMULATION only: an in-memory database
 * that mirrors `record_chunk_failure` as deployed (terminal guard, attempt + 1, status `queued`, backoff min(10 x 2^(n-1), 300) s), the real route, the real
 * start-failure code, the real settlement pre-check and the real pricing functions. No network, nothing paid.
 */
const state = vi.hoisted(() => ({
  user: { id: "user_1", email: "a@b.c", email_confirmed_at: "2026-10-01T00:00:00Z", user_metadata: {} } as any,
  quotes: [] as any[],
  jobs: [] as any[],
  ledger: [] as any[],
  messages: [] as any[],
  events: [] as any[],
  rpcCalls: [] as string[],
  dispatch: "ok" as "ok" | "worker_has_it_then_timeout" | "never_claimed_timeout" | "worker_finished_then_timeout" | "worker_failed_then_timeout" | "other_failure_while_running",
  jobReadFails: false,
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
        return { update: (patch: any) => ({ eq: (c1: string, v1: string) => ({ eq: async (c2: string, v2: string) => { for (const m of state.messages) if (m[c1] === v1 && m[c2] === v2) Object.assign(m, patch); return { error: null }; } }) }) };
      }
      if (table === "jobs") {
        return {
          select: () => ({
            eq: (_c: string, id: string) => {
              const job = state.jobs.find((j) => j.id === id) ?? null;
              const answer = () => (state.jobReadFails ? { data: null, error: new Error("read failed") } : { data: job ? { ...job } : null, error: null });
              return { maybeSingle: async () => answer(), single: async () => answer() };
            },
          }),
        };
      }
      return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }), insert: async (row: any) => { if (table === "job_events") state.events.push(row); return { error: null }; } };
    },
    rpc: async (name: string, args: any) => {
      state.rpcCalls.push(name);
      if (name === "record_chunk_failure") {
        const job = state.jobs.find((j) => j.id === args.p_job_id);
        if (!job) throw new Error("Job not found");
        if (["completed", "failed"].includes(job.status)) return { data: { success: true, ignored: true, status: job.status, job_id: job.id }, error: null };
        job.attempt_count = (job.attempt_count ?? 0) + 1;
        if (job.attempt_count >= 5) return { data: { success: true, failed_permanently: true, released: true, attempt_count: job.attempt_count }, error: null };
        job.status = "queued";
        job.error_message = args.p_error_message;
        job.delay_seconds = Math.min(10 * 2 ** (job.attempt_count - 1), 300);
        return { data: { success: true, failed_permanently: false, attempt_count: job.attempt_count, delay_seconds: job.delay_seconds }, error: null };
      }
      // the readiness probe of the people settlement function: a nonexistent job id answers «Job ... not found» (proves it is installed)
      if (name === "settle_people_job_atomic") return { data: null, error: { message: `Job ${args.p_job_id} not found` } };
      if (name !== "accept_quote_atomic") return { data: { success: true }, error: null };
      const q = state.quotes.find((item) => item.id === args.p_quote_id);
      if (!q) return { data: { success: false, error: "quote_not_found" }, error: null };
      const jobId = `job_quote_${q.id}`;
      if (q.status !== "quoted") return { data: { success: false, error: "invalid_quote_status", status: q.status }, error: null };
      state.ledger.push({ id: `res_${jobId}`, user_id: q.user_id, delta: -q.total_reserved_credits, type: "reserve", job_id: jobId });
      state.jobs.push({ id: jobId, user_id: q.user_id, status: "queued", reserved_credits: q.total_reserved_credits, attempt_count: 0 });
      q.status = "accepted";
      return { data: { success: true, already_accepted: false, quote_id: q.id, job_id: jobId, reserved_credits: q.total_reserved_credits }, error: null };
    },
  })),
}));

vi.mock("../src/lib/server/workerDispatch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/server/workerDispatch")>()),
  dispatchWorkerChunk: vi.fn(async (_base: string, jobId: string) => {
    const job = state.jobs.find((j) => j.id === jobId);
    const timeout = () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    if (state.dispatch === "worker_has_it_then_timeout") { job.status = "running"; throw timeout(); }
    if (state.dispatch === "worker_finished_then_timeout") { job.status = "completed"; throw timeout(); }
    if (state.dispatch === "worker_failed_then_timeout") { job.status = "failed"; throw timeout(); }
    if (state.dispatch === "never_claimed_timeout") throw timeout();
    if (state.dispatch === "other_failure_while_running") { job.status = "running"; return { started: false, status: 500, body: {}, failureCode: "worker_http_error" }; }
    job.status = "running";
    return { started: true, status: 200, body: { success: true, claimed: true } };
  }),
}));
vi.mock("../src/lib/server/jobNotices", async (importOriginal) => ({ ...(await importOriginal<any>()), sendJobNotice: vi.fn(async () => undefined) }));

import { collectionCompleteBeforeSettlement } from "../src/lib/server/settlementPrecheck";
import { startFailureStillApplies, startFailureEventAr } from "../src/lib/server/workerStartFailure";
import { WORKER_DISPATCH_TIMEOUT_MS } from "../src/lib/server/workerDispatch";
import { PEOPLE_LOOKUP_RESERVE_MS } from "../src/lib/server/tregAdapter";
import { decisionMakerChargePoints, decisionMakerDeliveredUnits, DECISION_MAKER_UNIT_PRICES_POINTS } from "../src/functions/shared/decisionMakerPricing";

const HASH = "a".repeat(64);
const future = () => new Date(Date.now() + 20 * 60_000).toISOString();
const item = { capabilitySlug: "professional-people-search", endpointId: "treg.people.search", unitPricePoints: 258, targetVolumeMin: 1, targetVolumeMax: 3, unitCostUsd: 0.015, params: { title: "CEO", country: "EG" } };
const JOB = "job_quote_q_people";

async function approve() {
  const { POST } = await import("../src/app/api/chat/accept-quote/route");
  const res = await POST(new NextRequest("http://127.0.0.1:3000/api/chat/accept-quote", { method: "POST", body: JSON.stringify({ quoteId: "q_people", expectedPlanHash: HASH, explicitApproval: true }) }));
  return { status: res.status, json: await res.json() };
}
const job = () => state.jobs.find((j) => j.id === JOB);
const warnings = () => state.events.filter((e) => e.job_id === JOB && e.event_type === "warning");

/** What the worker does when it reaches the end of its chunk with 2 delivered people: the real pre-check, then the real per-field charge, else a full release. */
function workerFinishesChunk() {
  const row = { ...job(), current_cursor: "completed", delivered_units: 2 };
  if (!collectionCompleteBeforeSettlement(row, null, 2)) {
    job().status = "failed";
    state.ledger.push({ id: `rel_${JOB}`, delta: 891, type: "release", job_id: JOB });
    return { settled: false, charged: 0 };
  }
  const rows = [{ work_email: "a@x.example", work_email_verification_status: "متحقق", phone: "" }, { work_email: "b@y.example", work_email_verification_status: "يحتاج مراجعة", phone: "" }];
  const charged = decisionMakerChargePoints(decisionMakerDeliveredUnits(rows, ["work_email", "phone"]), DECISION_MAKER_UNIT_PRICES_POINTS);
  job().status = "completed";
  job().charged_credits = charged;
  return { settled: true, charged };
}

describe("a dispatch cut by our own time limit", () => {
  const env = { ...process.env };
  beforeEach(() => {
    process.env.ENABLE_MOCK_PROVIDER = "true";
    (process.env as any).NODE_ENV = "test";
    state.quotes = [{ id: "q_people", user_id: "user_1", status: "quoted", quote_hash: HASH, total_reserved_credits: 891, expires_at: future(), items: [item] }];
    state.jobs = [];
    state.ledger = [];
    state.messages = [{ id: "m1", user_id: "user_1", request_quote_id: "q_people", request_status: "quoted" }];
    state.events = [];
    state.rpcCalls = [];
    state.dispatch = "ok";
    state.jobReadFails = false;
  });
  afterEach(() => { process.env = { ...env }; });

  it("while the worker HAS the job (running): no start failure is recorded, no warning is written, the status stays running, the job settles and charges", async () => {
    state.dispatch = "worker_has_it_then_timeout";
    const { status, json } = await approve();
    expect(status).toBe(200);
    expect(state.rpcCalls).not.toContain("record_chunk_failure");
    expect(warnings()).toEqual([]);
    expect(job()).toMatchObject({ status: "running", attempt_count: 0 });
    // the answer says the work started (the page shows it running), not the retry sentence
    expect(json.workerDispatch).toMatchObject({ started: true, body: { workerAlreadyRunning: true } });
    expect(json.messageAr).toBe("تم قبول الطلب وبدء التنفيذ.");
    // the worker finishes its chunk after the dispatcher stopped waiting: the pre-check passes, the 2 delivered people are charged 2 x (83 + 120), nothing is released
    expect(workerFinishesChunk()).toEqual({ settled: true, charged: 406 });
    expect(job()).toMatchObject({ status: "completed", charged_credits: 406 });
    expect(state.ledger.filter((row) => row.type === "release")).toEqual([]);
  });

  it("the same timeline WITHOUT the guard reproduces the live failure (the old behaviour, recorded by hand): queued, the pre-check refuses, the hold is released", async () => {
    state.dispatch = "worker_has_it_then_timeout";
    await approve();
    // what the old route did after the timeout
    const { recordWorkerStartFailure } = await import("../src/lib/server/workerStartFailure");
    const { createAdminClient } = await import("../src/lib/supabase/server");
    await recordWorkerStartFailure(createAdminClient(), JOB);
    expect(job()).toMatchObject({ status: "queued", attempt_count: 1, delay_seconds: 10 });
    const row = { ...job(), current_cursor: "completed", delivered_units: 2 };
    expect(collectionCompleteBeforeSettlement(row, null, 2)).toBe(false);
    expect(workerFinishesChunk()).toEqual({ settled: false, charged: 0 });
    expect(job().status).toBe("failed");
  });

  it("while the job is still QUEUED (the worker never claimed it): the start failure is recorded as before, with the reason code ١٧ and the retry sentence", async () => {
    state.dispatch = "never_claimed_timeout";
    const { status, json } = await approve();
    expect(status).toBe(200);
    expect(state.rpcCalls).toContain("record_chunk_failure");
    expect(job()).toMatchObject({ status: "queued", attempt_count: 1 });
    expect(json.workerDispatch.started).toBe(false);
    expect(json.messageAr).toBe("تعذر بدء البحث الآن. ستتم إعادة المحاولة تلقائياً.");
    expect(warnings().map((e) => e.message)).toEqual([startFailureEventAr("dispatch_timeout").message]);
    expect(warnings()[0].message).toContain("(رمز السبب ١٧)");
    expect(state.ledger.filter((row) => row.type === "release")).toEqual([]);
  });

  it("when the job already finished or failed on its own, the late timeout changes nothing", async () => {
    for (const mode of ["worker_finished_then_timeout", "worker_failed_then_timeout"] as const) {
      state.jobs = []; state.ledger = []; state.events = []; state.rpcCalls = [];
      state.quotes[0].status = "quoted";
      state.dispatch = mode;
      await approve();
      expect(state.rpcCalls, mode).not.toContain("record_chunk_failure");
      expect(warnings(), mode).toEqual([]);
      expect(job().status, mode).toBe(mode === "worker_finished_then_timeout" ? "completed" : "failed");
    }
  });

  it("only a TIMEOUT is read first: another failure (worker answered 500) keeps the old behaviour", async () => {
    state.dispatch = "other_failure_while_running";
    await approve();
    expect(state.rpcCalls).toContain("record_chunk_failure");
  });

  it("startFailureStillApplies: queued yes; running, completed, failed, cancelled no; an unreadable or missing job keeps the old behaviour (yes); other codes never read the job", async () => {
    const client = (rows: any[], fails = false) => ({ from: () => ({ select: () => ({ eq: (_c: string, id: string) => ({ maybeSingle: async () => (fails ? { data: null, error: new Error("x") } : { data: rows.find((r) => r.id === id) ?? null, error: null }) }) }) }) });
    const rows = [{ id: "q", status: "queued" }, { id: "r", status: "running" }, { id: "c", status: "completed" }, { id: "f", status: "failed" }, { id: "x", status: "cancelled" }];
    const applies = (id: string, code = "dispatch_timeout") => startFailureStillApplies(client(rows), id, code);
    expect(await applies("q")).toBe(true);
    for (const id of ["r", "c", "f", "x"]) expect(await applies(id), id).toBe(false);
    expect(await applies("missing")).toBe(true);
    expect(await startFailureStillApplies(client(rows, true), "r", "dispatch_timeout")).toBe(true);
    expect(await startFailureStillApplies({ from: () => { throw new Error("down"); } }, "r", "dispatch_timeout")).toBe(true);
    for (const code of ["worker_http_error", "protection_redirect", "dispatch_exception", undefined]) expect(await startFailureStillApplies(client(rows), "r", code as any), String(code)).toBe(true);
  });

  it("the settlement pre-check: running + completed cursor + the recorded count passes; any other status, cursor or count, or a read error, refuses", () => {
    const ok = { status: "running", current_cursor: "completed", delivered_units: 2 };
    expect(collectionCompleteBeforeSettlement(ok, null, 2)).toBe(true);
    expect(collectionCompleteBeforeSettlement({ ...ok, status: "queued" }, null, 2)).toBe(false);
    expect(collectionCompleteBeforeSettlement({ ...ok, status: "failed" }, null, 2)).toBe(false);
    expect(collectionCompleteBeforeSettlement({ ...ok, current_cursor: "page_2" }, null, 2)).toBe(false);
    expect(collectionCompleteBeforeSettlement({ ...ok, delivered_units: 3 }, null, 2)).toBe(false);
    expect(collectionCompleteBeforeSettlement(ok, new Error("x"), 2)).toBe(false);
    expect(collectionCompleteBeforeSettlement(null, null, 2)).toBe(false);
    // the worker route uses this function (and no longer compares inline)
    expect(readFileSync("src/app/api/worker/chunk/route.ts", "utf8")).toContain("collectionCompleteBeforeSettlement(persistedCompletion, persistedCompletionErr, recordedDeliveredUnits)");
  });
});

describe("the timing: the dispatcher waits longer than the worker can run", () => {
  it("arithmetic: the worker's deadline is 45 s; lookups stop starting 12 s before it (33 s); saving and settling took about 10 s (live: 15:00:39.7 to 15:00:49.3) = 43 s; the dispatcher waits 55 s, under maxDuration 60", () => {
    const workerDeadlineMs = 45_000;
    const savingAndSettlingMs = 10_000; // measured in the live job: lookup_log written 15:00:39.7, last event 15:00:49.3
    const lastLookupEndsMs = workerDeadlineMs - PEOPLE_LOOKUP_RESERVE_MS;
    expect(PEOPLE_LOOKUP_RESERVE_MS).toBe(12_000);
    expect(lastLookupEndsMs).toBe(33_000);
    expect(lastLookupEndsMs + savingAndSettlingMs).toBe(43_000);
    expect(lastLookupEndsMs + savingAndSettlingMs).toBeLessThanOrEqual(workerDeadlineMs);
    expect(WORKER_DISPATCH_TIMEOUT_MS).toBe(55_000);
    expect(WORKER_DISPATCH_TIMEOUT_MS - (lastLookupEndsMs + savingAndSettlingMs)).toBe(12_000); // margin over a normal chunk
    // the old numbers: lookups to 39 s + 10 s = 49 s > the 45 s wait (the live failure)
    expect(workerDeadlineMs - 6_000 + savingAndSettlingMs).toBeGreaterThan(45_000);
  });

  it("the sources agree: the worker deadline is routeStart + 45_000 with maxDuration 60; the accept and nudge routes allow 60 s; the dispatch default is the named constant", () => {
    const worker = readFileSync("src/app/api/worker/chunk/route.ts", "utf8");
    expect(worker).toContain("const deadlineMs = routeStart + 45_000;");
    expect(worker).toContain("export const maxDuration = 60;");
    expect(readFileSync("src/app/api/chat/accept-quote/route.ts", "utf8")).toContain("export const maxDuration = 60;");
    expect(readFileSync("src/app/api/jobs/[id]/nudge/route.ts", "utf8")).toContain("export const maxDuration = 60;");
    expect(readFileSync("src/lib/server/workerDispatch.ts", "utf8")).toContain("timeoutMs = WORKER_DISPATCH_TIMEOUT_MS,");
    expect(WORKER_DISPATCH_TIMEOUT_MS).toBeLessThan(60_000);
  });
});
