import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { currentDriverMode } from "@/lib/server/driverTick";
import { longJobDriverMode } from "@/lib/driverMode";

export const dynamic = "force-dynamic";

/**
 * Public and read-only: which driver the page may be told about («tab» or «cron»). «cron» only while the flag is on AND the scheduler was
 * seen calling the driver within the last three minutes; anything else is «tab». No secret and no data. Edge-cached for 30 seconds.
 */
export async function GET() {
  let mode: "tab" | "cron" = "tab";
  try { mode = await currentDriverMode(createAdminClient()); } catch { mode = "tab"; }
  return NextResponse.json({ mode, configured: longJobDriverMode() }, { headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=30" } });
}
