import { MISSION_EVENTS_TABLE, MISSION_TABLE } from "./constants";
import { approveMission } from "./lifecycle";
import type { PricedPlan } from "./plan";

/** The customer passes the owned snapshot read before precheck. The database compares it under the mission lock. */
export type ApprovalSnapshot = Readonly<{ id: string; user_id: string; status: string; plan: PricedPlan; updated_at: string }>;

export type ApprovalResult =
  | { ok: true; jobId: string; reservePoints: number; unitPricePoints: number }
  | { ok: false; status: number; error: string; code?: string };

export const STALE_MISSION_PLAN_AR = "راجع الخطة والسعر قبل تأكيد الاعتماد مرة أخرى.";

const bad = (status: number, error: string, code?: string): ApprovalResult => ({ ok: false, status, error, ...(code ? { code } : {}) });

export interface ApprovalInput {
  id: string;
  actorId: string;
  expectUserId?: string;
  snapshot?: ApprovalSnapshot;
  messages?: Partial<Record<string, string>>;
}

export async function approveMissionOnce(client: any, input: ApprovalInput): Promise<ApprovalResult> {
  const mission: ApprovalSnapshot | null | undefined = input.snapshot
    ?? (await client.from(MISSION_TABLE).select("id,user_id,status,plan,updated_at").eq("id", input.id).maybeSingle()).data;
  if (!mission || mission.id !== input.id || (input.snapshot && !input.expectUserId)
    || (input.expectUserId && mission.user_id !== input.expectUserId)) return bad(404, "المهمة غير موجودة.");
  if (mission.status !== "plan_ready" || !mission.plan) return bad(409, "لا توجد خطة جاهزة للاعتماد.");
  if (typeof mission.updated_at !== "string" || !Number.isFinite(Date.parse(mission.updated_at))) {
    return bad(409, STALE_MISSION_PLAN_AR, "stale_plan");
  }

  const result = await approveMission(client, { id: mission.id, user_id: mission.user_id, plan: mission.plan }, {
    atomicMission: { actorId: input.actorId, expectedUpdatedAt: mission.updated_at },
  });
  if (!result.ok) {
    if (result.code === "stale_plan") return bad(409, STALE_MISSION_PLAN_AR, result.code);
    return bad(result.code === "insufficient_balance" ? 402 : 409, input.messages?.[result.code] ?? result.messageAr, result.code);
  }

  await client.from(MISSION_EVENTS_TABLE).insert({ mission_id: input.id, kind: "system", message_ar: "اعتُمدت الخطة وحُجز الرصيد؛ يبدأ التنفيذ الآن.", counts: {} });
  return { ok: true, jobId: result.jobId, reservePoints: result.reservePoints, unitPricePoints: result.unitPricePoints };
}
