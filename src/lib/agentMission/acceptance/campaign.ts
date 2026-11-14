import { AGENT_SETTINGS_TABLE } from "../constants";
import { scopedFlagOn } from "../scopedFlag";
import { CAPABILITY_DISCOVERY_FLAG_KEY, MULTI_STAGE_ENGINE_FLAG_KEY, REGISTRY_ROUTER_FLAG_KEY, WEB_VIA_TREG_FLAG_KEY } from "../capabilities/flag";

/**
 * LIVE ACCEPTANCE CAMPAIGNS (docs/intelligence/ACCEPTANCE-WORKFLOW.md): the admin turns the Intelligence switches on for THE agent test account only, for a bounded time, and turns them back off, from an admin
 * screen, with no SQL. It adds no authority: the admin already writes `agent_settings` switches (redesign flags, catalog discovery); this narrows that power to one account and six named keys.
 *
 *  - WHO: only the agent test account (`AGENT_TEST_ACCOUNT_EMAIL`, the one account the admin agent console creates and approves missions for), and only when the shared classifier also calls it a test account
 *    (resolved by the admin route, src/app/api/admin/acceptance/account.ts, and handed in as `account`: these functions never pick an account themselves).
 *    Every written value is `{ "user_ids": [<that id>], "expires_at": <time> }`: never `true`, never `"on"`, never another id. No customer can inherit it (`scopedFlagOn`).
 *  - WHAT: only the six keys below, and only keys that are NOT set today (an owner's existing setting is never overwritten, so the restore is exact: the key is removed).
 *  - HOW LONG: 10 to 180 minutes. At `expires_at` every value reads OFF by itself (`scopedFlagOn`), even if nobody restores it.
 *  - ONE AT A TIME: the campaign row (`acceptance_campaign`) is INSERTED, never upserted: its primary key makes a second concurrent start fail with nothing written by it.
 *  - FAILURE: a start that fails half way removes what it wrote, then the campaign row. A restore removes only values still equal to what the campaign wrote (a value somebody changed meanwhile is kept and
 *    reported), verifies by reading again, and removes the campaign row last. Every step is idempotent.
 *  - MONEY: a start is REFUSED unless a hard campaign budget is enforceable (`CampaignBudgetGuarantee`). Nothing here reserves, charges, prices or approves anything.
 */
export const ACCEPTANCE_CAMPAIGN_KEY = "acceptance_campaign";
/** `chatTurn.ts` CHAT_RESEARCH_BRIEF_FLAG_KEY and `semantic/flag.ts` SEMANTIC_NORMALIZATION_FLAG_KEY (neither module is imported here: the chat and the semantic layer keep their own import fences; a test keeps the names equal). */
export const CHAT_RESEARCH_BRIEF_KEY = "chat_research_brief_v1";
export const SEMANTIC_NORMALIZATION_KEY = "semantic_normalization_v1";
export const ACCEPTANCE_FLAG_KEYS = [CHAT_RESEARCH_BRIEF_KEY, SEMANTIC_NORMALIZATION_KEY, CAPABILITY_DISCOVERY_FLAG_KEY, REGISTRY_ROUTER_FLAG_KEY, WEB_VIA_TREG_FLAG_KEY, MULTI_STAGE_ENGINE_FLAG_KEY] as const;
export type AcceptanceFlagKey = (typeof ACCEPTANCE_FLAG_KEYS)[number];
/** L4 (the Intelligence execution path of a mission the admin console creates): the switches the WORKER reads. The chat brief is a chat feature (an admin-console mission has no chat) and `web_via_treg` changes the source mix: both stay off unless chosen. */
export const L4_FLAG_KEYS: readonly AcceptanceFlagKey[] = [SEMANTIC_NORMALIZATION_KEY, CAPABILITY_DISCOVERY_FLAG_KEY, REGISTRY_ROUTER_FLAG_KEY, MULTI_STAGE_ENGINE_FLAG_KEY];
export const CAMPAIGN_MIN_MINUTES = 10;
export const CAMPAIGN_MAX_MINUTES = 180;
/** The owner's approved aggregate ceiling for one campaign (USD, every provider and model call together). */
export const CAMPAIGN_CEILING_USD = 0.3;

