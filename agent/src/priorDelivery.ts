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

/**
 * Whether this mission's card asks to exclude earlier deliveries, and the earlier missions of ITS conversation (read by the worker itself from the server-written cards of the same user, created before this one; the chat's own list
 * is added). Null when the card does not ask. Throws when any read fails: the requirement is never silently reduced to «nothing to exclude».
 */
export type ReadPriorDeliveryCard = (missionId: string, userId: string) => Promise<{ missionIds: string[] } | null>;
/** Of these missions, the ones of this customer, with their status, delivered rows and the stages their file was built from (key and planned rows). Throws when the read fails. */
export type ReadDeliveredMissions = (missionIds: string[], userId: string) => Promise<Array<{ id: string; status: string; delivered: number; stages: Array<{ key: string; rows: number }> }>>;
/** A mission that is still collecting after approval (what it saved so far is excluded; the card says the rest is not known yet). */
const RUNNING = new Set(["approved", "executing"]);

const MISSION_ID = /^msn_[a-z0-9]{8,40}$/;

export async function priorDeliveryForPlanning(input: { mission: MissionRecord; store: AgentStore; readCard?: ReadPriorDeliveryCard; readMissions?: ReadDeliveredMissions }): Promise<PriorDeliverySnapshot | null> {
  const { mission, store } = input;
  if (!input.readCard || !input.readMissions) return null;
  const card = await input.readCard(mission.id, mission.user_id);
  if (!card) return null;
  const ids = [...new Set(card.missionIds.filter((id) => typeof id === "string" && MISSION_ID.test(id) && id !== mission.id))].slice(0, PRIOR_DELIVERY_MAX_MISSIONS);
  const found = ids.length > 0 ? await input.readMissions(ids, mission.user_id) : [];
  const missions: Array<{ id: string; rows: Array<Record<string, unknown>> }> = [];
  let running = 0;
  let unreadable = 0;
  for (const m of found) {
    if (!ids.includes(m.id)) continue;
    const delivered = m.status === "completed" && m.delivered > 0;
    const live = RUNNING.has(m.status);
    if (!delivered && !live) continue;
    const snap = await readSnapshot(store, m.id);
    let rows = m.stages.flatMap((s) => snap.acceptedRows(s.key, Math.max(0, s.rows)));
    // an older mission kept its delivered rows only in the stage files (before the item store): read them there
    if (rows.length === 0 && delivered) rows = (await Promise.all(m.stages.map(async (s) => legacyRows(await store.getFile(m.id, `rows/${s.key}.json`), s.rows)))).flat();
    if (live) running += 1;
    if (rows.length === 0 && delivered) { unreadable += 1; continue; }
    missions.push({ id: m.id, rows });
  }
  return priorDeliverySnapshotOf(missions, { running, unreadable });
}

function legacyRows(raw: string | null, max: number): Array<Record<string, unknown>> {
  if (!raw) return [];
  try { const v = JSON.parse(raw) as unknown; return Array.isArray(v) ? (v.filter((r) => r && typeof r === "object") as Array<Record<string, unknown>>).slice(0, Math.max(0, max)) : []; } catch { return []; }
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
    const { data, error } = await client.from("messages").select("plan,created_at,conversation_id").eq("user_id", userId).eq("role", "assistant").eq("plan->>agentMissionId", missionId).order("created_at", { ascending: false }).limit(1);
    if (error) throw new Error("prior_delivery_card_read_failed");
    const card = Array.isArray(data) ? data[0] : undefined;
    const raw = card?.plan?.priorDelivery;
    if (!raw || typeof raw !== "object") return null;
    const fromChat = Array.isArray(raw.missionIds) ? (raw.missionIds as unknown[]).filter((x): x is string => typeof x === "string") : [];
    // the conversation's earlier cards, read here (the chat's list may be empty after a failed read on its side): same user, same conversation, created before this card
    if (typeof card.conversation_id !== "string" || typeof card.created_at !== "string") throw new Error("prior_delivery_card_incomplete");
    const earlier = await client.from("messages").select("plan,created_at").eq("conversation_id", card.conversation_id).eq("user_id", userId).eq("role", "assistant").lt("created_at", card.created_at).order("created_at", { ascending: false }).limit(100);
    if (earlier.error) throw new Error("prior_delivery_conversation_read_failed");
    const ids = new Set<string>(fromChat);
    for (const row of Array.isArray(earlier.data) ? earlier.data : []) { const id = row?.plan?.agentMissionId; if (typeof id === "string" && id !== missionId) ids.add(id); }
    return { missionIds: [...ids] };
  };
}

/** The real mission reader: only missions of THIS user, with status and delivered rows; their file's stages are the plan's delivered stages. A failed read throws. */
export function deliveredMissionsReader(client: any): ReadDeliveredMissions {
  return async (missionIds, userId) => {
    const { data, error } = await client.from("missions").select("id,user_id,status,delivered_units,plan").in("id", missionIds).eq("user_id", userId);
    if (error) throw new Error("prior_delivery_missions_read_failed");
    return (Array.isArray(data) ? data : [])
      .filter((m: any) => m && m.user_id === userId && typeof m.status === "string" && Array.isArray(m.plan?.stages))
      .map((m: any) => ({ id: String(m.id), status: String(m.status), delivered: Math.max(0, Math.floor(Number(m.delivered_units ?? 0) || 0)), stages: (m.plan.stages as any[]).filter((s) => s && s.deliver !== false && typeof s.key === "string").map((s) => ({ key: String(s.key), rows: Math.max(0, Math.floor(Number(s.planned_rows) || 0)) })) }));
  };
}
