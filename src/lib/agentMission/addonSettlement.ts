import { createHash } from "node:crypto";
import { AGENT_JOB_LEASE_SECONDS, MISSION_EVENTS_TABLE, MISSION_TABLE } from "./constants";
import { readJobMoneyState } from "./addonMoneyState";
import { settleMission, type SettleResult } from "./lifecycle";
import { priceMissionByCode } from "./price";
import { DEFAULT_MISSION_PRICING_SETTINGS, pointsPerCostUsd, type MissionPricingSettings } from "../missionPricing";

/**
 * MONEY PR 7a, PHASE 2A (docs/MONEY-PR-7A.md): THE MONEY OF A PAID REVIEW, A REVIEW FIX AND A POST-DELIVERY EDIT (an "add-on" of a delivered mission). NOT WIRED: nothing in the site or the worker imports this file
 * (tests/money7a-isolation.test.ts); it is only called by tests until the wiring phase (2B) is briefed and approved.
 *
 * An add-on is a row of the `missions` table linked to the delivered mission inside its `plan` JSON. It goes through the EXISTING money functions, unchanged:
 *   approve  claim plan_ready -> approved (compare-and-set), price AGAIN by code, create_quote_atomic -> accept_quote_atomic (res_<job>) -> claim_job_chunk      (approveAddonOnce)
 *   settle   settleMission: complete_chunk -> settle_job_atomic (rel_<job> FIRST, then chg_<job>), or complete_chunk(0) -> release_job_atomic                 (settleAddon)
 * The job SELLS POINTS at 1 point each (unit price 1, volume = the hold), so the database's own charge, LEAST(CEIL(delivered x 1), reserve, cap), is exactly the charge this file computes.
 *
 * RULES kept here: append-only ledger and deterministic ids (res_/rel_/chg_ of the add-on's own job, itself derived from the quote id, itself from the mission, the base version and the attempt); release first;
 * idempotent; charge never above the hold; the 15% buffer is on the hold only; NOTHING is spent before the customer approves (nothing here calls a provider); the AI never decides money (every number is code).
 * Money files are read and reused, never edited. THE DISPLAYED PRICES (stage4/quotes.ts) ARE NOT IMPORTED HERE: tests pin them equal to these functions instead (tests/money7a-charge.test.ts).
 */

export const ADDON_KINDS = ["review", "review_fix", "edit"] as const;
export type AddonKind = (typeof ADDON_KINDS)[number];
/** The capability (and endpoint) id of the add-on's job: the job row then says which kind it was. */
export const ADDON_SLUG: Readonly<Record<AddonKind, string>> = { review: "agent-review", review_fix: "agent-fix", edit: "agent-edit" };
/** The least an add-on is charged when anything was done (owner rule: no free path), in points. */
export const ADDON_MIN_POINTS = 100;
/** The most one add-on may hold: the database's volume limit of a job (accept_quote_atomic: 5,000 units, and the job sells points at 1 each). */
export const ADDON_MAX_HOLD_POINTS = 5_000;
/** The review: 1 point per 100 cells (rounded up), at least 100. */
export const ADDON_REVIEW_CELLS_PER_POINT = 100;
/** The pricing settings of an add-on: the site's markup, and the add-on minimum (100) instead of a mission's (200). */
export const addonSettings = (settings: MissionPricingSettings = DEFAULT_MISSION_PRICING_SETTINGS): MissionPricingSettings => ({ ...settings, minChargePoints: ADDON_MIN_POINTS });

/** What an add-on was priced on, stored in its row. The hold is what is reserved; the estimate is what it should cost (the hold without the 15% buffer). */
export interface AddonPricing {
  /** Units the add-on asks for: the cells or rows an edit must fill (1 for a review). Whole number, 1 or more. */
  requested: number;
  /** A review: the readable cells reviewed. */
  cells?: number;
  /** An edit or a fix: the per-row cost of the lookup chain of its columns, USD (from recorded calls or the catalog: stage4/addonQuote.ts). */
  costPerRowUsd?: number;
  settings: MissionPricingSettings;
  estimatePoints: number;
  holdPoints: number;
}
export interface AddonPlan {
  v: 1;
  kind: AddonKind;
  /** The delivered mission this add-on belongs to. */
  of: string;
  baseVersion: number;
  /** The version the edit or the fix will make (base + 1); null for a review (it makes no version). */
  newVersion: number | null;
  attempt: number;
  /** The customer's request as data (stage4/addonRow.ts types it); the money code never reads it. */
  request: unknown;
  pricing: AddonPricing;
}

