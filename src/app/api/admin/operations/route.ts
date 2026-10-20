import { NextRequest, NextResponse } from "next/server";
import { authenticateAdmin } from "@/lib/server/adminAuth";
import { createAdminClient } from "@/lib/supabase/server";
import { buildOperationsSnapshot, FAILED_WINDOW_MS } from "@/lib/server/adminOperations";
import { getProviderBalanceStatus, getConfiguredProviderCreditUsd } from "@/functions/shared/providerSpend";
import { resolveProviderLimits } from "@/lib/server/providerLimits";

export const dynamic = "force-dynamic";

/** Admin only, read only: the state of the job queue and the provider's daily allowance. No provider call, no write. */
export async function GET(req: NextRequest) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  const admin = createAdminClient();
  const now = Date.now();
  const since = new Date(now - FAILED_WINDOW_MS).toISOString();

  const { data, error } = await admin
    .from("jobs")
    .select("id, status, lease_until, updated_at, created_at, reserved_credits, delivered_units, error_message")
    .or(`status.in.(queued,running),and(status.eq.failed,updated_at.gte.${since})`)
    .order("updated_at", { ascending: false })
    .limit(500);
  if (error) return NextResponse.json({ error: "تعذّر قراءة الطلبات الآن." }, { status: 500 });

  const [balance, limits] = await Promise.all([getProviderBalanceStatus(admin as any), resolveProviderLimits(admin as any)]);
  const snapshot = buildOperationsSnapshot({
    jobs: (data || []) as any[],
    now,
    provider: {
      todaySpendUsd: balance.todaySpendUsd,
      todayCapUsd: balance.todayCapUsd,
      availableBalanceUsd: balance.availableBalanceUsd,
      creditUsd: getConfiguredProviderCreditUsd(),
      warnPercent: limits.limits.warnPercent,
    },
  });
  return NextResponse.json({ ...snapshot, checkedAt: new Date(now).toISOString() });
}
