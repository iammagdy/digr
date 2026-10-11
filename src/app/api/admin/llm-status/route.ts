import { NextRequest, NextResponse } from "next/server";
import { Client as ServerClient, TablesDB, Client as UserClient, Account, Query } from "node-appwrite";
import { getLlmStatusSnapshot } from "../../../../functions/shared/llmClient";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const endpoint = process.env.APPWRITE_ENDPOINT || "https://fra.cloud.appwrite.io/v1";
    const projectId = process.env.APPWRITE_PROJECT_ID || "6ac947090008606ef482";
    const apiKey = process.env.APPWRITE_API_KEY || "";

    const authHeader = req.headers.get("authorization");
    const bearerJwt = authHeader?.startsWith("Bearer ") ? authHeader.substring(7).trim() : null;
    const sessionCookie =
      req.cookies.get(`a_session_${projectId}`)?.value ||
      req.cookies.get(`a_session_${projectId}_legacy`)?.value;

    if (!bearerJwt && !sessionCookie) {
      return NextResponse.json(
        { error: "غير مصرح. يرجى تسجيل الدخول أولاً." },
        { status: 401 },
      );
    }

    const userClient = new UserClient().setEndpoint(endpoint).setProject(projectId);
    if (bearerJwt) {
      userClient.setJWT(bearerJwt);
    } else if (sessionCookie) {
      userClient.setSession(sessionCookie);
    }

    let userDoc: any;
    try {
      const userAccount = new Account(userClient);
      userDoc = await userAccount.get();
    } catch {
      return NextResponse.json(
        { error: "انتهت صلاحية الجلسة أو أنها غير صالحة." },
        { status: 401 },
      );
    }

    const isAdmin = Array.isArray(userDoc?.labels) && userDoc.labels.includes("admin");
    if (!isAdmin) {
      return NextResponse.json(
        { error: "ممنوع — هذه الواجهة مخصصة لمديري النظام فقط." },
        { status: 403 },
      );
    }

    let lastUsageTimestamp: string | null = null;
    if (apiKey) {
      try {
        const serverClient = new ServerClient()
          .setEndpoint(endpoint)
          .setProject(projectId)
          .setKey(apiKey);
        const tables = new TablesDB(serverClient);
        const usageRes = await tables.listRows({
          databaseId: "digr",
          tableId: "llm_usage",
          queries: [Query.orderDesc("createdAt"), Query.limit(1)],
        });
        if (usageRes.rows.length > 0) {
          const latest: any = usageRes.rows[0];
          lastUsageTimestamp = latest.createdAt || latest.$createdAt || null;
        }
      } catch {
        lastUsageTimestamp = null;
      }
    }

    const snapshot = getLlmStatusSnapshot(lastUsageTimestamp);
    return NextResponse.json({
      provider: snapshot.provider,
      llm_enabled: snapshot.llm_enabled,
      key_present: snapshot.key_present,
      model: snapshot.model,
      last_llm_usage_timestamp: snapshot.last_llm_usage_timestamp,
      last_fallback_reason: snapshot.last_fallback_reason,
    });
  } catch {
    return NextResponse.json(
      { error: "تعذر جلب حالة المساعد الذكي." },
      { status: 500 },
    );
  }
}
