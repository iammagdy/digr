import { NextRequest, NextResponse } from "next/server";
import { getProviderBalanceStatus } from "../../../../functions/shared/providerSpend";
import { authenticateAdmin } from "../../../../lib/server/adminAuth";
import { createAdminClient } from "../../../../lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;

  const forceRefresh = req.nextUrl.searchParams.get("refresh") === "true";
  let sbAdmin: any = null;
  try {
    sbAdmin = createAdminClient();
  } catch {
    sbAdmin = null;
  }
  const status = await getProviderBalanceStatus(sbAdmin, forceRefresh);
  return NextResponse.json({
    available_balance_usd: status.availableBalanceUsd,
    today_spend_usd: status.todaySpendUsd,
    today_cap_usd: status.todayCapUsd,
    is_healthy: status.isHealthy,
    cached_at: status.cachedAt,
  });
}
