import { createHash, randomBytes } from "node:crypto";
import { refundedPointsFromSettle } from "../server/settleRefund";
import { AGENT_CAPABILITY_SLUG, AGENT_JOB_LEASE_SECONDS, AGENT_JOB_POINTS_CAP, AGENT_MAX_DELIVERED_ROWS } from "./constants";
import { executionBudgetUsd, legacyPriceMissionByCode, priceMissionByCode, settlementCharge } from "./price";
import { firstSentenceAr, stagePriceInputs, type PricedPlan } from "./plan";

/**
 * The two money moments of a mission. BOTH go through the functions the website already uses; no money table is written by hand:
 *
 *   approve  create_quote_atomic -> accept_quote_atomic (reserves res_<job> in the ledger and creates the job) -> claim_job_chunk (a long lease on the job so the website's
 *            old driver never runs a chunk of it; complete_chunk or release_job_atomic ends it)
 *   settle   complete_chunk (records the delivered unique rows and clears the lease) -> settle_job_atomic (charge = ceil(delivered x the job's unit price), never above the reserve; the minimum charge is inside that unit, see missionPricing.ts; the rest
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
  claim_failed: "تعذّر إغلاق المهمة أمام المنفّذ القديم؛ حجز مؤقت مُحرَّر ولم يُخصم أي رصيد.",
};
const fail = (code: string): ApproveResult => ({ ok: false, code, messageAr: APPROVE_FAILURES[code] ?? "تعذّر اعتماد المهمة." });

/** The stored plan priced AGAIN by code: what the site shows and reserves is never a stored number that nobody recomputed. */
export function repriceStoredPlan(plan: PricedPlan) {
  // a plan stored before the one pricing rule (no `rule` on its price) is approved at the price it showed: the old formula; a new one is priced again with the markup and the minimum it was priced with
  if (plan.price.rule !== 2) return legacyPriceMissionByCode(plan.stages.map((s) => ({ rows: s.planned_rows, costPerRowUsd: s.measured_cost_per_row_usd, deliver: s.deliver })));
  return priceMissionByCode(stagePriceInputs(plan.stages), { settings: plan.price.settings });
}

export async function approveMission(client: any, mission: { id: string; user_id: string; plan: PricedPlan }, options: { now?: Date; expiresInMinutes?: number } = {}): Promise<ApproveResult> {
  const price = repriceStoredPlan(mission.plan);
  const stored = mission.plan.price;
  if (price.unitPricePoints !== stored.unitPricePoints || price.reservePoints !== stored.reservePoints || price.deliveredRows !== stored.deliveredRows) return fail("plan_changed");
  if (price.overCap || price.deliveredRows > AGENT_MAX_DELIVERED_ROWS) return fail("quote_failed");

  const now = options.now ?? new Date();
  const quoteId = `quote_${randomBytes(12).toString("hex")}`;
  const items = [{
    capabilitySlug: AGENT_CAPABILITY_SLUG, endpointId: AGENT_CAPABILITY_SLUG, missionId: mission.id,
    unitPricePoints: price.unitPricePoints, targetVolumeMin: 1, targetVolumeMax: price.deliveredRows, unitCostUsd: price.costPerFinalRowUsd,
    // what «طلباتي» says about the request: the one sentence the customer approved
    summaryAr: firstSentenceAr(mission.plan.summary_ar),
  }];
  const formats = ["xlsx", "csv"];
  const quoteHash = createHash("sha256").update(JSON.stringify({ items, formats })).digest("hex");
  const expiresAt = new Date(now.getTime() + (options.expiresInMinutes ?? 30) * 60_000).toISOString();

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
    await client.rpc("release_job_atomic", { p_job_id: jobId, p_error_message: "agent mission: the job could not be locked against the old driver" });
    return fail("claim_failed");
  }
  return { ok: true, jobId, quoteId, reservePoints: price.reservePoints, unitPricePoints: price.unitPricePoints, deliveredRows: price.deliveredRows, executionBudgetUsd: executionBudgetUsd(price.reservePoints) };
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
    const released = await client.rpc("release_job_atomic", { p_job_id: input.jobId, p_error_message: input.releaseReason ?? "agent mission delivered nothing" });
    if (released?.error) return { ok: false, code: "release_failed", detail: String(released.error.message ?? released.error.code ?? "").slice(0, 200) };
    return { ok: true, kind: "released", chargedPoints: 0, releasedPoints: input.reservedPoints };
  }
  const chunk = await client.rpc("complete_chunk", { p_job_id: input.jobId, p_expected_step: 0, p_new_cursor: "completed", p_new_delivered_units: delivered, p_cost_usd: Math.max(0, Number(input.costUsd.toFixed(6))) });
  if (chunk?.error) return { ok: false, code: "complete_chunk_failed", detail: String(chunk.error.message ?? chunk.error.code ?? "").slice(0, 200) };
  const settled = await client.rpc("settle_job_atomic", { p_job_id: input.jobId, p_points_cap: AGENT_JOB_POINTS_CAP, p_result_file_id: input.resultPath });
  if (settled?.error) return { ok: false, code: "settle_failed", detail: String(settled.error.message ?? settled.error.code ?? "").slice(0, 200) };
  const expected = settlementCharge({ deliveredUnits: delivered, unitPricePoints: input.unitPricePoints, reservedPoints: input.reservedPoints });
  const charged = Number(settled.data?.charged_credits ?? 0);
  const released = refundedPointsFromSettle(settled.data);
  return { ok: true, kind: "settled", chargedPoints: charged, releasedPoints: released, expectedChargedPoints: expected.chargedPoints, matchesExpectation: charged === expected.chargedPoints };
}