/**
 * Whether the campaign's aggregate ceiling can be ENFORCED before every paid request (not estimated, not watched). Only `enforceable: true` lets a campaign start or a scenario mission be created.
 */
export interface CampaignBudgetGuarantee { enforceable: boolean; ceilingUsd: number | null; reasons: string[] }

/**
 * THE GUARANTEE IN PRODUCTION TODAY: NOT ENFORCEABLE (audit in docs/intelligence/ACCEPTANCE-WORKFLOW.md §3). Each reason is a fact of the code on main:
 *  - `model_calls_not_reserved`: the Agent SDK's `maxBudgetUsd` and the planning/execution model budgets are checked AFTER a turn (the round-61 model-request gate says so, and it is not wired); nothing reserves a model request's maximum before it is sent.
 *  - `provider_caps_shared_and_estimated`: `reserve_provider_spend_atomic` is atomic, but it is a DAILY cap per provider shared by every customer, it reserves the call's ESTIMATE, and it does not cover the model.
 *  - `no_aggregate_ledger`: nothing adds TREG, Firecrawl, Context.dev and model spend into one reserved total; the designed one (the spend gate: docs/proposals/spend-gate, PR #481 + its SQL) is not applied.
 * It becomes enforceable only through a separately approved change (the spend gate in enforce mode with a campaign grant); this constant is then replaced, in its own reviewed PR.
 */
export const PRODUCTION_BUDGET_GUARANTEE: CampaignBudgetGuarantee = Object.freeze({
  enforceable: false,
  ceilingUsd: null,
  reasons: ["model_calls_not_reserved", "provider_caps_shared_and_estimated", "no_aggregate_ledger"],
}) as CampaignBudgetGuarantee;

export interface CampaignRecord {
  v: 1;
  account_id: string;
  keys: AcceptanceFlagKey[];
  /** What each key was before the start: always absent (a set key refuses the start), kept so the restore and the report say so. */
  snapshot: Record<string, null>;
  /** The exact value written for each key. */
  values: Record<string, { user_ids: string[]; expires_at: string }>;
  started_at: string;
  expires_at: string;
  started_by: string;
  ceiling_usd: number;
}

type Result<T = object> = ({ ok: true } & T) | { ok: false; status: number; error: string; detail?: string[] };
const fail = (status: number, error: string, detail?: string[]): { ok: false; status: number; error: string; detail?: string[] } => ({ ok: false, status, error, ...(detail ? { detail } : {}) });
const isUniqueViolation = (e: unknown) => String((e as { code?: unknown } | null)?.code ?? "") === "23505";
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

async function readRows(client: any, keys: string[]): Promise<{ ok: true; rows: Map<string, unknown> } | { ok: false }> {
  try {
    const { data, error } = await client.from(AGENT_SETTINGS_TABLE).select("key,value").in("key", keys);
    if (error || !Array.isArray(data)) return { ok: false };
    return { ok: true, rows: new Map(data.map((r: { key: string; value: unknown }) => [String(r.key), r.value])) };
  } catch {
    return { ok: false };
  }
}

async function deleteKey(client: any, key: string): Promise<boolean> {
  try {
    const { error } = await client.from(AGENT_SETTINGS_TABLE).delete().eq("key", key);
    return !error;
  } catch {
    return false;
  }
}

export function parseCampaignKeys(input: unknown): AcceptanceFlagKey[] | null {
  if (!Array.isArray(input) || input.length === 0 || input.length > ACCEPTANCE_FLAG_KEYS.length) return null;
  const out: AcceptanceFlagKey[] = [];
  for (const k of input) {
    if (typeof k !== "string" || !(ACCEPTANCE_FLAG_KEYS as readonly string[]).includes(k) || out.includes(k as AcceptanceFlagKey)) return null;
    out.push(k as AcceptanceFlagKey);
  }
  return out;
}

