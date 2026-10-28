import { NextRequest, NextResponse } from "next/server";
import { authenticateAdmin } from "../../../../lib/server/adminAuth";
import { createAdminClient } from "../../../../lib/supabase/server";
import { createMission, loadOverview, setMissionPricing, setPlanningModel } from "../../../../lib/agentMission/adminActions";

export const dynamic = "force-dynamic";

/** Admin only. The worker's heartbeat (alive or not), the planning-model setting and the latest missions of the agent. */
export async function GET(req: NextRequest) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  return NextResponse.json(await loadOverview(createAdminClient()));
}

/**
 * Admin only. Body {action: "create", text}: queues a mission FOR THE TEST ACCOUNT (iam.magdy+1@outlook.com) only; the worker plans it. Or {action: "planning_model", model}: the owner's
 * switch of PLANNING between claude-haiku-5-5 and claude-sonnet-5-5. Nothing here reserves money and no provider is called: the worker does that, after the admin approves.
 */
export async function POST(req: NextRequest) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  let body: any = {};
  try { body = await req.json(); } catch { /* bad input below */ }
  const client = createAdminClient();
  if (body?.action === "create") {
    const r = await createMission(client, { adminId: auth.ctx.adminId, text: body.text });
    if (r.ok) await auth.ctx.audit("agent", "إنشاء مهمة وكيل", r.id);
    return r.ok ? NextResponse.json(r) : NextResponse.json({ error: r.error }, { status: r.status });
  }
  if (body?.action === "planning_model") {
    const r = await setPlanningModel(client, { model: body.model, adminId: auth.ctx.adminId });
    if (r.ok) await auth.ctx.audit("setting", "نموذج تخطيط الوكيل", String(body.model));
    return r.ok ? NextResponse.json(r) : NextResponse.json({ error: r.error }, { status: r.status });
  }
  if (body?.action === "pricing") {
    const r = await setMissionPricing(client, { markup: body.markup, minChargePoints: body.minChargePoints, adminId: auth.ctx.adminId });
    // every change has an audit row: who, what, from what to what
    if (r.ok) {
      if (r.before.markup !== r.after.markup) await auth.ctx.audit("setting", "مضاعف سعر المهام", `markup: ${r.before.markup} → ${r.after.markup}`, { targetType: "agent_settings", targetId: "mission_pricing" });
      if (r.before.minChargePoints !== r.after.minChargePoints) await auth.ctx.audit("setting", "الحد الأدنى لخصم المهمة", `min_charge_points: ${r.before.minChargePoints} → ${r.after.minChargePoints}`, { targetType: "agent_settings", targetId: "mission_pricing" });
    }
    return r.ok ? NextResponse.json(r) : NextResponse.json({ error: r.error }, { status: r.status });
  }
  return NextResponse.json({ error: "bad_input" }, { status: 400 });
}
