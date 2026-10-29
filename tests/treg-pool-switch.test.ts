import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeTregCall } from "../src/functions/shared/tregClient";
import { getProviderStatus, lastGoodProviderBalance } from "../src/lib/server/providerStatus";
import { peekProviderKey, resetProviderKeyCache, resolveProviderKey } from "../src/lib/server/providerKeys";
import { POOL_SNAPSHOT_TTL_MS, POOL_STALE_GRACE_MS } from "../src/lib/server/tregKeyPool";
import { setActivePoolKey, setPoolRollout } from "../src/lib/server/tregPoolAdmin";
import { ADMIN, callOptions, clock, fakeSecret, makePoolWorld, teardownPoolWorld } from "./helpers/tregPoolKit";
import { captureConsole } from "./helpers/providerKeyTestKit";

/**
 * The TREG key pool at call time: rollout OFF is exactly today, ON follows the admin's active key within the 3-second view, a mission goes on with the new key from its
 * next call, and when the pool cannot be read the main key from the environment is used (never a non-main key after the grace window). Fake database, fake TREG, fake clock.
 */
let logs: ReturnType<typeof captureConsole>;
beforeEach(() => { resetProviderKeyCache(); logs = captureConsole(); });
afterEach(() => { logs.restore(); teardownPoolWorld(); resetProviderKeyCache(); });

const headerOf = (w: ReturnType<typeof makePoolWorld>) => w.treg.tokensOfCalls();
/** The OFF state is today's behaviour: it opens no alert, logs no emergency and writes nothing. */
const expectQuiet = (w: ReturnType<typeof makePoolWorld>) => {
  expect(w.db.alerts).toEqual([]);
  expect(w.db.events).toEqual([]);
  expect(logs.lines.filter((l) => l.includes("[treg_pool:emergency]"))).toEqual([]);
  expect(w.db.rpcLog.map((r) => r.fn).filter((f) => !["treg_pool_runtime"].includes(f))).toEqual([]);
};

describe("rollout switch OFF is exactly today", () => {
  it("website: the legacy key (environment here) is used even though pool keys exist; no ciphertext is handed out and nothing is marked", async () => {
    const w = makePoolWorld();
    const legacy = fakeSecret("legacy"); vi.stubEnv("TREG_TOKEN", legacy); w.treg.set(legacy);
    const main = w.addKey({ isMain: true }); w.addKey();
    const r = await executeTregCall(callOptions());
    expect(r.ok).toBe(true);
    expect(headerOf(w)).toEqual([legacy]);
    expect(r.keyRef).toBeUndefined();
    const runtime = await w.db.client.rpc("treg_pool_runtime", {});
    expect(runtime.data.keys).toEqual([]);
    expect(main.plaintext).not.toBe(legacy);
    // OFF is not an emergency: no alert row, no emergency line, nothing recorded
    expectQuiet(w);
  });

  it("worker: TREG_TOKEN travels as legacyToken and is what the call carries", async () => {
    const w = makePoolWorld({ source: "worker" });
    const tokenFromHeroku = fakeSecret("heroku"); w.treg.set(tokenFromHeroku);
    w.addKey({ isMain: true });
    await executeTregCall(callOptions({ legacyToken: tokenFromHeroku }));
    expect(headerOf(w)).toEqual([tokenFromHeroku]);
    expectQuiet(w);
  });

  it("an explicit token option still wins over everything (tests, one-off tools)", async () => {
    const w = makePoolWorld();
    const a = w.addKey({ isMain: true }); w.switchOn(a.id);
    const explicit = fakeSecret("explicit"); w.treg.set(explicit);
    await executeTregCall(callOptions({ token: explicit, legacyToken: fakeSecret("ignored") }));
    expect(headerOf(w)).toEqual([explicit]);
  });

  it("the pool SQL not applied (function missing) means OFF, with one non-secret log line", async () => {
    const w = makePoolWorld({ source: "worker" });
    w.db.flags.missingFunctions = true;
    const legacy = fakeSecret("heroku"); w.treg.set(legacy);
    await executeTregCall(callOptions({ legacyToken: legacy }));
    await executeTregCall(callOptions({ legacyToken: legacy }));
    expect(headerOf(w)).toEqual([legacy, legacy]);
    expect(logs.lines.filter((l) => l.includes("[treg_pool:not_ready]"))).toHaveLength(1);
  });
});

