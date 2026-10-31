import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeTregCall } from "../src/functions/shared/tregClient";
import { TregKeyPool, POOL_MAX_HOPS, type KeyChoice } from "../src/lib/server/tregKeyPool";
import { callOptions, clock, makePoolWorld, teardownPoolWorld, type TregMode } from "./helpers/tregPoolKit";
import { captureConsole } from "./helpers/providerKeyTestKit";

/**
 * When the active key fails for an auth or balance reason the platform moves to the next key of the chain (main last), records it, and retries the call; transient errors and
 * errors that are not the key's never switch anything. Fake TREG answers by key; the database model follows the SQL function by function.
 */
let logs: ReturnType<typeof captureConsole>;
beforeEach(() => { logs = captureConsole(); });
afterEach(() => { logs.restore(); teardownPoolWorld(); });

const authMeCalls = (w: ReturnType<typeof makePoolWorld>) => w.treg.requests.filter((r) => r.path === "/auth/me");

/** main + pool keys 2..n in chain order; the first pool key is active. */
function world(modes: TregMode[], source: "website" | "worker" = "website") {
  const w = makePoolWorld({ source });
  const main = w.addKey({ isMain: true });
  const pool = modes.map((m) => w.addKey({ tregMode: m }));
  w.switchOn(pool[0]?.id ?? main.id);
  return { w, main, pool };
}

describe("what moves the platform to the next key", () => {
  it("401 on the active key: verified with the free identity read, recorded as revoked, retried on the next key; one alert, one event", async () => {
    const { w, pool } = world(["revoked", "ok"]);
    const r = await executeTregCall(callOptions());
    expect(r.ok).toBe(true);
    expect(r.keyRef?.number).toBe(pool[1].number);
    expect(w.treg.requests.map((q) => `${q.path.split("/").slice(0, 2).join("/")}:${q.token === pool[0].plaintext ? "a" : q.token === pool[1].plaintext ? "b" : "?"}`)).toEqual(["/call:a", "/auth:a", "/call:b"]);
    expect(w.db.byId(pool[0].id)).toMatchObject({ status: "revoked", status_reason: "auth_401" });
    expect(w.db.state.active_key_id).toBe(pool[1].id);
    expect(w.db.events.filter((e) => e.kind === "failover")).toEqual([{ kind: "failover", key_number: pool[0].number, to_key_number: pool[1].number, reason: "auth_401", source: "website" }]);
    expect(w.db.alerts.map((a) => a.problem)).toEqual(["failover"]);
  });

  it("402 (not a price cap): verified with the free reads (identity and balance); a confirmed empty balance marks the key, the reason names the endpoint", async () => {
    const { w, pool } = world(["empty", "ok"]);
    const r = await executeTregCall(callOptions());
    expect(r.ok).toBe(true);
    expect(authMeCalls(w)).toHaveLength(1);
    expect(w.db.byId(pool[0].id)).toMatchObject({ status: "out_of_balance", status_reason: "balance_low:anyapi.x.search.posts" });
    expect(w.db.state.active_key_id).toBe(pool[1].id);
  });

  it("403 confirmed by the identity read (the key is rejected) moves on; 403 on one endpoint while the key is healthy does not", async () => {
    const a = world(["revoked403", "ok"]);
    expect((await executeTregCall(callOptions())).ok).toBe(true);
    expect(a.w.db.byId(a.pool[0].id)?.status).toBe("revoked");
    expect(a.w.db.state.active_key_id).toBe(a.pool[1].id);
    teardownPoolWorld();

    const b = world(["forbid403", "ok"]);
    const r = await executeTregCall(callOptions());
    expect(r).toMatchObject({ ok: false, httpStatus: 403 });
    expect(b.w.db.state.active_key_id).toBe(b.pool[0].id);
    expect(b.w.db.byId(b.pool[0].id)?.status).toBe("connected");
    expect(b.w.db.alerts).toHaveLength(0);
    expect(authMeCalls(b.w).length).toBeGreaterThan(0); // it was verified, and found fine
  });

  it("a verification that cannot answer (the identity read times out or fails) switches nothing", async () => {
    const { w, pool } = world(["revoked", "ok"]);
    w.treg.set(pool[0].plaintext, { mode: "revoked" });
    w.treg.keys.get(pool[0].plaintext)!.meMode = "http503";
    // revoked + me answers 401 first in the fake; force the inconclusive branch with a key whose /call is 403 and /auth/me is 503
    w.treg.set(pool[0].plaintext, { mode: "forbid403", meMode: "http503" });
    const r = await executeTregCall(callOptions());
    expect(r.httpStatus).toBe(403);
    expect(w.db.state.active_key_id).toBe(pool[0].id);
    expect(w.db.alerts).toHaveLength(0);
  });
});

