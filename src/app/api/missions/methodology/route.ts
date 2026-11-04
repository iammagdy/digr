import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { resolveMissionViewer } from "@/lib/server/missionViewer";
import { listMethodologyMissions } from "@/lib/agentMission/methodology/missions";
import { methodologyChargeId } from "@/lib/methodologyOffer";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * THE CUSTOMER'S DELIVERED REQUESTS THAT A DATA-COLLECTION METHODOLOGY CAN BE WRITTEN FOR (round 21), for the chat's chooser card: what each request was, how many records it delivered and whether the methodology was already bought (the ledger row `chg_meth_<jobId>`).
 * Read only. The customer's own missions only; no internal id of a mission, no cost and no provider reaches the answer (the job id is the one the purchase route takes).
 */
export async function GET(req: NextRequest) {
  const auth = await resolveMissionViewer(req);
  if (!auth.ok) return auth.response;
  if (auth.viewer.isGuest) return NextResponse.json({ success: true, missions: [] }, { headers: { "Cache-Control": "no-store" } });
  const client = createAdminClient();
  const list = await listMethodologyMissions(client, auth.viewer.userId);
  const bought = new Set<string>();
  if (list.length > 0) {
    try {
      const { data } = await client.from("credit_ledger").select("id").eq("user_id", auth.viewer.userId).in("id", list.map((m) => methodologyChargeId(m.jobId)));
      for (const row of Array.isArray(data) ? data : []) bought.add(String(row.id));
    } catch { /* shown as not bought: the purchase route re-checks and charges once */ }
  }
  return NextResponse.json({ success: true, missions: list.map((m) => ({ jobId: m.jobId, titleAr: m.titleAr, deliveredUnits: m.deliveredUnits, purchased: bought.has(methodologyChargeId(m.jobId)) })) }, { headers: { "Cache-Control": "no-store" } });
}
