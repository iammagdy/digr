import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * SUSPENDING A CUSTOMER ACCOUNT (DT-20261118-06 phase 1C, D-0094 point 1; Tier A). Two layers, both on the server:
 * 1. the sign-in service's own ban (`ban_duration`): no new sign-in and no token refresh for the account;
 * 2. every customer route checks the ban again with the service (`suspensionBlock` for every action that changes something: fresh lookup, fails closed; `isAccountSuspended` for reads), because a token the service issued before the ban is still read as valid locally
 *    until it expires (localClaims.ts): a suspended customer can start nothing, approve nothing and top up nothing from that moment on.
 * An admin can never suspend himself or another admin. Suspending does not cancel a running request and does not touch any hold or balance (the money code is not called).
 * This file never reads the requests table (the add-on fence, tests/money7e-isolation.test.ts): the dialog counts the running requests from the profile's own requests list.
 */

/** What the customer reads when a suspended account tries anything (customer text: Arabic only, no id). */
export const SUSPENDED_AR = "تم إيقاف هذا الحساب. للاستفسار تواصل مع الدعم.";

export type SuspendDuration = "7d" | "30d" | "indefinite";
/** The ban the sign-in service applies for each choice of the admin dialog («مدة الإيقاف»): ٧ أيام · ٣٠ يومًا · حتى أعيد التفعيل (100 years). */
export const BAN_DURATION: Record<SuspendDuration, string> = { "7d": "168h", "30d": "720h", indefinite: "876000h" };

export type SuspendInput = { action: "suspend"; duration: SuspendDuration; reason: string } | { action: "reactivate"; reason: string };

/** Reads the admin dialog's request: an action, a duration for a suspension, and a reason of 3 to 300 characters (it goes to the audit log). */
export function parseSuspendInput(body: unknown): { ok: true; input: SuspendInput } | { ok: false; errorAr: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const reason = String(b.reason ?? "").trim();
  if (reason.length < 3 || reason.length > 300) return { ok: false, errorAr: "اكتب سبب الإجراء (٣ أحرف على الأقل)." };
  if (b.action === "reactivate") return { ok: true, input: { action: "reactivate", reason } };
  if (b.action !== "suspend") return { ok: false, errorAr: "إجراء غير معروف." };
  const duration = b.duration;
  if (duration !== "7d" && duration !== "30d" && duration !== "indefinite") return { ok: false, errorAr: "اختر مدة الإيقاف." };
  return { ok: true, input: { action: "suspend", duration, reason } };
}

/** When the account's ban ends (ms), or null when it is not banned: the sign-in service's `banned_until`. */
export function bannedUntilOf(user: { banned_until?: string | null } | null | undefined): number | null {
  const raw = user?.banned_until;
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : null;
}

export type SuspendOutcome =
  | { ok: true; suspended: boolean; bannedUntil: string | null }
  | { ok: false; reason: "self" | "admin_target" | "not_found" | "failed"; messageAr: string; status: number };

/** Suspends or reactivates one account. Never the admin's own account, never another admin. The reason is written by the route to the audit log, not to the account. */
export async function setAccountSuspension(admin: SupabaseClient, input: SuspendInput & { adminId: string; userId: string }, now = Date.now()): Promise<SuspendOutcome> {
  if (input.userId === input.adminId) return { ok: false, reason: "self", messageAr: "لا يمكنك إيقاف حسابك أنت.", status: 400 };
  const found = await admin.auth.admin.getUserById(input.userId).catch(() => null);
  const user = found?.data?.user ?? null;
  if (!user) return { ok: false, reason: "not_found", messageAr: "الحساب غير موجود.", status: 404 };
  if ((user.app_metadata as Record<string, unknown> | undefined)?.role === "admin") return { ok: false, reason: "admin_target", messageAr: "لا يمكن إيقاف حساب مسؤول.", status: 400 };
  const suspend = input.action === "suspend";
  const appMetadata = { ...(user.app_metadata ?? {}), suspended: suspend ? { at: new Date(now).toISOString(), by: input.adminId, duration: input.duration } : null };
  const updated = await admin.auth.admin.updateUserById(input.userId, { ban_duration: suspend ? BAN_DURATION[input.duration] : "none", app_metadata: appMetadata }).catch(() => null);
  if (!updated || updated.error || !updated.data?.user) return { ok: false, reason: "failed", messageAr: "تعذّر تنفيذ الإجراء الآن. أعد المحاولة.", status: 500 };
  forgetSuspension(input.userId);
  const until = bannedUntilOf(updated.data.user as { banned_until?: string | null });
  return { ok: true, suspended: until !== null && until > now, bannedUntil: until !== null && until > now ? new Date(until).toISOString() : null };
}

