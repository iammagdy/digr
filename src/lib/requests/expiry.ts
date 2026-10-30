import { MISSION_TABLE } from "../agentMission/constants";

/**
 * A QUESTION OR A PLAN THAT NOBODY ANSWERS EXPIRES. Nothing is held before approval and nothing is spent, so ending one is a status change only (no money function, no ledger row):
 *
 *   - older than 72 hours: expired;
 *   - more than 5 waiting for the customer: the OLDEST are expired until 5 remain (this also bounds the planning cost of many abandoned requests).
 *
 * An expired request is stored as `cancelled` (a status that already exists) with the sentence «انتهت صلاحية الخطة» in `summary_ar` and `error` = `expired: …`; the customer's own cancel has neither.
 * It is done while the customer's lists are read (no background task); the update is a compare-and-set on the waiting statuses, so an answer or an approval that arrives in the same moment wins, and repeating it changes nothing.
 */
export const WAITING_STATUSES = ["needs_input", "plan_ready"] as const;
export const PENDING_WINDOW_MS = 72 * 3600_000;
export const PENDING_MAX_WAITING = 5;
export const EXPIRED_SENTENCE_AR = "انتهت صلاحية الخطة";
export const EXPIRED_ERROR_PREFIX = "expired:";

export const isExpiredMission = (row: { summary_ar?: unknown; error?: unknown }): boolean =>
  String(row.error ?? "").startsWith(EXPIRED_ERROR_PREFIX) || String(row.summary_ar ?? "") === EXPIRED_SENTENCE_AR;

interface WaitingRow { id: string; status: string; created_at: string | null; job_id?: string | null }

/** Which waiting missions expire, and why: pure. `rows` may come in any order. */
export function missionsToExpire(rows: WaitingRow[], now: number): Array<{ id: string; reason: "age" | "cap" }> {
  const waiting = rows.filter((r) => !r.job_id && (WAITING_STATUSES as readonly string[]).includes(r.status));
  const at = (r: WaitingRow): number => { const t = r.created_at ? Date.parse(r.created_at) : NaN; return Number.isFinite(t) ? t : 0; };
  const out: Array<{ id: string; reason: "age" | "cap" }> = [];
  const fresh: WaitingRow[] = [];
  for (const r of waiting) { if (at(r) < now - PENDING_WINDOW_MS) out.push({ id: r.id, reason: "age" }); else fresh.push(r); }
  fresh.sort((a, b) => at(b) - at(a));
  for (const r of fresh.slice(PENDING_MAX_WAITING)) out.push({ id: r.id, reason: "cap" });
  return out;
}

/** Ends the customer's stale or surplus waiting missions. Returns the ids ended. Never throws; a read error ends nothing. */
export async function expireWaitingMissions(client: any, input: { userId: string; now?: number }): Promise<string[]> {
  const now = input.now ?? Date.now();
  const read = await client.from(MISSION_TABLE).select("id,status,created_at,job_id").eq("user_id", input.userId).in("status", [...WAITING_STATUSES]).order("created_at", { ascending: false }).limit(500);
  if (read?.error || !Array.isArray(read?.data)) return [];
  const ended: string[] = [];
  for (const { id, reason } of missionsToExpire(read.data as WaitingRow[], now)) {
    const upd = await client.from(MISSION_TABLE)
      .update({ status: "cancelled", summary_ar: EXPIRED_SENTENCE_AR, error: `${EXPIRED_ERROR_PREFIX} ${reason === "age" ? "not approved within 72 hours" : "more than 5 waiting"}`, worker_id: null, lease_until: null, updated_at: new Date(now).toISOString() })
      .eq("id", id).eq("user_id", input.userId).in("status", [...WAITING_STATUSES]).is("job_id", null).select("id");
    if (!upd?.error && Array.isArray(upd?.data) && upd.data.length > 0) ended.push(id);
  }
  return ended;
}
