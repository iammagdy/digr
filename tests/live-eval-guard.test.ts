import { describe, expect, it, vi } from "vitest";
import { createSpendingGuard, preflight, GuardRefusal, CONFIRM_VALUE, COUNT_MARGIN_TOKENS, MAX_PAID_ATTEMPTS, EVAL_MODEL } from "../evals/live-intelligence/budget";
import { callClaudeChatWith } from "../src/lib/agentMission/chatModel";

/**
 * THE LIVE EVALUATION'S SPENDING GUARD, OFFLINE (docs/LIVE-INTELLIGENCE-EVAL.md): a fake network only. No key, no paid call. Proves the caps hold for every HTTP attempt, the transport's 400-retry included,
 * that every host except the Anthropic API is blocked before any I/O, and that the preflight refuses an unisolated environment.
 */
const FAKE_KEY = "sk-fake-guard-test-0000";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const message = (input: number, output: number, stop = "end_turn") => json(200, { type: "message", content: [{ type: "text", text: '{"type":"other","reason":"x","reply":"أهلًا؟"}' }], stop_reason: stop, usage: { input_tokens: input, output_tokens: output } });

function fakeNet(o: { count?: number | null; reply?: (n: number) => Response } = {}) {
  const calls: Array<{ path: string; body: any }> = [];
  let n = 0;
  const realFetch = vi.fn(async (input: any, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ path: url.pathname, body: JSON.parse(String(init?.body ?? "null")) });
    if (url.pathname === "/v1/messages/count_tokens") return o.count === null ? json(500, { type: "error", error: { type: "api_error" } }) : json(200, { input_tokens: o.count ?? 2000 });
    n += 1;
    return o.reply ? o.reply(n) : message(2000, 300);
  });
  return { realFetch: realFetch as unknown as typeof fetch, calls, messageCalls: () => calls.filter((c) => c.path === "/v1/messages").length };
}
const req = (extra: Record<string, unknown> = {}) => ({ method: "POST", headers: { "x-api-key": FAKE_KEY, "content-type": "application/json" }, body: JSON.stringify({ model: EVAL_MODEL, max_tokens: 700, system: "s", messages: [{ role: "user", content: "مرحبا" }], ...extra }) });
const send = (g: ReturnType<typeof createSpendingGuard>, extra: Record<string, unknown> = {}, url = "https://api.anthropic.com/v1/messages") => g.fetch(url, req(extra));

describe("live-eval guard: hosts and paths", () => {
  for (const url of ["https://treg.to/api/v1/x", "https://api.firecrawl.dev/v1/scrape", "https://api.context.dev/v1/search", "https://abc.supabase.co/rest/v1/missions", "https://example.com/", "http://api.anthropic.com/v1/messages", "https://api.anthropic.com.evil.example/v1/messages"]) {
    it(`blocks ${url} before any network I/O`, async () => {
      const net = fakeNet();
      const g = createSpendingGuard({ realFetch: net.realFetch });
      await expect(g.fetch(url, req())).rejects.toBeInstanceOf(GuardRefusal);
      expect(net.calls).toHaveLength(0);
      expect(g.state.paidAttempts).toBe(0);
    });
  }
  it("allows only POST /v1/messages and POST /v1/messages/count_tokens on the Anthropic host", async () => {
    const net = fakeNet();
    const g = createSpendingGuard({ realFetch: net.realFetch });
    await expect(g.fetch("https://api.anthropic.com/v1/models", req())).rejects.toThrow(/blocked_path/);
    await expect(g.fetch("https://api.anthropic.com/v1/messages", { ...req(), method: "GET" })).rejects.toThrow(/blocked_path/);
    await expect(g.fetch("https://api.anthropic.com/v1/messages/batches", req())).rejects.toThrow(/blocked_path/);
    expect(net.calls).toHaveLength(0);
    expect((await send(g)).status).toBe(200);
    expect((await send(g, {}, "https://api.anthropic.com/v1/messages/count_tokens")).status).toBe(200);
  });
  it("refuses another model, more than 700 output tokens and streaming", async () => {
    const net = fakeNet();
    const g = createSpendingGuard({ realFetch: net.realFetch });
    await expect(send(g, { model: "claude-opus-5-5" })).rejects.toThrow(/model_not_allowed/);
    await expect(send(g, { max_tokens: 701 })).rejects.toThrow(/max_tokens_not_allowed/);
    await expect(send(g, { stream: true })).rejects.toThrow(/stream_not_allowed/);
    expect(net.messageCalls()).toBe(0);
  });
});

