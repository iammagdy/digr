import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ADDON_RELEASED_ERROR, ADDON_RELEASED_SUMMARY_AR } from "../src/lib/agentMission/addonSettlement";
import { recoverFileAddons } from "../src/lib/agentMission/addonRecovery";
import { STAGE4_FLAGS, stage4FlagMode } from "../src/lib/agentMission/stage4/flags";
import { checkCustomerText } from "../src/lib/agentMission/text";
import { runClaimedSafely } from "../agent/src/stage4/dispatch";
import { runAddonSafely } from "../agent/src/stage4/runAddon";
import { updateRunState } from "../agent/src/runState";
import { AGENT_ERROR_REQUEUES_MAX } from "../src/lib/agentMission/constants";
import { APPROVAL_LEASE_MS, HOLD_WAITS_MAX, resolveUnrecordedHold } from "../agent/src/stage4/unrecordedHold";
import { newMission } from "../agent/src/memoryStore";
import { nicknameAnswer } from "./helpers/addonRunWorld";
import { holdRaceWorld, recordsJob, USER, M12, type HoldRaceWorld } from "./helpers/holdRaceWorld";

/**
 * SAFETY FIX E (docs/STAGE-4-FINANCIAL-SAFETY.md section 4, residual risk 1): THE WORKER ARRIVES BEFORE THE APPROVAL'S LAST UPDATE IS RECORDED. The hold is reserved (res_<job>), the row says `approved` and has no `job_id` / `reserved_points`. Before the fix the worker ended
 * such a paid request `failed` («no plan or no hold») WITHOUT releasing: the customer's points stayed held until the watchdog (job lease 6 h + 30 min). These tests run the REAL approval, the REAL worker runner, the REAL money-state reader and the REAL recovery over the hardened
 * money fake and a fault-injecting database. A row is judged by the money's own state of its deterministic job (never by the missing column); nothing is invented; no provider is called before the job and its hold are verified.
 */
const fetchSpy = vi.fn(() => { throw new Error("a real call was attempted"); });
beforeEach(() => { vi.stubGlobal("fetch", fetchSpy); fetchSpy.mockClear(); });
afterEach(() => vi.unstubAllGlobals());

const START = 100_000;
const REVIEW_FILE = `${M12}/reviews/r0001.json`;
const VERSION_FILE = `${M12}/versions/v0002.json`;
const published = (w: HoldRaceWorld) => [...w.store.files.keys()].filter((k) => k === REVIEW_FILE || k === VERSION_FILE);
const adminNotes = (w: HoldRaceWorld, id: string) => w.events(id).filter((e) => (e.counts as Record<string, number> | undefined)?.adm_flag === 1);
const workerRpcs = (w: HoldRaceWorld) => w.rpcNames();

