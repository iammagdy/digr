/**
 * Who may call send-email: the app, server to server, with a service-role key of THIS project.
 *
 * 1. Fast path (unchanged): the Authorization header is exactly `Bearer <the function's own SUPABASE_SERVICE_ROLE_KEY>`; no network call.
 * 2. Otherwise the bearer is verified by a real call: GET {SUPABASE_URL}/auth/v1/admin/users?per_page=1 with the bearer as apikey and
 *    Authorization. That endpoint answers 200 only to a service-level key of this project, in ANY key format (the legacy service_role JWT or
 *    an sb_secret_ key), so a valid key that is not the same string as the injected one is accepted. The body is discarded.
 * Anything else (another status, a timeout, a network error, a missing value) is NOT authorized: it fails closed. The key is never logged.
 */
export async function isAuthorizedCaller(
  authHeader: string,
  injectedKey: string,
  supabaseUrl: string,
  fetcher: typeof fetch = fetch,
  timeoutMs = 4000,
): Promise<boolean> {
  if (!injectedKey) return false;
  if (authHeader === `Bearer ${injectedKey}`) return true;

  const bearer = /^Bearer (\S+)$/.exec(authHeader)?.[1];
  const base = supabaseUrl.replace(/\/+$/, "");
  if (!bearer || !base) return false;
  try {
    const res = await fetcher(`${base}/auth/v1/admin/users?per_page=1`, {
      method: "GET",
      headers: { apikey: bearer, Authorization: `Bearer ${bearer}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    await res.body?.cancel().catch(() => undefined);
    return res.status === 200;
  } catch {
    return false;
  }
}
