import http from "node:http";
import type { AddressInfo } from "node:net";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { providerCallBound, tregRouteCapUsd, MAX_SINGLE_OPERATION_USD } from "../src/lib/server/spendGate/bounds";
import { modelRequestBound, modelUsageCost, DEFAULT_GATE_MAX_OUTPUT_TOKENS, TEMPLATE_TOKEN_ALLOWANCE } from "../src/lib/server/spendGate/modelBound";
import { createMemorySpendGate, guardedPaidCall, spendGateMode, type SpendGate } from "../src/lib/server/spendGate/gate";
import { startModelGate } from "../agent/src/modelGate";
import { CONTEXTDEV_USD_PER_CREDIT, FIRECRAWL_USD_PER_CREDIT } from "../src/lib/multiProvider/catalog";
import { MODEL_HAIKU, MODEL_SONNET } from "../src/lib/agentMission/constants";

/**
 * ROUND 61: the hard spend gate, OFFLINE (docs/proposals/spend-gate/SPEC-v2.md). No provider, no model, no database is called: the model gate's
 * upstream is a fake Anthropic server on 127.0.0.1. The SQL version of the same rules is tested on a scratch Postgres in the separate, unmerged PR.
 */
const T0 = Date.parse("2026-11-14T00:00:00Z");
function world(over: Partial<Parameters<ReturnType<typeof createMemorySpendGate>["owner"]["issueGrant"]>[0]> = {}) {
  let t = T0;
  const m = createMemorySpendGate({ now: () => t });
  const grant = () => m.owner.issueGrant({ id: "g1", ceilingUsd: 0.1, perOpMaxUsd: 0.05, perMissionMaxUsd: 0.06, kinds: ["provider", "model"], opensAt: T0, closesAt: T0 + 3600_000, issuedBy: "owner", reason: "test", ...over });
  return { ...m, grant, advance: (ms: number) => { t += ms; } };
}
const req = (key: string, usd: number, missionId: string | null = "msn_a", kind: "provider" | "model" | "chat" | "eval" = "provider") => ({ key, kind, op: "contextdev.scrape", boundUsd: usd, missionId, ttlSeconds: 60 });

describe("R61 bounds: a reservation is the most a call can cost, or the call has no bound and is refused", () => {
  it("FINDING 1: TREG's route cap is the bound; today the cap sent is max(estimate, 0.001) while the estimate is reserved", () => {
    expect(tregRouteCapUsd(0.0004)).toBe(0.001);
    const b = providerCallBound({ provider: "treg", op: "call", routeCapUsd: tregRouteCapUsd(0.0004) });
    expect(b).toMatchObject({ ok: true, usd: 0.001 });
    expect(providerCallBound({ provider: "treg", op: "call", routeCapUsd: null }).ok).toBe(false);
  });
  it("FINDING 2: a search of 15 results is two blocks of ten, not 1.5", () => {
    expect(providerCallBound({ provider: "firecrawl", op: "search", limit: 15 })).toMatchObject({ ok: true, usd: Number((4 * FIRECRAWL_USD_PER_CREDIT).toFixed(6)) });
    expect(providerCallBound({ provider: "contextdev", op: "search", limit: 15 })).toMatchObject({ ok: true, usd: Number((2 * CONTEXTDEV_USD_PER_CREDIT).toFixed(6)) });
    expect(providerCallBound({ provider: "contextdev", op: "search", limit: 0 }).ok).toBe(false);
  });
  it("FINDING 3: a Firecrawl scrape with proxy «auto» (what the adapter sends) may go stealth: 5 credits, not 1", () => {
    expect(providerCallBound({ provider: "firecrawl", op: "scrape", proxy: "auto" })).toMatchObject({ ok: true, usd: 5 * FIRECRAWL_USD_PER_CREDIT });
    expect(providerCallBound({ provider: "firecrawl", op: "scrape", proxy: "basic" })).toMatchObject({ ok: true, usd: FIRECRAWL_USD_PER_CREDIT });
    expect(providerCallBound({ provider: "firecrawl", op: "search", limit: 10, scrapesResults: true }).ok).toBe(false);
  });
  it("FINDING 4: Context.dev's prebuilt parsers have no documented credit cost: no bound, refused; a page read and people search are bounded", () => {
    expect(providerCallBound({ provider: "contextdev", op: "parser", parser: "google-maps" })).toMatchObject({ ok: false, reason: "no_safe_bound" });
    expect(providerCallBound({ provider: "contextdev", op: "scrape" })).toMatchObject({ ok: true, usd: CONTEXTDEV_USD_PER_CREDIT });
    expect(providerCallBound({ provider: "contextdev", op: "people_search" })).toMatchObject({ ok: true, usd: Number((10 * CONTEXTDEV_USD_PER_CREDIT).toFixed(6)) });
    expect(providerCallBound({ provider: "contextdev", op: "people_search", mode: "ultra" })).toMatchObject({ ok: true, usd: Number((50 * CONTEXTDEV_USD_PER_CREDIT).toFixed(6)) });
    expect(providerCallBound({ provider: "contextdev", op: "people_search", mode: "deep" as never }).ok).toBe(false);
    expect(providerCallBound({ provider: "openai", op: "x" }).ok).toBe(false);
    expect(providerCallBound({ provider: "treg", op: "call", routeCapUsd: MAX_SINGLE_OPERATION_USD + 0.01 }).ok).toBe(false);
  });
});

