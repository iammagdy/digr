import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeTregCall } from "../src/functions/shared/tregClient";
import { POOL_FORBIDDEN_STREAK, POOL_FORBIDDEN_WINDOW_MS } from "../src/lib/server/tregKeyPool";
import { runPoolHealth } from "../src/lib/server/tregPoolHealth";
import { DEAD_KEY_FAILED_CALLS, loadPoolOverview } from "../src/lib/server/tregPoolAdmin";
import { callOptions, clock, makePoolWorld, teardownPoolWorld, type TregMode } from "./helpers/tregPoolKit";
import { captureConsole } from "./helpers/providerKeyTestKit";

/**
 * REPLAY of the live rows of 2026-10-30 (read-only SELECTs of mission_calls, treg_pool_keys, treg_pool_calls). Two failures of the key pool:
 *
 *  1. KEY #2 (active): its TREG organisation was suspended. From 01:09:29 UTC every data call answered 403 «org suspended» (24 calls, 23 endpoints, until 16:15:48) while its identity
 *     read and balance read still passed. The pool verified a 403 only by the identity read, so it called the key «connected» and never failed over: all planning failed for 15 hours.
 *  2. KEY #1: out of balance since 22:32:57 on 29 Oct (a 402, recorded), balance 1,046 micro-USD. Every later health check found the identity read passing and the balance read
 *     «unreadable» and wrote status «connected», overwriting out_of_balance.
 *
 * These tests fail on the code of main (2be23b6) and pass after the fix. The clock is the fake clock of the kit; nothing reads the real time.
 */
let logs: ReturnType<typeof captureConsole>;
beforeEach(() => { logs = captureConsole(); });
afterEach(() => { logs.restore(); teardownPoolWorld(); });

/** The 24 refused calls of key #2: [endpoint id, seconds since the first one], copied from mission_calls (01:09:29 ... 16:15:48 UTC on 2026-10-30). */
const LIVE_403: Array<[string, number]> = [
  ["crawl4ai.weworkremotely.search.jobs", 0], ["crawl4ai.remoteok.search.jobs", 2], ["crawl4ai.stackoverflow.search.questions", 56], ["crawl4ai.weather.forecast.daily", 1117],
  ["litescrape.google.serp.maps", 2234], ["crawl4ai.google.serp.maps", 2235], ["anyapi.google.serp.maps", 2237], ["dataforseo.x.serp-google-maps-live-advanced", 2242],
  ["tomba.companies.search.reveal", 2248], ["icypeas.companies.search", 2250],
  ["crawl4ai.youtube.search.videos", 54_005], ["crawl4ai.youtube.search.videos", 54_006], ["tikhub.x.youtube-web-search-video", 54_009], ["tikhub.x.youtube-web-v2-get-general-search", 54_011],
  ["scrapecreators.x.v1-youtube-search", 54_013], ["tikhub.youtube.search.videos", 54_015], ["treg.youtube.search.videos", 54_017], ["serpapi.youtube.search.videos", 54_019],
  ["justoneapi.x.youtube-search-v1", 54_021], ["crawl4ai.youtube.channel.videos", 54_027], ["tikhub.youtube.channel.videos", 54_193], ["scrapecreators.x.v1-youtube-channel-videos", 54_195],
  ["treg.youtube.channel.videos", 54_197], ["justoneapi.x.youtube-get-channel-videos-v1", 54_199],
];

/** main + the pool: key A is active (the live key #2), key B is the next of the chain. */
function world(aMode: TregMode) {
  const w = makePoolWorld({ source: "worker" });
  const main = w.addKey({ isMain: true });
  const a = w.addKey({ tregMode: aMode, balanceMicro: 912_244 }); // the live balance of key #2: plenty, the account is the problem
  w.switchOn(a.id);
  return { w, main, a };
}
const dataCallsOf = (w: ReturnType<typeof makePoolWorld>, token: string) => w.treg.requests.filter((r) => r.path.startsWith("/call/") && r.token === token).length;

