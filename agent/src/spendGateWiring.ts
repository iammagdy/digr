import { randomBytes } from "node:crypto";
import type { FetchFn } from "../../src/lib/server/multiProvider/adapterTypes";
import { gateAfter, gateBefore, spendGateMode, type GateContext, type GateEvent, type ReserveRequest, type SpendGate, type SpendGateMode, type SpendKind } from "../../src/lib/server/spendGate/gate";
import { DEFAULT_GATE_MAX_OUTPUT_TOKENS, modelRequestBound, modelUsageCost, type ModelUsage } from "../../src/lib/server/spendGate/modelBound";
import { createSupabaseSpendGate } from "../../src/lib/server/spendGate/supabaseGate";
import { checkAnthropicBetas, startModelGate, type ModelGateHandle } from "./modelGate";
import { anthropicReviewCall, type ReviewCall } from "./review";
import { PROVIDER_RESERVATION_TTL_SECONDS } from "./spendGateKeys";

/**
 * ROUND 62 (PR B): THE HARD SPEND GATE, WIRED INTO THE WORKER. NOT ACTIVE: DIGER_SPEND_GATE is unset in production, so `workerSpendGateFromEnv` returns null
 * and the worker builds nothing from this file (its behaviour is exactly that of round 61).
 *
 * When the owner sets the mode (a separate decision, after the SQL of docs/proposals/spend-gate/sql is applied and a grant is issued):
 *  - every TREG call (gateway.ts) and every Firecrawl / Context.dev call (webGateway.ts) reserves its BOUND before it is sent;
 *  - every request of the Agent SDK's model process goes through the model gate (modelGate.ts) on 127.0.0.1, which holds the real key;
 *  - every direct model request of the worker (review.ts: the row review, the channel and capability choices, the names step) goes through `gatedModelFetch`;
 *  - the grant's per-mission maximum is counted by the database across every run, round and restart of a mission: a model budget that the SDK gives
 *    each execution round again (round 59) can no longer reset the mission's total.
 *
 * OBSERVE IS NOT BUDGET ENFORCEMENT. In observe mode a request whose reservation is refused, or whose bound is unknown, is STILL SENT. Every such request
 * is counted (`unreserved_ops`, `unreserved_usd`, `would_refuse`), and the summary says `NOT_PROTECTED_OBSERVE_ONLY`. Nothing here may call observe «protected».
 */

export interface SpendGateSummary {
  mission_id: string;
  mode: "observe" | "enforce";
  protection: "ENFORCED" | "NOT_PROTECTED_OBSERVE_ONLY";
  note: string;
  /** Reservations taken (each one a bound held against the grant before a paid request). */
  reservations: number;
  reserved_usd: number;
  /** What settled reservations counted (the reported charge, capped at the bound; an unknown charge counts the whole bound). */
  settled_usd: number;
  /** Charges ABOVE their bound (each one trips the grant). */
  overrun_usd: number;
  overruns: number;
  /** Reservations settled with an unknown charge (no answer, a cut stream, a charge the provider did not report). */
  unknown_charges: number;
  settle_failures: number;
  /** ENFORCE: operations refused, so NOT sent. */
  refused: number;
  /** OBSERVE: operations enforce would have refused, which WERE sent. */
  would_refuse: number;
  refusal_reasons: Record<string, number>;
  /** OBSERVE: operations sent WITHOUT a reservation (provider calls and the worker's direct model requests), their reported charge, and those whose charge is unknown. */
  unreserved_ops: number;
  unreserved_usd: number;
  unreserved_unknown_charge: number;
  /** The model gate's own counts, summed over the runs of this mission in this worker (requests of the Agent SDK's process). */
  model: { runs: number; start_failures: number; requests: number; forwarded: number; refused: number; unauthorized: number; unknown_charge: number; bound_violations: number; settled_usd: number; unreserved: number; unreserved_usd: number };
  /** Of `unreserved_ops`: the worker's direct model requests (review.ts), and their priced charge. */
  direct_model_unreserved: number;
  direct_model_unreserved_usd: number;
  /** Everything sent without a reservation: `unreserved_ops` + `model.unreserved` (OBSERVE only; always 0 in ENFORCE). */
  total_unreserved_requests: number;
  /** The priced charge of those requests (known charges only; `unreserved_unknown_charge` are not in it). */
  total_unreserved_usd: number;
}

