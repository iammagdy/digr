import { NextRequest, NextResponse } from "next/server";
import { authenticateAdmin } from "../../../../lib/server/adminAuth";
import { createAdminClient } from "../../../../lib/supabase/server";
import { ADMIN_LOOKUP_DAILY_CAP_USD, classifyLookupInput, readAdminLookupSpendToday, runAdminLookup } from "../../../../lib/server/adminLookup";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Admin only. The cost of the day so far and the cap (USD): for the screen's header. */
export async function GET(req: NextRequest) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  const spent = await readAdminLookupSpendToday(createAdminClient());
  return NextResponse.json({ capUsd: ADMIN_LOOKUP_DAILY_CAP_USD, spentTodayUsd: spent ?? 0 });
}

/**
 * Admin only. Body: { input: phone or email, depth?: 0 for the cheapest endpoint, 1 for the next («بحث أعمق»), … }.
 * No customer points are used; the cost goes to provider_costs (capability «admin_lookup») and every lookup is written to the sensitive-lookup audit log.
 */
export async function POST(req: NextRequest) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  let body: any = {};
  try { body = await req.json(); } catch { /* an empty body is a bad input below */ }
  if (!classifyLookupInput(body?.input)) return NextResponse.json({ ok: false, reason: "bad_input", message: "اكتب رقم هاتف أو بريدًا إلكترونيًا صحيحًا." }, { status: 400 });
  const depth = Number.isFinite(Number(body?.depth)) ? Math.max(0, Math.min(5, Math.floor(Number(body.depth)))) : 0;
  const result = await runAdminLookup({ client: createAdminClient(), adminId: auth.ctx.adminId, text: String(body.input), depth });
  const status = result.ok ? 200 : result.reason === "daily_cap" ? 429 : result.reason === "bad_input" ? 400 : 200;
  return NextResponse.json(result, { status });
}
