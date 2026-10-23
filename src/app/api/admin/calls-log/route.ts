import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { authenticateAdmin } from "@/lib/server/adminAuth";
import { parseCallsLogQuery, readCallsLog } from "@/lib/server/adminCallsLog";

export const dynamic = "force-dynamic";

/**
 * Every provider API call (TREG, Firecrawl, Context.dev) with the user behind it, filtered and paginated on the server, with a summary of
 * the filtered rows. READ ONLY and admin only: the admin is checked first, and provider names, USD and user emails never reach a customer route.
 */
export async function GET(req: NextRequest) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  const parsed = parseCallsLogQuery(req.nextUrl.searchParams);
  if (!parsed.ok) return NextResponse.json({ error: parsed.messageAr }, { status: 400 });
  try {
    const result = await readCallsLog(createAdminClient(), parsed.value);
    return NextResponse.json({ log: result }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "تعذر تحميل سجل الاستدعاءات الآن." }, { status: 500 });
  }
}
