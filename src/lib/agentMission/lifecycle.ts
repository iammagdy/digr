import { createHash, randomBytes } from "node:crypto";
import { refundedPointsFromSettle } from "../server/settleRefund";
import { AGENT_CAPABILITY_SLUG, AGENT_JOB_LEASE_SECONDS, AGENT_JOB_POINTS_CAP, AGENT_MAX_DELIVERED_ROWS } from "./constants";
import { planNeedsRequote } from "./catalogPriceGuard";
import { executionBudgetUsd, legacyPriceMissionByCode, priceMissionByCode, settlementCharge } from "./price";
import { firstSentenceAr, stagePriceInputs, type PricedPlan } from "./plan";
import { estimatedGroupKeys, settlementChargeByStage, stageUnitsOf, type StageCounts, type StageUnits } from "./stageUnits";

/**
 * The two money moments of a mission. BOTH go through the functions the website already uses; no money table is written by hand:
 *
 *   approve  create_quote_atomic -> accept_quote_atomic (reserves res_<job> in the ledger and creates the job) -> claim_job_chunk (a long lease on the job so the website's
 *            old driver never runs a chunk of it; complete_chunk or release_job_atomic ends it)
 *   settle   (a plan with an ESTIMATED people stage: settle_job_by_stage_atomic instead, stageUnits.ts; never a fallback to the next line) complete_chunk (records the delivered unique rows and clears the lease) -> settle_job_atomic (charge = ceil(delivered x the job's unit price), never above the reserve; the minimum charge is inside that unit, see missionPricing.ts; the rest
 *            of the hold is released). Nothing delivered: complete_chunk at zero rows (clears the lease) then release_job_atomic (the whole hold comes back, nothing is charged).
 *
 * Every function takes the Supabase client so the tests can hand it a fake that records the calls.
 */

export type ApproveResult =
  | { ok: true; jobId: string; quoteId: string; reservePoints: number; unitPricePoints: number; deliveredRows: number; executionBudgetUsd: number }
  | { ok: false; code: string; messageAr: string };

const APPROVE_FAILURES: Record<string, string> = {
  insufficient_balance: "رصيد حساب الاختبار لا يكفي لحجز هذه المهمة.",
  concurrency_limit: "لدى الحساب مهمتان نشطتان بالفعل؛ انتظر اكتمال إحداهما.",
  quote_expired: "انتهت صلاحية عرض السعر؛ أعد الاعتماد.",
  plan_changed: "تغيّر سعر الخطة عن المخزّن؛ أعد التخطيط.",
  quote_failed: "تعذّر إنشاء عرض السعر (قد يكون الحد الأقصى للحجز في قاعدة البيانات أقل من هذه المهمة).",
  accept_failed: "تعذّر اعتماد العرض وحجز الرصيد.",
  claim_failed: "تعذّر إغلاق المهمة أمام المنفّذ القديم؛ رجع لمحفظتك ولم يُخصم أي رصيد.",
  // a plan with an ESTIMATED people stage is settled per stage (stageUnits.ts): when the database cannot do that yet, nothing is held and nothing is charged
  settle_unavailable: "تعذّر التأكد من جاهزية التسوية لهذه المهمة، ولم يُحجز أي رصيد. حاول بعد قليل.",
};
export const MISSION_APPROVAL_PENDING_AR = "نتحقق الآن من اعتماد طلبك بعد انقطاع مؤقت، ولن تُحجز نقاطك مرتين. حدّث الصفحة للاطّلاع على أحدث حالة.";

const fail = (code: string): ApproveResult => ({ ok: false, code, messageAr: APPROVE_FAILURES[code] ?? "تعذّر اعتماد المهمة." });