describe("R61 model bound: input <= bytes + allowance, output <= max_tokens (lowered to the gate's cap); anything else that bills is refused", () => {
  const body = (extra: Record<string, unknown> = {}) => ({ model: MODEL_HAIKU, max_tokens: 128000, stream: true, system: "x", messages: [{ role: "user", content: "hello" }], thinking: { type: "adaptive", display: "updates" }, context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] }, output_config: { effort: "medium" }, metadata: {}, tools: [{ name: "mcp__diger__run_code", input_schema: { type: "object" } }], ...extra });
  const bytes = (b: unknown) => Buffer.byteLength(JSON.stringify(b));

  it("the Agent SDK's own request shape (measured: these exact fields, max_tokens 128000) is bounded, and max_tokens is lowered to the cap", () => {
    const b = body();
    const r = modelRequestBound(b, bytes(b));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.maxTokens).toBe(DEFAULT_GATE_MAX_OUTPUT_TOKENS);
    expect(r.body.max_tokens).toBe(DEFAULT_GATE_MAX_OUTPUT_TOKENS);
    expect(r.inputTokenBound).toBe(bytes(b) + TEMPLATE_TOKEN_ALLOWANCE);
    expect(r.usd).toBeCloseTo(((bytes(b) + TEMPLATE_TOKEN_ALLOWANCE) * 0.1 * 1.25 + 32000 * 0.5) / 1e6, 5);
    expect(r.usd).toBeGreaterThanOrEqual(((bytes(b) + TEMPLATE_TOKEN_ALLOWANCE) * 0.1 * 1.25 + 32000 * 0.5) / 1e6);
  });
  it.each([
    ["fast mode", { speed: "fast" }], ["a fallback model", { fallbacks: "default" }], ["a server-kept thread", { thread: { id: "t" } }], ["a service tier", { service_tier: "priority" }],
    ["an inference region", { inference_geo: "us" }], ["a container", { container: {} }], ["MCP servers", { mcp_servers: [] }],
    ["a server tool (billed per use)", { tools: [{ type: "web_search_20260209", name: "web_search" }] }], ["compaction", { context_management: { edits: [{ type: "compact_20260112" }] } }],
    ["an image (tokens not bounded by bytes)", { messages: [{ role: "user", content: [{ type: "image", source: { type: "url", url: "https://x/y.png" } }] }] }],
    ["a document inside a tool result", { messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: [{ type: "document", source: { type: "file", file_id: "f" } }] }] }] }],
    ["an unknown model", { model: "claude-unknown-1" }], ["no max_tokens", { max_tokens: undefined }],
  ])("refuses %s", (_name, extra) => {
    const b = JSON.parse(JSON.stringify(body(extra as Record<string, unknown>)));
    expect(modelRequestBound(b, bytes(b))).toMatchObject({ ok: false, reason: "no_safe_bound" });
  });
  it("a one-hour cache write prices input at 2x; above 100K tokens Haiku is priced at its long-context rate; Sonnet has its own table", () => {
    const b = body({ system: [{ type: "text", text: "x", cache_control: { type: "ephemeral", ttl: "1h" } }] });
    const r = modelRequestBound(b, 1000);
    expect(r.ok && r.usd).toBeCloseTo(((1000 + 4096) * 0.1 * 2 + 32000 * 0.5) / 1e6, 5);
    const long = modelRequestBound(body(), 200_000);
    expect(long.ok && long.longContext).toBe(true);
    expect(long.ok && long.usd).toBeCloseTo(((204_096) * 0.5 * 1.25 + 32000 * 2.5) / 1e6, 5);
    const sonnet = modelRequestBound(body({ model: MODEL_SONNET }), 1000, { maxOutputTokens: 8000 });
    expect(sonnet.ok && sonnet.usd).toBeCloseTo((5096 * 2 * 1.25 + 8000 * 10) / 1e6, 5);
  });
  it("usage is priced, and a usage above the bound's assumptions is reported as a violation", () => {
    const bound = { inputTokenBound: 5000, maxTokens: 100 };
    expect(modelUsageCost(MODEL_HAIKU, { input_tokens: 1000, output_tokens: 50 }, bound)).toEqual({ usd: Number(((1000 * 0.1 + 50 * 0.5) / 1e6).toFixed(9)), boundViolated: false });
    expect(modelUsageCost(MODEL_HAIKU, { input_tokens: 4000, cache_read_input_tokens: 2000, output_tokens: 1 }, bound).boundViolated).toBe(true);
    expect(modelUsageCost(MODEL_HAIKU, { input_tokens: 1, output_tokens: 101 }, bound).boundViolated).toBe(true);
  });
});

