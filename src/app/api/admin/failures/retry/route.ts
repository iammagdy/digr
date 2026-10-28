import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { authenticateAdmin } from "@/lib/server/adminAuth";
import { resolveProviderKey } from "@/lib/server/providerKeys";
import { createAnthropicTransport } from "@/lib/modelPlanner/transport";
import { retryRequest } from "@/lib/modelPlanner/retryRequest";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Admin only. Body: { requestText, runId }. Re-runs that ONE request through the planner and stops before any approval; the run costs at most 0.05 USD (the model and the sample calls together).
 * Nothing of a customer is written: no quote, no job, no hold, no charge.
 */
export async function POST(req: NextRequest) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  let body: any = {};
  try { body = await req.json(); } catch { /* bad input below */ }
  const requestText = String(body?.requestText ?? "").trim();
  const runId = String(body?.runId ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
  if (!requestText || requestText.length > 600 || !runId) return NextResponse.json({ error: "bad_input" }, { status: 400 });
  const key = await resolveProviderKey("anthropic").catch(() => ({ key: "" }));
  if (!(key as { key?: string }).key) return NextResponse.json({ error: "مفتاح النموذج غير مضبوط." }, { status: 503 });
  const result = await retryRequest({ requestText, transport: createAnthropicTransport(), client: createAdminClient(), adminId: auth.ctx.adminId, runId, deadlineAtMs: Date.now() + 52_000 });
  return NextResponse.json({ success: true, result }, { headers: { "Cache-Control": "no-store" } });
}
