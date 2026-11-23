import { peekProviderKey, reportProviderHttpStatus, resolveProviderKey } from "../../lib/server/providerKeys";
import { POOL_MAX_HOPS, getTregKeyPool, type KeyChoice } from "../../lib/server/tregKeyPool";
import { blockedEndpointReason } from "../../lib/treg/blockList";
import { categoryOf } from "../../lib/treg/dataPolicy";
import { JOB_BUDGET_ERROR_CODE, callMoney, type JobCallBudget } from "../../lib/server/callBudget";
import { classifyTregCharge } from "../../lib/server/tregCharge";
import type { RawCapture } from "../../lib/server/rawCapture";
import { getCircuitBreaker, getControlProbeRequest, type EndpointCircuitBreaker } from "../../lib/treg/circuitBreaker";
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
  /** DT-20261119-11: make ONE request only, never a key-pool hop (the money of the call was reserved for one). */
  singleAttempt?: boolean;
  /** DT-20261119-11 D1: the header is the money the `callBudget` has left, held in one step before the request (per request, over the requests the call can make); the call is refused (budgetStopped) when no amount that covers `callEstimateUsd` is left. */
  headerFromBudget?: boolean;
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
  /** Optional sleeper for deterministic testing of backoff / Retry-After delays. */
  sleep?: (ms: number) => Promise<void>;
  /** Marked true when executing a minimal documented control request to diagnose a 400. */
  isControlProbe?: boolean;
  /** Skip running control probe on 400. */
  skipControlProbe?: boolean;
  /** Circuit breaker instance to record to or query. */
  circuitBreaker?: EndpointCircuitBreaker;
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
  /** For a 402 (not a price cap), set by the key pool after the free balance read: «endpoint» = the key's balance is fine and this source refused payment by itself; «key» = a confirmed low balance. */
  paymentScope?: "key" | "endpoint" | "unconfirmed";
  /** The call was cut by OUR time limit: the source may have answered (and billed) after we stopped waiting. */
  timedOut?: boolean;
  /** What the FIRST call of an idempotent replay cost (header `X-Treg-Original-Cost-Micro`); a replay itself reports 0. */
  originalCostMicro?: number;
  /** TREG reported no charge for this answered call: `costMicro` is the call's catalog price estimate, and the record must say so. */
  costIsEstimate?: boolean;
  /** The charge the answer itself reported (`_treg.charged_micro`, routed calls), when it did. */
  chargedMicroReported?: number;
  /** TREG's answer reported NO charge (no header, no `_treg.charged_micro`) and there is no estimate: `costMicro` is a placeholder 0, not a reported zero. */
  costUnreported?: boolean;
  /** costHeaderInvalid: the cost header was present but is not a plain non-negative integer, so costMicro is not a report. Absent for a well-formed or absent header. */
  costHeaderInvalid?: true;
  /** The call was NOT made: the endpoint is on the hard block list (never callable) ... */
  blocked?: string;
  /** ... or the job's USD budget would have been passed. */
  budgetStopped?: boolean;
  /** The pool key that answered this call (number and label for the call log; never the key). Absent while the key pool's switch is OFF. */
  keyRef?: { id: string; number: number; label: string; isMain: boolean };
  /** Test/fixture adapter opt-in: allows legacy array envelope compatibility when declared list is absent. */
  allowLegacyEnvelope?: boolean;
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

const objectOf = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const capValueIn = (places: ReadonlyArray<Record<string, unknown>>, key: "max_cost_micro" | "estimated_cost_micro"): number | null => {
  for (const o of places) {
    const v = o[key];
    const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN;
    if (Number.isFinite(n)) return n;
  }
  return null;
};