/** The approval reserved the hold, and the update that records it FAILED, and so did its revert: the row is `approved` (one-hour lease) with no job id, and the job is running. */
async function unrecorded(w: HoldRaceWorld, id: string): Promise<void> {
  w.money.failUpdates({ when: recordsJob, mode: "error_before" });
  w.money.failUpdates({ when: (p) => p.status === "plan_ready", mode: "error_before" });
  expect((await w.approve(id)).ok).toBe(false);
  w.money.clearFaults();
}
/** The worker's next turn on the row: its lease ended, the claim takes it, the runner runs (never throws). */
async function workerTurn(w: HoldRaceWorld, id: string, worker = "worker-1", deps: HoldRaceWorld["deps"] & { now?: () => Date } = w.deps) {
  w.expireLease(id);
  const claimed = await w.claim(worker);
  if (!claimed) return null;
  expect(claimed.id).toBe(id);
  await runAddonSafely(deps, claimed);
  return claimed;
}
/** The approval is long over (older than its own one-hour lease): no approval can still be running. */
const over = (w: HoldRaceWorld): HoldRaceWorld["deps"] & { now: () => Date } => ({ ...w.deps, now: () => new Date(Date.now() + 2 * 3600_000) });
/** The invariants of every scenario, over the whole ledger of the job. */
function invariants(w: HoldRaceWorld, jobId: string, hold: number): void {
  const own = w.money.ledger.filter((r) => r.job_id === jobId);
  for (const t of ["reserve", "release", "charge"]) expect(own.filter((r) => r.type === t).length, `at most one ${t}`).toBeLessThanOrEqual(1);
  expect(new Set(own.map((r) => r.id)).size).toBe(own.length);
  expect(w.money.balance()).toBeGreaterThanOrEqual(0);
  const charge = own.find((r) => r.type === "charge");
  if (charge) expect(-charge.delta).toBeLessThanOrEqual(hold);
  expect(w.countRpc("release_job_atomic", jobId)).toBeLessThanOrEqual(1);
}
/** No customer success without a published file, and no charge for work that was not published unless the row says so honestly. */
function honest(w: HoldRaceWorld, id: string, jobId: string): void {
  const row = w.rowOf(id);
  const charged = w.money.ledger.some((r) => r.job_id === jobId && r.type === "charge");
  if (row.status === "completed") expect(published(w).length).toBeGreaterThan(0);
  if (published(w).length === 0) expect(row.status).not.toBe("completed");
  if (charged && published(w).length === 0) expect(row.error).toMatch(/charged_(not_published|waiting_publish)/);
  expect(w.said(id).join(" ")).not.toMatch(/no plan or no hold/);
}
const completed = (w: HoldRaceWorld, id: string, jobId: string, hold: number) => {
  expect(w.rowOf(id)).toMatchObject({ status: "completed", job_id: jobId, reserved_points: hold });
  expect(w.ledgerCount("reserve", jobId)).toBe(1);
  expect(w.ledgerCount("release", jobId)).toBe(1);
  expect(w.ledgerCount("charge", jobId)).toBe(1);
  expect(w.money.jobs.get(jobId)).toMatchObject({ status: "completed" });
  invariants(w, jobId, hold);
  honest(w, id, jobId);
};

