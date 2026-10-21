/**
 * Fewer calls to the sign-in service. Every `auth.getUser()` is a request to the service's `/user` endpoint. That is a cost in speed and in
 * the server's own load, not a sign-up limit: the service's rate limit on `/user` applies to e-mail-address changes, so plain checks are
 * not in the sign-up and sign-in bucket (corrected 2026-10-21, see docs/SUPABASE_FREE_PLAN.md section 1). A server that asks on every
 * page and every API call (the middleware and then the route) still pays a round trip each time.
 *
 * With `AUTH_LOCAL_CLAIMS=on` the server reads the signed token locally (`getClaims`: the project's public signing keys, cached, no
 * request per call) and only asks the service when the token cannot be read locally (an expired token, a project that still signs
 * with a shared secret, an unreadable token). The answer for a bad token is therefore the same as before: the service judges it.
 *
 * Default OFF: the owner turns it on after checking Authentication > JWT Signing Keys (an asymmetric key in use). Off, nothing changes.
 * A token that the service has already revoked (a deleted or banned account) still reads as valid here until it expires (at most the
 * token lifetime, one hour by default); money routes keep their own server-side checks.
 */

export function localClaimsEnabled(): boolean {
  return process.env.AUTH_LOCAL_CLAIMS === "on";
}

/** The fields the server reads from a user (id, e-mail, roles, metadata, verified e-mail), rebuilt from the token's claims. */
export function userFromClaims(claims: Record<string, any>): Record<string, any> {
  const metadata = claims.user_metadata && typeof claims.user_metadata === "object" ? claims.user_metadata : {};
  const issuedAt = typeof claims.iat === "number" ? new Date(claims.iat * 1000).toISOString() : undefined;
  return {
    id: String(claims.sub),
    aud: claims.aud,
    role: claims.role,
    email: claims.email,
    phone: claims.phone,
    is_anonymous: Boolean(claims.is_anonymous),
    app_metadata: claims.app_metadata && typeof claims.app_metadata === "object" ? claims.app_metadata : {},
    user_metadata: metadata,
    // The token does not carry the confirmation time; the confirmed flag in the metadata is what the server already accepts.
    email_confirmed_at: metadata.email_verified === true ? issuedAt : undefined,
    created_at: undefined,
  };
}

/**
 * Wraps `client.auth.getUser` so a readable token is answered locally. Idempotent; a client without `getClaims` (a test double, an old
 * library) is left alone.
 */
export function withLocalClaims<T extends { auth?: any }>(client: T): T {
  if (!localClaimsEnabled()) return client;
  const auth = client?.auth;
  if (!auth || typeof auth.getClaims !== "function" || typeof auth.getUser !== "function" || auth.__localClaims) return client;
  const original = auth.getUser.bind(auth);
  auth.getUser = async (jwt?: string) => {
    try {
      const { data, error } = await auth.getClaims(jwt);
      const claims = data?.claims;
      if (!error && claims && typeof claims.sub === "string" && claims.sub) {
        return { data: { user: userFromClaims(claims) }, error: null };
      }
    } catch {
      // fall through: the service decides
    }
    return original(jwt);
  };
  auth.__localClaims = true;
  return client;
}
