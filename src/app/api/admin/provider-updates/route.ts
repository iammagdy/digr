import { NextRequest, NextResponse } from "next/server";
import { authenticateAdmin } from "@/lib/server/adminAuth";
import { createAdminClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;

  try {
    const supabase = createAdminClient();
    const { data, error } = await supabase.storage
      .from("office-internal")
      .download("provider-updates.json");

    if (error || !data) {
      return NextResponse.json(
        { ok: false, error: "feed_not_found", updates: [], total: 0 },
        { status: 404 }
      );
    }

    const text = await data.text();
    const payload = JSON.parse(text);
    return NextResponse.json(
      { ok: true, ...payload },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch {
    return NextResponse.json(
      { ok: false, error: "server_error", updates: [], total: 0 },
      { status: 500 }
    );
  }
}