/** The stored plan priced AGAIN by code: what the site shows and reserves is never a stored number that nobody recomputed. */
export function repriceStoredPlan(plan: PricedPlan) {
  // a plan stored before the one pricing rule (no `rule` on its price) is approved at the price it showed: the old formula; a new one is priced again with the markup and the minimum it was priced with
  if (plan.price.rule !== 2) return legacyPriceMissionByCode(plan.stages.map((s) => ({ rows: s.planned_rows, costPerRowUsd: s.measured_cost_per_row_usd, deliver: s.deliver })));
  return priceMissionByCode(stagePriceInputs(plan.stages, plan.contact_steps), { settings: plan.price.settings });
}

/**
 * IS THE PER-STAGE SETTLEMENT IN THE DATABASE? A probe call with a job id that cannot exist. Only the POSITIVE answer counts: the function ran and said «Job probe not found» (code P0001). Anything else (the function missing: 42883 or PGRST202, a network error,
 * a timeout, a permission error, an answer that is not an error) is «not ready», so an outage can never let a customer pay through a settlement that is not there. No row is read or written by the probe: the function stops at its first lookup.
 */
export async function perStageSettlementReady(client: any): Promise<boolean> {
  try {
    const probe = await client.rpc("settle_job_by_stage_atomic", { p_job_id: "probe", p_units: { base: 0, estimated: 0 } });
    const e = probe?.error;
    return !!e && e.code === "P0001" && typeof e.message === "string" && e.message.includes("Job probe not found");
  } catch {
    return false;
  }
}