describe("THE EXACT RACE: the hold is reserved, the row has no job id, the worker claims it", () => {
  it("a paid REVIEW: the request is NOT failed «no hold»; the job is verified from the ledger, the record is finished, the review runs, is charged once and published once", async () => {
    const w = await holdRaceWorld({ balance: START });
    const a = w.createRow("review");
    await unrecorded(w, a.id);
    expect(w.rowOf(a.id)).toMatchObject({ status: "approved", job_id: null });
    expect(w.money.jobs.get(a.jobId)).toMatchObject({ status: "running", reserved_credits: a.hold });
    expect(w.money.balance()).toBe(START - a.hold);
    await workerTurn(w, a.id);
    completed(w, a.id, a.jobId, a.hold);
    expect(w.rowOf(a.id).charged_points).toBe(a.hold);
    expect(published(w)).toEqual([REVIEW_FILE]);
    expect(w.money.balance()).toBe(START - a.hold);
    expect(w.call).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a paid EDIT: no provider call happens before the row carries the verified job and hold; then it runs, charges at most the hold, once", async () => {
    const seen: unknown[] = [];
    let w!: HoldRaceWorld;
    let id = "";
    w = await holdRaceWorld({ balance: START, answers: (o) => { seen.push({ job: w.rowOf(id).job_id, hold: w.rowOf(id).reserved_points }); return nicknameAnswer()(o); } });
    const a = w.createRow("edit");
    id = a.id;
    await unrecorded(w, a.id);
    await workerTurn(w, a.id);
    expect(w.call).toHaveBeenCalled();
    for (const s of seen) expect(s).toEqual({ job: a.jobId, hold: a.hold });
    completed(w, a.id, a.jobId, a.hold);
    expect(published(w)).toEqual([VERSION_FILE]);
    expect(w.money.ledger.find((r) => r.job_id === a.jobId && r.type === "charge")!.delta).toBeLessThan(0);
  });

  it("the worker arrives BETWEEN the job's claim and the approval's record (the true interleaving): the worker finishes the record, the request completes once, and the approval's late record is read back as proved", async () => {
    const w = await holdRaceWorld({ balance: START });
    const a = w.createRow("review");
    const orig = w.money.client.rpc;
    let ran = false;
    w.money.client.rpc = async (name: string, args: any) => {
      const out = await orig(name, args);
      if (name === "claim_job_chunk" && !ran) { ran = true; await workerTurn(w, a.id, "worker-race"); }
      return out;
    };
    const result = await w.approve(a.id);
    expect(ran).toBe(true);
    // the row carries exactly this job, quote and hold (the worker wrote them): the approval's read-back proves it, and there is no second reservation
    expect(result.ok).toBe(true);
    completed(w, a.id, a.jobId, a.hold);
    expect(w.countRpc("accept_quote_atomic")).toBe(1);
  });

  it("the worker arrives BEFORE anything is reserved (the approval is still in flight): it WAITS (the row goes back to «approved» with a short lease), calls no money function, and the approval then records normally; the next worker turn completes it", async () => {
    const w = await holdRaceWorld({ balance: START });
    const a = w.createRow("review");
    const orig = w.money.client.rpc;
    let ran = false;
    w.money.client.rpc = async (name: string, args: any) => {
      if (name === "accept_quote_atomic" && !ran) {
        ran = true;
        const before = w.rpcNames().length;
        await workerTurn(w, a.id, "worker-early");
        expect(w.rpcNames().length).toBe(before); // the waiting worker called no money function
        expect(w.rowOf(a.id).status).toBe("approved");
        expect(w.rowOf(a.id).worker_id).toBeNull();
        expect(w.rowOf(a.id).lease_until && Date.parse(w.rowOf(a.id).lease_until!)).toBeGreaterThan(Date.now());
      }
      return orig(name, args);
    };
    expect((await w.approve(a.id)).ok).toBe(true);
    expect(w.money.jobs.get(a.jobId)).toMatchObject({ status: "running" });
    await workerTurn(w, a.id, "worker-late");
    completed(w, a.id, a.jobId, a.hold);
    expect(w.countRpc("accept_quote_atomic")).toBe(1);
  });
});

describe("EVERY FAILURE BOUNDARY OF THE APPROVAL'S LAST UPDATE", () => {
  it("the final update fails (the revert works): the row is `plan_ready`, the worker cannot claim it, the hold stays; the customer's page read finishes the record and the worker completes it once", async () => {
    const w = await holdRaceWorld({ balance: START });
    const a = w.createRow("review");
    w.money.failUpdates({ when: recordsJob, mode: "error_before", times: 3 });
    expect(await w.approve(a.id)).toMatchObject({ ok: false, code: "record_unverified" });
    w.money.clearFaults();
    expect(w.rowOf(a.id).status).toBe("plan_ready");
    expect(await w.claim()).toBeNull();
    expect(w.money.jobs.get(a.jobId)).toMatchObject({ status: "running" });
    expect(await recoverFileAddons(w.money.client, { missionId: M12, userId: USER })).toEqual([{ kind: "active", recorded: true }]);
    await workerTurn(w, a.id);
    completed(w, a.id, a.jobId, a.hold);
  });

  it("the final update COMMITTED and its answer was lost (error, throw, «no row»): the read-back proves it, the row carries the job, and the ordinary path runs with NO ledger read by the worker", async () => {
    for (const mode of ["error_after", "throw_after", "lost_ok_answer"] as const) {
      const w = await holdRaceWorld({ balance: START });
      const a = w.createRow("review");
      w.money.failUpdates({ when: recordsJob, mode, times: 1 });
      expect((await w.approve(a.id)).ok).toBe(true);
      w.money.clearFaults();
      expect(w.rowOf(a.id).job_id).toBe(a.jobId);
      await workerTurn(w, a.id);
      completed(w, a.id, a.jobId, a.hold);
      expect(w.money.ledgerReads, mode).toEqual([]);
    }
  });

  it("the record cannot be written by the worker either (one failure): nothing runs, nothing is failed, the worker waits and the next turn finishes it", async () => {
    const w = await holdRaceWorld({ balance: START });
    const a = w.createRow("edit");
    await unrecorded(w, a.id);
    w.money.failUpdates({ when: recordsJob, mode: "error_before", times: 1 });
    await workerTurn(w, a.id);
    expect(w.call).not.toHaveBeenCalled();
    expect(w.rowOf(a.id).status).toBe("approved");
    expect(w.rowOf(a.id).status).not.toBe("failed");
    expect(published(w)).toEqual([]);
    await workerTurn(w, a.id);
    completed(w, a.id, a.jobId, a.hold);
  });
});