describe("replay 1: key #2, 24 data calls answered «org suspended» while the identity read passes", () => {
  it("the first refused call moves the platform to the main key; the other 23 calls never touch the suspended key; one alert, one event", async () => {
    const { w, main, a } = world("suspended403");
    const results = [];
    let last = 0;
    for (const [endpointId, at] of LIVE_403) {
      clock.advance(Math.min(at - last, 600) * 1000); last = at; // the long gaps of the live night do not matter to the rule; capped so the fake clock stays small
      results.push(await executeTregCall(callOptions({ endpointId, jobId: `msn_replay_${at}` })));
    }
    expect(results.every((r) => r.ok)).toBe(true);                        // main: all 24 calls were REFUSED, none answered
    expect(dataCallsOf(w, a.plaintext)).toBe(1);                          // the suspended key is asked once, then replaced
    expect(dataCallsOf(w, main.plaintext)).toBe(24);
    expect(w.db.state.active_key_id).toBe(main.id);
    expect(w.db.byId(a.id)).toMatchObject({ status: "revoked", status_reason: "org_suspended" });
    expect(w.db.events.filter((e) => e.kind === "failover")).toEqual([{ kind: "failover", key_number: a.number, to_key_number: main.number, reason: "org_suspended", source: "worker" }]);
    expect(w.db.alerts.map((x) => x.problem).sort()).toEqual(["chain_reached_main", "failover"]);   // debounced: one of each, not 24
    expect(w.treg.requests.filter((r) => r.path === "/auth/me")).toHaveLength(0);                    // the verdict needs no identity read: it passes for a suspended organisation
  });

  it("the reason is stored for the admin only: nothing the customer can read carries it, and the key itself is in no log", async () => {
    const { w, a } = world("suspended403");
    await executeTregCall(callOptions());
    expect(logs.text()).not.toContain(a.plaintext);
    expect(JSON.stringify(w.db.rpcLog)).not.toContain(a.plaintext);
  });

  it("without the provider's words (a bare 403) the SAME night is caught by the streak: the 3rd refused call on 3 endpoints in 2 minutes moves on", async () => {
    const { w, main, a } = world("forbid403");
    const results = [];
    for (const [endpointId, at] of LIVE_403.slice(0, 5)) {
      clock.advance(at === 0 ? 0 : 2_000);
      results.push(await executeTregCall(callOptions({ endpointId })));
    }
    expect(results.map((r) => r.ok)).toEqual([false, false, true, true, true]);
    expect(dataCallsOf(w, a.plaintext)).toBe(POOL_FORBIDDEN_STREAK);
    expect(w.db.state.active_key_id).toBe(main.id);
    expect(w.db.byId(a.id)).toMatchObject({ status: "revoked", status_reason: "auth_403_repeated" });
  });
});

describe("the 403 streak: what counts and what does not", () => {
  // real catalog endpoints (an unknown id is blocked before any request leaves, which would make these tests vacuous)
  const E = ["crawl4ai.youtube.search.videos", "tikhub.youtube.search.videos", "crawl4ai.youtube.channel.videos", "tikhub.youtube.channel.videos"];
  const call = (endpointId: string) => executeTregCall(callOptions({ endpointId }));

  it("one refused call, or two, never switch: an endpoint can refuse a plan while the key is fine", async () => {
    const { w, a } = world("forbid403");
    expect((await call(E[0])).ok).toBe(false);
    expect((await call(E[1])).ok).toBe(false);
    expect(dataCallsOf(w, a.plaintext)).toBe(2);                    // both really reached the key
    expect(w.db.state.active_key_id).toBe(a.id);
    expect(w.db.byId(a.id)?.status).toBe("connected");
    expect(w.db.alerts).toHaveLength(0);
  });

  it("three in a row on ONE endpoint do not switch (that endpoint is refusing, not the key)", async () => {
    const { w, a } = world("forbid403");
    for (let i = 0; i < 4; i++) await call(E[0]);
    expect(dataCallsOf(w, a.plaintext)).toBe(4);
    expect(w.db.state.active_key_id).toBe(a.id);
  });

  it("an answered call in between clears the count; so does a 404; a 503, a timeout and a 429 neither count nor clear", async () => {
    const { w, a } = world("forbid403");
    await call(E[0]); await call(E[1]);
    w.treg.set(a.plaintext, { mode: "ok" });
    expect((await call(E[2])).ok).toBe(true);                       // answered: the count restarts
    w.treg.set(a.plaintext, { mode: "forbid403" });
    await call(E[0]); await call(E[1]);
    expect(w.db.state.active_key_id).toBe(a.id);                    // 2 since the answer, not 4
    w.treg.set(a.plaintext, { mode: "http503" });
    await call(E[2]); await call(E[3]);                              // neither counts nor clears
    w.treg.set(a.plaintext, { mode: "timeout" });
    await call(E[2]);
    w.treg.set(a.plaintext, { mode: "http429" });
    await call(E[2]);
    expect(w.db.state.active_key_id).toBe(a.id);
    w.treg.set(a.plaintext, { mode: "forbid403" });
    await call(E[2]);                                                // the 3rd refused call since the answer
    expect(w.db.state.active_key_id).not.toBe(a.id);
  });

  it("403s older than the window do not count", async () => {
    const { w, a } = world("forbid403");
    await call(E[0]); await call(E[1]);
    clock.advance(POOL_FORBIDDEN_WINDOW_MS + 1_000);
    await call(E[2]);
    expect(w.db.state.active_key_id).toBe(a.id);
  });

  it("5xx and timeouts NEVER switch, whatever their text says; the verdict needs a 401/403 or a platform 402", async () => {
    const { w, a } = world("http503");
    for (let i = 0; i < 6; i++) await call(E[i % 4]);
    w.treg.set(a.plaintext, { mode: "timeout" });
    for (let i = 0; i < 6; i++) await call(E[i % 4]);
    expect(dataCallsOf(w, a.plaintext)).toBeGreaterThanOrEqual(12);
    expect(w.db.state.active_key_id).toBe(a.id);
    expect(w.db.events).toHaveLength(0);
  });

  it("the chain is followed in order and the MAIN key is always last: a suspended key falls to the next pool key, that one to main", async () => {
    const w = makePoolWorld({ source: "website" });
    const main = w.addKey({ isMain: true });
    const k1 = w.addKey({ tregMode: "suspended403" });
    const k2 = w.addKey({ tregMode: "suspended403" });
    w.switchOn(k1.id);
    const r = await call(E[0]);
    expect(r.ok).toBe(true);
    expect(r.keyRef?.number).toBe(main.number);
    expect(w.db.events.filter((e) => e.kind === "failover").map((e) => `${e.key_number}>${e.to_key_number}`)).toEqual([`${k1.number}>${k2.number}`, `${k2.number}>${main.number}`]);
  });

  it("when the MAIN key itself is suspended there is nothing after it: it is marked, the admin gets the urgent mail once, and the pool does not loop", async () => {
    const w = makePoolWorld({ source: "website" });
    const main = w.addKey({ isMain: true, tregMode: "suspended403" });
    w.switchOn(main.id);
    for (let i = 0; i < 3; i++) expect((await call(E[i])).ok).toBe(false);
    expect(w.db.state.active_key_id).toBe(main.id);
    expect(w.db.byId(main.id)).toMatchObject({ status: "revoked", status_reason: "org_suspended" });
    expect(w.db.alerts.filter((x) => x.problem === "main_failed")).toHaveLength(1);
  });
});

