import { describe, expect, it } from "vitest";
import {
  ProviderKeyCryptoError, cleanKey, decryptProviderKey, encryptProviderKey, isEncryptionConfigured, last4Of, maskedKey, validateKeyShape,
} from "../src/lib/server/providerKeyCrypto";
import { fakeKey, newEncryptionKey } from "./helpers/providerKeyTestKit";

const envWith = (value?: string) => ({ ...(value === undefined ? {} : { PROVIDER_KEYS_ENCRYPTION_KEY: value }) }) as unknown as NodeJS.ProcessEnv;

describe("provider key encryption (AES-256-GCM)", () => {
  it("round-trips a key and never stores it in the clear", () => {
    const env = envWith(newEncryptionKey());
    const key = fakeKey("roundtrip");
    const stored = encryptProviderKey("treg", key, env);
    expect(stored).toMatch(/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$/);
    expect(stored).not.toContain(key);
    expect(decryptProviderKey("treg", stored, env)).toBe(key);
  });

  it("uses a fresh random nonce per value", () => {
    const env = envWith(newEncryptionKey());
    const key = fakeKey("nonce");
    const a = encryptProviderKey("treg", key, env);
    const b = encryptProviderKey("treg", key, env);
    expect(a).not.toBe(b);
    expect(a.split(".")[1]).not.toBe(b.split(".")[1]);
    expect(decryptProviderKey("treg", a, env)).toBe(decryptProviderKey("treg", b, env));
  });

  it("detects tampering in the nonce, the ciphertext and the tag", () => {
    const env = envWith(newEncryptionKey());
    const stored = encryptProviderKey("anthropic", fakeKey("tamper"), env);
    const [v, nonce, ct, tag] = stored.split(".");
    const flip = (s: string) => (s[0] === "A" ? "B" : "A") + s.slice(1);
    for (const bad of [`${v}.${flip(nonce)}.${ct}.${tag}`, `${v}.${nonce}.${flip(ct)}.${tag}`, `${v}.${nonce}.${ct}.${flip(tag)}`]) {
      expect(() => decryptProviderKey("anthropic", bad, env)).toThrowError(ProviderKeyCryptoError);
      try { decryptProviderKey("anthropic", bad, env); } catch (e) { expect((e as ProviderKeyCryptoError).code).toBe("decrypt_failed"); }
    }
  });

  it("binds the ciphertext to its provider and to the encryption key", () => {
    const env = envWith(newEncryptionKey());
    const stored = encryptProviderKey("treg", fakeKey("bind"), env);
    expect(() => decryptProviderKey("anthropic", stored, env)).toThrow(/decrypt_failed/);
    expect(() => decryptProviderKey("treg", stored, envWith(newEncryptionKey()))).toThrow(/decrypt_failed/);
  });

  it("refuses malformed stored values", () => {
    const env = envWith(newEncryptionKey());
    for (const bad of ["", "plain-text-key", "v2.a.b.c", "v1.short.x.y"]) {
      expect(() => decryptProviderKey("treg", bad, env)).toThrow(/ciphertext_invalid/);
    }
  });

  it("a missing or invalid encryption key refuses to encrypt: there is no plaintext fallback", () => {
    const key = fakeKey("refuse");
    expect(isEncryptionConfigured(envWith())).toBe(false);
    expect(() => encryptProviderKey("treg", key, envWith())).toThrow(/encryption_key_missing/);
    expect(() => encryptProviderKey("treg", key, envWith("   "))).toThrow(/encryption_key_missing/);
    expect(() => encryptProviderKey("treg", key, envWith("too-short"))).toThrow(/encryption_key_invalid/);
    expect(() => encryptProviderKey("treg", key, envWith(Buffer.alloc(16).toString("base64")))).toThrow(/encryption_key_invalid/);
    expect(() => encryptProviderKey("treg", key, envWith(Buffer.alloc(33).toString("base64")))).toThrow(/encryption_key_invalid/);
    expect(isEncryptionConfigured(envWith(newEncryptionKey()))).toBe(true);
  });

  it("no thrown error mentions the key, the ciphertext or the encryption key", () => {
    const encKey = newEncryptionKey();
    const env = envWith(encKey);
    const key = fakeKey("errors");
    const stored = encryptProviderKey("treg", key, env);
    const messages: string[] = [];
    for (const f of [
      () => encryptProviderKey("treg", key, envWith()),
      () => encryptProviderKey("treg", key, envWith("bad!!")),
      () => decryptProviderKey("anthropic", stored, env),
      () => decryptProviderKey("treg", "garbage", env),
    ]) {
      try { f(); } catch (e) { messages.push(String((e as Error).message), String((e as Error).stack || "")); }
    }
    const all = messages.join("\n");
    expect(messages.length).toBeGreaterThan(0);
    for (const secret of [key, stored, encKey, stored.split(".")[2]]) expect(all).not.toContain(secret);
  });

  it("masked output never contains more than 4 key characters", () => {
    const key = fakeKey("mask");
    expect(last4Of(key)).toBe(key.slice(-4));
    expect(last4Of("short")).toBeNull();
    const masked = maskedKey(last4Of(key));
    expect(masked).toContain(key.slice(-4));
    expect(masked).not.toContain(key.slice(-5));
    expect(masked.replace(/[•]/g, "").length).toBeLessThanOrEqual(4);
    expect(maskedKey("longerthan4").endsWith("han4")).toBe(true);
    expect(maskedKey("longerthan4")).not.toContain("than4");
    expect(maskedKey(null)).toBe("غير مضبوط");
  });

  it("validates pasted keys by shape only", () => {
    expect(validateKeyShape(fakeKey("ok"))).toBeNull();
    expect(validateKeyShape("short")).not.toBeNull();
    expect(validateKeyShape("has a space inside key value")).not.toBeNull();
    expect(validateKeyShape("x".repeat(401))).not.toBeNull();
    expect(validateKeyShape(undefined)).not.toBeNull();
    expect(cleanKey('  "abcdefghijklmnop"  ')).toBe("abcdefghijklmnop");
  });
});