describe("R61 gate rules (the reference model of the SQL functions)", () => {
  it("NO GRANT, NO SPEND: nothing is reserved before the owner issues a grant; starting a mission creates none", async () => {
    const w = world();
    expect(await w.gate.reserve(req("k1", 0.001))).toEqual({ ok: false, reason: "no_grant" });
    // what callers hold has no way to create, raise, reopen or extend a grant
    expect(Object.keys(w.gate).sort()).toEqual(["reserve", "settle", "stop"]);
  });
  it("a grant not yet open, expired, revoked or tripped refuses (fail closed)", async () => {
    const w = world({ opensAt: T0 + 1000 });
    w.grant();
    expect((await w.gate.reserve(req("k1", 0.001))).ok).toBe(false);
    w.advance(1000);
    expect((await w.gate.reserve(req("k2", 0.001))).ok).toBe(true);
    w.advance(3600_000);
    expect(await w.gate.reserve(req("k3", 0.001))).toMatchObject({ ok: false, reason: "grant_expired" });
    const v = world(); v.grant(); v.owner.revoke("g1");
    expect(await v.gate.reserve(req("k1", 0.001))).toMatchObject({ ok: false, reason: "grant_revoked" });
    const s = world(); s.grant(); await s.gate.stop("kill switch");
    expect(await s.gate.reserve(req("k1", 0.001))).toMatchObject({ ok: false, reason: "grant_tripped" });
  });
  it("kinds, the per-operation maximum and bad input are refused", async () => {
    const w = world(); w.grant();
    expect(await w.gate.reserve(req("k1", 0.001, null, "chat"))).toMatchObject({ ok: false, reason: "kind_not_covered" });
    expect(await w.gate.reserve(req("k2", 0.051))).toMatchObject({ ok: false, reason: "over_op_max" });
    expect(await w.gate.reserve(req("k3", 0))).toMatchObject({ ok: false, reason: "bad_input" });
    expect(await w.gate.reserve({ ...req("k4", 0.001), ttlSeconds: 3600 })).toMatchObject({ ok: false, reason: "bad_input" });
  });
  it("CONCURRENCY: 400 simultaneous reservations from four missions never take reserved + spent past the ceiling", async () => {
    const w = world({ perMissionMaxUsd: 1, perOpMaxUsd: 0.05 }); w.grant();
    const results = await Promise.all(Array.from({ length: 400 }, (_, i) => w.gate.reserve(req(`c${i}`, 0.00254, `msn_${i % 4}`))));
    const okCount = results.filter((r) => r.ok).length;
    expect(okCount).toBe(Math.floor(0.1 / 0.00254));
    const g = w.owner.grant("g1")!;
    expect(g.reservedUsd + g.spentUsd).toBeLessThanOrEqual(0.1 + 1e-9);
  });
  it("IDEMPOTENT: the same key returns the same reservation; the same key with another amount is refused; settle twice counts once", async () => {
    const w = world(); w.grant();
    const a = await w.gate.reserve(req("k1", 0.01));
    const b = await w.gate.reserve(req("k1", 0.01));
    expect(a.ok && b.ok && a.reservationId === b.reservationId && b.replay).toBe(true);
    expect(await w.gate.reserve(req("k1", 0.02))).toMatchObject({ ok: false, reason: "key_conflict" });
    if (!a.ok) return;
    expect(await w.gate.settle(a.reservationId, 0.004)).toMatchObject({ ok: true, countedUsd: 0.004, replay: false });
    expect(await w.gate.settle(a.reservationId, 0.009)).toMatchObject({ ok: true, countedUsd: 0.004, replay: true });
    expect(w.owner.grant("g1")).toMatchObject({ reservedUsd: 0, spentUsd: 0.004 });
  });
  it("AN UNKNOWN CHARGE (no answer, cut stream) keeps the whole bound; a known $0 failure releases it", async () => {
    const w = world(); w.grant();
    const a = await w.gate.reserve(req("k1", 0.01));
    const b = await w.gate.reserve(req("k2", 0.01));
    if (!a.ok || !b.ok) throw new Error("reserve");
    await w.gate.settle(a.reservationId, null);
    await w.gate.settle(b.reservationId, 0);
    expect(w.owner.grant("g1")).toMatchObject({ reservedUsd: 0, spentUsd: 0.01 });
  });
  it("AN OVERRUN never passes the ceiling silently: the bound counts, the excess is recorded, the grant TRIPS and refuses everything after", async () => {
    const w = world(); w.grant();
    const a = await w.gate.reserve(req("k1", 0.01));
    if (!a.ok) throw new Error("reserve");
    expect(await w.gate.settle(a.reservationId, 0.013)).toMatchObject({ ok: true, countedUsd: 0.01, overrunUsd: 0.003 });
    expect(w.owner.grant("g1")).toMatchObject({ spentUsd: 0.01, overrunUsd: 0.003, state: "tripped" });
    expect(await w.gate.reserve(req("k2", 0.001))).toMatchObject({ ok: false, reason: "grant_tripped" });
  });
  it("EXPIRY: a reservation held past its time (a worker killed mid-call) keeps its bound as SPENT, and a late settle cannot release it", async () => {
    const w = world(); w.grant();
    const a = await w.gate.reserve(req("k1", 0.02));
    if (!a.ok) throw new Error("reserve");
    w.advance(61_000);
    await w.gate.reserve(req("k2", 0.001)); // any reserve expires the stale ones first: no scheduled job is needed for safety
    expect(w.owner.grant("g1")).toMatchObject({ spentUsd: 0.02 });
    expect(await w.gate.settle(a.reservationId, 0)).toMatchObject({ ok: true, state: "expired", countedUsd: 0.02, replay: true });
  });
  it("PER MISSION: one mission cannot take more than the grant's per-mission maximum, held or spent", async () => {
    const w = world({ perMissionMaxUsd: 0.03, perOpMaxUsd: 0.02 }); w.grant();
    expect((await w.gate.reserve(req("k1", 0.02, "msn_a"))).ok).toBe(true);
    expect(await w.gate.reserve(req("k2", 0.02, "msn_a"))).toMatchObject({ ok: false, reason: "over_mission_ceiling" });
    expect((await w.gate.reserve(req("k3", 0.02, "msn_b"))).ok).toBe(true);
  });
  it("only one open grant at a time; the owner cannot issue a nonsensical grant", () => {
    const w = world(); w.grant();
    expect(() => w.grant()).toThrow(/one open grant/);
    const v = world({ closesAt: T0 });
    expect(() => v.grant()).toThrow(/bad grant/);
  });
});

