import { NextResponse } from "next/server";
import { liveDriverMode } from "@/lib/server/driverHeartbeat";

export const dynamic = "force-dynamic";

/** Public and read-only: whether the always-on driver is LIVE right now («cron») or not («tab»), from its last tick. No secret, no data. */
export async function GET() {
  return NextResponse.json({ mode: await liveDriverMode() }, { headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=30" } });
}
