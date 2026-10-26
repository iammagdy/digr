import { afterEach, describe, expect, it, vi } from "vitest";
import { executeTregCall } from "../src/functions/shared/tregClient";
import { callCostMicro, executeTregCallWithReplay } from "../src/lib/server/tregAdapter";

/**
 * The REAL client (`executeTregCall`) against a stubbed `fetch`: a source that answers 200 after our time limit, the shape of what the client
 * returns when it stops waiting, and the replay with the SAME idempotency key that reads the stored answer at no charge
 * (`X-Treg-Original-Cost-Micro` carries the first call's charge). The live failure: the source finished and billed a call our client had already abandoned.
 */
const BODY = {
  query: { currentJobTitle: { include: ["CEO"] }, location: { include: ["EG"] }, keyword: { include: ["information technology", "software", "technology"] } },
  pagination: { size: 9 },
};
const ANSWER = { total: 2560, success: true, leads: [{ firstname: "Mona", lastname: "Saleh" }], pagination: { token: "t", size: 9 } };
const answer = (headers: Record<string, string>) => new Response(JSON.stringify(ANSWER), { status: 200, headers: { "content-type": "application/json", ...headers } });

interface Seen { url: string; headers: Record<string, string>; body: any }

function stubFetch(script: Array<(init: RequestInit) => Promise<Response>>) {
  const seen: Seen[] = [];
  const stub = vi.fn(async (url: string, init: RequestInit) => {
    seen.push({ url: String(url), headers: { ...(init.headers as Record<string, string>) }, body: JSON.parse(String(init.body)) });
    return script[Math.min(seen.length - 1, script.length - 1)](init);
  });
  vi.stubGlobal("fetch", stub);
  return { stub, seen };
}

/** A source that finishes after `afterMs`, unless the caller's signal aborts the wait first (what fetch does with AbortSignal.timeout). */
const slow = (afterMs: number, headers: Record<string, string> = {}) => (init: RequestInit) => new Promise<Response>((resolve, reject) => {
  const timer = setTimeout(() => resolve(answer(headers)), afterMs);
  init.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(init.signal!.reason); });
});

const options = (extra: Record<string, any> = {}) => ({
  token: "test-token", endpointId: "icypeas.people.search", method: "POST" as const, params: BODY,
  userId: "user_live", jobId: "job_quote_slow", stepId: "step_0", page: 1, routeMaxCostUsd: "0.005", timeoutMs: 50, ...extra,
});

afterEach(() => { vi.unstubAllGlobals(); });

describe("the client records that it stopped waiting, and the replay reads the stored answer", () => {
  it("a 200 that arrives after the limit is a timeout with no answer and no cost read (the live failure's shape)", async () => {
    stubFetch([slow(400, { "x-treg-call-id": "never-read", "x-treg-cost-micro": "1140" })]);
    const result = await executeTregCall(options());
    expect(result).toMatchObject({ ok: false, httpStatus: 503, error: "network_failure", timedOut: true, costMicro: 0, data: null });
    expect(result.tregCallId).toMatch(/^err_/);
    expect(result.latencyMs).toBeLessThan(300);
  });

  it("the replay is sent with the SAME idempotency key, body and ceiling, and its answer is read: charged once, not twice", async () => {
    const { stub, seen } = stubFetch([
      slow(400, { "x-treg-call-id": "first", "x-treg-cost-micro": "1140" }),
      async () => answer({ "x-treg-call-id": "callref", "x-treg-cost-micro": "0", "x-treg-original-cost-micro": "1140" }),
    ]);
    const { result, calls } = await executeTregCallWithReplay(options(), { deadlineMs: Date.now() + 60_000, reserveMs: 12_000 });
    expect(calls).toBe(2);
    expect(stub).toHaveBeenCalledTimes(2);
    expect(seen[0].headers["Idempotency-Key"]).toBe("job_job_quote_slow_step_step_0_p1");
    expect(seen[1].headers["Idempotency-Key"]).toBe(seen[0].headers["Idempotency-Key"]);
    expect(seen[1].body).toEqual(seen[0].body);
    expect(seen[1].url).toBe(seen[0].url);
    expect(seen[1].url.endsWith("/call/icypeas.people.search")).toBe(true);
    expect(seen[1].headers["X-Treg-Route-Max-Cost"]).toBe("0.005");
    expect(result).toMatchObject({ ok: true, httpStatus: 200, tregCallId: "callref", costMicro: 0, originalCostMicro: 1140 });
    expect(result.data.leads).toHaveLength(1);
    // the first call's charge is the one recorded; the replay itself adds nothing
    expect(callCostMicro(result)).toBe(1140);
  });

  it("no replay when too little time is left, or when the job's spend budget refuses another call", async () => {
    const tight = stubFetch([slow(400)]);
    const near = await executeTregCallWithReplay(options(), { deadlineMs: Date.now() + 13_000, reserveMs: 12_000 });
    expect(near.calls).toBe(1);
    expect(near.result.timedOut).toBe(true);
    expect(tight.stub).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();

    const refused = stubFetch([slow(400)]);
    const out = await executeTregCallWithReplay(options(), { deadlineMs: Date.now() + 60_000, reserveMs: 12_000, beforeReplay: () => false });
    expect(out.calls).toBe(1);
    expect(refused.stub).toHaveBeenCalledTimes(1);
  });

  it("an answer the source refused (a 4xx or 5xx that came back) is never replayed", async () => {
    const { stub } = stubFetch([async () => new Response(JSON.stringify({ error: "bad" }), { status: 503, headers: { "content-type": "application/json" } })]);
    const out = await executeTregCallWithReplay(options(), { deadlineMs: Date.now() + 60_000, reserveMs: 12_000 });
    expect(out.calls).toBe(1);
    expect(out.result).toMatchObject({ ok: false, httpStatus: 503 });
    expect(out.result.timedOut).toBeUndefined();
    expect(stub).toHaveBeenCalledTimes(1);
  });
});
