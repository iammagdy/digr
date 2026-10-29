import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ADMIN, clock, fakeSecret, makePoolWorld, teardownPoolWorld } from "./helpers/tregPoolKit";
import { captureConsole, newEncryptionKey } from "./helpers/providerKeyTestKit";

const state = vi.hoisted(() => ({ user: null as any, client: null as any }));
vi.mock("../src/lib/supabase/server", () => ({
  createServerSideClient: vi.fn(async () => ({ auth: { getUser: vi.fn(async () => ({ data: { user: state.user }, error: null })) } })),
  createAdminClient: vi.fn(() => state.client),
}));

import { GET, POST } from "../src/app/api/admin/treg-keys/route";
import { __resetPoolLimiter, POOL_KEY_CHANGE_LIMIT, addPoolKey, adoptMainKey, loadPoolOverview, removePoolKey, replacePoolKey, setActivePoolKey, setPoolChain } from "../src/lib/server/tregPoolAdmin";
import { resetProviderKeyCache, __setProviderKeyStoreForTests } from "../src/lib/server/providerKeys";
import { decryptPoolKey } from "../src/lib/server/tregPoolCrypto";

/**
 * The admin side of the key pool: admin only (checked in the route AND inside every SQL function), a key is validated against the provider BEFORE it is saved, it is stored encrypted,
 * and no answer, audit line or log ever carries it. The main key can only be replaced; the key in use cannot be removed; the chain always ends at the main key.
 */