describe("R61 guarded call and mode: OFF changes nothing, ENFORCE fails closed", () => {
  it("DIGER_SPEND_GATE: unset/off/0 -> off, observe -> observe, anything else (a typo too) -> enforce", () => {
    expect(spendGateMode({})).toBe("off");
    expect(spendGateMode({ DIGER_SPEND_GATE: "0" })).toBe("off");
    expect(spendGateMode({ DIGER_SPEND_GATE: "observe" })).toBe("observe");
    expect(spendGateMode({ DIGER_SPEND_GATE: "enforced" })).toBe("enforce");
  });
  it("OFF: the call runs exactly as today, with no gate at all", async () => {
    let calls = 0;
    const r = await guardedPaidCall({ gate: null, mode: "off" }, req("k", 0.01), async () => { calls += 1; return { value: 7, actualUsd: 0.01 }; });
    expect(r).toEqual({ ran: true, value: 7, reservationId: null });
    expect(calls).toBe(1);
  });
  it("ENFORCE: a gate that throws, hangs past 2 s, or is missing means NO call (a database outage stops spending)", async () => {
    let calls = 0;
    const call = async () => { calls += 1; return { value: 1, actualUsd: 0 }; };
    const throwing: SpendGate = { reserve: async () => { throw new Error("db down"); }, settle: async () => ({ ok: false, reason: "gate_unavailable" }), stop: async () => undefined };
    const hanging: SpendGate = { reserve: () => new Promise(() => undefined), settle: async () => ({ ok: false, reason: "gate_unavailable" }), stop: async () => undefined };
    expect(await guardedPaidCall({ gate: throwing, mode: "enforce" }, req("k", 0.01), call)).toMatchObject({ ran: false, refused: "gate_unavailable" });
    expect(await guardedPaidCall({ gate: hanging, mode: "enforce", timeoutMs: 20 }, req("k", 0.01), call)).toMatchObject({ ran: false, refused: "gate_unavailable" });
    expect(await guardedPaidCall({ gate: null, mode: "enforce" }, req("k", 0.01), call)).toMatchObject({ ran: false, refused: "gate_unavailable" });
    expect(await guardedPaidCall({ gate: null, mode: "enforce" }, { refuse: "no_safe_bound", detail: "parser" }, call)).toMatchObject({ ran: false, refused: "no_safe_bound" });
    expect(calls).toBe(0);
  });
  it("OBSERVE: a refusal is only reported, the call runs; a call that throws settles as UNKNOWN (its bound stays spent)", async () => {
    const w = world(); w.grant();
    const events: string[] = [];
    const r = await guardedPaidCall({ gate: w.gate, mode: "observe", onEvent: (e) => events.push(e.type) }, req("k0", 0.051), async () => ({ value: 1, actualUsd: 0.001 }));
    expect(r).toMatchObject({ ran: true, observedRefusal: "over_op_max" });
    expect(events).toContain("spend_gate.refused");
    await expect(guardedPaidCall({ gate: w.gate, mode: "enforce" }, req("k1", 0.01), async () => { throw new Error("socket hang up"); })).rejects.toThrow(/hang up/);
    expect(w.owner.grant("g1")).toMatchObject({ reservedUsd: 0, spentUsd: 0.01 });
  });
});

