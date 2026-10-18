import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { authenticateUser } from "@/lib/server/userAuth";
import {
  PROMO_TOO_MANY_ATTEMPTS_AR,
  promoAttemptsExceeded,
  recordFailedPromoAttempt,
  redeemPromoCode,
} from "@/lib/server/promoCodes";
import { calculateBalance } from "@/lib/supabase/ledger";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const auth = await authenticateUser(req);
  if (!auth.ok) return auth.response;
  const body = await req.json().catch(() => ({}));
  if (promoAttemptsExceeded(auth.user.id)) {
    return NextResponse.json({ success: false, reason: "too_many_attempts", messageAr: PROMO_TOO_MANY_ATTEMPTS_AR }, { status: 429 });
  }
  const adminClient = createAdminClient();
  const outcome = await redeemPromoCode(adminClient, auth.user.id, body?.code);
  if (!outcome.ok) {
    if (outcome.reason !== "unavailable" && outcome.reason !== "failed") recordFailedPromoAttempt(auth.user.id);
    return NextResponse.json(
      { success: false, reason: outcome.reason, messageAr: outcome.messageAr },
      { status: outcome.reason === "unavailable" ? 503 : outcome.reason === "failed" ? 500 : 400 },
    );
  }
  let balance = outcome.balance ?? 0;
  try { balance = await calculateBalance(adminClient, auth.user.id); } catch { /* the function already returned the balance */ }
  return NextResponse.json({ success: true, points: outcome.points, balance, messageAr: outcome.messageAr });
}
