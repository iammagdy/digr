import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeTregCall } from "../src/functions/shared/tregClient";
import { decideVerdict } from "../src/lib/server/tregKeyCheck";
import { classifyFailure, sourceHealth, statsFromCalls } from "../src/lib/agentMission/sourceRanking";
import { poolReasonAr } from "../src/lib/server/tregPoolAlerts";
import { callOptions, clock, makePoolWorld, teardownPoolWorld } from "./helpers/tregPoolKit";
import { captureConsole } from "./helpers/providerKeyTestKit";

/**
 * LIVE INCIDENT 2026-10-31 15:50 (Cairo): ONE endpoint (`aiark.people.search`) answered HTTP 402 while the key's balance was 6.64 USD; the pool believed the single answer, marked the only key
 * «الرصيد خلص» and sent the urgent e-mail. A 402 is now VERIFIED with the free balance read before any status is written: a balance above the minimum is an endpoint's problem (no key status, no
 * e-mail, that source is demoted only); only a confirmed low balance marks the key. A successful data call clears a flag that no call proved.
 */
let logs: ReturnType<typeof captureConsole>;
beforeEach(() => { logs = captureConsole(); });
afterEach(() => { logs.restore(); teardownPoolWorld(); });

const balanceReads = (w: ReturnType<typeof makePoolWorld>) => w.treg.requests.filter((r) => /\/orgs\/.+\/balance$/.test(r.path));

describe("a 402 is verified with the free balance read before anything is written", () => {
  it("402 with a healthy balance: no key status, no alert, no event, no retry; the answer says it is the endpoint's", async () => {
    const w = makePoolWorld();
    const main = w.addKey({ isMain: true, tregMode: "endpoint402", balanceMicro: 6_641_393 });
    w.switchOn(main.id);
    const r = await executeTregCall(callOptions({ endpointId: "aiark.people.search" }));
    expect(r).toMatchObject({ ok: false, httpStatus: 402 });
    expect((r as any).paymentScope).toBe("endpoint");
    expect(balanceReads(w).length).toBeGreaterThan(0);
    expect(w.treg.callCount()).toBe(1);
    expect(w.db.byId(main.id)).toMatchObject({ status: "connected" });
    expect(w.db.alerts).toHaveLength(0);
    expect(w.db.events.filter((e) => e.kind === "failover")).toHaveLength(0);
    expect(w.db.state.active_key_id).toBe(main.id);
  });

  it("402 with a healthy balance on a pool key: it stays active, the chain is not walked", async () => {
    const w = makePoolWorld();
    const main = w.addKey({ isMain: true });
    const a = w.addKey({ tregMode: "endpoint402", balanceMicro: 3_000_000 });
    w.addKey();
    w.switchOn(a.id);
    const r = await executeTregCall(callOptions());
    expect(r).toMatchObject({ ok: false, httpStatus: 402 });
    expect(w.db.state.active_key_id).toBe(a.id);
    expect(w.db.byId(a.id)?.status).toBe("connected");
    expect(w.db.alerts).toHaveLength(0);
    expect(main.plaintext).not.toBe(a.plaintext);
  });

  it("402 with a confirmed LOW balance marks the key; the reason names the endpoint and the code (60 characters at most)", async () => {
    const w = makePoolWorld();
    const main = w.addKey({ isMain: true });
    const a = w.addKey({ tregMode: "empty", balanceMicro: 4_000 });
    w.switchOn(a.id);
    const r = await executeTregCall(callOptions({ endpointId: "aiark.people.search" }));
    expect(r.ok).toBe(true); // retried on the next key (the main key)
    expect(w.db.byId(a.id)?.status).toBe("out_of_balance");
    const reason = String(w.db.byId(a.id)?.status_reason);
    expect(reason).toBe("balance_low:aiark.people.search");
    expect(reason.length).toBeLessThanOrEqual(60);
    expect(w.db.state.active_key_id).toBe(main.id);
  });

  it("the main key with a confirmed low balance: «main_failed» is opened with the endpoint in the reason", async () => {
    const w = makePoolWorld();
    const main = w.addKey({ isMain: true, tregMode: "empty", balanceMicro: 0 });
    w.switchOn(main.id);
    const r = await executeTregCall(callOptions({ endpointId: "some.very.long.endpoint.identifier.that.goes.past.the.sixty.character.limit.of.a.reason" }));
    expect(r).toMatchObject({ ok: false, httpStatus: 402 });
    expect(w.db.alerts.map((a) => a.problem)).toEqual(["main_failed"]);
    expect(String(w.db.byId(main.id)?.status_reason).length).toBeLessThanOrEqual(60);
    expect(String(w.db.byId(main.id)?.status_reason)).toMatch(/^balance_low:/);
  });

  it("a balance that cannot be read confirms nothing: no status, no alert", async () => {
    const w = makePoolWorld();
    const main = w.addKey({ isMain: true, tregMode: "empty" });
    w.treg.keys.get(main.plaintext)!.balanceMode = "unreadable";
    w.switchOn(main.id);
    const r = await executeTregCall(callOptions());
    expect(r).toMatchObject({ ok: false, httpStatus: 402 });
    expect(w.db.byId(main.id)?.status).toBe("connected");
    expect(w.db.alerts).toHaveLength(0);
  });

  it("a burst of 30 endpoint-level 402s reads the balance at most twice and writes nothing", async () => {
    const w = makePoolWorld();
    const main = w.addKey({ isMain: true, tregMode: "endpoint402", balanceMicro: 2_000_000 });
    w.switchOn(main.id);
    const results = await Promise.all(Array.from({ length: 30 }, () => executeTregCall(callOptions())));
    expect(results.every((x) => (x as any).paymentScope === "endpoint")).toBe(true);
    expect(balanceReads(w).length).toBeLessThanOrEqual(2);
    expect(w.db.alerts).toHaveLength(0);
  });

  it("the reason of a flagged key reads as «انتهى رصيده» with the endpoint suffix", () => {
    expect(poolReasonAr("balance_low:aiark.people.search")).toBe("انتهى رصيده");
    expect(poolReasonAr("http_402")).toBe("انتهى رصيده");
  });
});