describe("replay 2: key #1, out of balance, then «connected» again because the balance became unreadable", () => {
  /** The live row of key #1: status out_of_balance (reason http_402), balance 1,046 micro-USD; the identity read passes, the balance read gives no number. */
  const seedKey1 = () => {
    const w = makePoolWorld({ source: "website" });
    const main = w.addKey({ isMain: true });
    const k1 = w.addKey({ status: "out_of_balance", balanceMicro: 1_046 });
    w.db.byId(k1.id)!.status_reason = "http_402";
    w.treg.set(k1.plaintext, { mode: "ok", balanceMicro: 1_046, balanceMode: "unreadable" });
    w.switchOn(main.id);
    return { w, main, k1 };
  };
  const run = (w: ReturnType<typeof makePoolWorld>) => runPoolHealth({ client: w.db.client, pool: w.pool, fetchFn: w.treg.fetch as any, now: clock.now, source: "health" });

  it("an unreadable balance leaves out_of_balance as it was, with its reason and its last real balance", async () => {
    const { w, k1 } = seedKey1();
    const out = await run(w);
    expect(out.ok).toBe(true);
    expect(w.db.byId(k1.id)).toMatchObject({ status: "out_of_balance", status_reason: "http_402", balance_micro: 1_046 });
  });

  it("every later check says the same (the live key stayed «connected» for 15 hours)", async () => {
    const { w, k1 } = seedKey1();
    for (let i = 0; i < 4; i++) { clock.advance(600_000); await run(w); }
    expect(w.db.byId(k1.id)?.status).toBe("out_of_balance");
  });

  it("a REAL refill (a number above the minimum) does clear it", async () => {
    const { w, k1 } = seedKey1();
    w.treg.set(k1.plaintext, { mode: "ok", balanceMicro: 900_000, balanceMode: "ok" });
    await run(w);
    expect(w.db.byId(k1.id)).toMatchObject({ status: "connected", status_reason: "ok", balance_micro: 900_000 });
  });

  it("a key never verified stays «unknown» when its balance cannot be read: «connected» needs a number or a successful data call", async () => {
    const w = makePoolWorld({ source: "website" });
    w.addKey({ isMain: true });
    const k = w.addKey({ status: "unknown" });
    w.treg.set(k.plaintext, { mode: "ok", balanceMode: "unreadable" });
    await run(w);
    expect(w.db.byId(k.id)?.status).toBe("unknown");
  });

  it("a key a call proved suspended is NOT turned back to «connected» by free reads that pass (identity and a real balance)", async () => {
    const w = makePoolWorld({ source: "website" });
    w.addKey({ isMain: true });
    const k2 = w.addKey({ status: "revoked", balanceMicro: 912_244, tregMode: "suspended403" });
    w.db.byId(k2.id)!.status_reason = "org_suspended";
    const out = await run(w);
    expect(out.held).toBe(1);
    expect(w.db.byId(k2.id)).toMatchObject({ status: "revoked", status_reason: "org_suspended" });
  });

  it("a key revoked only because its IDENTITY read failed is connected again when that read passes (unchanged behaviour)", async () => {
    const w = makePoolWorld({ source: "website" });
    w.addKey({ isMain: true });
    const k = w.addKey({ status: "revoked", balanceMicro: 500_000 });
    w.db.byId(k.id)!.status_reason = "auth_401";
    await run(w);
    expect(w.db.byId(k.id)?.status).toBe("connected");
  });
});

