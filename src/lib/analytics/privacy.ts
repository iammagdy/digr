/**
 * What a visit record may keep, and what is thrown away before anything is stored. Pure and shared by the page beacon (which sends only these shapes) and
 * the server route (which checks them again): the server never trusts the page.
 *
 * Kept: a path with no query and no identifier, the host of the referring site, a two-letter country from the hosting platform's own header, a device class
 * and the anonymous visitor / session ids. Never kept: the IP address, the full user agent (the device class is read from it and it is dropped), a fingerprint,
 * a query string, a request body, chat text, an e-mail address or a token.
 */

export type DeviceClass = "mobile" | "tablet" | "desktop";
export type VisitKind = "view" | "leave" | "login" | "signup";

export const VISIT_KINDS: readonly VisitKind[] = ["view", "leave", "login", "signup"];
export const MAX_PATH_CHARS = 120;
export const MAX_REFERRER_HOST_CHARS = 100;
export const MAX_DURATION_SECONDS = 86_400;
/** The visitor's anonymous id: 32 hex characters, set by the server in a first-party cookie. The session id is made by the page (16 to 32 hex characters). */
export const VISITOR_ID_RE = /^[a-f0-9]{32}$/;
export const SESSION_ID_RE = /^[a-f0-9]{16,32}$/;

/** Pages that are never tracked: the admin area, the API, the framework's own files and the sign-in callbacks. */
export function isExcludedPath(rawPath: string): boolean {
  const path = String(rawPath || "").split(/[?#]/)[0];
  return /^\/(?:admin|api|_next|auth)(?:\/|$)/i.test(path);
}

/** A path as it is stored: no query, no fragment, no identifier (a long hex or numeric segment, a UUID, a referral or share code), at most 120 characters. */
export function sanitizePath(raw: unknown): string {
  const text = String(raw ?? "").split(/[?#]/)[0].trim();
  if (!text.startsWith("/")) return "/";
  const segments = text.split("/").filter(Boolean).map((segment, index, all) => {
    let decoded = segment;
    try { decoded = decodeURIComponent(segment); } catch { /* keep the raw segment */ }
    // «/join/CONF26»: the code after a referral path is a private code, never a page name.
    if (index > 0 && /^join$/i.test(all[index - 1])) return ":code";
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(decoded)) return ":id";
    if (/^\d{4,}$/.test(decoded)) return ":id";
    if (/^[A-Za-z0-9_-]{20,}$/.test(decoded)) return ":id";
    return decoded.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 60);
  });
  const path = `/${segments.join("/")}`;
  return path.slice(0, MAX_PATH_CHARS) || "/";
}

/** The host of the page that sent the visitor here, or null: a link from the site itself, a malformed value and a host that is not a plain hostname are dropped. */
export function referrerHostOf(rawReferrer: unknown, ownHost?: string | null): string | null {
  const text = String(rawReferrer ?? "").trim();
  if (!text) return null;
  let host = "";
  try {
    host = new URL(text).hostname.toLowerCase();
  } catch {
    host = text.toLowerCase();
  }
  host = host.replace(/^www\./, "");
  if (!/^[a-z0-9.-]{1,100}$/.test(host) || !host.includes(".")) return null;
  const own = String(ownHost ?? "").toLowerCase().replace(/^www\./, "").split(":")[0];
  if (own && (host === own || host.endsWith(`.${own}`))) return null;
  return host.slice(0, MAX_REFERRER_HOST_CHARS);
}

/** The device class from the user agent. The agent itself is not kept by the caller. */
export function deviceClassOf(userAgent: unknown): DeviceClass {
  const ua = String(userAgent ?? "");
  if (/ipad|tablet|playbook|silk|kindle/i.test(ua) || (/android/i.test(ua) && !/mobile/i.test(ua))) return "tablet";
  if (/mobi|iphone|ipod|android|windows phone|blackberry|opera mini/i.test(ua)) return "mobile";
  return "desktop";
}

/** Crawlers, link previews, monitors, scripted clients and headless browsers: never counted. An empty agent is not a person either. */
const BOT_RE = /bot\b|crawl|spider|slurp|scrape|headless|phantom|lighthouse|pagespeed|gtmetrix|pingdom|uptime|monitor|preview|facebookexternalhit|whatsapp|telegram|discord|slack|curl\/|wget\/|python|requests|aiohttp|httpclient|java\/|okhttp|go-http|libwww|node-fetch|axios|postman|insomnia|vercel|chrome-lighthouse|bingpreview|yandex|baidu|duckduck|ahrefs|semrush|mj12|dotbot/i;
export function isBotUserAgent(userAgent: unknown): boolean {
  const ua = String(userAgent ?? "").trim();
  return ua.length < 8 || BOT_RE.test(ua);
}

/** The visitor asked not to be tracked («Do Not Track», or «Global Privacy Control»). */
export function respectsDoNotTrack(headers: { get(name: string): string | null }): boolean {
  return headers.get("dnt") === "1" || headers.get("sec-gpc") === "1";
}

/** The two-letter country the hosting platform put in its own header; anything else is unknown. */
export function countryOf(headers: { get(name: string): string | null }): string | null {
  const value = String(headers.get("x-vercel-ip-country") ?? "").trim().toUpperCase();
  return /^[A-Z]{2}$/.test(value) && value !== "XX" ? value : null;
}

export const clampDuration = (value: unknown): number | null => {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 0 ? Math.min(n, MAX_DURATION_SECONDS) : null;
};
