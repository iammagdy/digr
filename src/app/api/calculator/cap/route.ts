import { NextRequest, NextResponse } from "next/server";
import { RATE_LIMITED_MESSAGE_AR, clientKey, createRateLimiter } from "@/lib/server/publicRateLimit";
import { createAdminClient } from "@/lib/supabase/server";
import { resolveProviderLimits } from "@/lib/server/providerLimits";
import { dailyCapPointsFor } from "@/lib/calculatorPricing";

export const dynamic = "force-dynamic";

const limiter = createRateLimiter({ windowMs: 60_000, max: 60 });

/** Public: the live daily limit as customer POINTS only (never the provider USD value), for the calculator's cap logic. */
export async function GET(req: NextRequest) {
  const decision = limiter.check(clientKey(req.headers));
  if (!decision.allowed) {
    return NextResponse.json({ dailyCapPoints: null, error: RATE_LIMITED_MESSAGE_AR }, { status: 429, headers: { "Retry-After": String(decision.retryAfterSeconds) } });
  }
  try {
    const { limits } = await resolveProviderLimits(createAdminClient());
    return NextResponse.json({ dailyCapPoints: dailyCapPointsFor(limits.dailyUsd) }, { headers: { "Cache-Control": "public, max-age=30" } });
  } catch {
    return NextResponse.json({ dailyCapPoints: null });
  }
}
