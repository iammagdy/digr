import { AGENT_ERROR_REQUEUES_MAX, AGENT_MEMORY_REQUEUES_MAX, AGENT_PHASE_STARTS_MAX, AGENT_RESTART_REQUEUES_MAX } from "../../../src/lib/agentMission/constants";
import { checkAddon, readAddonPlan, settleAddon, type AddonKind, type AddonPlan, type AddonSettleInput } from "../../../src/lib/agentMission/addonSettlement";
import { reviewCellsOf, reviewFile } from "../../../src/lib/agentMission/stage4/review";
import type { RunnerDeps } from "../runMission";
import { readRunState, updateRunState, type RunState } from "../runState";
import type { CallRow, MissionRecord } from "../types";
import { JSON_TYPE, pendingReviewPath, readJson, readOutcome, readVersion, reviewPathOf, writeOutcome, type AddonOutcome } from "./addonFiles";
import { ADDON_DONE_AR } from "./addonText";

/**
 * MONEY PR 7a, PHASE 2B-1: THE WORKER'S RUN OF AN APPROVED ADD-ON (a paid review, a review fix, an edit): docs/MONEY-PR-7A.md section 3.0, in THIS order:
 *
 *   1 run                      the review (no provider call) or the re-read, within a provider budget of hold / points per USD, every call recorded under the add-on's own id
 *   2 store the work PENDING   create-only addons/<id>/..., then the OUTCOME (filled, requested, real cost): the inputs of the charge, written once
 *   3 check                    nothing else holds the published path (a zombie version, a review already made): if so, release, no charge, tell the admin
 *   4 settle                   settleAddon: the charge is computed ONLY by addonChargePoints; release first (rel_), then charge (chg_), through the existing settleMission
 *   5 publish                  create-only, from the pending bytes: versions/v<N+1>.json or reviews/r<NNNN>.json
 *   6 the add-on row           completed / unserved / failed, charged points, the sentence; the customer is told through the row's events
 *
 * The work is stored BEFORE the charge and shown AFTER it. A retry finds what it needs in the objects and the ledger: a pending object with a completed job only publishes (no second charge); a job already released (the watchdog) never
 * publishes. The runner never throws to the worker loop (runAddonSafely) and runs any approved add-on whatever the Stage 4 flags say (they gate creation and approval): a hold is never stranded if a flag is switched off mid-run.
 */
type Deps = RunnerDeps & { now?: () => Date };
const clear = { worker_id: null, lease_until: null } as const;
const shortError = (e: unknown): string => String((e as Error)?.message ?? e).slice(0, 300);

/** A claimed row whose plan holds an `addon`: the worker sends it here and every other row to the mission runner. */
export const isAddonMission = (m: { plan?: unknown } | null | undefined): boolean => Boolean(m && typeof m.plan === "object" && m.plan !== null && "addon" in (m.plan as object));

const executionSpend = (calls: CallRow[]) => calls.filter((c) => c.phase === "execution").reduce((n, c) => n + (Number(c.cost_usd) || 0), 0);
const sameBytes = (a: Buffer, b: Buffer) => a.length === b.length && a.equals(b);

/** The job's status, a read only (never a write): null when it cannot be read. */
async function readJob(client: any, jobId: string): Promise<{ status: string; charged: number } | null> {
  try {
    const { data } = await client.from("jobs").select("status,charged_credits").eq("id", jobId).maybeSingle();
    return data ? { status: String(data.status), charged: Number(data.charged_credits ?? 0) } : null;
  } catch { return null; }
}

async function adminNote(deps: Deps, addonId: string, text: string, counts: Record<string, number> = {}): Promise<void> {
  try { await deps.store.addEvent(addonId, { kind: "call", message_ar: `علامة داخلية للمشرف: ${text}`, counts: { adm_flag: 1, ...counts } }); } catch { /* a lost note never changes the ledger */ }
}

// ---------- the requeue (a run cut by memory or a restart goes back to «approved», keeping everything it saved) ----------
type Cause = "memory" | "restart" | "error";
const LIMIT: Record<Cause, number> = { memory: AGENT_MEMORY_REQUEUES_MAX, restart: AGENT_RESTART_REQUEUES_MAX, error: AGENT_ERROR_REQUEUES_MAX };
const COUNTER: Record<Cause, keyof Pick<RunState, "memoryRequeues" | "restartRequeues" | "errorRequeues">> = { memory: "memoryRequeues", restart: "restartRequeues", error: "errorRequeues" };
async function requeue(deps: Deps, id: string, cause: Cause, patch: Record<string, unknown> = {}): Promise<boolean> {
  const state = await readRunState(deps.store, id);
  if (state[COUNTER[cause]] >= LIMIT[cause]) return false;
  await updateRunState(deps.store, id, (s) => ({ ...s, [COUNTER[cause]]: s[COUNTER[cause]] + 1 }), deps.log);
  await deps.store.updateMission(id, { ...patch, status: "approved", ...clear });
  await deps.store.addEvent(id, { kind: "system", message_ar: ADDON_DONE_AR.requeued });
  deps.log?.(`addon_requeue_${cause} ${id}`);
  return true;
}

