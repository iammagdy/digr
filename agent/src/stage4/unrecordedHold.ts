import { MISSION_TABLE } from "../../../src/lib/agentMission/constants";
import { ADDON_RELEASED_SUMMARY_AR, addonJobId, addonQuoteId, checkAddon, readAddonPlan, releasedRowPatch } from "../../../src/lib/agentMission/addonSettlement";
import { readJobMoneyState, type JobMoneyState } from "../../../src/lib/agentMission/addonMoneyState";
import type { RunnerDeps } from "../runMission";
import type { MissionRecord } from "../types";
import { ADDON_DONE_AR } from "./addonText";

/**
 * SAFETY FIX E (docs/STAGE-4-FINANCIAL-SAFETY.md section 4a): THE WORKER CLAIMED AN ADD-ON WHOSE APPROVAL IS NOT RECORDED ON THE ROW. The row is `executing` (the worker's claim) but has no `job_id` / `reserved_points`: the approval reserved the hold and its last update (the record) did not land,
 * or has not yet. Before this file the runner ended such a PAID request `failed` («no hold») and never released, so the customer's points stayed held until the watchdog (job lease 6 h + 30 min).
 *
 * A missing column is NOT «nothing is held». This file judges the request by the DATABASE's own state of its DETERMINISTIC job (job_quote_<md5(quote_addon_<row id>)>, the same ids the approval and the recovery compute), read with `readJobMoneyState` (select only), and does the one thing that state proves:
 *   released      the ledger proves the points came back: END the request (`failed`, charge 0, `approval_released`, the customer's released-hold sentence). No money function is called.
 *   active+running the hold is held and the job is claimed: FINISH THE RECORD (same job, quote, hold, checked against the code's own price) and let the run go on. This is the ONLY way the runner goes on, so no provider call is ever made before the job and its hold are verified.
 *   charged       the job was settled and charged (a charged file may be waiting to be published): finish the record and let the run go on; the existing paid-retry publishes the stored bytes. Never ended, never released, never charged again.
 *   none / active+queued, approval maybe still running (it started less than its own lease ago): WAIT, bounded (HOLD_WAITS_MAX turns of HOLD_WAIT_SECONDS, counted in the row's own `error` mark so a restart cannot reset it).
 *   none / active+queued, approval over: hand the request back to `plan_ready` (the approval mark is kept): the customer's retry converges on the same quote and job; the recovery of Fix C judges it again. Never `failed`.
 *   unknown (a read failed: bounded waits, then handed back; the rows contradict each other: handed back at once) and a hold that is not what the code computes: handed back with an internal note and a log line carrying the ids; never ended, never run, nothing published.
 * It calls NO rpc: it never reserves, releases, charges or refunds, so it cannot release twice, charge twice or make a balance negative. Every write is ONE compare-and-set on the request's own row, pinned to `executing`, to THIS worker and to the job column it read, so another worker, the
 * approval's own late record or the watchdog's recovery makes it match nothing (and then it changes nothing). Never throws.
 */
export type HoldDeps = RunnerDeps & { now?: () => Date };
/** Waits of the worker for an approval that may still be running; the fifth turn hands the request back. Bounded in the row itself (`error` = hold_wait:<n>). */
export const HOLD_WAITS_MAX = 4;
export const HOLD_WAIT_SECONDS = 30;
/** The lease the approval puts on its own row (addonSettlement.ts: one hour). An approval younger than this MAY still be running; pinned equal by a test. */
export const APPROVAL_LEASE_MS = 3_600_000;
export const HOLD_WAIT_MARK = "hold_wait:";
export const HOLD_ERRORS = { unknown: "hold_state_unknown", notFound: "hold_not_found", unclaimed: "hold_unclaimed" } as const;

const waitsOf = (error: unknown): number => { const m = typeof error === "string" && error.startsWith(HOLD_WAIT_MARK) ? Number(error.slice(HOLD_WAIT_MARK.length)) : 0; return Number.isInteger(m) && m >= 0 ? m : 0; };

export async function resolveUnrecordedHold(deps: HoldDeps, row: MissionRecord, _opts: { afterRecord?: boolean } = {}): Promise<"verified" | "handled"> {
  try {
    return await resolve(deps, row);
  } catch (e) {
    deps.log?.(`addon_hold_unresolved ${row.id} ${String((e as Error)?.message ?? e).slice(0, 160)}`);
    return "handled";
  }
}