describe("R61 model gate: every model request of the SDK child is bounded and reserved BEFORE it leaves (fake upstream on 127.0.0.1)", () => {
  const servers: http.Server[] = [];
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const c of closers.splice(0)) await c(); for (const s of servers.splice(0)) s.close(); });

  async function fakeAnthropic(mode: "sse" | "json" | "cut" | "truncated" | "429" | "overuse") {
    const seen: Array<{ key: string | undefined; body: any }> = [];
    const server = http.createServer((req, res) => {
      let raw = ""; req.on("data", (c) => (raw += c)); req.on("end", () => {
        const body = JSON.parse(raw);
        seen.push({ key: req.headers["x-api-key"] as string | undefined, body });
        if (mode === "429") { res.writeHead(429, { "content-type": "application/json" }); res.end('{"type":"error","error":{"type":"rate_limit_error","message":"slow"}}'); return; }
        const usage = mode === "overuse" ? { input_tokens: 999_999, output_tokens: 3 } : { input_tokens: 120, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 };
        if (mode === "json") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ id: "m", type: "message", content: [], usage: { ...usage, output_tokens: 9 } })); return; }
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m", usage } })}\n\n`);
        res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } })}\n\n`);
        if (mode === "cut") { res.destroy(); return; }
        if (mode === "truncated") { res.end(); return; }
        res.write(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } })}\n\n`);
        res.write(`event: message_stop\ndata: {"type":"message_stop"}\n\n`);
        res.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    servers.push(server);
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
  }
  async function gateOver(upstream: string, mode: "enforce" | "observe" = "enforce", over: Partial<Parameters<ReturnType<typeof createMemorySpendGate>["owner"]["issueGrant"]>[0]> = {}) {
    const w = world({ kinds: ["model"], ...over }); w.grant();
    const g = await startModelGate({ upstreamBaseUrl: upstream, apiKey: "real-key-stays-in-worker", gate: w.gate, mode, missionId: "msn_a", maxOutputTokens: 4000 });
    closers.push(g.close);
    return { w, g };
  }
  const ask = (g: { baseUrl: string; childToken: string }, body: Record<string, unknown>, token = g.childToken, p = "/v1/messages?beta=true") =>
    fetch(`${g.baseUrl}${p}`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": token, "anthropic-version": "2023-06-01" }, body: JSON.stringify(body) });
  const sdkBody = { model: MODEL_HAIKU, max_tokens: 128000, stream: true, system: "x", messages: [{ role: "user", content: "say done" }] };

  it("a streamed request: max_tokens lowered to the cap, the REAL key added only upstream, the reservation settled from the stream's usage", async () => {
    const up = await fakeAnthropic("sse");
    const { w, g } = await gateOver(up.url);
    const r = await ask(g, sdkBody);
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("message_stop");
    expect(up.seen).toHaveLength(1);
    expect(up.seen[0].key).toBe("real-key-stays-in-worker");
    expect(up.seen[0].body.max_tokens).toBe(4000);
    expect(g.childEnv.ANTHROPIC_API_KEY).not.toContain("real-key");
    await new Promise((res) => setTimeout(res, 20));
    expect(w.owner.grant("g1")).toMatchObject({ reservedUsd: 0, spentUsd: Number(((120 * 0.1 + 7 * 0.5) / 1e6).toFixed(6)) });
    expect(g.stats()).toMatchObject({ requests: 1, forwarded: 1, refused: 0, unknownCharge: 0 });
  });
  it("REFUSED BEFORE SENDING: over the ceiling, no grant, or no bound -> HTTP 400 and the upstream never sees the request", async () => {
    const up = await fakeAnthropic("sse");
    const { g } = await gateOver(up.url, "enforce", { ceilingUsd: 0.001 });
    const r = await ask(g, sdkBody);
    expect(r.status).toBe(400);
    expect(await r.text()).toMatch(/spend_gate_refused: over_ceiling/);
    const r2 = await ask(g, { ...sdkBody, max_tokens: 10, speed: "fast" });
    expect(await r2.text()).toMatch(/spend_gate_refused: the field «speed»/);
    expect(up.seen).toHaveLength(0);
    const gNoGrant = await startModelGate({ upstreamBaseUrl: up.url, apiKey: "k", gate: createMemorySpendGate().gate, mode: "enforce", missionId: null });
    closers.push(gNoGrant.close);
    expect(await (await ask(gNoGrant, { ...sdkBody, max_tokens: 10 })).text()).toMatch(/no_grant/);
    expect(up.seen).toHaveLength(0);
  });
  it("only the child's token is served, only /v1/messages is gated, everything else is refused locally", async () => {
    const up = await fakeAnthropic("sse");
    const { g } = await gateOver(up.url);
    expect((await ask(g, sdkBody, "real-key-stays-in-worker")).status).toBe(401);
    expect((await ask(g, sdkBody, g.childToken, "/v1/messages/batches")).status).toBe(403);
    expect((await fetch(`${g.baseUrl}/api/hello`, { method: "HEAD" })).status).toBe(200);
    expect(up.seen).toHaveLength(0);
  });
  it("a stream cut before its final event, and a non-streamed answer: the first keeps its WHOLE bound (charge unknown), the second is priced", async () => {
    const cut = await fakeAnthropic("cut");
    const a = await gateOver(cut.url);
    await ask(a.g, sdkBody).then((r) => r.text()).catch(() => "");
    await new Promise((res) => setTimeout(res, 50));
    const ga = a.w.owner.grant("g1")!;
    expect(ga.reservedUsd).toBe(0);
    expect(ga.spentUsd).toBeGreaterThan(4000 * 0.5 / 1e6);
    expect(a.g.stats().unknownCharge).toBe(1);
    // a stream that ENDS cleanly but without message_stop is not a finished answer either: its usage so far is not the bill
    const trunc = await fakeAnthropic("truncated");
    const t = await gateOver(trunc.url);
    await (await ask(t.g, sdkBody)).text();
    await new Promise((res) => setTimeout(res, 30));
    expect(t.w.owner.grant("g1")!.spentUsd).toBeGreaterThan(4000 * 0.5 / 1e6);
    const json = await fakeAnthropic("json");
    const b = await gateOver(json.url);
    await (await ask(b.g, { ...sdkBody, stream: false })).text();
    await new Promise((res) => setTimeout(res, 20));
    expect(b.w.owner.grant("g1")!.spentUsd).toBeCloseTo((120 * 0.1 + 9 * 0.5) / 1e6, 6);
  });
  it("a 429 (not processed) releases the reservation; each SDK retry is a new request and a new reservation", async () => {
    const up = await fakeAnthropic("429");
    const { w, g } = await gateOver(up.url);
    expect((await ask(g, sdkBody)).status).toBe(429);
    expect((await ask(g, sdkBody)).status).toBe(429);
    await new Promise((res) => setTimeout(res, 20));
    expect(w.owner.grant("g1")).toMatchObject({ reservedUsd: 0, spentUsd: 0 });
    expect(up.seen).toHaveLength(2);
  });
  it("a usage above the input bound (the tokenizer assumption broken) is recorded and STOPS the grant in enforce mode", async () => {
    const up = await fakeAnthropic("overuse");
    const { w, g } = await gateOver(up.url);
    await (await ask(g, sdkBody)).text();
    await new Promise((res) => setTimeout(res, 30));
    expect(g.stats().boundViolations).toBe(1);
    expect(w.owner.grant("g1")!.state).toBe("tripped");
    expect((await ask(g, sdkBody)).status).toBe(400);
  });
  it("OBSERVE forwards the SDK's request unchanged (max_tokens too) and only records", async () => {
    const up = await fakeAnthropic("sse");
    const { g } = await gateOver(up.url, "observe", { ceilingUsd: 0.000001 });
    expect((await ask(g, sdkBody)).status).toBe(200);
    expect(up.seen[0].body.max_tokens).toBe(128000);
  });
});

describe("R61: NOT WIRED (this PR changes no production behaviour)", () => {
  it("no production source imports the spend gate or the model gate (only the gate's own files and the tests)", () => {
    const roots = ["src", "agent/src"].map((r) => path.resolve(__dirname, "..", r));
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = path.join(dir, name);
        if (statSync(p).isDirectory()) { if (name !== "node_modules") walk(p); continue; }
        if (!/\.(ts|tsx)$/.test(name)) continue;
        const rel = path.relative(path.resolve(__dirname, ".."), p);
        if (rel.startsWith(path.join("src", "lib", "server", "spendGate")) || rel === path.join("agent", "src", "modelGate.ts")) continue;
        if (/spendGate\/|modelGate/.test(readFileSync(p, "utf8"))) offenders.push(rel);
      }
    };
    roots.forEach(walk);
    expect(offenders).toEqual([]);
  });
});