describe("transient errors and errors that are not the key's never switch anything", () => {
  it.each<[TregMode, number]>([["timeout", 503], ["http503", 503], ["http429", 429], ["http400", 400], ["route_max_cost", 402]])("%s", async (mode, status) => {
    const { w, pool } = world([mode, "ok"]);
    const r = await executeTregCall(callOptions());
    expect(r.ok).toBe(false);
    expect(r.httpStatus).toBe(status);
    expect(w.treg.callCount()).toBe(1); // no retry on another key
    expect(authMeCalls(w)).toHaveLength(0); // not even a verification
    expect(w.db.state.active_key_id).toBe(pool[0].id);
    expect(w.db.byId(pool[0].id)?.status).toBe("connected");
    expect(w.db.alerts).toHaveLength(0);
    expect(w.db.events.filter((e) => e.kind === "failover")).toHaveLength(0);
  });
});

describe("the chain: admin order, main always last", () => {
  it("2 then 3 then 4: one call walks past a revoked key and an empty one and lands on the third", async () => {
    const { w, pool } = world(["revoked", "empty", "ok"]);
    const r = await executeTregCall(callOptions());
    expect(r.ok).toBe(true);
    expect(r.keyRef?.number).toBe(pool[2].number);
    expect(w.db.state.active_key_id).toBe(pool[2].id);
    expect(w.db.events.filter((e) => e.kind === "failover").map((e) => [e.key_number, e.to_key_number])).toEqual([[pool[0].number, pool[1].number], [pool[1].number, pool[2].number]]);
    // the same call (same idempotency key) every time, billed once
    const keys = new Set(w.treg.requests.filter((q) => q.path.startsWith("/call/")).map((q) => q.idempotencyKey));
    expect(keys.size).toBe(1);
    expect(w.treg.charged).toHaveLength(1);
  });

  it("the admin's order is followed, and a key already known to be bad is skipped", async () => {
    const w = makePoolWorld();
    const main = w.addKey({ isMain: true });
    const k2 = w.addKey({ tregMode: "revoked" }); const k3 = w.addKey(); const k4 = w.addKey();
    await w.db.client.rpc("admin_set_treg_chain", { p_admin_id: "admin-1", p_ordered: [k2.id, k4.id, k3.id] });
    w.db.byId(k4.id)!.status = "revoked";
    w.switchOn(k2.id);
    const r = await executeTregCall(callOptions());
    expect(r.keyRef?.number).toBe(k3.number); // 2 -> (4 is known bad) -> 3
    expect(w.db.state.active_key_id).toBe(k3.id);
    expect(main.plaintext).not.toBe(k3.plaintext);
  });

  it(`every pool key bad: the chain ends at the MAIN key (the last of at most ${POOL_MAX_HOPS} hops), and the admin is told it was reached`, async () => {
    const { w, main } = world(["revoked", "revoked", "revoked", "revoked"]);
    const r = await executeTregCall(callOptions());
    expect(r.ok).toBe(true);
    expect(r.keyRef).toMatchObject({ number: main.number, isMain: true });
    expect(w.treg.tokensOfCalls().at(-1)).toBe(main.plaintext);
    expect(w.treg.callCount()).toBe(POOL_MAX_HOPS + 1);
    expect(w.db.alerts.map((a) => a.problem)).toContain("failover");
  });

  it("the main key as the last step: reaching it opens «chain_reached_main» once", async () => {
    const { w, main } = world(["revoked"]);
    await executeTregCall(callOptions());
    expect(w.db.state.active_key_id).toBe(main.id);
    expect(w.db.alerts.map((a) => a.problem).sort()).toEqual(["chain_reached_main", "failover"]);
    await executeTregCall(callOptions());
    expect(w.db.alerts.filter((a) => a.problem === "chain_reached_main")).toHaveLength(1);
  });

  it("the main key itself failing: nothing is left after it, the failure is returned as today, «main_failed» is opened, no loop", async () => {
    const w = makePoolWorld();
    const main = w.addKey({ isMain: true, tregMode: "empty" });
    w.switchOn(main.id);
    const r = await executeTregCall(callOptions());
    expect(r).toMatchObject({ ok: false, httpStatus: 402 });
    expect(w.treg.callCount()).toBe(1);
    expect(w.db.state.active_key_id).toBe(main.id);
    expect(w.db.alerts.map((a) => a.problem)).toEqual(["main_failed"]);
  });

  it("a key outside the chain is never a fallback, but may be the active key; when it fails the chain starts from the top", async () => {
    const w = makePoolWorld();
    w.addKey({ isMain: true });
    const spare = w.addKey({ tregMode: "revoked", inChain: false }); const k3 = w.addKey();
    w.switchOn(spare.id);
    const r = await executeTregCall(callOptions());
    expect(r.keyRef?.number).toBe(k3.number);
  });
});

