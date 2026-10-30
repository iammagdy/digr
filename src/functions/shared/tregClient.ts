import { peekProviderKey, reportProviderHttpStatus, resolveProviderKey } from "../../lib/server/providerKeys";
import { POOL_MAX_HOPS, getTregKeyPool, type KeyChoice } from "../../lib/server/tregKeyPool";
import { blockedEndpointReason } from "../../lib/treg/blockList";
import { categoryOf } from "../../lib/treg/dataPolicy";
import { JOB_BUDGET_ERROR_CODE, type JobCallBudget } from "../../lib/server/callBudget";
import type { RawCapture } from "../../lib/server/rawCapture";
export interface TregCallOptions {
  baseUrl?: string;
  /** An explicit key (tests, one-off tools): used as given; the key pool is bypassed. */
  token?: string;
  /**
   * The key this caller used before the TREG key pool existed (the Heroku worker's TREG_TOKEN). Used exactly like `token` while the pool's rollout switch is OFF or the pool
   * cannot be read (it is then the main key); with the switch ON the pool's active key is used instead.
   */
  legacyToken?: string;
  endpointId: string;
  method?: "GET" | "POST";
  params?: Record<string, any>;
  allowedParamKeys?: string[];
  userId: string;
  jobId: string;
  stepId?: string;
  page?: number;
  routeMaxCostUsd?: string | number;
  idempotencyKey?: string;
  testScenario?: string;
  /** Give up on this one call after this long, so a slow source cannot outlast the worker's own time limit. */
  timeoutMs?: number;
  /** The catalog's own scope of the endpoint when the caller knows it («own_account» is never called). */
  endpointScope?: string | null;
  /** The job's USD budget, asked BEFORE this call (and before every retry): a call that would pass it is not made. */
  callBudget?: JobCallBudget;
  /** What this one call may cost, for the budget above (the catalog price of the call); defaults to the route's cost cap. */
  callEstimateUsd?: number;
  /**
   * Set ONLY by `runSensitiveCall` (src/lib/server/sensitiveAccess.ts) after the account, the purpose, the daily limit and the audit row were checked. An endpoint of the
   * SENSITIVE data category (data/treg/data_policy.json) is never sent a request without it, whoever calls.
   */
  sensitiveAccess?: { allowed: true };
  /** Receives the RAW answer of the call (flag RAW_FIRST_PAGE_CAPTURE, set by the worker for the first chunk): never affects the call. */
  rawCapture?: RawCapture;
  /** For a routed waterfall endpoint (see NO_WATERFALL_ENDPOINTS): false sends `X-Treg-Route-Waterfall: 0`, so only one provider is tried and billed. */
  routeWaterfall?: boolean;
}

export interface TregCallResult {
  ok: boolean;
  httpStatus: number;
  tregCallId: string;
  costMicro: number;
  latencyMs: number;
  data: any;
  error?: string;
  errorDetails?: string;
  detail?: string;
  isRouteMaxCost: boolean;
  isPlatformBalanceLow: boolean;
  /** The call was cut by OUR time limit: the source may have answered (and billed) after we stopped waiting. */
  timedOut?: boolean;
  /** What the FIRST call of an idempotent replay cost (header `X-Treg-Original-Cost-Micro`); a replay itself reports 0. */
  originalCostMicro?: number;
  /** TREG reported no charge for this answered call: `costMicro` is the call's catalog price estimate, and the record must say so. */
  costIsEstimate?: boolean;
  /** The charge the answer itself reported (`_treg.charged_micro`, routed calls), when it did. */
  chargedMicroReported?: number;
  /** The call was NOT made: the endpoint is on the hard block list (never callable) ... */
  blocked?: string;
  /** ... or the job's USD budget would have been passed. */
  budgetStopped?: boolean;
  /** The pool key that answered this call (number and label for the call log; never the key). Absent while the key pool's switch is OFF. */
  keyRef?: { id: string; number: number; label: string; isMain: boolean };
}

/**
 * Sanitize an error detail string: strip tokens, secrets, long hex hashes, and trim to 300 chars.
 */
