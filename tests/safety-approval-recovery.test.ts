import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ADDON_APPROVE_MESSAGES_AR, ADDON_RELEASED_ERROR, ADDON_RELEASED_SUMMARY_AR, addonJobId, addonQuoteId, approveAddonOnce, settleAddon } from "../src/lib/agentMission/addonSettlement";
import { readJobMoneyState } from "../src/lib/agentMission/addonMoneyState";
import { RECOVERY_MAX_PER_FILE, recoverAbandonedAddon, recoverFileAddons } from "../src/lib/agentMission/addonRecovery";
import { canCreateAddon } from "../src/lib/agentMission/stage4/addonRow";
import { cancelUnpaidAddonRow } from "../src/lib/agentMission/stage4/addonRowStore";
import { addonPhaseOf } from "../src/lib/agentMission/stage4/fileWorkflow";
import { checkCustomerText } from "../src/lib/agentMission/text";
import { addonRowOf, checkAddonLedger, USER } from "./helpers/addonWorld";
import { recordsJob, safetyWorld, type SafetyWorld } from "./helpers/safetyWorld";

/**
 * SAFETY FIX C (docs/STAGE-4-FINANCIAL-SAFETY.md): RECOVERY OF AN ABANDONED APPROVAL. An approval that fails after money-related steps puts the row back to `plan_ready` WITH its approval mark. If the abandoned job is later released (the approval's own release, or the watchdog),
 * nothing ended the request: it could be neither cancelled (the mark) nor approved again (`claim_retry` for ever), and it blocked the file. These tests run the REAL `approveAddonOnce`, `readJobMoneyState`, `recoverAbandonedAddon` and `recoverFileAddons` over the hardened money
 * fake and fault-injecting tables. They pin the five money states, that the recovery only READS the money tables and never calls a money function, that a possibly paid request is never ended as unpaid, that nothing is released twice, and that every recovery is idempotent.
 */