const r9 = (n: number) => Number(n.toFixed(9));

function snapshot(l: SpendGateSummary): SpendGateSummary {
  const s = JSON.parse(JSON.stringify(l)) as SpendGateSummary;
  s.total_unreserved_requests = s.unreserved_ops + s.model.unreserved;
  s.total_unreserved_usd = r9(s.unreserved_usd + s.model.unreserved_usd);
  return s;
}

function emptySummary(missionId: string, mode: "observe" | "enforce"): SpendGateSummary {
  return {
    mission_id: missionId, mode, protection: mode === "enforce" ? "ENFORCED" : "NOT_PROTECTED_OBSERVE_ONLY",
    note: mode === "enforce" ? "enforce: no paid request was sent without a reservation" : "observe: NOT budget enforcement; requests were sent even without a reservation (see unreserved_*)",
    reservations: 0, reserved_usd: 0, settled_usd: 0, overrun_usd: 0, overruns: 0, unknown_charges: 0, settle_failures: 0,
    refused: 0, would_refuse: 0, refusal_reasons: {}, unreserved_ops: 0, unreserved_usd: 0, unreserved_unknown_charge: 0,
    model: { runs: 0, start_failures: 0, requests: 0, forwarded: 0, refused: 0, unauthorized: 0, unknown_charge: 0, bound_violations: 0, settled_usd: 0, unreserved: 0, unreserved_usd: 0 },
    direct_model_unreserved: 0, direct_model_unreserved_usd: 0, total_unreserved_requests: 0, total_unreserved_usd: 0,
  };
}

/** A refusal reason as a short, fixed key: never a request's content. */
function reasonKey(e: GateEvent): string {
  if (e.reason) return e.reason;
  const d = String(e.detail ?? "");
  const known = /^(no_grant|grant_not_open|grant_expired|grant_revoked|grant_tripped|kind_not_covered|over_ceiling|over_mission_ceiling|over_op_max|bad_input|key_conflict|no_safe_bound|gate_unavailable)\b/.exec(d);
  if (known) return known[1];
  if (d.startsWith("anthropic-beta")) return "anthropic_beta";
  return "no_safe_bound";
}

export interface WorkerSpendGate {
  readonly mode: "observe" | "enforce";
  /** The context the provider gateways of this mission hold. */
  context(missionId: string): GateContext;
  /** The model gate of one SDK run of this mission (RunInput.modelGate). */
  modelGateFor(missionId: string): NonNullable<import("./driver").RunInput["modelGate"]>;
  /** A fetch that gates each direct model request of this mission (review.ts). */
  modelFetch(missionId: string, inner?: FetchFn): FetchFn;
  /** The review call (review.ts) of this mission, through `modelFetch`, with the worker's own key. */
  reviewCall(missionId: string): ReviewCall;
  /** What has been recorded for this mission so far (a copy). */
  summary(missionId: string): SpendGateSummary;
  /** Logs the mission's summary and forgets it. */
  finish(missionId: string): SpendGateSummary;
}

export interface WorkerSpendGateOptions {
  mode: "observe" | "enforce";
  gate: SpendGate | null;
  /** The real Anthropic key: stays in the worker process (the model gate and the direct requests use it; the SDK's child never sees it). */
  apiKey: string;
  upstreamBaseUrl?: string;
  log?: (line: string) => void;
  fetchFn?: FetchFn;
  timeoutMs?: number;
  maxOutputTokens?: number;
}