describe("THE RUNNER'S OWN ERROR RECOVERY never ends a paid request on a missing job id either", () => {
  it("a run that threw, with its error requeues used up and no job id on the row: the recovery asks the money state (here: released, proved) instead of failing it «charged, not shown» or «no hold»", async () => {
    const w = await holdRaceWorld({ balance: START });
    const a = w.createRow("review");
    await unrecorded(w, a.id);
    await w.money.client.rpc("release_job_atomic", { p_job_id: a.jobId, p_error_message: "x", p_force: true });
    await updateRunState(w.store, a.id, (s) => ({ ...s, errorRequeues: AGENT_ERROR_REQUEUES_MAX }));
    w.expireLease(a.id);
    const claimed = (await w.claim())!;
    const get = w.store.getMission.bind(w.store);
    let threw = false;
    w.store.getMission = async (id: string) => { if (!threw) { threw = true; throw new Error("the database dropped the read"); } return get(id); };
    await runAddonSafely(w.deps, claimed);
    expect(threw).toBe(true);
    expect(w.rowOf(a.id)).toMatchObject({ status: "failed", error: ADDON_RELEASED_ERROR, charged_points: 0, summary_ar: ADDON_RELEASED_SUMMARY_AR });
    expect(w.rowOf(a.id).summary_ar).not.toMatch(/تعذّر إظهار نتيجة/);
    expect(w.countRpc("release_job_atomic", a.jobId)).toBe(1);
  });
});

