import { randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { modelRequestBound, modelUsageCost, type ModelUsage } from "../../src/lib/server/spendGate/modelBound";
import type { SpendGate, SpendGateMode, SpendKind } from "../../src/lib/server/spendGate/gate";
import { RESERVE_TIMEOUT_MS } from "../../src/lib/server/spendGate/gate";

/**
 * ROUND 61: THE MODEL GATE (docs/proposals/spend-gate/SPEC-v2.md §6). NOT WIRED: nothing in the worker starts it yet (DIGER_SPEND_GATE is off and the wiring
 * is in the separate, unmerged PR).
 *
 * The Agent SDK has no hook before each model request, and `maxBudgetUsd` is checked AFTER a turn: it cannot stop the request that passes the budget.
 * This gate sits where the SDK's requests must go: a loopback HTTP server the SDK child is pointed at with ANTHROPIC_BASE_URL (measured on SDK 0.3.312:
 * every request goes there). The child gets a random per-run token instead of the real Anthropic key, so it cannot reach the API except through the gate.
 * For EACH /v1/messages request, before anything is sent: the bound of the request (modelBound.ts) is computed, max_tokens is lowered to the gate's cap,
 * the bound is reserved; refused -> HTTP 400 (the SDK does not retry a 400) and nothing goes out. After: the usage the API reports settles it; a stream
 * that ends without its final event, a cut connection or any error leaves the whole bound spent. An SDK retry is a new request, so a new reservation.
 *
 * What it does NOT guarantee: the input bound rests on «tokens <= bytes + allowance» (checked on every answer; a violation stops the grant), and only
 * traffic of a child started with this gate's base URL and token is gated. The website's direct model calls are not covered by this file.
 */

export interface ModelGateOptions {
  upstreamBaseUrl: string;
  /** The real key: stays in the worker process, never given to the child. */
  apiKey: string;
  gate: SpendGate | null;
  mode: Exclude<SpendGateMode, "off">;
  missionId: string | null;
  kind?: SpendKind;
  maxOutputTokens?: number;
  ttlSeconds?: number;
  maxBodyBytes?: number;
  fetchFn?: typeof fetch;
  onEvent?: (e: { type: string; detail?: string }) => void;
}

export interface ModelGateHandle {
  baseUrl: string;
  /** What the child gets as ANTHROPIC_API_KEY: valid only at this gate. */
  childToken: string;
  /** The child's environment additions: the base URL, the token, and the output cap the SDK itself also honours. */
  childEnv: Record<string, string>;
  stats(): { requests: number; forwarded: number; refused: number; unknownCharge: number; boundViolations: number; settledUsd: number };
  close(): Promise<void>;
}

const NOT_BILLED_STATUSES = new Set([400, 401, 403, 404, 413, 429]);

function errorJson(message: string) {
  return JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } });
}

