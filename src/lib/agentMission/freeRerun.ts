import { randomBytes } from "node:crypto";
import { AGENT_TEST_ACCOUNT_EMAIL, MISSION_EVENTS_TABLE, MISSION_TABLE } from "./constants";
import { ADDON_MARKER_COLUMN, hasAddonMarker } from "./addonMarker";
import { grantCreditAsAdmin } from "../server/adminCredit";
import { FREE_RERUN_MARK, FREE_RERUN_REFUND, holdGrantOf, isFreeRerunEvents, refundDue, refundOf } from "./freeRerunMark";

/**
 * A FREE RE-RUN FOR A CUSTOMER (the admin's «إعادة تشغيل مجانية»): the admin runs a request again ON THE CUSTOMER'S OWN ACCOUNT (it shows in their
 * requests, they get the usual notices and the file), and the customer pays nothing.
 *
 * It is built on the EXISTING money functions only; no money function and no table changes:
 * 1. create: a mission of the customer (`created_by` = the admin) and an internal marker event (`counts.free_rerun = 1`, kind "call": never shown to the customer);
 * 2. approve (adminActions.approveFreeRerun): the ordinary approval holds the reserve from the customer's balance; when the balance is short, the reserve is
 *    granted first through `admin_grant_credit_atomic` (`counts.free_rerun_hold_grant`);
 * 3. compensate: after the settlement, what was charged (less any hold grant) is granted back through `admin_grant_credit_atomic`, with ONE request id per
 *    mission, so it is granted at most once whoever calls it (the worker right after the settlement, the admin page as a safety net).
 *
 * Net effect for the customer: never negative. Exactly zero when the balance covered the hold; when the hold had to be granted, they keep the unused part of it.
 */

export { FREE_RERUN_MARK, FREE_RERUN_HOLD_GRANT, FREE_RERUN_REFUND, isFreeRerunEvents, holdGrantOf, refundOf, refundDue } from "./freeRerunMark";
export const FREE_RERUN_MARK_AR = "علامة داخلية للمشرف: تشغيل مجاني لحساب العميل؛ يُعاد للعميل ما يُخصم عند التسوية.";
const MIN_TEXT = 3;
const MAX_TEXT = 4000;
const JOBS_TABLE = "jobs";

export type FreeRerunResult<T = Record<string, never>> = ({ ok: true } & T) | { ok: false; status: number; error: string };
const bad = (status: number, error: string): { ok: false; status: number; error: string } => ({ ok: false, status, error });
type EventRow = { counts?: Record<string, unknown> | null };

/** ONE request id per mission for each grant: `admin_grant_credit_atomic` grants a request id once. */
export const refundRequestId = (missionId: string): string => `free-rerun-${missionId}`;
export const holdRequestId = (missionId: string): string => `free-rerun-hold-${missionId}`;

export async function eventsOf(client: any, missionId: string): Promise<EventRow[]> {
  const { data } = await client.from(MISSION_EVENTS_TABLE).select("counts").eq("mission_id", missionId).eq("kind", "call");
  return Array.isArray(data) ? (data as EventRow[]) : [];
}

/**
 * Creates the free re-run: the customer's own mission with the text of one of their missions (or the admin's text), queued for the worker, and the marker.
 * The source must be the customer's (never another customer's, never an add-on row); the test account is not a customer.
 */
