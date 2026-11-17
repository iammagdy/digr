import { capabilitiesOfProvider, capabilityById } from "../../../multiProvider/catalog";
import type { CapabilityDef, OperationKind } from "../../../multiProvider/types";
import type { AdapterContext, CallStatus, ErrorCode, OperationInputs, OperationOutputs, OperationResult, ProviderAdapter, SupportedOperation } from "../adapterTypes";
import { RETRYABLE_ON_ANOTHER_PROVIDER } from "../adapterTypes";
import { mapHttpError } from "../httpCall";
import type { ProviderAdapterCallInput, ProviderAdapterCallOutput, ProviderAdapterFn } from "../../tregAdapter";
import { normalizeIcypeasCompanyParams } from "../../tregAdapter";
import { executeTregCall, type TregCallOptions, type TregCallResult } from "../../../../functions/shared/tregClient";
import { parseIcypeasCompaniesResponse } from "../../../../functions/shared/multiStepWorker";
import { TREG_DIRECTORY, TREG_EMAIL_LOOKUP, tombaAnswerKind, type TregAnswerKind } from "../../../multiProvider/tregContacts";

/**
 * TREG stays a first-class provider and the fallback. Its company directory is reached through the EXISTING adapter function
 * (`defaultTregAdapter` in production, an injected fake in tests), so every rule that adapter already holds (key resolution, retry,
 * the route cost cap, row parsing) is unchanged. This module only adds what the router needs around it: the capability list, the
 * error mapping and the cost recording of each directory page with the provider identifier `treg`.
 */
export interface DirectoryPageResult {
  ok: boolean;
  status: CallStatus;
  rows: Record<string, any>[];
  nextCursor: string | null;
  costUsd: number;
  durationMs: number;
  httpStatus: number | null;
  errorCode?: ErrorCode;
  retryable: boolean;
}

export const tregAdapter: ProviderAdapter = {
  id: "treg",
  capabilities: (): CapabilityDef[] => capabilitiesOfProvider("treg"),
  supports: (operation: OperationKind) => operation === "discover.companies",
  async run<K extends SupportedOperation>(operation: K, _input: OperationInputs[K], _ctx: AdapterContext): Promise<OperationResult<OperationOutputs[K]>> {
    throw new Error(`treg does not support ${String(operation)} through run(); use runTregDirectoryPage`);
  },
};

/** One page of the company directory, recorded in provider_costs as provider `treg` whatever happens (success, empty or failure). */
export async function runTregDirectoryPage(args: {
  tregFn: ProviderAdapterFn;
  input: ProviderAdapterCallInput;
  ctx: Pick<AdapterContext, "recorder" | "jobId" | "now">;
}): Promise<DirectoryPageResult> {
  const capability = capabilityById("treg.companies.search") as CapabilityDef;
  const now = args.ctx.now ?? Date.now;
  const perRecord = capability.costPerUnitUsd ?? 0;
  const estimatedUsd = Math.round(perRecord * Math.max(1, args.input.pageSize) * 1e6) / 1e6;
  const reservation = await args.ctx.recorder.reserve({ provider: "treg", capabilityId: capability.id, estimatedUsd, jobId: args.ctx.jobId });
  if (!reservation.allowed) {
    return { ok: false, status: "failed", rows: [], nextCursor: null, costUsd: 0, durationMs: 0, httpStatus: null, errorCode: "cap_reached", retryable: true };
  }
  const started = now();
  let out: ProviderAdapterCallOutput | null = null;
  try {
    out = await args.tregFn(args.input);
  } catch {
    out = null;
  }
  const durationMs = Math.max(0, now() - started);
  let result: DirectoryPageResult;
  if (!out) {
    result = { ok: false, status: "failed", rows: [], nextCursor: null, costUsd: 0, durationMs, httpStatus: null, errorCode: "network", retryable: true };
  } else if (!out.ok) {
    const code = out.httpStatus === 503 && !out.errorCode ? "network" : mapHttpError(out.httpStatus, { code: out.errorCode });
    const costUsd = Math.max(0, Number(out.costUsd) || 0);
    result = { ok: false, status: "failed", rows: [], nextCursor: null, costUsd, durationMs, httpStatus: out.httpStatus, errorCode: code, retryable: RETRYABLE_ON_ANOTHER_PROVIDER.has(code) };
  } else {
    const rows = Array.isArray(out.rows) ? out.rows : [];
    result = { ok: true, status: rows.length === 0 ? "empty" : "success", rows, nextCursor: out.nextCursor ?? null, costUsd: Math.max(0, Number(out.costUsd) || 0), durationMs, httpStatus: out.httpStatus, retryable: false };
  }
  try {
    await args.ctx.recorder.commit(reservation.costId, { provider: "treg", capabilityId: capability.id, status: result.status, units: result.rows.length, costUsd: result.costUsd, durationMs, jobId: args.ctx.jobId });
  } catch { /* best effort: the reserved estimate row stays and counts against the cap */ }
  return result;
}