const isCount = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 1;
const sha256Hex = (s: string): string => createHash("sha256").update(s).digest("hex");

// ---------- the deterministic ids ----------

/** The add-on's id (its row in `missions`): msn_ + 20 hex of sha256("<mission id>|v<base version>|a<attempt>"). Two creations of the same request compute the same id, and the primary key refuses the second. */
export function addonId(missionId: string, baseVersion: number, attempt: number): string {
  if (typeof missionId !== "string" || missionId.trim() === "") throw new Error("addonId: the mission id is empty");
  if (!isCount(baseVersion) || !isCount(attempt)) throw new Error("addonId: the base version and the attempt are whole numbers of 1 or more");
  return `msn_${sha256Hex(`${missionId}|v${baseVersion}|a${attempt}`).slice(0, 20)}`;
}
export const addonQuoteId = (id: string): string => `quote_addon_${id}`;
/** What accept_quote_atomic makes of a quote id: job_quote_<md5(quote id)> (the live definition and the migration agree). */
export const addonJobId = (quoteId: string): string => `job_quote_${createHash("md5").update(quoteId).digest("hex")}`;
export const addonLedgerIds = (jobId: string): { reserve: string; release: string; charge: string } => ({ reserve: `res_${jobId}`, release: `rel_${jobId}`, charge: `chg_${jobId}` });

// ---------- the prices, by code ----------

/** The review's hold and price: 1 point per 100 cells, rounded up, at least 100. Held as is (no buffer): a review spends nothing on providers. quotes.ts `reviewQuote` is pinned equal by a test. */
export function reviewHoldPoints(cells: number): number {
  if (!Number.isInteger(cells) || cells < 0) throw new Error("reviewHoldPoints: cells must be a whole number of 0 or more");
  return Math.max(ADDON_MIN_POINTS, Math.ceil(cells / ADDON_REVIEW_CELLS_PER_POINT));
}

/** The provider budget of an add-on's run, USD, in millionths: hold / points per USD, rounded DOWN, so the real cost times the markup, rounded up, is at most the hold. The gateway refuses any call that would pass it. */
export function addonProviderBudgetUsd(holdPoints: number, settings: MissionPricingSettings = addonSettings()): number {
  if (!Number.isFinite(holdPoints) || holdPoints < 0) throw new Error("addonProviderBudgetUsd: the hold must be a number of 0 or more");
  return Math.floor((holdPoints / pointsPerCostUsd(settings)) * 1_000_000) / 1_000_000;
}

/**
 * The charge of an add-on, in whole points (integer arithmetic on millionths of a dollar):
 *   nothing filled -> 0 (the whole hold comes back)
 *   charge = min(hold, max(ceil(real cost x points per USD), ceil(100 x filled / requested)))
 * `filled` counts cells that received a VALUE (a stated gap is not a value: the caller counts); it is read as at most `requested`. The share of the 100-point minimum is proportional to what was filled.
 * `holdPoints` may be Infinity (the displayed price has no hold). It throws on anything that is not a number: nothing is charged on a guess.
 */
export function addonChargePoints(input: { realCostUsd: number; filled: number; requested: number; holdPoints: number; settings?: MissionPricingSettings }): number {
  const { realCostUsd, holdPoints } = input;
  if (!Number.isFinite(realCostUsd) || realCostUsd < 0) throw new Error("addonChargePoints: the real cost must be a number of 0 or more");
  if (typeof holdPoints !== "number" || Number.isNaN(holdPoints)) throw new Error("addonChargePoints: the hold must be a number");
  const requested = Math.floor(input.requested);
  if (!(requested >= 1)) throw new Error("addonChargePoints: requested must be 1 or more");
  const filled = Math.min(Math.max(0, Math.floor(input.filled)), requested);
  if (filled === 0) return 0;
  const micro = BigInt(Math.round(realCostUsd * 1_000_000));
  // points per USD in thousandths (5,500 -> 5,500,000): exact for the markups the owner can set (steps of 0.001 and more)
  const perUsdMilli = BigInt(Math.round(pointsPerCostUsd(input.settings ?? addonSettings()) * 1000));
  const unit = BigInt(1_000_000_000);
  const raw = (micro * perUsdMilli + unit - BigInt(1)) / unit;
  const share = (BigInt(100) * BigInt(filled) + BigInt(requested) - BigInt(1)) / BigInt(requested);
  const wanted = raw > share ? raw : share;
  const hold = Math.max(0, Math.floor(holdPoints));
  return Number(holdPoints === Number.POSITIVE_INFINITY ? wanted : wanted < BigInt(hold) ? wanted : BigInt(hold));
}

