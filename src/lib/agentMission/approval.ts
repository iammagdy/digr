import { MISSION_EVENTS_TABLE, MISSION_TABLE } from "./constants";
import { approveMission } from "./lifecycle";
import type { PricedPlan } from "./plan";

/**
 * The ONE approval path of a mission, shared by the admin page and the customer: it claims the transition `plan_ready -> approved` first, atomically (a double click or two tabs approve at
 * most once: the claim must change exactly one row), then re-prices the stored plan by code and reserves through the EXISTING money functions (approveMission), and records the result.
 * Nothing here writes a money table directly.
 */
export type ApprovalResult =
  | { ok: true; jobId: string; reservePoints: number; unitPricePoints: number }
  | { ok: false; status: number; error: string; code?: string };

const bad = (status: number, error: string, code?: string): ApprovalResult => ({ ok: false, status, error, ...(code ? { code } : {}) });

export interface ApprovalInput {
  id: string;
  /** Who approved: the admin or the customer (stored in approved_by). */
  actorId: string;
  /** The mission must belong to this user (the customer path), or be any user's (the admin path checks the test account itself). */
  expectUserId?: string;
  /** Texts of the money failures (the customer and the admin read different words). */
  messages?: Partial<Record<string, string>>;
}

export async function approveMissionOnce(client: any, input: ApprovalInput): Promise<ApprovalResult> {
  const { data: mission } = await client.from(MISSION_TABLE).select("id,user_id,status,plan").eq("id", input.id).maybeSingle();
  if (!mission || (input.expectUserId && mission.user_id !== input.expectUserId)) return bad(404, "المهمة غير موجودة.");
  if (mission.status !== "plan_ready" || !mission.plan) return bad(409, "لا توجد خطة جاهزة للاعتماد.");
  const claim = await client.from(MISSION_TABLE).update({ status: "approved", approved_at: new Date().toISOString(), approved_by: input.actorId, worker_id: null, lease_until: new Date(Date.now() + 3600_000).toISOString() }).eq("id", input.id).eq("status", "plan_ready").select("id");
  if (claim.error) return bad(500, "تعذّر الاعتماد.");
  // the claim changed no row: another click got there first
  if (Array.isArray(claim.data) && claim.data.length === 0) return bad(409, "هذه الخطة اعتُمدت بالفعل.");
  const result = await approveMission(client, { id: mission.id, user_id: mission.user_id, plan: mission.plan as PricedPlan });
  if (!result.ok) {
    await client.from(MISSION_TABLE).update({ status: "plan_ready", lease_until: null, error: result.code }).eq("id", input.id);
    return bad(result.code === "insufficient_balance" ? 402 : 409, input.messages?.[result.code] ?? result.messageAr, result.code);
  }
  await client.from(MISSION_TABLE).update({ job_id: result.jobId, quote_id: result.quoteId, reserved_points: result.reservePoints, unit_price_points: result.unitPricePoints, lease_until: null, error: null, updated_at: new Date().toISOString() }).eq("id", input.id);
  await client.from(MISSION_EVENTS_TABLE).insert({ mission_id: input.id, kind: "system", message_ar: "اعتُمدت الخطة وحُجز الرصيد؛ يبدأ التنفيذ الآن.", counts: {} });
  return { ok: true, jobId: result.jobId, reservePoints: result.reservePoints, unitPricePoints: result.unitPricePoints };
}