const fetchSpy = vi.fn(() => { throw new Error("a real call was attempted"); });
beforeEach(() => { vi.stubGlobal("fetch", fetchSpy); fetchSpy.mockClear(); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

const START = 10_000;
const FILE = "msn_5851abc92a1e6645a9cd";
const hold = (row: ReturnType<typeof addonRowOf>) => row.plan.addon.pricing.holdPoints as number;
const make = (kind: "review" | "edit" = "review") => { const w = safetyWorld({ balance: START }); const row = addonRowOf({ kind, of: FILE }); w.missions.set(row.id, row); return { w, row, jobId: addonJobId(addonQuoteId(row.id)) }; };
const approve = (w: SafetyWorld, id: string) => approveAddonOnce(w.client, { id, actorId: USER, expectUserId: USER });
const recover = (w: SafetyWorld, id: string, now?: Date) => recoverAbandonedAddon(w.client, { id, userId: USER, ...(now ? { now } : {}) });
const money = (w: SafetyWorld) => w.ledger.filter((r) => r.type === "release" || r.type === "charge");
const later = () => new Date(Date.now() + 2 * 3600_000);

/** A reservation is held (job running, lease ours) and the row says «waiting, approved once»: the record never got written. */
async function abandonedActive(w: SafetyWorld, id: string): Promise<void> {
  w.failUpdates({ when: recordsJob, mode: "error_before", times: 3 });
  expect((await approve(w, id)).ok).toBe(false);
  w.clearFaults();
}
/** The hold is reserved, the record failed AND the revert failed: the row is `approved` with a one-hour lease and no job id. */
async function approvedWithoutJob(w: SafetyWorld, id: string): Promise<void> {
  w.failUpdates({ when: recordsJob, mode: "error_before" });
  w.failUpdates({ when: (p) => p.status === "plan_ready", mode: "error_before" });
  expect((await approve(w, id)).ok).toBe(false);
  w.clearFaults();
}
/** accept committed, the claim never ran: the job is `queued`, the hold is reserved, nobody holds the lease. */
async function abandonedQueued(w: SafetyWorld, id: string): Promise<void> {
  w.inject("claim_job_chunk", "before");
  expect((await approve(w, id)).ok).toBe(false);
}
/** The claim failed with a returned error and the approval's own release SUCCEEDED: the job is `failed` with its release row; the row went back to `plan_ready`, marked. */
async function abandonedReleased(w: SafetyWorld, id: string): Promise<void> {
  w.injectError("claim_job_chunk", "before");
  expect(await approve(w, id)).toMatchObject({ ok: false, code: "claim_failed" });
}
const watchdogReleases = (w: SafetyWorld, jobId: string) => w.client.rpc("release_job_atomic", { p_job_id: jobId, p_error_message: "تم إلغاء الطلب تلقائياً لتأخر التنفيذ والنقاط المحجوزة: حجز مؤقت مُحرَّر كاملًا.", p_force: true });

describe("THE MONEY STATE OF A JOB: a read-only look at the job and its ledger rows, five states and one «unknown»", () => {
  it("no job and no ledger row: «none» (confirmed: nothing was ever reserved)", async () => {
    const { w, jobId } = make();
    expect(await readJobMoneyState(w.client, jobId)).toEqual({ kind: "none" });
  });
  it("a job that is queued or running, with its reserve and no release: «active», with the hold read from the job", async () => {
    const { w, row, jobId } = make();
    await abandonedQueued(w, row.id);
    expect(await readJobMoneyState(w.client, jobId)).toEqual({ kind: "active", status: "queued", holdPoints: hold(row) });
    expect((await approve(w, row.id)).ok).toBe(true);
    expect(await readJobMoneyState(w.client, jobId)).toEqual({ kind: "active", status: "running", holdPoints: hold(row) });
  });
  it("a failed job with its reserve AND its release row: «released» (confirmed by the ledger, not by the status alone)", async () => {
    const { w, row, jobId } = make();
    await abandonedReleased(w, row.id);
    expect(await readJobMoneyState(w.client, jobId)).toEqual({ kind: "released", holdPoints: hold(row) });
  });
  it("a completed job with release and charge rows: «charged», with the points charged", async () => {
    const { w, row, jobId } = make();
    await abandonedActive(w, row.id);
    await settleAddon(w.client, { kind: "review", jobId, holdPoints: hold(row), reportStored: true });
    expect(await readJobMoneyState(w.client, jobId)).toEqual({ kind: "charged", chargedPoints: hold(row), holdPoints: hold(row) });
  });
  it("a completed job with a release and NO charge row: «settled_free»", async () => {
    const { w, row, jobId } = make();
    await abandonedQueued(w, row.id);
    const job = w.jobs.get(jobId)!;
    job.status = "completed"; job.charged_credits = 0;
    w.ledger.push({ id: `rel_${jobId}`, delta: hold(row), type: "release", job_id: jobId, user_id: USER });
    expect(await readJobMoneyState(w.client, jobId)).toEqual({ kind: "settled_free", holdPoints: hold(row) });
  });
  it("a failed job WITHOUT its release row, a reserve that does not match the job, a ledger row with no job: «unknown, inconsistent» (never read as released)", async () => {
    const a = make(); await abandonedQueued(a.w, a.row.id);
    a.w.jobs.get(a.jobId)!.status = "failed";
    expect(await readJobMoneyState(a.w.client, a.jobId)).toEqual({ kind: "unknown", why: "inconsistent" });
    const b = make(); await abandonedQueued(b.w, b.row.id);
    b.w.ledger.find((l) => l.id === `res_${b.jobId}`)!.delta = -1;
    expect(await readJobMoneyState(b.w.client, b.jobId)).toEqual({ kind: "unknown", why: "inconsistent" });
    const c = make(); await abandonedQueued(c.w, c.row.id);
    c.w.jobs.delete(c.jobId);
    expect(await readJobMoneyState(c.w.client, c.jobId)).toEqual({ kind: "unknown", why: "inconsistent" });
    const d = make(); await abandonedQueued(d.w, d.row.id);
    d.w.jobs.get(d.jobId)!.status = "completed"; d.w.jobs.get(d.jobId)!.charged_credits = 5;
    expect(await readJobMoneyState(d.w.client, d.jobId)).toEqual({ kind: "unknown", why: "inconsistent" });
  });
  it("a read that fails, in the jobs table or in the ledger, or that throws: «unknown, read_failed» (the answer «none» is never assumed from an error)", async () => {
    const a = make(); await abandonedQueued(a.w, a.row.id); a.w.setJobsDown(true);
    expect(await readJobMoneyState(a.w.client, a.jobId)).toEqual({ kind: "unknown", why: "read_failed" });
    const b = make(); await abandonedQueued(b.w, b.row.id); b.w.setLedgerDown(true);
    expect(await readJobMoneyState(b.w.client, b.jobId)).toEqual({ kind: "unknown", why: "read_failed" });
    expect(await readJobMoneyState({ from: () => { throw new Error("boom"); } }, "job_x")).toEqual({ kind: "unknown", why: "read_failed" });
  });
  it("reading writes nothing: no rpc, no update, no insert", async () => {
    const { w, row, jobId } = make();
    await abandonedQueued(w, row.id);
    const calls = w.calls.length; const writes = w.writes.length; const ledger = JSON.stringify(w.ledger);
    await readJobMoneyState(w.client, jobId);
    expect([w.calls.length, w.writes.length, JSON.stringify(w.ledger)]).toEqual([calls, writes, ledger]);
  });
});

describe("FIX C: a request whose abandoned job was RELEASED is ended safely, once", () => {
  it("the approval's own release (claim failed): the next click says the points came back and ENDS the request, instead of «claim_retry» for ever", async () => {
    const { w, row, jobId } = make();
    await abandonedReleased(w, row.id);
    const out = await approve(w, row.id);
    expect(out).toMatchObject({ ok: false, code: "released_before_start", error: ADDON_APPROVE_MESSAGES_AR.released_before_start });
    expect(w.missions.get(row.id)).toMatchObject({ status: "failed", error: ADDON_RELEASED_ERROR, charged_points: 0, summary_ar: ADDON_RELEASED_SUMMARY_AR });
    expect(w.calls.filter((c) => c.name === "release_job_atomic"), "released once, by the first attempt, never again").toHaveLength(1);
    expect(checkAddonLedger(w, jobId, { reserved: hold(row), charged: "none" })).toEqual([]);
    expect(w.balance()).toBe(START);
    expect(await approve(w, row.id), "a third click finds an ended request").toMatchObject({ ok: false, status: 409 });
    expect(w.calls.filter((c) => c.name === "accept_quote_atomic")).toHaveLength(2);
  });
  it("the WATCHDOG releases an abandoned job (record failed, nobody retried): `recoverAbandonedAddon` ends the request: failed, no charge, points back, ONE event", async () => {
    const { w, row, jobId } = make();
    await abandonedActive(w, row.id);
    expect(w.balance()).toBe(START - hold(row));
    expect(await watchdogReleases(w, jobId)).toMatchObject({ data: { success: true } });
    expect(await recover(w, row.id)).toEqual({ kind: "ended_released" });
    expect(w.missions.get(row.id)).toMatchObject({ status: "failed", error: ADDON_RELEASED_ERROR, charged_points: 0, delivered_units: 0, summary_ar: ADDON_RELEASED_SUMMARY_AR, job_id: jobId, quote_id: addonQuoteId(row.id), lease_until: null, worker_id: null });
    expect(w.events.filter((e) => e.message_ar === ADDON_RELEASED_SUMMARY_AR)).toHaveLength(1);
    expect(checkAddonLedger(w, jobId, { reserved: hold(row), charged: "none" })).toEqual([]);
    expect(w.balance()).toBe(START);
  });
  it("every recovery is IDEMPOTENT: repeated, concurrent and interleaved calls end the request once, write one event, and call no money function", async () => {
    const { w, row, jobId } = make();
    await abandonedActive(w, row.id);
    await watchdogReleases(w, jobId);
    const callsBefore = w.calls.length;
    const outs = await Promise.all([1, 2, 3, 4, 5].map(() => recover(w, row.id)));
    expect(outs.filter((o) => o.kind === "ended_released")).toHaveLength(1);
    expect(outs.filter((o) => o.kind === "not_applicable")).toHaveLength(4);
    expect(await recover(w, row.id)).toEqual({ kind: "not_applicable" });
    expect(w.events.filter((e) => e.message_ar === ADDON_RELEASED_SUMMARY_AR)).toHaveLength(1);
    expect(w.calls.length, "the recovery calls NO money function").toBe(callsBefore);
    expect(w.ledgerReads.length).toBeGreaterThan(0);
  });
  it("after the end, the file is free: a new request is allowed (a NEW attempt number, so a new id), and the workflow status says «not completed, no charge»", async () => {
    const { w, row } = make();
    await abandonedReleased(w, row.id);
    const rows = () => [...w.missions.values()].map((r) => ({ id: r.id, status: r.status, plan: r.plan, job_id: r.job_id ?? null, approved_at: (r.approved_at as string | null | undefined) ?? null }));
    expect(canCreateAddon({ rows: rows(), of: FILE, kind: "review", baseVersion: 1, latestVersion: 1 })).toMatchObject({ ok: false, reason: "open_addon" });
    await recover(w, row.id);
    expect(canCreateAddon({ rows: rows(), of: FILE, kind: "review", baseVersion: 1, latestVersion: 1 })).toEqual({ ok: true, attempt: 2 });
    const r = w.missions.get(row.id)!;
    expect(addonPhaseOf({ id: r.id, status: String(r.status), plan: r.plan, job_id: r.job_id ?? null, approved_at: (r.approved_at as string | null | undefined) ?? null, charged_points: r.charged_points as number, error: r.error as string, created_at: null } as any, { versions: new Set([1]), reviews: new Set() })).toMatchObject({ phase: "failed_no_charge" });
  });
  it("a request that was RELEASED and is `approved` with no job id (the revert failed too) is ended the same way once its one-hour lease has run out", async () => {
    const { w, row, jobId } = make();
    await approvedWithoutJob(w, row.id);
    await watchdogReleases(w, jobId);
    expect(await recover(w, row.id, later())).toEqual({ kind: "ended_released" });
    expect(w.missions.get(row.id)).toMatchObject({ status: "failed", error: ADDON_RELEASED_ERROR, charged_points: 0 });
  });
  it("the customer's sentences for the ended request pass the customer-text check, use the released-hold wording, and never say anything was charged", () => {
    for (const s of [ADDON_RELEASED_SUMMARY_AR, ADDON_APPROVE_MESSAGES_AR.released_before_start]) {
      expect(checkCustomerText(s).issues).toEqual([]);
      expect(s).toMatch(/حجز مؤقت مُحرَّر/); // the owner's released-hold wording, never a refund wording
      expect(s).not.toMatch(/خُصم|سُجّل خصم|اكتمل/);
      expect(s).not.toMatch(/[0-9]/);
    }
  });
});

describe("FIX C: a request whose money is NOT proved released is never ended, never cancelled as unpaid, never released by the recovery", () => {
  it("NEVER APPROVED (waiting, no mark, no job): «unpaid», nothing is read from the money tables and nothing is written", async () => {
    const { w, row } = make();
    expect(await recover(w, row.id)).toEqual({ kind: "unpaid" });
    expect(w.ledgerReads).toEqual([]);
    expect(w.writes).toEqual([]);
  });
  it("RESERVATION POSSIBLY ACTIVE, confirmed active and running: the record is FINISHED from the job's own state (same job, same quote, same hold), the request becomes `approved` for the worker, and no money function is called", async () => {
    const { w, row, jobId } = make();
    await abandonedActive(w, row.id);
    const callsBefore = w.calls.length;
    expect(await recover(w, row.id)).toEqual({ kind: "active", recorded: true });
    expect(w.missions.get(row.id)).toMatchObject({ status: "approved", job_id: jobId, quote_id: addonQuoteId(row.id), reserved_points: hold(row), unit_price_points: 1, lease_until: null, error: null });
    expect(w.calls.length).toBe(callsBefore);
    expect(w.ledger.filter((l) => l.type === "reserve")).toHaveLength(1);
    expect(await recover(w, row.id), "idempotent: the row is recorded now").toEqual({ kind: "not_applicable" });
  });
  it("…and the worker then settles it once: ONE reserve, ONE release, ONE charge, the charge never above the hold, the balance never negative", async () => {
    const { w, row, jobId } = make();
    await abandonedActive(w, row.id);
    await recover(w, row.id);
    const settled = await settleAddon(w.client, { kind: "review", jobId, holdPoints: hold(row), reportStored: true });
    expect(settled.chargePoints).toBeLessThanOrEqual(hold(row));
    expect(checkAddonLedger(w, jobId, { reserved: hold(row), charged: hold(row) })).toEqual([]);
    expect(w.balance()).toBeGreaterThanOrEqual(0);
    expect(await settleAddon(w.client, { kind: "review", jobId, holdPoints: hold(row), reportStored: true }), "a second settlement charges nothing more").toMatchObject({ result: { ok: true } });
    expect(checkAddonLedger(w, jobId, { reserved: hold(row), charged: hold(row) })).toEqual([]);
  });
  it("`approved` with no job id and a LIVE one-hour lease may be an approval still in flight: «not_applicable», nothing written; once the lease has run out the record is finished", async () => {
    const { w, row, jobId } = make();
    await approvedWithoutJob(w, row.id);
    const writes = w.writes.length;
    expect(await recover(w, row.id)).toEqual({ kind: "not_applicable" });
    expect(w.writes.length).toBe(writes);
    expect(await recover(w, row.id, later())).toEqual({ kind: "active", recorded: true });
    expect(w.missions.get(row.id)).toMatchObject({ status: "approved", job_id: jobId });
  });
  it("RESERVED BUT NOT CLAIMED (job queued): «active», NOT recorded (the retry of the approval claims it); the row is untouched", async () => {
    const { w, row } = make();
    await abandonedQueued(w, row.id);
    const before = JSON.stringify(w.missions.get(row.id));
    expect(await recover(w, row.id)).toEqual({ kind: "active", recorded: false });
    expect(JSON.stringify(w.missions.get(row.id))).toBe(before);
    expect((await approve(w, row.id)).ok, "the retry claims the job and converges").toBe(true);
    expect(w.ledger.filter((l) => l.type === "reserve")).toHaveLength(1);
  });
  it("ALREADY SETTLED AND CHARGED: «charged»; the row is NOT ended and NOT cancelled; nothing is written; no money function is called", async () => {
    const { w, row, jobId } = make();
    await abandonedActive(w, row.id);
    await settleAddon(w.client, { kind: "review", jobId, holdPoints: hold(row), reportStored: true });
    const before = JSON.stringify(w.missions.get(row.id)); const calls = w.calls.length; const writes = w.writes.length;
    expect(await recover(w, row.id)).toEqual({ kind: "charged" });
    expect([JSON.stringify(w.missions.get(row.id)), w.calls.length, w.writes.length]).toEqual([before, calls, writes]);
    expect(await cancelUnpaidAddonRow(w.client, { id: row.id, userId: USER }), "a charged request is never cancelled as unpaid").toBe(false);
  });
  it("SETTLED WITH NO CHARGE and the row still waiting, or an inconsistent ledger: «unresolved»; the row is untouched (a person decides)", async () => {
    const a = make(); await abandonedQueued(a.w, a.row.id);
    const job = a.w.jobs.get(a.jobId)!; job.status = "completed"; job.charged_credits = 0;
    a.w.ledger.push({ id: `rel_${a.jobId}`, delta: hold(a.row), type: "release", job_id: a.jobId, user_id: USER });
    expect(await recover(a.w, a.row.id)).toEqual({ kind: "unresolved", why: "settled_without_row" });
    expect(a.w.missions.get(a.row.id)!.status).toBe("plan_ready");
    const b = make(); await abandonedQueued(b.w, b.row.id); b.w.jobs.get(b.jobId)!.status = "failed";
    expect(await recover(b.w, b.row.id)).toEqual({ kind: "unresolved", why: "inconsistent" });
    expect(b.w.missions.get(b.row.id)!.status).toBe("plan_ready");
  });
  it("A DATABASE THAT CANNOT ANSWER (jobs or ledger read fails): «unresolved, read_failed»; nothing is written; the request stays blocking, never freed on a guess", async () => {
    const { w, row } = make();
    await abandonedActive(w, row.id);
    const writes = w.writes.length;
    w.setJobsDown(true);
    expect(await recover(w, row.id)).toEqual({ kind: "unresolved", why: "read_failed" });
    w.setJobsDown(false); w.setLedgerDown(true);
    expect(await recover(w, row.id)).toEqual({ kind: "unresolved", why: "read_failed" });
    expect(w.writes.length).toBe(writes);
    expect(w.missions.get(row.id)!.status).toBe("plan_ready");
  });
  it("MARKED BUT NOTHING RESERVED (the quote could not be made): «no_reservation»; the request stays waiting, so the customer can approve again; nothing is ended", async () => {
    const { w, row } = make();
    w.injectError("create_quote_atomic", "before");
    expect(await approve(w, row.id)).toMatchObject({ ok: false, code: "quote_failed" });
    expect(await recover(w, row.id)).toEqual({ kind: "no_reservation" });
    expect(w.missions.get(row.id)).toMatchObject({ status: "plan_ready" });
    expect((await approve(w, row.id)).ok).toBe(true);
  });
  it("a hold that is not what the code computes for the request: «unresolved, hold_mismatch»; the record is NOT finished from a job that does not match", async () => {
    const { w, row, jobId } = make();
    await abandonedActive(w, row.id);
    w.jobs.get(jobId)!.reserved_credits = hold(row) + 1;
    w.ledger.find((l) => l.id === `res_${jobId}`)!.delta = -(hold(row) + 1);
    expect(await recover(w, row.id)).toEqual({ kind: "unresolved", why: "hold_mismatch" });
    expect(w.missions.get(row.id)!.status).toBe("plan_ready");
  });
  it("another customer's request, a request that is not an add-on, a missing one, and an executing or completed one: «not_applicable», nothing read, nothing written", async () => {
    const { w, row } = make();
    await abandonedActive(w, row.id);
    const writes = w.writes.length;
    expect(await recoverAbandonedAddon(w.client, { id: row.id, userId: "someone-else" })).toEqual({ kind: "not_applicable" });
    expect(await recover(w, "msn_missing")).toEqual({ kind: "not_applicable" });
    w.missions.set("msn_plain", { id: "msn_plain", user_id: USER, status: "plan_ready", plan: { stages: [] }, approved_at: "2026-11-04T00:00:00Z", job_id: null });
    expect(await recover(w, "msn_plain")).toEqual({ kind: "not_applicable" });
    for (const status of ["executing", "completed", "failed", "cancelled"]) { w.missions.get(row.id)!.status = status; expect(await recover(w, row.id)).toEqual({ kind: "not_applicable" }); }
    expect(w.writes.length).toBe(writes);
  });
  it("the recovery touches the missions table and mission_events with writes, the jobs and credit_ledger tables with READS only, and calls no money function, in every state it handles", async () => {
    for (const setup of [abandonedActive, abandonedQueued, abandonedReleased]) {
      const { w, row, jobId } = make();
      await setup(w, row.id);
      if (setup === abandonedActive) await watchdogReleases(w, jobId);
      const calls = w.calls.length; const ledger = JSON.stringify(w.ledger); const jobs = JSON.stringify([...w.jobs.values()]);
      await recover(w, row.id);
      expect(w.calls.length).toBe(calls);
      expect(JSON.stringify(w.ledger)).toBe(ledger);
      expect(JSON.stringify([...w.jobs.values()])).toBe(jobs);
      expect(w.tableCalls.filter((t) => !["missions", "mission_events", "jobs", "credit_ledger"].includes(t))).toEqual([]);
    }
  });
});

describe("FIX C: the customer's file heals itself: `recoverFileAddons` is bounded, best effort and never throws", () => {
  it("it ends the released request of THIS customer's file and leaves a charged one, an unmarked one and another file's request alone", async () => {
    const released = make(); await abandonedReleased(released.w, released.row.id);
    const out = await recoverFileAddons(released.w.client, { missionId: FILE, userId: USER });
    expect(out).toEqual([{ kind: "ended_released" }]);
    expect(released.w.missions.get(released.row.id)!.status).toBe("failed");
    const other = make(); await abandonedReleased(other.w, other.row.id);
    expect(await recoverFileAddons(other.w.client, { missionId: "msn_another_file", userId: USER })).toEqual([]);
    expect(await recoverFileAddons(other.w.client, { missionId: FILE, userId: "someone-else" })).toEqual([]);
    expect(other.w.missions.get(other.row.id)!.status).toBe("plan_ready");
  });
  it("a file with only unmarked or finished add-ons reads the money tables NEVER", async () => {
    const { w, row } = make();
    expect(await recoverFileAddons(w.client, { missionId: FILE, userId: USER })).toEqual([]);
    w.missions.get(row.id)!.status = "completed";
    expect(await recoverFileAddons(w.client, { missionId: FILE, userId: USER })).toEqual([]);
    expect(w.ledgerReads).toEqual([]);
    expect(w.writes).toEqual([]);
  });
  it("it handles at most three add-ons of one file per call (never an unbounded loop), and a failing read of the rows returns nothing instead of throwing", async () => {
    const w = safetyWorld({ balance: START });
    for (let attempt = 1; attempt <= 6; attempt += 1) { const r = addonRowOf({ kind: "review", of: FILE, attempt }); r.approved_at = "2026-11-04T10:00:00.000Z"; w.missions.set(r.id, r); }
    const out = await recoverFileAddons(w.client, { missionId: FILE, userId: USER });
    expect(out).toHaveLength(RECOVERY_MAX_PER_FILE);
    const broken = { from: () => { throw new Error("database down"); } };
    await expect(recoverFileAddons(broken, { missionId: FILE, userId: USER })).resolves.toEqual([]);
  });
  it("called twice, it changes nothing the second time", async () => {
    const { w, row } = make();
    await abandonedReleased(w, row.id);
    await recoverFileAddons(w.client, { missionId: FILE, userId: USER });
    const snapshot = JSON.stringify([[...w.missions.values()], w.events, w.ledger]);
    expect(await recoverFileAddons(w.client, { missionId: FILE, userId: USER })).toEqual([]);
    expect(JSON.stringify([[...w.missions.values()], w.events, w.ledger])).toBe(snapshot);
  });
});