export function sanitizeTregDetail(rawMsg: string, knownSecret?: string): string {
  if (!rawMsg) return "";

  let sanitized = rawMsg
    .replace(/Bearer\s+[a-zA-Z0-9_\-\.]+/gi, "Bearer [REDACTED]")
    .replace(/treg_[a-zA-Z0-9_\-]+/gi, "[REDACTED]")
    .replace(/sk-[a-zA-Z0-9_\-]+/gi, "[REDACTED]")
    .replace(/[a-f0-9]{32,64}/gi, "[REDACTED]");

  if (knownSecret && knownSecret.trim().length > 4) {
    sanitized = sanitized.split(knownSecret.trim()).join("[REDACTED]");
  }

  const resolvedToken = peekProviderKey("treg");
  if (resolvedToken && resolvedToken.trim().length > 4) {
    sanitized = sanitized.split(resolvedToken.trim()).join("[REDACTED]");
  }
  // every pool key this process holds decrypted (the one that answered may not be the active one any more)
  for (const held of getTregKeyPool()?.knownKeys() ?? []) sanitized = sanitized.split(held.trim()).join("[REDACTED]");

  return sanitized.trim().slice(0, 300);
}

export const SENSITIVE_INTERNAL_CONTROL_KEYS: ReadonlySet<string> = new Set([
  "exclusionrules",
  "exclusionfile",
  "exclusionbaseline",
  "companynames",
  "corporatedomains",
  "normalizedentities",
  "brandfingerprints",
  "baselinerowcount",
  "baselinerecords",
  "filename",
  "audittrail",
  "deduplicationaudit",
  "testscenario",
  "contextdata",
  "stepresults",
  "targetrequested",
  "requiredcontactfields",
  "deliverableformats",
]);

/**
 * Strictly serializes parameters intended for external data providers.
 * Strips internal control metadata, exclusion lists, and baseline entities.
 */
export function serializeProviderParams(
  rawParams: Record<string, any>,
  allowedParamKeys?: string[]
): Record<string, any> {
  const allowedSet =
    allowedParamKeys && allowedParamKeys.length > 0
      ? new Set(allowedParamKeys.map((k) => k.toLowerCase()))
      : null;

  const clean: Record<string, any> = {};

  for (const [key, val] of Object.entries(rawParams || {})) {
    const lowerKey = key.toLowerCase();

    // 1. Strictly block any known internal research control keys
    if (
      SENSITIVE_INTERNAL_CONTROL_KEYS.has(lowerKey) ||
      lowerKey.startsWith("internal_") ||
      lowerKey.startsWith("_")
    ) {
      continue;
    }

    // 2. The live endpoint schema is authoritative, including for pagination.
    // Generic plans sometimes include `offset` even when the provider does
    // not support it; never exempt pagination keys from a known allowlist.
    if (allowedSet && !allowedSet.has(lowerKey)) {
      continue;
    }

    // 3. Skip undefined, null, or empty string values
    if (val === undefined || val === null || val === "") {
      continue;
    }

    clean[key] = val;
  }

  return clean;
}

/**
 * Client for executing upstream TREG API calls matching https://treg.to/integrate.md & https://treg.to/llms.txt:
 * - URL: https://treg.to/call/<endpoint-id>
 * - Auth: X-Treg-Token
 * - Cost cap: X-Treg-Route-Max-Cost (USD, default 0.05)
 * - Metadata tag: X-Treg-Meta comma-separated key=value pairs (letters, digits, . _ - : only, <=128 chars)
 * - Retry key: Idempotency-Key job_{jobId}_step_{stepId}_p{page}
 * - Settled cost: X-Treg-Cost-Micro (integer micro-USD)
 */
/**
 * One gateway call, behind two hard gates that run in code before any request leaves:
 *  1. the block list (`blockedEndpointReason`): a write action, an own-account endpoint or an endpoint outside the sellable catalog is never called;
 *  1b. the SENSITIVE data category (personal contact, reverse lookups, advertising ids, personality): refused unless `options.sensitiveAccess` was set by the audited path;
 *  2. the job's USD budget (`options.callBudget`): a call that would pass it is not made, and the same check runs again for every retry.
 * A refused call costs nothing and carries `blocked` / `budgetStopped` so the caller can end the collection and settle on what it has.
 */
