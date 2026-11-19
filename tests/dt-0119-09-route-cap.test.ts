import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ceilToMicroUsd, tregRouteCapUsd } from "../src/lib/server/spendGate/bounds";
import { estimateCallUsd, tregRouteMaxUsd } from "../agent/src/gateway";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { executeTregCall, isRouteMaxCostBody } from "../src/functions/shared/tregClient";
import { classifyFailure } from "../src/lib/agentMission/sourceRanking";
import { callOptions, makePoolWorld, teardownPoolWorld } from "./helpers/tregPoolKit";
import { captureConsole } from "./helpers/providerKeyTestKit";

/**
 * DT-20261119-09 (Megz D-0125). Live 2026-11-19 (msn_d3544ab2…): six planning calls to blitzapi/aiark answered HTTP 402 with `estimated_cost_micro` in the body. TREG compares its reserve, in whole micro-USD, with the
 * `X-Treg-Route-Max-Cost` we send. F1: the cap is never rounded DOWN (aiark.people.search 0.0026335 was sent as 0.002633, one micro-dollar under its price: refused every time, as on 2026-10-31).
 * F2: a price-cap refusal is recognised wherever its fields sit and is NOT read as «platform balance low» (no balance check, no «endpoint_payment_refused», no source demotion).
 */
let logs: ReturnType<typeof captureConsole>;
beforeEach(() => { logs = captureConsole(); });
afterEach(() => { logs.restore(); teardownPoolWorld(); });

describe("F1: the route cap is rounded UP to the micro-dollar, never down", () => {
  it("the live case: aiark.people.search (0.0026335) is sent as at least 0.002634", () => {
    expect(tregRouteCapUsd(0.0026335)).toBe(0.002634);
    const catalog = loadTregCatalog();
    expect(estimateCallUsd(catalog.byId.get("aiark.people.search")!, {}, catalog)).toBe(0.0026335);
    expect(tregRouteMaxUsd("aiark.people.search", {}, catalog)).toBe(0.002634);
  });

  it.each([
    // COUNTER: an amount that is exact to the micro-dollar is not moved (float noise is not a fraction of a micro-dollar: 0.000495 x 10 is 4950.000000000001 micro)
    [0.001, 0.001], [0.0025, 0.0025], [0.005, 0.005], [0.000495 * 10, 0.00495], [0.000495 * 65, 0.032175], [0.05, 0.05], [1, 1], [0.0123456789, 0.012346], [0.0004, 0.001], [0, 0.001], [0.0010000004, 0.001001],
  ])("tregRouteCapUsd(%s) = %s (the floor 0.001 is kept)", (estimate, cap) => {
    expect(tregRouteCapUsd(estimate)).toBe(cap);
  });

  it("COUNTER over 4,000 exact micro-dollar prices (some carry upward float noise, e.g. 0.000495 x 65 = 32175.000000000004 micro): none moves", () => {
    for (let k = 1000; k < 5000; k += 1) expect(tregRouteCapUsd(k / 1e6), String(k)).toBe(Number((k / 1e6).toFixed(6)));
  });

  it("ceilToMicroUsd: whole micro-dollars stay, any fraction goes up, a non-number is 0", () => {
    expect(ceilToMicroUsd(0.000002)).toBe(0.000002);
    expect(ceilToMicroUsd(0.0000021)).toBe(0.000003);
    expect(ceilToMicroUsd(Number.NaN)).toBe(0);
  });

  it("PROPERTY over the whole sellable catalog: no endpoint's cap is below its estimate, and none is more than one micro-dollar above it (0 of the priced endpoints below)", () => {
    const catalog = loadTregCatalog();
    let priced = 0;
    const below: string[] = [];
    const far: string[] = [];
    for (const [id, endpoint] of catalog.byId) {
      for (const params of [{}, { limit: 50 }, { size: 1 }, { max_results: 100 }] as Array<Record<string, unknown>>) {
        const estimate = estimateCallUsd(endpoint, params, catalog);
        const cap = tregRouteMaxUsd(id, params, catalog);
        if (cap === null) continue;
        if (Object.keys(params).length === 0) priced += 1;
        const floored = Math.max(estimate, 0.001) * 1e6;
        if (cap * 1e6 < floored - 1e-6) below.push(`${id} ${JSON.stringify(params)} ${estimate} -> ${cap}`);
        // the customer's price, hold and settlement do not read the cap, and the spend-gate reservation grows by at most one micro-dollar
        if (cap * 1e6 > floored + 1 + 1e-6) far.push(`${id} ${JSON.stringify(params)}`);
      }
    }
    expect(priced).toBeGreaterThan(2000);
    expect(below).toEqual([]);
    expect(far).toEqual([]);
  });
});