describe("THE RESERVATION WAS RELEASED (proved by the ledger): the request is closed accurately, with no charge, and nothing is released again", () => {
  async function released(w: HoldRaceWorld, id: string): Promise<void> {
    w.money.injectError("claim_job_chunk", "before");
    w.money.failUpdates({ when: (p) => p.status === "plan_ready", mode: "error_before" });
    expect((await w.approve(id)).ok).toBe(false);
    w.money.clearFaults();
  }
  it("the approval's own release, then the worker: failed, approval_released, charged 0, the customer's released-hold sentence; the worker calls no money function", async () => {
    const w = await holdRaceWorld({ balance: START });
    const a = w.createRow("review");
    await released(w, a.id);
    expect(w.money.jobs.get(a.jobId)).toMatchObject({ status: "failed" });
    expect(w.money.balance()).toBe(START);
    const before = w.rpcNames().length;
    await workerTurn(w, a.id);
    expect(w.rpcNames().length).toBe(before);
    expect(w.rowOf(a.id)).toMatchObject({ status: "failed", error: ADDON_RELEASED_ERROR, charged_points: 0, delivered_units: 0, summary_ar: ADDON_RELEASED_SUMMARY_AR, job_id: a.jobId, worker_id: null, lease_until: null });
    expect(checkCustomerText(ADDON_RELEASED_SUMMARY_AR).issues).toEqual([]);
    expect(w.said(a.id)).toContain(ADDON_RELEASED_SUMMARY_AR);
    expect(w.ledgerCount("release", a.jobId)).toBe(1);
    expect(w.ledgerCount("charge", a.jobId)).toBe(0);
    expect(w.money.balance()).toBe(START);
    expect(published(w)).toEqual([]);
    invariants(w, a.jobId, a.hold);
  });

  it("the WATCHDOG ran before the worker (a forced release of the running job): the worker finds the release in the ledger and closes the request with no charge; the release happened once", async () => {
    const w = await holdRaceWorld({ balance: START });
    const a = w.createRow("edit");
    await unrecorded(w, a.id);
    const dog = await w.money.client.rpc("release_job_atomic", { p_job_id: a.jobId, p_error_message: "تم إلغاء الطلب تلقائياً", p_force: true });
    expect((dog as any).data.success).toBe(true);
    await workerTurn(w, a.id);
    expect(w.rowOf(a.id)).toMatchObject({ status: "failed", error: ADDON_RELEASED_ERROR, charged_points: 0 });
    expect(w.countRpc("release_job_atomic", a.jobId)).toBe(1);
    expect(w.call).not.toHaveBeenCalled();
    expect(w.money.balance()).toBe(START);
    expect(w.ledgerCount("charge", a.jobId)).toBe(0);
    invariants(w, a.jobId, a.hold);
  });

  it("the worker NEVER closes a request on a release it cannot prove: a failed job with no release row is «unknown» and is not ended", async () => {
    const w = await holdRaceWorld({ balance: START });
    const a = w.createRow("review");
    await unrecorded(w, a.id);
    w.money.jobs.get(a.jobId)!.status = "failed";
    await workerTurn(w, a.id);
    expect(w.rowOf(a.id).status).toBe("plan_ready");
    expect(w.rowOf(a.id).error).toBe("hold_state_unknown");
    expect(w.rowOf(a.id).summary_ar ?? null).toBeNull();
    expect(w.ledgerCount("release", a.jobId)).toBe(0);
  });
});

