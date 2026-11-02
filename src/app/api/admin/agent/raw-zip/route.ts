import { NextRequest, NextResponse } from "next/server";
import { authenticateAdmin } from "@/lib/server/adminAuth";
import { createAdminClient } from "@/lib/supabase/server";
import { RAW_ZIP_ERRORS_AR, parseMissionIds, prepareRawZip, rawZipFileName, type RawZipStorage } from "@/lib/agentMission/rawZip";

export const dynamic = "force-dynamic";
/** The ZIP is streamed; reading stops by itself before this limit (RAW_ZIP_TIME_BUDGET_MS). */
export const maxDuration = 60;

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * Admin only, read-only: ?ids=msn_…,msn_… (at most 40). ONE ZIP with the stored raw/ and rows/ objects of those missions from the private bucket
 * "agent-missions" (docs/FOUNDATION-PLAN.md, PR 1), through the server's existing admin client. Nothing is written, nothing is cached, and no object
 * content is ever logged (src/lib/agentMission/rawZip.ts).
 */
export async function GET(req: NextRequest) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) {
    const refusal = new NextResponse(auth.response.body, { status: auth.response.status, headers: auth.response.headers });
    refusal.headers.set("Cache-Control", "no-store");
    return refusal;
  }

  const parsed = parseMissionIds(req.nextUrl.searchParams.get("ids"));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400, headers: NO_STORE });

  const at = new Date();
  let storage: RawZipStorage;
  try { storage = createAdminClient().storage as unknown as RawZipStorage; } catch { return NextResponse.json({ error: RAW_ZIP_ERRORS_AR.unreadable }, { status: 500, headers: NO_STORE }); }
  const prepared = await prepareRawZip(storage, parsed.ids, { now: at });
  if (!prepared.ok) return NextResponse.json({ error: prepared.error }, { status: prepared.status, headers: NO_STORE });

  return new NextResponse(prepared.stream, {
    status: 200,
    headers: {
      ...NO_STORE,
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${rawZipFileName(at)}"`,
      "X-Raw-Objects": String(prepared.objects),
      "X-Content-Type-Options": "nosniff",
    },
  });
}
