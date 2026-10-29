import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "../../../../lib/supabase/server";
import { verifyCronSecret } from "../../../../lib/server/cronAuth";
import { getTregKeyPool } from "../../../../lib/server/tregKeyPool";
import { flushPoolAlerts } from "../../../../lib/server/tregPoolAlerts";
import { runPoolHealth } from "../../../../lib/server/tregPoolHealth";
import { readProviderKeySettings } from "../../../../lib/server/providerKeyAdmin";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** The minimum gap between two background health runs, whoever calls (the SQL claim keeps it: treg_pool_claim_health_run). */
const HEALTH_MIN_INTERVAL_SECONDS = 600;

/**
 * Called every minute by pg_cron (docs/proposals/treg-key-pool/04_treg_pool_cron.sql) ONLY when an e-mail is waiting or a health run is due. It
 *  1. sends the waiting admin e-mails (one per key per problem; the outbox leases them so two runs never send one twice),
 *  2. when the claim succeeds (at most one run per 10 minutes), checks every pool key with two read-only TREG calls and records the result (the active key found revoked or
 *     empty moves the pool on), and sends what that opened.
 * It reserves, charges and releases nothing and calls no billed endpoint.
 */
export async function GET(req: NextRequest) {
  if (!verifyCronSecret(req)) return NextResponse.json({ success: false, error: "غير مصرح." }, { status: 401 });
  const pool = getTregKeyPool();
  if (!pool) return NextResponse.json({ success: false, error: "unavailable" }, { status: 503 });
  const client = createAdminClient();

  const first = await flushPoolAlerts({ client });
  let health: Awaited<ReturnType<typeof runPoolHealth>> | null = null;
  let claimed = false;
  try {
    const claim = await client.rpc("treg_pool_claim_health_run", { p_min_interval_seconds: HEALTH_MIN_INTERVAL_SECONDS });
    claimed = !claim.error && claim.data === true;
  } catch { claimed = false; }
  if (claimed) {
    const settings = await readProviderKeySettings(client).catch(() => null);
    health = await runPoolHealth({ client, pool, mainOrgId: settings?.tregOrgId ?? null, source: "health" });
  }
  const second = claimed ? await flushPoolAlerts({ client }) : null;
  return NextResponse.json({ success: true, claimed, health, alerts: { first, second } }, { headers: { "Cache-Control": "no-store" } });
}