export async function createFreeRerun(client: any, input: { adminId: string; customerId: string; sourceMissionId?: string | null; text?: unknown }): Promise<FreeRerunResult<{ id: string; text: string }>> {
  const { data: profile } = await client.from("profiles").select("id,email").eq("id", input.customerId).maybeSingle();
  if (!profile?.id) return bad(404, "العميل غير موجود.");
  if (String(profile.email ?? "").toLowerCase() === AGENT_TEST_ACCOUNT_EMAIL) return bad(400, "حساب الاختبار ليس عميلًا؛ شغّل مهامه من صفحة «الوكيل».");
  let text = String(input.text ?? "").replace(/\s+/g, " ").trim();
  if (input.sourceMissionId) {
    if (!/^msn_[a-z0-9]{8,40}$/.test(input.sourceMissionId)) return bad(400, "رقم المهمة غير صالح.");
    const { data: source } = await client.from(MISSION_TABLE).select(`id,user_id,request_text,${ADDON_MARKER_COLUMN}`).eq("id", input.sourceMissionId).maybeSingle();
    if (!source || source.user_id !== input.customerId || hasAddonMarker(source)) return bad(404, "المهمة الأصلية ليست لهذا العميل.");
    if (!text) text = String(source.request_text ?? "").replace(/\s+/g, " ").trim();
  }
  if (text.length < MIN_TEXT) return bad(400, "اكتب نص الطلب أو اختر مهمة أصلية.");
  if (text.length > MAX_TEXT) return bad(400, "نص الطلب أطول من المسموح.");
  const id = `msn_${randomBytes(10).toString("hex")}`;
  const { error } = await client.from(MISSION_TABLE).insert({ id, user_id: input.customerId, created_by: input.adminId, request_text: text, status: "queued" });
  if (error) return bad(500, "تعذّر إنشاء المهمة.");
  const marked = await client.from(MISSION_EVENTS_TABLE).insert({ mission_id: id, kind: "call", message_ar: FREE_RERUN_MARK_AR, counts: { [FREE_RERUN_MARK]: 1 } });
  if (marked?.error) {
    // without the marker the mission would be an ordinary, paid one: it is cancelled before any worker plans it
    await client.from(MISSION_TABLE).update({ status: "cancelled", updated_at: new Date().toISOString() }).eq("id", id).eq("status", "queued");
    return bad(500, "تعذّر وسم المهمة كتشغيل مجاني؛ أُلغيت ولم يُحجز شيء.");
  }
  return { ok: true, id, text };
}

export type CompensationOutcome =
  | { status: "not_free" }
  | { status: "pending" }
  | { status: "nothing_due"; charged: number; holdGrant: number }
  | { status: "granted" | "already_granted"; points: number }
  | { status: "failed"; reason: string };

/**
 * GIVES BACK WHAT A FREE RE-RUN CHARGED, once. The charge is the settled job's (`jobs.charged_credits`), or the one the caller just settled. Granted in the name of the admin who
 * created the re-run (the database function checks that they are an admin). Never throws.
 */
export async function compensateFreeRerun(client: any, input: { missionId: string; chargedPoints?: number }): Promise<CompensationOutcome> {
  try {
    const { data: mission } = await client.from(MISSION_TABLE).select(`id,user_id,created_by,job_id,status,${ADDON_MARKER_COLUMN}`).eq("id", input.missionId).maybeSingle();
    if (!mission || hasAddonMarker(mission) || !mission.created_by || mission.created_by === mission.user_id) return { status: "not_free" };
    const events = await eventsOf(client, input.missionId);
    if (!isFreeRerunEvents(events)) return { status: "not_free" };
    let charged = typeof input.chargedPoints === "number" ? input.chargedPoints : null;
    if (charged === null) {
      if (!mission.job_id) return { status: "pending" };
      const { data: job } = await client.from(JOBS_TABLE).select("id,status,charged_credits").eq("id", mission.job_id).maybeSingle();
      // the charge is final only once the job is settled
      if (!job || !["completed", "failed", "refused"].includes(String(job.status))) return { status: "pending" };
      charged = Number(job.charged_credits ?? 0);
    }
    const holdGrant = holdGrantOf(events);
    const due = refundDue(charged, holdGrant);
    if (due <= 0) return { status: "nothing_due", charged, holdGrant };
    const r = await grantCreditAsAdmin(client, { adminId: String(mission.created_by), userId: String(mission.user_id), points: due, note: "تشغيل مجاني من فريق ديجر: أُعيد ما خُصم لطلبك.", requestId: refundRequestId(input.missionId) });
    if (!r.ok) return { status: "failed", reason: r.reason };
    if (!r.alreadyGranted) await client.from(MISSION_EVENTS_TABLE).insert({ mission_id: input.missionId, kind: "call", message_ar: "علامة داخلية للمشرف: أُعيد للعميل ما خُصم في التشغيل المجاني.", counts: { [FREE_RERUN_REFUND]: due } });
    return { status: r.alreadyGranted ? "already_granted" : "granted", points: due };
  } catch {
    return { status: "failed", reason: "exception" };
  }
}

