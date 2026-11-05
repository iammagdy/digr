import { NextRequest, NextResponse } from "next/server";
import { createAdminClient, createServerSideClient } from "../supabase/server";
import { resolveTrustedEmailVerified } from "./trustedEmailVerification";
import { ownGuestAccountId } from "./guestIdentity";

/**
 * Who is looking at a mission: the signed-in customer (bearer token or session cookie), or the guest of the chat (the `guest_session_id` cookie the chat route set, checked against a real
 * guest account). The user id is never taken from the body or the URL. Every mission action then checks that the mission belongs to this user.
 */
export interface MissionViewer { userId: string; isGuest: boolean; emailVerified: boolean }

const GUEST_COOKIE_RE = /^gst_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export async function resolveMissionViewer(req: NextRequest): Promise<{ ok: true; viewer: MissionViewer } | { ok: false; response: NextResponse }> {
  const denied = (status: number, error: string) => ({ ok: false as const, response: NextResponse.json({ success: false, error }, { status }) });
  try {
    const supabase = await createServerSideClient();
    const authHeader = req.headers.get("authorization");
    const token = authHeader?.startsWith("Bearer ") ? authHeader.substring(7).trim() : undefined;
    const result = token ? await supabase.auth.getUser(token) : await supabase.auth.getUser();
    const user = result.data?.user;
    if (user && !user.user_metadata?.is_guest) {
      // Only the sign-in service's own confirmation counts: `user_metadata` is writable by the customer and is never read here.
      return { ok: true, viewer: { userId: user.id, isGuest: false, emailVerified: await resolveTrustedEmailVerified(supabase, user, token) } };
    }
  } catch { /* try the guest cookie */ }
  const match = GUEST_COOKIE_RE.exec(req.cookies.get("guest_session_id")?.value ?? "");
  if (match) {
    try {
      // The cookie is the browser's word: it counts only for a disposable guest account Diger made (a real customer who wrote `is_guest` on their own account is not one).
      const guestId = await ownGuestAccountId(createAdminClient(), `gst_${match[1]}`);
      if (guestId) return { ok: true, viewer: { userId: guestId, isGuest: true, emailVerified: false } };
    } catch { /* not a guest */ }
  }
  return denied(401, "غير مصرح. يرجى تسجيل الدخول أولاً.");
}

export const safeMissionId = (id: string): string | null => (/^msn_[a-z0-9]{8,40}$/.test(id) ? id : null);