// ---------- the entry point ----------
/** Never throws. */
export async function runAddonSafely(deps: Deps, mission: MissionRecord): Promise<void> {
  try {
    await runAddon(deps, mission);
  } catch (e) {
    await recoverAddon(deps, mission, e);
  }
}

/** A run that ended with an exception: back to «approved» (counted); past the limit, the hold is released whole (never stranded) and the row ends. Every step is guarded. */
export async function recoverAddon(deps: Deps, mission: MissionRecord, error: unknown): Promise<void> {
  const { store } = deps;
  deps.log?.(`addon_error ${mission.id} ${shortError(error).slice(0, 200)}`);
  try {
    const fresh = (await store.getMission(mission.id)) ?? mission;
    if (fresh.status !== "executing") return;
    if (await requeue(deps, fresh.id, "error", { error: shortError(error) })) return;
    const addon = readAddonPlan(fresh.plan);
    const hold = Number(fresh.reserved_points);
    let released = false;
    if (addon && fresh.job_id && hold >= 1) {
      const s = await settleAddon(deps.client, settleInputOf(addon.kind, fresh.job_id, hold, null, false)).catch(() => null);
      released = Boolean(s?.result.ok);
    }
    await store.updateMission(fresh.id, { status: "failed", error: shortError(error), charged_points: released ? 0 : null, delivered_units: 0, summary_ar: released ? ADDON_DONE_AR.stuck : ADDON_DONE_AR.chargedNotShown, ...clear });
    await store.addEvent(fresh.id, { kind: "result", message_ar: released ? ADDON_DONE_AR.stuck : ADDON_DONE_AR.chargedNotShown });
  } catch (e) {
    deps.log?.(`addon_recovery_failed ${mission.id} ${shortError(e).slice(0, 120)}`);
  }
}

/** The settlement input that releases the whole hold (nothing filled / the report not stored) or, with `outcome`, charges what the run found. */
function settleInputOf(kind: AddonKind, jobId: string, hold: number, outcome: AddonOutcome | null, charge: boolean, settings?: AddonPlan["pricing"]["settings"]): AddonSettleInput {
  if (kind === "review") return { kind: "review", jobId, holdPoints: hold, reportStored: charge && outcome !== null && outcome.filled > 0 };
  return { kind, jobId, holdPoints: hold, realCostUsd: charge && outcome ? outcome.realCostUsd : 0, filled: charge && outcome ? outcome.filled : 0, requested: outcome?.requested ?? 1, ...(settings ? { settings } : {}) };
}

// ---------- the run ----------
export async function runAddon(deps: Deps, mission: MissionRecord): Promise<void> {
  const { store } = deps;
  const row = (await store.getMission(mission.id)) ?? mission;
  if (row.status !== "executing") return;
  const addon = readAddonPlan(row.plan);
  const jobId = row.job_id;
  const hold = Number(row.reserved_points);
  if (!addon || !jobId || !(hold >= 1)) {
    await store.updateMission(row.id, { status: "failed", error: "the add-on has no plan or no hold", summary_ar: ADDON_DONE_AR.planMismatch, ...clear });
    await store.addEvent(row.id, { kind: "result", message_ar: ADDON_DONE_AR.planMismatch });
    return;
  }
  const check = checkAddon(row.id, addon);
  const starts = await updateRunState(store, row.id, (r) => ({ ...r, executionStarts: r.executionStarts + 1 }), deps.log);
  const startsExceeded = starts.executionStarts > AGENT_PHASE_STARTS_MAX;
  const job = await readJob(deps.client, jobId);

  // a plan that is not what the code computes, or a job the watchdog already released: nothing is run, nothing is spent
  let outcome = await readOutcome(store, addon.of, row.id);
  if (!check.ok || check.holdPoints !== hold) return finish(deps, row, addon, jobId, hold, { kind: "release", reason: "plan_mismatch" });
  if (job?.status === "failed") return finish(deps, row, addon, jobId, hold, { kind: "release", reason: "released_earlier" });

  if (!outcome && job?.status !== "completed") {
    const made = addon.kind === "review" ? await reviewWork(deps, row, addon, hold) : await editWork(deps, row, addon, jobId, hold, startsExceeded);
    if (made === "interrupted") return;
    outcome = made;
  }
  if (!outcome) {
    // a settled job with no outcome (it cannot happen: the outcome is written before the settlement): nothing is published and the admin is told
    await adminNote(deps, row.id, "حُسمت مهمة هذا الطلب ولا نتيجة محفوظة له.", { adm_charged: job?.charged ?? 0 });
    await store.updateMission(row.id, { status: "failed", error: "charged_not_published", charged_points: job?.charged ?? null, summary_ar: ADDON_DONE_AR.chargedNotShown, ...clear });
    await store.addEvent(row.id, { kind: "result", message_ar: ADDON_DONE_AR.chargedNotShown });
    return;
  }
  return finish(deps, row, addon, jobId, hold, { kind: "settle", outcome });
}