describe("F2: TREG's price-cap 402 is recognised wherever its fields sit", () => {
  it.each<[string, unknown, boolean]>([
    ["the documented shape: a top-level error code", { error: "route_max_cost", max_cost_micro: 2633, estimated_cost_micro: 2634 }, true],
    ["the code inside a `detail` object (live 2026-11-19: the text begins with «{»)", { detail: { error: "route_max_cost", max_cost_micro: 2633, estimated_cost_micro: 2634 } }, true],
    ["a `code` key inside `detail`", { detail: { code: "route_max_cost" } }, true],
    ["the pair of fields inside `detail`, no code, the reserve ABOVE the cap", { detail: { max_cost_micro: 2633, estimated_cost_micro: 2634 } }, true],
    ["`detail` as a JSON string with the pair, reserve above the cap", { detail: JSON.stringify({ max_cost_micro: 2633, estimated_cost_micro: 2634 }) }, true],
    ["`detail` as a JSON string with the code", { detail: JSON.stringify({ error: "route_max_cost" }) }, true],
    ["`error` as an object with a code", { error: { code: "route_max_cost" } }, true],
    ["one cap field (the reserve) and no code at all: the shape seen live", { detail: { estimated_cost_micro: 2634 } }, true],
    ["the same single field in an `error` OBJECT wrapper", { error: { estimated_cost_micro: 2634 } }, true],
    ["the same single field in a JSON STRING under `error` (a container, never a code)", { error: JSON.stringify({ estimated_cost_micro: 2634 }) }, true],
    ["the same single field in a JSON STRING under `detail`", { detail: JSON.stringify({ estimated_cost_micro: 2634 }) }, true],
    // COUNTERS: an explicit balance or payment code ALWAYS wins; a field-only pair is a cap only when the reserve is above the cap
    ["COUNTER: payment_required", { error: "payment_required" }, false],
    ["COUNTER: insufficient_balance with its balance", { error: "insufficient_balance", balance_micro: 1500, top_up_url: "x" }, false],
    ["COUNTER (فزاع P0): insufficient_balance with a pair whose reserve is BELOW the cap", { error: "insufficient_balance", detail: { max_cost_micro: 3000, estimated_cost_micro: 2500 } }, false],
    ["COUNTER: insufficient_balance with a pair whose reserve is ABOVE the cap (the explicit code still wins)", { error: "insufficient_balance", detail: { max_cost_micro: 2633, estimated_cost_micro: 2634 } }, false],
    ["COUNTER (فزاع P1): payment_required that quotes the reserve", { error: "payment_required", detail: { estimated_cost_micro: 5000 } }, false],
    ["COUNTER: an explicit balance code inside `detail`", { detail: { error: "insufficient_balance", estimated_cost_micro: 5000 } }, false],
    ["COUNTER: route_max_cost beside a balance code (a balance signal wins)", { error: "insufficient_balance", detail: { error: "route_max_cost" } }, false],
    ["COUNTER: no code, a pair whose reserve is BELOW the cap (the cap was not exceeded)", { detail: { max_cost_micro: 3000, estimated_cost_micro: 2500 } }, false],
    ["COUNTER: no code, the ceiling alone", { detail: { max_cost_micro: 3000 } }, false],
    ["COUNTER: a detail with words only", { detail: { message: "payment required" } }, false],
    ["COUNTER: a detail string that is not JSON", { detail: "insufficient balance" }, false],
    ["COUNTER: a cap field that is not a number", { detail: { estimated_cost_micro: "soon" } }, false],
    ["COUNTER: an empty object", {}, false],
    ["COUNTER: null", null, false],
    ["COUNTER: plain text", "route_max_cost", false],
    ["COUNTER: a list", [{ error: "route_max_cost" }], false],
  ])("%s", (_name, body, expected) => {
    expect(isRouteMaxCostBody(body)).toBe(expected);
  });

  const balanceReads = (w: ReturnType<typeof makePoolWorld>) => w.treg.requests.filter((r) => /\/orgs\/.+\/balance$/.test(r.path));

  it.each(["route_cap_detail", "route_cap_fields"] as const)("%s: through the client the answer is a PRICE CAP: no balance check, no key status, no alert, no retry, not «endpoint» scope", async (mode) => {
    const w = makePoolWorld();
    const main = w.addKey({ isMain: true, tregMode: mode, balanceMicro: 2_000_000 });
    w.switchOn(main.id);
    const r = await executeTregCall(callOptions({ endpointId: "aiark.people.search" }));
    expect(r).toMatchObject({ ok: false, httpStatus: 402, isRouteMaxCost: true, isPlatformBalanceLow: false, error: "route_max_cost" });
    expect((r as any).paymentScope).toBeUndefined();
    expect(balanceReads(w)).toHaveLength(0);
    expect(w.treg.callCount()).toBe(1);
    expect(w.db.byId(main.id)).toMatchObject({ status: "connected" });
    expect(w.db.alerts).toHaveLength(0);
    expect(w.db.events.filter((e) => e.kind === "failover")).toHaveLength(0);
  });

  it("فزاع's replay (P0): an active key with a LOW balance answers insufficient_balance with cap fields whose reserve is BELOW the cap: the key is checked, marked out_of_balance, and the call recovers on the funded standby (200), as on the base", async () => {
    const w = makePoolWorld();
    const main = w.addKey({ isMain: true });
    const low = w.addKey({ tregMode: "balance_with_cap_fields", balanceMicro: 1_000 });
    w.switchOn(low.id);
    const r = await executeTregCall(callOptions({ endpointId: "aiark.people.search" }));
    expect(r.ok).toBe(true);
    expect(r.httpStatus).toBe(200);
    expect(w.db.byId(low.id)?.status).toBe("out_of_balance");
    expect(balanceReads(w).length).toBeGreaterThan(0);
    expect(w.treg.callCount()).toBe(2); // the low key, then the funded standby
    expect(main.plaintext).not.toBe(low.plaintext);
  });

  it("فزاع's counter (P1): an explicit payment_required that quotes only the reserve is the ENDPOINT's refusal (balance checked, endpoint scope), not a price cap", async () => {
    const w = makePoolWorld();
    const main = w.addKey({ isMain: true, tregMode: "payment_with_cost_field", balanceMicro: 6_641_393 });
    w.switchOn(main.id);
    const r = await executeTregCall(callOptions({ endpointId: "aiark.people.search" }));
    expect(r).toMatchObject({ ok: false, httpStatus: 402, isRouteMaxCost: false, isPlatformBalanceLow: true });
    expect((r as any).paymentScope).toBe("endpoint");
    expect(balanceReads(w).length).toBeGreaterThan(0);
    expect(w.db.byId(main.id)).toMatchObject({ status: "connected" });
  });

  it("COUNTER: a real endpoint payment refusal on a healthy balance is still the endpoint's (checked with the balance read); a low balance still marks the key; the top-level price cap is unchanged", async () => {
    const w = makePoolWorld();
    const main = w.addKey({ isMain: true, tregMode: "endpoint402", balanceMicro: 6_641_393 });
    w.switchOn(main.id);
    const r = await executeTregCall(callOptions({ endpointId: "aiark.people.search" }));
    expect(r).toMatchObject({ ok: false, httpStatus: 402, isRouteMaxCost: false, isPlatformBalanceLow: true });
    expect((r as any).paymentScope).toBe("endpoint");
    expect(balanceReads(w).length).toBeGreaterThan(0);
    teardownPoolWorld();

    const w2 = makePoolWorld();
    const low = w2.addKey({ isMain: true, tregMode: "empty", balanceMicro: 4_000 });
    w2.switchOn(low.id);
    const r2 = await executeTregCall(callOptions({ endpointId: "aiark.people.search" }));
    expect(r2).toMatchObject({ ok: false, httpStatus: 402, isPlatformBalanceLow: true, isRouteMaxCost: false });
    expect((r2 as any).paymentScope).toBe("key");
    expect(w2.db.byId(low.id)?.status).toBe("out_of_balance");
    teardownPoolWorld();

    const w3 = makePoolWorld();
    const cap = w3.addKey({ isMain: true, tregMode: "route_max_cost" });
    w3.switchOn(cap.id);
    const r3 = await executeTregCall(callOptions());
    expect(r3).toMatchObject({ httpStatus: 402, isRouteMaxCost: true, isPlatformBalanceLow: false, error: "route_max_cost" });
  });
});

