import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureConsole, fakeKey, fakeKeyStore, mockProviderFetch, newEncryptionKey } from "./helpers/providerKeyTestKit";

const state = vi.hoisted(() => ({ user: null as any, adminClient: null as any }));

vi.mock("../src/lib/supabase/server", () => ({
  createServerSideClient: vi.fn(async () => ({ auth: { getUser: vi.fn(async () => ({ data: { user: state.user }, error: null })) } })),
  createAdminClient: vi.fn(() => state.adminClient),
}));

import { GET as keysGet } from "../src/app/api/admin/provider-keys/route";
import { GET as balanceGet } from "../src/app/api/admin/provider-balance/route";
import { AccountEmailLine, ACCOUNT_EMAIL_UNAVAILABLE_AR } from "../src/components/admin/ProviderTab";
import { loadProviderTabState } from "../src/lib/server/providerKeyAdmin";
import { __setProviderKeyStoreForTests, resetProviderKeyCache } from "../src/lib/server/providerKeys";
import { extractProviderAccountEmail, getProviderAccountEmail, getProviderStatus, invalidateProviderStatusCache, resetLastGoodProviderBalanceForTests } from "../src/lib/server/providerStatus";
import { readRealProviderBalance } from "../src/lib/server/realProviderBalance";

const EMAIL = "owner.account@example.com";
const ADMIN = { id: "admin-1", email: "a@t", app_metadata: { role: "admin" }, user_metadata: { name: "مدير" } };
const req = (url: string) => new NextRequest(`http://localhost${url}`, { method: "GET" });

const answer = (identity: Record<string, unknown>, balance: Record<string, unknown> = { balance_micro: 918_640 }) => mockProviderFetch((url) =>
  url.endsWith("/auth/me") ? { status: 200, body: { org_id: "org_1", ...identity } } : { status: 200, body: balance });

let logs: ReturnType<typeof captureConsole>;
let store: ReturnType<typeof fakeKeyStore>;

