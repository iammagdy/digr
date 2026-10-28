import { NextRequest, NextResponse } from "next/server";
import { createAdminClient, createServerSideClient } from "@/lib/supabase/server";
import { resolveJobConversation } from "@/lib/server/jobConversation";

export const dynamic = "force-dynamic";

/** The conversation a request of the signed-in customer belongs to (so «طلباتي» opens the request in its own conversation, never in a new empty chat). Own requests only. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: jobId } = await params;
    if (!jobId || jobId.length > 120) return NextResponse.json({ success: false, error: "معرف الطلب مطلوب" }, { status: 400 });
    const supabase = await createServerSideClient();
    const authHeader = req.headers.get("authorization");
    const { data } = authHeader?.startsWith("Bearer ") ? await supabase.auth.getUser(authHeader.substring(7).trim()) : await supabase.auth.getUser();
    const user = data?.user;
    if (!user) return NextResponse.json({ success: false, error: "غير مصرح. يرجى تسجيل الدخول أولاً." }, { status: 401 });
    const found = await resolveJobConversation(createAdminClient(), { userId: user.id, jobId });
    return NextResponse.json({ success: true, conversationId: found?.conversationId ?? null }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ success: false, error: "تعذّر تحديد محادثة الطلب." }, { status: 500 });
  }
}
