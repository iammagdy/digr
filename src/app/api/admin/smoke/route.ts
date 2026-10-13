import { NextRequest, NextResponse } from "next/server";
import { Client as UserClient, Account } from "node-appwrite";
import { runSmokeTests } from "../../../../functions/shared/smokeTest";
import { createServerSideClient } from "../../../../lib/supabase/server";

export const dynamic = "force-dynamic";

function extractFallbackSession(headerVal: string | null, projectId: string): string | null {
  if (!headerVal) return null;
  try {
    const parsed = JSON.parse(headerVal);
    if (parsed && typeof parsed === "object") {
      const val = parsed[`a_session_${projectId}`] || parsed[`a_session_${projectId}_legacy`];
      if (typeof val === "string" && val.trim()) {
        return val.trim();
      }
    }
  } catch {}
  return null;
}

interface AuthenticatedAdmin {
  userId: string;
}

async function authenticateAdmin(req: NextRequest): Promise<{ ok: boolean; admin?: AuthenticatedAdmin; errorResponse?: NextResponse }> {
  const authHeader = req.headers.get("authorization");
  const bearerJwt = authHeader?.startsWith("Bearer ") ? authHeader.substring(7).trim() : null;

  // 1. Try Supabase Admin Auth first
  try {
    const supabase = await createServerSideClient();
    const { data: sbData } = bearerJwt
      ? await supabase.auth.getUser(bearerJwt)
      : await supabase.auth.getUser();
    const sbUser = sbData?.user;
    if (sbUser) {
      if (sbUser.app_metadata?.role !== "admin") {
        return {
          ok: false,
          errorResponse: NextResponse.json(
            { auth_ok: false, error: "ممنوع — هذا الفحص مخصص لمديري النظام فقط." },
            { status: 403 }
          ),
        };
      }
      return { ok: true, admin: { userId: sbUser.id } };
    }
  } catch {
    // Fall through if Supabase not configured in test env
  }

  const endpoint = process.env.APPWRITE_ENDPOINT || process.env.NEXT_PUBLIC_APPWRITE_ENDPOINT || "https://fra.cloud.appwrite.io/v1";
  const projectId = process.env.APPWRITE_PROJECT_ID || process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID || "6ac947090008606ef482";

    const cookieJwt = (req.cookies.get("diger_jwt") ?? req.cookies.get("digr_jwt"))?.value?.trim() || null;
  const effectiveJwt = bearerJwt || cookieJwt;

  const sessionCookie =
    req.cookies.get(`a_session_${projectId}`)?.value ||
    req.cookies.get(`a_session_${projectId}_legacy`)?.value ||
    extractFallbackSession(req.headers.get("x-fallback-cookies"), projectId);

  if (!effectiveJwt && !sessionCookie) {
    return {
      ok: false,
      errorResponse: NextResponse.json(
        { auth_ok: false, error: "غير مصرح. يرجى تسجيل الدخول أولاً بحساب مدير النظام." },
        { status: 401 }
      ),
    };
  }

  const userClient = new UserClient().setEndpoint(endpoint).setProject(projectId);
  if (effectiveJwt) {
    userClient.setJWT(effectiveJwt);
  } else if (sessionCookie) {
    userClient.setSession(sessionCookie);
  }

  let userDoc: any;
  try {
    const userAccount = new Account(userClient);
    userDoc = await userAccount.get();
  } catch {
    return {
      ok: false,
      errorResponse: NextResponse.json(
        { auth_ok: false, error: "انتهت صلاحية الجلسة أو أنها غير صالحة." },
        { status: 401 }
      ),
    };
  }

  const isAdmin = Array.isArray(userDoc?.labels) && userDoc.labels.includes("admin");
  if (!isAdmin) {
    return {
      ok: false,
      errorResponse: NextResponse.json(
        { auth_ok: false, error: "ممنوع — هذا الفحص مخصص لمديري النظام فقط." },
        { status: 403 }
      ),
    };
  }

  return { ok: true, admin: { userId: userDoc.$id } };
}

export async function GET(req: NextRequest) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) {
    return auth.errorResponse!;
  }

  const summary = await runSmokeTests(auth.admin!.userId);
  return NextResponse.json(summary);
}

export async function POST(req: NextRequest) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) {
    return auth.errorResponse!;
  }

  const summary = await runSmokeTests(auth.admin!.userId);
  return NextResponse.json(summary);
}
