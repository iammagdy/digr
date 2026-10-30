import { AGENT_MAX_OPEN_MISSIONS_PER_USER, AGENT_STUCK_PLANNING_AFTER_MS, MISSION_TABLE } from "./constants";
import { refusalSentenceAr } from "./refusal";
import { expireWaitingMissions } from "../requests/expiry";

/**
 * THE ONE DEFINITION OF AN «OPEN» MISSION. The limit on new requests and the list the customer reads («طلباتي», the refusal sentence) are both computed from `openKindOf`, so a mission that blocks
 * a request is always one the customer is shown, with its state, and a mission the customer is shown as «waiting for you» never blocks.
 *
 *   worker                the worker has it (queued for it, or being planned with a live lease): counts toward the limit;
 *   waiting_for_customer  a question to answer or a plan to approve: holds nothing, uses no worker, never blocks;
 *   stuck                 planning with a lease that ran out past AGENT_STUCK_PLANNING_AFTER_MS: no live worker; ended honestly by `failStuckPlanning`, never counted;
 *   closed                anything else (done, failed, cancelled, approved or executing: those are jobs, listed with the jobs).
 */
export type OpenKind = "worker" | "waiting_for_customer" | "stuck" | "closed";

export interface OpenMissionRow { id: string; status: string; request_text?: string | null; created_at?: string | null; lease_until?: string | null; job_id?: string | null }

export const WORKER_HELD_STATUSES = ["queued", "planning"] as const;
export const WAITING_FOR_CUSTOMER_STATUSES = ["needs_input", "plan_ready"] as const;
export const OPEN_LIST_STATUSES = [...WORKER_HELD_STATUSES, ...WAITING_FOR_CUSTOMER_STATUSES];
/** What the customer may cancel before approval (a status change only: nothing is held before approval). */
const CANCELLABLE_OPEN = ["queued", "needs_input", "plan_ready"];

export function openKindOf(row: Pick<OpenMissionRow, "status" | "lease_until">, now: number = Date.now()): OpenKind {
  if (row.status === "queued") return "worker";
  if (row.status === "planning") {
    const lease = row.lease_until ? Date.parse(row.lease_until) : NaN;
    return Number.isFinite(lease) && lease < now - AGENT_STUCK_PLANNING_AFTER_MS ? "stuck" : "worker";
  }
  if ((WAITING_FOR_CUSTOMER_STATUSES as readonly string[]).includes(row.status)) return "waiting_for_customer";
  return "closed";
}

const STATE_AR: Record<string, string> = {
  queued: "في الدور وتبدأ خلال دقائق",
  planning: "قيد الدراسة الآن",
  needs_input: "تنتظر إجابتك",
  plan_ready: "الخطة جاهزة وتنتظر اعتمادك",
};
const STUCK_AR = "تعثّر تحضيرها من جانبنا؛ لم يُخصم شيء";

export interface OpenMissionView {
  id: string;
  /** The stored status (queued / planning / needs_input / plan_ready). */
  status: string;
  kind: OpenKind;
  stateAr: string;
  requestText: string;
  createdAt: string | null;
  /** True when this mission is one of those the limit counts. */
  blocksNewRequests: boolean;
  cancellable: boolean;
}

const shortText = (t: unknown, n: number): string => { const s = String(t ?? "").replace(/\s+/g, " ").trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };

export function openMissionView(row: OpenMissionRow, now: number = Date.now()): OpenMissionView | null {
  const kind = openKindOf(row, now);
  if (kind === "closed") return null;
  return {
    id: row.id, status: row.status, kind, stateAr: kind === "stuck" ? STUCK_AR : STATE_AR[row.status] ?? "قيد الإعداد",
    requestText: shortText(row.request_text, 80), createdAt: row.created_at ?? null,
    blocksNewRequests: kind === "worker", cancellable: kind !== "stuck" && CANCELLABLE_OPEN.includes(row.status),
  };
}

/**
 * A planning mission with no live worker is ended, not kept: `failed` with the same honest sentence and admin flag as any other planning failure of ours. Planning holds nothing (the reserve exists only after approval,
 * through the existing money functions), so nothing is released here; a mission that has a job is never touched. The update is a compare-and-set on the status and on the expired lease, so a worker that took the mission
 * over in the meantime (it renews the lease) keeps it, and repeating the call changes nothing. Returns the ids ended.
 */
export async function failStuckPlanning(client: any, input: { userId: string; now?: number }): Promise<string[]> {
  const now = input.now ?? Date.now();
  const read = await client.from(MISSION_TABLE).select("id,status,lease_until,job_id").eq("user_id", input.userId).eq("status", "planning");
  if (read?.error || !Array.isArray(read?.data)) return [];
  const cutoff = new Date(now - AGENT_STUCK_PLANNING_AFTER_MS).toISOString();
  const ended: string[] = [];
  for (const row of read.data as OpenMissionRow[]) {
    if (row.job_id || openKindOf(row, now) !== "stuck") continue;
    const upd = await client.from(MISSION_TABLE)
      .update({ status: "failed", summary_ar: refusalSentenceAr("internal"), error: "admin: planning_failed class=internal reason=lease_lost_past_timeout", worker_id: null, lease_until: null, updated_at: new Date(now).toISOString() })
      .eq("id", row.id).eq("user_id", input.userId).eq("status", "planning").lt("lease_until", cutoff);
    if (!upd?.error) ended.push(row.id);
  }
  return ended;
}

/**
 * The customer's open missions, newest first, after stuck planning ones were ended and the questions and plans nobody answered in 72 hours (or beyond the newest 5) were expired (`expiry.ts`: a status change, no money).
 * Read errors read as «none»: the request path never fails because of the list.
 */
export async function listOpenMissions(client: any, input: { userId: string; now?: number }): Promise<OpenMissionView[]> {
  const now = input.now ?? Date.now();
  try { await failStuckPlanning(client, { userId: input.userId, now }); } catch { /* the list still reads */ }
  try { await expireWaitingMissions(client, { userId: input.userId, now }); } catch { /* the list still reads */ }
  const read = await client.from(MISSION_TABLE).select("id,status,request_text,created_at,lease_until,job_id").eq("user_id", input.userId).in("status", OPEN_LIST_STATUSES).order("created_at", { ascending: false }).limit(50);
  if (read?.error || !Array.isArray(read?.data)) return [];
  return (read.data as OpenMissionRow[]).map((r) => openMissionView(r, now)).filter((v): v is OpenMissionView => v !== null);
}

/** The refusal sentence of the limit: it names the missions that block, each with its state, and says where they are. */
export function openLimitMessageAr(blockers: OpenMissionView[]): string {
  const lines = blockers.slice(0, AGENT_MAX_OPEN_MISSIONS_PER_USER).map((m) => `«${m.requestText}» (${m.stateAr})`);
  return `عندك مهام مفتوحة بالفعل قيد الإعداد: ${lines.join("، ")}. انتظر حتى تجهز إحداها ثم ابدأ مهمة جديدة؛ لن يُخصم شيء. تجدها في «طلباتي» تحت «مهام قيد الإعداد».`;
}