describe("THE MONEY STATE IS UNCERTAIN: evidence is kept, nothing is declared, nothing runs", () => {
  it("the ledger contradicts the job: the request is handed back to the recovery protocol (`plan_ready`, still marked), an internal note is written, no money function is called, nothing is published or said as success", async () => {
    const w = await holdRaceWorld({ balance: START });
    const a = w.createRow("edit");
    await unrecorded(w, a.id);
    w.money.ledger.splice(w.money.ledger.findIndex((r) => r.id === `res_${a.jobId}`), 1);
    const before = w.rpcNames().length;
    await workerTurn(w, a.id);
    expect(w.rpcNames().length).toBe(before);
    expect(w.rowOf(a.id)).toMatchObject({ status: "plan_ready", error: "hold_state_unknown", worker_id: null, lease_until: null });
    expect(w.rowOf(a.id).approved_at).toBeTruthy();
    expect(adminNotes(w, a.id).length).toBe(1);
    expect(w.call).not.toHaveBeenCalled();
    expect(published(w)).toEqual([]);
    expect(w.events(a.id).filter((e) => e.kind === "result")).toEqual([]);
    expect(await w.claim()).toBeNull();
  });

  it("the database cannot be read (every attempt): BOUNDED waits, then the request is handed back; the reads are bounded; nothing is failed, charged or released; when the database returns the page read finishes it", async () => {
    const w = await holdRaceWorld({ balance: START });
    const a = w.createRow("review");
    await unrecorded(w, a.id);
    w.money.setLedgerDown(true);
    let turns = 0;
    while (w.rowOf(a.id).status === "approved" && turns < HOLD_WAITS_MAX + 5) { await workerTurn(w, a.id); turns += 1; }
    expect(turns).toBe(HOLD_WAITS_MAX + 1);
    expect(w.money.ledgerReads.length).toBeLessThanOrEqual(HOLD_WAITS_MAX + 1);
    expect(w.rowOf(a.id)).toMatchObject({ status: "plan_ready", error: "hold_state_unknown" });
    expect(w.money.jobs.get(a.jobId)).toMatchObject({ status: "running" });
    expect(w.ledgerCount("release", a.jobId) + w.ledgerCount("charge", a.jobId)).toBe(0);
    w.money.setLedgerDown(false);
    expect(await recoverFileAddons(w.money.client, { missionId: M12, userId: USER })).toEqual([{ kind: "active", recorded: true }]);
    await workerTurn(w, a.id);
    completed(w, a.id, a.jobId, a.hold);
  });

  it("the database is down for ONE read: the worker waits and the next turn verifies, records and completes", async () => {
    const w = await holdRaceWorld({ balance: START });
    const a = w.createRow("review");
    await unrecorded(w, a.id);
    w.money.setJobsDown(true);
    await workerTurn(w, a.id);
    expect(w.rowOf(a.id)).toMatchObject({ status: "approved" });
    expect(w.rowOf(a.id).lease_until && Date.parse(w.rowOf(a.id).lease_until!)).toBeGreaterThan(Date.now());
    expect(w.call).not.toHaveBeenCalled();
    w.money.setJobsDown(false);
    await workerTurn(w, a.id);
    completed(w, a.id, a.jobId, a.hold);
  });

  it("a job that is only QUEUED (reserved, never claimed): the worker does not claim or run it; the request goes back to waiting so the approval's retry claims it, and that retry converges on the same hold", async () => {
    const w = await holdRaceWorld({ balance: START });
    const a = w.createRow("review");
    w.money.inject("claim_job_chunk", "before");
    w.money.failUpdates({ when: (p) => p.status === "plan_ready", mode: "error_before" });
    expect((await w.approve(a.id)).ok).toBe(false);
    w.money.clearFaults();
    expect(w.money.jobs.get(a.jobId)).toMatchObject({ status: "queued" });
    const workerCalls = w.rpcNames().length;
    await workerTurn(w, a.id, "worker-1", over(w));
    expect(w.rpcNames().length).toBe(workerCalls);
    expect(w.rowOf(a.id)).toMatchObject({ status: "plan_ready", error: "hold_unclaimed" });
    expect(w.money.jobs.get(a.jobId)).toMatchObject({ status: "queued" });
    expect((await w.approve(a.id)).ok).toBe(true);
    await workerTurn(w, a.id);
    completed(w, a.id, a.jobId, a.hold);
    expect(w.ledgerCount("reserve", a.jobId)).toBe(1);
  });

  it("a hold that is not what the code computes for this request is never adopted", async () => {
    const w = await holdRaceWorld({ balance: START });
    const a = w.createRow("review");
    await unrecorded(w, a.id);
    // the job and its reserve say another hold (a different amount): the code's price (checkAddon) disagrees
    const job = w.money.jobs.get(a.jobId)!;
    const res = w.money.ledger.find((r) => r.id === `res_${a.jobId}`)!;
    job.reserved_credits = a.hold + 7; res.delta = -(a.hold + 7);
    await workerTurn(w, a.id);
    expect(w.rowOf(a.id).status).toBe("plan_ready");
    expect(w.rowOf(a.id).job_id ?? null).toBeNull();
    expect(w.rowOf(a.id).error).toBe("hold_state_unknown");
    expect(published(w)).toEqual([]);
    expect(w.ledgerCount("charge", a.jobId)).toBe(0);
  });
});

