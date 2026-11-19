import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { authenticateAdmin } from "@/lib/server/adminAuth";
import { bannedUntilOf, parseSuspendInput, setAccountSuspension } from "@/lib/server/accountSuspension";

export const dynamic = "force-dynamic";

const validId = (id: string): boolean => /^[0-9a-fA-F-]{36}$/.test(id);

/** «أوقف الحساب» dialog: whether the account is suspended now and until when (the running requests are counted by the dialog from the profile's requests list: this route never reads the requests table). */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  const { id } = await params;
  if (!validId(id)) return NextResponse.json({ success: false, error: "معرّف غير صالح" }, { status: 400 });
  const admin = createAdminClient();
  const found = await admin.auth.admin.getUserById(id).catch(() => null);
  const user = found?.data?.user ?? null;
  if (!user) return NextResponse.json({ success: false, error: "الحساب غير موجود." }, { status: 404 });
  const until = bannedUntilOf(user as { banned_until?: string | null });
  const suspended = until !== null && until > Date.now();
  return NextResponse.json({ success: true, suspended, bannedUntil: suspended ? new Date(until!).toISOString() : null, self: id === auth.ctx.adminId });
}

/** Suspend or reactivate (Tier A, DT-20261118-06 phase 1C): the admin role is checked by authenticateAdmin; the admin can never suspend himself or another admin; every action is written to the audit log with its reason. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  const { id } = await params;
  if (!validId(id)) return NextResponse.json({ success: false, error: "معرّف غير صالح" }, { status: 400 });
  const parsed = parseSuspendInput(await req.json().catch(() => ({})));
  if (!parsed.ok) return NextResponse.json({ success: false, error: parsed.errorAr }, { status: 400 });
  const outcome = await setAccountSuspension(createAdminClient(), { ...parsed.input, adminId: auth.ctx.adminId, userId: id });
  if (!outcome.ok) return NextResponse.json({ success: false, error: outcome.messageAr, reason: outcome.reason }, { status: outcome.status });
  const label = parsed.input.action === "suspend" ? `إيقاف حساب (${parsed.input.duration})` : "إعادة تفعيل حساب";
  await auth.ctx.audit("setting", `${label}: ${parsed.input.reason}`, id, { targetType: "user", targetId: id });
  return NextResponse.json({ success: true, suspended: outcome.suspended, bannedUntil: outcome.bannedUntil });
}
