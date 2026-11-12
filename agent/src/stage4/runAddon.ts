import { AGENT_ERROR_REQUEUES_MAX, AGENT_MEMORY_REQUEUES_MAX, AGENT_PHASE_STARTS_MAX, AGENT_RESTART_REQUEUES_MAX, AGENT_EXECUTION_WALL_MS } from "../../../src/lib/agentMission/constants";
import { assertOwned } from "../ownership";
import { addonProviderBudgetUsd, checkAddon, readAddonPlan, settleAddon, type AddonKind, type AddonPlan, type AddonSettleInput } from "../../../src/lib/agentMission/addonSettlement";
import type { AddonRequest } from "../../../src/lib/agentMission/stage4/addonRow";
import { EDIT_NOT_SEARCHED_AR, applyEditCore, type EditRequest } from "../../../src/lib/agentMission/stage4/editCore";
import { reviewCellsOf, reviewFile, type ReviewIssue } from "../../../src/lib/agentMission/stage4/review";
import { cellText, isRealValue, readRecipe, type RereadRecipe } from "../../../src/lib/agentMission/stage4/reread";
import type { FileVersion } from "../../../src/lib/agentMission/stage4/versions";
import { createJobCallBudget } from "../../../src/lib/server/callBudget";
import { createGateway } from "../gateway";
import type { RunnerDeps } from "../runMission";
import { readRunState, updateRunState, type RunState } from "../runState";
import { trackRun, untrackRun } from "../sessions";
import type { CallRow, MissionRecord } from "../types";
import { JSON_TYPE, type AddonFreeze, pendingReviewPath, pendingVersionPath, readFreeze, readJsonOrNull, readOutcome, writeFreeze, readVersion, reviewPathOf, versionPathOf, writeOutcome, type AddonOutcome } from "./addonFiles";
import { ADDON_DONE_AR } from "./addonText";
import { runReread, type RereadUnit } from "./rereadRun";
import { resolveUnrecordedHold } from "./unrecordedHold";

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

const lastSeq = (calls: CallRow[]) => calls.reduce((n, c) => Math.max(n, Number(/call_(\d+)$/.exec(c.id)?.[1] ?? 0)), 0);
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

// ---------- a CHARGED file that could not be published yet ----------
/** The paid retries before a charged file that can never be shown is given up (the administrator refunds by hand). With the waits below this is about a day. */
export const ADDON_PAID_PARKS_MAX = 48;
const PARK_FIRST_WAIT_S = 30;
const PARK_LONGEST_WAIT_S = 1800;
const WAITING_MARK = "charged_waiting_publish";
const paidOf = (job: { status: string; charged: number } | null): boolean => job?.status === "completed" && job.charged > 0;

/**
 * The points are charged and the file is not shown (storage failed, or the folder could not be read): the file is OWED. The row goes back to «approved» with its lease in the future (the claim leaves it alone until then; the wait
 * doubles up to half an hour), nothing is released or charged again, and the next run only publishes the pending bytes. The customer and the administrator are told once. Past ADDON_PAID_PARKS_MAX tries the row ends «failed» with
 * a note for the administrator: the charge stays and is refunded by hand.
 */