const nothing = (addon: AddonPlan, row: MissionRecord, reason: NonNullable<AddonOutcome["reason"]>, stop: AddonOutcome["stop"], realCostUsd: number, now: Date): AddonOutcome => ({
  v: 1, kind: addon.kind, addonId: row.id, of: addon.of, baseVersion: addon.baseVersion, newVersion: addon.newVersion, filled: 0, requested: addon.pricing.requested, realCostUsd, stop, reason, pending: null, publishAt: null, createdAt: now.toISOString(),
});

// ---------- the review: no provider call ----------
async function reviewWork(deps: Deps, row: MissionRecord, addon: AddonPlan, _hold: number): Promise<AddonOutcome> {
  const { store } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const base = await readVersion(store, addon.of, addon.baseVersion);
  if (!base) return writeOutcome(store, nothing(addon, row, "no_base", null, 0, now));
  if (reviewCellsOf(base) !== addon.pricing.cells) return writeOutcome(store, nothing(addon, row, "mismatch", null, 0, now));
  // D11: a second review of the same version is free; the first one's report stands
  const published = await readJson<{ addonId?: string }>(store, addon.of, reviewPathOf(base.version)).catch(() => null);
  if (published && published.addonId !== row.id) return writeOutcome(store, nothing(addon, row, "review_exists", null, 0, now));
  const result = reviewFile(base);
  const report = { v: 1, addonId: row.id, missionId: addon.of, version: base.version, baseDigest: base.digest, createdAt: now.toISOString(), ...result };
  const put = await store.putNewStrict(addon.of, pendingReviewPath(row.id), JSON.stringify(report), JSON_TYPE);
  void put; // the first pending report stands (a cut run's), whichever run wrote it
  return writeOutcome(store, { v: 1, kind: "review", addonId: row.id, of: addon.of, baseVersion: addon.baseVersion, newVersion: null, filled: 1, requested: 1, realCostUsd: 0, stop: null, reason: null, pending: pendingReviewPath(row.id), publishAt: reviewPathOf(base.version), createdAt: now.toISOString() });
}

// ---------- an edit or a review fix (the re-read comes in the next commit: until then it is released whole, nothing spent) ----------
async function editWork(deps: Deps, row: MissionRecord, addon: AddonPlan, _jobId: string, _hold: number, _startsExceeded: boolean): Promise<AddonOutcome | "interrupted"> {
  return writeOutcome(deps.store, nothing(addon, row, "nothing", null, 0, (deps.now ?? (() => new Date()))()));
}

// ---------- check, settle, publish, tell ----------
type Ending = { kind: "release"; reason: "plan_mismatch" | "released_earlier" } | { kind: "settle"; outcome: AddonOutcome };

