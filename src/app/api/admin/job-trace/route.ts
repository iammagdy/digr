import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { authenticateAdmin } from "@/lib/server/adminAuth";
import { readRoutingTrace } from "@/lib/server/multiProvider/traceStore";
import { summarizeTrace } from "@/lib/multiProvider/trace";

export const dynamic = "force-dynamic";

/**
 * The routing trace of one job: the router's decision (what, by whom, why, the stages, the routes that were excluded) and what each
 * stage did (provider and capability, calls, cost, found / new / duplicate, fallbacks). READ ONLY and admin only: provider names, USD and
 * capability ids never reach a customer route, and the trace is not stored where a customer can read it (the private partials bucket).
 */
export async function GET(req: NextRequest) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  const jobId = (req.nextUrl.searchParams.get("jobId") || "").trim();
  if (!/^[A-Za-z0-9_-]{6,80}$/.test(jobId)) return NextResponse.json({ error: "معرّف الطلب غير صالح." }, { status: 400 });
  try {
    const trace = await readRoutingTrace(createAdminClient(), jobId);
    if (!trace) return NextResponse.json({ trace: null, summary: null }, { headers: { "Cache-Control": "no-store" } });
    return NextResponse.json({ trace, summary: summarizeTrace(trace) }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "تعذر تحميل مسار الطلب الآن." }, { status: 500 });
  }
}
