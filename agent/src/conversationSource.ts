import { buildAsk } from "../../src/lib/agentMission/foundation/ask";
import { sourceIdOf } from "../../src/lib/agentMission/foundation/sourceScope";
import { normalizeText } from "../../src/lib/agentMission/relevance";
import { readRunState } from "./runState";
import type { AgentStore, MissionRecord } from "./types";

/**
 * P0 (15 Nov 2026, live acceptance msn_5abbc68352f31fa31d56): A SOURCE THE CUSTOMER ALREADY IDENTIFIED IN THIS CONVERSATION IS NOT ASKED AGAIN.
 *
 * The follow-up «ممكن تكمّل البحث … من نفس الحساب، من غير ما تكرر» kept the topic, the period, the count and the exclusion, but the source came back as its NAME («وزارة الصحة السعودية») and the customer was asked
 * for the handle again, although they had answered «@SaudiMOH» to that very question earlier in the same conversation. The identifier lives in the earlier mission's planning choices.
 *
 * The rule: when this mission names a source by name (no identifier written), an EARLIER mission of the SAME customer in the SAME conversation whose request named the SAME source (the same name, compared in the normalized form)
 * and whose customer confirmed an identifier for it gives that identifier. Nothing is guessed: a different name, another customer, another conversation, or a failed read gives nothing, and the source question is asked as before.
 * The plan states the account it is scoped to («النتائج من حساب «@…» وحده»), so the customer sees it before approving.
 */
export type ReadConversationMissions = (missionId: string, userId: string) => Promise<Array<{ id: string; request_text: string; created_at?: string | null }>>;

export async function conversationSourceIdOf(input: { mission: MissionRecord; store: AgentStore; read: ReadConversationMissions; nowMs?: number }): Promise<{ id: string; from: string } | null> {
  const { mission, store } = input;
  const now = input.nowMs ?? (Date.parse(String(mission.created_at ?? "")) || Date.now());
  const source = buildAsk(mission.request_text, null, now).source;
  if (source.kind !== "named" || !source.text || sourceIdOf(source.text)) return null;
  const want = normalizeText(source.text);
  if (want === "") return null;
  const earlier = await input.read(mission.id, mission.user_id);
  for (const e of earlier) {
    if (!e || e.id === mission.id) continue;
    const was = buildAsk(e.request_text, null, Date.parse(String(e.created_at ?? "")) || now).source;
    if (was.kind !== "named" || !was.text || normalizeText(was.text) !== want) continue;
    const chosen = (await readRunState(store, e.id)).choices?.sourceId;
    const id = chosen ? sourceIdOf(chosen) : null;
    if (id) return { id, from: e.id };
  }
  return null;
}

/** The real reader: the earlier missions of THIS customer's conversation (the cards written before this mission's card), newest first. A failed read throws (the caller then asks the source question as before). */
export function conversationMissionsReader(client: any): ReadConversationMissions {
  return async (missionId, userId) => {
    const card = await client.from("messages").select("conversation_id,created_at").eq("user_id", userId).eq("role", "assistant").eq("plan->>agentMissionId", missionId).order("created_at", { ascending: false }).limit(1);
    if (card.error) throw new Error("conversation_card_read_failed");
    const c = Array.isArray(card.data) ? card.data[0] : undefined;
    if (!c || typeof c.conversation_id !== "string" || typeof c.created_at !== "string") return [];
    const earlier = await client.from("messages").select("plan,created_at").eq("conversation_id", c.conversation_id).eq("user_id", userId).eq("role", "assistant").lt("created_at", c.created_at).order("created_at", { ascending: false }).limit(50);
    if (earlier.error) throw new Error("conversation_cards_read_failed");
    const order: string[] = [];
    for (const row of Array.isArray(earlier.data) ? earlier.data : []) { const id = row?.plan?.agentMissionId; if (typeof id === "string" && id !== missionId && !order.includes(id)) order.push(id); }
    if (order.length === 0) return [];
    const ms = await client.from("missions").select("id,user_id,request_text,created_at").in("id", order).eq("user_id", userId);
    if (ms.error) throw new Error("conversation_missions_read_failed");
    const byId = new Map<string, { id: string; request_text: string; created_at?: string | null }>();
    for (const m of Array.isArray(ms.data) ? ms.data : []) if (m && m.user_id === userId && typeof m.request_text === "string") byId.set(String(m.id), { id: String(m.id), request_text: m.request_text, created_at: m.created_at ?? null });
    return order.map((id) => byId.get(id)).filter((m): m is { id: string; request_text: string; created_at?: string | null } => Boolean(m));
  };
}