describe("NOTHING WAS RESERVED (confirmed) and the approval is old enough to be over: the request goes back to waiting, never failed, never invented", () => {
  it("no job, no ledger row: `plan_ready`, still marked, error hold_not_found; the customer may approve again, twice and recovery twice converge on ONE reservation and ONE charge", async () => {
    const w = await holdRaceWorld({ balance: START });
    const a = w.createRow("review");
    w.money.inject("accept_quote_atomic", "before");
    w.money.failUpdates({ when: (p) => p.status === "plan_ready", mode: "error_before" });
    expect((await w.approve(a.id)).ok).toBe(false);
    w.money.clearFaults();
    expect(w.money.jobs.size).toBe(0);
    const before = w.rpcNames().length;
    await workerTurn(w, a.id, "worker-1", over(w));
    expect(w.rpcNames().length).toBe(before);
    expect(w.money.jobs.size).toBe(0);
    expect(w.money.ledger.filter((r) => r.type !== "topup")).toEqual([]);
    expect(w.rowOf(a.id)).toMatchObject({ status: "plan_ready", error: "hold_not_found", worker_id: null });
    expect(w.rowOf(a.id).approved_at).toBeTruthy();
    expect(w.said(a.id).join(" ")).not.toMatch(/no plan or no hold/);
    for (let i = 0; i < 2; i += 1) expect(await recoverFileAddons(w.money.client, { missionId: M12, userId: USER })).toEqual([{ kind: "no_reservation" }]);
    const [r1, r2] = await Promise.all([w.approve(a.id), w.approve(a.id)]);
    expect([r1.ok, r2.ok].filter(Boolean).length).toBe(1);
    await workerTurn(w, a.id);
    completed(w, a.id, a.jobId, a.hold);
    expect(w.countRpc("accept_quote_atomic")).toBeLessThanOrEqual(3);
  });
});

describe("TWO WORKERS, THE SAME REQUEST", () => {
  it("two runs of the same claimed row at the same moment: one record, one reserve, one release, one charge, one published file", async () => {
    const w = await holdRaceWorld({ balance: START });
    const a = w.createRow("review");
    await unrecorded(w, a.id);
    w.expireLease(a.id);
    const first = (await w.claim("worker-1"))!;
    await Promise.all([runAddonSafely(w.deps, first), runAddonSafely(w.deps, { ...first })]);
    completed(w, a.id, a.jobId, a.hold);
    expect(published(w)).toEqual([REVIEW_FILE]);
  });

  it("a worker whose claim was taken over (another worker owns the row now) writes NOTHING: the resolver leaves the row and the money alone", async () => {
    const w = await holdRaceWorld({ balance: START });
    const a = w.createRow("review");
    await unrecorded(w, a.id);
    w.expireLease(a.id);
    const old = (await w.claim("worker-1"))!;
    const oldSnapshot = { ...old };
    w.expireLease(a.id);
    expect((await w.claim("worker-2"))!.worker_id).toBe("worker-2");
    const snapshot = JSON.stringify(w.rowOf(a.id));
    const calls = w.rpcNames().length;
    expect(await resolveUnrecordedHold(w.deps, oldSnapshot)).toBe("handled");
    expect(JSON.stringify(w.rowOf(a.id))).toBe(snapshot);
    expect(w.rpcNames().length).toBe(calls);
    await runAddonSafely(w.deps, w.rowOf(a.id));
    completed(w, a.id, a.jobId, a.hold);
  });

  it("the approval lease the resolver waits for is the one the real approval writes (one hour)", async () => {
    const w = await holdRaceWorld({ balance: START });
    const a = w.createRow("review");
    const t0 = Date.now();
    await unrecorded(w, a.id);
    const lease = Date.parse(w.rowOf(a.id).lease_until!) - t0;
    expect(Math.abs(lease - APPROVAL_LEASE_MS)).toBeLessThan(5_000);
  });
});

