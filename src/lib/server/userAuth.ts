import { NextRequest, NextResponse } from "next/server";
import { createServerSideClient } from "../supabase/server";

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
    return {
      ok: true,
      user: { id: user.id, email: user.email || "", appRole: (user.app_metadata?.role as string) || null, createdAt: user.created_at || null },
    };
  } catch {
    return { ok: false, response: NextResponse.json({ success: false, error: "انتهت صلاحية الجلسة." }, { status: 401 }) };
  }
}