export function createWorkerSpendGate(opts: WorkerSpendGateOptions): WorkerSpendGate {
  const mode = opts.mode;
  const upstream = (opts.upstreamBaseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "");
  const tallies = new Map<string, SpendGateSummary>();
  const tally = (missionId: string) => { let l = tallies.get(missionId); if (!l) { l = emptySummary(missionId, mode); tallies.set(missionId, l); } return l; };
  const log = (line: string) => { try { opts.log?.(line); } catch { /* never decides */ } };

  /** The gate a mission's calls hold: the real gate, with every reservation and settlement counted in the mission's tally. */
  const recordingGate = (missionId: string): SpendGate | null => {
    const g = opts.gate;
    if (!g) return null;
    const l = () => tally(missionId);
    return {
      async reserve(req: ReserveRequest) {
        const r = await g.reserve(req);
        if (r.ok && !r.replay) { l().reservations += 1; l().reserved_usd = r9(l().reserved_usd + req.boundUsd); }
        return r;
      },
      async settle(id: string, actualUsd: number | null) {
        const s = await g.settle(id, actualUsd);
        if (s.ok && !s.replay) {
          l().settled_usd = r9(l().settled_usd + s.countedUsd);
          if (actualUsd === null) l().unknown_charges += 1;
          if (s.overrunUsd > 0) { l().overruns += 1; l().overrun_usd = r9(l().overrun_usd + s.overrunUsd); }
        }
        return s;
      },
      stop: (reason: string) => g.stop(reason),
    };
  };

  const onEvent = (missionId: string) => (e: GateEvent) => {
    const l = tally(missionId);
    switch (e.type) {
      case "spend_gate.refused":
      case "model_gate.refused":
        l.refused += 1; l.refusal_reasons[reasonKey(e)] = (l.refusal_reasons[reasonKey(e)] ?? 0) + 1;
        log(`spend_gate ${missionId} REFUSED (not sent) ${String(e.op ?? "model").slice(0, 80)} ${reasonKey(e)}`);
        break;
      case "spend_gate.observed_refusal":
      case "model_gate.observed_refusal":
        l.would_refuse += 1; l.refusal_reasons[reasonKey(e)] = (l.refusal_reasons[reasonKey(e)] ?? 0) + 1;
        break;
      case "spend_gate.observed_unreserved_usage": {
        const known = typeof e.usd === "number" && Number.isFinite(e.usd);
        l.unreserved_ops += 1;
        if (known) l.unreserved_usd = r9(l.unreserved_usd + (e.usd as number)); else l.unreserved_unknown_charge += 1;
        if (String(e.op ?? "").startsWith("model:")) { l.direct_model_unreserved += 1; if (known) l.direct_model_unreserved_usd = r9(l.direct_model_unreserved_usd + (e.usd as number)); }
        break;
      }
      case "spend_gate.settle_failed":
      case "model_gate.settle_failed":
        l.settle_failures += 1;
        break;
      case "spend_gate.bound_violated":
      case "model_gate.bound_assumption_violated":
        log(`spend_gate ${missionId} BOUND VIOLATED ${String(e.op ?? "model").slice(0, 80)}`);
        break;
      default:
        break;
    }
  };

  const context = (missionId: string): GateContext => ({ gate: recordingGate(missionId), mode, ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}), onEvent: onEvent(missionId) });

  return {
    mode,
    context,
    modelGateFor(missionId) {
      return {
        mode,
        start: async () => {
          let handle: ModelGateHandle;
          try {
            handle = await startModelGate({ upstreamBaseUrl: upstream, apiKey: opts.apiKey, gate: recordingGate(missionId), mode, missionId, ...(opts.maxOutputTokens ? { maxOutputTokens: opts.maxOutputTokens } : {}), ...(opts.fetchFn ? { fetchFn: opts.fetchFn as unknown as typeof fetch } : {}), onEvent: onEvent(missionId) });
          } catch (e) {
            tally(missionId).model.start_failures += 1;
            log(`spend_gate ${missionId} model gate did not start${mode === "enforce" ? ": the run is not started" : ": observe runs WITHOUT the gate (unmeasured)"}`);
            throw e;
          }
          tally(missionId).model.runs += 1;
          return {
            childEnv: handle.childEnv,
            close: async () => {
              await handle.close();
              const st = handle.stats();
              const m = tally(missionId).model;
              m.requests += st.requests; m.forwarded += st.forwarded; m.refused += st.refused; m.unauthorized += st.unauthorized; m.unknown_charge += st.unknownCharge;
              m.bound_violations += st.boundViolations; m.settled_usd = r9(m.settled_usd + st.settledUsd); m.unreserved += st.unreserved; m.unreserved_usd = r9(m.unreserved_usd + st.unreservedUsd);
            },
          };
        },
      };
    },
    modelFetch(missionId, inner) {
      return gatedModelFetch(context(missionId), missionId, {
        inner: inner ?? opts.fetchFn ?? ((input, init) => fetch(input, init)),
        ...(opts.maxOutputTokens ? { maxOutputTokens: opts.maxOutputTokens } : {}),
      });
    },
    reviewCall(missionId) {
      return anthropicReviewCall(opts.apiKey, gatedModelFetch(context(missionId), missionId, { inner: opts.fetchFn ?? ((input, init) => fetch(input, init)), ...(opts.maxOutputTokens ? { maxOutputTokens: opts.maxOutputTokens } : {}) }));
    },
    summary: (missionId) => snapshot(tally(missionId)),
    finish(missionId) {
      const s = snapshot(tally(missionId));
      tallies.delete(missionId);
      // one line per mission: counts and amounts only (no request content, no key)
      log(`spend_gate.summary ${JSON.stringify(s)}`);
      return s;
    },
  };
}