async function finish(deps: Deps, row: MissionRecord, addon: AddonPlan, jobId: string, hold: number, ending: Ending): Promise<void> {
  const { store, client } = deps;
  const of = addon.of;
  const outcome = ending.kind === "settle" ? ending.outcome : null;
  const workable = Boolean(outcome && outcome.filled > 0 && outcome.pending && outcome.publishAt);
  let pendingBytes: Buffer | null = null;
  let zombie = false;
  let alreadyPublished = false;
  if (workable && outcome) {
    pendingBytes = await store.getFileBytes(of, outcome.pending!);
    if (!pendingBytes) throw new Error("the pending work is not in the folder");
    const there = await store.getFileBytes(of, outcome.publishAt!);
    if (there) { if (sameBytes(there, pendingBytes)) alreadyPublished = true; else zombie = true; }
  }
  const charging = ending.kind === "settle" && workable && !zombie;
  const settled = await settleAddon(client, settleInputOf(addon.kind, jobId, hold, outcome, charging, addon.pricing.settings));
  let charged = 0;
  let released = false;
  let failedEarlier = ending.kind === "release" && ending.reason === "released_earlier";
  if (settled.result.ok) {
    if (settled.result.kind === "settled") charged = settled.result.chargedPoints; else released = true;
  } else {
    // a refused settlement: read the job to tell a hold the watchdog already released (never publish) from one that was settled before (publish) from a call that only failed (retry)
    const job = await readJob(client, jobId);
    if (job?.status === "failed") { failedEarlier = true; released = true; }
    else if (job?.status === "completed") charged = job.charged;
    else throw new Error(`settlement ${settled.result.code}`);
  }

  // PUBLISH, only after the charge, only from the pending bytes, never over another object
  let publishedNow = false;
  if (charged > 0 && workable && !zombie && outcome && pendingBytes) {
    if (alreadyPublished) publishedNow = true;
    else {
      const put = await store.putNewStrict(of, outcome.publishAt!, pendingBytes, JSON_TYPE);
      if (put.created) publishedNow = true;
      else {
        const there = await store.getFileBytes(of, outcome.publishAt!);
        if (there && sameBytes(there, pendingBytes)) publishedNow = true;
        else { zombie = true; await adminNote(deps, row.id, "نُسخة أخرى سبقت نشر هذا الطلب بعد الخصم؛ لم يُستبدل شيء.", { adm_charged: charged }); }
      }
    }
  }
  if (outcome?.reason === "version_exists") await adminNote(deps, row.id, "وُجدت نسخة على مسار هذا الطلب قبل تشغيله؛ لم يُصرف شيء وحُرّر الحجز كاملًا.");
  if (zombie && released) await adminNote(deps, row.id, "وُجد عنصر منشور على المسار نفسه قبل التسوية؛ حُرّر الحجز كاملًا ولم يُنشر شيء.");
  if (zombie && charged > 0 && !publishedNow) await adminNote(deps, row.id, "خُصم الطلب وفي المسار عنصر آخر؛ يلزم مراجعة المشرف.", { adm_charged: charged });

  const filled = publishedNow ? (outcome?.filled ?? 0) : 0;
  // completed: the work is published. A charge with nothing shown, or a hold the watchdog released first, or a plan that is not what the code computes: failed. A release with nothing to show: unserved.
  const mismatch = ending.kind === "release" && ending.reason === "plan_mismatch";
  const status = publishedNow ? "completed" : charged > 0 || failedEarlier || mismatch ? "failed" : "unserved";
  const sentence = sentenceOf({ addon, outcome, charged, publishedNow, zombie, failedEarlier, mismatch });
  await store.updateMission(row.id, { status, delivered_units: filled, charged_points: charged, summary_ar: sentence.at(-1) ?? null, error: charged > 0 && !publishedNow ? "charged_not_published" : zombie ? "version_exists" : null, execution_treg_usd: Number((outcome?.realCostUsd ?? 0).toFixed(6)), ...clear });
  for (const line of sentence) await store.addEvent(row.id, { kind: "result", message_ar: line, counts: { delivered: filled, charged_points: charged } });
}

function sentenceOf(a: { addon: AddonPlan; outcome: AddonOutcome | null; charged: number; publishedNow: boolean; zombie: boolean; failedEarlier: boolean; mismatch: boolean }): string[] {
  const { addon, outcome } = a;
  if (a.publishedNow && addon.kind === "review") return [ADDON_DONE_AR.reviewDone(a.charged)];
  if (a.publishedNow) {
    const partial = outcome ? outcome.filled < outcome.requested || outcome.stop !== null : false;
    const version = outcome?.newVersion ?? addon.newVersion ?? 0;
    return [...(outcome?.stop === "daily_cap" ? [ADDON_DONE_AR.dailyCap] : []), partial ? ADDON_DONE_AR.versionPartial(version, a.charged) : ADDON_DONE_AR.versionDone(version, a.charged)];
  }
  if (a.charged > 0) return [ADDON_DONE_AR.chargedNotShown];
  if (a.mismatch) return [ADDON_DONE_AR.planMismatch];
  if (a.failedEarlier) return [ADDON_DONE_AR.releasedEarlier];
  if (addon.kind === "review") return [outcome?.reason === "review_exists" ? ADDON_DONE_AR.reviewExists : ADDON_DONE_AR.reviewFailed];
  if (a.zombie || outcome?.reason === "version_exists") return [ADDON_DONE_AR.versionExists];
  return [...(outcome?.stop === "daily_cap" ? [ADDON_DONE_AR.dailyCap] : []), ADDON_DONE_AR.nothingFound];
}
