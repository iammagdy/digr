import { MISSION_TABLE } from "../constants";
import type { AddonRowInsert, AddonRowLike, AddonRowStore } from "./addonRow";

/**
 * MONEY PR 7d, 2B-2 task 3 (docs/MONEY-PR-7A.md section 16): THE SUPABASE STORE OF ADD-ON ROWS, for ONE customer. Add-on rows are rows of the existing `missions` table; this file reads them, inserts one (`plan_ready`, nothing held) and cancels an UNPAID one.
 * It touches the missions table only: no job, no ledger, no wallet, no rpc, no storage. Every read and write names the customer (`user_id`), so a row of another customer is never seen or changed.
 */
const bad = (what: string): Error => new Error(`add-on rows: ${what}`);

/**
 * Cancel an UNPAID add-on row with ONE compare-and-set: it matches only a row of this customer that is still `plan_ready` AND has no job (nothing was reserved). The update is read back: `true` only when exactly this call changed the row; a row that is gone,
 * already cancelled, started or holding a job matches nothing and answers `false`. A database failure throws. No refund and no settlement function exists on this path.
 */
export async function cancelUnpaidAddonRow(client: any, input: { id: string; userId: string }): Promise<boolean> {
  const upd = await client.from(MISSION_TABLE).update({ status: "cancelled", updated_at: new Date().toISOString() }).eq("id", input.id).eq("user_id", input.userId).eq("status", "plan_ready").is("job_id", null).select("id");
  if (upd.error) throw bad("the cancel failed");
  return Array.isArray(upd.data) && upd.data.length === 1;
}

export function createSupabaseAddonRowStore(client: any, userId: string): AddonRowStore {
  return {
    async listFor(missionId: string): Promise<ReadonlyArray<AddonRowLike>> {
      // the customer's own add-on rows of this delivered mission (the JSON path `plan->addon->>of`); a failed read THROWS: «no add-on is open» is never assumed from an error
      const { data, error } = await client.from(MISSION_TABLE).select("id,status,plan").eq("user_id", userId).eq("plan->addon->>of", missionId);
      if (error || !Array.isArray(data)) throw bad("the read failed");
      return data.map((r: any) => ({ id: String(r.id), status: String(r.status), plan: r.plan }));
    },
    async insert(row: AddonRowInsert) {
      const { error } = await client.from(MISSION_TABLE).insert(row);
      if (!error) return { ok: true as const };
      // the primary key refused: the same id was made a moment ago (the same click twice)
      return { ok: false as const, duplicate: String(error.code ?? "") === "23505" || /duplicate key/i.test(String(error.message ?? "")) };
    },
    cancelUnpaid: (id: string) => cancelUnpaidAddonRow(client, { id, userId }),
  };
}