export async function executeTregCall(options: TregCallOptions): Promise<TregCallResult> {
  const blocked = blockedEndpointReason(options.endpointId, options.endpointScope);
  if (blocked) {
    console.warn(JSON.stringify({ tag: "treg_call_blocked", endpointId: options.endpointId, reason: blocked }));
    return refusedCall({ error: "endpoint_blocked", httpStatus: 403, blocked });
  }
  if (categoryOf(options.endpointId) === "sensitive" && options.sensitiveAccess?.allowed !== true) {
    console.warn(JSON.stringify({ tag: "treg_call_blocked", endpointId: options.endpointId, reason: "sensitive_not_allowed" }));
    return refusedCall({ error: "endpoint_blocked", httpStatus: 403, blocked: "sensitive_not_allowed" });
  }
  const budget = options.callBudget;
  const cap = Number(options.routeMaxCostUsd);
  const estimate = Math.max(0, Number.isFinite(Number(options.callEstimateUsd)) && options.callEstimateUsd !== undefined ? Number(options.callEstimateUsd) : Number.isFinite(cap) && cap > 0 ? cap : 0.05);
  if (budget && !budget.reserve(estimate)) {
    console.warn(JSON.stringify({ tag: "treg_call_budget_stop", endpointId: options.endpointId, spentUsd: Number(budget.spentUsd().toFixed(6)), ceilingUsd: budget.ceilingUsd, estimateUsd: estimate }));
    return refusedCall({ error: JOB_BUDGET_ERROR_CODE, httpStatus: 0, budgetStopped: true });
  }
  let result: TregCallResult;
  try {
    result = await executeWithKeyPool(options);
  } catch (err) {
    budget?.settle(estimate, null);
    throw err;
  }
  if (budget) {
    // A cut or unreachable call may have been billed after we stopped waiting: its estimate stays counted. Any answer carries its own cost (0 for a refusal).
    const unknown = result.timedOut === true || result.error === "network_failure";
    budget.settle(estimate, unknown ? null : Math.max(0, result.costMicro || 0) / 1_000_000);
  }
  return result;
}

/**
 * One call with the key the pool chooses. Without a pool (offline tests, nothing configured), with an explicit `token`, or with the rollout switch OFF this is the
 * single attempt it always was (the worker's TREG_TOKEN travels as `legacyToken`). With the switch ON, a failure that is the KEY's (revoked, or out of balance, verified
 * first) moves the active key to the next one of the chain and retries the same call on it (same idempotency key; such a call was not billed), at most three times,
 * the last always on the main key.
 */
async function executeWithKeyPool(options: TregCallOptions): Promise<TregCallResult> {
  const pool = options.token ? null : getTregKeyPool();
  const single = (token: string | undefined) => executeTregCallUnguarded(token ? { ...options, token } : options);
  if (!pool) return single(options.token ? undefined : options.legacyToken);
  let choice: KeyChoice = await pool.choose(options.legacyToken);
  const attempt = (c: KeyChoice) => single(c.key ?? options.legacyToken);
  let result = await attempt(choice);
  for (let hop = 0; hop < POOL_MAX_HOPS; hop++) {
    const next = await pool.afterCall(choice, result, { forceMain: hop === POOL_MAX_HOPS - 1, endpointId: options.endpointId });
    if (!next) break;
    choice = next;
    result = await attempt(choice);
  }
  if (choice.mode === "pool" && choice.ref) {
    result.keyRef = { ...choice.ref };
    pool.noteUse(options.jobId, choice.ref);
  }
  return result;
}

function refusedCall(input: { error: string; httpStatus: number; blocked?: string; budgetStopped?: boolean }): TregCallResult {
  return {
    ok: false,
    httpStatus: input.httpStatus,
    tregCallId: "",
    costMicro: 0,
    latencyMs: 0,
    data: null,
    error: input.error,
    isRouteMaxCost: false,
    isPlatformBalanceLow: false,
    ...(input.blocked ? { blocked: input.blocked } : {}),
    ...(input.budgetStopped ? { budgetStopped: true } : {}),
  };
}

