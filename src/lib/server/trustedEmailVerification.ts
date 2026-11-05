/**
 * Who may approve or pay: only an e-mail that the SIGN-IN SERVICE itself marked as confirmed.
 *
 * `user.user_metadata` is writable by the signed-in customer (`supabase.auth.updateUser({ data })`), so a flag such as
 * `user_metadata.email_verified` proves nothing and must never authorize points, approval or a top-up. The service sets
 * `email_confirmed_at` (a server-owned column) when the customer clicks the link; the customer cannot write it.
 *
 * With `AUTH_LOCAL_CLAIMS=on` the server rebuilds the user from the token locally (`userFromClaims`). That rebuilt user carries no
 * trusted confirmation time (the token does not carry it), so it is marked `__localClaims` and the confirmation is asked from the
 * service itself (`auth.getUserFromService`, the unwrapped `getUser`) for the call that needs it.
 */

export interface AuthUserLike {
  email_confirmed_at?: string | null;
  confirmed_at?: string | null;
  __localClaims?: boolean;
}

/** True only for a user object that came from the service itself AND carries a confirmation time. Never reads `user_metadata`. */
export function isEmailConfirmedByAuth(user: AuthUserLike | null | undefined): boolean {
  if (!user || user.__localClaims) return false;
  return Boolean(user.email_confirmed_at || user.confirmed_at);
}

/**
 * Trusted verification for a user that may have been rebuilt from local claims. For a locally rebuilt user the service is asked once;
 * if the service cannot answer, the answer is «not verified» (never a guess).
 */
export async function resolveTrustedEmailVerified(supabase: { auth?: any } | null | undefined, user: AuthUserLike | null | undefined, token?: string): Promise<boolean> {
  if (!user) return false;
  if (!user.__localClaims) return isEmailConfirmedByAuth(user);
  const fromService = supabase?.auth?.getUserFromService;
  if (typeof fromService !== "function") return false;
  try {
    const { data, error } = await fromService(token);
    if (error || !data?.user) return false;
    return isEmailConfirmedByAuth(data.user);
  } catch {
    return false;
  }
}
