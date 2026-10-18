import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decryptProviderKey } from "../src/lib/server/providerKeyCrypto";
import {
  KEY_CHANGE_LIMIT, MSG, __resetKeyChangeLimiter, loadProviderTabState, replaceProviderKey, rollbackProviderKey,
} from "../src/lib/server/providerKeyAdmin";
import { __setProviderKeyStoreForTests, resetProviderKeyCache, resolveProviderKey } from "../src/lib/server/providerKeys";
import { invalidateProviderStatusCache } from "../src/lib/server/providerStatus";
import { captureConsole, fakeKey, fakeKeyStore, mockProviderFetch, newEncryptionKey } from "./helpers/providerKeyTestKit";

const enc = newEncryptionKey();
let logs: ReturnType<typeof captureConsole>;
const ok = () => mockProviderFetch(() => ({ status: 200, body: { org_id: 1, balance_micro: 900_000 } }));

beforeEach(() => {
  vi.stubEnv("PROVIDER_KEYS_ENCRYPTION_KEY", enc);
  vi.stubEnv("TREG_TOKEN", "");
  vi.stubEnv("TREG_API_KEY", "");
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  __resetKeyChangeLimiter();
  invalidateProviderStatusCache();
  logs = captureConsole();
});
afterEach(() => {
  logs.restore();
  __setProviderKeyStoreForTests(null);
  resetProviderKeyCache();
  vi.unstubAllEnvs();
});

const setup = (options: Parameters<typeof fakeKeyStore>[0] = {}) => {
  const store = fakeKeyStore(options);
  __setProviderKeyStoreForTests(store.client);
  return store;
};

