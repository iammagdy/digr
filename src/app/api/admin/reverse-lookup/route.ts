import { NextRequest, NextResponse } from "next/server";
import { authenticateAdmin } from "../../../../lib/server/adminAuth";
import { createAdminClient } from "../../../../lib/supabase/server";
import { ADMIN_LOOKUP_DAILY_CAP_USD, classifyLookupInput, lookupPlan, readAdminLookupSpendToday, runAdminLookup, runLookupAttempt } from "../../../../lib/server/adminLookup";
import { loadLookupHistory, sanitizeEntry, saveLookupHistory } from "../../../../lib/server/adminLookupHistory";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Admin only. The cost of the day so far and the cap (USD), and the history of past lookups (`historyAvailable: false` when the server table is not applied: the screen keeps it in the browser). */
export async function GET(req: NextRequest) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  const client = createAdminClient();
  const spent = await readAdminLookupSpendToday(client);
  const history = await loadLookupHistory(client);
  return NextResponse.json({ capUsd: ADMIN_LOOKUP_DAILY_CAP_USD, spentTodayUsd: spent ?? 0, historyAvailable: history.available, history: history.rows });
}

const bad = () => NextResponse.json({ ok: false, reason: "bad_input", message: "اكتب رقم هاتف أو بريدًا إلكترونيًا صحيحًا." }, { status: 400 });

/**
 * Admin only. No customer points are used; every lookup is written to the sensitive-lookup audit log. Body:
 *   { action: "plan", input }                                     → the ordered endpoints with their state and price (nothing is called);
 *   { action: "attempt", input, endpointId, confirmedUsd?, previous? } → ONE attempt (a paid phone endpoint only with confirmedUsd ≥ its price), the screen drives the order and shows each result live;
 *   { action: "save", input, result }                             → stores the finished lookup in the history;
 *   { input, depth?, previous? }                                  → the whole automatic lookup in one call (first useful answer; depth continues and merges).
 */
export async function POST(req: NextRequest) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  let body: any = {};
  try { body = await req.json(); } catch { /* an empty body is a bad input below */ }
  const parsed = classifyLookupInput(body?.input);
  if (!parsed) return bad();
  const client = createAdminClient();
  const action = String(body?.action ?? "");

  if (action === "plan") {
    const plan = lookupPlan(parsed.kind, parsed.value);
    const spent = await readAdminLookupSpendToday(client);
    return NextResponse.json({ ok: true, kind: parsed.kind, plan, spentTodayUsd: spent ?? 0, capUsd: ADMIN_LOOKUP_DAILY_CAP_USD });
  }
  if (action === "attempt") {
    const r = await runLookupAttempt({ client, adminId: auth.ctx.adminId, text: String(body.input), endpointId: String(body?.endpointId ?? ""), confirmedUsd: Number.isFinite(Number(body?.confirmedUsd)) ? Number(body.confirmedUsd) : undefined, previous: body?.previous && typeof body.previous === "object" ? body.previous : undefined });
    return NextResponse.json(r, { status: !r.ok && r.reason === "daily_cap" ? 429 : 200 });
  }
  if (action === "save") {
    const entry = sanitizeEntry(body?.result, body.input);
    if (!entry) return bad();
    return NextResponse.json({ ok: true, ...(await saveLookupHistory(client, auth.ctx.adminId, entry)), entry });
  }
  const depth = Number.isFinite(Number(body?.depth)) ? Math.max(0, Math.min(12, Math.floor(Number(body.depth)))) : 0;
  const result = await runAdminLookup({ client, adminId: auth.ctx.adminId, text: String(body.input), depth, previous: body?.previous && typeof body.previous === "object" ? body.previous : undefined });
  const status = result.ok ? 200 : result.reason === "daily_cap" ? 429 : result.reason === "bad_input" ? 400 : 200;
  return NextResponse.json(result, { status });
}
