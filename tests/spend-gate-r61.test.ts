import http from "node:http";
import type { AddressInfo } from "node:net";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { providerCallBound, tregRouteCapUsd, MAX_SINGLE_OPERATION_USD } from "../src/lib/server/spendGate/bounds";
import { modelRequestBound, modelUsageCost, DEFAULT_GATE_MAX_OUTPUT_TOKENS, TEMPLATE_TOKEN_ALLOWANCE } from "../src/lib/server/spendGate/modelBound";
import { createMemorySpendGate, guardedPaidCall, spendGateMode, type SpendGate } from "../src/lib/server/spendGate/gate";
import { ALLOWED_ANTHROPIC_BETAS, checkAnthropicBetas, isLoopbackAddress, startModelGate } from "../agent/src/modelGate";
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

  async function fakeAnthropic(mode: "sse" | "json" | "cut" | "truncated" | "429" | "overuse" | "long") {
    const seen: Array<{ key: string | undefined; body: any; beta: string | undefined }> = [];
    const server = http.createServer((req, res) => {
      let raw = ""; req.on("data", (c) => (raw += c)); req.on("end", () => {
        const body = JSON.parse(raw);
        seen.push({ key: req.headers["x-api-key"] as string | undefined, body, beta: req.headers["anthropic-beta"] as string | undefined });
        if (mode === "429") { res.writeHead(429, { "content-type": "application/json" }); res.end('{"type":"error","error":{"type":"rate_limit_error","message":"slow"}}'); return; }
        const usage = mode === "overuse" ? { input_tokens: 999_999, output_tokens: 3 } : { input_tokens: 120, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 };
        if (mode === "json") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ id: "m", type: "message", content: [], usage: { ...usage, output_tokens: 9 } })); return; }
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m", usage } })}\n\n`);
        res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } })}\n\n`);
        if (mode === "cut") { res.destroy(); return; }
        if (mode === "truncated") { res.end(); return; }
        res.write(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: mode === "long" ? 50_000 : 7 } })}\n\n`);
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

  // ---- PR #479 review fixes ----------------------------------------------------------------------------------------------------------------------
  /** A gate whose reservations are recorded (the bound each request reserved), with every event kept for the no-secret checks. */
  async function spyGate(upstream: string, mode: "enforce" | "observe", over: Partial<Parameters<ReturnType<typeof createMemorySpendGate>["owner"]["issueGrant"]>[0]> = {}, extra: { maxOutputTokens?: number } = {}) {
    const w = world({ kinds: ["model"], ...over }); w.grant();
    const bounds: number[] = [];
    const events: Array<{ type: string; detail?: string }> = [];
    const spied: SpendGate = { ...w.gate, reserve: (r) => { bounds.push(r.boundUsd); return w.gate.reserve(r); } };
    const g = await startModelGate({ upstreamBaseUrl: upstream, apiKey: "real-key-stays-in-worker", gate: spied, mode, missionId: "msn_a", maxOutputTokens: extra.maxOutputTokens ?? 4000, onEvent: (e) => events.push(e) });
    closers.push(g.close);
    return { w, g, bounds, events };
  }
  const settle = () => new Promise((res) => setTimeout(res, 20));
  const askWith = (g: { baseUrl: string; childToken: string }, body: Record<string, unknown>, headers: Record<string, string>) =>
    fetch(`${g.baseUrl}/v1/messages?beta=true`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": g.childToken, "anthropic-version": "2023-06-01", ...headers }, body: JSON.stringify(body) });
  /** A raw request (node:http), for credentials fetch would normalize or refuse to send. */
  const rawAsk = (g: { baseUrl: string }, headers: Record<string, string>) => new Promise<{ status: number; text: string }>((resolve, reject) => {
    const u = new URL(`${g.baseUrl}/v1/messages`);
    const r = http.request({ host: u.hostname, port: Number(u.port), path: u.pathname, method: "POST", headers: { "content-type": "application/json", ...headers } }, (res) => {
      let t = ""; res.setEncoding("latin1"); res.on("data", (c) => (t += c)); res.on("end", () => resolve({ status: res.statusCode ?? 0, text: t }));
    });
    r.on("error", reject); r.end(JSON.stringify(sdkBody));
  });
  const bytesOf = (b: Record<string, unknown>) => Buffer.byteLength(JSON.stringify(b));
  const roomyGrant = { ceilingUsd: 0.5, perOpMaxUsd: 0.2, perMissionMaxUsd: 0.5 };

  describe("FINDING 1: OBSERVE reserves the bound of the request it forwards, never the capped bound", () => {
    it("ABOVE the cap: max_tokens 128000 is forwarded, the reservation is its as-sent bound, and an answer longer than the cap does NOT trip the grant", async () => {
      const up = await fakeAnthropic("long");
      const { w, g, bounds } = await spyGate(up.url, "observe", roomyGrant);
      expect((await (await ask(g, sdkBody)).text())).toContain("message_stop");
      await settle();
      expect(up.seen[0].body.max_tokens).toBe(128000);
      const asSent = modelRequestBound(sdkBody, bytesOf(sdkBody), { maxOutputTokens: Number.MAX_SAFE_INTEGER });
      const capped = modelRequestBound(sdkBody, bytesOf(sdkBody), { maxOutputTokens: 4000 });
      expect(asSent.ok && capped.ok).toBe(true);
      if (!asSent.ok || !capped.ok) return;
      expect(bounds).toEqual([asSent.usd]);
      expect(asSent.usd).toBeGreaterThan(capped.usd);
      // 50,000 output tokens: above the 4,000 cap (the old accounting's bound) but inside the forwarded request's own max_tokens
      const actual = Number(((120 * 0.1 + 50_000 * 0.5) / 1e6).toFixed(6));
      expect(actual).toBeGreaterThan(capped.usd);
      expect(w.owner.grant("g1")).toMatchObject({ state: "open", reservedUsd: 0, spentUsd: actual, overrunUsd: 0 });
      expect(g.stats()).toMatchObject({ boundViolations: 0, unreserved: 0, refused: 0 });
    });
    it("BELOW the cap: a request asking 1000 tokens is reserved and forwarded at 1000 in both modes, and settled by its usage", async () => {
      for (const mode of ["observe", "enforce"] as const) {
        const up = await fakeAnthropic("sse");
        const { w, g, bounds } = await spyGate(up.url, mode, roomyGrant);
        const body = { ...sdkBody, max_tokens: 1000 };
        expect((await ask(g, body)).status).toBe(200);
        await settle();
        expect(up.seen[0].body.max_tokens).toBe(1000);
        const b = modelRequestBound(body, bytesOf(body), { maxOutputTokens: 4000 });
        expect(b.ok && bounds).toEqual([b.ok ? b.usd : 0]);
        expect(w.owner.grant("g1")).toMatchObject({ state: "open", reservedUsd: 0, overrunUsd: 0, spentUsd: Number(((120 * 0.1 + 7 * 0.5) / 1e6).toFixed(6)) });
      }
    });
    it("ENFORCE is unchanged: above the cap, max_tokens is lowered to the cap and the capped bound is reserved", async () => {
      const up = await fakeAnthropic("sse");
      const { g, bounds } = await spyGate(up.url, "enforce", roomyGrant);
      expect((await ask(g, sdkBody)).status).toBe(200);
      const capped = modelRequestBound(sdkBody, bytesOf(sdkBody), { maxOutputTokens: 4000 });
      expect(up.seen[0].body.max_tokens).toBe(4000);
      expect(bounds).toEqual([capped.ok ? capped.usd : -1]);
    });
    it("an as-sent bound that cannot be reserved (Sonnet asking 128000 tokens: above $1) is forwarded UNRESERVED in observe, and its usage is reported apart", async () => {
      const up = await fakeAnthropic("sse");
      const { w, g, bounds, events } = await spyGate(up.url, "observe", roomyGrant);
      const body = { ...sdkBody, model: MODEL_SONNET };
      expect(modelRequestBound(body, bytesOf(body), { maxOutputTokens: Number.MAX_SAFE_INTEGER }).ok).toBe(false);
      expect((await ask(g, body)).status).toBe(200);
      await settle();
      expect(bounds).toEqual([]);
      expect(up.seen[0].body.max_tokens).toBe(128000);
      expect(w.owner.grant("g1")).toMatchObject({ state: "open", reservedUsd: 0, spentUsd: 0 });
      expect(g.stats()).toMatchObject({ unreserved: 1, unreservedUsd: Number(((120 * 2 + 7 * 10) / 1e6).toFixed(9)) });
      expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(["model_gate.observed_unreserved", "model_gate.observed_unreserved_usage"]));
    });
    it("OBSERVE does not lower the SDK's own output cap (the child runs as today); ENFORCE does", async () => {
      const up = await fakeAnthropic("sse");
      const o = await spyGate(up.url, "observe");
      const e = await spyGate(up.url, "enforce");
      expect(o.g.childEnv).not.toHaveProperty("CLAUDE_CODE_MAX_OUTPUT_TOKENS");
      expect(e.g.childEnv.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe("4000");
    });
  });

  describe("FINDING 2: anthropic-beta passes only an allowlist whose billing is inside the request bound", () => {
    /** Measured: what the Agent SDK 0.3.312 sends on every request (fake upstream on 127.0.0.1, 13 Nov 2026). */
    const SDK_BETAS = "interleaved-thinking-2025-05-14,context-management-2025-06-27,claude-code-20250219,per-turn-control-2026-07-01,mid-conversation-tool-changes-2026-07-01,inline-tools-2026-09-15,advisor-tool-2026-03-01,thinking-token-count-2026-05-13,effort-2025-11-24,thinking-display-updates-2026-08-18";
    it("the allowlist is exactly the SDK's measured set, each entry with a reason", () => {
      expect(Object.keys(ALLOWED_ANTHROPIC_BETAS).sort()).toEqual(SDK_BETAS.split(",").sort());
      for (const reason of Object.values(ALLOWED_ANTHROPIC_BETAS)) expect(reason.length).toBeGreaterThan(10);
    });
    it("ENFORCE forwards the SDK's betas (checked, de-duplicated) and the request goes through", async () => {
      const up = await fakeAnthropic("sse");
      const { g } = await spyGate(up.url, "enforce", roomyGrant);
      expect((await askWith(g, sdkBody, { "anthropic-beta": `${SDK_BETAS}, effort-2025-11-24` })).status).toBe(200);
      expect(up.seen[0].beta).toBe(SDK_BETAS);
    });
    it("ENFORCE refuses, BEFORE sending and before reserving, a beta that bills by the header alone or is unknown", async () => {
      const refused = ["context-1m-2025-08-07", "fast-mode-2026-02-01", "compact-2026-01-12", "message-threads-2026-08-12", "mcp-client-2025-11-20", "code-execution-2025-08-25", "files-api-2025-04-14", "server-side-fallback-2026-07-01", "output-300k-2026-03-24", "some-future-capability-2027-01-01"];
      const up = await fakeAnthropic("sse");
      const { w, g, bounds } = await spyGate(up.url, "enforce", roomyGrant);
      for (const beta of refused) {
        const r = await askWith(g, sdkBody, { "anthropic-beta": `effort-2025-11-24,${beta}` });
        expect(r.status, beta).toBe(400);
        expect(await r.text()).toContain(`«${beta}» is not allowed`);
      }
      expect(up.seen).toHaveLength(0);
      expect(bounds).toEqual([]);
      expect(w.owner.grant("g1")).toMatchObject({ reservedUsd: 0, spentUsd: 0 });
      expect(g.stats()).toMatchObject({ refused: refused.length, forwarded: 0 });
    });
    it("a malformed header is refused whole, and the malformed value is never echoed", () => {
      const bad = ["", " , ", "effort-2025-11-24,", "Effort-2025-11-24", "effort 2025", "effort;2025", "evilé-1", `x${"-a".repeat(60)}`, "a".repeat(2049), Array.from({ length: 33 }, () => "effort-2025-11-24").join(",")];
      for (const h of bad) {
        const r = checkAnthropicBetas(h);
        expect(r.ok, JSON.stringify(h).slice(0, 40)).toBe(false);
        if (!r.ok && h.length > 3 && !h.includes("effort-2025-11-24")) expect(r.detail).not.toContain(h);
      }
      expect(checkAnthropicBetas(undefined)).toEqual({ ok: true, values: [] });
      expect(checkAnthropicBetas(["effort-2025-11-24", "claude-code-20250219, effort-2025-11-24"])).toEqual({ ok: true, values: ["effort-2025-11-24", "claude-code-20250219"] });
    });
    it("OBSERVE forwards an unknown beta exactly as sent, UNRESERVED, and records that enforce would refuse it", async () => {
      const up = await fakeAnthropic("sse");
      const { w, g, bounds, events } = await spyGate(up.url, "observe", roomyGrant);
      expect((await askWith(g, sdkBody, { "anthropic-beta": "context-1m-2025-08-07" })).status).toBe(200);
      await settle();
      expect(up.seen[0].beta).toBe("context-1m-2025-08-07");
      expect(bounds).toEqual([]);
      expect(w.owner.grant("g1")).toMatchObject({ reservedUsd: 0, spentUsd: 0 });
      expect(g.stats()).toMatchObject({ unreserved: 1 });
      expect(events.find((e) => e.type === "model_gate.observed_refusal")?.detail).toContain("context-1m-2025-08-07");
    });
    it("the INERT allowed betas stay inert: their billable body forms (tool_addition blocks, an advisor tool) are refused by the body check", async () => {
      const up = await fakeAnthropic("sse");
      const { g } = await spyGate(up.url, "enforce", roomyGrant);
      const withAddition = { ...sdkBody, max_tokens: 10, messages: [{ role: "user", content: "hi" }, { role: "system", content: [{ type: "tool_addition", tool: { type: "web_search_20260209", name: "web_search" } }] }] };
      const withAdvisor = { ...sdkBody, max_tokens: 10, tools: [{ type: "advisor_20260301", name: "advisor", model: MODEL_SONNET }] };
      expect((await askWith(g, withAddition, { "anthropic-beta": "inline-tools-2026-09-15,mid-conversation-tool-changes-2026-07-01" })).status).toBe(400);
      expect((await askWith(g, withAdvisor, { "anthropic-beta": "advisor-tool-2026-03-01" })).status).toBe(400);
      expect(up.seen).toHaveLength(0);
    });
  });

  describe("FINDING 3: the child's token is checked in constant time, on loopback only", () => {
    it("valid tokens pass, by x-api-key and by Authorization: Bearer (the scheme in any case)", async () => {
      const up = await fakeAnthropic("sse");
      const { g } = await spyGate(up.url, "enforce", roomyGrant);
      expect((await rawAsk(g, { "x-api-key": g.childToken })).status).toBe(200);
      expect((await rawAsk(g, { authorization: `Bearer ${g.childToken}` })).status).toBe(200);
      expect((await rawAsk(g, { authorization: `bearer ${g.childToken}` })).status).toBe(200);
      expect(up.seen).toHaveLength(3);
    });
    it("invalid, malformed and missing tokens are refused with 401, never forwarded, never reserved, and never echoed", async () => {
      const up = await fakeAnthropic("sse");
      const { g, bounds } = await spyGate(up.url, "enforce", roomyGrant);
      const t = g.childToken;
      const flip = t.slice(0, -1) + (t.endsWith("0") ? "1" : "0");
      const cases: Array<Record<string, string>> = [
        {},                                             // missing
        { "x-api-key": "" },                            // empty
        { "x-api-key": flip },                          // same length, one character off
        { "x-api-key": t.slice(0, -1) },                // truncated
        { "x-api-key": `${t}x` },                       // extended
        { "x-api-key": "real-key-stays-in-worker" },    // the real key is not the child's credential
        { "x-api-key": "a".repeat(10_000) },            // oversize
        { "x-api-key": `${t.slice(0, 8)}é${t.slice(9)}` }, // non-ASCII byte
        { authorization: "Bearer" },                    // scheme with no token
        { authorization: `Basic ${t}` },                // wrong scheme
        { authorization: `Bearer ${t} extra` },         // trailing garbage
        { authorization: t },                           // no scheme
        { "x-api-key": flip, authorization: `Bearer ${t}` }, // a wrong x-api-key is not rescued by a right Authorization
      ];
      for (const h of cases) {
        const r = await rawAsk(g, h);
        expect(r.status, JSON.stringify(h).slice(0, 60)).toBe(401);
        for (const v of Object.values(h)) if (v.length > 6) expect(r.text).not.toContain(v);
      }
      expect(up.seen).toHaveLength(0);
      expect(bounds).toEqual([]);
      expect(g.stats()).toMatchObject({ unauthorized: cases.length, requests: 0, forwarded: 0 });
    });
    it("the gate binds 127.0.0.1 and accepts only loopback peers; the source compares digests with timingSafeEqual, never the raw token", () => {
      expect(isLoopbackAddress("127.0.0.1")).toBe(true);
      expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
      for (const a of ["10.0.0.5", "192.168.1.2", "::1", "0.0.0.0", "", undefined]) expect(isLoopbackAddress(a)).toBe(false);
      const src = readFileSync(path.resolve(__dirname, "../agent/src/modelGate.ts"), "utf8");
      expect(src).toMatch(/timingSafeEqual\(sha256\(presented\), childTokenDigest\)/);
      expect(src).not.toMatch(/[!=]==\s*childToken\b|childToken\s*[!=]==/);
      expect(src).toMatch(/server\.listen\(0, "127\.0\.0\.1"/);
    });
    it("a live gate's address is 127.0.0.1", async () => {
      const up = await fakeAnthropic("sse");
      const { g } = await spyGate(up.url, "enforce");
      expect(new URL(g.baseUrl).hostname).toBe("127.0.0.1");
    });
  });

  it("NO SECRET IN EVENTS: across refusals, unauthorized calls, observe and enforce, no event carries the real key or the child's token", async () => {
    const up = await fakeAnthropic("long");
    const all: Array<{ type: string; detail?: string }> = [];
    for (const mode of ["enforce", "observe"] as const) {
      const { g, events } = await spyGate(up.url, mode, { ceilingUsd: 0.001, perOpMaxUsd: 0.001, perMissionMaxUsd: 0.001 });
      await (await ask(g, sdkBody)).text();
      await (await askWith(g, sdkBody, { "anthropic-beta": "context-1m-2025-08-07" })).text();
      await (await ask(g, { ...sdkBody, model: "no-such-model" })).text();
      await rawAsk(g, { "x-api-key": `${g.childToken}x` });
      await settle();
      expect(events.length).toBeGreaterThan(0);
      for (const e of events) expect(`${e.type} ${e.detail ?? ""}`).not.toContain(g.childToken.slice(5));
      all.push(...events);
    }
    for (const e of all) expect(`${e.type} ${e.detail ?? ""}`).not.toContain("real-key-stays-in-worker");
  });
});

