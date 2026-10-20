import { NextResponse } from "next/server";
import { longJobDriverMode } from "@/lib/driverMode";

export const dynamic = "force-dynamic";

/** Public and read-only: which driver runs long jobs («tab» or «cron»). A configuration flag, no secret and no data. */
export async function GET() {
  return NextResponse.json({ mode: longJobDriverMode() }, { headers: { "Cache-Control": "no-store" } });
}
