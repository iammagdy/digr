import { MISSION_EVENTS_TABLE, MISSION_TABLE } from "./constants";
import { ADDON_APPROVE_MESSAGES_AR, addonJobId, addonQuoteId, checkAddon, readAddonPlan, releasedRowPatch } from "./addonSettlement";
import { readJobMoneyState } from "./addonMoneyState";

/**
 * SAFETY FIX C (docs/STAGE-4-FINANCIAL-SAFETY.md): RECOVERY OF AN ABANDONED APPROVAL. A request whose approval failed after money-related steps goes back to `plan_ready` WITH its approval mark (and a record that failed can leave it `approved` with no job id). If its job was later
 * released (the approval's own release, or the watchdog), nothing ended the request: it could be neither cancelled (the mark) nor approved again, and it blocked its file. This file decides from the DATABASE's own state of the request's deterministic job (`readJobMoneyState`) and does the
 * one thing that state proves:
 *   released     the points came back (the ledger says so): END the request (`failed`, no charge, the job recorded for audit). One compare-and-set; a second call finds it ended.
 *   active       the hold is held and the job is RUNNING: finish the record that the approval could not write (same job, same quote, same hold; status `approved` for the worker). A job only QUEUED (reserved, never claimed) is left for the approval's retry, which claims it.
 *   none         nothing was ever reserved: the request stays waiting (the customer may approve again). NOT ended, NOT cancelled by this file. When its approval mark is older than STALE_APPROVAL_MARK_MS the mark is cleared (`mark_cleared`) so the page shows the request waiting again.
 *   charged      settled and charged: untouched (the worker or an administrator resolves it). Never ended as unpaid.
 *   anything else (a read failed, the rows contradict each other, a hold that is not what the code computes): untouched, reported as unresolved.
 * It NEVER calls a money function (no rpc at all), never writes a money table (jobs and credit_ledger are read only), never releases, charges or refunds; every write is ONE compare-and-set on the request's own row, conditioned on the status, job and approval mark that were read,
 * so a concurrent approval, worker or recovery makes it match nothing. A row that is `approved` without a job is touched only after its one-hour lease has run out (an approval still in flight is not disturbed).
 */
export type RecoveryOutcome =
  | { kind: "not_applicable" }
  | { kind: "unpaid" }
  | { kind: "no_reservation" }
  | { kind: "mark_cleared" }
  | { kind: "active"; recorded: boolean }
  | { kind: "ended_released" }
  | { kind: "charged" }
  | { kind: "unresolved"; why: "read_failed" | "inconsistent" | "settled_without_row" | "hold_mismatch" };

/**
 * How long a request's approval mark must be OLD before a ledger state «none» (nothing ever reserved) frees it. A quote lasts 30 minutes (`expiresInMinutes`, addonSettlement.ts), so an approval that began more than 31 minutes ago can no longer
 * reserve anything: a late accept is refused as expired. Younger marks are left alone (an approval may still be in flight in another tab or instance).
 */
export const STALE_APPROVAL_MARK_MS = 31 * 60_000;

/** The most add-ons of one file a single call looks at (a file has one open add-on; the bound keeps a damaged file from becoming a loop). */
export const RECOVERY_MAX_PER_FILE = 3;

interface RowLike { id: string; user_id?: string; status?: string; plan?: unknown; job_id?: string | null; approved_at?: string | null; lease_until?: string | null }
const COLUMNS = "id,user_id,status,plan,job_id,approved_at,lease_until";

/** Is this row a request whose approval was ATTEMPTED and not finished? */
export function abandonedApproval(row: { status?: string; job_id?: string | null; approved_at?: string | null; lease_until?: string | null }, now: Date = new Date()): boolean {
  if (row.status === "plan_ready") return Boolean(row.approved_at) || Boolean(row.job_id);
  if (row.status === "approved") return !row.job_id && !(row.lease_until && Date.parse(row.lease_until) > now.getTime());
  return false;
}

/** The compare-and-set filters that pin the row to what was read: its status, its job (or its absence) and its approval mark. */
function pinned(q: any, row: RowLike): any {
  let out = q.eq("status", row.status as string);
  out = row.job_id ? out.eq("job_id", row.job_id) : out.is("job_id", null);
  return row.approved_at ? out.eq("approved_at", row.approved_at) : out.is("approved_at", null);
}