// ---------- reading and checking the add-on row ----------

/** The add-on of a row's `plan`, or null when the plan is not an add-on (a normal mission's plan has no `addon`). Strict: every field is checked, nothing is trusted. */
export function readAddonPlan(plan: unknown): AddonPlan | null {
  const a = (plan as { addon?: unknown } | null)?.addon as Record<string, any> | undefined;
  if (!a || typeof a !== "object" || a.v !== 1 || !ADDON_KINDS.includes(a.kind) || typeof a.of !== "string" || a.of === "" || !isCount(a.baseVersion) || !isCount(a.attempt)) return null;
  if (a.newVersion !== null && !isCount(a.newVersion)) return null;
  const p = a.pricing as Record<string, any> | undefined;
  if (!p || typeof p !== "object" || !isCount(p.requested) || !isCount(p.holdPoints) || !isCount(p.estimatePoints) || !p.settings || typeof p.settings.markup !== "number" || typeof p.settings.minChargePoints !== "number") return null;
  if (a.kind === "review" ? !(Number.isInteger(p.cells) && p.cells >= 0) : !(typeof p.costPerRowUsd === "number" && Number.isFinite(p.costPerRowUsd) && p.costPerRowUsd >= 0)) return null;
  return a as unknown as AddonPlan;
}

export type AddonCheck = { ok: true; holdPoints: number; estimatePoints: number } | { ok: false; code: "not_an_addon" | "plan_changed" | "too_large" };

/** The add-on priced AGAIN by code, and its identity checked: what is held is never a stored number that nobody recomputed. */
export function checkAddon(rowId: string, addon: AddonPlan): AddonCheck {
  if (rowId !== addonId(addon.of, addon.baseVersion, addon.attempt)) return { ok: false, code: "plan_changed" };
  if (addon.kind === "review" ? addon.newVersion !== null : addon.newVersion !== addon.baseVersion + 1) return { ok: false, code: "plan_changed" };
  const p = addon.pricing;
  let hold: number;
  let estimate: number;
  try {
    if (addon.kind === "review") {
      hold = reviewHoldPoints(p.cells as number);
      estimate = hold;
      if (p.requested !== 1) return { ok: false, code: "plan_changed" };
    } else {
      const price = priceMissionByCode([{ rows: p.requested, costPerRowUsd: p.costPerRowUsd as number, deliver: true, codeOnly: true }], { settings: p.settings });
      if (price.overCap) return { ok: false, code: "too_large" };
      hold = price.reservePoints;
      estimate = price.maxChargePoints;
      if (p.settings.minChargePoints !== ADDON_MIN_POINTS) return { ok: false, code: "plan_changed" };
    }
  } catch {
    return { ok: false, code: "plan_changed" };
  }
  if (hold !== p.holdPoints || estimate !== p.estimatePoints) return { ok: false, code: "plan_changed" };
  if (hold > ADDON_MAX_HOLD_POINTS) return { ok: false, code: "too_large" };
  return { ok: true, holdPoints: hold, estimatePoints: estimate };
}

// ---------- approval ----------

export type AddonApprovalResult =
  | { ok: true; jobId: string; quoteId: string; kind: AddonKind; holdPoints: number; providerBudgetUsd: number }
  | { ok: false; status: number; error: string; code?: string };

