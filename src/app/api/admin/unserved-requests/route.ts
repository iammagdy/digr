import { NextRequest, NextResponse } from "next/server";
import { authenticateAdmin } from "@/lib/server/adminAuth";
import { createAdminClient } from "@/lib/supabase/server";
import { summarizeUnserved } from "@/lib/server/unservedRequests";

export const dynamic = "force-dynamic";

/** Admin only, read only: the latest requests the platform could not serve (or served in part), with a count per family. */
export async function GET(req: NextRequest) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  const { data, error } = await createAdminClient()
    .from("capability_requests")
    .select("id, user_id, query, created_at")
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) return NextResponse.json({ error: "تعذّر قراءة الطلبات الآن." }, { status: 500 });
  return NextResponse.json(summarizeUnserved((data || []) as any[]));
}
