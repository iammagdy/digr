import { NextRequest, NextResponse } from "next/server";
import { getLlmStatusSnapshot } from "../../../../functions/shared/llmClient";
import { authenticateAdmin } from "../../../../lib/server/adminAuth";
import { createAdminClient } from "../../../../lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;

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