/** The customer's words for every refusal (Arabic only, no provider, no endpoint id, no USD). A refusal before the money call says nothing was held. */
export const ADDON_APPROVE_MESSAGES_AR = {
  not_found: "الطلب غير موجود.",
  not_ready: "لا يوجد طلب جاهز للاعتماد.",
  already_approved: "هذا الطلب اعتُمد بالفعل.",
  plan_changed: "تغيّر سعر هذا الطلب عن المعروض؛ اطلبه من جديد. لم يُحجز شيء.",
  too_large: "هذا التعديل أكبر من الحد المسموح لطلب واحد؛ قسّمه إلى أجزاء أصغر. لم يُحجز شيء.",
  quote_failed: "تعذّر تجهيز هذا الطلب الآن. لم يُحجز ولم يُخصم شيء.",
  insufficient_balance: "رصيدك لا يكفي لهذا الطلب. اشحن رصيدك ثم اعتمده؛ لم يُخصم شيء.",
  concurrency_limit: "لديك طلبان قيد التنفيذ بالفعل؛ انتظر اكتمال أحدهما ثم اعتمد هذا الطلب. لم يُخصم شيء.",
  quote_expired: "انتهت مهلة اعتماد هذا الطلب؛ اطلبه من جديد. لم يُخصم شيء.",
  accept_failed: "تعذّر اعتماد الطلب وحجز النقاط. لم يُخصم شيء.",
  claim_failed: "تعذّر تجهيز الطلب للتنفيذ، فعاد الحجز كاملًا إلى رصيدك.",
  claim_retry: "تعذّر تجهيز الطلب للتنفيذ الآن. نقاطك محجوزة، فأعد المحاولة بعد قليل ولن يُخصم منها إلا ما يُنجز.",
  approved_event: "اعتُمد الطلب وحُجزت النقاط؛ يبدأ التنفيذ الآن.",
  /** The reservation MAY have happened and the answer was lost or never came (accept or claim failed in a way that does not say which). It must never say nothing was held, and never say approved. */
  approval_unverified: "لم نتمكن من تأكيد اعتماد الطلب بعد. قد تكون نقاطك حُجزت مؤقتًا، ولن يُخصم منها إلا ما يُنجز. أعد المحاولة بعد قليل؛ لن يُحجز شيء مرتين.",
  /** The hold was reserved but recording it on the request could not be proved (after bounded retries and a read-back). Not success: the request goes back to waiting so a retry converges on the same hold. */
  record_unverified: "لم نتمكن من تأكيد تسجيل اعتماد الطلب بعد. قد تكون نقاطك حُجزت مؤقتًا، ولن يُخصم منها إلا ما يُنجز. أعد المحاولة بعد قليل؛ لن يُحجز شيء مرتين.",
  /** The abandoned job of this request was RELEASED (proved by its ledger): the points are back and the request is ended. Said only when the release row exists. */
  released_before_start: "لم يبدأ تنفيذ هذا الطلب، وعادت النقاط التي حُجزت له إلى رصيدك كاملة. يمكنك تقديم طلب جديد.",
} as const;
/** How a request ended after its abandoned job was released: the row's `error`, and the sentence the customer reads (it says the points came back and never says anything was charged). */
export const ADDON_RELEASED_ERROR = "approval_released";
export const ADDON_RELEASED_SUMMARY_AR = "لم يبدأ تنفيذ هذا الطلب، وعادت النقاط التي حُجزت له إلى رصيدك كاملة. لم يُسجَّل أي خصم، ويمكنك تقديم طلب جديد.";
/** The patch that ENDS a request whose abandoned job was released: failed, no charge, the job recorded for audit. One shape for the approval's own retry and for the recovery. */
export const releasedRowPatch = (jobId: string, quoteId: string, holdPoints: number) => ({ status: "failed" as const, error: ADDON_RELEASED_ERROR, charged_points: 0, delivered_units: 0, summary_ar: ADDON_RELEASED_SUMMARY_AR, job_id: jobId, quote_id: quoteId, reserved_points: holdPoints, lease_until: null, worker_id: null });
export type AddonApproveMessage = keyof typeof ADDON_APPROVE_MESSAGES_AR;
/** What the job's list line says (the `summaryAr` of the quote item). */
export const ADDON_SUMMARY_AR: Readonly<Record<AddonKind, string>> = { review: "مراجعة الملف", review_fix: "تصحيح بعد المراجعة", edit: "تعديل الملف" };

export interface AddonApprovalInput {
  /** The add-on's row id (addonId(...)). */
  id: string;
  actorId: string;
  /** The row must belong to this user (the customer path). */
  expectUserId?: string;
  now?: Date;
  expiresInMinutes?: number;
}