describe("rollout switch ON: the active key, switched at once", () => {
  it("the call carries the active key and its number and label (never the key) on the result", async () => {
    const w = makePoolWorld();
    const main = w.addKey({ isMain: true }); const t1 = w.addKey({ label: "اختبار-١" });
    w.switchOn(t1.id);
    const r = await executeTregCall(callOptions());
    expect(headerOf(w)).toEqual([t1.plaintext]);
    expect(r.keyRef).toEqual({ id: t1.id, number: t1.number, label: "اختبار-١", isMain: false });
    expect(JSON.stringify(r)).not.toContain(t1.plaintext);
    expect(main.plaintext).not.toBe(t1.plaintext);
    const resolved = await resolveProviderKey("treg");
    expect(resolved).toMatchObject({ source: "pool", key: t1.plaintext, keyRef: { number: t1.number } });
    expect(peekProviderKey("treg")).toBe(t1.plaintext);
  });

  it("the admin's switch is live on the same server at once, and on another server within the 3-second view", async () => {
    const w = makePoolWorld();
    const main = w.addKey({ isMain: true }); const t1 = w.addKey(); const t2 = w.addKey();
    w.switchOn(t1.id);
    await executeTregCall(callOptions());
    // another server instance: the database changes behind its cached view
    w.db.client.rpc("admin_set_treg_active_key", { p_admin_id: ADMIN, p_key_id: t2.id, p_force: false });
    await executeTregCall(callOptions());
    expect(headerOf(w)).toEqual([t1.plaintext, t1.plaintext]); // still inside the view
    clock.advance(POOL_SNAPSHOT_TTL_MS + 100);
    await executeTregCall(callOptions());
    expect(headerOf(w)[2]).toBe(t2.plaintext);
    // the server that took the admin's click sees it at once
    const r = await setActivePoolKey({ client: w.db.client, pool: w.pool }, { adminId: ADMIN, keyId: main.id });
    expect(r.ok).toBe(true);
    await executeTregCall(callOptions());
    expect(headerOf(w)[3]).toBe(main.plaintext);
  });

  it("worker: a mission in progress goes on with the new key from its next call, no restart", async () => {
    const w = makePoolWorld({ source: "worker" });
    const heroku = fakeSecret("heroku"); w.treg.set(heroku);
    const main = w.addKey({ isMain: true }); const t1 = w.addKey(); const t2 = w.addKey();
    w.switchOn(t1.id);
    const call = () => executeTregCall(callOptions({ legacyToken: heroku, jobId: "agent_msn_1" }));
    await call(); await call();
    await w.db.client.rpc("admin_set_treg_active_key", { p_admin_id: ADMIN, p_key_id: t2.id, p_force: false });
    clock.advance(POOL_SNAPSHOT_TTL_MS + 100);
    await call(); await call();
    expect(headerOf(w)).toEqual([t1.plaintext, t1.plaintext, t2.plaintext, t2.plaintext]);
    expect(headerOf(w)).not.toContain(heroku);
    expect(main.plaintext).not.toBe(t1.plaintext);
  });

  it("turning the switch OFF restores the legacy keys within the view, on the website and on the worker", async () => {
    const website = makePoolWorld();
    const legacy = fakeSecret("legacy"); vi.stubEnv("TREG_TOKEN", legacy); website.treg.set(legacy);
    const a = website.addKey({ isMain: true }); website.switchOn(a.id);
    await executeTregCall(callOptions());
    expect((await setPoolRollout({ client: website.db.client, pool: website.pool }, { adminId: ADMIN, on: false })).ok).toBe(true);
    await executeTregCall(callOptions());
    expect(headerOf(website)).toEqual([a.plaintext, legacy]);
    teardownPoolWorld();

    const worker = makePoolWorld({ source: "worker" });
    const heroku = fakeSecret("heroku"); worker.treg.set(heroku);
    const b = worker.addKey({ isMain: true }); worker.switchOn(b.id);
    await executeTregCall(callOptions({ legacyToken: heroku }));
    worker.db.state.rollout_on = false;
    clock.advance(POOL_SNAPSHOT_TTL_MS + 100);
    await executeTregCall(callOptions({ legacyToken: heroku }));
    expect(headerOf(worker)).toEqual([b.plaintext, heroku]);
    expect(worker.db.alerts).toEqual([]);
  });

  it("the rollout cannot be turned ON without a main key", async () => {
    const w = makePoolWorld();
    w.addKey();
    const r = await setPoolRollout({ client: w.db.client, pool: w.pool }, { adminId: ADMIN, on: true });
    expect(r).toMatchObject({ ok: false, reason: "no_main_key" });
    expect(w.db.state.rollout_on).toBe(false);
  });
});