async function parkPaid(deps: Deps, row: MissionRecord, error: unknown, charged: number): Promise<void> {
  const { store } = deps;
  const state = await updateRunState(store, row.id, (s) => ({ ...s, errorRequeues: s.errorRequeues + 1 }), deps.log);
  if (state.errorRequeues > ADDON_PAID_PARKS_MAX) {
    await adminNote(deps, row.id, "خُصم هذا الطلب ولم يُنشر ملفه بعد كل المحاولات؛ يلزم ردّ النقاط يدويًا بعد مراجعة المشرف.", { adm_charged: charged });
    await store.updateMission(row.id, { status: "failed", error: "charged_not_published", charged_points: charged, delivered_units: 0, summary_ar: ADDON_DONE_AR.chargedNotShown, ...clear });
    await store.addEvent(row.id, { kind: "result", message_ar: ADDON_DONE_AR.chargedNotShown });
    return;
  }
  const wait = Math.min(PARK_FIRST_WAIT_S * 2 ** Math.min(state.errorRequeues - 1, 10), PARK_LONGEST_WAIT_S);
  const first = row.error !== WAITING_MARK;
  await store.updateMission(row.id, { status: "approved", worker_id: null, lease_until: new Date(Date.now() + wait * 1000).toISOString(), error: WAITING_MARK, charged_points: charged });
  if (first) {
    await adminNote(deps, row.id, "خُصم هذا الطلب ولم يُنشر ملفه بعد؛ يُعاد النشر تلقائيًا ويُراجَع إن طال.", { adm_charged: charged });
    await store.addEvent(row.id, { kind: "system", message_ar: ADDON_DONE_AR.paidPublishing });
  }
  deps.log?.(`addon_paid_parked ${row.id} try ${state.errorRequeues} wait ${wait}s ${shortError(error).slice(0, 120)}`);
}