async function executeTregCallUnguarded(options: TregCallOptions): Promise<TregCallResult> {
  const baseUrl = (
    options.baseUrl ||
    process.env.TREG_BASE_URL ||
    "https://treg.to"
  ).replace(/\/$/, "");

  // One shared resolver: encrypted store first (30 s cache), then the environment variable.
  const resolvedKey = options.token ? null : await resolveProviderKey("treg");
  const token = options.token || resolvedKey?.key || "";

  // Clean and map params (strictly strip internal control metadata)
  const cleanParams: Record<string, any> = serializeProviderParams(options.params || {}, options.allowedParamKeys);
  if (options.endpointId === "tikhub.tiktok.user.profile") {
    if (cleanParams.username && !cleanParams.uniqueId) {
      cleanParams.uniqueId = cleanParams.username;
      delete cleanParams.username;
    }
    if (cleanParams.uniqueId && typeof cleanParams.uniqueId === "string") {
      cleanParams.uniqueId = cleanParams.uniqueId.replace(/^@/, "");
    }
  }

  const costCapUsd = options.routeMaxCostUsd !== undefined
    ? String(options.routeMaxCostUsd)
    : "0.05";

  const stepId = options.stepId || "step_1";
  const page = options.page || 1;
  const idemKey = options.idempotencyKey || `job_${options.jobId}_step_${stepId}_p${page}`;

  // Build X-Treg-Meta as comma-separated key=value pairs matching https://treg.to/integrate.md
  // Values: letters, digits, and . _ - : only, <= 128 chars, no email
  const sanitizeMeta = (val: string) =>
    String(val || "unknown")
      .replace(/@/g, "_at_")
      .replace(/[^a-zA-Z0-9._\-:]/g, "_")
      .slice(0, 128) || "unknown";

  const metaParts: string[] = [];
  if (options.userId) {
    metaParts.push(`customer=${sanitizeMeta(options.userId)}`);
  }
  if (options.jobId) {
    metaParts.push(`job=${sanitizeMeta(options.jobId)}`);
  }
  if (stepId) {
    metaParts.push(`step=${sanitizeMeta(stepId)}`);
  }
  const metaHeader = metaParts.join(", ");

  let targetUrl = `${baseUrl}/call/${options.endpointId}`;
  const headers: Record<string, string> = {
    "X-Treg-Token": token,
    "X-Treg-Route-Max-Cost": costCapUsd,
    "Idempotency-Key": idemKey,
  };

  if (metaHeader) {
    headers["X-Treg-Meta"] = metaHeader;
  }
  if (options.routeWaterfall === false) {
    headers["X-Treg-Route-Waterfall"] = "0";
  }

  // Only pass test scenario header when running against local fake server
  if (options.testScenario && targetUrl.includes("127.0.0.1")) {
    headers["X-Test-Scenario"] = options.testScenario;
  }

  const method = (
    options.method ||
    (options.endpointId === "tikhub.tiktok.user.profile" ? "GET" : "POST")
  ).toUpperCase() as "GET" | "POST";

  let requestBody: string | undefined = undefined;

  if (method === "GET") {
    const searchParams = new URLSearchParams();
    for (const [k, v] of Object.entries(cleanParams)) {
      if (v !== undefined && v !== null && v !== "") {
        searchParams.append(k, String(v));
      }
    }
    const qs = searchParams.toString();
    if (qs) {
      targetUrl += (targetUrl.includes("?") ? "&" : "?") + qs;
    }
  } else {
    headers["Content-Type"] = "application/json";
    requestBody = JSON.stringify(cleanParams);
  }

  const startTime = Date.now();
  let response: Response;

  try {
    response = await fetch(targetUrl, {
      method,
      headers,
      body: requestBody,
      signal:
        options.timeoutMs && options.timeoutMs > 0 && typeof AbortSignal !== "undefined" && AbortSignal.timeout
          ? AbortSignal.timeout(options.timeoutMs)
          : undefined,
    });
  } catch (netErr: any) {
    const errorMsg = sanitizeTregDetail(netErr.message || "Failed to reach data provider", token);
    return {
      ok: false,
      httpStatus: 503,
      tregCallId: `err_${Date.now()}`,
      costMicro: 0,
      latencyMs: Date.now() - startTime,
      data: null,
      error: "network_failure",
      errorDetails: errorMsg,
      detail: errorMsg,
      isRouteMaxCost: false,
      isPlatformBalanceLow: false,
      // AbortSignal.timeout rejects with a TimeoutError (a manual abort with an AbortError): either way we stopped waiting.
      timedOut: netErr?.name === "TimeoutError" || netErr?.name === "AbortError",
    };
  }

  const latencyMs = Date.now() - startTime;
  if (resolvedKey) reportProviderHttpStatus("treg", response.status, resolvedKey.source);
  const headerCost = response.headers.get("x-treg-cost-micro");
  const headerMicro = headerCost === null ? null : (parseInt(headerCost || "0", 10) || 0);
  const originalCostMicro = parseInt(response.headers.get("x-treg-original-cost-micro") || "0", 10);
  const tregCallId = response.headers.get("x-treg-call-id") || "";

  console.log(
    JSON.stringify({
      tag: "treg_call_timing",
      endpointId: options.endpointId,
      method,
      latencyMs,
      status: response.status,
      costMicro: headerMicro ?? 0,
      tregCallId,
    })
  );

  let responseBody: any = null;
  let rawText = "";
  try {
    rawText = await response.text();
    try {
      responseBody = JSON.parse(rawText);
    } catch {
      responseBody = null;
    }
  } catch {
    rawText = "";
  }

  if (options.rawCapture) {
    try { await options.rawCapture({ endpointId: options.endpointId, httpStatus: response.status, page, body: responseBody ?? rawText }); } catch { /* a capture never changes a call */ }
  }

  // THE ACTUAL CHARGE, as TREG reports it: the cost header of a direct call; a routed call also reports `_treg.charged_micro` in its answer, which is used when the header is absent.
  // When TREG reports nothing at all for an answered call, the call's own catalog price estimate is recorded and the result is marked as an estimate. A header and an answer that
  // disagree are both kept visible: `chargedMicroReported` carries the answer's figure and the mismatch is logged for the owner (the header stays the figure the books use).
  const reportedInBody = responseBody?._treg?.charged_micro;
  const bodyMicro = typeof reportedInBody === "number" && Number.isFinite(reportedInBody) && reportedInBody >= 0 ? Math.round(reportedInBody) : null;
  const estimatedMicro = response.ok && options.callEstimateUsd !== undefined && Number(options.callEstimateUsd) > 0 ? Math.round(Number(options.callEstimateUsd) * 1_000_000) : 0;
  const costIsEstimate = bodyMicro === null && headerMicro === null && estimatedMicro > 0;
  const costMicro = headerMicro !== null ? headerMicro : bodyMicro !== null ? bodyMicro : costIsEstimate ? estimatedMicro : 0;
  if (bodyMicro !== null && headerMicro !== null && bodyMicro !== headerMicro) {
    console.warn(JSON.stringify({ tag: "treg_charge_mismatch", endpointId: options.endpointId, headerMicro, chargedMicroInAnswer: bodyMicro, tregCallId }));
  }

  const bodyError = responseBody?.error;
  const isRouteMaxCost = response.status === 402 && bodyError === "route_max_cost";
  const isPlatformBalanceLow = response.status === 402 && bodyError !== "route_max_cost";

  let rawDetail = "";
  if (!response.ok) {
    if (responseBody && typeof responseBody === "object") {
      if (typeof responseBody.detail === "string" && responseBody.detail.trim()) {
        rawDetail = responseBody.detail;
      } else if (responseBody.detail && typeof responseBody.detail === "object") {
        rawDetail = JSON.stringify(responseBody.detail);
      } else if (typeof responseBody.message === "string" && responseBody.message.trim()) {
        rawDetail = responseBody.message;
      } else if (typeof responseBody.error === "string" && responseBody.error.trim()) {
        rawDetail = responseBody.error;
      } else if (typeof responseBody.msg === "string" && responseBody.msg.trim()) {
        rawDetail = responseBody.msg;
      } else {
        rawDetail = JSON.stringify(responseBody);
      }
    } else if (rawText && rawText.trim()) {
      rawDetail = rawText.trim();
    } else {
      rawDetail = response.statusText || `http_${response.status}`;
    }
  }

  const sanitizedDetail = !response.ok ? sanitizeTregDetail(rawDetail, token) : undefined;

  if (!response.ok && response.status >= 400 && response.status < 500) {
    console.warn(JSON.stringify({
      tag: "treg_client_rejected",
      endpointId: options.endpointId,
      status: response.status,
      sentParamKeys: Object.keys(cleanParams).sort(),
      allowedParamKeys: options.allowedParamKeys?.slice().sort(),
      detail: sanitizedDetail,
    }));
  }

  return {
    ok: response.ok,
    httpStatus: response.status,
    tregCallId,
    costMicro,
    latencyMs,
    data: responseBody,
    error: bodyError || (response.ok ? undefined : `http_${response.status}`),
    errorDetails: sanitizedDetail,
    detail: sanitizedDetail,
    isRouteMaxCost,
    isPlatformBalanceLow,
    ...(Number.isFinite(originalCostMicro) && originalCostMicro > 0 ? { originalCostMicro } : {}),
    ...(costIsEstimate ? { costIsEstimate: true } : {}),
    ...(bodyMicro !== null ? { chargedMicroReported: bodyMicro } : {}),
  };
}
