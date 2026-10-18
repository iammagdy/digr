import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeKey, fakeKeyStore, newEncryptionKey, captureConsole } from "./helpers/providerKeyTestKit";

const state = vi.hoisted(() => ({ user: null as any, adminClient: null as any }));

vi.mock("../src/lib/supabase/server", () => ({
  createServerSideClient: vi.fn(async () => ({ auth: { getUser: vi.fn(async () => ({ data: { user: state.user }, error: null })) } })),
  createAdminClient: vi.fn(() => state.adminClient),
}));

import { GET, POST } from "../src/app/api/admin/provider-keys/route";
import { POST as legacyPost } from "../src/app/api/admin/providers/route";
import { __resetKeyChangeLimiter } from "../src/lib/server/providerKeyAdmin";
import { __setProviderKeyStoreForTests, resetProviderKeyCache } from "../src/lib/server/providerKeys";
import { invalidateProviderStatusCache } from "../src/lib/server/providerStatus";

const ADMIN = { id: "admin-1", email: "a@t", app_metadata: { role: "admin" }, user_metadata: { name: "مدير" } };
const req = (method: string, url: string, body?: unknown) =>
  new NextRequest(`http://localhost${url}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const okFetch = () => vi.fn(async () => new Response(JSON.stringify({ org_id: 3, balance_micro: 700_000 }), { status: 200 }));

let logs: ReturnType<typeof captureConsole>;
let store: ReturnType<typeof fakeKeyStore>;
let fetchMock: ReturnType<typeof okFetch>;

beforeEach(() => {
  vi.stubEnv("PROVIDER_KEYS_ENCRYPTION_KEY", newEncryptionKey());
  vi.stubEnv("TREG_TOKEN", "");
  vi.stubEnv("TREG_API_KEY", "");
  store = fakeKeyStore({ admins: ["admin-1"] });
  state.adminClient = store.client;
  state.user = ADMIN;
  __setProviderKeyStoreForTests(store.client);
  __resetKeyChangeLimiter();
  invalidateProviderStatusCache();
  fetchMock = okFetch();
  vi.stubGlobal("fetch", fetchMock);
  logs = captureConsole();
});
afterEach(() => {
  logs.restore();
  __setProviderKeyStoreForTests(null);
  resetProviderKeyCache();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("/api/admin/provider-keys access control", () => {
  it("signed-out callers get 401 and nothing is touched", async () => {
    state.user = null;
    expect((await GET(req("GET", "/api/admin/provider-keys?provider=treg"))).status).toBe(401);
    expect((await POST(req("POST", "/api/admin/provider-keys", { action: "replace", provider: "treg", key: fakeKey("x") }))).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.rpcCalls).toHaveLength(0);
  });

  it("a signed-in non-admin gets 403 on every verb and nothing is touched", async () => {
    for (const user of [{ id: "u1", email: "u@t", app_metadata: {} }, { id: "u2", email: "v@t", app_metadata: { role: "user" } }]) {
      state.user = user;
      expect((await GET(req("GET", "/api/admin/provider-keys?provider=treg"))).status).toBe(403);
      for (const action of ["replace", "rollback", "settings"]) {
        const res = await POST(req("POST", "/api/admin/provider-keys", { action, provider: "treg", key: fakeKey("x"), lowBalanceThresholdUsd: 5 }));
        expect(res.status).toBe(403);
      }
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.rpcCalls).toHaveLength(0);
    expect(store.settings.size).toBe(0);
  });

  it("the legacy providers route no longer accepts secrets at all", async () => {
    const before = process.env.TREG_TOKEN;
    const res = await legacyPost(req("POST", "/api/admin/providers", { updates: [{ key: "TREG_TOKEN", value: fakeKey("legacy") }] }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/استبدال المفتاح/);
    expect(process.env.TREG_TOKEN).toBe(before);
    const res2 = await legacyPost(req("POST", "/api/admin/providers", { updates: [{ key: "ANTHROPIC_API_KEY", value: fakeKey("legacy2") }] }));
    expect(res2.status).toBe(400);
  });
});

describe("/api/admin/provider-keys for an admin", () => {
  it("replace uses the verified session id, never one from the body, and audits last4 only", async () => {
    const fresh = fakeKey("fresh");
    const res = await POST(req("POST", "/api/admin/provider-keys", { action: "replace", provider: "treg", key: fresh, adminId: "attacker", p_admin_id: "attacker" }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ success: true });
    expect(store.rpcCalls[0].args.p_admin_id).toBe("admin-1");
    const auditRows = store.inserted.filter((i) => i.table === "admin_audit_log");
    expect(auditRows).toHaveLength(1);
    expect(JSON.stringify(auditRows[0].row)).toContain(fresh.slice(-4));
    expect(JSON.stringify(auditRows[0].row)).not.toContain(fresh);
    expect(JSON.stringify(body)).not.toContain(fresh);
    expect(logs.text()).not.toContain(fresh);
  });

  it("a rejected key returns the Arabic reason under `error` and saves nothing", async () => {
    store.seed("treg", fakeKey("old"));
    fetchMock.mockImplementation(async () => new Response("{}", { status: 401 }));
    const bad = fakeKey("bad");
    const res = await POST(req("POST", "/api/admin/provider-keys", { action: "replace", provider: "treg", key: bad }));
    const body = await res.json();
    expect(res.status).toBe(422);
    expect(body.error).toMatch(/رفض المزود/);
    expect(JSON.stringify(body)).not.toContain(bad);
    expect(store.rpcCalls).toHaveLength(0);
    expect(store.inserted.filter((i) => i.table === "admin_audit_log")).toHaveLength(0);
  });

  it("GET returns the masked tab state with the real check and never the key", async () => {
    const key = fakeKey("view");
    store.seed("treg", key);
    const res = await GET(req("GET", "/api/admin/provider-keys?provider=treg&refresh=1"));
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toContain(key);
    expect(text).not.toContain(key.slice(-5));
    expect(JSON.parse(text).state).toMatchObject({ provider: "treg", keySource: "store", status: { health: { ok: true }, balance: { available: true, balanceUsd: 0.7 } } });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects unknown providers and actions", async () => {
    expect((await GET(req("GET", "/api/admin/provider-keys?provider=openai"))).status).toBe(400);
    expect((await POST(req("POST", "/api/admin/provider-keys", { action: "replace", provider: "openai", key: fakeKey("x") }))).status).toBe(400);
    expect((await POST(req("POST", "/api/admin/provider-keys", { action: "delete", provider: "treg" }))).status).toBe(400);
    expect((await POST(req("POST", "/api/admin/provider-keys", { action: "settings", provider: "anthropic", lowBalanceThresholdUsd: 1 }))).status).toBe(400);
  });

  it("saves the low-balance threshold and team id with validation", async () => {
    const bad = await POST(req("POST", "/api/admin/provider-keys", { action: "settings", provider: "treg", lowBalanceThresholdUsd: -3 }));
    expect(bad.status).toBe(400);
    const badOrg = await POST(req("POST", "/api/admin/provider-keys", { action: "settings", provider: "treg", tregOrgId: "../x" }));
    expect(badOrg.status).toBe(400);
    const ok = await POST(req("POST", "/api/admin/provider-keys", { action: "settings", provider: "treg", lowBalanceThresholdUsd: "٠٫٥".replace("٫", ".") , tregOrgId: "42" }));
    expect(ok.status).toBe(200);
    expect(store.settings.get("provider_keys")).toMatchObject({ lowBalanceThresholdUsd: 0.5, tregOrgId: "42" });
  });
});
