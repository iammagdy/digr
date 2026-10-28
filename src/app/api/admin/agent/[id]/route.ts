import { NextRequest, NextResponse } from "next/server";
import { authenticateAdmin } from "../../../../../lib/server/adminAuth";
import { createAdminClient } from "../../../../../lib/supabase/server";
import { answerQuestion, approvePlan, cancelMission, loadDetail } from "../../../../../lib/agentMission/adminActions";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const safeId = (id: string) => (/^msn_[a-z0-9]{8,40}$/.test(id) ? id : null);

/** Admin only. One mission: status, the plan with the price computed by code, the events after ?after=<event id>, the call totals and the files. */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  const id = safeId((await ctx.params).id);
  if (!id) return NextResponse.json({ error: "bad_input" }, { status: 400 });
  const after = Number(new URL(req.url).searchParams.get("after") ?? 0);
  const r = await loadDetail(createAdminClient(), { id, afterEventId: Number.isFinite(after) && after > 0 ? Math.floor(after) : 0 });
  return r.ok ? NextResponse.json(r) : NextResponse.json({ error: r.error }, { status: r.status });
}

/**
 * Admin only. Body {action}: "approve" reserves the plan's reserve through the EXISTING money functions (quote, accept, lock the job) and hands the mission to the worker; "answer" (+ text) answers
 * the agent's one question; "cancel" cancels a mission that holds nothing. The price is recomputed by code from the measured costs at approval; nothing the agent said sets it.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  const id = safeId((await ctx.params).id);
  if (!id) return NextResponse.json({ error: "bad_input" }, { status: 400 });
  let body: any = {};
  try { body = await req.json(); } catch { /* bad input below */ }
  const client = createAdminClient();
  const respond = (r: { ok: true } | { ok: false; status: number; error: string }, extra?: unknown) => (r.ok ? NextResponse.json(extra ?? r) : NextResponse.json({ error: r.error }, { status: r.status }));
  if (body?.action === "approve") {
    const r = await approvePlan(client, { id, adminId: auth.ctx.adminId });
    if (r.ok) await auth.ctx.audit("approve", "اعتماد خطة وكيل", id);
    return respond(r);
  }
  if (body?.action === "answer") return respond(await answerQuestion(client, { id, text: body.text }));
  if (body?.action === "cancel") return respond(await cancelMission(client, { id }));
  return NextResponse.json({ error: "bad_input" }, { status: 400 });
}
