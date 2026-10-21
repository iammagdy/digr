/**
 * The fake data provider for the PRESSURE TEST on a preview deployment. It exists so 500 virtual visitors can run whole missions
 * (sign-up, chat, plan, approval, chunks, results) without spending a cent on a real provider.
 *
 * It is on only when ALL of these hold, so it can never run on the live site or against the live database:
 *   - PRESSURE_FAKE_PROVIDER is exactly "on" (set by the owner on a PREVIEW deployment only);
 *   - VERCEL_ENV is "preview" (a production deployment, a local run and a build all fail this);
 *   - the database in NEXT_PUBLIC_SUPABASE_URL is not the production project.
 * Money is untouched: the ledger, the reserve, the settlement and the release run exactly as in production, on the test database.
 */
export const PRODUCTION_DATABASE_REF = "pfinlfaqwnytesedchik";

export function fakeProviderActive(env: Record<string, string | undefined> = process.env): boolean {
  if (env.PRESSURE_FAKE_PROVIDER !== "on") return false;
  if (env.VERCEL_ENV !== "preview") return false;
  if (String(env.NEXT_PUBLIC_SUPABASE_URL || "").includes(PRODUCTION_DATABASE_REF)) return false;
  return true;
}

/** Why the fake provider is off, in a sentence for a log line (never shown to a customer). */
export function fakeProviderOffReason(env: Record<string, string | undefined> = process.env): string | null {
  if (env.PRESSURE_FAKE_PROVIDER !== "on") return "flag_not_set";
  if (env.VERCEL_ENV !== "preview") return "not_a_preview_deployment";
  if (String(env.NEXT_PUBLIC_SUPABASE_URL || "").includes(PRODUCTION_DATABASE_REF)) return "production_database";
  return null;
}
