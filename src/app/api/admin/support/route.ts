import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { authenticateAdmin } from "@/lib/server/adminAuth";

export const dynamic = "force-dynamic";

function missingTable(error: any): boolean {
  return /42P01|PGRST205|does not exist|schema cache|could not find/i.test(`${error?.code || ""} ${error?.message || ""}`);
}

export async function GET(req: NextRequest) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  const { data, error } = await createAdminClient().from("support_messages").select("*").order("created_at", { ascending: false }).limit(200);
  if (error) {
    if (missingTable(error)) return NextResponse.json({ messages: [], migrationPending: true });
    return NextResponse.json({ error: "تعذّر تحميل الرسائل" }, { status: 500 });
  }
  return NextResponse.json({
    migrationPending: false,
    messages: (data || []).map((m: any) => ({
      id: m.id, name: m.name, email: m.email, message: m.message, jobId: m.job_id, source: m.source,
      status: m.status, emailed: m.emailed, createdAt: m.created_at,
    })),
  });
}

export async function PATCH(req: NextRequest) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  const body = await req.json().catch(() => ({}));
  if (!/^[0-9a-f-]{36}$/i.test(String(body?.id)) || !["new", "read", "closed"].includes(body?.status)) {
    return NextResponse.json({ error: "طلب غير صالح" }, { status: 400 });
  }
  const { error } = await createAdminClient().from("support_messages").update({ status: body.status }).eq("id", body.id);
  if (error) return NextResponse.json({ error: "تعذّر تحديث الحالة" }, { status: 500 });
  return NextResponse.json({ success: true });
}