describe("CHARGED, BUT NOT PUBLISHED: the file stays recoverable, also when the row lost its job id", () => {
  const outage = (w: HoldRaceWorld) => {
    const put = w.store.putNewStrict.bind(w.store);
    const state = { down: true };
    w.store.putNewStrict = async (m, p, c, t) => { if (state.down && (p.startsWith("reviews/") || p.startsWith("versions/"))) throw new Error("upload: storage is unavailable"); return put(m, p, c, t); };
    return state;
  };
  it("storage fails after the settlement: charged once, nothing published, never `completed`; storage returns: the very pending bytes are published, nothing is charged or released again", async () => {
    const w = await holdRaceWorld({ balance: START });
    const a = w.createRow("review");
    await unrecorded(w, a.id);
    const down = outage(w);
    await workerTurn(w, a.id);
    expect(w.ledgerCount("charge", a.jobId)).toBe(1);
    expect(published(w)).toEqual([]);
    expect(w.rowOf(a.id).status).not.toBe("completed");
    expect(w.rowOf(a.id).status).not.toBe("failed");
    honest(w, a.id, a.jobId);
    const ledger = JSON.stringify(w.money.ledger);
    (down as { down: boolean }).down = false;
    await workerTurn(w, a.id);
    completed(w, a.id, a.jobId, a.hold);
    expect(JSON.stringify(w.money.ledger)).toBe(ledger);
    const pending = await w.store.getFileBytes(M12, `addons/${a.id}/review.json`);
    expect((await w.store.getFileBytes(M12, "reviews/r0001.json"))!.equals(pending!)).toBe(true);
  });

  it("the row lost its job id AFTER the charge (the file is owed): the worker adopts the CHARGED job, publishes the pending bytes once, and does not charge or release again", async () => {
    const w = await holdRaceWorld({ balance: START });
    const a = w.createRow("review");
    await unrecorded(w, a.id);
    const down = outage(w);
    await workerTurn(w, a.id);
    expect(w.ledgerCount("charge", a.jobId)).toBe(1);
    (down as { down: boolean }).down = false;
    Object.assign(w.rowOf(a.id), { job_id: null, quote_id: null, reserved_points: null, status: "approved", worker_id: null });
    const ledger = JSON.stringify(w.money.ledger);
    await workerTurn(w, a.id);
    completed(w, a.id, a.jobId, a.hold);
    expect(JSON.stringify(w.money.ledger)).toBe(ledger);
  });
});

describe("ORDINARY WORK IS UNCHANGED, THE FLAGS STAY OFF", () => {
  it("an add-on whose approval was recorded runs exactly as before: no ledger or money-state read by the worker, the same ledger", async () => {
    const w = await holdRaceWorld({ balance: START });
    const a = w.createRow("review");
    expect((await w.approve(a.id)).ok).toBe(true);
    await workerTurn(w, a.id);
    completed(w, a.id, a.jobId, a.hold);
    expect(w.money.ledgerReads).toEqual([]);
    expect(w.money.ledger.map((r) => r.type)).toEqual(["topup", "reserve", "release", "charge"]);
  });

  it("an ordinary mission still goes to the mission runner only", async () => {
    const w = await holdRaceWorld();
    const runners = { mission: vi.fn(async () => undefined), addon: vi.fn(async () => undefined) };
    const m = newMission({ id: "msn_ordinary", user_id: USER, status: "executing", plan: { stages: [] } as never });
    await runClaimedSafely(w.deps, m, runners as never);
    expect(runners.mission).toHaveBeenCalledTimes(1);
    expect(runners.addon).not.toHaveBeenCalled();
  });

  it("the Stage 4 flags are OFF when unset, and the new worker code reads no flag and no environment", async () => {
    for (const f of STAGE4_FLAGS) expect(stage4FlagMode(f, {})).toBe("off");
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("agent/src/stage4/unrecordedHold.ts", "utf8");
    expect(src).not.toMatch(/process\.env|DIGER_STAGE4|stage4Enabled|stage4FlagMode/);
  });

  it("the resolver touches no money function and no money table: no rpc, no ledger or jobs access of its own (the money state is read through readJobMoneyState), and only the request's own row is written", async () => {
    const { readFileSync } = await import("node:fs");
    const code = readFileSync("agent/src/stage4/unrecordedHold.ts", "utf8").split("\n").filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("/**") && !l.trim().startsWith("//")).join("\n");
    expect(code).not.toMatch(/\.rpc\(|credit_ledger|"jobs"|plans_quotes|\.insert\(|\.upsert\(|\.delete\(|settleAddon|settleMission/);
    expect([...code.matchAll(/\.from\(\s*([A-Za-z_"]+)/g)].map((m) => m[1])).toEqual(["MISSION_TABLE", "MISSION_TABLE"]);
  });
});