export function parseCampaignMinutes(input: unknown): number | null {
  const n = typeof input === "number" ? input : Number.NaN;
  return Number.isInteger(n) && n >= CAMPAIGN_MIN_MINUTES && n <= CAMPAIGN_MAX_MINUTES ? n : null;
}

export function readCampaignRecord(value: unknown): CampaignRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const r = value as Partial<CampaignRecord>;
  if (r.v !== 1 || typeof r.account_id !== "string" || !Array.isArray(r.keys) || !r.values || typeof r.values !== "object" || typeof r.expires_at !== "string" || typeof r.started_at !== "string") return null;
  return r as CampaignRecord;
}

export type AcceptanceAccount = { id: string } | null;

export async function startCampaign(client: any, input: { adminId: string; account: AcceptanceAccount; keys: unknown; minutes: unknown; budget: CampaignBudgetGuarantee; nowMs?: number }): Promise<Result<{ record: CampaignRecord }>> {
  const keys = parseCampaignKeys(input.keys);
  if (!keys) return fail(400, "bad_keys");
  const minutes = parseCampaignMinutes(input.minutes);
  if (minutes === null) return fail(400, "bad_minutes");
  // NO PAID WORK WITHOUT A HARD CEILING: the switches exist only to run paid test missions, so they are not turned on while the ceiling cannot be enforced
  if (input.budget.enforceable !== true || !(typeof input.budget.ceilingUsd === "number" && input.budget.ceilingUsd > 0 && input.budget.ceilingUsd <= CAMPAIGN_CEILING_USD)) return fail(409, "budget_not_enforceable", input.budget.reasons);
  const account = input.account;
  if (!account) return fail(404, "test_account_missing");
  const current = await readRows(client, [ACCEPTANCE_CAMPAIGN_KEY, ...keys]);
  if (!current.ok) return fail(503, "settings_unreadable");
  if (current.rows.has(ACCEPTANCE_CAMPAIGN_KEY)) return fail(409, "campaign_active");
  const alreadySet = keys.filter((k) => current.rows.has(k));
  if (alreadySet.length) return fail(409, "key_already_set", alreadySet);

  const now = input.nowMs ?? Date.now();
  const startedAt = new Date(now).toISOString();
  const expiresAt = new Date(now + minutes * 60_000).toISOString();
  const values = Object.fromEntries(keys.map((k) => [k, { user_ids: [account.id], expires_at: expiresAt }]));
  const record: CampaignRecord = { v: 1, account_id: account.id, keys, snapshot: Object.fromEntries(keys.map((k) => [k, null])), values, started_at: startedAt, expires_at: expiresAt, started_by: input.adminId, ceiling_usd: input.budget.ceilingUsd as number };
  const row = (key: string, value: unknown) => ({ key, value, updated_at: startedAt, updated_by: input.adminId });

  // the campaign row FIRST, by INSERT: the lock. A second admin's start fails here with nothing written
  try {
    const { error } = await client.from(AGENT_SETTINGS_TABLE).insert(row(ACCEPTANCE_CAMPAIGN_KEY, record));
    if (error) return isUniqueViolation(error) ? fail(409, "campaign_active") : fail(503, "settings_write_failed");
  } catch {
    return fail(503, "settings_write_failed");
  }
  const written: string[] = [];
  for (const k of keys) {
    let error: unknown = null;
    try { ({ error } = await client.from(AGENT_SETTINGS_TABLE).insert(row(k, values[k]))); } catch (e) { error = e ?? "thrown"; }
    if (error) {
      // undo: what this start wrote, then the lock; anything that cannot be undone is reported (it still turns itself off at expires_at)
      const left: string[] = [];
      for (const w of written) if (!(await deleteKey(client, w))) left.push(w);
      if (left.length === 0 && !(await deleteKey(client, ACCEPTANCE_CAMPAIGN_KEY))) left.push(ACCEPTANCE_CAMPAIGN_KEY);
      return fail(isUniqueViolation(error) ? 409 : 503, left.length ? "start_failed_rollback_incomplete" : isUniqueViolation(error) ? "key_already_set" : "settings_write_failed", left.length ? left : [k]);
    }
    written.push(k);
  }
  return { ok: true, record };
}

