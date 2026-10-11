import { NextRequest, NextResponse } from "next/server";
import { Client as ServerClient, TablesDB, Client as UserClient, Account, Query } from "node-appwrite";
import { getLlmStatusSnapshot } from "../../../../functions/shared/llmClient";

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

function buildBrowserBootstrapHtml(endpoint: string, projectId: string): string {
  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8" />
  <title>حالة المساعد الذكي — Digr</title>
  <style>
    body { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: #faf8f5; color: #1c1917; padding: 24px; direction: ltr; }
    pre { background: #ffffff; border: 1px solid #e7e2da; border-radius: 12px; padding: 16px; overflow-x: auto; font-size: 14px; line-height: 1.6; }
  </style>
</head>
<body>
  <pre id="out">Checking session...</pre>
  <script>
    (async function () {
      const out = document.getElementById("out");
      const endpoint = ${JSON.stringify(endpoint)};
      const projectId = ${JSON.stringify(projectId)};
      const fallback = window.localStorage ? (window.localStorage.getItem("cookieFallback") || "") : "";
      let jwt = "";
      try {
        const jwtHeaders = { "X-Appwrite-Project": projectId, "Content-Type": "application/json" };
        if (fallback) jwtHeaders["X-Fallback-Cookies"] = fallback;
        const jwtRes = await fetch(endpoint + "/account/jwts", {
          method: "POST",
          headers: jwtHeaders,
          credentials: "include"
        });
        if (jwtRes.ok) {
          const data = await jwtRes.json();
          if (data && data.jwt) {
            jwt = data.jwt;
            document.cookie = "digr_jwt=" + encodeURIComponent(jwt) + "; Path=/; Max-Age=840; SameSite=Lax";
          }
        }
      } catch (e) {}
      const reqHeaders = { "Accept": "application/json" };
      if (jwt) reqHeaders["Authorization"] = "Bearer " + jwt;
      if (fallback) reqHeaders["X-Fallback-Cookies"] = fallback;
      const res = await fetch("/api/admin/llm-status?format=json", {
        headers: reqHeaders,
        credentials: "same-origin"
      });
      const json = await res.json().catch(() => ({ error: "Failed to parse response" }));
      out.textContent = JSON.stringify(json, null, 2);
    })();
  </script>
</body>
</html>`;
}

export async function GET(req: NextRequest) {
  try {
    const endpoint = process.env.APPWRITE_ENDPOINT || "https://fra.cloud.appwrite.io/v1";
    const projectId = process.env.APPWRITE_PROJECT_ID || "6ac947090008606ef482";
    const apiKey = process.env.APPWRITE_API_KEY || "";

    const authHeader = req.headers.get("authorization");
    const bearerJwt = authHeader?.startsWith("Bearer ") ? authHeader.substring(7).trim() : null;
    const cookieJwt = req.cookies.get("digr_jwt")?.value?.trim() || null;
    const effectiveJwt = bearerJwt || cookieJwt;

    const sessionCookie =
      req.cookies.get(`a_session_${projectId}`)?.value ||
      req.cookies.get(`a_session_${projectId}_legacy`)?.value ||
      extractFallbackSession(req.headers.get("x-fallback-cookies"), projectId);

    const acceptsHtml =
      (req.headers.get("accept") || "").includes("text/html") &&
      req.nextUrl.searchParams.get("format") !== "json";

    if (!effectiveJwt && !sessionCookie) {
      if (acceptsHtml) {
        return new NextResponse(buildBrowserBootstrapHtml(endpoint, projectId), {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      return NextResponse.json(
        { error: "غير مصرح. يرجى تسجيل الدخول أولاً." },
        { status: 401 },
      );
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
      if (acceptsHtml) {
        return new NextResponse(buildBrowserBootstrapHtml(endpoint, projectId), {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
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
      last_fallback_detail: snapshot.last_fallback_detail,
    });
  } catch {
    return NextResponse.json(
      { error: "تعذر جلب حالة المساعد الذكي." },
      { status: 500 },
    );
  }
}