export interface TregCallOutcome { ok: boolean; status: CallStatus; httpStatus: number | null; errorCode?: ErrorCode; body: any; committedUsd: number; known: boolean; refused?: "cap_reached" | "budget_reached" | "ledger_unavailable"; timedOut: boolean; answerKind: TregAnswerKind; durationMs: number }

export function buildTregIdempotencyKey(args: { jobId: string; attemptId: string; ordinal: number; kind: "dir" | "dirkw" | "mail" }): string {
  const raw = `c_${args.jobId}_${args.attemptId}_${Math.max(0, Math.floor(args.ordinal))}_${args.kind}`;
  const key = raw.replace(/[^A-Za-z0-9_-]/g, "_");
  if (key.length > 120) {
    throw new Error("treg_key_too_long");
  }
  return key;
}

export function classifyTregCost(result: TregCallResult | null | undefined, reservedMicro: number, answerKind: TregAnswerKind, thrown?: unknown): { known: boolean; commitMicro: number } {
  const valid = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x) && x >= 0;
  const unknown = (): { known: boolean; commitMicro: number } => {
    const figs = result ? [result.costMicro, "originalCostMicro" in result ? result.originalCostMicro : undefined, "chargedMicroReported" in result ? result.chargedMicroReported : undefined] : [];
    return { known: false, commitMicro: Math.max(reservedMicro, ...figs.filter(valid)) };
  };
  if (thrown !== undefined || !result) return unknown();
  if (result.timedOut === true || result.error === "network_failure" || !Number.isSafeInteger(result.httpStatus)) return unknown();
  if ("blocked" in result && result.blocked !== undefined || "budgetStopped" in result && (result as any).budgetStopped !== undefined) return unknown();
  const s = result.httpStatus;
  const definite = (s >= 200 && s <= 299) || (s >= 400 && s <= 499 && s !== 408 && s !== 409);
  if (!definite) return unknown();
  if (result.costHeaderInvalid === true || result.costUnreported === true || result.costIsEstimate === true) return unknown();
  const figs6 = [result.costMicro, ...("originalCostMicro" in result ? [result.originalCostMicro] : []), ...("chargedMicroReported" in result ? [result.chargedMicroReported] : [])];
  if (figs6.some((x) => !valid(x))) return unknown();
  const knownMicro = Math.max(...(figs6 as number[]));
  if (knownMicro > 0) return { known: true, commitMicro: knownMicro };
  if (result.httpStatus >= 200 && result.httpStatus <= 299) return answerKind === "empty" ? { known: true, commitMicro: 0 } : unknown();
  if (result.httpStatus >= 400 && result.httpStatus <= 499) return { known: true, commitMicro: 0 };
  return unknown();
}

