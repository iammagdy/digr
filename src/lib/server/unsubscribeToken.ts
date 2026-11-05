import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * One-click unsubscribe token (RFC 8058). The token is `<base64url(userId)>.<base64url(HMAC-SHA256)>` where the MAC is computed over
 * `unsubscribe:v1:<userId>` with the server secret SUPABASE_SERVICE_ROLE_KEY (no new environment variable). It carries the user id, so the
 * unsubscribe endpoint needs no lookup table, and nobody without the server secret can build a link for another account. The token never
 * expires on purpose: a mail from last year must still unsubscribe. It can only switch the `news` preference OFF.
 * Server-only: the key never leaves the server and is never logged.
 */
const PREFIX = "unsubscribe:v1:";
/** What a Supabase user id looks like (a UUID); anything else is refused before any MAC is computed. */
const USER_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;

const b64url = (buf: Buffer): string => buf.toString("base64url");

function mac(userId: string, key: string): Buffer {
  return createHmac("sha256", key).update(`${PREFIX}${userId}`).digest();
}

/** The server secret the app signs with (read lazily so a test can set it). */
export function unsubscribeKeyFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return String(env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
}

export function signUnsubscribeToken(userId: string, key: string): string {
  if (!key) throw new Error("unsubscribe_key_missing");
  if (!USER_ID_RE.test(userId)) throw new Error("unsubscribe_user_id_invalid");
  return `${b64url(Buffer.from(userId, "utf8"))}.${b64url(mac(userId, key))}`;
}

/** The user id a token was issued for, or null for anything that is not a valid token for this key (malformed, tampered, wrong key). Constant-time MAC comparison. */
export function verifyUnsubscribeToken(token: unknown, key: string): string | null {
  if (!key || typeof token !== "string" || token.length > 512) return null;
  const parts = token.split(".");
  if (parts.length !== 2 || !B64URL_RE.test(parts[0]) || !B64URL_RE.test(parts[1])) return null;
  let userId: string;
  try {
    userId = Buffer.from(parts[0], "base64url").toString("utf8");
  } catch {
    return null;
  }
  if (!USER_ID_RE.test(userId)) return null;
  const given = Buffer.from(parts[1], "base64url");
  const expected = mac(userId, key);
  if (given.length !== expected.length) return null;
  return timingSafeEqual(given, expected) ? userId : null;
}

/** `<site>/api/email/unsubscribe?t=<token>`: the link in the mail footer and in the List-Unsubscribe header. */
export function buildUnsubscribeUrl(siteUrl: string, userId: string, key: string): string {
  const base = String(siteUrl || "").replace(/\/+$/, "");
  return `${base}/api/email/unsubscribe?t=${signUnsubscribeToken(userId, key)}`;
}