export async function approveMission(client: any, mission: { id: string; user_id: string; plan: PricedPlan }, options: { now?: Date; expiresInMinutes?: number; atomicMission?: { actorId: string; expectedUpdatedAt: string } } = {}): Promise<ApproveResult> {
  // a card quoted before a catalog price correction (DT-20261119-11 D7): refused before any price is recomputed, any quote made or any point reserved
  if (planNeedsRequote(mission.plan)) return fail("plan_changed");
  const price = repriceStoredPlan(mission.plan);
  const stored = mission.plan.price;
  if (price.unitPricePoints !== stored.unitPricePoints || price.reservePoints !== stored.reservePoints || price.deliveredRows !== stored.deliveredRows) return fail("plan_changed");
  if (price.overCap || price.deliveredRows > AGENT_MAX_DELIVERED_ROWS) return fail("quote_failed");
  // A PLAN WITH AN ESTIMATED PEOPLE STAGE (DT-20261119-01): its two unit prices travel in the accepted quote, and the settlement that reads them must exist BEFORE anything is held (nothing moves when it does not)
  const hasEstimate = estimatedGroupKeys(mission.plan.stages).size > 0;
  const units = hasEstimate ? stageUnitsOf(mission.plan) : null;
  if (hasEstimate && units === null) return fail("settle_unavailable");
  if (units !== null && !(await perStageSettlementReady(client))) return fail("settle_unavailable");

  const now = options.now ?? new Date();
  const quoteId = `quote_${randomBytes(12).toString("hex")}`;
  const items = [{
    capabilitySlug: AGENT_CAPABILITY_SLUG, endpointId: AGENT_CAPABILITY_SLUG, missionId: mission.id,
    unitPricePoints: price.unitPricePoints, targetVolumeMin: 1, targetVolumeMax: price.deliveredRows, unitCostUsd: price.costPerFinalRowUsd,
    // what «طلباتي» says about the request: the one sentence the customer approved
    summaryAr: firstSentenceAr(mission.plan.summary_ar),
    ...(units !== null ? { stageUnitsPoints: { base: units.base, estimated: units.estimated }, stageRowsPlanned: { base: units.rows.base, estimated: units.rows.estimated } } : {}),
  }];
  const formats = ["xlsx", "csv"];
  const quoteHash = createHash("sha256").update(JSON.stringify({ items, formats })).digest("hex");
  const expiresAt = new Date(now.getTime() + (options.expiresInMinutes ?? 30) * 60_000).toISOString();

  const approval = (jobId: string): ApproveResult => ({
    ok: true, jobId, quoteId, reservePoints: price.reservePoints, unitPricePoints: price.unitPricePoints,
    deliveredRows: price.deliveredRows, executionBudgetUsd: executionBudgetUsd(price.reservePoints),
  });
  if (options.atomicMission) {
    const pending: ApproveResult = { ok: false, code: "approval_pending", messageAr: MISSION_APPROVAL_PENDING_AR };
    let response;
    try {
      response = await client.rpc("accept_mission_quote_atomic", {
        p_mission_id: mission.id, p_user_id: mission.user_id, p_actor_id: options.atomicMission.actorId,
        p_expected_plan: mission.plan, p_expected_updated_at: options.atomicMission.expectedUpdatedAt,
        p_quote_id: quoteId, p_quote_hash: quoteHash, p_items: items, p_total_points: price.reservePoints,
        p_output_formats: formats, p_expires_at: expiresAt, p_lease_seconds: AGENT_JOB_LEASE_SECONDS,
      });
    } catch {
      return pending;
    }
    if (response?.error) return pending;
    const body = response?.data;
    if (body?.success === true) {
      return typeof body.job_id === "string" && body.job_id.length > 0 && body.quote_id === quoteId
        && body.reserved_credits === price.reservePoints ? approval(body.job_id) : pending;
    }
    if (body?.success !== false) return pending;

    switch (body.error) {
      case "stale_plan": return fail("stale_plan");
      case "already_approved": return { ok: false, code: body.error, messageAr: "هذه الخطة اعتُمدت بالفعل." };
      case "not_plan_ready": return { ok: false, code: body.error, messageAr: "لا توجد خطة جاهزة للاعتماد." };
      case "claim_failed": return { ok: false, code: body.error, messageAr: "تعذّر بدء المهمة الآن؛ لم يُحجز أي رصيد." };
      case "insufficient_balance":
      case "concurrency_limit":
      case "quote_expired":
      case "quote_failed":
      case "accept_failed": return fail(body.error);
      default: return pending;
    }
  }

  const created = await client.rpc("create_quote_atomic", {
    p_user_id: mission.user_id, p_quote_id: quoteId, p_quote_hash: quoteHash, p_items: items,
    p_total_points: price.reservePoints, p_output_formats: formats, p_expires_at: expiresAt, p_previous_quote_ids: [],
  });
  if (created?.error || created?.data?.success === false) return fail("quote_failed");

  const accepted = await client.rpc("accept_quote_atomic", { p_quote_id: quoteId, p_user_id: mission.user_id, p_expected_quote_hash: quoteHash });
  if (accepted?.error) return fail("accept_failed");
  const body = accepted?.data;
  if (!body?.success) return fail(typeof body?.error === "string" && body.error in APPROVE_FAILURES ? body.error : "accept_failed");
  const jobId = String(body.job_id);

  const claim = await client.rpc("claim_job_chunk", { p_job_id: jobId, p_expected_step: 0, p_lease_seconds: AGENT_JOB_LEASE_SECONDS });
  if (claim?.error || claim?.data?.claimed !== true) {
    await client.rpc("release_job_atomic", { p_job_id: jobId, p_error_message: "تعذّر تجهيز المهمة للتنفيذ، فعاد الحجز المؤقت كاملًا." });
    return fail("claim_failed");
  }
  return approval(jobId);
}

export interface SettleInput {
  jobId: string;
  /** Unique final rows delivered (the rows of the delivered stages that were saved with a valid parent), already capped at the approved volume by the caller. */
  deliveredUnits: number;
  unitPricePoints: number;
  reservedPoints: number;
  /** TREG spend of the execution, USD, for complete_chunk's accumulated_cost_usd. */
  costUsd: number;
  resultPath: string | null;
  /** Reason recorded when nothing is delivered and the hold is released. */
  releaseReason?: string;
  /**
   * A mission whose people stage was priced by an ESTIMATE (stageUnitsOf of the APPROVED plan): its units and the rows delivered per group. When present, ONLY the per-stage function is used: if it fails the settlement is refused and
   * stays retryable (the hold stays), it never falls back to the one-unit function, which would charge the companies the blended price.
   */
  stage?: { units: StageUnits; counts: StageCounts };
}

