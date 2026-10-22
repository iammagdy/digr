import { capabilitiesOfProvider, capabilityById } from "../../../multiProvider/catalog";
import type { CapabilityDef, OperationKind } from "../../../multiProvider/types";
import type { AdapterContext, CallStatus, ErrorCode, OperationInputs, OperationOutputs, OperationResult, ProviderAdapter, SupportedOperation } from "../adapterTypes";
import { RETRYABLE_ON_ANOTHER_PROVIDER } from "../adapterTypes";
import { mapHttpError } from "../httpCall";
import type { ProviderAdapterCallInput, ProviderAdapterCallOutput, ProviderAdapterFn } from "../../tregAdapter";

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