describe("replacing a provider key", () => {
  it("validates with the provider, stores only ciphertext, audits last4, and the new key is used at once", async () => {
    const store = setup();
    const envKey = fakeKey("env"); vi.stubEnv("TREG_TOKEN", envKey);
    expect((await resolveProviderKey("treg")).key).toBe(envKey);
    const fresh = fakeKey("fresh");
    const f = ok();

    const out = await replaceProviderKey({ client: store.client, fetchFn: f.fn }, { adminId: "admin-1", provider: "treg", newKey: `  ${fresh}  ` });

    expect(out).toMatchObject({ ok: true, status: 200, last4: fresh.slice(-4) });
    expect(out.messageAr).toMatch(/مشفّرًا/);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].headers["x-treg-token"]).toBe(fresh); // validated BEFORE saving
    expect(store.rpcCalls).toHaveLength(1);
    const args = store.rpcCalls[0].args;
    expect(args.p_ciphertext).not.toContain(fresh);
    expect(JSON.stringify(args)).not.toContain(fresh);
    expect(args.p_last4).toBe(fresh.slice(-4));
    expect(decryptProviderKey("treg", args.p_ciphertext)).toBe(fresh);
    expect(store.audit).toEqual([{ provider: "treg", action: "set", last4: fresh.slice(-4), actor_id: "admin-1" }]);
    // immediately, without waiting for the 30 s cache
    expect(await resolveProviderKey("treg")).toMatchObject({ key: fresh, source: "store" });
    expect(logs.text()).not.toContain(fresh);
  });

  it("a key the provider rejects is NOT saved and the old key keeps working", async () => {
    const store = setup();
    const oldKey = fakeKey("old");
    store.seed("treg", oldKey);
    const bad = fakeKey("bad");
    const f = mockProviderFetch(() => ({ status: 401 }));

    const out = await replaceProviderKey({ client: store.client, fetchFn: f.fn }, { adminId: "admin-1", provider: "treg", newKey: bad });

    expect(out).toMatchObject({ ok: false, reason: "validation_rejected", status: 422 });
    expect(out.messageAr).toBe(MSG.rejected);
    expect(out.messageAr).toMatch(/لم يُحفظ/);
    expect(store.rpcCalls).toHaveLength(0);
    expect(store.audit).toHaveLength(0);
    expect((await resolveProviderKey("treg")).key).toBe(oldKey);
    expect(logs.text()).not.toContain(bad);
  });

  it("an unreachable provider also blocks the save, and an error that carries the key is never echoed or logged", async () => {
    const store = setup();
    const oldKey = fakeKey("old"); store.seed("anthropic", oldKey);
    const bad = fakeKey("leaky");
    const f = mockProviderFetch(() => new Error(`connect ETIMEDOUT while sending ${bad}`));
    const out = await replaceProviderKey({ client: store.client, fetchFn: f.fn }, { adminId: "admin-1", provider: "anthropic", newKey: bad });
    expect(out).toMatchObject({ ok: false, reason: "validation_unreachable", status: 502 });
    expect(JSON.stringify(out)).not.toContain(bad);
    expect(logs.text()).not.toContain(bad);
    expect(store.rpcCalls).toHaveLength(0);
    expect((await resolveProviderKey("anthropic")).key).toBe(oldKey);
  });

  it("refuses to save when PROVIDER_KEYS_ENCRYPTION_KEY is missing, tells the owner to set it in Vercel, and calls nothing", async () => {
    const store = setup();
    vi.stubEnv("PROVIDER_KEYS_ENCRYPTION_KEY", "");
    const f = ok();
    const out = await replaceProviderKey({ client: store.client, fetchFn: f.fn }, { adminId: "admin-1", provider: "treg", newKey: fakeKey("x") });
    expect(out).toMatchObject({ ok: false, reason: "encryption_key_missing", status: 503 });
    expect(out.messageAr).toContain("PROVIDER_KEYS_ENCRYPTION_KEY");
    expect(out.messageAr).toContain("Vercel");
    expect(f.mock).not.toHaveBeenCalled();
    expect(store.rpcCalls).toHaveLength(0);
    expect(store.rows.size).toBe(0); // never a plaintext fallback
  });

  it("an invalid encryption key value is refused with its own message", async () => {
    const store = setup();
    vi.stubEnv("PROVIDER_KEYS_ENCRYPTION_KEY", "not-32-bytes");
    const out = await replaceProviderKey({ client: store.client, fetchFn: ok().fn }, { adminId: "admin-1", provider: "treg", newKey: fakeKey("x") });
    expect(out).toMatchObject({ ok: false, reason: "encryption_key_invalid" });
    expect(store.rpcCalls).toHaveLength(0);
  });

  it("before the migration (table missing) saving is refused with an Arabic notice and the provider is not even called", async () => {
    const store = setup({ tableMissing: true });
    const f = ok();
    const out = await replaceProviderKey({ client: store.client, fetchFn: f.fn }, { adminId: "admin-1", provider: "treg", newKey: fakeKey("x") });
    expect(out).toMatchObject({ ok: false, reason: "store_not_ready", status: 409 });
    expect(out.messageAr).toBe(MSG.storeNotReady);
    expect(f.mock).not.toHaveBeenCalled();
  });

  it("if only the function is missing the save is refused after validation, with one log line and nothing stored", async () => {
    const store = setup({ functionsMissing: true });
    const out = await replaceProviderKey({ client: store.client, fetchFn: ok().fn }, { adminId: "admin-1", provider: "treg", newKey: fakeKey("x") });
    expect(out).toMatchObject({ ok: false, reason: "store_not_ready" });
    expect(logs.lines.filter((l) => l.includes("[provider_key:set_function_unavailable]"))).toHaveLength(1);
    expect(store.rows.size).toBe(0);
  });

  it("a non-admin is refused by the database function itself, nothing changes, and the key is not used", async () => {
    const store = setup({ admins: ["admin-1"] });
    const envKey = fakeKey("env"); vi.stubEnv("TREG_TOKEN", envKey);
    const attacker = fakeKey("attacker");
    const out = await replaceProviderKey({ client: store.client, fetchFn: ok().fn }, { adminId: "not-an-admin", provider: "treg", newKey: attacker });
    expect(out).toMatchObject({ ok: false, reason: "not_admin", status: 403 });
    expect(store.rows.size).toBe(0);
    expect(store.audit).toHaveLength(0);
    expect((await resolveProviderKey("treg")).key).toBe(envKey);
  });

  it("refuses malformed keys before anything else", async () => {
    const store = setup();
    const f = ok();
    for (const bad of ["", "short", "has spaces in it long enough", 42, null]) {
      const out = await replaceProviderKey({ client: store.client, fetchFn: f.fn }, { adminId: "admin-1", provider: "treg", newKey: bad });
      expect(out).toMatchObject({ ok: false, reason: "invalid_key", status: 400 });
    }
    expect(f.mock).not.toHaveBeenCalled();
  });

  it("pasting the key that is already stored is refused, but pasting the environment key moves it into the store", async () => {
    const store = setup();
    const envKey = fakeKey("env"); vi.stubEnv("TREG_TOKEN", envKey);
    const move = await replaceProviderKey({ client: store.client, fetchFn: ok().fn }, { adminId: "admin-1", provider: "treg", newKey: envKey });
    expect(move.ok).toBe(true);
    expect((await resolveProviderKey("treg")).source).toBe("store");
    const again = await replaceProviderKey({ client: store.client, fetchFn: ok().fn }, { adminId: "admin-1", provider: "treg", newKey: envKey });
    expect(again).toMatchObject({ ok: false, reason: "same_key" });
  });

  it("limits key-change attempts per admin", async () => {
    const store = setup();
    const f = mockProviderFetch(() => ({ status: 401 }));
    let last: Awaited<ReturnType<typeof replaceProviderKey>> | null = null;
    for (let i = 0; i < KEY_CHANGE_LIMIT.max + 1; i++) last = await replaceProviderKey({ client: store.client, fetchFn: f.fn }, { adminId: "admin-1", provider: "treg", newKey: fakeKey(`try${i}`) });
    expect(last).toMatchObject({ ok: false, reason: "rate_limited", status: 429 });
    expect(f.calls).toHaveLength(KEY_CHANGE_LIMIT.max);
  });
});