export async function recoverAbandonedAddon(client: any, input: { id: string; userId: string; now?: Date }): Promise<RecoveryOutcome> {
  const now = input.now ?? new Date();
  const { data: row, error } = await client.from(MISSION_TABLE).select(COLUMNS).eq("id", input.id).maybeSingle();
  if (error) return { kind: "unresolved", why: "read_failed" };
  if (!row || row.user_id !== input.userId) return { kind: "not_applicable" };
  const addon = readAddonPlan(row.plan);
  if (!addon) return { kind: "not_applicable" };
  if (row.status === "plan_ready" && !row.approved_at && !row.job_id) return { kind: "unpaid" };
  if (!abandonedApproval(row, now)) return { kind: "not_applicable" };

  const quoteId = addonQuoteId(row.id);
  const jobId = addonJobId(quoteId);
  if (row.job_id && row.job_id !== jobId) return { kind: "unresolved", why: "inconsistent" };
  const state = await readJobMoneyState(client, jobId);
  const stamp = now.toISOString();

  switch (state.kind) {
    case "none": {
      // The root cause of «after a reload there is no button and no cancel»: an approval that failed with an UNCERTAIN code (quote_failed, a thrown error) keeps the mark, nothing was reserved (the ledger says «none»),
      // and the page only shows an UNMARKED waiting request. Once the quote has certainly expired, the mark is cleared by ONE compare-and-set on the request's own row (still plan_ready, no job, the same mark), so the SAME request is
      // waiting again (approve or cancel). No money function is called; a hold that appears later is impossible (expired quote) and would be found by the next call as «active».
      const markedAt = row.status === "plan_ready" && row.approved_at && !row.job_id ? Date.parse(String(row.approved_at)) : NaN;
      if (Number.isFinite(markedAt) && now.getTime() - markedAt > STALE_APPROVAL_MARK_MS) {
        const cleared = await pinned(client.from(MISSION_TABLE).update({ approved_at: null, approved_by: null, updated_at: stamp }).eq("id", row.id).eq("user_id", input.userId), row).select("id");
        if (!cleared.error && Array.isArray(cleared.data) && cleared.data.length === 1) return { kind: "mark_cleared" };
      }
      return { kind: "no_reservation" };
    }
    case "unknown": return { kind: "unresolved", why: state.why };
    case "settled_free": return { kind: "unresolved", why: "settled_without_row" };
    case "charged": return { kind: "charged" };
    case "released": {
      const patch = { ...releasedRowPatch(jobId, quoteId, state.holdPoints), updated_at: stamp };
      const upd = await pinned(client.from(MISSION_TABLE).update(patch).eq("id", row.id).eq("user_id", input.userId), row).select("id");
      if (upd.error) return { kind: "unresolved", why: "read_failed" };
      if (!Array.isArray(upd.data) || upd.data.length !== 1) return { kind: "not_applicable" };
      try { await client.from(MISSION_EVENTS_TABLE).insert({ mission_id: row.id, kind: "result", message_ar: patch.summary_ar, counts: {} }); } catch { /* the sentence is on the row; a lost event changes no money */ }
      return { kind: "ended_released" };
    }
    case "active": {
      const check = checkAddon(row.id, addon);
      if (!check.ok || check.holdPoints !== state.holdPoints) return { kind: "unresolved", why: "hold_mismatch" };
      if (state.status !== "running") return { kind: "active", recorded: false };
      const patch = { status: "approved", job_id: jobId, quote_id: quoteId, reserved_points: check.holdPoints, unit_price_points: 1, lease_until: null, error: null, updated_at: stamp };
      const upd = await pinned(client.from(MISSION_TABLE).update(patch).eq("id", row.id).eq("user_id", input.userId), row).select("id");
      if (upd.error || !Array.isArray(upd.data) || upd.data.length !== 1) return { kind: "active", recorded: false };
      try { await client.from(MISSION_EVENTS_TABLE).insert({ mission_id: row.id, kind: "system", message_ar: ADDON_APPROVE_MESSAGES_AR.approved_event, counts: {} }); } catch { /* as above */ }
      return { kind: "active", recorded: true };
    }
  }
}

/** The abandoned approvals among rows ALREADY READ (at most RECOVERY_MAX_PER_FILE), handled one by one. Best effort: a failing call is skipped and never thrown, so a page that calls it behaves as before when the database is down. */
export async function recoverRows(client: any, input: { userId: string; rows: ReadonlyArray<RowLike>; now?: Date }): Promise<RecoveryOutcome[]> {
  const now = input.now ?? new Date();
  const mine = input.rows.filter((r) => readAddonPlan(r.plan) !== null && abandonedApproval(r, now)).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).slice(0, RECOVERY_MAX_PER_FILE);
  const out: RecoveryOutcome[] = [];
  for (const r of mine) { try { out.push(await recoverAbandonedAddon(client, { id: r.id, userId: input.userId, now })); } catch { /* the next call tries again */ } }
  return out;
}

/** The abandoned approvals of one customer's file: read the add-on rows, then `recoverRows`. Never throws. */
export async function recoverFileAddons(client: any, input: { missionId: string; userId: string; now?: Date }): Promise<RecoveryOutcome[]> {
  try {
    const { data, error } = await client.from(MISSION_TABLE).select(COLUMNS).eq("user_id", input.userId).eq("plan->addon->>of", input.missionId);
    if (error || !Array.isArray(data)) return [];
    return await recoverRows(client, { userId: input.userId, rows: data as RowLike[], ...(input.now ? { now: input.now } : {}) });
  } catch {
    return [];
  }
}
