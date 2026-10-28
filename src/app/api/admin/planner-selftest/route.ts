import { NextRequest, NextResponse } from "next/server";
import { authenticateAdmin } from "../../../../lib/server/adminAuth";
import { createAdminClient } from "../../../../lib/supabase/server";
import { resolveProviderKey } from "../../../../lib/server/providerKeys";
import { createAnthropicTransport } from "../../../../lib/modelPlanner/transport";
import { readPlannerHealth } from "../../../../lib/modelPlanner/health";
import { ALL_SELF_TEST_CASES, MISSION_SELF_TEST_CASES, SELF_TEST_CASES, SELF_TEST_RUN_CAP_USD, estimateCaseCostUsd, runSelfTestCase, type SelfTestCase } from "../../../../lib/modelPlanner/selfTest";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** What the page shows of a request before it is run: the expectation, the price range its plan must stay inside, and what a run of it is expected to cost. */
const caseInfo = (c: SelfTestCase) => ({ id: c.id, group: c.group, request: c.request, expected: c.expect.join(" / "), note: c.note ?? "", priceRange: c.priceRangePoints ? `${c.priceRangePoints[0]}..${c.priceRangePoints[1]}` : "", estimateUsd: estimateCaseCostUsd(c) });

/** Admin only. The 30 requests with what each is expected to end in, the run's cost cap, and the planner's health line. */
export async function GET(req: NextRequest) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  const client = createAdminClient();
  const key = await resolveProviderKey("anthropic").catch(() => ({ key: "" }));
  const health = await readPlannerHealth(client);
  return NextResponse.json({
    capUsd: SELF_TEST_RUN_CAP_USD,
    keyConfigured: Boolean((key as { key?: string }).key),
    health,
    cases: SELF_TEST_CASES.map(caseInfo),
    // the missions the owner used to run by hand, as small planning-only requests (M1 to M4)
    missionCases: MISSION_SELF_TEST_CASES.map(caseInfo),
  });
}

/**
 * Admin only. Body: { caseId, runId, spentUsd }: runs ONE request of the self-test through the real planner (the real model, the real sample calls) and stops before any quote:
 * no quote, no job, no hold, no charge, nothing of a customer is written. Returns the table row and the run's total so far; when the run's cap is reached it says so and runs nothing.
 */
export async function POST(req: NextRequest) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  let body: any = {};
  try { body = await req.json(); } catch { /* bad input below */ }
  const test = ALL_SELF_TEST_CASES.find((c) => c.id === body?.caseId);
  const runId = String(body?.runId ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
  const spentUsd = Number(body?.spentUsd);
  if (!test || !runId || !Number.isFinite(spentUsd) || spentUsd < 0) return NextResponse.json({ error: "bad_input" }, { status: 400 });
  const result = await runSelfTestCase({ test, transport: createAnthropicTransport(), client: createAdminClient(), adminId: auth.ctx.adminId, runId, spentUsd, deadlineAtMs: Date.now() + 52_000 });
  return NextResponse.json(result);
}
