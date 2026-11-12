import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSpendingGuard, EVAL_MODEL, GuardRefusal, AUTHORIZED_TOTAL_USD, PLANNER_MAX_OUTPUT_TOKENS } from "../evals/live-intelligence/budget";
import { openCumulativeBudget, LOCK_FILE, STATE_FILE } from "../evals/live-intelligence/cumulative";

/**
 * THE CUMULATIVE BUDGET OF THE LLM QUALITY MISSION, OFFLINE (evals/live-intelligence/cumulative.ts): a temporary folder and a fake network only. Proves the owner's total ceiling holds across runs, restarts, retries, failures and
 * concurrent runs, and that a missing, corrupt or unwritable state fails closed before any paid call.
 */
const dirs: string[] = [];
const fresh = () => { const d = mkdtempSync(path.join(tmpdir(), "diger-budget-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const code = (f: () => unknown): string => { try { f(); return "no-refusal"; } catch (e) { return e instanceof GuardRefusal ? e.code : `other:${String(e)}`; } };

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function fakeNet(reply: (n: number) => Response | Promise<Response> = () => json(200, { type: "message", content: [{ type: "text", text: "{}" }], stop_reason: "end_turn", usage: { input_tokens: 1000, output_tokens: 100 } })) {
  const calls: Array<{ path: string; body: any }> = [];
  let n = 0;
  const realFetch = vi.fn(async (input: any, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ path: url.pathname, body: JSON.parse(String(init?.body ?? "null")) });
    if (url.pathname === "/v1/messages/count_tokens") return json(200, { input_tokens: 1000 });
    n += 1;
    return reply(n);
  });
  return { realFetch: realFetch as unknown as typeof fetch, calls, sent: () => calls.filter((c) => c.path === "/v1/messages").length };
}
const send = (g: ReturnType<typeof createSpendingGuard>, extra: Record<string, unknown> = {}) =>
  g.fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "x-api-key": "sk-fake", "content-type": "application/json" }, body: JSON.stringify({ model: EVAL_MODEL, max_tokens: 700, system: "s", messages: [{ role: "user", content: "x" }], ...extra }) });

describe("cumulative budget: created once, never reset or raised", () => {
  it("creates the state once; a second init is refused (no reset)", () => {
    const dir = fresh();
    openCumulativeBudget({ dir, init: { ceilingUsd: 9.5, maxAttempts: 500 } }).close();
    expect(code(() => openCumulativeBudget({ dir, init: { ceilingUsd: 9.5, maxAttempts: 500 } }))).toBe("budget_state_exists_no_reset");
  });
  it(`refuses a ceiling above the owner's $${AUTHORIZED_TOTAL_USD} authorization`, () => {
    expect(code(() => openCumulativeBudget({ dir: fresh(), init: { ceilingUsd: AUTHORIZED_TOTAL_USD + 0.01, maxAttempts: 10 } }))).toBe("budget_ceiling_above_authorization");
  });
  it("a state edited to a higher ceiling fails closed (checksum), even with a recomputed-looking file", () => {
    const dir = fresh();
    openCumulativeBudget({ dir, init: { ceilingUsd: 1, maxAttempts: 10 } }).close();
    const file = path.join(dir, STATE_FILE);
    const doc = JSON.parse(readFileSync(file, "utf8"));
    doc.state.ceilingUsd = 9;
    writeFileSync(file, JSON.stringify(doc));
    expect(code(() => openCumulativeBudget({ dir }))).toBe("budget_state_corrupt");
  });
  it("a run never creates the state implicitly: missing state fails closed", () => {
    expect(code(() => openCumulativeBudget({ dir: fresh() }))).toBe("budget_state_missing");
  });
});

describe("cumulative budget: restarts, ceilings and in-flight reservations", () => {
  it("a restart does not reset spending: what one process spent is there for the next", () => {
    const dir = fresh();
    const a = openCumulativeBudget({ dir, init: { ceilingUsd: 1, maxAttempts: 100 } });
    a.settle(a.reserve(0.4, "c1"), 0.3);
    a.close();
    const b = openCumulativeBudget({ dir });
    expect(b.snapshot()).toMatchObject({ spentUsd: 0.3, attempts: 1, inflightUsd: 0, runs: 2 });
    expect(code(() => b.reserve(0.71, "c2"))).toBe("cumulative_usd_cap");
    b.settle(b.reserve(0.7, "c2"), 0.7);
    expect(code(() => b.reserve(0.000001, "c3"))).toBe("cumulative_usd_cap");
    b.close();
  });
  it("reservations in flight count against the ceiling until settled", () => {
    const dir = fresh();
    const a = openCumulativeBudget({ dir, init: { ceilingUsd: 1, maxAttempts: 100 } });
    a.reserve(0.6, "c1");
    expect(code(() => a.reserve(0.5, "c2"))).toBe("cumulative_usd_cap");
    expect(a.snapshot().inflightUsd).toBe(0.6);
    a.close();
  });
  it("the cumulative attempt cap stops further attempts", () => {
    const a = openCumulativeBudget({ dir: fresh(), init: { ceilingUsd: 1, maxAttempts: 2 } });
    a.reserve(0.01, "1");
    a.reserve(0.01, "2");
    expect(code(() => a.reserve(0.01, "3"))).toBe("cumulative_attempt_cap");
    a.close();
  });
  it("a process killed mid-request: its lock is taken over and its in-flight reservation is charged IN FULL", () => {
    const dir = fresh();
    const dead = openCumulativeBudget({ dir, init: { ceilingUsd: 1, maxAttempts: 100 }, pid: 999_001 });
    dead.reserve(0.25, "killed");
    // the process dies without closing: the lock and the reservation stay
    expect(existsSync(path.join(dir, LOCK_FILE))).toBe(true);
    const next = openCumulativeBudget({ dir, pid: 999_002, isAlive: () => false });
    expect(next.snapshot()).toMatchObject({ spentUsd: 0.25, inflightUsd: 0, recoveredUsd: 0.25 });
    next.close();
  });
});

