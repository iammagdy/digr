import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Encryption of the TREG key pool (docs/proposals/treg-key-pool). Same format as providerKeyCrypto (`v1.<nonce>.<ciphertext>.<tag>`, base64url, AES-256-GCM,
 * random nonce), with two differences that matter: the encryption key is NOT an environment variable but the Supabase Vault secret `diger-treg-pool-enc-key`
 * (read through the service-role-only function treg_pool_enc_key()), and the authenticated data is the ROW ID of the key, so a ciphertext cannot be moved
 * to another row. The plaintext key exists only in this process's memory; it never reaches SQL, a log, an error or an e-mail.
 */
export type PoolCryptoFailure = "encryption_key_missing" | "encryption_key_invalid" | "ciphertext_invalid" | "decrypt_failed";

/** Carries only a fixed reason code: never the key, the ciphertext, or the underlying library message. */
export class PoolCryptoError extends Error {
  readonly code: PoolCryptoFailure;
  constructor(code: PoolCryptoFailure) {
    super(`treg pool crypto: ${code}`);
    this.name = "PoolCryptoError";
    this.code = code;
  }
}

/** The shape the SQL functions accept (02/03: treg_pool_keys_ciphertext_shape). */
export const POOL_CIPHERTEXT_FORMAT = /^v1\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{8,1200})\.([A-Za-z0-9_-]{22})$/;

const aad = (keyId: string) => Buffer.from(`digr:treg-pool:${keyId}`, "utf8");

/** The Vault secret: base64 of exactly 32 bytes. Anything else is refused; there is no plaintext fallback. */
export function parsePoolEncryptionKey(raw: unknown): Buffer {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) throw new PoolCryptoError("encryption_key_missing");
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) throw new PoolCryptoError("encryption_key_invalid");
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) throw new PoolCryptoError("encryption_key_invalid");
  return key;
}

export function encryptPoolKey(encryptionKey: string, keyId: string, plaintext: string): string {
  const key = parsePoolEncryptionKey(encryptionKey);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad(keyId));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `v1.${nonce.toString("base64url")}.${ct.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}`;
}

export function decryptPoolKey(encryptionKey: string, keyId: string, stored: string): string {
  const key = parsePoolEncryptionKey(encryptionKey);
  const m = POOL_CIPHERTEXT_FORMAT.exec(stored || "");
  if (!m) throw new PoolCryptoError("ciphertext_invalid");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(m[1], "base64url"));
    decipher.setAAD(aad(keyId));
    decipher.setAuthTag(Buffer.from(m[3], "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(m[2], "base64url")), decipher.final()]).toString("utf8");
  } catch {
    // Tampered ciphertext, another row's ciphertext, or a different Vault key: all fail the authentication tag.
    throw new PoolCryptoError("decrypt_failed");
  }
}