export async function restoreCampaign(client: any): Promise<Result<{ removed: string[]; already: boolean }>> {
  const lock = await readRows(client, [ACCEPTANCE_CAMPAIGN_KEY]);
  if (!lock.ok) return fail(503, "settings_unreadable");
  if (!lock.rows.has(ACCEPTANCE_CAMPAIGN_KEY)) return { ok: true, removed: [], already: true };
  const record = readCampaignRecord(lock.rows.get(ACCEPTANCE_CAMPAIGN_KEY));
  if (!record) return fail(409, "campaign_unreadable");
  const current = await readRows(client, record.keys);
  if (!current.ok) return fail(503, "settings_unreadable");
  const removed: string[] = [];
  const conflicts: string[] = [];
  const failed: string[] = [];
  for (const k of record.keys) {
    if (!current.rows.has(k)) continue;
    // only the value THIS campaign wrote is removed; a value somebody changed meanwhile is theirs
    if (!sameJson(current.rows.get(k), record.values[k])) { conflicts.push(k); continue; }
    if (await deleteKey(client, k)) removed.push(k); else failed.push(k);
  }
  // VERIFIED, not assumed: read again; every key the campaign wrote must be gone
  const after = await readRows(client, record.keys);
  if (!after.ok) return fail(503, "restore_unverified", record.keys);
  const remaining = record.keys.filter((k) => after.rows.has(k) && sameJson(after.rows.get(k), record.values[k]));
  if (failed.length || remaining.length) return fail(503, "restore_incomplete", [...new Set([...failed, ...remaining])]);
  if (conflicts.length) return fail(409, "restore_conflict", conflicts);
  if (!(await deleteKey(client, ACCEPTANCE_CAMPAIGN_KEY))) return fail(503, "restore_incomplete", [ACCEPTANCE_CAMPAIGN_KEY]);
  return { ok: true, removed, already: false };
}

export interface FlagState { key: AcceptanceFlagKey; set: boolean; onForTestAccount: boolean; onForOthers: boolean; scopedToTestAccountOnly: boolean }

/** Everything the screen shows, read-only: the account, the campaign, each key's state, and whether ANY other account could see a key on (isolation). */
export async function campaignStatus(client: any, account: AcceptanceAccount, nowMs: number = Date.now()): Promise<Result<{ account: { id: string } | null; campaign: (CampaignRecord & { expired: boolean }) | null; flags: FlagState[]; isolated: boolean }>> {
  const rows = await readRows(client, [ACCEPTANCE_CAMPAIGN_KEY, ...ACCEPTANCE_FLAG_KEYS]);
  if (!rows.ok) return fail(503, "settings_unreadable");
  const record = readCampaignRecord(rows.rows.get(ACCEPTANCE_CAMPAIGN_KEY));
  // a probe id that is no real account: if a value is on for it, it is on for every account
  const PROBE = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const flags = ACCEPTANCE_FLAG_KEYS.map((key): FlagState => {
    const set = rows.rows.has(key);
    const value = rows.rows.get(key);
    const ids = value && typeof value === "object" && !Array.isArray(value) && Array.isArray((value as { user_ids?: unknown }).user_ids) ? (value as { user_ids: unknown[] }).user_ids : null;
    return {
      key, set,
      onForTestAccount: account ? scopedFlagOn(value, account.id, nowMs) : false,
      onForOthers: scopedFlagOn(value, PROBE, nowMs),
      scopedToTestAccountOnly: !set || (account !== null && ids !== null && ids.length === 1 && String(ids[0]).trim().toLowerCase() === account.id),
    };
  });
  return {
    ok: true,
    account: account ? { id: account.id } : null,
    campaign: record ? { ...record, expired: !(nowMs < Date.parse(record.expires_at)) } : null,
    flags,
    isolated: flags.every((f) => !f.onForOthers && f.scopedToTestAccountOnly),
  };
}
