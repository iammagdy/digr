import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeTregCall, sanitizeTregDetail } from "../src/functions/shared/tregClient";
import { clearCatalogCache, getEndpointDetails, searchCatalog } from "../src/functions/shared/catalogClient";
import { runSmokeTests } from "../src/functions/shared/smokeTest";
import { LlmClient, isProviderKeyPresent, resolveRuntimeProvider } from "../src/functions/shared/llmClient";
import { getLiveProviderGateStatus, getLiveProviderGateStatusFromSettings } from "../src/lib/server/providerGate";
import { getLastAuthRejection, __setProviderKeyStoreForTests, resetProviderKeyCache, resolveProviderKey } from "../src/lib/server/providerKeys";
import { captureConsole, fakeKey, fakeKeyStore, newEncryptionKey } from "./helpers/providerKeyTestKit";

const enc = newEncryptionKey();
let logs: ReturnType<typeof captureConsole>;
let store: ReturnType<typeof fakeKeyStore>;

beforeEach(() => {
  vi.stubEnv("PROVIDER_KEYS_ENCRYPTION_KEY", enc);
  vi.stubEnv("TREG_TOKEN", "");
  vi.stubEnv("TREG_API_KEY", "");
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  vi.stubEnv("TREG_LIVE", "true");
  store = fakeKeyStore();
  __setProviderKeyStoreForTests(store.client);
  clearCatalogCache();
  logs = captureConsole();
});
afterEach(() => {
  logs.restore();
  __setProviderKeyStoreForTests(null);
  resetProviderKeyCache();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const okJson = (body: unknown = { ok: true }, status = 200) => new Response(JSON.stringify(body), { status, headers: { "x-treg-cost-micro": "0" } });

describe("every data-provider call site resolves the key through the shared resolver", () => {
  it("the worker call uses the store key; an environment key is only the fallback", async () => {
    const storeKey = fakeKey("store"); const envKey = fakeKey("env");
    store.seed("treg", storeKey);
    vi.stubEnv("TREG_TOKEN", envKey);
    const fetchMock = vi.fn(async () => okJson({ rows: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await executeTregCall({ endpointId: "x.y.z", params: {}, userId: "u", jobId: "j" });
    expect((fetchMock.mock.calls[0] as any[])[1].headers["X-Treg-Token"]).toBe(storeKey);
  });

  it("falls back to the environment key when the store has none or the table does not exist yet", async () => {
    const envKey = fakeKey("env");
    vi.stubEnv("TREG_TOKEN", envKey);
    for (const s of [fakeKeyStore(), fakeKeyStore({ tableMissing: true })]) {
      resetProviderKeyCache();
      __setProviderKeyStoreForTests(s.client);
      const fetchMock = vi.fn(async () => okJson({ rows: [] }));
      vi.stubGlobal("fetch", fetchMock);
      await executeTregCall({ endpointId: "x.y.z", params: {}, userId: "u", jobId: "j" });
      expect((fetchMock.mock.calls[0] as any[])[1].headers["X-Treg-Token"]).toBe(envKey);
    }
    expect(logs.text()).not.toContain(envKey);
  });

  it("an explicit token option still wins (used by tests and one-off tools)", async () => {
    store.seed("treg", fakeKey("store"));
    const explicit = fakeKey("explicit");
    const fetchMock = vi.fn(async () => okJson());
    vi.stubGlobal("fetch", fetchMock);
    await executeTregCall({ endpointId: "x.y.z", params: {}, userId: "u", jobId: "j", token: explicit });
    expect((fetchMock.mock.calls[0] as any[])[1].headers["X-Treg-Token"]).toBe(explicit);
  });

  it("a 401 on the stored key is logged with a reason code and kept for the admin tab; the key is not switched", async () => {
    const storeKey = fakeKey("store"); const envKey = fakeKey("env");
    store.seed("treg", storeKey);
    vi.stubEnv("TREG_TOKEN", envKey);
    const fetchMock = vi.fn(async () => okJson({ error: "unauthorized" }, 401));
    vi.stubGlobal("fetch", fetchMock);
    await executeTregCall({ endpointId: "x.y.z", params: {}, userId: "u", jobId: "j" });
    await executeTregCall({ endpointId: "x.y.z", params: {}, userId: "u", jobId: "j2" });
    expect(getLastAuthRejection("treg")).toMatchObject({ httpStatus: 401, source: "store", count: 2 });
    expect(logs.lines.some((l) => l.includes("[provider_key:auth_rejected] provider=treg source=store status=401"))).toBe(true);
    for (const call of fetchMock.mock.calls as any[][]) expect(call[1].headers["X-Treg-Token"]).toBe(storeKey);
    expect(logs.text()).not.toContain(storeKey);
    expect(logs.text()).not.toContain(envKey);
  });

  it("error text is redacted with the resolved key, not only the environment one", async () => {
    const storeKey = fakeKey("store");
    store.seed("treg", storeKey);
    await resolveProviderKey("treg");
    expect(sanitizeTregDetail(`upstream said bad key ${storeKey} please retry`)).not.toContain(storeKey);
  });

  it("catalog search and endpoint lookup send the resolved key", async () => {
    const storeKey = fakeKey("store");
    store.seed("treg", storeKey);
    const seen: string[] = [];
    const fetchFn = vi.fn(async (_url: string, init?: any) => { seen.push(init?.headers?.["X-Treg-Token"]); return okJson({ results: [] }); });
    await searchCatalog("tiktok comments", "tiktok", { fetchFn: fetchFn as any, bypassCache: true } as any).catch(() => {});
    await getEndpointDetails("some.endpoint.id", { fetchFn: fetchFn as any, bypassCache: true } as any).catch(() => {});
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen.every((t) => t === storeKey)).toBe(true);
  });

  it("the smoke test and the live gate see a key that exists only in the store", async () => {
    store.seed("treg", fakeKey("store"));
    vi.stubEnv("TREG_LIVE", "false");
    const smoke = await runSmokeTests("admin-1");
    expect(smoke.provider_token_present).toBe(true);
    vi.stubEnv("TREG_LIVE", "true");
    const gate = await getLiveProviderGateStatusFromSettings({});
    expect(gate).toMatchObject({ isReady: true, reasonCode: "ok" });
    expect(getLiveProviderGateStatus().isReady).toBe(true);
  });

  it("with no key anywhere the gate says token_missing", async () => {
    const gate = await getLiveProviderGateStatusFromSettings({});
    expect(gate).toMatchObject({ isReady: false, reasonCode: "token_missing" });
  });
});

describe("the assistant resolves its key through the shared resolver", () => {
  it("sends the store key to the model provider and reports a rejection", async () => {
    const storeKey = fakeKey("store"); const envKey = fakeKey("env");
    store.seed("anthropic", storeKey);
    vi.stubEnv("ANTHROPIC_API_KEY", envKey);
    vi.stubEnv("LLM_PROVIDER", "anthropic");
    vi.stubEnv("LLM_ENABLED", "true");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: { type: "authentication_error", message: "invalid x-api-key" } }), { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await new LlmClient().executeTurn({ messages: [{ role: "user", content: "مرحبا" }], sanitizedCapabilities: [] });
    expect((fetchMock.mock.calls[0] as any[])[1].headers["x-api-key"]).toBe(storeKey);
    expect(getLastAuthRejection("anthropic")).toMatchObject({ httpStatus: 401, source: "store" });
    expect(JSON.stringify(result)).not.toContain(storeKey);
    expect(logs.text()).not.toContain(storeKey);
    expect(logs.text()).not.toContain(envKey);
  });

  it("a key held only in the store counts as present once resolved", async () => {
    store.seed("anthropic", fakeKey("store"));
    expect(isProviderKeyPresent("anthropic")).toBe(false);
    await new LlmClient({ provider: "fake" }).executeTurn({ messages: [{ role: "user", content: "x" }], sanitizedCapabilities: [] }).catch(() => {});
    expect(isProviderKeyPresent("anthropic")).toBe(true);
    expect(resolveRuntimeProvider("anthropic")).toBe("anthropic");
  });
});