describe("live-eval guard: caps", () => {
  it(`the ${MAX_PAID_ATTEMPTS}-attempt cap: attempt ${MAX_PAID_ATTEMPTS + 1} is refused and never sent`, async () => {
    const net = fakeNet();
    const g = createSpendingGuard({ realFetch: net.realFetch });
    for (let i = 0; i < MAX_PAID_ATTEMPTS; i += 1) expect((await send(g)).status).toBe(200);
    await expect(send(g)).rejects.toThrow(/attempt_cap/);
    expect(net.messageCalls()).toBe(MAX_PAID_ATTEMPTS);
    expect(g.state.paidAttempts).toBe(MAX_PAID_ATTEMPTS);
    expect(g.state.refusals.map((r) => r.code)).toEqual(["attempt_cap"]);
  });
  it("the $1 cap: spent + worst-case reservation above $1.00 is refused before sending (cumulative over attempts)", async () => {
    // a price high enough that one worst case is about $0.37 ((2000 + margin) in × $10/M + 700 out × $500/M): attempts 1 and 2 pass, 3 would end above $1.10
    const net = fakeNet({ count: 2000, reply: () => message(2000, 700) });
    const g = createSpendingGuard({ realFetch: net.realFetch, price: { inputPerM: 10, outputPerM: 500 } });
    await send(g);
    await send(g);
    expect(g.state.spentUsd).toBeCloseTo(0.74, 6);
    await expect(send(g)).rejects.toThrow(/usd_cap/);
    expect(net.messageCalls()).toBe(2);
  });
  it("the reservation uses count_tokens' input plus a margin (the count carries the request's thinking field); when count_tokens is unavailable, UTF-8 bytes / 2", async () => {
    const a = fakeNet({ count: 1234 });
    const g1 = createSpendingGuard({ realFetch: a.realFetch });
    await send(g1, { thinking: { type: "disabled" } });
    expect(a.calls[0].body.thinking).toEqual({ type: "disabled" });
    expect(g1.state.ledger[0]).toMatchObject({ inputTokensCounted: 1234 + COUNT_MARGIN_TOKENS, countSource: "count_tokens" });
    expect(g1.state.ledger[0].reservedUsd).toBeCloseTo(((1234 + COUNT_MARGIN_TOKENS) * 0.1 + 700 * 0.5) / 1e6, 12);
    const b = fakeNet({ count: null });
    const g2 = createSpendingGuard({ realFetch: b.realFetch });
    await send(g2);
    expect(g2.state.ledger[0].countSource).toBe("estimate_bytes_div_2");
    expect(g2.state.ledger[0].inputTokensCounted).toBe(Math.ceil(Buffer.byteLength(req().body, "utf8") / 2));
  });
  it("an input above the 100K price tier is refused", async () => {
    const net = fakeNet({ count: 100_001 - COUNT_MARGIN_TOKENS });
    const g = createSpendingGuard({ realFetch: net.realFetch });
    await expect(send(g)).rejects.toThrow(/input_above_price_tier/);
    expect(net.messageCalls()).toBe(0);
  });
  it("an actual cost above its reservation HALTS the run: every later call is refused", async () => {
    const net = fakeNet({ count: 100, reply: () => message(100, 5000) });
    const g = createSpendingGuard({ realFetch: net.realFetch });
    await send(g);
    expect(g.state.halted).toBe(true);
    expect(g.state.haltReason).toBe("actual_exceeded_reservation");
    await expect(send(g)).rejects.toThrow(/halted/);
    expect(net.messageCalls()).toBe(1);
  });
  for (const [status, shape] of [[529, "overloaded_error"], [401, "authentication_error"], [500, "api_error"]] as const) {
    it(`an unexpected HTTP ${status} halts the run`, async () => {
      const net = fakeNet({ reply: () => json(status, { type: "error", error: { type: shape } }) });
      const g = createSpendingGuard({ realFetch: net.realFetch });
      await send(g);
      expect(g.state.halted).toBe(true);
      expect(g.state.ledger[0].errorType).toBe(shape);
      await expect(send(g)).rejects.toThrow(/halted/);
    });
  }
  it("a 200 without usage halts the run and books the whole reservation", async () => {
    const net = fakeNet({ reply: () => json(200, { type: "message", content: [] }) });
    const g = createSpendingGuard({ realFetch: net.realFetch });
    await send(g);
    expect(g.state.halted).toBe(true);
    expect(g.state.spentUsd).toBeCloseTo(g.state.ledger[0].reservedUsd, 12);
  });
});

