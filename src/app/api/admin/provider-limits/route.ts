import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { authenticateAdmin } from "@/lib/server/adminAuth";
import { loadProviderLimitsState, saveProviderLimits } from "@/lib/server/providerLimitsAdmin";
import { resolveAllProviderDailyCaps, readProviderSpendToday } from "@/lib/server/multiProvider/providerCaps";

export const dynamic = "force-dynamic";

/** The limits in force, today's recorded spend against them, store readiness and the last audit rows. Admin only. */
export async function GET(req: NextRequest) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  try {
    const client = createAdminClient();
    const state = await loadProviderLimitsState(client, { forceRefresh: true });
    // The daily limits of the two extra data providers, beside the state above (which is exactly what it was): their own cap and today's recorded spend.
    const [caps, firecrawlToday, contextdevToday] = await Promise.all([resolveAllProviderDailyCaps(client), readProviderSpendToday(client, "firecrawl"), readProviderSpendToday(client, "contextdev")]);
    const extra = {
      firecrawl: { dailyUsd: caps.firecrawl, todayUsd: firecrawlToday },
      contextdev: { dailyUsd: caps.contextdev, todayUsd: contextdevToday },
    };
    return NextResponse.json({ state, extra }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "تعذر تحميل الحدود الآن." }, { status: 500 });
  }
}

/** Saves a partial set of limits. Admin is verified here and again inside the SQL function; the new values apply at once. */
export async function POST(req: NextRequest) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  const body = await req.json().catch(() => ({}));
  const outcome = await saveProviderLimits({ client: createAdminClient() }, { adminId: auth.ctx.adminId, limits: body?.limits ?? {} });
  if (outcome.ok) {
    const fields = Object.keys(body?.limits ?? {}).join("، ");
    await auth.ctx.audit("setting", "تعديل حدود إنفاق المزودين", fields, { targetType: "provider_limits", targetId: "provider_limits" });
  }
  return NextResponse.json(
    { success: outcome.ok, reason: outcome.reason, message: outcome.messageAr, ...(outcome.ok ? {} : { error: outcome.messageAr }) },
    { status: outcome.status },
  );
}
