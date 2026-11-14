/**
 * SPEND SAFETY MILESTONE (14 Nov 2026): the terms of the ONE capped, test-account-only acceptance campaign. Pure constants and pure functions: no network,
 * no database, no secret. NOTHING HERE ENABLES ANYTHING. The campaign exists only if the owner, with the database owner role, issues a campaign grant
 * (docs/proposals/spend-gate/sql/003_campaign_scope.sql), AND the owner sets DIGER_SPEND_GATE=campaign with DIGER_SPEND_CAMPAIGN_ACCOUNT on the worker.
 *
 * What «campaign» adds to the round-61/62 grant (which was global: one open grant that every paid call of the worker drew on):
 *  - the grant is BOUND to one account, and only the missions ENROLLED in it may reserve against it;
 *  - the ceiling is ONE cumulative amount for the whole campaign, counted across every grant ever issued to the campaign account (a revoked or expired
 *    grant does not give its amount back; a reservation still held counts in full);
 *  - the worker gates ONLY the missions of that account; every other mission runs exactly as before and never touches the gate;
 *  - the grant's terms are immutable once issued, and a tripped or revoked grant never reopens.
 */

/** The owner's total for the whole campaign. NOT per call, mission, provider, stage or day. */
export const CAMPAIGN_LIFETIME_CEILING_USD = 0.3;
/** A campaign grant's window is short on purpose (the general grant allows 31 days). */
export const CAMPAIGN_MAX_WINDOW_HOURS = 72;
/** A campaign covers the worker's provider calls and model requests only: never `chat` (the website) and never `eval`. */
export const CAMPAIGN_KINDS = ["provider", "model"] as const;
/** The most missions one campaign grant may enroll (the first acceptance is ONE representative mission). */
export const CAMPAIGN_MAX_ENROLLED_MISSIONS = 5;
/**
 * A TREG call is retried on the next key of the key pool when it fails for the KEY's reason, at most POOL_MAX_HOPS (3) times
 * (src/lib/server/tregKeyPool.ts). The pool documents those hops as unbilled, but a bound must not rest on that: a campaign reserves the route cap of
 * EVERY possible attempt, so even four billed attempts stay inside the reservation.
 */
export const TREG_CAMPAIGN_ATTEMPTS = 4;

export const CAMPAIGN_ENV = { mode: "DIGER_SPEND_GATE", account: "DIGER_SPEND_CAMPAIGN_ACCOUNT" } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isAccountId = (v: unknown): v is string => typeof v === "string" && UUID.test(v.trim());

/** Why a campaign environment is unusable. The worker REFUSES TO START with it: a half-configured campaign must never run ungated. */
export class SpendCampaignConfigError extends Error {
  constructor(message: string) { super(message); this.name = "SpendCampaignConfigError"; }
}

export interface CampaignMode { mode: "campaign"; accountId: string }
/**
 * `DIGER_SPEND_GATE=campaign` selects the scoped mode and REQUIRES `DIGER_SPEND_CAMPAIGN_ACCOUNT` to be the test account's id (a UUID); so does any other enforcing
 * value when an account id is set. Anything else returns null here (off, observe or the round-62 global modes are decided by spendGateMode). A campaign mode without a
 * valid account throws.
 */
export function campaignModeFromEnv(env: Record<string, string | undefined>): CampaignMode | null {
  const raw = String(env[CAMPAIGN_ENV.mode] ?? "").trim().toLowerCase();
  const account = String(env[CAMPAIGN_ENV.account] ?? "").trim();
  // `campaign` selects the scope. An account id ALONGSIDE any other enforcing value (`enforce`, a typo) means the same, so a typo in the mode can never become a GLOBAL
  // enforce that refuses every customer's paid call: the account id says what the owner meant. Off and observe are never turned into a campaign.
  const enforcing = raw !== "" && raw !== "off" && raw !== "0" && raw !== "observe";
  if (raw !== "campaign" && !(enforcing && account !== "")) return null;
  if (!isAccountId(account)) throw new SpendCampaignConfigError(`${CAMPAIGN_ENV.mode}=${raw === "campaign" ? "campaign" : "an enforcing value"} needs ${CAMPAIGN_ENV.account} to be the test account's id (a UUID): the worker does not start without it`);
  return { mode: "campaign", accountId: account.toLowerCase() };
}

/** Everything the enforceability of the campaign ceiling rests on. Each field is EVIDENCE somebody observed, never an assumption. */
export interface CampaignEvidence {
  /** 001 and 003 are applied and 004's checks all returned true (owner, database). */
  sqlApplied: boolean;
  /** An open campaign grant exists, bound to the test account, with a ceiling at or under the lifetime ceiling, not expired, not tripped. */
  grantOpen: boolean;
  grantCeilingUsd: number | null;
  grantAccountIsTestAccount: boolean;
  /** The worker runs this commit's gate in campaign mode for that account (heartbeat or log). */
  workerInCampaignMode: boolean;
  workerVersionHasGate: boolean;
  /** The paid-call inventory test passes (no paid path outside the registry) and every path in campaign scope is gated. */
  inventoryComplete: boolean;
  /** The spending store answered a reservation and a settlement in a rehearsal on THIS database (a refusal seen before any provider call). */
  rehearsalPassed: boolean;
  /** Provider-side limits exist (Anthropic Console workspace limit, plan caps): the only control against a leaked key. */
  providerLimitsConfigured: boolean;
}

export interface CampaignReadiness { enforceable: boolean; blockers: string[] }

/**
 * Is the campaign's $0.30 ceiling ENFORCEABLE, from evidence. True only when every condition holds. It is NOT called by any production path today
 * (PRODUCTION_BUDGET_GUARANTEE in acceptance/campaign.ts stays enforceable=false and the admin acceptance routes keep refusing); it is the checklist a
 * later, separately approved PR would wire to live evidence.
 */
export function campaignReadiness(e: CampaignEvidence): CampaignReadiness {
  const blockers: string[] = [];
  if (!e.sqlApplied) blockers.push("sql_not_applied");
  if (!e.grantOpen) blockers.push("no_open_campaign_grant");
  if (e.grantOpen && !(typeof e.grantCeilingUsd === "number" && e.grantCeilingUsd > 0 && e.grantCeilingUsd <= CAMPAIGN_LIFETIME_CEILING_USD + 1e-9)) blockers.push("grant_ceiling_above_campaign_ceiling");
  if (e.grantOpen && !e.grantAccountIsTestAccount) blockers.push("grant_not_bound_to_the_test_account");
  if (!e.workerVersionHasGate) blockers.push("worker_without_the_gate");
  if (!e.workerInCampaignMode) blockers.push("worker_not_in_campaign_mode");
  if (!e.inventoryComplete) blockers.push("paid_call_inventory_incomplete");
  if (!e.rehearsalPassed) blockers.push("no_rehearsal_on_the_production_store");
  if (!e.providerLimitsConfigured) blockers.push("provider_side_limits_not_confirmed");
  return { enforceable: blockers.length === 0, blockers };
}
