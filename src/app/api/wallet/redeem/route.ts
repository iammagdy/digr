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
import { DEVICE_COOKIE, GRANT_THROTTLED_AR, grantAllowed, recordGrant } from "@/lib/server/grantThrottle";
import { clientKey } from "@/lib/server/publicRateLimit";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const auth = await authenticateUser(req);
  if (!auth.ok) return auth.response;
  const body = await req.json().catch(() => ({}));
  if (promoAttemptsExceeded(auth.user.id)) {
    return NextResponse.json({ success: false, reason: "too_many_attempts", messageAr: PROMO_TOO_MANY_ATTEMPTS_AR }, { status: 429 });
  }
  // Per address and per device, before anything is redeemed (the points, the code's maximum and one-per-account stay in the database).
  const ip = clientKey(req.headers);
  const existingDevice = req.cookies.get(DEVICE_COOKIE)?.value || null;
  const deviceId = existingDevice && /^[A-Za-z0-9_-]{16,64}$/.test(existingDevice) ? existingDevice : null;
  const throttle = grantAllowed({ ip, deviceId });
  if (!throttle.allowed) {
    return NextResponse.json({ success: false, reason: "too_many_signups_here", messageAr: GRANT_THROTTLED_AR }, { status: 429 });
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
  const issuedDevice = deviceId ?? crypto.randomUUID().replace(/-/g, "");
  recordGrant({ ip, deviceId: issuedDevice });
  const response = NextResponse.json({ success: true, points: outcome.points, balance, messageAr: outcome.messageAr });
  if (!deviceId) response.cookies.set(DEVICE_COOKIE, issuedDevice, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 365 * 24 * 60 * 60, path: "/" });
  return response;
}