/** A short memory per server instance, so a busy customer is not checked with the sign-in service on every READ request; a suspension or reactivation through this file clears it at once (on this instance only). */
const CACHE_MS = 30_000;
const cache = new Map<string, { until: number | null; checkedAt: number }>();
export function forgetSuspension(userId?: string): void {
  if (userId === undefined) cache.clear(); else cache.delete(userId);
}

export type SuspensionVerdict = "suspended" | "active" | "unknown";

/**
 * What the sign-in service says about the ban: «suspended», «active», or «unknown» (the service could not be asked: it answered {error}, no user, or threw; an unknown answer is never remembered).
 * A user object that already carries a future `banned_until` is suspended without a call. `fresh` skips the memory above and always asks the service (the memory of ANOTHER server instance can
 * be up to 30 s behind a suspension: QA FAIL at 6af74613); the fresh answer is then remembered like any other.
 */
export async function suspensionVerdict(admin: () => SupabaseClient, userId: string, user?: { banned_until?: string | null } | null, opts: { fresh?: boolean; now?: number } = {}): Promise<SuspensionVerdict> {
  const now = opts.now ?? Date.now();
  const own = bannedUntilOf(user);
  if (own !== null && own > now) return "suspended";
  if (opts.fresh !== true) {
    const hit = cache.get(userId);
    if (hit && now - hit.checkedAt < CACHE_MS) return hit.until !== null && hit.until > now ? "suspended" : "active";
  }
  try {
    const found = await admin().auth.admin.getUserById(userId);
    // the service answers an outage with {error} rather than throwing: that is «not known», never remembered (Gate 1: it was cached as «not suspended» for 30 s)
    if (found?.error || !found?.data?.user) return "unknown";
    const until = bannedUntilOf(found.data.user as { banned_until?: string | null });
    cache.set(userId, { until, checkedAt: now });
    return until !== null && until > now ? "suspended" : "active";
  } catch {
    return "unknown";
  }
}

/**
 * Is this account suspended now? For READ paths (a list, a page, a file): the short memory is used and, when the service cannot be asked, the answer is «not suspended» (the ban in the
 * sign-in service still holds sign-in and refresh), so an outage never locks every customer out of reading.
 */
export async function isAccountSuspended(admin: () => SupabaseClient, userId: string, user?: { banned_until?: string | null } | null, now = Date.now()): Promise<boolean> {
  return (await suspensionVerdict(admin, userId, user, { now })) === "suspended";
}

/** What the customer reads when the ban cannot be checked right now (a retryable, temporary error: customer text, Arabic only, no id). */
export const SUSPENSION_UNKNOWN_AR = "تعذّر التأكد من حالة حسابك الآن. حاول مرة أخرى بعد قليل.";

/** A request that changes something (POST, PUT, PATCH, DELETE) is a sensitive action; a read (GET, HEAD, OPTIONS) is not. */
export const isSensitiveMethod = (method: string | null | undefined): boolean => !/^(GET|HEAD|OPTIONS)$/i.test(String(method ?? "POST"));

/**
 * The guard of every customer action that spends points or changes the customer's data (DT-20261118-06 fix push, QA FAIL at 6af74613): the ban is asked of the sign-in service EVERY time
 * (never the 30 s memory, which another instance's suspension can leave stale) and the guard FAILS CLOSED: a suspended account gets 403 and the suspended sentence; when the ban cannot be
 * established the action is refused with a temporary 503 (the retryable sentence, never the suspended one) and nothing is charged or changed. Read paths keep `isAccountSuspended`.
 * Returns null when the account may go on.
 */
export async function suspensionBlock(admin: () => SupabaseClient, user: { id: string; banned_until?: string | null }, extra: Record<string, unknown> = {}): Promise<NextResponse | null> {
  const verdict = await suspensionVerdict(admin, user.id, user, { fresh: true });
  if (verdict === "suspended") return suspendedResponse(extra);
  if (verdict === "unknown") return suspensionUnknownResponse(extra);
  return null;
}

/** The customer routes' answer for a suspended account: 403 with the customer sentence. */
export function suspendedResponse(extra: Record<string, unknown> = {}): NextResponse {
  return NextResponse.json({ success: false, ...extra, error: SUSPENDED_AR, suspended: true }, { status: 403 });
}

/** The customer routes' answer when the ban cannot be checked: 503, retryable, never the suspended sentence. */
export function suspensionUnknownResponse(extra: Record<string, unknown> = {}): NextResponse {
  return NextResponse.json({ success: false, ...extra, error: SUSPENSION_UNKNOWN_AR, retryable: true }, { status: 503, headers: { "Retry-After": "5" } });
}
