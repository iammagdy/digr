import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { answerForCustomer, approveForCustomer, cancelForCustomer, loadCustomerMission } from "@/lib/agentMission/customerActions";
import { sendMissionNotice } from "@/lib/server/missionNotify";
import { resolveMissionViewer, safeMissionId } from "@/lib/server/missionViewer";
import { getLiveProviderGateStatusFromSettings } from "@/lib/server/providerGate";
import { getBusyState } from "@/lib/server/busyState";
import { countActiveJobs, evaluateConcurrentJobs } from "@/lib/server/concurrentJobs";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** The customer's own mission: the card and the live panel are drawn from this one answer (polled every few seconds while the mission is live). */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const id = safeMissionId((await ctx.params).id);
  if (!id) return NextResponse.json({ success: false, error: "bad_request" }, { status: 400 });
  const auth = await resolveMissionViewer(req);
  if (!auth.ok) return auth.response;
  const r = await loadCustomerMission(createAdminClient(), { id, userId: auth.viewer.userId });
  return r.ok ? NextResponse.json({ success: true, isGuest: auth.viewer.isGuest, status: r.status, requestText: r.requestText, view: r.view }, { headers: { "Cache-Control": "no-store" } }) : NextResponse.json({ success: false, error: r.error }, { status: r.status });
}

/**
 * Body {action}: "approve" (a guest signs up first; the reserve goes through the existing money functions), "cancel", "answer" (+ text), or "edit" (cancels a mission that holds nothing and
 * returns its words so the customer can change them and send again). The price is recomputed by code at approval; nothing the agent said sets it.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const id = safeMissionId((await ctx.params).id);
  if (!id) return NextResponse.json({ success: false, error: "bad_request" }, { status: 400 });
  const auth = await resolveMissionViewer(req);
  if (!auth.ok) return auth.response;
  let body: any = {};
  try { body = await req.json(); } catch { /* bad input below */ }
  const client = createAdminClient();
  const { viewer } = auth;
  const fail = (r: { status: number; error: string }) => NextResponse.json({ success: false, error: r.error }, { status: r.status });

  if (body?.action === "approve") {
    const r = await approveForCustomer(client, {
      id, userId: viewer.userId, isGuest: viewer.isGuest, emailVerified: viewer.emailVerified,
      precheck: async () => {
        const gate = await getLiveProviderGateStatusFromSettings(client);
        if (!gate.isReady) return { ok: false, status: 503, error: gate.messageAr };
        const busy = await getBusyState(client);
        if (busy.busy) return { ok: false, status: 503, error: busy.messageAr };
        const concurrency = evaluateConcurrentJobs(await countActiveJobs(client, viewer.userId));
        if (!concurrency.allowed) return { ok: false, status: 429, error: concurrency.messageAr };
        return { ok: true };
      },
      onApproved: async ({ jobId }) => { await sendMissionNotice(client, { userId: viewer.userId, missionId: id, jobId, kind: "started", facts: { delivered: 0, planned: 0, chargedPoints: 0, releasedPoints: 0, hasJob: true } }); },
    });
    return r.ok ? NextResponse.json({ success: true, jobId: r.jobId }) : fail(r);
  }
  if (body?.action === "cancel" || body?.action === "edit") {
    const r = await cancelForCustomer(client, { id, userId: viewer.userId });
    return r.ok ? NextResponse.json({ success: true, ...(body.action === "edit" ? { requestText: r.requestText } : {}) }) : fail(r);
  }
  if (body?.action === "answer") {
    const r = await answerForCustomer(client, { id, userId: viewer.userId, text: body.text });
    return r.ok ? NextResponse.json({ success: true }) : fail(r);
  }
  return NextResponse.json({ success: false, error: "bad_request" }, { status: 400 });
}
