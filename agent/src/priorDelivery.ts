import type { PricedPlan } from "../../src/lib/agentMission/plan";
import {
  PRIOR_DELIVERY_MAX_MISSIONS,
  PRIOR_DELIVERY_PATH,
  parsePriorDeliverySnapshot,
  planPriorDeliveryOf,
  priorDeliveryLineAr,
  priorDeliveryMatcherOf,
  priorDeliverySnapshotOf,
  type PlanPriorDelivery,
  type PriorDeliveryMatcher,
  type PriorDeliverySnapshot,
} from "../../src/lib/agentMission/priorDelivery";
import { readSnapshot } from "./items/itemStore";
import type { AgentStore, MissionRecord } from "./types";

/**
 * P0 (15 Nov 2026, msn_8824508f840f703dee69): «WITHOUT REPEATING WHAT WAS DELIVERED» IN THE WORKER (the shared contract: src/lib/agentMission/priorDelivery.ts).
 *
 * PLANNING: the earlier missions the chat server recorded on THIS mission's card (`messages.plan.priorDelivery`, server-written) are verified (the same customer, completed, something delivered) and their item stores are read; the
 * identities of every item they delivered become a snapshot, written to this mission's private folder and pinned by digest on the plan the customer approves. A read that fails throws (the planning's error path retries it):
 * the customer's requirement is never silently dropped.
 * EXECUTION: a plan approved with a snapshot never runs without exactly that snapshot (fail closed, like the customer's exclusion list).
 */

/** The earlier missions recorded on this mission's card, or null when the card records none (the customer did not ask for it). Throws when the read fails. */
export type ReadPriorDeliveryCard = (missionId: string, userId: string) => Promise<{ missionIds: string[] } | null>;
/** Of these missions, the ones of this customer that completed and delivered something, with the stages their file was built from (key and planned rows). Throws when the read fails. */
export type ReadDeliveredMissions = (missionIds: string[], userId: string) => Promise<Array<{ id: string; stages: Array<{ key: string; rows: number }> }>>;

const MISSION_ID = /^msn_[a-z0-9]{8,40}$/;

export async function priorDeliveryForPlanning(input: { mission: MissionRecord; store: AgentStore; readCard?: ReadPriorDeliveryCard; readMissions?: ReadDeliveredMissions }): Promise<PriorDeliverySnapshot | null> {
  const { mission, store } = input;
  if (!input.readCard || !input.readMissions) return null;
  const card = await input.readCard(mission.id, mission.user_id);
  if (!card) return null;
  const ids = [...new Set(card.missionIds.filter((id) => typeof id === "string" && MISSION_ID.test(id) && id !== mission.id))].slice(0, PRIOR_DELIVERY_MAX_MISSIONS);
  const delivered = ids.length > 0 ? await input.readMissions(ids, mission.user_id) : [];
  const missions: Array<{ id: string; rows: Array<Record<string, unknown>> }> = [];
  for (const m of delivered) {
    if (!ids.includes(m.id)) continue;
    const snap = await readSnapshot(store, m.id);
    missions.push({ id: m.id, rows: m.stages.flatMap((s) => snap.acceptedRows(s.key, Math.max(0, s.rows))) });
  }
  return priorDeliverySnapshotOf(missions);
}

/** The plan with the snapshot pinned: the private copy written, the digest recorded, one sentence on the card. */
export async function withPriorDelivery(plan: PricedPlan, missionId: string, store: AgentStore, snapshot: PriorDeliverySnapshot | null): Promise<PricedPlan> {
  if (!snapshot) return plan;
  const mark = planPriorDeliveryOf(snapshot);
  if (mark.items > 0) await store.putFile(missionId, PRIOR_DELIVERY_PATH, JSON.stringify(snapshot), "application/json");
  return { ...plan, notes_ar: [...new Set([...(plan.notes_ar ?? []), priorDeliveryLineAr(mark)])], prior_delivery: mark };
}

/** The approved snapshot's matcher, or null when it cannot be loaded with exactly the approved digest (missing, unreadable, altered). */
export async function loadApprovedPriorDelivery(store: AgentStore, missionId: string, mark: PlanPriorDelivery): Promise<PriorDeliveryMatcher | null> {
  try {
    const raw = await store.getFile(missionId, PRIOR_DELIVERY_PATH);
    if (!raw) return null;
    const snapshot = parsePriorDeliverySnapshot(JSON.parse(raw));
    if (!snapshot || snapshot.digest !== mark.digest || snapshot.items !== mark.items) return null;
    return priorDeliveryMatcherOf(snapshot);
  } catch {
    return null;
  }
}

/** The real card reader: the assistant message of THIS user that carries THIS mission's card (the same lookup as the brief's); a failed read throws. */
export function priorDeliveryCardReader(client: any): ReadPriorDeliveryCard {
  return async (missionId, userId) => {
    const { data, error } = await client.from("messages").select("plan,created_at").eq("user_id", userId).eq("role", "assistant").eq("plan->>agentMissionId", missionId).order("created_at", { ascending: false }).limit(1);
    if (error) throw new Error("prior_delivery_card_read_failed");
    const raw = Array.isArray(data) ? data[0]?.plan?.priorDelivery : undefined;
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.missionIds)) return null;
    return { missionIds: (raw.missionIds as unknown[]).filter((x): x is string => typeof x === "string") };
  };
}

/** The real mission reader: only missions of THIS user that completed and delivered at least one row; their file's stages are the plan's delivered stages. A failed read throws. */
export function deliveredMissionsReader(client: any): ReadDeliveredMissions {
  return async (missionIds, userId) => {
    const { data, error } = await client.from("missions").select("id,user_id,status,delivered_units,plan").in("id", missionIds).eq("user_id", userId);
    if (error) throw new Error("prior_delivery_missions_read_failed");
    return (Array.isArray(data) ? data : [])
      .filter((m: any) => m && m.user_id === userId && m.status === "completed" && Number(m.delivered_units ?? 0) > 0 && Array.isArray(m.plan?.stages))
      .map((m: any) => ({ id: String(m.id), stages: (m.plan.stages as any[]).filter((s) => s && s.deliver !== false && typeof s.key === "string").map((s) => ({ key: String(s.key), rows: Math.max(0, Math.floor(Number(s.planned_rows) || 0)) })) }));
  };
}