/**
 * Whether a 402 answer is TREG's PRICE-CAP refusal (the call's reserve is above our `X-Treg-Route-Max-Cost`; nothing was charged and the balance has nothing to do with it), by STRUCTURE, never by a word list. A balance or payment
 * refusal is never taken for one (DT-20261119-09, فزاع's pre-push): the key pool must still check the key and recover on a funded standby.
 *  1. an explicit code other than `route_max_cost` (`insufficient_balance`, `payment_required`, …) ALWAYS wins: not a price cap, whatever fields travel with it;
 *  2. the code `route_max_cost` (top level, in a `detail` object, in a JSON string or object under `detail` / `error`, in an `error` object): a price cap;
 *  3. no code at all: the fields decide: `estimated_cost_micro` with `max_cost_micro` is a cap only when the reserve is ABOVE the cap; `estimated_cost_micro` alone (the shape seen live 2026-11-19) is a cap; `max_cost_micro` alone is not.
 * A JSON string under `detail` or `error` is a CONTAINER (its fields are read), never itself a code.
 */
export function isRouteMaxCostBody(body: unknown): boolean {
  const root = objectOf(body);
  if (!root) return false;
  const places: Array<Record<string, unknown>> = [root];
  const containerStrings = new Set<string>();
  for (const v of [root.detail, root.error]) {
    const o = objectOf(v);
    if (o) { places.push(o); continue; }
    if (typeof v === "string" && v.trim().startsWith("{")) {
      try { const parsed = objectOf(JSON.parse(v)); if (parsed) { places.push(parsed); containerStrings.add(v); } } catch { /* not JSON: no fields to read */ }
    }
  }
  const codes = places.flatMap((o) => [o.error, o.code]).filter((c): c is string => typeof c === "string" && c.trim() !== "" && !containerStrings.has(c));
  if (codes.some((c) => c !== "route_max_cost")) return false;
  if (codes.includes("route_max_cost")) return true;
  const max = capValueIn(places, "max_cost_micro");
  const estimated = capValueIn(places, "estimated_cost_micro");
  if (estimated !== null && max !== null) return estimated > max;
  return estimated !== null;
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
function getStepAttempts(budget: JobCallBudget): Map<string, number> {
  let map = (budget as any)._stepAttempts as Map<string, number> | undefined;
  if (!map) {
    map = new Map<string, number>();
    (budget as any)._stepAttempts = map;
  }
  return map;
}

export function resetStepAttempts(): void {
  // Retained for test utility compatibility
}

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
  // Per Rule 1 (الكبير): attempt cap strictly applies ONLY when options.callBudget is present.
  // When no budget is passed, today's behavior holds (no cap refusal).
  // Per Rule 2: attempt count lives with the job's own budget object (never process-wide).
  const stepKey = (budget && options.jobId && options.stepId) ? `${options.jobId}:${options.stepId}:${options.page ?? 1}` : null;
  if (stepKey && budget) {
    const attemptsMap = getStepAttempts(budget);
    const current = attemptsMap.get(stepKey) ?? 0;
    if (current >= 4) {
      console.warn(JSON.stringify({ tag: "treg_call_step_limit", endpointId: options.endpointId, stepKey, attempts: current }));
      return refusedCall({ error: JOB_BUDGET_ERROR_CODE, httpStatus: 0, budgetStopped: true });
    }
  }

  const cap = Number(options.routeMaxCostUsd);
  let estimate = Math.max(0, Number.isFinite(Number(options.callEstimateUsd)) && options.callEstimateUsd !== undefined ? Number(options.callEstimateUsd) : Number.isFinite(cap) && cap > 0 ? cap : 0.05);
  // DT-20261119-11 D1/D2: the header IS the money the budget has left (whole micro-dollars, rounded down), held in ONE step before the request and kept for a call whose charge is unknown; no positive amount that covers the estimate, no request
  let wire: TregCallOptions = options;
  const left = budget && options.headerFromBudget === true ? budget.leftUsd(0) : null;
  if (budget && left !== null) {
    const money = callMoney(left, estimate, maxTregAttempts(options));
    if (money && budget.reserve(money.holdUsd)) {
      estimate = money.holdUsd;
      wire = { ...options, routeMaxCostUsd: money.perRequestUsd, ...(money.attempts === 1 ? { singleAttempt: true } : {}) };
    } else {
      budget.reserve(Number.MAX_SAFE_INTEGER); // the refusal is counted like any other budget stop
      console.warn(JSON.stringify({ tag: "treg_call_budget_stop", endpointId: options.endpointId, spentUsd: Number(budget.spentUsd().toFixed(6)), ceilingUsd: budget.ceilingUsd, estimateUsd: estimate }));
      return refusedCall({ error: JOB_BUDGET_ERROR_CODE, httpStatus: 0, budgetStopped: true });
    }
  } else if (budget && !budget.reserve(estimate)) {
    console.warn(JSON.stringify({ tag: "treg_call_budget_stop", endpointId: options.endpointId, spentUsd: Number(budget.spentUsd().toFixed(6)), ceilingUsd: budget.ceilingUsd, estimateUsd: estimate }));
    return refusedCall({ error: JOB_BUDGET_ERROR_CODE, httpStatus: 0, budgetStopped: true });
  }
  let result: TregCallResult;
  try {
    result = await executeWithKeyPool(wire);
  } catch (err) {
    budget?.settle(estimate, null);
    throw err;
  }
  if (budget) {
    // A cut or unreachable call may have been billed after we stopped waiting: its estimate stays counted. Any answer carries its own cost (0 for a refusal).
    // (DT-20261119-11 F3) one shared reading of the charge: a reported charge wins (also on a failure), a documented free refusal is zero, anything uncertain keeps the reservation
    const charge = classifyTregCharge(result);
    budget.settle(estimate, charge.known ? charge.usd : null);
  }

  const cb = options.circuitBreaker ?? getCircuitBreaker();
  if (result.ok) {
    cb.recordSuccess(options.endpointId);
  } else if (result.httpStatus !== 409) {
    // 409 is «still running» (in-flight polling), not a failure and not a circuit failure
    if (result.httpStatus === 400 && !options.isControlProbe && !options.skipControlProbe) {
      const probeReq = getControlProbeRequest(options.endpointId);
      if (probeReq) {
        let canProbe = true;
        if (stepKey && budget) {
          const attemptsMap = getStepAttempts(budget);
          if ((attemptsMap.get(stepKey) ?? 0) >= 4) {
            canProbe = false;
          }
        }
        if (budget && !budget.reserve(estimate)) {
          canProbe = false;
        }
        if (canProbe) {
          try {
            const probeResult = await executeTregCallUnguarded({
              ...options,
              isControlProbe: true,
              method: probeReq.method,
              params: probeReq.params,
              singleAttempt: true,
              callBudget: undefined,
            });
            if (budget) {
              const probeCharge = classifyTregCharge(probeResult);
              budget.settle(estimate, probeCharge.known ? probeCharge.usd : null);
            }
            if (!probeResult.ok && probeResult.httpStatus === 400) {
              // Control probe failed with 400: provider itself is broken, trip circuit immediately
              cb.recordFailure(options.endpointId, 400, true);
            } else {
              // Control probe succeeded or returned other status: original query was invalid
              cb.recordFailure(options.endpointId, 400, false);
            }
          } catch {
            if (budget) budget.settle(estimate, null);
            cb.recordFailure(options.endpointId, 400, false);
          }
        } else {
          cb.recordFailure(options.endpointId, 400, false);
        }
      } else {
        cb.recordFailure(options.endpointId, 400, false);
      }
    } else {
      cb.recordFailure(options.endpointId, result.httpStatus, options.isControlProbe);
    }
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
  for (let hop = 0; hop < (options.singleAttempt ? 0 : POOL_MAX_HOPS); hop++) {
    const next = await pool.afterCall(choice, result, { forceMain: hop === POOL_MAX_HOPS - 1, endpointId: options.endpointId });
    if (!next) break;
    // DT-20261119-11 F3: a hop is made ONLY after a VERIFIED zero, so the last answer is the whole charge of the call; an earlier attempt that charged, or whose charge is not known, is never dropped (no hop: the call ends here and keeps its hold)
    const earlier = classifyTregCharge(result);
    if (!earlier.known || earlier.usd > 0) break;
    choice = next;
    result = await attempt(choice);
  }
  if (choice.mode === "pool" && choice.ref) {
    result.keyRef = { ...choice.ref };
    pool.noteUse(options.jobId, choice.ref);
  }
  return result;
}

/** The most requests ONE call of this client can send: one, or the call and every hop of the key pool (DT-20261119-11 D1: the money a call may take is reserved for each of them). */
export function maxTregAttempts(options: { token?: string; singleAttempt?: boolean }): number {
  return options.token || options.singleAttempt ? 1 : getTregKeyPool() ? 1 + POOL_MAX_HOPS : 1;
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

export function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  const sec = parseInt(trimmed, 10);
  if (!Number.isNaN(sec) && sec >= 0) return sec;
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    const diffSec = Math.ceil((dateMs - Date.now()) / 1000);
    return diffSec >= 0 ? diffSec : 0;
  }
  return null;
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
    "X-Treg-Idempotency-Key": idemKey,
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
  let response: Response | null = null;
  let lastNetErr: any = null;
  const sleepFn = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  // Standalone callers without budget or step id perform bounded 5xx retries; outer runners manage their own retries
  const max5xxRetries = (options.callBudget || options.stepId || options.singleAttempt) ? 0 : 2;
  let attempt = 0;
  let retried429 = false;

  const stepKey = (options.callBudget && options.jobId && options.stepId) ? `${options.jobId}:${options.stepId}:${options.page ?? 1}` : null;

  while (attempt <= max5xxRetries) {
    if (stepKey && options.callBudget) {
      const attemptsMap = getStepAttempts(options.callBudget);
      const cur = attemptsMap.get(stepKey) ?? 0;
      if (cur >= 4) {
        return {
          ok: false,
          httpStatus: 0,
          tregCallId: `err_${Date.now()}`,
          costMicro: 0,
          latencyMs: Date.now() - startTime,
          data: null,
          error: JOB_BUDGET_ERROR_CODE,
          budgetStopped: true,
          isRouteMaxCost: false,
          isPlatformBalanceLow: false,
        };
      }
      attemptsMap.set(stepKey, cur + 1);
    }

    lastNetErr = null;
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

      // HTTP 429 with Retry-After (delay and retry once if <= 10 seconds)
      if (response.status === 429 && !retried429) {
        const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
        if (retryAfter !== null && retryAfter <= 10) {
          if (stepKey && options.callBudget) {
            const attemptsMap = getStepAttempts(options.callBudget);
            if ((attemptsMap.get(stepKey) ?? 0) >= 4) {
              break;
            }
          }
          if (options.callBudget) {
            const est = Math.max(0, Number.isFinite(Number(options.callEstimateUsd)) ? Number(options.callEstimateUsd) : 0.05);
            // Settle first 429 call at 0
            options.callBudget.settle(est, 0);
            if (!options.callBudget.reserve(est)) {
              return {
                ok: false,
                httpStatus: 429,
                tregCallId: `err_${Date.now()}`,
                costMicro: 0,
                latencyMs: Date.now() - startTime,
                data: null,
                error: JOB_BUDGET_ERROR_CODE,
                budgetStopped: true,
                isRouteMaxCost: false,
                isPlatformBalanceLow: false,
              };
            }
          }
          retried429 = true;
          await sleepFn(Math.max(50, retryAfter * 1000));
          continue;
        }
      }

      // Transient 5xx (502, 503, 504): retry with exponential backoff for standalone callers
      const isTransient5xx = response.status === 502 || response.status === 503 || response.status === 504;
      if (isTransient5xx && attempt < max5xxRetries) {
        attempt++;
        const backoffMs = Math.min(1000, 100 * Math.pow(2, attempt)) + Math.floor(Math.random() * 50);
        await sleepFn(backoffMs);
        continue;
      }

      break;
    } catch (netErr: any) {
      lastNetErr = netErr;
      if (attempt < max5xxRetries) {
        attempt++;
        const backoffMs = Math.min(1000, 100 * Math.pow(2, attempt)) + Math.floor(Math.random() * 50);
        await sleepFn(backoffMs);
        continue;
      }
      break;
    }
  }

  if (!response) {
    const errorMsg = sanitizeTregDetail(lastNetErr?.message || "Failed to reach data provider", token);
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
      timedOut: lastNetErr?.name === "TimeoutError" || lastNetErr?.name === "AbortError",
    };
  }

  const latencyMs = Date.now() - startTime;
  if (resolvedKey) reportProviderHttpStatus("treg", response.status, resolvedKey.source);
  const headerCost = response.headers.get("x-treg-cost-micro");
  const headerMicro = headerCost === null ? null : (parseInt(headerCost || "0", 10) || 0);
  const costHeaderInvalid = headerCost !== null && !/^\d+$/.test(headerCost.trim());
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

  const isBusinessError = Boolean(
    response.ok &&
    responseBody &&
    typeof responseBody === "object" &&
    !Array.isArray(responseBody) &&
    (
      (typeof responseBody.error === "string" && responseBody.error.trim().length > 0) ||
      (typeof responseBody.code === "number" && responseBody.code >= 400) ||
      (typeof responseBody.status_code === "number" && responseBody.status_code >= 400)
    )
  );

  const effectiveOk = response.ok && !isBusinessError;
  const effectiveStatus = isBusinessError
    ? (typeof responseBody.code === "number" ? responseBody.code : typeof responseBody.status_code === "number" ? responseBody.status_code : 400)
    : response.status;
  const rawBusinessError = isBusinessError ? (responseBody.error || responseBody.message || "provider_business_error") : undefined;

  const bodyError = responseBody?.error;
  // DT-20261119-09 (F2): TREG's price-cap refusal is read wherever its fields sit (top level, inside a `detail` object or a JSON `detail` string): live 2026-11-19 six of them were read as «platform balance low» and traced «endpoint_payment_refused»
  const isRouteMaxCost = response.status === 402 && isRouteMaxCostBody(responseBody);
  const isPlatformBalanceLow = response.status === 402 && !isRouteMaxCost;

  let rawDetail = "";
  if (!effectiveOk) {
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

  const sanitizedDetail = !effectiveOk ? sanitizeTregDetail(rawDetail, token) : undefined;

  if (!effectiveOk && effectiveStatus >= 400 && effectiveStatus < 500) {
    console.warn(JSON.stringify({
      tag: "treg_client_rejected",
      endpointId: options.endpointId,
      status: effectiveStatus,
      sentParamKeys: Object.keys(cleanParams).sort(),
      allowedParamKeys: options.allowedParamKeys?.slice().sort(),
      detail: sanitizedDetail,
    }));
  }

  return {
    ok: effectiveOk,
    httpStatus: effectiveStatus,
    tregCallId,
    costMicro,
    latencyMs,
    data: responseBody,
    error: typeof bodyError === "string" && bodyError ? bodyError : isRouteMaxCost ? "route_max_cost" : rawBusinessError || bodyError || (effectiveOk ? undefined : `http_${effectiveStatus}`),
    errorDetails: sanitizedDetail,
    detail: sanitizedDetail,
    isRouteMaxCost,
    isPlatformBalanceLow,
    ...(Number.isFinite(originalCostMicro) && originalCostMicro > 0 ? { originalCostMicro } : {}),
    ...(costIsEstimate ? { costIsEstimate: true } : {}),
    ...(bodyMicro !== null ? { chargedMicroReported: bodyMicro } : {}),
    // an answer that carries NO charge at all (no cost header, no `_treg.charged_micro`, no estimate): `costMicro` above is a placeholder 0, not a report (the spend gate settles it UNKNOWN)
    ...(headerMicro === null && bodyMicro === null && !costIsEstimate ? { costUnreported: true } : {}),
    ...(costHeaderInvalid ? { costHeaderInvalid: true as const } : {}),
  };
}

export async function executeControlProbe(
  endpointId: string,
  options?: Partial<TregCallOptions>
): Promise<TregCallResult> {
  const probeReq = getControlProbeRequest(endpointId);
  return executeTregCallUnguarded({
    endpointId,
    userId: options?.userId || "system_probe",
    jobId: options?.jobId || "probe_job",
    isControlProbe: true,
    singleAttempt: true,
    method: probeReq?.method || "GET",
    params: probeReq?.params || {},
    ...options,
  });
}
