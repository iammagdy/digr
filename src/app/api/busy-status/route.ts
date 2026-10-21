import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { getBusyState } from "@/lib/server/busyState";
import { PUBLIC_LIMITS_PER_MINUTE, clientKey, createRateLimiter, RATE_LIMITED_MESSAGE_AR } from "@/lib/server/publicRateLimit";

export const dynamic = "force-dynamic";

const limiter = createRateLimiter({ windowMs: 60_000, max: PUBLIC_LIMITS_PER_MINUTE.status });

/** Public and read only: whether new requests are paused, in one plain sentence. No number about the provider, no secret, no customer data. */
export async function GET(req: NextRequest) {
  const decision = limiter.check(clientKey(req.headers));
  if (!decision.allowed) return NextResponse.json({ error: RATE_LIMITED_MESSAGE_AR }, { status: 429, headers: { "Retry-After": String(decision.retryAfterSeconds) } });
  const state = await getBusyState(createAdminClient());
  return NextResponse.json({ busy: state.busy, messageAr: state.messageAr, queueAhead: state.queueAhead, position: state.position }, { headers: { "Cache-Control": "no-store" } });
}