beforeEach(() => {
  vi.stubEnv("PROVIDER_KEYS_ENCRYPTION_KEY", newEncryptionKey());
  vi.stubEnv("TREG_TOKEN", "");
  vi.stubEnv("TREG_API_KEY", "");
  store = fakeKeyStore({ admins: ["admin-1"] });
  state.adminClient = store.client;
  state.user = ADMIN;
  __setProviderKeyStoreForTests(store.client);
  invalidateProviderStatusCache();
  resetLastGoodProviderBalanceForTests();
  logs = captureConsole();
});
afterEach(() => {
  logs.restore();
  __setProviderKeyStoreForTests(null);
  resetProviderKeyCache();
  invalidateProviderStatusCache();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("the e-mail is read only from the places an identity answer puts the signed-in account", () => {
  it("the account's own address in the usual places", () => {
    for (const body of [{ email: EMAIL }, { user: { email: EMAIL } }, { account: { email: EMAIL } }, { me: { email: EMAIL } }, { profile: { email: EMAIL } }, { data: { user: { email: EMAIL } } }, { owner: { email: ` ${EMAIL} ` } }]) {
      expect(extractProviderAccountEmail(body), JSON.stringify(body)).toBe(EMAIL);
    }
  });

  it("never a guess: a list of members, a name, an id or a malformed address gives nothing", () => {
    expect(extractProviderAccountEmail({ orgs: [{ id: "o", members: [{ email: "someone.else@example.com" }] }] })).toBeNull();
    expect(extractProviderAccountEmail({ username: "owner", name: "Owner", id: "42", org_id: "o1" })).toBeNull();
    for (const bad of ["not-an-email", "a@b", "x@y.z", "<script>@x.com", "two words@x.com", "", 42, null]) expect(extractProviderAccountEmail({ email: bad }), String(bad)).toBeNull();
    expect(extractProviderAccountEmail(null)).toBeNull();
    expect(extractProviderAccountEmail("owner@example.com")).toBeNull();
  });
});

describe("the admin tab state carries it, beside the real balance", () => {
  it("from the identity answer; the team id stays its own field", async () => {
    store.seed("treg", fakeKey("view"));
    const f = answer({ email: EMAIL });
    const tab = await loadProviderTabState({ client: store.client, fetchFn: f.fn }, "treg", { forceRefresh: true });
    expect(tab.accountEmail).toBe(EMAIL);
    expect(tab.status.balance).toMatchObject({ available: true, balanceUsd: 0.91864, orgId: "org_1" });
    expect(tab.settings.tregOrgId).not.toBe(EMAIL);
    expect(JSON.stringify(tab.status)).not.toContain(EMAIL);
  });

  it("from the balance answer when the identity answer has none", async () => {
    store.seed("treg", fakeKey("view"));
    const tab = await loadProviderTabState({ client: store.client, fetchFn: answer({}, { balance_micro: 918_640, account: { email: EMAIL } }).fn }, "treg", { forceRefresh: true });
    expect(tab.accountEmail).toBe(EMAIL);
  });

  it("a provider answer without an e-mail: null, and the tab shows the fallback sentence", async () => {
    store.seed("treg", fakeKey("view"));
    const tab = await loadProviderTabState({ client: store.client, fetchFn: answer({}).fn }, "treg", { forceRefresh: true });
    expect(tab.accountEmail).toBeNull();
    const html = renderToStaticMarkup(createElement(AccountEmailLine, { email: tab.accountEmail }));
    expect(html).toContain("الإيميل غير متاح من المزود");
    expect(ACCOUNT_EMAIL_UNAVAILABLE_AR).toBe("الإيميل غير متاح من المزود");
    expect(html).not.toContain("@");
  });

  it("the line shows the address left-to-right when there is one", () => {
    const html = renderToStaticMarkup(createElement(AccountEmailLine, { email: EMAIL }));
    expect(html).toContain(EMAIL);
    expect(html).toContain('dir="ltr"');
    expect(html).not.toContain("الإيميل غير متاح من المزود");
  });

  it("a failed check shows no e-mail, and the model provider has none", async () => {
    store.seed("treg", fakeKey("view"));
    await loadProviderTabState({ client: store.client, fetchFn: answer({ email: EMAIL }).fn }, "treg", { forceRefresh: true });
    expect(getProviderAccountEmail("treg")).toBe(EMAIL);
    const failing = mockProviderFetch(() => ({ status: 500 }));
    const tab = await loadProviderTabState({ client: store.client, fetchFn: failing.fn }, "treg", { forceRefresh: true });
    expect(tab.accountEmail).toBeNull();
    vi.stubEnv("ANTHROPIC_API_KEY", fakeKey("llm"));
    const llm = await loadProviderTabState({ client: store.client, fetchFn: answer({ email: EMAIL }).fn }, "anthropic", { forceRefresh: true });
    expect(llm.accountEmail).toBeNull();
  });
});

describe("the routes that return it are admin-only", () => {
  const stubProvider = (identity: Record<string, unknown>) => {
    const f = answer(identity);
    vi.stubGlobal("fetch", f.mock);
    store.seed("treg", fakeKey("route"));
  };

  it("an admin sees it on the provider tab route and on the balance route", async () => {
    stubProvider({ email: EMAIL });
    const keys = await keysGet(req("/api/admin/provider-keys?provider=treg&refresh=1"));
    expect(keys.status).toBe(200);
    expect((await keys.json()).state.accountEmail).toBe(EMAIL);
    const balance = await balanceGet(req("/api/admin/provider-balance?refresh=true"));
    expect(balance.status).toBe(200);
    const body = await balance.json();
    expect(body.account_email).toBe(EMAIL);
    expect(body.real_balance).toMatchObject({ available: true, balance_micro: 918_640 });
  });

  it("a signed-out caller and a non-admin never get it, on any verb, even right after an admin loaded it", async () => {
    stubProvider({ email: EMAIL });
    expect((await keysGet(req("/api/admin/provider-keys?provider=treg&refresh=1"))).status).toBe(200);
    const leaked: string[] = [];
    for (const user of [null, { id: "u1", email: "u@t", app_metadata: {} }, { id: "u2", email: "v@t", app_metadata: { role: "user" } }]) {
      state.user = user;
      for (const call of [() => keysGet(req("/api/admin/provider-keys?provider=treg")), () => keysGet(req("/api/admin/provider-keys?provider=treg&refresh=1")), () => balanceGet(req("/api/admin/provider-balance")), () => balanceGet(req("/api/admin/provider-balance?refresh=true"))]) {
        const res = await call();
        expect([401, 403]).toContain(res.status);
        leaked.push(await res.text());
      }
    }
    expect(leaked.join("\n")).not.toContain(EMAIL);
    expect(leaked.join("\n")).not.toMatch(/account_?email/i);
  });

  it("only the admin routes read it: no other source file mentions the reader", () => {
    const files: string[] = [];
    const walk = (dir: string) => { for (const name of readdirSync(dir)) { const full = path.join(dir, name); if (statSync(full).isDirectory()) walk(full); else if (/\.(ts|tsx)$/.test(name)) files.push(full); } };
    walk(path.resolve(__dirname, "../src"));
    const users = files.filter((file) => /getProviderAccountEmail/.test(readFileSync(file, "utf8"))).map((file) => path.relative(path.resolve(__dirname, ".."), file).split(path.sep).join("/")).sort();
    expect(users).toEqual([
      "src/app/api/admin/provider-balance/route.ts",
      "src/lib/server/providerKeyAdmin.ts",
      "src/lib/server/providerStatus.ts",
    ]);
    const adminOnly = ["src/app/api/admin/provider-balance/route.ts", "src/app/api/admin/provider-keys/route.ts"].map((f) => readFileSync(path.resolve(__dirname, "..", f), "utf8"));
    for (const source of adminOnly) expect(source).toContain("authenticateAdmin");
  });
});

describe("the e-mail is kept in memory only and never written anywhere", () => {
  it("not in a log line, a database write, a saved setting or an audit row", async () => {
    store.seed("treg", fakeKey("quiet"));
    vi.stubGlobal("fetch", answer({ email: EMAIL }).mock);
    await keysGet(req("/api/admin/provider-keys?provider=treg&refresh=1"));
    await balanceGet(req("/api/admin/provider-balance?refresh=true"));
    await loadProviderTabState({ client: store.client, fetchFn: answer({ email: EMAIL }).fn }, "treg", { forceRefresh: true });
    expect(logs.text()).not.toContain(EMAIL);
    expect(JSON.stringify(store.inserted)).not.toContain(EMAIL);
    expect(JSON.stringify([...store.settings.entries()])).not.toContain(EMAIL);
    expect(JSON.stringify(store.rpcCalls)).not.toContain(EMAIL);
    expect(JSON.stringify([...store.rows.values()])).not.toContain(EMAIL);
  });

  it("the plan path's balance read and its reading never carry it", async () => {
    vi.stubEnv("TREG_TOKEN", "test-token");
    resetProviderKeyCache();
    const reading = await readRealProviderBalance(null, { fetchFn: answer({ email: EMAIL }).fn });
    expect(reading).toMatchObject({ usd: 0.91864 });
    expect(JSON.stringify(reading)).not.toContain(EMAIL);
    expect(logs.text()).not.toContain(EMAIL);
    const snapshot = await getProviderStatus("treg", "k", { fetchFn: answer({ email: EMAIL }).fn, forceRefresh: true });
    expect(JSON.stringify(snapshot)).not.toContain(EMAIL);
  });

  it("no job event, notification or customer-facing source mentions it: only the admin tab names the field", () => {
    const customerFacing = ["src/app/api/worker/chunk/route.ts", "src/lib/server/workerDispatch.ts", "src/functions/shared/chatHandler.ts", "src/app/dashboard/chat/page.tsx"]
      .map((f) => readFileSync(path.resolve(__dirname, "..", f), "utf8")).join("\n");
    expect(customerFacing).not.toMatch(/accountEmail|account_email|getProviderAccountEmail/);
  });
});
