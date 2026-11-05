/**
 * Who a `guest_session_id` cookie is allowed to name.
 *
 * The cookie is chosen by the browser, so it must never be enough to act as, take over, or delete a real account.
 * A cookie of the form `gst_<uuid>` is honoured ONLY when that user id belongs to a disposable guest account that
 * Diger created itself: the metadata mark, the generated guest address AND an unconfirmed address must all hold.
 * `user_metadata` is customer-writable (anyone can sign up with `is_guest: true`), so the mark alone proves nothing;
 * a confirmed address can only belong to a real customer.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The address `/api/chat` generates for a guest: guest_ + 32 hex digits. */
export const GUEST_EMAIL_RE = /^guest_[0-9a-f]{32}@diger\.tech$/i;

export type GuestAccountLike = {
  email?: string | null;
  email_confirmed_at?: string | null;
  user_metadata?: { is_guest?: unknown } | null;
} | null | undefined;

type AdminLike = { auth?: { admin?: { getUserById?: (id: string) => Promise<{ data?: { user?: (GuestAccountLike & { id?: string }) | null } | null }> } } } | null | undefined;

/** True only for an account Diger itself made as a throw-away guest. */
export function isDisposableGuestAccount(user: GuestAccountLike): boolean {
  if (!user) return false;
  if (user.user_metadata?.is_guest !== true) return false;
  if (user.email_confirmed_at) return false;
  return typeof user.email === "string" && GUEST_EMAIL_RE.test(user.email);
}

/** The user id a `gst_<uuid>` cookie names, or null when the cookie is not of that form. */
export function guestUuidOfCookie(cookie: string | null | undefined): string | null {
  if (typeof cookie !== "string" || !cookie.startsWith("gst_")) return null;
  const candidate = cookie.slice(4);
  return UUID_RE.test(candidate) ? candidate : null;
}

/**
 * The id of the existing disposable guest account a cookie names, or null.
 * Null for: a cookie that is not `gst_<uuid>`, an unknown id, a REAL customer's id, a lookup failure.
 * With no admin lookup at all (only the in-memory fakes of the test-suite have none) the id is returned as before.
 */
export async function ownGuestAccountId(admin: AdminLike, cookie: string | null | undefined): Promise<string | null> {
  const uuid = guestUuidOfCookie(cookie);
  if (!uuid) return null;
  const lookup = admin?.auth?.admin?.getUserById;
  if (typeof lookup !== "function") return uuid;
  try {
    const { data } = await lookup.call(admin!.auth!.admin, uuid);
    const user = data?.user;
    return user?.id === uuid && isDisposableGuestAccount(user) ? uuid : null;
  } catch {
    return null;
  }
}