async function resolve(deps: HoldDeps, snapshot: MissionRecord): Promise<"verified" | "handled"> {
  const { store, client } = deps;
  // OWNERSHIP: only the worker that holds the row's claim writes anything. A row that moved on (another worker, the watchdog's recovery, the approval's own record) is left alone.
  const row = await store.getMission(snapshot.id);
  if (!row || row.status !== "executing" || row.worker_id !== snapshot.worker_id) return "handled";
  const me = row.worker_id;
  const quoteId = addonQuoteId(row.id);
  const jobId = addonJobId(quoteId);
  const addon = readAddonPlan(row.plan);
  const check = addon ? checkAddon(row.id, addon) : null;
  const priced = addon && check && check.ok ? { addon, hold: check.holdPoints } : null;

  const mine = (q: any): any => (me ? q.eq("id", row.id).eq("status", "executing").eq("worker_id", me) : q.eq("id", row.id).eq("status", "executing").is("worker_id", null));
  const jobPinned = (q: any): any => (row.job_id ? q.eq("job_id", row.job_id) : q.is("job_id", null));
  const write = async (patch: Record<string, unknown>): Promise<boolean> => {
    try {
      const r = await jobPinned(mine(client.from(MISSION_TABLE).update({ ...patch, updated_at: (deps.now ?? (() => new Date()))().toISOString() }))).select("id");
      return !r?.error && Array.isArray(r?.data) && r.data.length === 1;
    } catch { return false; }
  };
  const note = async (text: string, counts: Record<string, number> = {}): Promise<void> => {
    try { await store.addEvent(row.id, { kind: "call", message_ar: `علامة داخلية للمشرف: ${text}`, counts: { adm_flag: 1, ...counts } }); } catch { /* a lost note changes no money */ }
  };
  const log = (what: string, state?: JobMoneyState): void => deps.log?.(`addon_hold_${what} ${row.id} job ${jobId}${state ? ` state ${state.kind}${"why" in state ? `:${state.why}` : ""}` : ""}`);

  if (row.job_id && row.job_id !== jobId) {
    // a job id on the row that is not this request's deterministic job: nothing here can say which is right
    log("foreign_job");
    await handBack(HOLD_ERRORS.unknown, "رقم المهمة المسجَّل على هذا الطلب لا يطابق مهمته المحسوبة؛ لم يُنفَّذ شيء وبقي للمراجعة.");
    return "handled";
  }

  const state = await readJobMoneyState(client, jobId);
  const waits = waitsOf(row.error);
  const approvedAt = await readApprovedAt();
  const inFlight = approvedAt === "unknown" || approvedAt === null || (deps.now ?? (() => new Date()))().getTime() - approvedAt < APPROVAL_LEASE_MS;

  switch (state.kind) {
    case "released": {
      // the ledger PROVES the release: the request ends with no charge. One compare-and-set; a second worker finds it ended.
      if (await write({ ...releasedRowPatch(jobId, quoteId, state.holdPoints) })) {
        try { await store.addEvent(row.id, { kind: "result", message_ar: ADDON_RELEASED_SUMMARY_AR }); } catch { /* the sentence is on the row */ }
        log("released_closed", state);
      }
      return "handled";
    }
    case "none": {
      if (!priced) {
        // nothing was ever reserved AND the plan is not what the code computes (the approval would refuse it too): the request cannot run, and nothing is held
        if (await write({ status: "failed", error: "the add-on has no valid plan", charged_points: 0, delivered_units: 0, summary_ar: ADDON_DONE_AR.planMismatch, worker_id: null, lease_until: null })) {
          try { await store.addEvent(row.id, { kind: "result", message_ar: ADDON_DONE_AR.planMismatch }); } catch { /* as above */ }
        }
        return "handled";
      }
      return waitOrHandBack(state, HOLD_ERRORS.notFound, inFlight);
    }
    case "active": {
      if (!priced || priced.hold !== state.holdPoints) {
        log("hold_mismatch", state);
        await handBack(HOLD_ERRORS.unknown, "الحجز القائم لهذا الطلب لا يطابق ما يحسبه النظام لسعره؛ لم يُنفَّذ شيء وبقي للمراجعة.", { adm_hold: state.holdPoints });
        return "handled";
      }
      if (state.status !== "running") return waitOrHandBack(state, HOLD_ERRORS.unclaimed, inFlight);
      return (await record(priced.hold)) ? "verified" : waitOrHandBack(state, HOLD_ERRORS.unknown, true);
    }
    case "charged": {
      if (!priced || priced.hold !== state.holdPoints) {
        log("charged_mismatch", state);
        await handBack(HOLD_ERRORS.unknown, "خُصم هذا الطلب وحجزه لا يطابق ما يحسبه النظام؛ لم يُنشر شيء وبقي للمراجعة.", { adm_charged: state.chargedPoints });
        return "handled";
      }
      // a charged file is OWED: the record is finished and the run goes on (it publishes the stored bytes; the settlement is already done and idempotent)
      return (await record(priced.hold)) ? "verified" : waitOrHandBack(state, HOLD_ERRORS.unknown, true);
    }
    case "settled_free": {
      log("settled_without_row", state);
      await handBack(HOLD_ERRORS.unknown, "حُسمت مهمة هذا الطلب بلا خصم ولا يوجد سجل لها على الطلب؛ بقي للمراجعة.");
      return "handled";
    }
    case "unknown": {
      if (state.why === "read_failed") return waitOrHandBack(state, HOLD_ERRORS.unknown, true);
      log("inconsistent", state);
      await handBack(HOLD_ERRORS.unknown, "حالة نقاط هذا الطلب غير متسقة في السجل المالي؛ لم يُنفَّذ شيء ولم يُحرَّر شيء وبقي للمراجعة.");
      return "handled";
    }
  }

  // ---- the writes ----
  async function readApprovedAt(): Promise<number | null | "unknown"> {
    try {
      const { data, error } = await client.from(MISSION_TABLE).select("approved_at").eq("id", row!.id).maybeSingle();
      if (error) return "unknown";
      const t = data?.approved_at ? Date.parse(String(data.approved_at)) : NaN;
      return Number.isFinite(t) ? t : null;
    } catch { return "unknown"; }
  }
  /** Finish the record the approval could not write: this very job, quote and hold, pinned to the claim of this worker. True only when the row now carries exactly them. */
  async function record(hold: number): Promise<boolean> {
    if (await write({ job_id: jobId, quote_id: quoteId, reserved_points: hold, unit_price_points: 1, error: null })) { log("recorded"); return true; }
    // not changed by this call: it counts only when the row ALREADY carries exactly this record (the approval's late record landed first)
    const again = await store.getMission(row!.id);
    return Boolean(again && again.status === "executing" && again.worker_id === me && again.job_id === jobId && again.quote_id === quoteId && Number(again.reserved_points) === hold);
  }
  /** Back to «approved» with a short lease (the claim leaves it alone until then) and one more mark; past HOLD_WAITS_MAX the request is handed back instead. */
  async function waitOrHandBack(state: JobMoneyState, code: string, mayWait: boolean): Promise<"handled"> {
    if (mayWait && waits < HOLD_WAITS_MAX) {
      const until = new Date((deps.now ?? (() => new Date()))().getTime() + HOLD_WAIT_SECONDS * 1000).toISOString();
      if (await write({ status: "approved", worker_id: null, lease_until: until, error: `${HOLD_WAIT_MARK}${waits + 1}` })) log("waiting", state);
      return "handled";
    }
    log("handed_back", state);
    await handBack(code, code === HOLD_ERRORS.unknown ? "تعذّر التحقق من حالة نقاط هذا الطلب؛ لم يُنفَّذ شيء ولم يُحرَّر شيء وبقي للمراجعة." : "");
    return "handled";
  }
  /** The request goes back to `plan_ready` with its approval mark KEPT (nothing is cleared that says money may have moved): the approval's retry and the recovery of Fix C judge it from the money's own state. Never `failed`. */
  async function handBack(code: string, noteText: string, counts: Record<string, number> = {}): Promise<void> {
    if (await write({ status: "plan_ready", worker_id: null, lease_until: null, error: code }) && noteText) await note(noteText, counts);
  }
}
