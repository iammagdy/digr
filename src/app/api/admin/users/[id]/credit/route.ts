import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { authenticateAdmin } from "@/lib/server/adminAuth";
import { grantCreditAsAdmin, parseGrantPoints } from "@/lib/server/adminCredit";

export const dynamic = "force-dynamic";

/** «إضافة رصيد يدوي»: the route checks the admin role, and the database function checks it again. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  const { id } = await params;
  if (!/^[0-9a-fA-F-]{36}$/.test(id)) return NextResponse.json({ success: false, error: "معرّف غير صالح" }, { status: 400 });

  const body = await req.json().catch(() => ({}));
  const points = parseGrantPoints(body?.points);
  if (points === null) {
    return NextResponse.json({ success: false, error: "عدد النقاط يجب أن يكون رقمًا صحيحًا موجبًا." }, { status: 400 });
  }
  const note = String(body?.note ?? "").trim();
  if (note.length < 3 || note.length > 200) {
    return NextResponse.json({ success: false, error: "اكتب سبب الإضافة (٣ أحرف على الأقل)." }, { status: 400 });
  }
  const supplied = typeof body?.requestId === "string" ? body.requestId : "";
  const requestId = /^[A-Za-z0-9_-]{8,64}$/.test(supplied) ? supplied : randomUUID();

  const outcome = await grantCreditAsAdmin(createAdminClient(), {
    adminId: auth.ctx.adminId,
    userId: id,
    points,
    note,
    requestId,
  });
  if (!outcome.ok) {
    const status = outcome.reason === "not_admin" ? 403 : outcome.reason === "unavailable" ? 503 : outcome.reason === "failed" ? 500 : 400;
    return NextResponse.json({ success: false, error: outcome.messageAr, reason: outcome.reason }, { status });
  }
  await auth.ctx.audit("setting", "إضافة رصيد يدوي", id, { targetType: "user", targetId: id });
  return NextResponse.json({ success: true, points: outcome.points, balance: outcome.balance, alreadyGranted: outcome.alreadyGranted, messageAr: outcome.messageAr, requestId });
}