describe("the pool cannot be read: the main key from the environment, never a non-main key silently", () => {
  it("the database goes away: the admin's active key is kept for the 30-second grace, then TREG_TOKEN is used, the admin is told once, and the notice reaches the database when it is back", async () => {
    const notices: string[] = [];
    const w = makePoolWorld({ source: "worker", onEmergency: (i) => { notices.push(i.reason); } });
    const heroku = fakeSecret("heroku"); w.treg.set(heroku);
    const main = w.addKey({ isMain: true }); const t1 = w.addKey();
    w.switchOn(t1.id);
    const call = () => executeTregCall(callOptions({ legacyToken: heroku }));
    await call();
    w.db.flags.down = true;
    clock.advance(POOL_SNAPSHOT_TTL_MS + 100);
    await call(); // inside the grace: the admin's own active key
    clock.advance(POOL_STALE_GRACE_MS + 1000);
    await call(); await call();
    expect(headerOf(w)).toEqual([t1.plaintext, t1.plaintext, heroku, heroku]);
    expect(headerOf(w)).not.toContain(main.plaintext);
    expect(notices).toHaveLength(1);
    expect(w.db.alerts).toHaveLength(0); // the database is down: queued in memory
    w.db.flags.down = false;
    clock.advance(2000);
    await call();
    expect(w.db.alerts.map((a) => a.problem)).toEqual(["store_unreadable"]);
    expect(headerOf(w)[4]).toBe(t1.plaintext); // readable again: back on the active key
  });

  it("the Vault key cannot be read or the active key does not decrypt: TREG_TOKEN is used and the alert row is opened at once", async () => {
    const w = makePoolWorld({ source: "worker" });
    const heroku = fakeSecret("heroku"); w.treg.set(heroku);
    const t1 = w.addKey(); w.addKey({ isMain: true });
    w.switchOn(t1.id);
    w.db.flags.encMissing = true;
    await executeTregCall(callOptions({ legacyToken: heroku }));
    expect(headerOf(w)).toEqual([heroku]);
    expect(w.db.alerts.map((a) => [a.problem, a.reason])).toEqual([["store_unreadable", "encryption_key_missing"]]);
  });

  it("never known to be ON and the database is down at the start: behaves exactly as today, no alert", async () => {
    const w = makePoolWorld({ source: "worker" });
    w.db.flags.down = true;
    const heroku = fakeSecret("heroku"); w.treg.set(heroku);
    await executeTregCall(callOptions({ legacyToken: heroku }));
    expect(headerOf(w)).toEqual([heroku]);
    expect(w.db.alerts).toHaveLength(0);
  });
});

describe("a switch of the active key never reuses the old key's readings, and no key reaches a log", () => {
  it("the provider status cache and the last good balance belong to the key that was read", async () => {
    const w = makePoolWorld();
    const a = w.addKey({ isMain: true, balanceMicro: 5_000_000 }); const b = w.addKey({ balanceMicro: 900_000 });
    const sa = await getProviderStatus("treg", a.plaintext, { fetchFn: w.treg.fetch as any });
    const sb = await getProviderStatus("treg", b.plaintext, { fetchFn: w.treg.fetch as any });
    expect(sa.balance.balanceUsd).toBe(5);
    expect(sb.balance.balanceUsd).toBeCloseTo(0.9, 6);
    expect(lastGoodProviderBalance(a.plaintext)).toBeNull(); // the last good reading is b's
    expect(lastGoodProviderBalance(b.plaintext)?.balanceMicro).toBe(900_000);
  });

  it("no log line of any of these paths contains a key", async () => {
    const w = makePoolWorld();
    const a = w.addKey({ isMain: true }); const b = w.addKey(); w.switchOn(b.id);
    w.treg.set(b.plaintext, { mode: "revoked" });
    await executeTregCall(callOptions());
    for (const k of [a, b]) {
      expect(logs.text()).not.toContain(k.plaintext);
      expect(logs.text()).not.toContain(k.row.ciphertext as string);
    }
  });
});
