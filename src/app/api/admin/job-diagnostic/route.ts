import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { authenticateAdmin } from "@/lib/server/adminAuth";
import { readDiagnosticFile, totalDiagnostic } from "@/lib/server/zeroDeliveryDiagnostic";

export const dynamic = "force-dynamic";

/**
 * Why a job delivered nothing: the counts per reason and a sample of at most five posts and five rows that were turned away (cut short, links
 * and numbers masked). READ ONLY and admin only: the sample lives in the job's private storage and is never part of a customer response.
 */
export async function GET(req: NextRequest) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  const jobId = (req.nextUrl.searchParams.get("jobId") || "").trim();
  if (!/^[A-Za-z0-9_-]{6,80}$/.test(jobId)) return NextResponse.json({ error: "معرّف الطلب غير صالح." }, { status: 400 });
  try {
    const file = await readDiagnosticFile(createAdminClient().storage.from("partials"), jobId);
    if (Object.keys(file.steps).length === 0) return NextResponse.json({ diagnostic: null }, { headers: { "Cache-Control": "no-store" } });
    return NextResponse.json({ diagnostic: totalDiagnostic(file) }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "تعذر تحميل تشخيص الطلب الآن." }, { status: 500 });
  }
}
