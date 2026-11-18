import { formatAr, normalizeDigits } from "@/lib/arabicDigits";
import type { BadgeTone } from "./ui";

/**
 * THE PROFILE'S BEHAVIOUR (DT-20261118-06 phase 1B, spec §5.3-§5.4), kept out of the markup so it is tested without a browser.
 * A money or account action never fires from one tap: the grant is reviewed, then confirmed, then posted ONCE with one requestId (the credit route and its
 * idempotency are unchanged); the suspension is posted once with the suspend route's own body.
 */

export type UserTab = "summary" | "balance" | "missions" | "topups" | "messages" | "actions";
export const USER_TABS: Array<[UserTab, string]> = [["summary", "ملخص"], ["balance", "الرصيد"], ["missions", "المهام"], ["topups", "الشحن"], ["messages", "الرسائل"], ["actions", "إجراءات"]];

/** A row of GET /api/admin/users/[id]/missions. */
export interface UserMissionItem { id: string; created_at: string | null; status: string; request: string; delivered: number | null; asked: number; charged_points: number | null }

/** «نشط الآن»: signed in during the last hour; «خامل»: no sign-in in 30 days (the list's «خاملون ٣٠ يومًا»). */
export const ACTIVE_NOW_MS = 60 * 60 * 1000;
export const IDLE_MS = 30 * 24 * 60 * 60 * 1000;
export function userBadges(input: { lastLogin: string | null; suspended: boolean; verified: boolean; now?: number }): Array<{ tone: BadgeTone; label: string }> {
  const now = input.now ?? Date.now();
  const at = input.lastLogin ? Date.parse(input.lastLogin) : NaN;
  const out: Array<{ tone: BadgeTone; label: string }> = [];
  if (input.suspended) out.push({ tone: "bad", label: "موقوف" });
  if (Number.isFinite(at) && now - at <= ACTIVE_NOW_MS) out.push({ tone: "ok", label: "نشط الآن" });
  else if (!Number.isFinite(at) || now - at > IDLE_MS) out.push({ tone: "mute", label: "خامل" });
  if (input.verified) out.push({ tone: "gold", label: "حساب أعمال موثّق" });
  return out;
}

/** The worker holds a mission in these two (the overview counts the same two as running). */
export const RUNNING_MISSION_STATUSES = ["planning", "executing"];
export const runningMissionsCount = (rows: ReadonlyArray<{ status: string }>): number => rows.filter((r) => RUNNING_MISSION_STATUSES.includes(r.status)).length;
/** What the suspension does not change, said in the dialog (spec §5.4). */
export const runningNoteAr = (n: number): string => `لدى العميل ${formatAr(n)} مهام قيد التنفيذ؛ الإيقاف لا يلغيها ولا يلمس أي حجز.`;

export const MISSION_STATUS_AR: Record<string, string> = {
  queued: "في الانتظار", planning: "يخطّط", needs_input: "ينتظر إجابة العميل", plan_ready: "الخطة جاهزة", approved: "معتمدة", executing: "قيد التنفيذ",
  completed: "اكتملت", failed: "تعذّرت", unserved: "لا يمكن خدمتها", cancelled: "أُلغيت",
};
export const missionStatusTone = (status: string): BadgeTone =>
  status === "completed" ? "ok" : status === "failed" ? "bad" : RUNNING_MISSION_STATUSES.includes(status) || status === "approved" ? "warn" : "mute";

/* ── grant ── */

export interface GrantBody { points: string; note: string; requestId: string }
export type GrantResult = { ok: true; messageAr: string } | { ok: false; errorAr: string };

export const newRequestId = (): string => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `req-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);

/**
 * The grant: review (checks the form, posts nothing) → confirm (posts once; a second tap while it runs gets the same answer) or cancel (nothing changes).
 * The requestId is renewed only after a grant succeeded, so a retry after a failure can never grant twice (the route's idempotency key).
 */
export function createGrantFlow(deps: { post: (body: GrantBody) => Promise<{ messageAr: string }>; newId: () => string }) {
  let requestId = deps.newId();
  let pending: GrantBody | null = null;
  let inFlight: Promise<GrantResult> | null = null;
  return {
    get pending() { return pending; },
    review(points: string, note: string): { ok: true; body: GrantBody } | { ok: false; errorAr: string } {
      const n = normalizeDigits(points).trim();
      if (!/^\d+$/.test(n) || Number(n) <= 0) return { ok: false, errorAr: "اكتب عدد النقاط (رقم صحيح أكبر من صفر)." };
      if (note.trim().length < 3) return { ok: false, errorAr: "اكتب السبب (٣ أحرف على الأقل)." };
      pending = { points: n, note: note.trim(), requestId };
      return { ok: true, body: pending };
    },
    cancel() { if (!inFlight) pending = null; },
    confirm(): Promise<GrantResult> | null {
      if (inFlight) return inFlight;
      if (!pending) return null;
      const body = pending;
      inFlight = deps.post(body).then(
        (r): GrantResult => { requestId = deps.newId(); pending = null; return { ok: true, messageAr: r.messageAr }; },
        (e): GrantResult => ({ ok: false, errorAr: e instanceof Error && e.message ? e.message : "تعذرت إضافة الرصيد" }),
      ).finally(() => { inFlight = null; });
      return inFlight;
    },
  };
}

/* ── suspend ── */

export type SuspendDuration = "7d" | "30d" | "indefinite";
export const SUSPEND_DURATIONS: Array<[SuspendDuration, string]> = [["7d", "٧ أيام"], ["30d", "٣٠ يومًا"], ["indefinite", "حتى أعيد التفعيل"]];
export type SuspendBody = { action: "suspend"; duration: SuspendDuration; reason: string } | { action: "reactivate"; reason: string };
export type SuspendResult = { ok: true; suspended: boolean; bannedUntil: string | null } | { ok: false; errorAr: string };

/** The suspend route's state for this profile: null hides the action (the admin's own account, or the state could not be read). */
export function suspendControlOf(state: { suspended: boolean; self: boolean } | null): { suspended: boolean } | null {
  if (!state || state.self) return null;
  return { suspended: state.suspended };
}

/** Checks the dialog (the route's own rules and sentences) and posts it once; a second tap while it runs gets the same answer. */
export function createSuspendFlow(post: (body: SuspendBody) => Promise<{ suspended: boolean; bannedUntil: string | null }>) {
  let inFlight: Promise<SuspendResult> | null = null;
  return {
    submit(input: SuspendBody): Promise<SuspendResult> {
      if (inFlight) return inFlight;
      const reason = input.reason.trim();
      if (reason.length < 3 || reason.length > 300) return Promise.resolve({ ok: false, errorAr: "اكتب سبب الإجراء (٣ أحرف على الأقل)." });
      let body: SuspendBody;
      if (input.action === "reactivate") body = { action: "reactivate", reason };
      else if (SUSPEND_DURATIONS.some(([d]) => d === input.duration)) body = { action: "suspend", duration: input.duration, reason };
      else return Promise.resolve({ ok: false, errorAr: "اختر مدة الإيقاف." });
      inFlight = post(body).then(
        (r): SuspendResult => ({ ok: true, suspended: r.suspended, bannedUntil: r.bannedUntil }),
        (e): SuspendResult => ({ ok: false, errorAr: e instanceof Error && e.message ? e.message : "تعذّر تنفيذ الإجراء الآن. أعد المحاولة." }),
      ).finally(() => { inFlight = null; });
      return inFlight;
    },
  };
}