const bad = (status: number, key: AddonApproveMessage, code?: string): AddonApprovalResult => ({ ok: false, status, error: ADDON_APPROVE_MESSAGES_AR[key], ...(code ? { code } : {}) });
const quiet = async (f: () => PromiseLike<unknown> | unknown): Promise<void> => { try { await f(); } catch { /* the revert is best effort: the next approval of the same add-on converges (deterministic ids) */ } };

/**
 * THE ONE APPROVAL PATH OF AN ADD-ON. It copies the shape of approveMissionOnce (approval.ts) for an add-on row:
 *   1 read the row (it must be an add-on, `plan_ready`, the user's own), check it by code (identity, price again, 5,000-point limit): a refusal here writes NOTHING
 *   2 claim plan_ready -> approved (compare-and-set: two clicks approve once; the claim must change exactly one row)
 *   3 the plan is read again after the claim and checked again
 *   4 create_quote_atomic (deterministic quote id: the same call again is `already_created`) -> accept_quote_atomic (res_<job>; the same call again is `already_accepted`) -> claim_job_chunk
 *   5 record job, quote and reserve on the row, and PROVE it (safety fix A): the update is retried at most three times, each followed by a read-back that must show this very job, quote and hold; an unproved record is NOT success (the row goes back to waiting, the hold is kept for the retry)
 * Any failure puts the row back to `plan_ready` (an expired quote ends it: the customer asks again and the next attempt number makes a new id). A failure NEVER releases a job that was already accepted before this call.
 */
