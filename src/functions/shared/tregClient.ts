import { peekProviderKey, reportProviderHttpStatus, resolveProviderKey } from "../../lib/server/providerKeys";
export interface TregCallOptions {
  baseUrl?: string;
  token?: string;
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
export async function executeTregCall(options: TregCallOptions): Promise<TregCallResult> {
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
    };
  }

  const latencyMs = Date.now() - startTime;
  if (resolvedKey) reportProviderHttpStatus("treg", response.status, resolvedKey.source);
  const costMicro = parseInt(response.headers.get("x-treg-cost-micro") || "0", 10);
  const tregCallId = response.headers.get("x-treg-call-id") || "";

  console.log(
    JSON.stringify({
      tag: "treg_call_timing",
      endpointId: options.endpointId,
      method,
      latencyMs,
      status: response.status,
      costMicro,
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
  };
}
