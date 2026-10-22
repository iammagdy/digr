import { PROVIDER_FACTS } from "../../multiProvider/catalog";
import type { CapabilityDef } from "../../multiProvider/types";
import { RETRYABLE_ON_ANOTHER_PROVIDER, type AdapterContext, type CallStatus, type ErrorCode, type OperationResult } from "./adapterTypes";

export interface InterpretedAnswer<T> {
  status: CallStatus;
  data: T | null;
  units: number;
  /** Credits the provider says the call used; null when the answer does not say (the registry's documented credits apply when the call was served). */
  credits: number | null;
  errorCode?: ErrorCode;
}

export interface HttpAnswer { httpStatus: number; json: any; headers: Headers }

/** Maps an HTTP status (and the provider's own error code) to the router's error codes. */
export function mapHttpError(httpStatus: number, json: any): ErrorCode {
  const code = String(json?.error_code ?? json?.code ?? "").toUpperCase();
  if (code === "WEBSITE_BLOCKED") return "blocked_site";
  if (code === "WEBSITE_NOT_FOUND") return "not_found";
  if (code === "REQUEST_TIMEOUT") return "timeout";
  if (code === "USAGE_EXCEEDED" || code === "INSUFFICIENT_CREDITS") return "insufficient_credits";
  if (httpStatus === 401 || httpStatus === 403) return "auth_rejected";
  if (httpStatus === 402) return "insufficient_credits";
  if (httpStatus === 408) return "timeout";
  if (httpStatus === 429) return "rate_limited";
  if (httpStatus === 404 || httpStatus === 410) return "not_found";
  if (httpStatus === 400 || httpStatus === 409 || httpStatus === 422) return "bad_request";
  if (httpStatus >= 500) return "server_error";
  return "bad_request";
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/**
 * One billed provider call, with the cost-recording hook around it: reserve against the provider's daily cap, send, interpret,
 * commit what the call really cost. Failed and empty calls are committed too (cost 0, or the credits the provider reported).
 * A call the cap refuses is not sent and writes nothing.
 */
export async function runRecordedCall<T>(args: {
  ctx: AdapterContext;
  capability: CapabilityDef;
  request: { url: string; method: "GET" | "POST"; headers: Record<string, string>; body?: unknown };
  interpret: (answer: HttpAnswer) => InterpretedAnswer<T>;
}): Promise<OperationResult<T>> {
  const { ctx, capability, request } = args;
  const now = ctx.now ?? Date.now;
  const facts = PROVIDER_FACTS[capability.provider];
  const usdPerCredit = facts.usdPerCredit ?? 0;
  const timeoutMs = Math.min(ctx.timeoutMs && ctx.timeoutMs > 0 ? ctx.timeoutMs : facts.callTimeoutMs, facts.callTimeoutMs);
  const estimatedUsd = round6(capability.costPerCallUsd ?? 0);

  const reservation = await ctx.recorder.reserve({ provider: capability.provider, capabilityId: capability.id, estimatedUsd, jobId: ctx.jobId });
  if (!reservation.allowed) {
    return { ok: false, status: "failed", data: null, units: 0, credits: 0, costUsd: 0, durationMs: 0, httpStatus: null, errorCode: "cap_reached", retryable: true };
  }

  const started = now();
  let answer: HttpAnswer | null = null;
  let errorCode: ErrorCode | undefined;
  try {
    const response = await ctx.fetchFn(request.url, {
      method: request.method,
      headers: { ...request.headers, Authorization: `Bearer ${ctx.apiKey}`, Accept: "application/json", ...(request.body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: request.body !== undefined ? JSON.stringify(request.body) : undefined,
      redirect: "error",
      cache: "no-store",
      signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined,
    });
    let json: any = null;
    try { json = await response.json(); } catch { json = null; }
    answer = { httpStatus: response.status, json, headers: response.headers };
  } catch (error) {
    const name = (error as { name?: string } | null)?.name;
    errorCode = name === "TimeoutError" || name === "AbortError" ? "timeout" : "network";
  }
  const durationMs = Math.max(0, now() - started);

  let result: OperationResult<T>;
  if (!answer) {
    result = { ok: false, status: "failed", data: null, units: 0, credits: 0, costUsd: 0, durationMs, httpStatus: null, errorCode, retryable: true };
  } else if (answer.httpStatus < 200 || answer.httpStatus >= 300) {
    const code = mapHttpError(answer.httpStatus, answer.json);
    // A failed call is charged only what the provider says it used (Context.dev reports credits_consumed on errors too); otherwise nothing.
    const credits = Number(answer.json?.key_metadata?.credits_consumed);
    const usedCredits = Number.isFinite(credits) && credits > 0 ? credits : 0;
    result = { ok: false, status: "failed", data: null, units: 0, credits: usedCredits, costUsd: round6(usedCredits * usdPerCredit), durationMs, httpStatus: answer.httpStatus, errorCode: code, retryable: RETRYABLE_ON_ANOTHER_PROVIDER.has(code) };
  } else {
    const read = args.interpret(answer);
    const credits = read.credits !== null ? read.credits : read.status === "failed" ? 0 : (capability.creditsPerCall ?? 0);
    result = {
      ok: read.status !== "failed",
      status: read.status,
      data: read.data,
      units: read.units,
      credits,
      costUsd: round6(credits * usdPerCredit),
      durationMs,
      httpStatus: answer.httpStatus,
      ...(read.errorCode ? { errorCode: read.errorCode } : {}),
      retryable: read.errorCode ? RETRYABLE_ON_ANOTHER_PROVIDER.has(read.errorCode) : false,
    };
  }

  try {
    await ctx.recorder.commit(reservation.costId, { provider: capability.provider, capabilityId: capability.id, status: result.status, units: result.units, costUsd: result.costUsd, durationMs, jobId: ctx.jobId });
  } catch {
    // Recording is best effort here: the reserved estimate row stays and counts against the cap (the conservative side).
  }
  return result;
}