describe("R62: WIRED INTO THE WORKER ONLY (the website is not wired; the gate stays off unless DIGER_SPEND_GATE is set)", () => {
  it("only the listed worker files reference the spend gate or the model gate; no website source does", () => {
    const roots = ["src", "agent/src"].map((r) => path.resolve(__dirname, "..", r));
    const users: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = path.join(dir, name);
        if (statSync(p).isDirectory()) { if (name !== "node_modules") walk(p); continue; }
        if (!/\.(ts|tsx)$/.test(name)) continue;
        const rel = path.relative(path.resolve(__dirname, ".."), p);
        if (rel.startsWith(path.join("src", "lib", "server", "spendGate")) || rel === path.join("agent", "src", "modelGate.ts")) continue;
        if (/spendGate\/|modelGate|spendGateWiring/.test(readFileSync(p, "utf8"))) users.push(rel.split(path.sep).join("/"));
      }
    };
    roots.forEach(walk);
    // round 62 (PR B): the worker's paid call sites and the files that carry the gate to them. A new user must be added here on purpose, after review.
    expect(users.sort()).toEqual([
      "agent/src/driver.ts", "agent/src/gateway.ts", "agent/src/main.ts", "agent/src/runMission.ts", "agent/src/sdkOptions.ts", "agent/src/sdkRuntime.ts",
      "agent/src/spendGateKeys.ts", "agent/src/spendGateWiring.ts", "agent/src/webGateway.ts",
    ]);
    expect(users.filter((u) => u.startsWith("src/"))).toEqual([]);
  });
});