export async function approveAddonOnce(client: any, input: AddonApprovalInput): Promise<AddonApprovalResult> {
  const { data: row } = await client.from(MISSION_TABLE).select("id,user_id,status,plan").eq("id", input.id).maybeSingle();
  if (!row || (input.expectUserId && row.user_id !== input.expectUserId)) return bad(404, "not_found");
  const first = readAddonPlan(row.plan);
  if (!first) return bad(409, "not_ready");
  if (row.status === "approved" || row.status === "executing" || row.status === "completed") return bad(409, "already_approved");
  if (row.status !== "plan_ready") return bad(409, "not_ready");
  const before = checkAddon(row.id, first);
  if (!before.ok) return bad(409, before.code === "too_large" ? "too_large" : "plan_changed", before.code);

  const claim = await client.from(MISSION_TABLE).update({ status: "approved", approved_at: (input.now ?? new Date()).toISOString(), approved_by: input.actorId, worker_id: null, lease_until: new Date(Date.now() + 3600_000).toISOString() }).eq("id", input.id).eq("status", "plan_ready").select("id");
  if (claim.error) return { ok: false, status: 500, error: "تعذّر الاعتماد." };
  if (Array.isArray(claim.data) && claim.data.length === 0) return bad(409, "already_approved");
  const revert = (error: string, status: "plan_ready" | "cancelled" = "plan_ready") => quiet(() => client.from(MISSION_TABLE).update({ status, lease_until: null, error }).eq("id", input.id));
  // Where the money stands decides what the customer may be told: before `accept` nothing can be reserved; from `accept` on it MAY be, whatever the answer of the call was.
  let stage: "plan" | "quote" | "accept" | "claim" | "record" = "plan";

  try {
    const { data: claimed } = await client.from(MISSION_TABLE).select("plan").eq("id", input.id).maybeSingle();
    const addon = readAddonPlan(claimed?.plan ?? row.plan);
    const price = addon ? checkAddon(row.id, addon) : null;
    if (!addon || !price || !price.ok) { await revert(price && !price.ok ? price.code : "plan_changed"); return bad(409, price && !price.ok && price.code === "too_large" ? "too_large" : "plan_changed", price && !price.ok ? price.code : "plan_changed"); }
    const hold = price.holdPoints;

    const quoteId = addonQuoteId(row.id);
    const slug = ADDON_SLUG[addon.kind];
    const items = [{ capabilitySlug: slug, endpointId: slug, missionId: addon.of, addonId: row.id, unitPricePoints: 1, targetVolumeMin: 1, targetVolumeMax: hold, summaryAr: ADDON_SUMMARY_AR[addon.kind] }];
    const formats = ["xlsx", "csv"];
    const quoteHash = sha256Hex(JSON.stringify({ items, formats }));
    const expiresAt = new Date((input.now ?? new Date()).getTime() + (input.expiresInMinutes ?? 30) * 60_000).toISOString();

    stage = "quote";
    const created = await client.rpc("create_quote_atomic", { p_user_id: row.user_id, p_quote_id: quoteId, p_quote_hash: quoteHash, p_items: items, p_total_points: hold, p_output_formats: formats, p_expires_at: expiresAt, p_previous_quote_ids: [] });
    if (created?.error || created?.data?.success === false) { await revert("quote_failed"); return bad(409, "quote_failed", "quote_failed"); }

    stage = "accept";
    const accepted = await client.rpc("accept_quote_atomic", { p_quote_id: quoteId, p_user_id: row.user_id, p_expected_quote_hash: quoteHash });
    // an ERROR from accept (not a clean refusal in its body) does not say whether the reservation committed: the sentence is the uncertain one, and the retry converges (deterministic ids)
    if (accepted?.error) { await revert("approval_unverified"); return bad(409, "approval_unverified", "approval_unverified"); }
    const body = accepted?.data;
    if (!body?.success) {
      const code = typeof body?.error === "string" ? body.error : "accept_failed";
      if (code === "quote_expired") { await revert("quote_expired", "cancelled"); return bad(409, "quote_expired", code); }
      const key: AddonApproveMessage = code === "insufficient_balance" || code === "concurrency_limit" ? code : "accept_failed";
      await revert(code);
      return bad(key === "insufficient_balance" ? 402 : 409, key, code);
    }
    const jobId = String(body.job_id);
    const alreadyAccepted = body.already_accepted === true;

    stage = "claim";
    const claimJob = await client.rpc("claim_job_chunk", { p_job_id: jobId, p_expected_step: 0, p_lease_seconds: AGENT_JOB_LEASE_SECONDS });
    // an earlier attempt of THIS add-on that was accepted and claimed but whose answer was lost: the lease is already ours (no other code claims an add-on's job), so it counts as claimed
    const claimedOk = claimJob?.data?.claimed === true || (alreadyAccepted && claimJob?.data?.error === "lease_active");
    if (claimJob?.error || !claimedOk) {
      if (alreadyAccepted) {
        // a job accepted before this call is never released here: it may already be running. But a job whose RELEASE is proved by the ledger (the first attempt's own release, or the watchdog) will never run: the request is ended instead of answering «retry» for ever
        const state = await readJobMoneyState(client, jobId);
        if (state.kind === "released") {
          const ended = await client.from(MISSION_TABLE).update({ ...releasedRowPatch(jobId, quoteId, state.holdPoints), updated_at: new Date().toISOString() }).eq("id", input.id).eq("status", "approved").select("id");
          if (!ended?.error && Array.isArray(ended?.data) && ended.data.length === 1) {
            await quiet(() => client.from(MISSION_EVENTS_TABLE).insert({ mission_id: input.id, kind: "result", message_ar: ADDON_RELEASED_SUMMARY_AR, counts: {} }));
            return bad(409, "released_before_start", "released_before_start");
          }
        }
        await revert("claim_failed");
        return bad(409, "claim_retry", "claim_failed");
      }
      // THIS call reserved the hold and could not claim it: give it back, and say «returned» only if the release is PROVED (a refused or lost release leaves the hold, and the sentence says so)
      const released = await client.rpc("release_job_atomic", { p_job_id: jobId, p_error_message: "تعذّر تجهيز الطلب للتنفيذ، فعاد الحجز المؤقت كاملًا." });
      if (released?.error || released?.data?.success !== true) { await revert("approval_unverified"); return bad(409, "approval_unverified", "approval_unverified"); }
      await revert("claim_failed");
      return bad(409, "claim_failed", "claim_failed");
    }

    stage = "record";
    const record = { job_id: jobId, quote_id: quoteId, reserved_points: hold, unit_price_points: 1, lease_until: null, error: null, updated_at: new Date().toISOString() };
    if (!(await recordApproval(client, input.id, record))) {
      // the hold is reserved and the row does not say so: NOT success. The row goes back to waiting (compare-and-set on «approved»: a row that moved on is left alone) so the retry converges on the same quote, job and reserve;
      // if even that fails the row stays «approved» with its one-hour lease, and `recoverAbandonedAddon` (addonRecovery.ts) finishes the record from the job's own state
      await quiet(() => client.from(MISSION_TABLE).update({ status: "plan_ready", lease_until: null, error: "record_unverified" }).eq("id", input.id).eq("status", "approved"));
      return bad(409, "record_unverified", "record_unverified");
    }
    await client.from(MISSION_EVENTS_TABLE).insert({ mission_id: input.id, kind: "system", message_ar: ADDON_APPROVE_MESSAGES_AR.approved_event, counts: {} });
    return { ok: true, jobId, quoteId, kind: addon.kind, holdPoints: hold, providerBudgetUsd: addon.kind === "review" ? 0 : addonProviderBudgetUsd(hold, addon.pricing.settings) };
  } catch {
    // a call that threw (the answer may be lost: the money may or may not have moved): the row goes back, and the deterministic ids make the next approval converge on the same quote, job and ledger rows
    if (stage === "accept" || stage === "claim" || stage === "record") { await revert("approval_unverified"); return bad(409, "approval_unverified", "approval_unverified"); }
    await revert(stage === "quote" ? "quote_failed" : "accept_failed");
    return stage === "quote" ? bad(409, "quote_failed", "quote_failed") : bad(409, "accept_failed", "accept_failed");
  }
}

