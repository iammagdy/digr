import { NextRequest, NextResponse } from "next/server";
import { getProviderBalanceStatus } from "../../../../functions/shared/providerSpend";
import { authenticateAdmin } from "../../../../lib/server/adminAuth";
import { createAdminClient } from "../../../../lib/supabase/server";
import { resolveProviderKey } from "../../../../lib/server/providerKeys";
import { getProviderAccountEmail, getProviderStatus } from "../../../../lib/server/providerStatus";
import { readProviderKeySettings } from "../../../../lib/server/providerKeyAdmin";

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
  // The figure below is the platform's own estimate (configured credit minus recorded spend). The real balance is
  // read from the provider with an authenticated call and returned separately.
  const settings = sbAdmin ? await readProviderKeySettings(sbAdmin) : null;
  const key = await resolveProviderKey("treg");
  const real = await getProviderStatus("treg", key.key, { forceRefresh, orgIdOverride: settings?.tregOrgId ?? null });
  return NextResponse.json({
    real_balance: {
      available: real.balance.available,
      balance_usd: real.balance.balanceUsd ?? null,
      balance_micro: real.balance.balanceMicro ?? null,
      unavailable_reason: real.balance.unavailableReason ?? null,
      checked_at: real.balance.checkedAt,
    },
    health: real.health,
    // The connected account's e-mail as the provider's own answer gave it (this route is admin-only); null when it had none.
    account_email: getProviderAccountEmail("treg"),
    available_balance_is_estimate: true,
    available_balance_usd: status.availableBalanceUsd,
    today_spend_usd: status.todaySpendUsd,
    today_cap_usd: status.todayCapUsd,
    is_healthy: status.isHealthy,
    cached_at: status.cachedAt,
  });
}