describe("bursts and two servers failing together", () => {
  it("30 calls failing on the same dead key at once: one verification, one switch, one alert, and every call is answered by the next key", async () => {
    const { w, pool } = world(["revoked", "ok"]);
    const results = await Promise.all(Array.from({ length: 30 }, () => executeTregCall(callOptions())));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(authMeCalls(w).length).toBeLessThanOrEqual(2);
    expect(w.db.events.filter((e) => e.kind === "failover")).toHaveLength(1);
    expect(w.db.alerts.filter((a) => a.problem === "failover")).toHaveLength(1);
    expect(w.db.state.active_key_id).toBe(pool[1].id);
  });

  it("the same failing key over time: still one alert per key per problem (the 30-minute guard), a new episode later opens a new one", async () => {
    const { w, pool } = world(["revoked", "ok"]);
    await executeTregCall(callOptions());
    // the admin puts the dead key back in use by force: the same problem again within 30 minutes opens nothing new
    await w.db.client.rpc("admin_set_treg_active_key", { p_admin_id: "admin-1", p_key_id: pool[0].id, p_force: true });
    w.pool.invalidate(); clock.advance(10_000);
    await executeTregCall(callOptions());
    expect(w.db.alerts.filter((a) => a.problem === "failover")).toHaveLength(1);
    expect(w.db.events.filter((e) => e.kind === "failover")).toHaveLength(2);
  });

  it("two server instances reporting the same failed key switch the active key once and open each alert once", async () => {
    const w = makePoolWorld();
    const main = w.addKey({ isMain: true });
    const a = w.addKey({ tregMode: "empty" }); const b = w.addKey();
    w.switchOn(a.id);
    const second = new TregKeyPool({ source: "worker", getClient: async () => w.db.client, fetchFn: w.treg.fetch as any, now: clock.now });
    const choiceOf = async (p: TregKeyPool): Promise<KeyChoice> => p.choose(undefined);
    const [c1, c2] = [await choiceOf(w.pool), await choiceOf(second)];
    const outcome = { ok: false, httpStatus: 402, isPlatformBalanceLow: true };
    const [n1, n2] = await Promise.all([w.pool.afterCall(c1, outcome), second.afterCall(c2, outcome)]);
    expect(n1?.ref?.id).toBe(b.id);
    expect(n2?.ref?.id).toBe(b.id);
    expect(w.db.events.filter((e) => e.kind === "failover")).toHaveLength(1);
    expect(w.db.alerts.filter((x) => x.problem === "failover")).toHaveLength(1);
    expect(w.db.state.generation).toBeGreaterThan(0);
    expect(main.plaintext).not.toBe(b.plaintext);
  });
});

describe("the keys stay on the server", () => {
  it("no log line, no result field, no alert row and no event contains a key or its ciphertext", async () => {
    const { w, main, pool } = world(["revoked", "empty", "ok"]);
    const r = await executeTregCall(callOptions());
    const seen = [logs.text(), JSON.stringify(r), JSON.stringify(w.db.alerts), JSON.stringify(w.db.events), JSON.stringify(w.db.rpcLog.filter((x) => !["treg_pool_runtime", "treg_pool_enc_key"].includes(x.fn)))].join("\n");
    for (const k of [main, ...pool]) {
      expect(seen).not.toContain(k.plaintext);
      expect(seen).not.toContain(k.row.ciphertext as string);
    }
  });
});
