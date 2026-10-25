import { NextRequest, NextResponse } from "next/server";
import { authenticateAdmin } from "@/lib/server/adminAuth";
import { createAdminClient } from "@/lib/supabase/server";
import { backupZipFileName } from "@/lib/adminExport";
import { prepareBackupZip } from "./backupZip";

export const dynamic = "force-dynamic";
/** The ZIP is streamed, so it has no 4.5 MB answer limit; reading stops by itself before this limit (EXPORT_ZIP_TIME_BUDGET_MS). */
export const maxDuration = 60;

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * Admin only, SELECT only: ONE ZIP with the five tables as CSV files (byte for byte the files the page-by-page download writes) and a manifest.json
 * written last. Nothing is cached anywhere, nothing is written to any table, and no row is ever logged.
 */
export async function GET(req: NextRequest) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) {
    const refusal = new NextResponse(auth.response.body, { status: auth.response.status, headers: auth.response.headers });
    refusal.headers.set("Cache-Control", "no-store");
    return refusal;
  }

  const at = new Date();
  const prepared = await prepareBackupZip(createAdminClient(), { now: at });
  if (!prepared.ok) return NextResponse.json({ error: prepared.error }, { status: prepared.status, headers: NO_STORE });

  return new NextResponse(prepared.stream, {
    status: 200,
    headers: {
      ...NO_STORE,
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${backupZipFileName(at)}"`,
      "X-Export-Rows": String(prepared.expectedRows),
      "X-Content-Type-Options": "nosniff",
    },
  });
}