describe("live-eval guard: the transport's 400-retry is a second, counted and budgeted attempt", () => {
  const input = { system: "s", messages: [{ role: "user" as const, content: "مرحبا" }], maxTokens: 700, timeoutMs: 5000 };
  it("400 then 200: two paid attempts, two reservations, a count before each", async () => {
    const net = fakeNet({ reply: (n) => (n === 1 ? json(400, { type: "error", error: { type: "invalid_request_error" } }) : message(2000, 300)) });
    const g = createSpendingGuard({ realFetch: net.realFetch });
    const r = await callClaudeChatWith(input, { model: EVAL_MODEL, resolveKey: async () => FAKE_KEY, fetchImpl: g.fetch });
    expect(r.ok).toBe(true);
    expect(g.state.paidAttempts).toBe(2);
    expect(g.state.ledger.map((e) => e.httpStatus)).toEqual([400, 200]);
    expect(net.calls.map((c) => c.path)).toEqual(["/v1/messages/count_tokens", "/v1/messages", "/v1/messages/count_tokens", "/v1/messages"]);
    // the first attempt carried thinking off, the retry did not
    expect(net.calls[1].body.thinking).toEqual({ type: "disabled" });
    expect(net.calls[3].body.thinking).toBeUndefined();
    // a 400 is not billed by the API, but the guard charges its input conservatively (2000 counted + the margin, at the input price)
    expect(g.state.ledger[0].actualUsd).toBeCloseTo(((2000 + COUNT_MARGIN_TOKENS) * 0.1) / 1_000_000, 12);
    expect(g.state.halted).toBe(false);
  });
  it("at 29 attempts, a 400 uses the 30th and its retry is refused (the transport answers a failure, nothing is sent)", async () => {
    const net = fakeNet({ reply: (n) => (n === MAX_PAID_ATTEMPTS ? json(400, { type: "error", error: { type: "invalid_request_error" } }) : message(10, 10)) });
    const g = createSpendingGuard({ realFetch: net.realFetch });
    for (let i = 0; i < MAX_PAID_ATTEMPTS - 1; i += 1) await send(g);
    const r = await callClaudeChatWith(input, { model: EVAL_MODEL, resolveKey: async () => FAKE_KEY, fetchImpl: g.fetch });
    expect(r).toEqual({ ok: false, failure: "network" });
    expect(g.state.paidAttempts).toBe(MAX_PAID_ATTEMPTS);
    expect(net.messageCalls()).toBe(MAX_PAID_ATTEMPTS);
  });
  it("the key is never in the ledger, a refusal or an error message", async () => {
    const net = fakeNet();
    const g = createSpendingGuard({ realFetch: net.realFetch });
    await send(g);
    const errors: string[] = [];
    for (const url of ["https://treg.to/x", "https://api.anthropic.com/v1/models"]) await g.fetch(url, req()).catch((e: Error) => errors.push(e.message));
    expect(JSON.stringify({ ledger: g.state.ledger, refusals: g.state.refusals, errors })).not.toContain(FAKE_KEY);
  });
});

describe("live-eval preflight: the harness refuses to start in an unisolated environment", () => {
  const ok = { LIVE_EVAL_CONFIRM: CONFIRM_VALUE, DIGER_EVAL_ANTHROPIC_KEY: "x", LIVE_EVAL_BUDGET_DIR: "/tmp/outside-the-repo" };
  it("a clean, confirmed environment with the evaluation key passes", () => {
    expect(preflight(ok)).toEqual([]);
  });
  for (const name of ["SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL", "TREG_TOKEN", "TREG_API_KEY", "ANTHROPIC_API_KEY", "FIRECRAWL_API_KEY", "CONTEXT_DEV_API_KEY", "CONTEXTDEV_KEY"]) {
    it(`refuses when ${name} is set (and names it, never its value)`, () => {
      const problems = preflight({ ...ok, [name]: "secret-value" });
      expect(problems).toEqual([`forbidden_env_set:${name}`]);
      expect(problems.join(" ")).not.toContain("secret-value");
    });
  }
  it("refuses without the exact confirmation", () => {
    expect(preflight({ DIGER_EVAL_ANTHROPIC_KEY: "x" })).toContain("confirmation_missing:LIVE_EVAL_CONFIRM");
    expect(preflight({ ...ok, LIVE_EVAL_CONFIRM: "30calls-2usd" })).toContain("confirmation_missing:LIVE_EVAL_CONFIRM");
  });
  it("refuses without the evaluation key", () => {
    expect(preflight({ LIVE_EVAL_CONFIRM: CONFIRM_VALUE, LIVE_EVAL_BUDGET_DIR: "/tmp/x" })).toEqual(["key_missing:DIGER_EVAL_ANTHROPIC_KEY"]);
    expect(preflight({ LIVE_EVAL_CONFIRM: CONFIRM_VALUE, LIVE_EVAL_BUDGET_DIR: "/tmp/x", DIGER_EVAL_ANTHROPIC_KEY: "  " })).toEqual(["key_missing:DIGER_EVAL_ANTHROPIC_KEY"]);
  });
  it("refuses without the persistent budget folder (the cumulative ceiling cannot be enforced without it)", () => {
    expect(preflight({ LIVE_EVAL_CONFIRM: CONFIRM_VALUE, DIGER_EVAL_ANTHROPIC_KEY: "x" })).toEqual(["budget_dir_missing:LIVE_EVAL_BUDGET_DIR"]);
  });
  it("refuses when the product's transport is switched off (the run would measure nothing)", () => {
    expect(preflight({ ...ok, LLM_PROVIDER: "fake" })).toEqual(["transport_disabled:LLM_PROVIDER"]);
    expect(preflight({ ...ok, LLM_ENABLED: "false" })).toEqual(["transport_disabled:LLM_ENABLED"]);
  });
});