const ADMIN_USER = { id: ADMIN, email: "owner@example.test", app_metadata: { role: "admin" }, user_metadata: { name: "المدير" } };
const req = (method: string, body?: unknown, url = "/api/admin/treg-keys") => new NextRequest(`http://localhost${url}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const post = (body: unknown) => POST(req("POST", body));

let w: ReturnType<typeof makePoolWorld>;
let logs: ReturnType<typeof captureConsole>;
beforeEach(() => { w = makePoolWorld(); state.client = w.db.client; state.user = ADMIN_USER; logs = captureConsole(); __resetPoolLimiter(); resetProviderKeyCache(); vi.stubEnv("TREG_TOKEN", ""); vi.stubEnv("TREG_API_KEY", ""); });
afterEach(() => { logs.restore(); teardownPoolWorld(); __setProviderKeyStoreForTests(null); resetProviderKeyCache(); });

const deps = () => ({ client: w.db.client, pool: w.pool, fetchFn: w.treg.fetch as any, now: clock.now });
const bodies = new WeakMap<Response, string>();
/** The whole body of an answer as text (read once, remembered). */
const everything = async (res: Response) => { if (!bodies.has(res)) bodies.set(res, await res.text()); return bodies.get(res) as string; };
const jsonOf = async (res: Response) => JSON.parse(await everything(res));

describe("access: admin only", () => {
  it("signed out: 401; a customer: 403; nothing is read or written for them, and the refusal names nothing", async () => {
    w.addKey({ isMain: true });
    for (const user of [null, { id: "u1", email: "customer@example.com", app_metadata: {}, user_metadata: {} }]) {
      state.user = user;
      const results = [await GET(req("GET")), await post({ action: "set_rollout", on: true }), await post({ action: "add", label: "x", key: fakeSecret("x") })];
      expect(results.map((r) => r.status)).toEqual(user ? [403, 403, 403] : [401, 401, 401]);
      expect(await everything(results[0])).not.toMatch(/treg|key|مفتاح \d|last4/i);
    }
    expect(w.db.rpcLog).toHaveLength(0);
    expect(w.treg.requests).toHaveLength(0);
  });

  it("every SQL function also refuses a non-admin on its own (a route that forgot its check still cannot change the pool)", async () => {
    const main = w.addKey({ isMain: true });
    const rpc = (fn: string, args: Record<string, unknown>) => w.db.client.rpc(fn, args).then((r: any) => r.data?.error);
    expect(await rpc("admin_set_treg_rollout", { p_admin_id: "nobody", p_on: true })).toBe("not_admin");
    expect(await rpc("admin_set_treg_active_key", { p_admin_id: "nobody", p_key_id: main.id, p_force: false })).toBe("not_admin");
    expect(await rpc("admin_remove_treg_pool_key", { p_admin_id: "nobody", p_key_id: main.id })).toBe("not_admin");
    expect(await rpc("admin_set_treg_chain", { p_admin_id: "nobody", p_ordered: [] })).toBe("not_admin");
    expect(w.db.state.rollout_on).toBe(false);
  });

  it("an unknown action and a bad body are 400", async () => {
    expect((await post({ action: "drop_everything" })).status).toBe(400);
    expect((await post({ action: "set_rollout", on: "yes" })).status).toBe(400);
    expect((await post({ action: "set_chain", orderedIds: "x" })).status).toBe(400);
    expect((await post({ action: "set_active", keyId: "not-a-uuid" })).status).toBe(400);
  });
});

describe("adding a key: checked with the provider first, stored encrypted, never echoed", () => {
  it("a good key is saved: encrypted with the Vault key (bound to its row), the e-mail and balance read from the provider, last 4 shown, an audit line without the key", async () => {
    const secret = fakeSecret("new"); w.treg.set(secret, { balanceMicro: 950_000, email: "t1@example.test" });
    const res = await post({ action: "add", label: "اختبار-١", key: secret });
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body).toMatchObject({ success: true, number: 1, last4: secret.slice(-4) });
    const row = w.db.live()[0];
    expect(row.ciphertext).not.toContain(secret);
    expect(decryptPoolKey(w.db.encKey, row.id, row.ciphertext as string)).toBe(secret);
    expect(row).toMatchObject({ label: "اختبار-١", account_email: "t1@example.test", status: "connected", balance_micro: 950_000, last4: secret.slice(-4) });
    // the whole exchange never carries the key or its ciphertext
    const seen = [await everything(res), logs.text(), JSON.stringify(w.db.events), JSON.stringify(w.db.alerts)].join("\n");
    expect(seen).not.toContain(secret);
    expect(seen).not.toContain(row.ciphertext as string);
  });

  it("a key TREG rejects is NOT saved; an unreachable provider saves nothing; a malformed value is refused before any call", async () => {
    const bad = fakeSecret("bad"); w.treg.set(bad, { mode: "revoked" });
    expect((await addPoolKey(deps(), { adminId: ADMIN, label: "x", key: bad }))).toMatchObject({ ok: false, reason: "rejected" });
    const slow = fakeSecret("slow"); w.treg.set(slow, { meMode: "http503" });
    expect((await addPoolKey(deps(), { adminId: ADMIN, label: "x", key: slow }))).toMatchObject({ ok: false, reason: "unreachable" });
    const calls = w.treg.requests.length;
    expect((await addPoolKey(deps(), { adminId: ADMIN, label: "x", key: "has space in it 12345" }))).toMatchObject({ ok: false, reason: "invalid_key" });
    expect((await addPoolKey(deps(), { adminId: ADMIN, label: "", key: fakeSecret("y") }))).toMatchObject({ ok: false, reason: "invalid_label" });
    expect(w.treg.requests.length).toBe(calls);
    expect(w.db.live()).toHaveLength(0);
  });

  it("the same key twice is refused; the Vault key unreadable refuses and saves nothing; too many attempts are slowed", async () => {
    const s = fakeSecret("dup"); w.treg.set(s, { email: "d@example.test" });
    expect((await addPoolKey(deps(), { adminId: ADMIN, label: "a", key: s })).ok).toBe(true);
    expect(await addPoolKey(deps(), { adminId: ADMIN, label: "b", key: s })).toMatchObject({ ok: false, reason: "duplicate" });
    // a process that already holds the Vault key keeps using it if a later read fails; one that never read it cannot encrypt and saves nothing
    const cold = makePoolWorld(); cold.db.flags.encMissing = true;
    const fresh = fakeSecret("fresh"); cold.treg.set(fresh);
    expect(await addPoolKey({ client: cold.db.client, pool: cold.pool, fetchFn: cold.treg.fetch as any, now: clock.now }, { adminId: ADMIN, label: "c", key: fresh })).toMatchObject({ ok: false, reason: "encryption_unavailable" });
    expect(cold.db.live()).toHaveLength(0);
    teardownPoolWorld(); w = makePoolWorld(); state.client = w.db.client;
    __resetPoolLimiter();
    let last: any;
    for (let i = 0; i < POOL_KEY_CHANGE_LIMIT.max + 1; i += 1) last = await addPoolKey(deps(), { adminId: ADMIN, label: "z", key: "x" + fakeSecret(String(i)) });
    expect(last).toMatchObject({ ok: false, reason: "rate_limited" });
  });
});

describe("the main key: adopted from today's key on the server, replaced but never removed", () => {
  it("«اعتماد المفتاح الحالي» copies today's key (here the environment key) into the pool without it appearing anywhere", async () => {
    const current = fakeSecret("current"); vi.stubEnv("TREG_TOKEN", current); w.treg.set(current, { balanceMicro: 4_000_000, email: "main@example.test" });
    const res = await post({ action: "adopt_main" });
    expect(res.status).toBe(200);
    const main = w.db.live()[0];
    expect(main).toMatchObject({ is_main: true, label: "الرئيسي", last4: current.slice(-4), status: "connected", balance_micro: 4_000_000 });
    expect(decryptPoolKey(w.db.encKey, main.id, main.ciphertext as string)).toBe(current);
    expect([await everything(res), logs.text()].join("\n")).not.toContain(current);
    expect(await adoptMainKey(deps(), { adminId: ADMIN })).toMatchObject({ ok: false, reason: "main_exists" });
  });

  it("with no current key, adoption says so; the key can be pasted instead", async () => {
    expect(await adoptMainKey(deps(), { adminId: ADMIN })).toMatchObject({ ok: false, reason: "no_current_key" });
    const s = fakeSecret("pasted"); w.treg.set(s);
    expect(await adoptMainKey(deps(), { adminId: ADMIN, key: s })).toMatchObject({ ok: true });
  });

  it("the main key can only be replaced: removal is refused, replacement keeps its number and place", async () => {
    const main = w.addKey({ isMain: true });
    expect(await removePoolKey(deps(), { adminId: ADMIN, keyId: main.id })).toMatchObject({ ok: false, reason: "main_cannot_be_removed" });
    const next = fakeSecret("main2"); w.treg.set(next);
    expect(await replacePoolKey(deps(), { adminId: ADMIN, keyId: main.id, key: next })).toMatchObject({ ok: true });
    const row = w.db.byId(main.id)!;
    expect(row).toMatchObject({ number: main.number, is_main: true, last4: next.slice(-4), status: "connected" });
    expect(decryptPoolKey(w.db.encKey, main.id, row.ciphertext as string)).toBe(next);
  });

  it("replacing with a key the provider rejects keeps the old one", async () => {
    const main = w.addKey({ isMain: true }); const bad = fakeSecret("bad"); w.treg.set(bad, { mode: "revoked" });
    expect(await replacePoolKey(deps(), { adminId: ADMIN, keyId: main.id, key: bad })).toMatchObject({ ok: false, reason: "rejected" });
    expect(decryptPoolKey(w.db.encKey, main.id, w.db.byId(main.id)!.ciphertext as string)).toBe(main.plaintext);
  });
});

describe("removing, activating and ordering", () => {
  it("the key in use cannot be removed until another is active; a removed key's secret is erased and its number is never reused", async () => {
    w.addKey({ isMain: true }); const a = w.addKey(); const b = w.addKey(); w.switchOn(a.id);
    expect(await removePoolKey(deps(), { adminId: ADMIN, keyId: a.id })).toMatchObject({ ok: false, reason: "key_in_use" });
    expect((await setActivePoolKey(deps(), { adminId: ADMIN, keyId: b.id })).ok).toBe(true);
    expect((await removePoolKey(deps(), { adminId: ADMIN, keyId: a.id })).ok).toBe(true);
    expect(w.db.keys.find((k) => k.id === a.id)).toMatchObject({ removed: true, ciphertext: null });
    const s = fakeSecret("n"); w.treg.set(s);
    expect((await addPoolKey(deps(), { adminId: ADMIN, label: "n", key: s })).number).toBe(4);
  });

  it("a revoked or empty key is activated only with an explicit force", async () => {
    w.addKey({ isMain: true }); const dead = w.addKey({ status: "revoked" });
    expect(await setActivePoolKey(deps(), { adminId: ADMIN, keyId: dead.id })).toMatchObject({ ok: false, reason: "key_not_usable" });
    expect(await setActivePoolKey(deps(), { adminId: ADMIN, keyId: dead.id, force: true })).toMatchObject({ ok: true });
  });

  it("the chain: the admin's order is saved, the main key stays last and cannot be listed, a key left out leaves the chain", async () => {
    const main = w.addKey({ isMain: true }); const a = w.addKey(); const b = w.addKey(); const c = w.addKey();
    expect((await setPoolChain(deps(), { adminId: ADMIN, orderedIds: [c.id, a.id] })).ok).toBe(true);
    const order = w.db.ordered(w.db.live().filter((k) => k.in_chain)).map((k) => k.number);
    expect(order).toEqual([c.number, a.number, main.number]);
    expect(w.db.byId(b.id)?.in_chain).toBe(false);
    expect(await setPoolChain(deps(), { adminId: ADMIN, orderedIds: [main.id] })).toMatchObject({ ok: false, reason: "invalid_chain" });
    expect(await setPoolChain(deps(), { adminId: ADMIN, orderedIds: [a.id, a.id] })).toMatchObject({ ok: false, reason: "invalid_chain" });
    expect(w.db.byId(main.id)?.in_chain).toBe(true);
  });
});

describe("the overview the screen reads", () => {
  it("numbered keys with label, e-mail, last 4, balance, status, last check, spend per key, the main mark and the active mark; never a key", async () => {
    const main = w.addKey({ isMain: true, balanceMicro: 12_400_000, email: "main@example.test" });
    const t1 = w.addKey({ label: "اختبار-١", balanceMicro: 910_000 }); const t2 = w.addKey({ status: "revoked" });
    w.switchOn(t1.id);
    w.db.client.rpc("treg_pool_record_call", { p_cost_id: 1, p_key_id: t1.id, p_source: "website" });
    w.db.client.rpc("treg_pool_record_call", { p_cost_id: 2, p_key_id: t1.id, p_source: "worker" });
    w.db.setCost(1, 0.04); w.db.setCost(2, 0.05);
    const ov = await loadPoolOverview(deps());
    expect(ov).toMatchObject({ ready: true, rolloutOn: true, activeKeyId: t1.id });
    expect(ov.keys.map((k) => [k.number, k.isMain, k.isActive, k.status])).toEqual([[main.number, true, false, "connected"], [t1.number, false, true, "connected"], [t2.number, false, false, "revoked"]]);
    expect(ov.keys[1]).toMatchObject({ label: "اختبار-١", last4: t1.plaintext.slice(-4), balanceUsd: 0.91, spend: { calls: 2, usd: 0.09 } });
    expect(ov.keys[0]).toMatchObject({ accountEmail: "main@example.test", balanceUsd: 12.4 });
    const text = JSON.stringify(ov);
    for (const k of [main, t1, t2]) { expect(text).not.toContain(k.plaintext); expect(text).not.toContain(k.row.ciphertext as string); }
  });

  it("warns when Heroku's TREG_TOKEN is not the main key, and when there is no main key yet; reports the SQL not applied", async () => {
    const main = w.addKey({ isMain: true });
    w.db.state.worker_env_last4 = "zzzz";
    const ov = await loadPoolOverview(deps());
    expect(ov.workerMismatch).toBe(true);
    expect(ov.noticesAr.join(" ")).toContain("TREG_TOKEN");
    expect(ov.noticesAr.join(" ")).toContain(main.plaintext.slice(-4));
    w.db.flags.missingFunctions = true;
    expect(await loadPoolOverview(deps())).toMatchObject({ ready: false });
    w.db.flags.missingFunctions = false; w.db.keys.length = 0; w.db.state.worker_env_last4 = null;
    expect((await loadPoolOverview(deps())).noticesAr.join(" ")).toContain("اعتماد المفتاح الحالي");
  });

  it("«فحص الآن» refreshes balances live and reports it", async () => {
    const k = w.addKey({ isMain: true, balanceMicro: 1_000_000 });
    w.treg.set(k.plaintext, { balanceMicro: 250_000 });
    const ov = await loadPoolOverview(deps(), { refresh: true });
    expect(ov.keys[0].balanceUsd).toBe(0.25);
    expect(ov.health).toMatchObject({ ok: true, checked: 1 });
  });
});

describe("the route end to end", () => {
  it("add, activate, switch on: every answer is a short Arabic message and no key", async () => {
    const main = fakeSecret("main"); const t1 = fakeSecret("t1"); w.treg.set(main); w.treg.set(t1);
    vi.stubEnv("TREG_TOKEN", main);
    const answers = [await post({ action: "adopt_main" }), await post({ action: "add", label: "اختبار-١", key: t1 })];
    const ids = w.db.live().map((k) => k.id);
    answers.push(await post({ action: "set_rollout", on: true }), await post({ action: "set_active", keyId: ids[1] }), await GET(req("GET")));
    expect(answers.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    const answerBodies = await Promise.all(answers.map(everything));
    expect(w.db.state).toMatchObject({ rollout_on: true, active_key_id: ids[1] });
    const all = answerBodies.join("\n") + logs.text();
    expect(all).not.toContain(main); expect(all).not.toContain(t1);
    expect(JSON.parse(answerBodies[3]).message).toContain("فُعّل المفتاح");
  });

  it("a key travels only in the body of add, adopt and replace; the GET carries last 4 at most", async () => {
    const s = fakeSecret("only"); w.treg.set(s);
    await post({ action: "add", label: "a", key: s });
    const getRes = await GET(req("GET"));
    const ov = await jsonOf(getRes);
    expect(await everything(getRes)).not.toContain(s);
    expect(ov.overview.keys[0].last4).toBe(s.slice(-4));
    // an encryption key of the old kind plays no part: the pool reads its own from Vault
    expect(newEncryptionKey()).not.toBe(w.db.encKey);
  });
});
