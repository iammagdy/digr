import { NextRequest, NextResponse } from "next/server";
import { createAdminClient, createServerSideClient } from "../supabase/server";

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
    const result = authHeader?.startsWith("Bearer ") ? await supabase.auth.getUser(authHeader.substring(7).trim()) : await supabase.auth.getUser();
    const user = result.data?.user;
    if (user && !user.user_metadata?.is_guest) {
      return { ok: true, viewer: { userId: user.id, isGuest: false, emailVerified: Boolean(user.email_confirmed_at || user.user_metadata?.email_verified) } };
    }
  } catch { /* try the guest cookie */ }
  const match = GUEST_COOKIE_RE.exec(req.cookies.get("guest_session_id")?.value ?? "");
  if (match) {
    try {
      const { data } = await createAdminClient().auth.admin.getUserById(match[1]);
      if (data?.user?.id && data.user.user_metadata?.is_guest) return { ok: true, viewer: { userId: data.user.id, isGuest: true, emailVerified: false } };
    } catch { /* not a guest */ }
  }
  return denied(401, "غير مصرح. يرجى تسجيل الدخول أولاً.");
}

export const safeMissionId = (id: string): string | null => (/^msn_[a-z0-9]{8,40}$/.test(id) ? id : null);
