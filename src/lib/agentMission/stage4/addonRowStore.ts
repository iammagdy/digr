import { MISSION_TABLE } from "../constants";
import { recoverRows } from "../addonRecovery";
import type { AddonRowInsert, AddonRowLike, AddonRowStore } from "./addonRow";

/**
 * MONEY PR 7d, 2B-2 task 3 (docs/MONEY-PR-7A.md section 16): THE SUPABASE STORE OF ADD-ON ROWS, for ONE customer. Add-on rows are rows of the existing `missions` table; this file reads them, inserts one (`plan_ready`, nothing held) and cancels an UNPAID one.
 * It touches the missions table only: no job, no ledger, no wallet, no rpc, no storage. Every read and write names the customer (`user_id`), so a row of another customer is never seen or changed.
 */
const bad = (what: string): Error => new Error(`add-on rows: ${what}`);

/**
 * Cancel an UNPAID add-on row with ONE compare-and-set: it matches only a row of this customer that is still `plan_ready`, has no job AND was never put through an approval (`approved_at` empty). The approval's claim sets `approved_at` and a failed approval puts the row back
 * to `plan_ready` WITHOUT clearing it, so a row that was ever claimed (its money may have moved before the answer was lost) is never cancelled here: that state is the approval's to settle. The update is read back: `true` only when exactly this call changed the row; a row that is
 * gone, already cancelled, started, holding a job or ever approved matches nothing and answers `false`. A database failure throws. No refund and no settlement function exists on this path.
 */
export async function cancelUnpaidAddonRow(client: any, input: { id: string; userId: string }): Promise<boolean> {
  const upd = await client.from(MISSION_TABLE).update({ status: "cancelled", updated_at: new Date().toISOString() }).eq("id", input.id).eq("user_id", input.userId).eq("status", "plan_ready").is("job_id", null).is("approved_at", null).select("id");
  if (upd.error) throw bad("the cancel failed");
  return Array.isArray(upd.data) && upd.data.length === 1;
}

/** The names of the two unique constraints an add-on insert can meet (the second is prepared in supabase/migrations/*_one_open_addon_per_file.sql and NOT applied: until it is, `other_open` never occurs). */
export const PK_CONSTRAINT_NAME = "missions_pkey";
export const OPEN_ADDON_INDEX_NAME = "missions_one_open_addon_per_file";

/**
 * WHAT A FAILED INSERT MEANS. PostgreSQL answers a unique violation with SQLSTATE 23505 and the constraint's name in the message (PostgREST passes both through; the text below was captured from PostgreSQL 16 by scripts/verify/verify-one-open-addon-index.sh):
 *   `missions_pkey`                         the SAME request (the same id) was inserted a moment ago: the same click twice                  -> duplicate, by «same_id»
 *   `missions_one_open_addon_per_file`      a DIFFERENT request of this file is open: the database refused a second one                      -> duplicate, by «other_open»
 *   any other 23505                         a unique constraint nobody here knows                                                            -> duplicate, by «unknown» (still a refusal, never success)
 *   anything else (permission, check, timeout, connection, no code)                                                                         -> NOT a duplicate: the caller throws, the request is not made and not reported
 * A message that merely MENTIONS a constraint name without being a unique violation (a missing relation) is not a duplicate. Only `{ ok: true }` ever creates a request.
 */
export function classifyInsertError(error: { code?: unknown; message?: unknown }): { ok: false; duplicate: boolean; by?: "same_id" | "other_open" | "unknown" } {
  const message = String(error?.message ?? "");
  const code = String(error?.code ?? "");
  const unique = code === "23505" || (code === "" && /duplicate key value violates unique constraint/i.test(message));
  if (!unique) return { ok: false, duplicate: false };
  if (message.includes(`"${PK_CONSTRAINT_NAME}"`)) return { ok: false, duplicate: true, by: "same_id" };
  if (message.includes(`"${OPEN_ADDON_INDEX_NAME}"`)) return { ok: false, duplicate: true, by: "other_open" };
  return { ok: false, duplicate: true, by: "unknown" };
}

export function createSupabaseAddonRowStore(client: any, userId: string): AddonRowStore {
  return {
    async listFor(missionId: string): Promise<ReadonlyArray<AddonRowLike>> {
      // the customer's own add-on rows of this delivered mission (the JSON path `plan->addon->>of`); a failed read THROWS: «no add-on is open» is never assumed from an error
      const { data, error } = await client.from(MISSION_TABLE).select("id,status,plan,job_id,approved_at,lease_until").eq("user_id", userId).eq("plan->addon->>of", missionId);
      if (error || !Array.isArray(data)) throw bad("the read failed");
      return data.map((r: any) => ({ id: String(r.id), status: String(r.status), plan: r.plan, job_id: r.job_id ?? null, approved_at: r.approved_at ?? null, lease_until: r.lease_until ?? null }));
    },
    async insert(row: AddonRowInsert) {
      const { error } = await client.from(MISSION_TABLE).insert(row);
      if (!error) return { ok: true as const };
      return classifyInsertError(error);
    },
    cancelUnpaid: (id: string) => cancelUnpaidAddonRow(client, { id, userId }),
    async recoverAbandoned(rows: ReadonlyArray<AddonRowLike>): Promise<boolean> {
      const outcomes = await recoverRows(client, { userId, rows });
      return outcomes.some((o) => o.kind === "ended_released" || (o.kind === "active" && o.recorded));
    },
  };
}
