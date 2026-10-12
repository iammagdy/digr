/** Canonical public origin. Set NEXT_PUBLIC_SITE_URL on the production Site; it falls back to the main domain. */
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL || "https://diger.tech").replace(/\/+$/, "");
export const SITE_HOST = new URL(SITE_URL).hostname;
export const SITE_NAME = "Digr";
export const SUPPORT_EMAIL = process.env.NEXT_PUBLIC_SUPPORT_EMAIL || "support@diger.tech";

/**
 * Origin used inside e-mailed links (verification, password recovery). Appwrite only accepts hosts that are
 * registered as Web platforms, so production pins it with NEXT_PUBLIC_SITE_URL; previews and localhost fall back
 * to the origin the visitor is on.
 */
export function appBaseUrl(): string {
  const pinned = process.env.NEXT_PUBLIC_SITE_URL;
  if (pinned && typeof window !== "undefined" && window.location.hostname.endsWith(SITE_HOST)) return SITE_URL;
  return typeof window !== "undefined" ? window.location.origin : SITE_URL;
}