describe("one-step rollback", () => {
  it("restores the previous key, validated first, audited, and active immediately", async () => {
    const store = setup();
    const first = fakeKey("first"); const second = fakeKey("second");
    store.seed("treg", first);
    expect((await replaceProviderKey({ client: store.client, fetchFn: ok().fn }, { adminId: "admin-1", provider: "treg", newKey: second })).ok).toBe(true);
    expect((await resolveProviderKey("treg")).key).toBe(second);

    const f = ok();
    const out = await rollbackProviderKey({ client: store.client, fetchFn: f.fn }, { adminId: "admin-1", provider: "treg" });

    expect(out).toMatchObject({ ok: true, reason: "rolled_back", last4: first.slice(-4) });
    expect(f.calls[0].headers["x-treg-token"]).toBe(first);
    expect((await resolveProviderKey("treg")).key).toBe(first);
    expect(store.audit.map((a) => a.action)).toEqual(["set", "rollback"]);
    expect(store.audit.every((a) => a.last4.length <= 4)).toBe(true);
    expect(logs.text()).not.toContain(first);
    expect(logs.text()).not.toContain(second);
  });

  it("is refused when there is no previous key, or when the previous key no longer validates", async () => {
    const store = setup();
    store.seed("treg", fakeKey("only"));
    expect(await rollbackProviderKey({ client: store.client, fetchFn: ok().fn }, { adminId: "admin-1", provider: "treg" })).toMatchObject({ ok: false, reason: "no_previous_key", status: 404 });

    await replaceProviderKey({ client: store.client, fetchFn: ok().fn }, { adminId: "admin-1", provider: "treg", newKey: fakeKey("next") });
    const current = (await resolveProviderKey("treg")).key;
    const out = await rollbackProviderKey({ client: store.client, fetchFn: mockProviderFetch(() => ({ status: 401 })).fn }, { adminId: "admin-1", provider: "treg" });
    expect(out).toMatchObject({ ok: false, reason: "validation_rejected" });
    expect((await resolveProviderKey("treg")).key).toBe(current);
  });

  it("a non-admin cannot roll back", async () => {
    const store = setup();
    store.seed("treg", fakeKey("a"));
    await replaceProviderKey({ client: store.client, fetchFn: ok().fn }, { adminId: "admin-1", provider: "treg", newKey: fakeKey("b") });
    const out = await rollbackProviderKey({ client: store.client, fetchFn: ok().fn }, { adminId: "intruder", provider: "treg" });
    expect(out).toMatchObject({ ok: false, reason: "not_admin", status: 403 });
  });
});

describe("what the admin tab receives", () => {
  it("is masked: at most 4 key characters, no ciphertext, no encryption key", async () => {
    const store = setup();
    const key = fakeKey("shown");
    store.seed("treg", key);
    const f = ok();
    const state = await loadProviderTabState({ client: store.client, fetchFn: f.fn }, "treg", { forceRefresh: true });
    const json = JSON.stringify(state);
    expect(state.maskedKey).toContain(key.slice(-4));
    expect(json).not.toContain(key);
    expect(json).not.toContain(key.slice(-5));
    expect(json).not.toContain(store.rows.get("treg").active_ciphertext);
    expect(json).not.toContain(enc);
    expect(state).toMatchObject({ keySource: "store", storeState: "ok", encryptionConfigured: true });
    expect(state.status.health.ok).toBe(true);
    expect(state.status.balance).toMatchObject({ available: true, balanceUsd: 0.9 });
    expect(store.selects.filter((s) => s.startsWith("provider_api_keys")).every((s) => !/ciphertext/.test(s) || s.includes("active_ciphertext, active_last4"))).toBe(true);
  });

  it("before the migration it says the key store is not ready and that the environment key is in use", async () => {
    const store = setup({ tableMissing: true });
    vi.stubEnv("TREG_TOKEN", fakeKey("env"));
    const state = await loadProviderTabState({ client: store.client, fetchFn: ok().fn }, "treg", { forceRefresh: true });
    expect(state.store.ready).toBe(false);
    expect(state.keySource).toBe("env");
    expect(state.noticesAr.join(" ")).toMatch(/مخزن المفاتيح غير جاهز/);
    expect(state.noticesAr.join(" ")).toMatch(/متغيرات البيئة/);
  });

  it("the model provider tab states plainly that there is no balance API", async () => {
    const store = setup();
    vi.stubEnv("ANTHROPIC_API_KEY", fakeKey("llm"));
    const state = await loadProviderTabState({ client: store.client, fetchFn: ok().fn }, "anthropic", { forceRefresh: true });
    expect(state.status.balance).toMatchObject({ available: false, unavailableReason: "no_balance_api" });
    expect(state.noticesAr.join(" ")).toMatch(/لا يوفّر واجهة لقراءة الرصيد/);
  });
});