export interface FreeRerunRow {
  id: string; status: string; requestAr: string; createdAt: string | null; summaryAr: string | null; questionAr: string | null;
  reservePoints: number | null; deliveredUnits: number | null; chargedPoints: number | null; holdGrant: number; refunded: number; files: string[];
}

/** The customer's free re-runs (newest first), with what the admin needs to approve them and to see that nothing was paid. */
export async function listFreeReruns(client: any, customerId: string): Promise<FreeRerunRow[]> {
  const { data } = await client.from(MISSION_TABLE).select(`id,status,request_text,created_at,created_by,user_id,summary_ar,question_ar,plan,delivered_units,charged_points,files,${ADDON_MARKER_COLUMN}`).eq("user_id", customerId).order("created_at", { ascending: false }).limit(30);
  const rows = (Array.isArray(data) ? data : []).filter((m: any) => !hasAddonMarker(m) && m.created_by && m.created_by !== m.user_id);
  const out: FreeRerunRow[] = [];
  for (const m of rows) {
    const events = await eventsOf(client, m.id);
    if (!isFreeRerunEvents(events)) continue;
    const reserve = Number(m.plan?.price?.reservePoints);
    out.push({
      id: m.id, status: String(m.status ?? ""), requestAr: String(m.request_text ?? "").slice(0, 200), createdAt: m.created_at ?? null,
      summaryAr: typeof m.plan?.summary_ar === "string" ? m.plan.summary_ar : typeof m.summary_ar === "string" ? m.summary_ar : null, questionAr: m.question_ar ?? null,
      reservePoints: Number.isFinite(reserve) ? reserve : null, deliveredUnits: m.delivered_units ?? null, chargedPoints: m.charged_points === null || m.charged_points === undefined ? null : Number(m.charged_points),
      holdGrant: holdGrantOf(events), refunded: refundOf(events),
      files: (Array.isArray(m.files) ? m.files : []).map((f: any) => String(f?.name ?? "")).filter((n: string) => /^result\.(xlsx|csv)$/.test(n)),
    });
  }
  return out;
}

/** Is this mission a free re-run of THIS customer? (Every admin action on a re-run checks it: a mission id of another customer, an ordinary mission or an add-on row is refused.) */
export async function isCustomersFreeRerun(client: any, input: { missionId: string; customerId: string }): Promise<boolean> {
  if (!/^msn_[a-z0-9]{8,40}$/.test(input.missionId)) return false;
  const { data: m } = await client.from(MISSION_TABLE).select(`id,user_id,created_by,${ADDON_MARKER_COLUMN}`).eq("id", input.missionId).maybeSingle();
  if (!m || hasAddonMarker(m) || m.user_id !== input.customerId || !m.created_by || m.created_by === m.user_id) return false;
  return isFreeRerunEvents(await eventsOf(client, input.missionId));
}

/** The customer's own missions the admin may run again (newest first; not add-on rows, not free re-runs themselves). */
export async function rerunSources(client: any, customerId: string): Promise<Array<{ id: string; status: string; requestAr: string; createdAt: string | null }>> {
  const { data } = await client.from(MISSION_TABLE).select(`id,status,request_text,created_at,created_by,user_id,${ADDON_MARKER_COLUMN}`).eq("user_id", customerId).order("created_at", { ascending: false }).limit(20);
  return (Array.isArray(data) ? data : [])
    .filter((m: any) => !hasAddonMarker(m) && m.created_by === m.user_id && String(m.request_text ?? "").trim().length >= MIN_TEXT)
    .map((m: any) => ({ id: String(m.id), status: String(m.status ?? ""), requestAr: String(m.request_text ?? "").slice(0, 200), createdAt: m.created_at ?? null }));
}

/** A free re-run is due a refund the worker may have missed (a settled run that charged more than was given back): the admin page grants it (same request id, so never twice). */
export const refundPending = (r: Pick<FreeRerunRow, "status" | "chargedPoints" | "holdGrant" | "refunded">): boolean =>
  ["completed", "failed", "unserved"].includes(r.status) && r.chargedPoints !== null && refundDue(r.chargedPoints, r.holdGrant) > r.refunded;
