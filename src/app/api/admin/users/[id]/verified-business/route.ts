import { NextRequest, NextResponse } from "next/server";
import { authenticateAdmin } from "../../../../../../lib/server/adminAuth";
import { createAdminClient } from "../../../../../../lib/supabase/server";
import { VERIFIED_BUSINESS_TABLE } from "../../../../../../lib/server/sensitiveAccess";

export const dynamic = "force-dynamic";

/** Admin only: whether this customer account is marked «verified business» (may use the sensitive data category). A missing table reads as «not verified». */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  const { id } = await params;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return NextResponse.json({ error: "معرّف غير صالح" }, { status: 400 });
  const { data, error } = await createAdminClient().from(VERIFIED_BUSINESS_TABLE).select("verified,verified_at,note").eq("user_id", id).maybeSingle();
  return NextResponse.json({ verified: !error && data?.verified === true, verifiedAt: data?.verified_at ?? null, note: data?.note ?? "", available: !error });
}

/** Admin only. Body: { verified: boolean, note?: string }. Written by the service role; the change is recorded in the admin audit. */
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  const { id } = await params;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return NextResponse.json({ error: "معرّف غير صالح" }, { status: 400 });
  let body: any = {};
  try { body = await req.json(); } catch { /* handled below */ }
  if (typeof body?.verified !== "boolean") return NextResponse.json({ error: "الحالة مطلوبة" }, { status: 400 });
  const note = typeof body?.note === "string" ? body.note.slice(0, 200) : "";
  const { error } = await createAdminClient().from(VERIFIED_BUSINESS_TABLE).upsert({ user_id: id, verified: body.verified, verified_by: auth.ctx.adminId, verified_at: new Date().toISOString(), note }, { onConflict: "user_id" });
  if (error) return NextResponse.json({ success: false, error: "تعذّر الحفظ: الجدول غير مُفعَّل بعد." }, { status: 503 });
  await auth.ctx.audit("setting", body.verified ? "توثيق حساب أعمال" : "إلغاء توثيق حساب أعمال", id, { targetType: "user", targetId: id });
  return NextResponse.json({ success: true, verified: body.verified });
}
