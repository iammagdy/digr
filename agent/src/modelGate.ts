import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { DEFAULT_GATE_MAX_OUTPUT_TOKENS, modelRequestBound, modelUsageCost, type ModelBound, type ModelUsage } from "../../src/lib/server/spendGate/modelBound";
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
 *
 * PR #479 review fixes:
 *  1. OBSERVE reserves the bound of the request it actually forwards (the SDK's own max_tokens), never the capped bound ENFORCE would send, so an answer
 *     longer than the cap is not a false overrun and cannot trip a grant. A request whose as-sent bound cannot be reserved is forwarded unreserved and
 *     its priced usage is reported apart (`unreservedUsd`), never hidden. OBSERVE also leaves the child's output cap unset (the SDK runs as today).
 *  2. anthropic-beta: only the values in ALLOWED_ANTHROPIC_BETAS pass. Anything else (a value that bills by the header alone, such as long-context or
 *     fast-mode pricing, or an unknown one) is refused before sending in ENFORCE, and forwarded unreserved in OBSERVE.
 *  3. The child's token is compared in constant time (SHA-256 digests through timingSafeEqual); the gate listens on 127.0.0.1 only and drops any
 *     connection that does not come from it.
 */

/**
 * The anthropic-beta values ENFORCE forwards: exactly those the Agent SDK 0.3.312 sends on every request (measured against a fake upstream on
 * 127.0.0.1, 13 Nov 2026), each with the reason its billing is inside the request bound. A value earns a place here only by such a reason; anything
 * else is refused. Values that bill by the header alone (e.g. `context-1m-*` long-context pricing) are deliberately absent.
 */
export const ALLOWED_ANTHROPIC_BETAS: Readonly<Record<string, string>> = Object.freeze({
  "claude-code-20250219": "client identification of the Agent SDK; adds no billable feature",
  "interleaved-thinking-2025-05-14": "thinking between tool calls is output, inside max_tokens",
  "context-management-2025-06-27": "context edits; the body check accepts only clear_* edits, which remove input",
  "effort-2025-11-24": "output_config.effort changes how many tokens are used, inside max_tokens",
  "per-turn-control-2026-07-01": "per-message effort (same feature as effort); inside max_tokens",
  "thinking-token-count-2026-05-13": "reports thinking token counts; reporting only",
  "thinking-display-updates-2026-08-18": "thinking display mode; visibility only, billed the same",
  "mid-conversation-tool-changes-2026-07-01": "inert here: its tool_addition/tool_removal blocks are refused by the body check",
  "inline-tools-2026-09-15": "inert here: its tool_addition blocks are refused by the body check",
  "advisor-tool-2026-03-01": "inert here: the advisor bills only through a tools entry of its own type, which the body check refuses",
});
export const MAX_BETA_HEADER_LENGTH = 2048;
export const MAX_BETA_VALUES = 32;
const BETA_NAME = /^[a-z0-9]+(?:-[a-z0-9]+){0,15}$/;

export type BetaCheck = { ok: true; values: string[] } | { ok: false; detail: string };

/** Parses an anthropic-beta header (comma-separated, possibly repeated). Strict: an empty, malformed or non-allowlisted value refuses the whole header. */
export function checkAnthropicBetas(header: string | string[] | undefined): BetaCheck {
  if (header === undefined) return { ok: true, values: [] };
  const raw = Array.isArray(header) ? header.join(",") : header;
  if (typeof raw !== "string" || raw.length > MAX_BETA_HEADER_LENGTH) return { ok: false, detail: "anthropic-beta: header too long" };
  const parts = raw.split(",").map((p) => p.trim());
  if (parts.length > MAX_BETA_VALUES) return { ok: false, detail: "anthropic-beta: too many values" };
  const values: string[] = [];
  for (const p of parts) {
    if (p === "") return { ok: false, detail: "anthropic-beta: empty value" };
    // a malformed value is not echoed (it comes from the child and could carry anything)
    if (p.length > 100 || !BETA_NAME.test(p)) return { ok: false, detail: "anthropic-beta: malformed value" };
    if (!Object.prototype.hasOwnProperty.call(ALLOWED_ANTHROPIC_BETAS, p)) return { ok: false, detail: `anthropic-beta: «${p}» is not allowed (its billing is not shown to be inside the request bound)` };
    if (!values.includes(p)) values.push(p);
  }
  return { ok: true, values };
}

/** The gate binds 127.0.0.1; a connection from anywhere else is dropped before any header is read. */
export function isLoopbackAddress(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::ffff:127.0.0.1";
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest();
const MAX_TOKEN_LENGTH = 512;

/**
 * The credential the child presented: `x-api-key` when present, else `Authorization: Bearer <token>`. Null when missing or malformed. Nothing here
 * compares secret bytes: the comparison is done once, in constant time, by the caller.
 */
function presentedToken(req: http.IncomingMessage): string | null {
  const key = req.headers["x-api-key"];
  if (key !== undefined) return typeof key === "string" && key.length > 0 && key.length <= MAX_TOKEN_LENGTH ? key : null;
  const auth = req.headers.authorization;
  if (typeof auth !== "string") return null;
  const m = /^Bearer ([\x21-\x7e]{1,512})$/i.exec(auth);
  return m ? m[1] : null;
}

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
  /** `unauthorized`: requests refused for a missing or wrong token. `unreservedUsd`: priced usage of OBSERVE requests forwarded without a reservation. */
  stats(): { requests: number; forwarded: number; refused: number; unknownCharge: number; boundViolations: number; settledUsd: number; unauthorized: number; unreserved: number; unreservedUsd: number };
  close(): Promise<void>;
}

const NOT_BILLED_STATUSES = new Set([400, 401, 403, 404, 413, 429]);

function errorJson(message: string) {
  return JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } });
}