/** The bounded number of tries to record the approval on the row (one update plus one read-back each). A database that stays down is asked exactly this many times: never a loop. */
export const APPROVAL_RECORD_ATTEMPTS = 3;

/**
 * RECORD THE APPROVAL ON THE ROW AND PROVE IT. The update is compare-and-set on «approved» (the claim of this very call). Its ANSWER is never trusted, in either direction: an error may hide a commit, «no row» may hide a commit, and an answer of «one row» is only believed
 * because the row is READ BACK and must carry exactly this job, this quote and this hold. True only when the read-back proves it.
 */
async function recordApproval(client: any, id: string, record: { job_id: string; quote_id: string; reserved_points: number }): Promise<boolean> {
  for (let attempt = 0; attempt < APPROVAL_RECORD_ATTEMPTS; attempt += 1) {
    try { await client.from(MISSION_TABLE).update(record).eq("id", id).eq("status", "approved").select("id"); } catch { /* proved by the read-back below, never by this answer */ }
    try {
      const { data, error } = await client.from(MISSION_TABLE).select("id,status,job_id,quote_id,reserved_points").eq("id", id).maybeSingle();
      if (!error && data && data.job_id === record.job_id && data.quote_id === record.quote_id && Number(data.reserved_points) === record.reserved_points) return true;
    } catch { /* not proved: try again, then give up */ }
  }
  return false;
}

// ---------- settlement ----------

export type AddonSettleInput =
  | { kind: "review"; jobId: string; holdPoints: number; /** The report was made and stored. */ reportStored: boolean; resultPath?: string | null }
  | { kind: "review_fix" | "edit"; jobId: string; holdPoints: number; realCostUsd: number; filled: number; requested: number; settings?: MissionPricingSettings; resultPath?: string | null };

export interface AddonSettleResult { result: SettleResult; chargePoints: number }

/**
 * THE SETTLEMENT OF AN ADD-ON: the charge is computed here by code, then handed to the EXISTING settleMission as "points delivered at 1 point each": complete_chunk, then settle_job_atomic (rel_ first, then chg_;
 * never above the hold). Nothing charged: complete_chunk(0) then release_job_atomic (the whole hold comes back). Idempotent: the database answers `already_settled` / `already_released` and a retry writes nothing more.
 * A review is charged its exact hold when its report is stored, and released whole when it is not.
 */
export async function settleAddon(client: any, input: AddonSettleInput): Promise<AddonSettleResult> {
  const hold = Math.floor(input.holdPoints);
  if (!Number.isInteger(hold) || hold < 1) throw new Error("settleAddon: the hold must be a whole number of 1 or more");
  const costUsd = input.kind === "review" ? 0 : input.realCostUsd;
  const chargePoints = input.kind === "review" ? (input.reportStored ? hold : 0) : addonChargePoints({ realCostUsd: input.realCostUsd, filled: input.filled, requested: input.requested, holdPoints: hold, settings: input.settings });
  const result = await settleMission(client, { jobId: input.jobId, deliveredUnits: chargePoints, unitPricePoints: 1, reservedPoints: hold, costUsd, resultPath: input.resultPath ?? null, releaseReason: "لم يُسلَّم شيء من هذا الطلب، فعاد الحجز كاملًا." });
  return { result, chargePoints };
}