export type SettleResult =
  | { ok: true; kind: "settled"; chargedPoints: number; releasedPoints: number; expectedChargedPoints: number; matchesExpectation: boolean }
  | { ok: true; kind: "released"; chargedPoints: 0; releasedPoints: number }
  | { ok: false; code: string; detail: string };

export async function settleMission(client: any, input: SettleInput): Promise<SettleResult> {
  const delivered = Math.max(0, Math.floor(input.deliveredUnits));
  if (delivered === 0) {
    // release_job_atomic refuses while a chunk lease is held (found on the real function bodies on a scratch PostgreSQL): complete_chunk at zero rows clears the lease first
    const cleared = await client.rpc("complete_chunk", { p_job_id: input.jobId, p_expected_step: 0, p_new_cursor: "completed", p_new_delivered_units: 0, p_cost_usd: Math.max(0, Number(input.costUsd.toFixed(6))) });
    if (cleared?.error) return { ok: false, code: "complete_chunk_failed", detail: String(cleared.error.message ?? cleared.error.code ?? "").slice(0, 200) };
    const released = await client.rpc("release_job_atomic", { p_job_id: input.jobId, p_error_message: input.releaseReason ?? "لم يُسلَّم شيء من هذه المهمة، فعاد الحجز المؤقت كاملًا." });
    if (released?.error) return { ok: false, code: "release_failed", detail: String(released.error.message ?? released.error.code ?? "").slice(0, 200) };
    return { ok: true, kind: "released", chargedPoints: 0, releasedPoints: input.reservedPoints };
  }
  // a per-stage settlement whose counts do not add up to the rows delivered is refused BEFORE anything is recorded (the database refuses it too)
  if (input.stage && (input.stage.counts.base < 0 || input.stage.counts.estimated < 0 || input.stage.counts.base + input.stage.counts.estimated !== delivered)) return { ok: false, code: "stage_counts_mismatch", detail: "the delivered rows per stage do not add up to the rows delivered" };
  const chunk = await client.rpc("complete_chunk", { p_job_id: input.jobId, p_expected_step: 0, p_new_cursor: "completed", p_new_delivered_units: delivered, p_cost_usd: Math.max(0, Number(input.costUsd.toFixed(6))) });
  if (chunk?.error) return { ok: false, code: "complete_chunk_failed", detail: String(chunk.error.message ?? chunk.error.code ?? "").slice(0, 200) };
  const stage = input.stage;
  const settled = stage
    ? await client.rpc("settle_job_by_stage_atomic", { p_job_id: input.jobId, p_units: { base: stage.counts.base, estimated: stage.counts.estimated }, p_points_cap: AGENT_JOB_POINTS_CAP, p_result_file_id: input.resultPath })
    : await client.rpc("settle_job_atomic", { p_job_id: input.jobId, p_points_cap: AGENT_JOB_POINTS_CAP, p_result_file_id: input.resultPath });
  if (settled?.error) return { ok: false, code: "settle_failed", detail: String(settled.error.message ?? settled.error.code ?? "").slice(0, 200) };
  const expected = stage
    ? { chargedPoints: settlementChargeByStage(stage.counts, stage.units, input.unitPricePoints, input.reservedPoints) }
    : settlementCharge({ deliveredUnits: delivered, unitPricePoints: input.unitPricePoints, reservedPoints: input.reservedPoints });
  const charged = Number(settled.data?.charged_credits ?? 0);
  const released = refundedPointsFromSettle(settled.data);
  return { ok: true, kind: "settled", chargedPoints: charged, releasedPoints: released, expectedChargedPoints: expected.chargedPoints, matchesExpectation: charged === expected.chargedPoints };
}