export async function startModelGate(opts: ModelGateOptions): Promise<ModelGateHandle> {
  const childToken = `gate-${randomBytes(24).toString("hex")}`;
  const fetchFn = opts.fetchFn ?? fetch;
  const kind: SpendKind = opts.kind ?? "model";
  const ttl = Math.min(900, Math.max(30, Math.floor(opts.ttlSeconds ?? 600)));
  const maxBody = opts.maxBodyBytes ?? 8 * 1024 * 1024;
  const runId = randomBytes(8).toString("hex");
  const s = { requests: 0, forwarded: 0, refused: 0, unknownCharge: 0, boundViolations: 0, settledUsd: 0 };
  let seq = 0;
  const note = (type: string, detail?: string) => { try { opts.onEvent?.({ type, detail }); } catch { /* never decides */ } };

  const server = http.createServer((req, res) => {
    void handle(req, res).catch((e) => {
      note("model_gate.error", String((e as Error)?.message ?? e).slice(0, 160));
      if (!res.headersSent) { res.writeHead(502, { "content-type": "application/json" }); res.end(errorJson("spend_gate_error")); } else res.destroy();
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? "/", "http://gate.local");
    if ((req.method === "HEAD" || req.method === "GET") && url.pathname === "/api/hello") { res.writeHead(200); res.end(); return; }
    const presented = String(req.headers["x-api-key"] ?? "").trim() || String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
    if (presented !== childToken) { res.writeHead(401, { "content-type": "application/json" }); res.end(errorJson("spend_gate: unknown caller")); return; }
    if (req.method !== "POST" || url.pathname !== "/v1/messages") { res.writeHead(403, { "content-type": "application/json" }); res.end(errorJson(`spend_gate: ${url.pathname} is not gated`)); return; }
    s.requests += 1;
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) { size += (c as Buffer).length; if (size > maxBody) { res.writeHead(413, { "content-type": "application/json" }); res.end(errorJson("spend_gate: request too large")); return; } chunks.push(c as Buffer); }
    const rawBody = Buffer.concat(chunks);
    let parsed: unknown = null;
    try { parsed = JSON.parse(rawBody.toString("utf8")); } catch { /* refused below */ }
    const bound = modelRequestBound(parsed, rawBody.length, { maxOutputTokens: opts.maxOutputTokens });
    const refuse = (why: string) => { s.refused += 1; note("model_gate.refused", why); res.writeHead(400, { "content-type": "application/json" }); res.end(errorJson(`spend_gate_refused: ${why}`)); };
    if (!bound.ok && opts.mode === "enforce") return refuse(bound.detail);

    let reservationId: string | null = null;
    if (bound.ok) {
      seq += 1;
      const timeout = new Promise<{ ok: false; reason: "gate_unavailable" }>((r) => { setTimeout(() => r({ ok: false, reason: "gate_unavailable" }), RESERVE_TIMEOUT_MS).unref(); });
      const r = opts.gate
        ? await Promise.race([opts.gate.reserve({ key: `model:${runId}:${seq}`, kind, op: `model:${bound.model}`, boundUsd: bound.usd, missionId: opts.missionId, ttlSeconds: ttl }), timeout]).catch(() => ({ ok: false as const, reason: "gate_unavailable" as const }))
        : ({ ok: false, reason: "gate_unavailable" } as const);
      if (r.ok) reservationId = r.reservationId;
      else if (opts.mode === "enforce") return refuse(r.reason);
      else note("model_gate.observed_refusal", r.reason);
    } else note("model_gate.observed_refusal", bound.detail);

    // observe forwards the request exactly as the SDK sent it; enforce sends the body with max_tokens lowered to the cap
    const outBody = opts.mode === "enforce" && bound.ok ? Buffer.from(JSON.stringify(bound.body)) : rawBody;
    const headers: Record<string, string> = { "content-type": "application/json", "x-api-key": opts.apiKey };
    for (const h of ["anthropic-version", "anthropic-beta", "accept"]) { const v = req.headers[h]; if (typeof v === "string") headers[h] = v; }
    const upstreamAbort = new AbortController();
    const killer = setTimeout(() => upstreamAbort.abort(), ttl * 1000 - 5000);
    killer.unref();
    res.on("close", () => { if (!res.writableEnded) upstreamAbort.abort(); });

    let usage: ModelUsage | null = null;
    let complete = false;
    let billedKnownZero = false;
    try {
      let up: Response;
      try {
        up = await fetchFn(`${opts.upstreamBaseUrl.replace(/\/+$/, "")}/v1/messages${url.search}`, { method: "POST", headers, body: outBody, signal: upstreamAbort.signal });
      } catch (e) {
        res.writeHead(502, { "content-type": "application/json" }); res.end(errorJson("spend_gate: upstream unreachable"));
        throw e;
      }
      s.forwarded += 1;
      const ctype = up.headers.get("content-type") ?? "application/json";
      const pass: Record<string, string> = { "content-type": ctype };
      for (const h of ["request-id", "retry-after", "anthropic-ratelimit-requests-remaining"]) { const v = up.headers.get(h); if (v) pass[h] = v; }
      res.writeHead(up.status, pass);
      if (!up.ok) {
        const text = await up.text();
        res.end(text);
        billedKnownZero = NOT_BILLED_STATUSES.has(up.status);
        return;
      }
      if (ctype.includes("text/event-stream") && up.body) {
        const reader = up.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        let acc: ModelUsage = {};
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          res.write(Buffer.from(value));
          buf += decoder.decode(value, { stream: true });
          let i: number;
          while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (!line.startsWith("data:")) continue;
            let ev: any = null;
            try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
            if (ev?.type === "message_start" && ev.message?.usage) acc = { ...acc, ...ev.message.usage };
            else if (ev?.type === "message_delta" && ev.usage) acc = { ...acc, ...ev.usage };
            else if (ev?.type === "message_stop") complete = true;
          }
        }
        res.end();
        if (complete) usage = acc;
      } else {
        const text = await up.text();
        res.end(text);
        try { const j = JSON.parse(text); if (j?.usage) { usage = j.usage; complete = true; } } catch { /* unknown charge */ }
      }
    } finally {
      clearTimeout(killer);
      if (reservationId && opts.gate) {
        let actual: number | null = null;
        if (billedKnownZero) actual = 0;
        else if (complete && usage && bound.ok) {
          const c = modelUsageCost(bound.model, usage, bound);
          actual = c.usd;
          if (c.boundViolated) {
            s.boundViolations += 1;
            note("model_gate.bound_assumption_violated", `input bound ${bound.inputTokenBound}, max_tokens ${bound.maxTokens}`);
            if (opts.mode === "enforce") await opts.gate.stop("model bound assumption violated").catch(() => undefined);
          }
        }
        if (actual === null) s.unknownCharge += 1;
        const settled = await opts.gate.settle(reservationId, actual).catch(() => null);
        if (!settled || !settled.ok) note("model_gate.settle_failed", "left held: expires as spent");
        else s.settledUsd = Number((s.settledUsd + settled.countedUsd + settled.overrunUsd).toFixed(9));
      }
    }
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const cap = String(Math.floor(opts.maxOutputTokens ?? 32_000));
  return {
    baseUrl,
    childToken,
    childEnv: { ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_API_KEY: childToken, CLAUDE_CODE_MAX_OUTPUT_TOKENS: cap },
    stats: () => ({ ...s }),
    close: () => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}