describe("what the admin table says about a key whose calls fail (SQL 07)", () => {
  it("«connected» with 24 failed calls since its last answer reads «not answering», with the time of the last answer", async () => {
    const w = makePoolWorld({ source: "website" });
    w.addKey({ isMain: true });
    const k2 = w.addKey({ status: "connected", balanceMicro: 912_244 });
    w.switchOn(k2.id);
    const t0 = clock.t;
    w.db.calls.set(1, { key_id: k2.id, key_number: k2.number, key_label: "2", source: "worker" }); w.db.setCostStatus(1, "success", t0 - 15 * 3_600_000);
    for (let i = 0; i < 24; i++) { w.db.calls.set(100 + i, { key_id: k2.id, key_number: k2.number, key_label: "2", source: "worker" }); w.db.setCostStatus(100 + i, "failed", t0 - 3_600_000 + i * 1000); }
    const ov = await loadPoolOverview({ client: w.db.client, pool: w.pool, fetchFn: w.treg.fetch as any, now: clock.now });
    const v = ov.keys.find((k) => k.id === k2.id)!;
    expect(v.status).toBe("connected");
    expect(v.callHealth).toMatchObject({ failedSinceOk: 24 });
    expect(v.callHealth?.lastOkAt).toBe(new Date(t0 - 15 * 3_600_000).toISOString());
    expect(v.deadWarning).toBe(true);
    expect(ov.callHealthReady).toBe(true);
  });

  it("fewer failures than the threshold, or an answer after them, is not a warning; a key with no calls has no figures", async () => {
    const w = makePoolWorld({ source: "website" });
    w.addKey({ isMain: true });
    const k = w.addKey({ status: "connected" });
    const t0 = clock.t;
    for (let i = 0; i < DEAD_KEY_FAILED_CALLS - 1; i++) { w.db.calls.set(i + 1, { key_id: k.id, key_number: k.number, key_label: "x", source: "worker" }); w.db.setCostStatus(i + 1, "failed", t0 + i); }
    let ov = await loadPoolOverview({ client: w.db.client, pool: w.pool, fetchFn: w.treg.fetch as any, now: clock.now });
    expect(ov.keys.find((x) => x.id === k.id)?.deadWarning).toBe(false);
    expect(ov.keys.find((x) => x.isMain)?.callHealth).toBeNull();
    for (let i = 0; i < 5; i++) { w.db.calls.set(50 + i, { key_id: k.id, key_number: k.number, key_label: "x", source: "worker" }); w.db.setCostStatus(50 + i, "failed", t0 + 10 + i); }
    w.db.calls.set(99, { key_id: k.id, key_number: k.number, key_label: "x", source: "worker" }); w.db.setCostStatus(99, "empty", t0 + 100);
    ov = await loadPoolOverview({ client: w.db.client, pool: w.pool, fetchFn: w.treg.fetch as any, now: clock.now });
    expect(ov.keys.find((x) => x.id === k.id)).toMatchObject({ deadWarning: false, callHealth: { failedSinceOk: 0 } });
  });

  it("before SQL 07 is applied the table still loads and says so", async () => {
    const w = makePoolWorld({ source: "website" });
    w.addKey({ isMain: true });
    w.db.flags.noCallHealth = true;
    const ov = await loadPoolOverview({ client: w.db.client, pool: w.pool, fetchFn: w.treg.fetch as any, now: clock.now });
    expect(ov.ready).toBe(true);
    expect(ov.callHealthReady).toBe(false);
    expect(ov.keys.every((k) => k.callHealth === null && k.deadWarning === false)).toBe(true);
  });
});