describe("cumulative budget: concurrent runs cannot bypass the ceiling", () => {
  it("a second run is refused while the first holds the lock", () => {
    const dir = fresh();
    const a = openCumulativeBudget({ dir, init: { ceilingUsd: 1, maxAttempts: 100 }, pid: 999_101 });
    expect(code(() => openCumulativeBudget({ dir, pid: 999_102, isAlive: (p) => p === 999_101 }))).toBe("budget_locked_by_running_process");
    a.close();
    openCumulativeBudget({ dir, pid: 999_102, isAlive: () => true }).close();
  });
});

describe("cumulative budget: corrupt, missing or unwritable state fails closed after the start", () => {
  it("the state deleted mid-run: the next reservation is refused", () => {
    const dir = fresh();
    const a = openCumulativeBudget({ dir, init: { ceilingUsd: 1, maxAttempts: 100 } });
    unlinkSync(path.join(dir, STATE_FILE));
    expect(code(() => a.reserve(0.01, "x"))).toBe("budget_state_missing");
    a.close();
  });
  it("the state corrupted mid-run: refused", () => {
    const dir = fresh();
    const a = openCumulativeBudget({ dir, init: { ceilingUsd: 1, maxAttempts: 100 } });
    writeFileSync(path.join(dir, STATE_FILE), "{not json");
    expect(code(() => a.reserve(0.01, "x"))).toBe("budget_state_corrupt");
    a.close();
  });
  it("a state that cannot be written: refused (nothing is sent)", () => {
    const dir = fresh();
    const a = openCumulativeBudget({ dir, init: { ceilingUsd: 1, maxAttempts: 100 } });
    // the state's path becomes a folder: the atomic rename fails
    const file = path.join(dir, STATE_FILE);
    const keep = readFileSync(file, "utf8");
    unlinkSync(file);
    mkdirSync(file);
    writeFileSync(path.join(dir, "keep.json"), keep);
    expect(["budget_state_missing", "budget_state_unwritable"]).toContain(code(() => a.reserve(0.01, "x")));
    a.close();
  });
});

