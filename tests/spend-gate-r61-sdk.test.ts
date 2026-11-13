import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { startModelGate } from "../agent/src/modelGate";
import { createMemorySpendGate } from "../src/lib/server/spendGate/gate";
import { MODEL_HAIKU } from "../src/lib/agentMission/constants";

/**
 * ROUND 61: the REAL Agent SDK (agent/node_modules, the version the worker runs) driven through the model gate, against a FAKE Anthropic server on
 * 127.0.0.1. No paid call: the SDK child only ever holds the gate's token, and the upstream is local. Opt-in (it starts the SDK's native process):
 * DIGER_TEST_REAL_SDK=1 npx vitest run tests/spend-gate-r61-sdk.test.ts
 */
const SDK = path.resolve(__dirname, "../agent/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs");

async function fakeUpstream() {
  const seen: Array<{ url: string; key: string; max_tokens: number }> = [];
  const server = http.createServer((req, res) => {
    let raw = ""; req.on("data", (c) => (raw += c)); req.on("end", () => {
      const j = JSON.parse(raw || "{}");
      seen.push({ url: req.url ?? "", key: String(req.headers["x-api-key"] ?? ""), max_tokens: j.max_tokens });
      res.writeHead(200, { "content-type": "text/event-stream" });
      const ev = (t: string, d: object) => res.write(`event: ${t}\ndata: ${JSON.stringify({ type: t, ...d })}\n\n`);
      ev("message_start", { message: { id: "msg_f", type: "message", role: "assistant", model: j.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 400, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
      ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
      ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "done" } });
      ev("content_block_stop", { index: 0 });
      ev("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } });
      ev("message_stop", {});
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, close: () => server.close() };
}

async function runSdk(env: Record<string, string>, home: string) {
  const { query } = await import(SDK);
  const out: Array<{ type: string; subtype?: string; is_error?: boolean; text?: string }> = [];
  const q = query({ prompt: "say done", options: { model: MODEL_HAIKU, systemPrompt: "x", tools: [], allowedTools: [], settingSources: [], persistSession: false, maxTurns: 2, maxBudgetUsd: 0.05, cwd: home, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, ...env } } });
  try { for await (const m of q) out.push({ type: m.type, subtype: m.subtype, is_error: m.is_error, text: m.type === "result" ? String(m.result ?? "").slice(0, 200) : undefined }); } catch (e) { out.push({ type: "thrown", text: String((e as Error).message).slice(0, 200) }); }
  return out;
}

describe.skipIf(process.env.DIGER_TEST_REAL_SDK !== "1")("R61 model gate with the REAL Agent SDK (fake upstream, no paid call)", () => {
  it("with a grant: the SDK's request goes through the gate with max_tokens lowered and the real key only upstream; the grant is charged by the stream's usage", async () => {
    const up = await fakeUpstream();
    const home = mkdtempSync(path.join(tmpdir(), "r61-sdk-"));
    const w = createMemorySpendGate();
    w.owner.issueGrant({ id: "g1", ceilingUsd: 0.05, perOpMaxUsd: 0.05, perMissionMaxUsd: 0.05, kinds: ["model"], opensAt: Date.now() - 1000, closesAt: Date.now() + 600_000, issuedBy: "owner", reason: "test" });
    const g = await startModelGate({ upstreamBaseUrl: up.url, apiKey: "real-key-stays-in-worker", gate: w.gate, mode: "enforce", missionId: "msn_sdk", maxOutputTokens: 4000 });
    try {
      const out = await runSdk(g.childEnv, home);
      expect(out.find((m) => m.type === "result")).toMatchObject({ subtype: "success" });
      const msgs = up.seen.filter((s) => s.url.startsWith("/v1/messages"));
      expect(msgs.length).toBeGreaterThanOrEqual(1);
      expect(msgs.every((s) => s.key === "real-key-stays-in-worker" && s.max_tokens <= 4000)).toBe(true);
      expect(g.stats()).toMatchObject({ refused: 0, unknownCharge: 0 });
      expect(w.owner.grant("g1")!.reservedUsd).toBe(0);
      expect(w.owner.grant("g1")!.spentUsd).toBeGreaterThan(0);
    } finally { await g.close(); up.close(); rmSync(home, { recursive: true, force: true }); }
  }, 120_000);

  it("WITHOUT a grant: the SDK's request is refused at the gate, nothing reaches the upstream, and the run ends in error (no retry storm)", async () => {
    const up = await fakeUpstream();
    const home = mkdtempSync(path.join(tmpdir(), "r61-sdk-"));
    const g = await startModelGate({ upstreamBaseUrl: up.url, apiKey: "real-key-stays-in-worker", gate: createMemorySpendGate().gate, mode: "enforce", missionId: "msn_sdk" });
    try {
      const out = await runSdk(g.childEnv, home);
      expect(up.seen.filter((s) => s.url.startsWith("/v1/messages"))).toHaveLength(0);
      const result = out.find((m) => m.type === "result" || m.type === "thrown");
      expect(result?.subtype === "success" && !result.is_error).toBe(false);
      console.info("R61 real SDK without grant:", JSON.stringify(g.stats()), JSON.stringify(result));
      expect(g.stats().forwarded).toBe(0);
      expect(g.stats().refused).toBeGreaterThanOrEqual(1);
      expect(g.stats().refused).toBeLessThanOrEqual(3);
    } finally { await g.close(); up.close(); rmSync(home, { recursive: true, force: true }); }
  }, 120_000);
});

/**
 * ROUND 62: the worker's REAL driver (agent/src/sdkRuntime.ts createSdkDriver) with the gate the worker builds (agent/src/spendGateWiring.ts), against the same
 * fake upstream on 127.0.0.1. No paid call. Opt-in like the tests above: DIGER_TEST_REAL_SDK=1 npx vitest run tests/spend-gate-r61-sdk.test.ts
 */
describe.skipIf(process.env.DIGER_TEST_REAL_SDK !== "1")("R62 the worker's driver through the wired model gate (fake upstream, no paid call)", () => {
  const runInput = (modelGate: any) => ({ phase: "planning" as const, missionId: "msn_r62sdk", systemPrompt: "x", userPrompt: "say done", tools: [], state: { terminal: false } as any, model: MODEL_HAIKU, maxTurns: 2, maxBudgetUsd: 0.05, wallMs: 90_000, ...(modelGate ? { modelGate } : {}) });

  it("ENFORCE with a grant: every request of the driver's child goes through the gate (capped, reserved, settled); the real key never leaves the worker", async () => {
    const { createSdkDriver } = await import("../agent/src/sdkRuntime");
    const { createWorkerSpendGate } = await import("../agent/src/spendGateWiring");
    const up = await fakeUpstream();
    const w = createMemorySpendGate();
    w.owner.issueGrant({ id: "g1", ceilingUsd: 0.05, perOpMaxUsd: 0.05, perMissionMaxUsd: 0.05, kinds: ["model"], opensAt: Date.now() - 1000, closesAt: Date.now() + 600_000, issuedBy: "owner", reason: "test" });
    const sg = createWorkerSpendGate({ mode: "enforce", gate: w.gate, apiKey: "real-key-stays-in-worker", upstreamBaseUrl: up.url, maxOutputTokens: 4000 });
    // the driver is created with an environment holding the real key, as main.ts does: the gate must keep it from the child
    const driver = createSdkDriver({ PATH: process.env.PATH, HOME: process.env.HOME, ANTHROPIC_API_KEY: "real-key-stays-in-worker" });
    try {
      const out = await driver.run(runInput(sg.modelGateFor("msn_r62sdk")));
      expect(out.error).toBeUndefined();
      const msgs = up.seen.filter((s) => s.url.startsWith("/v1/messages"));
      expect(msgs.length).toBeGreaterThanOrEqual(1);
      expect(msgs.every((s) => s.key === "real-key-stays-in-worker" && s.max_tokens <= 4000)).toBe(true);
      const s = sg.finish("msn_r62sdk");
      console.info("R62 real driver, enforce:", JSON.stringify(s));
      expect(s).toMatchObject({ protection: "ENFORCED", refused: 0, model: { runs: 1, refused: 0, unreserved: 0 } });
      expect(s.model.forwarded).toBe(msgs.length);
      expect(s.reservations).toBe(msgs.length);
      expect(w.owner.grant("g1")!.reservedUsd).toBe(0);
    } finally { up.close(); }
  }, 120_000);

  it("ENFORCE with no grant: the driver's child reaches nothing; and a model gate that cannot start does not start the model at all", async () => {
    const { createSdkDriver } = await import("../agent/src/sdkRuntime");
    const { createWorkerSpendGate } = await import("../agent/src/spendGateWiring");
    const up = await fakeUpstream();
    const sg = createWorkerSpendGate({ mode: "enforce", gate: createMemorySpendGate().gate, apiKey: "real-key-stays-in-worker", upstreamBaseUrl: up.url });
    const driver = createSdkDriver({ PATH: process.env.PATH, HOME: process.env.HOME, ANTHROPIC_API_KEY: "real-key-stays-in-worker" });
    try {
      const out = await driver.run(runInput(sg.modelGateFor("msn_r62sdk")));
      expect(up.seen.filter((s) => s.url.startsWith("/v1/messages"))).toHaveLength(0);
      expect(sg.finish("msn_r62sdk").refused).toBeGreaterThanOrEqual(1);
      // the SDK may write its own error message as a turn; nothing was billed
      expect(out.llmCostUsd).toBe(0);
      const failed = await driver.run(runInput({ mode: "enforce", start: async () => { throw new Error("cannot listen"); } }));
      expect(failed).toMatchObject({ stop: "spend_gate", turns: 0, llmCostUsd: 0 });
      expect(up.seen).toHaveLength(0);
    } finally { up.close(); }
  }, 120_000);
});
