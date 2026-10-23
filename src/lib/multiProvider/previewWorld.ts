/**
 * The fake provider world of the multi-provider feature, for a PREVIEW deployment on a TEST database: the flag-on path can then be
 * walked end to end (plan, router, quote, approval, chunks, results) without a real key or a real call. At plan time the worker is not
 * involved, so this module answers the same question the worker's own switch answers, with the same three conditions:
 *   - PRESSURE_FAKE_PROVIDER is exactly "on";
 *   - VERCEL_ENV is "preview" (a production deployment, a local run and a build all fail this);
 *   - the database is not the live project.
 * A live deployment can never satisfy it. In this world the router sees every provider as ready with a small daily limit, and the
 * call recorder uses that limit only where the admin has set none: nothing is ever unbounded.
 */
const LIVE_DATABASE_REF = "pfinlfaqwnytesedchik";

export const PREVIEW_WORLD_DAILY_CAP_USD = 1;

export function previewWorldActive(env: Record<string, string | undefined> = process.env): boolean {
  if (env.PRESSURE_FAKE_PROVIDER !== "on") return false;
  if (env.VERCEL_ENV !== "preview") return false;
  if (String(env.NEXT_PUBLIC_SUPABASE_URL || "").includes(LIVE_DATABASE_REF)) return false;
  return true;
}