export async function runTregCall(args: {
  tregCall?: (options: TregCallOptions) => Promise<TregCallResult>;
  ctx: Pick<AdapterContext, "recorder" | "jobId" | "now">;
  capabilityId: string;
  reservedUsd: number;
  options: TregCallOptions;
  answerKindOf: (body: any) => TregAnswerKind;
  unitsOf: (body: any) => number;
}): Promise<TregCallOutcome> {
  const reservation = await args.ctx.recorder.reserve({
    provider: "treg",
    capabilityId: args.capabilityId,
    estimatedUsd: args.reservedUsd,
    jobId: args.ctx.jobId,
  });
  if (!reservation.allowed) {
    const refused = reservation.reason === "budget" ? "budget_reached" : reservation.reason === "error" ? "ledger_unavailable" : "cap_reached";
    return {
      ok: false,
      status: "failed",
      httpStatus: null,
      body: null,
      committedUsd: 0,
      known: true,
      timedOut: false,
      answerKind: "unparsable",
      durationMs: 0,
      refused,
    };
  }
  const now = args.ctx.now ?? Date.now;
  const started = now();
  const call = args.tregCall ?? executeTregCall;
  let result: TregCallResult | undefined;
  let thrown: unknown;
  try {
    result = await call(args.options);
  } catch (e) {
    thrown = e ?? new Error("treg_call_failed");
  }
  const durationMs = Math.max(0, now() - started);
  const body = result?.data ?? null;
  const okAnswer = Boolean(result && result.ok && result.httpStatus >= 200 && result.httpStatus <= 299);
  const answerKind = okAnswer ? args.answerKindOf(body) : "unparsable";
  const verdict = classifyTregCost(result, Math.round(args.reservedUsd * 1e6), answerKind, thrown);
  const units = okAnswer ? args.unitsOf(body) : 0;
  const status: CallStatus = okAnswer ? (units > 0 ? "success" : "empty") : "failed";
  try {
    await args.ctx.recorder.commit(reservation.costId, {
      provider: "treg",
      capabilityId: args.capabilityId,
      status,
      units,
      costUsd: verdict.commitMicro / 1e6,
      durationMs,
      jobId: args.ctx.jobId,
    });
  } catch {
    /* the reserved row stays and counts */
  }
  const httpStatus = result?.httpStatus ?? null;
  let errorCode: ErrorCode | undefined;
  if (!okAnswer) {
    errorCode = httpStatus !== null ? mapHttpError(httpStatus, { code: undefined }) : "network";
  }
  return {
    ok: okAnswer,
    status,
    httpStatus,
    ...(errorCode ? { errorCode } : {}),
    body,
    committedUsd: verdict.commitMicro / 1e6,
    known: verdict.known,
    timedOut: result?.timedOut === true,
    answerKind,
    durationMs,
  };
}

export async function runTregDirectoryPageDirect(args: {
  tregCall?: (options: TregCallOptions) => Promise<TregCallResult>;
  ctx: Pick<AdapterContext, "recorder" | "jobId" | "now">;
  userId: string;
  rawParams: Record<string, any>;
  cursor: string | null;
  keywordsOnly?: boolean;
  idempotencyKey: string;
  timeoutMs: number;
}): Promise<TregCallOutcome & { rows: Record<string, any>[]; nextCursor: string | null }> {
  const options: TregCallOptions = {
    endpointId: TREG_DIRECTORY.endpointId,
    method: "POST",
    params: normalizeIcypeasCompanyParams(args.rawParams, TREG_DIRECTORY.pageSize, args.cursor, { keywordsOnly: args.keywordsOnly === true }),
    userId: args.userId,
    jobId: args.ctx.jobId ?? "",
    idempotencyKey: args.idempotencyKey,
    timeoutMs: args.timeoutMs,
    callEstimateUsd: TREG_DIRECTORY.reservedUsd,
    routeMaxCostUsd: TREG_DIRECTORY.headerCeilingUsd,
  };
  const parseSafe = (b: any) => {
    try {
      return parseIcypeasCompaniesResponse(b);
    } catch {
      return null;
    }
  };
  const outcome = await runTregCall({
    tregCall: args.tregCall,
    ctx: args.ctx,
    capabilityId: "treg.companies.search",
    reservedUsd: TREG_DIRECTORY.reservedUsd,
    options,
    answerKindOf: (b) => {
      const p = parseSafe(b);
      return Array.isArray(p?.rows) ? (p.rows.length === 0 ? "empty" : "non_empty") : "unparsable";
    },
    unitsOf: (b) => {
      const p = parseSafe(b);
      return Array.isArray(p?.rows) ? p.rows.length : 0;
    },
  });
  if (outcome.ok) {
    const p = parseSafe(outcome.body);
    return {
      ...outcome,
      rows: Array.isArray(p?.rows) ? p.rows : [],
      nextCursor: typeof p?.nextCursor === "string" ? p.nextCursor : null,
    };
  }
  return {
    ...outcome,
    rows: [],
    nextCursor: null,
  };
}