export async function startModelGate(opts: ModelGateOptions): Promise<ModelGateHandle> {
  const childToken = `gate-${randomBytes(24).toString("hex")}`;
  const childTokenDigest = sha256(childToken);
  const fetchFn = opts.fetchFn ?? fetch;
  const kind: SpendKind = opts.kind ?? "model";
  const ttl = Math.min(900, Math.max(30, Math.floor(opts.ttlSeconds ?? 600)));
  const maxBody = opts.maxBodyBytes ?? 8 * 1024 * 1024;
  const capTokens = Math.max(1, Math.floor(opts.maxOutputTokens ?? DEFAULT_GATE_MAX_OUTPUT_TOKENS));
  const runId = randomBytes(8).toString("hex");
  const s = { requests: 0, forwarded: 0, refused: 0, unknownCharge: 0, boundViolations: 0, settledUsd: 0, unauthorized: 0, unreserved: 0, unreservedUsd: 0 };
  let seq = 0;
  const note = (type: string, detail?: string) => { try { opts.onEvent?.({ type, detail }); } catch { /* never decides */ } };
  /** Constant time in the token's content and length: both sides are hashed to 32 bytes before timingSafeEqual. */
  const isChild = (presented: string | null) => presented !== null && timingSafeEqual(sha256(presented), childTokenDigest);

  const server = http.createServer((req, res) => {
    if (!isLoopbackAddress(req.socket.remoteAddress)) { req.socket.destroy(); return; }
    void handle(req, res).catch((e) => {
      note("model_gate.error", String((e as Error)?.message ?? e).slice(0, 160));
      if (!res.headersSent) { res.writeHead(502, { "content-type": "application/json" }); res.end(errorJson("spend_gate_error")); } else res.destroy();
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? "/", "http://gate.local");
    if ((req.method === "HEAD" || req.method === "GET") && url.pathname === "/api/hello") { res.writeHead(200); res.end(); return; }
    if (!isChild(presentedToken(req))) { s.unauthorized += 1; res.writeHead(401, { "content-type": "application/json" }); res.end(errorJson("spend_gate: unknown caller")); return; }
    if (req.method !== "POST" || url.pathname !== "/v1/messages") { res.writeHead(403, { "content-type": "application/json" }); res.end(errorJson(`spend_gate: ${url.pathname} is not gated`)); return; }
    s.requests += 1;
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) { size += (c as Buffer).length; if (size > maxBody) { res.writeHead(413, { "content-type": "application/json" }); res.end(errorJson("spend_gate: request too large")); return; } chunks.push(c as Buffer); }
    const rawBody = Buffer.concat(chunks);
    let parsed: unknown = null;
    try { parsed = JSON.parse(rawBody.toString("utf8")); } catch { /* refused below */ }
    const refuse = (why: string) => { s.refused += 1; note("model_gate.refused", why); res.writeHead(400, { "content-type": "application/json" }); res.end(errorJson(`spend_gate_refused: ${why}`)); };
    const betas = checkAnthropicBetas(req.headers["anthropic-beta"]);
    // what ENFORCE sends: max_tokens lowered to the cap
    const capped = modelRequestBound(parsed, rawBody.length, { maxOutputTokens: capTokens });
    let bound: ModelBound;
    if (opts.mode === "enforce") {
      if (!betas.ok) return refuse(betas.detail);
      if (!capped.ok) return refuse(capped.detail);
      bound = capped;
    } else {
      // OBSERVE forwards the SDK's request exactly as sent, so the bound reserved is the bound of THAT request (its own max_tokens), never the capped one:
      // an answer longer than the cap is then not an overrun and cannot trip the grant. What ENFORCE would have refused is only recorded.
      if (!betas.ok) note("model_gate.observed_refusal", betas.detail);
      else if (!capped.ok) note("model_gate.observed_refusal", capped.detail);
      bound = betas.ok ? modelRequestBound(parsed, rawBody.length, { maxOutputTokens: Number.MAX_SAFE_INTEGER }) : { ok: false, reason: "no_safe_bound", detail: betas.detail };
    }

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
    } else note("model_gate.observed_unreserved", bound.detail);
    // only OBSERVE reaches here without a reservation (ENFORCE has returned): its usage is priced and reported apart, never hidden
    const unreserved = reservationId === null;
    if (unreserved) s.unreserved += 1;

    // observe forwards the request exactly as the SDK sent it; enforce sends the body with max_tokens lowered to the cap, and only the checked betas
    const outBody = opts.mode === "enforce" && bound.ok ? Buffer.from(JSON.stringify(bound.body)) : rawBody;
    const headers: Record<string, string> = { "content-type": "application/json", "x-api-key": opts.apiKey };
    for (const h of ["anthropic-version", "accept"]) { const v = req.headers[h]; if (typeof v === "string") headers[h] = v; }
    if (opts.mode === "enforce") { if (betas.ok && betas.values.length) headers["anthropic-beta"] = betas.values.join(","); }
    else { const v = req.headers["anthropic-beta"]; if (typeof v === "string") headers["anthropic-beta"] = v; }
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
      if (unreserved && complete && usage) {
        const model = typeof (parsed as { model?: unknown } | null)?.model === "string" ? String((parsed as { model: string }).model) : "";
        const c = modelUsageCost(model, usage, { inputTokenBound: Number.POSITIVE_INFINITY, maxTokens: Number.POSITIVE_INFINITY });
        if (Number.isFinite(c.usd)) { s.unreservedUsd = Number((s.unreservedUsd + c.usd).toFixed(9)); note("model_gate.observed_unreserved_usage", `${c.usd} USD`); }
        else note("model_gate.observed_unreserved_usage", "unpriced model");
      }
    }
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  // ENFORCE also asks the SDK itself for the cap; OBSERVE leaves the child's output cap as it is today (the SDK's requests are only recorded)
  const childEnv: Record<string, string> = { ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_API_KEY: childToken };
  if (opts.mode === "enforce") childEnv.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(capTokens);
  return {
    baseUrl,
    childToken,
    childEnv,
    stats: () => ({ ...s }),
    close: () => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}
