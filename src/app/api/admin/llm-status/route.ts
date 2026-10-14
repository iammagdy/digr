import { NextRequest, NextResponse } from "next/server";
import { getLlmStatusSnapshot } from "../../../../functions/shared/llmClient";
import { authenticateAdmin } from "../../../../lib/server/adminAuth";
import { createAdminClient } from "../../../../lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const bearer = authHeader?.startsWith("Bearer ") ? authHeader.substring(7).trim() : null;
  const cookieToken =
    req.cookies.get("diger_jwt")?.value ||
    req.cookies.get("digr_jwt")?.value ||
    req.cookies.get("sb-access-token")?.value;

  const acceptsHtml =
    (req.headers.get("accept") || "").includes("text/html") &&
    req.nextUrl.searchParams.get("format") !== "json";

  if (!bearer && !cookieToken) {
    if (acceptsHtml) {
      return new NextResponse(
        `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8" />
  <title>حالة المساعد الذكي — Diger</title>
</head>
<body>
  <script>
    fetch("/api/admin/llm-status?format=json").then(r => r.json()).then(console.log);
  </script>
</body>
</html>`,
        {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        }
      );
    }
  }

  const auth = await authenticateAdmin(req);
  if (!auth.ok) {
    return auth.response;
  }

  let lastUsageTimestamp: string | null = null;
  try {
    const adminClient = createAdminClient();
    const { data: usageRows } = await adminClient
      .from("llm_usage")
      .select("created_at")
      .order("created_at", { ascending: false })
      .limit(1);
    if (usageRows && usageRows.length > 0) {
      lastUsageTimestamp = usageRows[0].created_at || null;
    }
  } catch {
    lastUsageTimestamp = null;
  }

  const snapshot = getLlmStatusSnapshot(lastUsageTimestamp);
  return NextResponse.json({
    provider: snapshot.provider,
    llm_enabled: snapshot.llm_enabled,
    key_present: snapshot.key_present,
    model: snapshot.model,
    reasoning_effort: snapshot.reasoning_effort,
    reasoning_effort_status: snapshot.reasoning_effort_status,
    last_llm_usage_timestamp: snapshot.last_llm_usage_timestamp,
    last_fallback_reason: snapshot.last_fallback_reason,
    last_fallback_detail: snapshot.last_fallback_detail,
  });
}