describe("a successful data call clears a flag no call proved", () => {
  it("the main key flagged out of balance (nothing proves it) answers a call: it is connected again and the urgent alert is cleared", async () => {
    const w = makePoolWorld();
    const main = w.addKey({ isMain: true, status: "out_of_balance" });
    w.switchOn(main.id);
    await w.db.client.rpc("treg_pool_claim_alert", { p_problem: "main_failed", p_key_id: main.id, p_reason: "out_of_balance", p_to_key_id: null });
    expect(w.db.alerts.filter((a) => !a.cleared)).toHaveLength(1);
    const r = await executeTregCall(callOptions());
    expect(r.ok).toBe(true);
    expect(w.db.byId(main.id)).toMatchObject({ status: "connected", status_reason: "data_call_ok" });
    expect(w.db.alerts.filter((a) => !a.cleared)).toHaveLength(0);
  });

  it("a FREE call (cost 0) that succeeds leaves the flag where it is; only a BILLED call clears it (no flapping against the health check)", async () => {
    const w = makePoolWorld();
    const main = w.addKey({ isMain: true, status: "out_of_balance", tregMode: "free" });
    w.switchOn(main.id);
    await w.db.client.rpc("treg_pool_claim_alert", { p_problem: "main_failed", p_key_id: main.id, p_reason: "out_of_balance", p_to_key_id: null });
    const free = await executeTregCall(callOptions());
    expect(free.ok).toBe(true);
    expect(free.costMicro).toBe(0);
    expect(w.db.byId(main.id)?.status).toBe("out_of_balance");
    expect(w.db.alerts.filter((a) => !a.cleared)).toHaveLength(1);
    expect(w.db.rpcLog.filter((c) => c.fn === "treg_pool_record_check")).toHaveLength(0);
    // the same key now answers a billed call (cost > 0): the flag clears
    w.treg.keys.get(main.plaintext)!.mode = "ok";
    clock.advance(10_000);
    const billed = await executeTregCall(callOptions());
    expect(billed.ok).toBe(true);
    expect(billed.costMicro).toBeGreaterThan(0);
    expect(w.db.byId(main.id)).toMatchObject({ status: "connected", status_reason: "data_call_ok" });
    expect(w.db.alerts.filter((a) => !a.cleared)).toHaveLength(0);
  });

  it("a «revoked» status is left to the health check and the admin: a call answering does not move it", async () => {
    const w = makePoolWorld();
    const main = w.addKey({ isMain: true, status: "revoked" });
    w.switchOn(main.id);
    const r = await executeTregCall(callOptions());
    expect(r.ok).toBe(true);
    expect(w.db.byId(main.id)?.status).toBe("revoked");
  });

  it("a healthy key answering calls writes nothing (no database call per call)", async () => {
    const w = makePoolWorld();
    const main = w.addKey({ isMain: true });
    w.switchOn(main.id);
    await executeTregCall(callOptions());
    await executeTregCall(callOptions());
    expect(w.db.rpcLog.filter((c) => c.fn === "treg_pool_record_check")).toHaveLength(0);
  });
});

