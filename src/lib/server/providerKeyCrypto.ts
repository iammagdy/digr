import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export type ProviderId = "treg" | "anthropic";
export const PROVIDER_IDS: readonly ProviderId[] = ["treg", "anthropic"];
export const ENCRYPTION_KEY_ENV = "PROVIDER_KEYS_ENCRYPTION_KEY";

/** Stored value: v1.<nonce>.<ciphertext>.<tag>, each part base64url. The provider name is authenticated data. */
const FORMAT = /^v1\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{8,1200})\.([A-Za-z0-9_-]{22})$/;

export type CryptoFailure = "encryption_key_missing" | "encryption_key_invalid" | "ciphertext_invalid" | "decrypt_failed";

/** Carries only a fixed reason code: never the key, the ciphertext, or the underlying library message. */
export class ProviderKeyCryptoError extends Error {
  readonly code: CryptoFailure;
  constructor(code: CryptoFailure) {
    super(`provider key crypto: ${code}`);
    this.name = "ProviderKeyCryptoError";
    this.code = code;
  }
}

const b64url = (buf: Buffer) => buf.toString("base64url");

/** The server-only key: base64 of exactly 32 random bytes. Anything else is refused; there is no plaintext fallback. */
export function getEncryptionKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = (env[ENCRYPTION_KEY_ENV] || "").trim();
  if (!raw) throw new ProviderKeyCryptoError("encryption_key_missing");
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(raw)) throw new ProviderKeyCryptoError("encryption_key_invalid");
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new ProviderKeyCryptoError("encryption_key_invalid");
  return key;
}

export function isEncryptionConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  try { getEncryptionKey(env); return true; } catch { return false; }
}

export function encryptProviderKey(provider: ProviderId, plaintext: string, env: NodeJS.ProcessEnv = process.env): string {
  const key = getEncryptionKey(env);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(`digr:provider-key:${provider}`, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `v1.${b64url(nonce)}.${b64url(ct)}.${b64url(cipher.getAuthTag())}`;
}

export function decryptProviderKey(provider: ProviderId, stored: string, env: NodeJS.ProcessEnv = process.env): string {
  const key = getEncryptionKey(env);
  const m = FORMAT.exec(stored || "");
  if (!m) throw new ProviderKeyCryptoError("ciphertext_invalid");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(m[1], "base64url"));
    decipher.setAAD(Buffer.from(`digr:provider-key:${provider}`, "utf8"));
    decipher.setAuthTag(Buffer.from(m[3], "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(m[2], "base64url")), decipher.final()]).toString("utf8");
  } catch {
    // Tampered ciphertext, wrong provider, or a different encryption key: all fail the authentication tag.
    throw new ProviderKeyCryptoError("decrypt_failed");
  }
}

/** Never more than the last 4 characters of a key, and only for keys long enough that 4 characters reveal little. */
export function last4Of(secret: string | null | undefined): string | null {
  const v = (secret || "").trim();
  return v.length >= 8 ? v.slice(-4) : null;
}

export function maskedKey(last4: string | null | undefined): string {
  return last4 ? `••••••••••••${String(last4).slice(-4)}` : "غير مضبوط";
}

/** Keys are pasted by hand: no whitespace, printable ASCII, a sane length. */
export function validateKeyShape(raw: unknown): string | null {
  if (typeof raw !== "string") return "المفتاح غير صالح.";
  const v = raw.trim().replace(/^["']|["']$/g, "").trim();
  if (v.length < 12 || v.length > 400) return "المفتاح غير صالح (طوله غير معتاد).";
  if (!/^[\x21-\x7e]+$/.test(v)) return "المفتاح غير صالح (يحتوي على مسافات أو رموز غير مسموحة).";
  return null;
}

export function cleanKey(raw: string): string {
  return raw.trim().replace(/^["']|["']$/g, "").trim();
}

export function generateEncryptionKeyHint(): string {
  return "node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"";
}
