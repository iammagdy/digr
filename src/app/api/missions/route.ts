import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { listOpenMissions } from "@/lib/agentMission/openMissions";
import { resolveMissionViewer } from "@/lib/server/missionViewer";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * The customer's OPEN missions (queued, being planned, a question to answer, a plan to approve), each with its state, whether it blocks a new request, and the conversation that holds its card.
 * It is computed by the same function as the limit on new requests (`openMissions.ts`), so nothing that blocks a request is hidden from the customer. Read only, except that a planning mission with no
 * live worker is ended honestly (it holds nothing).
 */
export async function GET(req: NextRequest) {
  const auth = await resolveMissionViewer(req);
  if (!auth.ok) return auth.response;
  const client = createAdminClient();
  const missions = await listOpenMissions(client, { userId: auth.viewer.userId });
  const conversationOf = new Map<string, string>();
  if (missions.length > 0) {
    try {
      const { data } = await client.from("messages").select("conversation_id,plan").eq("user_id", auth.viewer.userId).eq("role", "assistant").order("created_at", { ascending: false }).limit(300);
      for (const row of Array.isArray(data) ? data : []) {
        const id = row?.plan?.agentMissionId;
        if (typeof id === "string" && row.conversation_id && !conversationOf.has(id)) conversationOf.set(id, String(row.conversation_id));
      }
    } catch { /* the list still shows; the mission opens by its id */ }
  }
  return NextResponse.json({ success: true, missions: missions.map((m) => ({ ...m, conversationId: conversationOf.get(m.id) ?? null })) }, { headers: { "Cache-Control": "no-store" } });
}
