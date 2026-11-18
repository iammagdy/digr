import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * SUSPENDING A CUSTOMER ACCOUNT (DT-20261118-06 phase 1C, D-0094 point 1; Tier A). Two layers, both on the server:
 * 1. the sign-in service's own ban (`ban_duration`): no new sign-in and no token refresh for the account;
 * 2. every customer route checks the ban again with the service (`isAccountSuspended`), because a token the service issued before the ban is still read as valid locally
 *    until it expires (localClaims.ts): a suspended customer can start nothing, approve nothing and top up nothing from that moment on.
 * An admin can never suspend himself or another admin. Suspending does not cancel a running request and does not touch any hold or balance (the money code is not called).
 * This file never reads the requests table (the add-on fence, tests/money7e-isolation.test.ts): the dialog counts the running requests from the profile's own requests list.
 */

/** What the customer reads when a suspended account tries anything (customer text: Arabic only, no id). */
export const SUSPENDED_AR = "تم إيقاف هذا الحساب مؤقتًا. للاستفسار تواصل مع الدعم.";

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

/** A short memory per server instance, so a busy customer is not checked with the sign-in service on every request; a suspension or reactivation through this file clears it at once. */
const CACHE_MS = 30_000;
const cache = new Map<string, { until: number | null; checkedAt: number }>();
export function forgetSuspension(userId?: string): void {
  if (userId === undefined) cache.clear(); else cache.delete(userId);
}

/**
 * Is this account suspended now? Asks the sign-in service (the token alone cannot say: a token issued before the ban stays readable until it expires). A user object that already
 * carries `banned_until` from the service answers without a call. When the service cannot be asked the answer is «not suspended» (the ban in the sign-in service still holds), so an
 * outage never locks every customer out.
 */
export async function isAccountSuspended(admin: () => SupabaseClient, userId: string, user?: { banned_until?: string | null } | null, now = Date.now()): Promise<boolean> {
  const own = bannedUntilOf(user);
  if (own !== null && own > now) return true;
  const hit = cache.get(userId);
  if (hit && now - hit.checkedAt < CACHE_MS) return hit.until !== null && hit.until > now;
  try {
    const found = await admin().auth.admin.getUserById(userId);
    const until = bannedUntilOf(found?.data?.user as { banned_until?: string | null } | undefined);
    cache.set(userId, { until, checkedAt: now });
    return until !== null && until > now;
  } catch {
    return false;
  }
}

/** The customer routes' answer for a suspended account: 403 with the customer sentence. */
export function suspendedResponse(extra: Record<string, unknown> = {}): NextResponse {
  return NextResponse.json({ success: false, ...extra, error: SUSPENDED_AR, suspended: true }, { status: 403 });
}
