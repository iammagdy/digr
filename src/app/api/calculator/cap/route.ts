import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { resolveProviderLimits } from "@/lib/server/providerLimits";
import { dailyCapPointsFor } from "@/lib/calculatorPricing";

export const dynamic = "force-dynamic";

/** Public: the live daily limit as customer POINTS only (never the provider USD value), for the calculator's cap logic. */
export async function GET() {
  try {
    const { limits } = await resolveProviderLimits(createAdminClient());
    return NextResponse.json({ dailyCapPoints: dailyCapPointsFor(limits.dailyUsd) }, { headers: { "Cache-Control": "public, max-age=30" } });
  } catch {
    return NextResponse.json({ dailyCapPoints: null });
  }
}