describe("F2: source health: only a recognised price cap is not a verdict on the source; an endpoint's payment refusal keeps its demotion", () => {
  const row = (text: string, kind?: string, http = 402) => ({ status: "failed" as const, http_status: http, refused_reason: null, params_digest: { _failure: text, ...(kind ? { _failure_kind: kind } : {}) } });
  it("a row the client marked `price_cap` is `none`; a row it marked `endpoint_payment` is `payment` WHATEVER the clipped text carries (even a cost field)", () => {
    expect(classifyFailure(row("route_max_cost: {\"max_cost_micro\":2633,\"estimated_cost_micro\":2634}", "price_cap"))).toBe("none");
    expect(classifyFailure(row("endpoint_payment_refused: {\"estimated_cost_micro\":5000}", "endpoint_payment"))).toBe("payment");
    expect(classifyFailure(row("endpoint_payment_refused: payment_required", "endpoint_payment"))).toBe("payment");
    // the marker is trusted on its own: a price cap whose text carries nothing recognisable is still `none`
    expect(classifyFailure(row("endpoint_payment_refused: the reserve is above the ceiling", "price_cap"))).toBe("none");
  });
  it("a row recorded BEFORE the fix has no kind: its clipped cap fields mark a price cap that was labelled «endpoint_payment_refused» (not a failure of the source); a plain endpoint refusal row still demotes", () => {
    expect(classifyFailure(row("endpoint_payment_refused: {\"detail\":{\"error\":\"route_max_cost\",\"max_cost_micro\":2633,\"estimated_cost_micro\":2634}}"))).toBe("none");
    expect(classifyFailure(row("endpoint_payment_refused: {\"detail\":{\"estimated_cost_mi"))).toBe("none");
    expect(classifyFailure(row("endpoint_payment_refused: {\"detail\":{\"max_cost_mi"))).toBe("none");
    expect(classifyFailure(row("endpoint_payment_refused: payment_required"))).toBe("payment");
    expect(classifyFailure(row("endpoint_payment_refused"))).toBe("payment");
  });
  it("COUNTER: a bare 402 and the other failures are unchanged", () => {
    expect(classifyFailure(row("payment required"))).toBe("none");
    expect(classifyFailure(row("forbidden", undefined, 403))).toBe("config");
    expect(classifyFailure(row("Invalid request body", undefined, 422))).toBe("validation");
  });
});
