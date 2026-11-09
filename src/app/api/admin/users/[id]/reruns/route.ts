import { NextRequest, NextResponse } from "next/server";
import { authenticateAdmin } from "@/lib/server/adminAuth";
import { createAdminClient } from "@/lib/supabase/server";
import { answerQuestion, approveFreeRerun, cancelMission } from "@/lib/agentMission/adminActions";
import { compensateFreeRerun, createFreeRerun, isCustomersFreeRerun, listFreeReruns, refundPending, rerunSources } from "@/lib/agentMission/freeRerun";
import { sendMissionNotice } from "@/lib/server/missionNotify";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const USER_ID = /^[0-9a-fA-F-]{36}$/;

/**
 * «إعادة تشغيل مجانية»: the admin runs a request again on the CUSTOMER'S account, for free (src/lib/agentMission/freeRerun.ts).
 * GET: the customer's missions that can be run again, and their free re-runs (a settled re-run whose refund the worker missed is granted here, once).
 * POST {action}: create {sourceMissionId?, text?} · approve {missionId} · answer {missionId, text} · cancel {missionId} · refund {missionId}.
 * Every action on a re-run checks that it is a free re-run of THIS customer, and is written to the admin audit log.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  const { id } = await params;
  if (!USER_ID.test(id)) return NextResponse.json({ error: "معرّف غير صالح" }, { status: 400 });
  const client = createAdminClient();
  let reruns = await listFreeReruns(client, id);
  const due = reruns.filter(refundPending);
  if (due.length > 0) {
    for (const r of due) await compensateFreeRerun(client, { missionId: r.id });
    reruns = await listFreeReruns(client, id);
  }
  return NextResponse.json({ sources: await rerunSources(client, id), reruns });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  const { id } = await params;
  if (!USER_ID.test(id)) return NextResponse.json({ error: "معرّف غير صالح" }, { status: 400 });
  let body: any = {};
  try { body = await req.json(); } catch { return NextResponse.json({ error: "طلب غير صالح" }, { status: 400 }); }
  const client = createAdminClient();
  const fail = (status: number, error: string) => NextResponse.json({ error }, { status });

  if (body?.action === "create") {
    const r = await createFreeRerun(client, { adminId: auth.ctx.adminId, customerId: id, sourceMissionId: typeof body.sourceMissionId === "string" && body.sourceMissionId ? body.sourceMissionId : null, text: body.text });
    if (!r.ok) return fail(r.status, r.error);
    await auth.ctx.audit("rerun", "إعادة تشغيل مجانية لعميل", `${r.id}${body.sourceMissionId ? ` (عن ${body.sourceMissionId})` : ""}`, { targetType: "user", targetId: id });
    return NextResponse.json({ ok: true, id: r.id, messageAr: "أُنشئت المهمة على حساب العميل، ويخطط لها الوكيل الآن." });
  }

  const missionId = typeof body?.missionId === "string" ? body.missionId : "";
  if (!(await isCustomersFreeRerun(client, { missionId, customerId: id }))) return fail(404, "هذه ليست مهمة تشغيل مجاني لهذا العميل.");

  if (body.action === "approve") {
    const r = await approveFreeRerun(client, { id: missionId, adminId: auth.ctx.adminId });
    if (!r.ok) return fail(r.status, r.error);
    await auth.ctx.audit("approve", "اعتماد تشغيل مجاني لعميل", `${missionId}${r.holdGranted > 0 ? ` · رصيد حجز ${r.holdGranted}` : ""}`, { targetType: "user", targetId: id });
    // the customer is told the run started, as when they approve it themselves
    try { await sendMissionNotice(client, { userId: id, missionId, jobId: r.jobId, kind: "started", facts: { delivered: 0, planned: 0, chargedPoints: 0, releasedPoints: 0, hasJob: true } }); } catch { /* the notice never changes the approval */ }
    return NextResponse.json({ ok: true, messageAr: r.holdGranted > 0 ? "اعتُمدت المهمة؛ مُنح العميل رصيد الحجز لأن رصيده لم يكفِ، ويُعاد له ما يُخصم بعد التسوية." : "اعتُمدت المهمة؛ يُعاد للعميل ما يُخصم فور التسوية." });
  }
  if (body.action === "answer") {
    const r = await answerQuestion(client, { id: missionId, text: body.text });
    return r.ok ? NextResponse.json({ ok: true, messageAr: "وصلت الإجابة وعاد الوكيل إلى التخطيط." }) : fail(r.status, r.error);
  }
  if (body.action === "cancel") {
    const r = await cancelMission(client, { id: missionId });
    if (!r.ok) return fail(r.status, r.error);
    await auth.ctx.audit("rerun", "إلغاء تشغيل مجاني لعميل", missionId, { targetType: "user", targetId: id });
    return NextResponse.json({ ok: true, messageAr: "أُلغيت المهمة ولم يُحجز شيء." });
  }
  if (body.action === "refund") {
    const r = await compensateFreeRerun(client, { missionId });
    if (r.status === "failed") return fail(502, "تعذّر رد المبلغ الآن؛ حاول مرة أخرى.");
    if (r.status === "pending") return fail(409, "لم تُسوَّ المهمة بعد.");
    if (r.status === "granted") await auth.ctx.audit("rerun", "رد ما خُصم في تشغيل مجاني", `${missionId} · ${r.points}`, { targetType: "user", targetId: id });
    return NextResponse.json({ ok: true, messageAr: r.status === "granted" ? "أُعيد المبلغ للعميل." : r.status === "already_granted" ? "أُعيد المبلغ من قبل." : "لا شيء مستحق للرد." });
  }
  return fail(400, "طلب غير صالح");
}