describe("the spending guard with the cumulative budget", () => {
  it("every attempt is reserved on disk BEFORE it is sent, and settled with its actual cost after", async () => {
    const dir = fresh();
    const budget = openCumulativeBudget({ dir, init: { ceilingUsd: 1, maxAttempts: 100 } });
    let onDiskWhenSent = -1;
    const net = fakeNet(() => { onDiskWhenSent = Object.keys(JSON.parse(readFileSync(path.join(dir, STATE_FILE), "utf8")).state.inflight).length; return json(200, { type: "message", content: [], stop_reason: "end_turn", usage: { input_tokens: 1000, output_tokens: 100 } }); });
    const g = createSpendingGuard({ realFetch: net.realFetch, cumulative: budget });
    await send(g);
    expect(onDiskWhenSent).toBe(1);
    expect(budget.snapshot()).toMatchObject({ attempts: 1, inflightUsd: 0 });
    expect(budget.snapshot().spentUsd).toBeCloseTo((1000 * 0.1 + 100 * 0.5) / 1e6, 12);
    budget.close();
  });
  it("two runs one after the other share ONE ceiling: the second is refused though its own per-run cap allows it", async () => {
    const dir = fresh();
    // each attempt reserves (1000 + 32) × 0.1/M + 700 × 0.5/M ≈ $0.000453 and costs 1000 × 0.1/M + 100 × 0.5/M = $0.00015: with $0.0008 the first run's one attempt and the second run's two fit, a fourth reservation does not
    const b1 = openCumulativeBudget({ dir, init: { ceilingUsd: 0.0008, maxAttempts: 100 } });
    const g1 = createSpendingGuard({ realFetch: fakeNet().realFetch, cumulative: b1, maxUsd: 1 });
    await send(g1);
    b1.close();
    const b2 = openCumulativeBudget({ dir });
    const net2 = fakeNet();
    const g2 = createSpendingGuard({ realFetch: net2.realFetch, cumulative: b2, maxUsd: 1 });
    await send(g2);
    await send(g2);
    await expect(send(g2)).rejects.toThrow(/cumulative_usd_cap/);
    expect(net2.sent()).toBe(2);
    expect(b2.snapshot().spentUsd).toBeCloseTo(0.00045, 12);
    b2.close();
  });
  it("a network failure is charged its WHOLE reservation on disk, and the run halts", async () => {
    const dir = fresh();
    const budget = openCumulativeBudget({ dir, init: { ceilingUsd: 1, maxAttempts: 100 } });
    const g = createSpendingGuard({ realFetch: fakeNet(() => { throw new TypeError("socket hang up"); }).realFetch, cumulative: budget });
    await expect(send(g)).rejects.toThrow(/socket hang up/);
    const reserved = ((1000 + 32) * 0.1 + 700 * 0.5) / 1e6;
    expect(budget.snapshot().spentUsd).toBeCloseTo(reserved, 12);
    expect(budget.snapshot().inflightUsd).toBe(0);
    expect(g.state.halted).toBe(true);
    budget.close();
  });
  it("a 529 is charged its input, and the run halts", async () => {
    const budget = openCumulativeBudget({ dir: fresh(), init: { ceilingUsd: 1, maxAttempts: 100 } });
    const g = createSpendingGuard({ realFetch: fakeNet(() => json(529, { type: "error", error: { type: "overloaded_error" } })).realFetch, cumulative: budget });
    await send(g);
    expect(budget.snapshot().spentUsd).toBeCloseTo(((1000 + 32) * 0.1) / 1e6, 12);
    expect(g.state.halted).toBe(true);
    budget.close();
  });
  it("a cumulative refusal is recorded and nothing is sent", async () => {
    const budget = openCumulativeBudget({ dir: fresh(), init: { ceilingUsd: 0.0001, maxAttempts: 100 } });
    const net = fakeNet();
    const g = createSpendingGuard({ realFetch: net.realFetch, cumulative: budget });
    await expect(send(g)).rejects.toThrow(/cumulative_usd_cap/);
    expect(net.sent()).toBe(0);
    expect(g.state.refusals.map((r) => r.code)).toEqual(["cumulative_usd_cap"]);
    budget.close();
  });
});

describe("the spending guard: the planner's output ceiling and tool-aware counting", () => {
  it("max_tokens above 700 is refused by default, allowed up to the planner ceiling when configured, never above it", async () => {
    const net = fakeNet();
    const chat = createSpendingGuard({ realFetch: net.realFetch });
    await expect(send(chat, { max_tokens: 701 })).rejects.toThrow(/max_tokens_not_allowed/);
    const planner = createSpendingGuard({ realFetch: net.realFetch, maxOutputTokens: PLANNER_MAX_OUTPUT_TOKENS });
    expect((await send(planner, { max_tokens: PLANNER_MAX_OUTPUT_TOKENS })).status).toBe(200);
    await expect(send(planner, { max_tokens: PLANNER_MAX_OUTPUT_TOKENS + 1 })).rejects.toThrow(/max_tokens_not_allowed/);
    const above = createSpendingGuard({ realFetch: net.realFetch, maxOutputTokens: 100_000 });
    await expect(send(above, { max_tokens: PLANNER_MAX_OUTPUT_TOKENS + 1 })).rejects.toThrow(/max_tokens_not_allowed/);
  });
  it("the count request carries the tools (they are part of the billed input)", async () => {
    const net = fakeNet();
    const g = createSpendingGuard({ realFetch: net.realFetch, maxOutputTokens: PLANNER_MAX_OUTPUT_TOKENS });
    const tools = [{ name: "propose_plan", description: "d", input_schema: { type: "object", properties: {} } }];
    await send(g, { tools, max_tokens: 2000 });
    expect(net.calls[0].path).toBe("/v1/messages/count_tokens");
    expect(net.calls[0].body.tools).toEqual(tools);
  });
  it("a cache write is charged at twice the input price (an upper bound): a reservation it exceeds halts the run", async () => {
    const net = fakeNet(() => json(200, { type: "message", content: [], stop_reason: "end_turn", usage: { input_tokens: 10, cache_creation_input_tokens: 1000, output_tokens: 700 } }));
    const g = createSpendingGuard({ realFetch: net.realFetch });
    await send(g);
    expect(g.state.ledger[0].actualUsd).toBeCloseTo(((10 + 2000) * 0.1 + 700 * 0.5) / 1e6, 12);
    expect(g.state.halted).toBe(true);
  });
});
