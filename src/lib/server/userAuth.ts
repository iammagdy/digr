import { NextRequest, NextResponse } from "next/server";
import { createAdminClient, createServerSideClient } from "../supabase/server";
import { isAccountSuspended, suspendedResponse } from "./accountSuspension";

export type AuthenticatedUser = { id: string; email: string; appRole: string | null; createdAt: string | null };

/** Resolves the signed-in customer from a bearer token or the session cookie; never trusts a user id from the body. */
export async function authenticateUser(
  req: NextRequest,
): Promise<{ ok: true; user: AuthenticatedUser } | { ok: false; response: NextResponse }> {
  try {
    const supabase = await createServerSideClient();
    const authHeader = req.headers.get("authorization");
    const result = authHeader?.startsWith("Bearer ")
      ? await supabase.auth.getUser(authHeader.substring(7).trim())
      : await supabase.auth.getUser();
    const user = result.data?.user;
    if (!user) {
      return { ok: false, response: NextResponse.json({ success: false, error: "غير مصرح. يرجى تسجيل الدخول أولاً." }, { status: 401 }) };
    }
    // A SUSPENDED ACCOUNT (DT-20261118-06 phase 1C, Tier A): asked of the sign-in service, not read from the token (a token issued before the ban is still readable until it expires)
    if (await isAccountSuspended(() => createAdminClient(), user.id, user as { banned_until?: string | null })) return { ok: false, response: suspendedResponse() };
    return {
      ok: true,
      user: { id: user.id, email: user.email || "", appRole: (user.app_metadata?.role as string) || null, createdAt: user.created_at || null },
    };
  } catch {
    return { ok: false, response: NextResponse.json({ success: false, error: "انتهت صلاحية الجلسة." }, { status: 401 }) };
  }
}
