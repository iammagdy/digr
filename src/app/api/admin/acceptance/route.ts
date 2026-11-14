import { NextRequest, NextResponse } from "next/server";
import { authenticateAdmin } from "../../../../lib/server/adminAuth";
import { createAdminClient } from "../../../../lib/supabase/server";
import { ACCEPTANCE_FLAG_KEYS, CAMPAIGN_CEILING_USD, CAMPAIGN_MAX_MINUTES, CAMPAIGN_MIN_MINUTES, L4_FLAG_KEYS, PRODUCTION_BUDGET_GUARANTEE, campaignStatus, restoreCampaign, startCampaign } from "../../../../lib/agentMission/acceptance/campaign";
import { SCENARIOS } from "../../../../lib/agentMission/acceptance/scenarios";
import { createScenarioMission } from "../../../../lib/agentMission/acceptance/run";
import { loadAcceptanceSpend } from "../../../../lib/agentMission/adminActions";
import { resolveAcceptanceAccount } from "./account";

export const dynamic = "force-dynamic";

const ACTIONS = new Set(["start", "restore", "create_scenario"]);
/** The only body fields any action reads. Anything else (an e-mail, a phone, a user id, an amount) is refused: the route takes no identifier and no money from the caller. */
const ALLOWED_FIELDS = new Set(["action", "keys", "minutes", "scenario"]);

/**
 * Admin only (docs/intelligence/ACCEPTANCE-WORKFLOW.md). GET: the campaign's state (the designated test account, each Intelligence switch, isolation, the budget guarantee and why), the scenarios, and what the
 * test account's missions cost since the campaign started (or in the last 24 hours). Read-only.
 */
export async function GET(req: NextRequest) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  const client = createAdminClient();
  const status = await campaignStatus(client, await resolveAcceptanceAccount(client));
  if (!status.ok) return NextResponse.json({ error: status.error }, { status: status.status });
  const since = status.campaign?.started_at ?? new Date(Date.now() - 24 * 3_600_000).toISOString();
  const spend = status.account ? await loadAcceptanceSpend(client, status.account.id, since) : { ok: false as const };
  return NextResponse.json({
    account: status.account, campaign: status.campaign, flags: status.flags, isolated: status.isolated,
    budget: PRODUCTION_BUDGET_GUARANTEE, ceilingUsd: CAMPAIGN_CEILING_USD, minutes: { min: CAMPAIGN_MIN_MINUTES, max: CAMPAIGN_MAX_MINUTES }, keys: ACCEPTANCE_FLAG_KEYS, l4Keys: L4_FLAG_KEYS,
    scenarios: SCENARIOS, spend: spend.ok ? { since, totalUsd: spend.totalUsd, missions: spend.missions } : null,
  });
}

/**
 * Admin only. {action: "start", keys, minutes} turns the chosen switches on for the test account only (refused while the hard ceiling is not enforceable); {action: "restore"} removes exactly what the campaign
 * wrote and verifies it; {action: "create_scenario", scenario: "L3" | "L4"} creates the scenario's mission through the existing admin console action (refused while the ceiling is not enforceable).
 * Every attempt, allowed or refused, leaves an audit row.
 */
export async function POST(req: NextRequest) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  let body: Record<string, unknown> = {};
  try { const b = await req.json(); body = b && typeof b === "object" && !Array.isArray(b) ? b : {}; } catch { /* bad input below */ }
  if (!ACTIONS.has(String(body.action)) || Object.keys(body).some((k) => !ALLOWED_FIELDS.has(k))) return NextResponse.json({ error: "bad_input" }, { status: 400 });
  const client = createAdminClient();
  const account = await resolveAcceptanceAccount(client);
  const audit = (label: string, target: string) => auth.ctx.audit("acceptance", label, target.slice(0, 300), { targetType: "agent_settings", targetId: "acceptance_campaign" }).catch(() => undefined);

  if (body.action === "start") {
    const r = await startCampaign(client, { adminId: auth.ctx.adminId, account, keys: body.keys, minutes: body.minutes, budget: PRODUCTION_BUDGET_GUARANTEE });
    await audit(r.ok ? "بدء حملة قبول" : "رفض بدء حملة قبول", r.ok ? `keys=${r.record.keys.join(",")} until=${r.record.expires_at}` : `${r.error}${r.detail ? `:${r.detail.join(",")}` : ""}`);
    return r.ok ? NextResponse.json({ ok: true, campaign: r.record }) : NextResponse.json({ error: r.error, detail: r.detail ?? [] }, { status: r.status });
  }
  if (body.action === "restore") {
    const r = await restoreCampaign(client);
    await audit(r.ok ? "استعادة مفاتيح حملة القبول" : "تعذّرت استعادة مفاتيح حملة القبول", r.ok ? `removed=${r.removed.join(",") || "none"}${r.already ? " already" : ""}` : `${r.error}${r.detail ? `:${r.detail.join(",")}` : ""}`);
    return r.ok ? NextResponse.json(r) : NextResponse.json({ error: r.error, detail: r.detail ?? [] }, { status: r.status });
  }
  const r = await createScenarioMission(client, { adminId: auth.ctx.adminId, account, scenario: body.scenario, budget: PRODUCTION_BUDGET_GUARANTEE });
  await audit(r.ok ? "إنشاء مهمة قبول" : "رفض إنشاء مهمة قبول", r.ok ? `${r.scenario} ${r.id}` : `${String(body.scenario)} ${r.error}${r.detail ? `:${r.detail.join(",")}` : ""}`);
  return r.ok ? NextResponse.json(r) : NextResponse.json({ error: r.error, detail: r.detail ?? [] }, { status: r.status });
}
