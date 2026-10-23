/**
 * The safety switch of the multi-provider feature. OFF unless the environment variable is exactly "true": with the flag off no
 * code path of this feature runs (no extra capability in the catalog, no router, no extra provider call), so behaviour is the
 * behaviour of the code before the feature existed.
 */
export const MULTI_PROVIDER_FLAG_ENV = "MULTI_PROVIDER_ENABLED";

export function multiProviderEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return String(env[MULTI_PROVIDER_FLAG_ENV] ?? "").trim().toLowerCase() === "true";
}
