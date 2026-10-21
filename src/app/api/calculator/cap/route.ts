import { NextRequest, NextResponse } from "next/server";
import { PUBLIC_LIMITS_PER_MINUTE, RATE_LIMITED_MESSAGE_AR, clientKey, createRateLimiter } from "@/lib/server/publicRateLimit";
import { liveDailyCapPoints } from "@/lib/server/liveDailyCap";

export const dynamic = "force-dynamic";

const limiter = createRateLimiter({ windowMs: 60_000, max: PUBLIC_LIMITS_PER_MINUTE.cap });

/** Public: the live daily limit as customer POINTS only (never the provider USD value), for the calculator's cap logic. */
export async function GET(req: NextRequest) {
  const decision = limiter.check(clientKey(req.headers));
  if (!decision.allowed) {
    return NextResponse.json({ dailyCapPoints: null, error: RATE_LIMITED_MESSAGE_AR }, { status: 429, headers: { "Retry-After": String(decision.retryAfterSeconds) } });
  }
  const dailyCapPoints = await liveDailyCapPoints();
  if (dailyCapPoints === undefined) return NextResponse.json({ dailyCapPoints: null });
  return NextResponse.json({ dailyCapPoints }, { headers: { "Cache-Control": "public, max-age=30" } });
}
