import { createMission } from "../adminActions";
import { campaignStatus, CAMPAIGN_CEILING_USD, L4_FLAG_KEYS, type AcceptanceAccount, type CampaignBudgetGuarantee } from "./campaign";
import { scenarioOf } from "./scenarios";

/**
 * CREATE ONE ACCEPTANCE MISSION (L3 or L4) through the EXISTING admin action (`createMission`: the agent test account only, status `queued`; the worker plans it, and spending money still needs the admin's
 * approval of the priced plan through the shared quote path). This adds only preconditions, never a shortcut:
 *  - the campaign's hard ceiling must be enforceable (planning itself calls the model and the sources);
 *  - L3 runs on today's path: no Intelligence switch may be on for the test account;
 *  - L4 runs inside a live campaign: unexpired, isolated to the test account, with every L4 switch on.
 * L1 and L2 are never created here (they need authorized identifiers, typed by their owner on the reverse-lookup screen).
 */
export async function createScenarioMission(client: any, input: { adminId: string; account: AcceptanceAccount; scenario: unknown; budget: CampaignBudgetGuarantee; nowMs?: number }): Promise<{ ok: true; id: string; scenario: "L3" | "L4" } | { ok: false; status: number; error: string; detail?: string[] }> {
  const scenario = scenarioOf(input.scenario);
  if (!scenario || scenario.route !== "agent_console" || !scenario.requestAr) return { ok: false, status: 400, error: "bad_scenario" };
  if (input.budget.enforceable !== true || !(typeof input.budget.ceilingUsd === "number" && input.budget.ceilingUsd > 0 && input.budget.ceilingUsd <= CAMPAIGN_CEILING_USD)) return { ok: false, status: 409, error: "budget_not_enforceable", detail: input.budget.reasons };
  const status = await campaignStatus(client, input.account, input.nowMs ?? Date.now());
  if (!status.ok) return { ok: false, status: 503, error: "settings_unreadable" };
  if (!status.account) return { ok: false, status: 404, error: "test_account_missing" };
  if (!status.isolated) return { ok: false, status: 409, error: "not_isolated" };
  if (scenario.intelligence) {
    const off = L4_FLAG_KEYS.filter((k) => !status.flags.find((f) => f.key === k)?.onForTestAccount);
    if (!status.campaign || status.campaign.expired || off.length) return { ok: false, status: 409, error: "campaign_not_active", detail: off };
  } else {
    const on = status.flags.filter((f) => f.onForTestAccount).map((f) => f.key);
    if (on.length) return { ok: false, status: 409, error: "intelligence_on", detail: on };
  }
  const r = await createMission(client, { adminId: input.adminId, text: scenario.requestAr });
  return r.ok ? { ok: true, id: r.id, scenario: scenario.id as "L3" | "L4" } : { ok: false, status: r.status, error: r.error };
}