describe("the admin's own check", () => {
  it("a probe call that answers 402 while the balance read is healthy is not «out of balance»", () => {
    const d = decideVerdict({ identity: { ok: true, httpStatus: 200, text: null }, balanceMicro: 6_641_393, minBalanceMicro: 10_000, data: { ran: true, ok: false, httpStatus: 402, platformBalanceLow: true, text: "payment required" } });
    expect(d.verdict).not.toBe("out_of_balance");
  });
  it("a 402 with a low balance read is still out of balance; with no balance read it is not concluded", () => {
    expect(decideVerdict({ identity: { ok: true, httpStatus: 200, text: null }, balanceMicro: 0, minBalanceMicro: 10_000, data: { ran: true, ok: false, httpStatus: 402, platformBalanceLow: true, text: null } }).verdict).toBe("out_of_balance");
    expect(decideVerdict({ identity: { ok: true, httpStatus: 200, text: null }, balanceMicro: null, minBalanceMicro: 10_000, data: { ran: true, ok: false, httpStatus: 402, platformBalanceLow: true, text: null } }).verdict).not.toBe("out_of_balance");
  });
});

describe("source health: an endpoint-level 402 demotes that source only", () => {
  const call = (over: Record<string, unknown>) => ({ endpoint_id: "aiark.people.search", status: "failed", http_status: 402, created_at: 1_800_000_000_000, params_digest: {}, ...over }) as any;
  it("a 402 marked as the endpoint's own is a «payment» failure; a bare 402 and a price cap say nothing about the source", () => {
    expect(classifyFailure(call({ params_digest: { _failure: "endpoint_payment_refused: payment required" } }))).toBe("payment");
    expect(classifyFailure(call({ params_digest: { _failure: "insufficient_balance" } }))).toBe("none");
    expect(classifyFailure(call({ params_digest: { _failure: "route_max_cost" } }))).toBe("none");
  });
  it("one such failure demotes the source; many never skip it (a real top-up must not leave the sources skipped)", () => {
    const now = 1_800_000_100_000;
    const one = statsFromCalls([call({ params_digest: { _failure: "endpoint_payment_refused: x" } })]);
    expect(sourceHealth(one.get("aiark.people.search"), now).state).toBe("demoted");
    const many = statsFromCalls([1, 2, 3, 4].map((i) => call({ created_at: 1_800_000_000_000 + i, params_digest: { _failure: "endpoint_payment_refused: x" } })));
    expect(sourceHealth(many.get("aiark.people.search"), now).state).toBe("demoted");
  });
  it("a call that gives rows again ends the demotion", () => {
    const now = 1_800_000_100_000;
    const s = statsFromCalls([call({ params_digest: { _failure: "endpoint_payment_refused: x" } }), { endpoint_id: "aiark.people.search", status: "ok", http_status: 200, rows_returned: 3, cost_usd: 0.001, created_at: 1_800_000_050_000 } as any]);
    expect(sourceHealth(s.get("aiark.people.search"), now).state).toBe("ok");
  });
});
