import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PROVIDER_KEY_CACHE_TTL_MS, __setProviderKeyStoreForTests, getLastAuthRejection, invalidateProviderKeyCache, peekProviderKey,
  reportProviderHttpStatus, resolveProviderKey, resetProviderKeyCache,
} from "../src/lib/server/providerKeys";
import { captureConsole, fakeKey, fakeKeyStore, newEncryptionKey } from "./helpers/providerKeyTestKit";

let now = 1_000_000;
const tick = (ms: number) => { now += ms; };
const enc = newEncryptionKey();
let logs: ReturnType<typeof captureConsole>;

beforeEach(() => {
  now = 1_000_000;
  vi.stubEnv("PROVIDER_KEYS_ENCRYPTION_KEY", enc);
  vi.stubEnv("TREG_TOKEN", "");
  vi.stubEnv("TREG_API_KEY", "");
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  logs = captureConsole();
});
afterEach(() => {
  logs.restore();
  __setProviderKeyStoreForTests(null);
  resetProviderKeyCache();
  vi.unstubAllEnvs();
});

const countReads = (store: ReturnType<typeof fakeKeyStore>) => store.selects.filter((s) => s.startsWith("provider_api_keys:active_ciphertext")).length;

describe("shared provider key resolver", () => {
  it("prefers the active key from the store over the environment variable", async () => {
    const store = fakeKeyStore();
    const storeKey = fakeKey("store"); const envKey = fakeKey("env");
    store.seed("treg", storeKey);
    vi.stubEnv("TREG_TOKEN", envKey);
    __setProviderKeyStoreForTests(store.client, () => now);
    const r = await resolveProviderKey("treg");
    expect(r).toMatchObject({ key: storeKey, source: "store", storeState: "ok", last4: storeKey.slice(-4) });
  });

  it("falls back to the environment variable when the store has no key (TREG_TOKEN, then TREG_API_KEY)", async () => {
    const store = fakeKeyStore();
    __setProviderKeyStoreForTests(store.client, () => now);
    vi.stubEnv("TREG_API_KEY", fakeKey("alt"));
    expect((await resolveProviderKey("treg")).key).toBe(process.env.TREG_API_KEY);
    invalidateProviderKeyCache();
    vi.stubEnv("TREG_TOKEN", fakeKey("primary"));
    const r = await resolveProviderKey("treg");
    expect(r).toMatchObject({ key: process.env.TREG_TOKEN, source: "env", storeState: "no_key" });
  });

  it("keeps a resolved key for at most 30 seconds, then reads the store again", async () => {
    expect(PROVIDER_KEY_CACHE_TTL_MS).toBe(30_000);
    const store = fakeKeyStore();
    const first = fakeKey("one"); const second = fakeKey("two");
    store.seed("treg", first);
    __setProviderKeyStoreForTests(store.client, () => now);
    expect((await resolveProviderKey("treg")).key).toBe(first);
    store.seed("treg", second);
    tick(29_000);
    expect((await resolveProviderKey("treg")).key).toBe(first);
    expect(countReads(store)).toBe(1);
    tick(1_500);
    expect((await resolveProviderKey("treg")).key).toBe(second);
    expect(countReads(store)).toBe(2);
  });

  it("takes effect immediately on the instance that saved it (cache invalidation)", async () => {
    const store = fakeKeyStore();
    const first = fakeKey("one"); const second = fakeKey("two");
    store.seed("anthropic", first);
    __setProviderKeyStoreForTests(store.client, () => now);
    expect((await resolveProviderKey("anthropic")).key).toBe(first);
    store.seed("anthropic", second);
    invalidateProviderKeyCache("anthropic");
    expect((await resolveProviderKey("anthropic")).key).toBe(second);
  });

  it("concurrent resolutions share one store read", async () => {
    const store = fakeKeyStore();
    store.seed("treg", fakeKey("shared"));
    __setProviderKeyStoreForTests(store.client, () => now);
    await Promise.all([resolveProviderKey("treg"), resolveProviderKey("treg"), resolveProviderKey("treg")]);
    expect(countReads(store)).toBe(1);
  });

  it("falls back to the environment variable when the table is missing, with one safe log line", async () => {
    const store = fakeKeyStore({ tableMissing: true });
    const envKey = fakeKey("env");
    vi.stubEnv("TREG_TOKEN", envKey);
    __setProviderKeyStoreForTests(store.client, () => now);
    for (let i = 0; i < 3; i++) { tick(31_000); expect(await resolveProviderKey("treg")).toMatchObject({ key: envKey, source: "env", storeState: "not_ready" }); }
    const lines = logs.lines.filter((l) => l.includes("[provider_key:store_not_ready]"));
    expect(lines).toHaveLength(1);
    expect(logs.text()).not.toContain(envKey);
  });

  it("without the encryption key a stored key cannot be read: environment key is used and the state says why", async () => {
    const store = fakeKeyStore();
    store.seed("treg", fakeKey("stored"), undefined, { PROVIDER_KEYS_ENCRYPTION_KEY: enc } as unknown as NodeJS.ProcessEnv);
    const envKey = fakeKey("env");
    vi.stubEnv("TREG_TOKEN", envKey);
    vi.stubEnv("PROVIDER_KEYS_ENCRYPTION_KEY", "");
    __setProviderKeyStoreForTests(store.client, () => now);
    expect(await resolveProviderKey("treg")).toMatchObject({ key: envKey, source: "env", storeState: "encryption_missing" });
    expect(logs.text()).toContain("[provider_key:encryption_missing]");
  });

  it("a tampered stored value is not used: environment key, decrypt_failed", async () => {
    const store = fakeKeyStore();
    store.seed("treg", fakeKey("stored"), undefined, { PROVIDER_KEYS_ENCRYPTION_KEY: enc } as unknown as NodeJS.ProcessEnv);
    const row = store.rows.get("treg");
    row.active_ciphertext = row.active_ciphertext.replace(/.$/, (c: string) => (c === "A" ? "B" : "A"));
    const envKey = fakeKey("env");
    vi.stubEnv("TREG_TOKEN", envKey);
    __setProviderKeyStoreForTests(store.client, () => now);
    expect(await resolveProviderKey("treg")).toMatchObject({ key: envKey, storeState: "decrypt_failed" });
  });

  it("a database blip keeps using the last good store key instead of flipping to a possibly revoked env key", async () => {
    const store = fakeKeyStore();
    const storeKey = fakeKey("store");
    store.seed("treg", storeKey);
    vi.stubEnv("TREG_TOKEN", fakeKey("old-env"));
    let failing = false;
    const failingFrom = fakeKeyStore({ readError: true }).client.from;
    const client = { ...store.client, from: (table: string) => (failing ? failingFrom(table) : store.client.from(table)) };
    __setProviderKeyStoreForTests(client, () => now);
    expect((await resolveProviderKey("treg")).key).toBe(storeKey);
    failing = true;
    tick(31_000);
    expect(await resolveProviderKey("treg")).toMatchObject({ key: storeKey, source: "store", storeState: "read_failed" });
    expect(logs.text()).toContain("[provider_key:store_read_failed]");
  });

  it("an environment variable changed at runtime is never hidden behind the cache", async () => {
    __setProviderKeyStoreForTests(fakeKeyStore().client, () => now);
    expect((await resolveProviderKey("treg")).source).toBe("none");
    const later = fakeKey("later");
    vi.stubEnv("TREG_TOKEN", later);
    expect(await resolveProviderKey("treg")).toMatchObject({ key: later, source: "env" });
    expect(peekProviderKey("treg")).toBe(later);
  });

  it("with no store and no variable there is no key", async () => {
    __setProviderKeyStoreForTests(fakeKeyStore().client, () => now);
    expect(await resolveProviderKey("anthropic")).toMatchObject({ key: "", source: "none" });
    expect(peekProviderKey("anthropic")).toBe("");
  });

  it("peek returns the last resolved store key synchronously, else the environment variable", async () => {
    const store = fakeKeyStore();
    const storeKey = fakeKey("store");
    store.seed("treg", storeKey);
    vi.stubEnv("TREG_TOKEN", fakeKey("env"));
    __setProviderKeyStoreForTests(store.client, () => now);
    expect(peekProviderKey("treg")).toBe(process.env.TREG_TOKEN);
    await resolveProviderKey("treg");
    expect(peekProviderKey("treg")).toBe(storeKey);
  });

  it("under the offline test runner without an injected store the environment variable is used and nothing is fetched", async () => {
    vi.stubEnv("TREG_TOKEN", fakeKey("plain"));
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(await resolveProviderKey("treg")).toMatchObject({ source: "env", storeState: "skipped" });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("an authentication rejection is logged with a reason code, kept for the admin tab, never switches keys and clears on success", async () => {
    const store = fakeKeyStore();
    const storeKey = fakeKey("store");
    store.seed("treg", storeKey);
    vi.stubEnv("TREG_TOKEN", fakeKey("env"));
    __setProviderKeyStoreForTests(store.client, () => now);
    const before = await resolveProviderKey("treg");
    reportProviderHttpStatus("treg", 401, before.source);
    reportProviderHttpStatus("treg", 403, before.source);
    expect(getLastAuthRejection("treg")).toMatchObject({ provider: "treg", httpStatus: 403, source: "store", count: 2 });
    expect(logs.lines.filter((l) => l.includes("[provider_key:auth_rejected] provider=treg source=store"))).toHaveLength(2);
    expect((await resolveProviderKey("treg")).key).toBe(storeKey); // no silent switch
    expect(logs.text()).not.toContain(storeKey);
    reportProviderHttpStatus("treg", 200, "store");
    expect(getLastAuthRejection("treg")).toBeNull();
  });
});