// ---------- the entry point ----------
/** Never throws. */
export async function runAddonSafely(deps: Deps, mission: MissionRecord): Promise<void> {
  try {
    await runAddon(deps, mission);
  } catch (e) {
    // another worker owns this row now (ownership.ts): its recovery is that worker's, nothing is written here
    if (deps.leaseLost?.()) { deps.log?.(`lease_lost_stop ${mission.id}: no recovery, another worker owns it`); return; }
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
    // a CHARGED add-on is never released, never failed for good while its file can still be published: it waits and is retried
    const before = fresh.job_id ? await readJob(deps.client, fresh.job_id) : null;
    if (paidOf(before)) return parkPaid(deps, fresh, error, before!.charged);
    if (await requeue(deps, fresh.id, "error", { error: shortError(error) })) return;
    // the row does not say what is held: not «nothing is held» and never «lost»: the money's own state decides (unrecordedHold.ts)
    if (!fresh.job_id || !(Number(fresh.reserved_points) >= 1)) { await resolveUnrecordedHold(deps, fresh); return; }
    const addon = readAddonPlan(fresh.plan);
    const hold = Number(fresh.reserved_points);
    let released = false;
    if (addon && fresh.job_id && hold >= 1) {
      assertOwned(deps.leaseLost, mission.id);
      const s = await settleAddon(deps.client, settleInputOf(addon.kind, fresh.job_id, hold, null, false)).catch(() => null);
      released = Boolean(s?.result.ok);
    }
    if (!released && fresh.job_id) {
      // the release was refused: the job may have been charged in the meantime, or its state cannot be read: never end a possibly charged file as lost
      const now = await readJob(deps.client, fresh.job_id);
      if (now === null || paidOf(now)) return parkPaid(deps, fresh, error, now?.charged ?? 0);
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
export async function runAddon(deps: Deps, mission: MissionRecord, afterRecord = false): Promise<void> {
  const { store } = deps;
  const row = (await store.getMission(mission.id)) ?? mission;
  if (row.status !== "executing") return;
  const addon = readAddonPlan(row.plan);
  const jobId = row.job_id;
  const hold = Number(row.reserved_points);
  if (!addon || !jobId || !(hold >= 1)) {
    // the row does not say what is held: that is NOT «nothing is held». The money's own state decides (unrecordedHold.ts); the run goes on only when it was verified
    if ((await resolveUnrecordedHold(deps, row, { afterRecord })) !== "verified" || afterRecord) return;
    return runAddon(deps, mission, true);
  }
  const check = checkAddon(row.id, addon);
  // WHO OWNS THE ROW: the worker that claimed it. When its lease ends and another worker claims the row, the row's worker id changes: the old worker then stops spending and stops telling the customer (what it already stored is harmless: every object is create-only)
  const me = row.worker_id;
  const owns = async (): Promise<boolean> => { if (!me) return true; const now = await store.getMission(row.id); return Boolean(now && now.status === "executing" && now.worker_id === me); };
  const starts = await updateRunState(store, row.id, (r) => ({ ...r, executionStarts: r.executionStarts + 1 }), deps.log);
  const startsExceeded = starts.executionStarts > AGENT_PHASE_STARTS_MAX;
  const job = await readJob(deps.client, jobId);

  // a plan that is not what the code computes, or a job the watchdog already released: nothing is run, nothing is spent
  let outcome = await readOutcome(store, addon.of, row.id);
  if (!check.ok || check.holdPoints !== hold) return finish(deps, row, addon, jobId, hold, { kind: "release", reason: "plan_mismatch" }, owns);
  if (job?.status === "failed") return finish(deps, row, addon, jobId, hold, { kind: "release", reason: "released_earlier" }, owns);

  if (!outcome && job?.status !== "completed") {
    const made = addon.kind === "review" ? await reviewWork(deps, row, addon) : await editWork(deps, row, addon, jobId, hold, startsExceeded, owns);
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
  return finish(deps, row, addon, jobId, hold, { kind: "settle", outcome }, owns);
}

const nothing = (addon: AddonPlan, row: MissionRecord, reason: NonNullable<AddonOutcome["reason"]>, stop: AddonOutcome["stop"], realCostUsd: number, now: Date): AddonOutcome => ({
  v: 1, kind: addon.kind, addonId: row.id, of: addon.of, baseVersion: addon.baseVersion, newVersion: addon.newVersion, filled: 0, requested: addon.pricing.requested, realCostUsd, stop, reason, pending: null, publishAt: null, createdAt: now.toISOString(),
});

// ---------- the review: no provider call ----------
async function reviewWork(deps: Deps, row: MissionRecord, addon: AddonPlan): Promise<AddonOutcome> {
  const { store } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const base = await readVersion(store, addon.of, addon.baseVersion);
  if (!base) return writeOutcome(store, nothing(addon, row, "no_base", null, 0, now));
  if (reviewCellsOf(base) !== addon.pricing.cells) return writeOutcome(store, nothing(addon, row, "mismatch", null, 0, now));
  // D11: a second review of the same version is free; the first one's report stands
  const published = await readJsonOrNull<{ addonId?: string }>(store, addon.of, reviewPathOf(base.version));
  if (published && published.addonId !== row.id) return writeOutcome(store, nothing(addon, row, "review_exists", null, 0, now));
  const result = reviewFile(base);
  const report = { v: 1, addonId: row.id, missionId: addon.of, version: base.version, baseDigest: base.digest, createdAt: now.toISOString(), ...result };
  // the first pending report stands (a cut run's), whichever run wrote it
  await store.putNewStrict(addon.of, pendingReviewPath(row.id), JSON.stringify(report), JSON_TYPE);
  return writeOutcome(store, { v: 1, kind: "review", addonId: row.id, of: addon.of, baseVersion: addon.baseVersion, newVersion: null, filled: 1, requested: 1, realCostUsd: 0, stop: null, reason: null, pending: pendingReviewPath(row.id), publishAt: reviewPathOf(base.version), createdAt: now.toISOString() });
}

// ---------- an edit or a review fix ----------
async function editWork(deps: Deps, row: MissionRecord, addon: AddonPlan, jobId: string, hold: number, startsExceeded: boolean, owns: () => Promise<boolean>): Promise<AddonOutcome | "interrupted"> {
  const { store } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const calls = await store.listCalls(row.id);
  const base = await readVersion(store, addon.of, addon.baseVersion);
  if (!base) return writeOutcome(store, nothing(addon, row, "no_base", null, executionSpend(calls), now));
  // a version already holds the path this edit would publish (another writer got there first): nothing is spent, the hold comes back
  if (addon.newVersion !== null && (await store.getFile(addon.of, versionPathOf(addon.newVersion))) !== null) return writeOutcome(store, nothing(addon, row, "version_exists", null, executionSpend(calls), now));
  const plan = unitsOf(addon, base);
  if (!plan || (plan.units.length > 0 && plan.units.length !== addon.pricing.requested)) return writeOutcome(store, nothing(addon, row, "mismatch", null, executionSpend(calls), now));
  // THE FREEZE IS THE SETTLEMENT SNAPSHOT: the version AND the real cost that paid for it, in one create-only object. A run that finds one makes no re-read and builds no other version: everything is read from it.
  const pendingAt = pendingVersionPath(row.id, base.version + 1);
  const frozen = await readFreeze(store, addon.of, row.id);
  if (frozen) return settleFrozen(deps, row, addon, base, plan, frozen, pendingAt, now);
  // a pending version with no freeze is not something this code writes: it cannot be tied to a cost, so it is never charged for nor published
  if (await store.getFileBytes(addon.of, pendingAt)) return inconsistent(deps, row, "نسخة معلّقة بلا لقطة تسوية لهذا الطلب؛ لم يُخصم ولم يُنشر شيء وبقيت للمراجعة.");

  let values = new Map<string, string | null>();
  let stop: AddonOutcome["stop"] = null;
  if (plan.units.length > 0) {
    const budget = createJobCallBudget({ ceilingUsd: addonProviderBudgetUsd(hold, addon.pricing.settings), spentUsd: executionSpend(calls) });
    const access = await deps.resolveAccess(row.user_id);
    const gateway = createGateway({ store, client: deps.client, missionId: row.id, userId: row.user_id, jobId, phase: "execution", access, catalog: deps.catalog, budget, recorder: deps.recorder, commit: deps.commit, call: deps.call, token: deps.token, defaultPurpose: row.request_text, counter: { seq: lastSeq(calls) } });
    const tracked = trackRun(row.id);
    try {
      const got = await runReread({ store, gateway, catalog: deps.catalog, of: addon.of, addonId: row.id, base, sheet: plan.sheet, units: plan.units, deadlineMs: startsExceeded ? 0 : Date.now() + AGENT_EXECUTION_WALL_MS, shouldStop: () => tracked.reason.value !== null, lost: async () => !(await owns()), log: deps.log });
      values = got.values;
      // another worker owns the row now: stop here, spend nothing more, touch nothing (the row is its)
      if (got.stop === "lost") return "interrupted";
      if (got.stop === "interrupted") {
        const cause: Cause = tracked.reason.value === "memory" ? "memory" : "restart";
        // out of requeues: finish with what is saved (settled like any other end)
        if (await requeue(deps, row.id, cause)) return "interrupted";
        stop = "deadline";
      } else stop = got.stop;
    } finally {
      untrackRun(tracked);
    }
  }
  const realCostUsd = executionSpend(await store.listCalls(row.id));
  const built = buildVersion(addon, base, plan, values, now);
  if (!built || built.filled === 0) return writeOutcome(store, nothing(addon, row, "nothing", stop, realCostUsd, now));
  if (!(await owns())) return "interrupted";
  const freeze = await writeFreeze(store, { v: 1, addonId: row.id, of: addon.of, version: built.version, realCostUsd, stop, createdAt: now.toISOString() });
  return settleFrozen(deps, row, addon, base, plan, freeze, pendingAt, now);
}

/** An object that cannot be tied to this add-on: nothing is invented, charged or published; the administrator is told, the run stops with an error and the existing recovery takes over (requeue, then the whole hold comes back); the object stays as evidence. */
async function inconsistent(deps: Deps, row: MissionRecord, noteAr: string): Promise<never> {
  await adminNote(deps, row.id, noteAr);
  throw new Error("the stored work does not match this add-on");
}

/**
 * The outcome of a FROZEN version. What it holds is decided by the freeze alone: `filled` is the number of REAL values IN THE FROZEN VERSION, found by rebuilding it from its own cells over the base and requiring the very same bytes (so
 * the object is exactly what this add-on's request makes of this base: right mission, version, parent, digest and cells), and the real cost is the one taken at the moment of the freeze. Calls recorded later (another worker's) are
 * not part of it. The pending object is written from the freeze (create-only; one that exists must hold the same bytes), then the outcome (first writer wins).
 */
async function settleFrozen(deps: Deps, row: MissionRecord, addon: AddonPlan, base: FileVersion, plan: UnitPlan, freeze: AddonFreeze, path: string, now: Date): Promise<AddonOutcome> {
  const { store } = deps;
  const text = JSON.stringify(freeze.version);
  const filled = freeze.of === addon.of ? frozenFilled(addon, base, plan, Buffer.from(text, "utf8")) : null;
  if (filled === null) return inconsistent(deps, row, "لقطة التسوية المحفوظة لهذا الطلب لا تطابق ما طُلب؛ لم يُخصم ولم يُنشر شيء وبقيت للمراجعة.");
  const put = await store.putNewStrict(addon.of, path, text, JSON_TYPE);
  if (!put.created) {
    const there = await store.getFileBytes(addon.of, path);
    if (!there || !sameBytes(there, Buffer.from(text, "utf8"))) return inconsistent(deps, row, "النسخة المعلّقة لهذا الطلب تخالف لقطة التسوية؛ لم يُخصم ولم يُنشر شيء وبقيت للمراجعة.");
  }
  return writeOutcome(store, { v: 1, kind: addon.kind, addonId: row.id, of: addon.of, baseVersion: addon.baseVersion, newVersion: base.version + 1, filled, requested: addon.pricing.requested, realCostUsd: freeze.realCostUsd, stop: freeze.stop, reason: null, pending: path, publishAt: versionPathOf(base.version + 1), createdAt: now.toISOString() });
}

/** The number of real values in a stored pending version, or null when the bytes are not exactly the version this request makes of this base (or hold no real value: a run never stores such a version). */
function frozenFilled(addon: AddonPlan, base: FileVersion, plan: UnitPlan, bytes: Buffer): number | null {
  try {
    const text = bytes.toString("utf8");
    const stored = JSON.parse(text) as FileVersion;
    const sheet = stored.sheets.find((s) => s.nameAr === plan.sheet);
    if (!sheet) return null;
    const rowById = new Map(sheet.rows.map((r) => [r.id, r]));
    const values = new Map<string, string | null>();
    for (const u of plan.units) {
      const at = sheet.headers.indexOf(plan.shape === "add_column" ? String(plan.edit.titleAr) : u.column);
      if (at < 0) return null;
      const cell = rowById.get(u.rowId)?.cells[at];
      values.set(u.key, typeof cell === "string" ? cell : null);
    }
    const rebuilt = buildVersion(addon, base, plan, values, new Date(stored.createdAt));
    if (!rebuilt || rebuilt.filled < 1 || JSON.stringify(rebuilt.version) !== text) return null;
    return rebuilt.filled;
  } catch { return null; }
}

interface UnitPlan { sheet: string; units: RereadUnit[]; shape: "add_column" | "set_cells" | "rename" | "add_rows"; edit: Record<string, unknown> }

/** What the approved request asks the run to do, as units of re-read (none for a rename or typed rows). A request the stored data cannot carry out is null. */
function unitsOf(addon: AddonPlan, base: FileVersion): UnitPlan | null {
  const req = addon.request as AddonRequest;
  if (req.kind === "review") return null;
  if (req.kind === "review_fix") {
    if (req.issue.code === "exact_duplicate") return { sheet: req.issue.sheet, units: [], shape: "set_cells", edit: {} };
    const issue: ReviewIssue | undefined = reviewFile(base, { keepRowIds: Number.POSITIVE_INFINITY }).issues.find((i) => i.code === req.issue.code && i.sheet === req.issue.sheet && i.column === req.issue.column);
    if (!issue) return { sheet: req.issue.sheet, units: [], shape: "set_cells", edit: {} };
    const recipe = readRecipe(req.reread);
    return { sheet: issue.sheet, shape: "set_cells", edit: {}, units: issue.rowIds.map((rowId) => ({ key: `${rowId}|${issue.column}`, rowId, column: issue.column, recipe })) };
  }
  const e = req.edit;
  if (e.kind === "add_column") {
    const recipe = readRecipe(e.reread);
    return { sheet: e.sheet, shape: "add_column", edit: { titleAr: e.titleAr }, units: [...new Set(e.rowIds)].map((rowId) => ({ key: `${rowId}|${e.titleAr}`, rowId, column: e.titleAr, recipe })) };
  }
  if (e.kind === "set_cells") {
    const seen = new Set<string>();
    const units: RereadUnit[] = [];
    for (const c of e.cells) {
      const key = `${c.rowId}|${c.column}`;
      if (seen.has(key)) continue;
      seen.add(key);
      units.push({ key, rowId: c.rowId, column: c.column, recipe: readRecipe((e.reread ?? {})[c.column]), ...(typeof c.value === "string" ? { typed: c.value } : {}) });
    }
    return { sheet: e.sheet, shape: "set_cells", edit: {}, units };
  }
  if (e.kind === "rename_column") return { sheet: e.sheet, shape: "rename", edit: { from: e.from, to: e.to }, units: [] };
  if (e.kind === "add_rows") return { sheet: e.sheet, shape: "add_rows", edit: { rows: e.rows ?? [] }, units: [] };
  return null;
}

/** The new version from what the run found. Cells no tool filled say «لم يكتمل البحث» (never an empty cell, never a guess). `filled` counts REAL values only (D4); a rename or typed rows count as filled when applied. */
function buildVersion(addon: AddonPlan, base: FileVersion, plan: UnitPlan, values: Map<string, string | null>, now: Date): { version: FileVersion; filled: number } | null {
  const reason = addon.kind === "review_fix" ? "review_fix" : "edit";
  const meta = { createdAt: now.toISOString(), reason } as const;
  let request: EditRequest;
  let filled = 0;
  if (plan.shape === "add_column") {
    const found: Record<string, string> = {};
    for (const u of plan.units) { const v = values.get(u.key); if (typeof v === "string" && isRealValue(v)) { found[u.rowId] = v; filled += 1; } }
    request = { kind: "add_column", sheet: plan.sheet, titleAr: String(plan.edit.titleAr), values: found };
  } else if (plan.shape === "set_cells") {
    if (plan.units.length === 0) return null;
    const cells = plan.units.map((u) => { const v = values.get(u.key); const real = typeof v === "string" && isRealValue(v); if (real) filled += 1; return { rowId: u.rowId, column: u.column, value: real ? cellText(v) : EDIT_NOT_SEARCHED_AR }; });
    request = { kind: "set_cells", sheet: plan.sheet, cells };
  } else if (plan.shape === "rename") {
    request = { kind: "rename_column", sheet: plan.sheet, from: String(plan.edit.from), to: String(plan.edit.to) };
    filled = 1;
  } else {
    const rows = (plan.edit.rows ?? []) as Array<{ id: string; parentId?: string | null; values: Record<string, string> }>;
    request = { kind: "add_rows", sheet: plan.sheet, rows };
    filled = rows.length;
  }
  const out = applyEditCore(base, request, meta);
  return out.ok ? { version: out.version, filled } : null;
}

// ---------- check, settle, publish, tell ----------
type Ending = { kind: "release"; reason: "plan_mismatch" | "released_earlier" } | { kind: "settle"; outcome: AddonOutcome };

async function finish(deps: Deps, row: MissionRecord, addon: AddonPlan, jobId: string, hold: number, ending: Ending, owns: () => Promise<boolean>): Promise<void> {
  const { store, client } = deps;
  // another worker owns the row now: it finishes (settlement and publishing are idempotent); this one says and changes nothing
  if (!(await owns())) return;
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
  assertOwned(deps.leaseLost, row.id);
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

  // the money and the file are done and idempotent; the row and the customer's words belong to the worker that owns the row
  if (!(await owns())) return;
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