const NOT_BILLED_MODEL_STATUSES = new Set([400, 401, 403, 404, 413, 429]);

function errorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } }), { status, headers: { "content-type": "application/json" } });
}

/**
 * ROUND 62: a fetch for the worker's DIRECT model requests (review.ts). Each POST to /v1/messages is ONE paid attempt: its bound is computed from the body
 * before it is sent (modelBound.ts) and reserved; ENFORCE refuses (HTTP 403, nothing sent) when there is no bound or no room, and lowers max_tokens to the
 * gate's cap; OBSERVE sends the request as it is and reports a request it could not reserve, with its priced charge. A retry (review.ts asks again
 * without its tool after a 400) is another call of this fetch, so another reservation. The answer's `usage` settles it; no answer, an unreadable answer
 * or a server error settles UNKNOWN (the whole bound stays spent).
 */
export function gatedModelFetch(ctx: GateContext, missionId: string | null, o: { inner: FetchFn; maxOutputTokens?: number; ttlSeconds?: number; kind?: SpendKind }): FetchFn {
  const cap = Math.max(1, Math.floor(o.maxOutputTokens ?? DEFAULT_GATE_MAX_OUTPUT_TOKENS));
  const runId = randomBytes(6).toString("hex");
  let seq = 0;
  return async (input, init) => {
    if (ctx.mode === "off") return o.inner(input, init);
    const url = String(input);
    const method = String(init?.method ?? "GET").toUpperCase();
    const isMessages = method === "POST" && /\/v1\/messages(\?|$)/.test(url);
    const bodyText = typeof init?.body === "string" ? init.body : null;
    let parsed: unknown = null;
    if (bodyText !== null) { try { parsed = JSON.parse(bodyText); } catch { parsed = null; } }
    const headers = new Headers((init?.headers ?? {}) as HeadersInit);
    const betas = checkAnthropicBetas(headers.get("anthropic-beta") ?? undefined);
    const enforce = ctx.mode === "enforce";
    // enforce: the bound of what is SENT (max_tokens lowered to the cap); observe: the bound of the request exactly as it is sent today
    const bound = !isMessages || bodyText === null ? { ok: false as const, reason: "no_safe_bound" as const, detail: "not a model request the gate can bound" }
      : !betas.ok ? { ok: false as const, reason: "no_safe_bound" as const, detail: betas.detail }
      : modelRequestBound(parsed, Buffer.byteLength(bodyText, "utf8"), { maxOutputTokens: enforce ? cap : Number.MAX_SAFE_INTEGER });
    seq += 1;
    const op = bound.ok ? `model:${bound.model}` : "model:direct";
    const before = await gateBefore(ctx, bound.ok
      ? { key: `model-direct:${missionId ?? "none"}:${runId}:${seq}`, kind: o.kind ?? "model", op, boundUsd: bound.usd, missionId, ttlSeconds: o.ttlSeconds ?? PROVIDER_RESERVATION_TTL_SECONDS }
      : { refuse: "no_safe_bound", detail: bound.detail, op });
    if (!before.proceed) return errorResponse(403, `spend_gate_refused: ${before.reason}`);
    const sendBody = enforce && bound.ok && bound.maxTokens !== Number((parsed as { max_tokens?: unknown }).max_tokens) ? JSON.stringify(bound.body) : init?.body;
    let res: Response;
    try {
      res = await o.inner(input, { ...init, body: sendBody } as RequestInit);
    } catch (e) {
      await gateAfter(ctx, before, null);
      throw e;
    }
    if (!res.ok) {
      const actual = NOT_BILLED_MODEL_STATUSES.has(res.status) ? 0 : null;
      await gateAfter(ctx, before, actual);
      return res;
    }
    let text: string | null = null;
    try { text = await res.text(); } catch { text = null; }
    let usage: ModelUsage | null = null;
    if (text !== null && !(res.headers.get("content-type") ?? "").includes("text/event-stream")) { try { usage = (JSON.parse(text) as { usage?: ModelUsage })?.usage ?? null; } catch { usage = null; } }
    const model = typeof (parsed as { model?: unknown } | null)?.model === "string" ? String((parsed as { model: string }).model) : "";
    let actual: number | null = null;
    if (usage) {
      const c = modelUsageCost(model, usage, bound.ok ? bound : { inputTokenBound: Number.POSITIVE_INFINITY, maxTokens: Number.POSITIVE_INFINITY });
      actual = Number.isFinite(c.usd) ? c.usd : null;
      if (bound.ok && c.boundViolated) {
        try { ctx.onEvent?.({ type: "model_gate.bound_assumption_violated", op, detail: `input bound ${bound.inputTokenBound}, max_tokens ${bound.maxTokens}` }); } catch { /* never decides */ }
        if (enforce && ctx.gate) await ctx.gate.stop("model bound assumption violated (direct request)").catch(() => undefined);
      }
    }
    await gateAfter(ctx, before, actual);
    return new Response(text ?? "", { status: res.status, headers: res.headers });
  };
}

/**
 * The worker's spend gate from its environment. `DIGER_SPEND_GATE` unset, "", "off" or "0": NULL, and the worker is exactly as before (nothing is
 * started, nothing is reserved, no request changes). "observe": measurement only, NOT budget enforcement. Anything else: enforce (a typo fails closed).
 * The database functions (spend_reserve, spend_settle, spend_stop) are NOT applied in production: until the owner applies them, every reservation fails
 * (`gate_unavailable`), so enforce refuses every paid call and observe sends every call unreserved.
 */
export function workerSpendGateFromEnv(env: Record<string, string | undefined>, client: { rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message?: string } | null }> } | null, log?: (line: string) => void): WorkerSpendGate | null {
  const mode: SpendGateMode = spendGateMode(env);
  if (mode === "off") return null;
  const apiKey = env.ANTHROPIC_API_KEY ?? "";
  const gate = client ? createSupabaseSpendGate(client) : null;
  log?.(mode === "enforce" ? "spend gate: ENFORCE (no paid request without a reservation)" : "spend gate: OBSERVE (measurement only, NOT budget enforcement: unreserved requests are still sent)");
  return createWorkerSpendGate({ mode, gate, apiKey, ...(log ? { log } : {}) });
}
