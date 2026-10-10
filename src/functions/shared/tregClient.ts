export interface TregCallOptions {
  baseUrl?: string;
  token?: string;
  endpointId: string;
  method: "GET" | "POST";
  params?: Record<string, any>;
  userId: string;
  jobId: string;
  routeMaxCostUsd?: string | number;
  idempotencyKey?: string;
  testScenario?: string;
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
  isRouteMaxCost: boolean;
  isPlatformBalanceLow: boolean;
}

/**
 * Client for executing upstream TREG API calls matching https://treg.to/integrate.md & https://treg.to/llms.txt:
 * - URL: https://treg.to/call/<endpoint-id>
 * - Auth: X-Treg-Token
 * - Cost cap: X-Treg-Route-Max-Cost (USD, default 0.05)
 * - Metadata tag: X-Treg-Meta (customer=USERID, job=JOBID)
 * - Retry key: Idempotency-Key
 * - Settled cost: X-Treg-Cost-Micro (integer micro-USD)
 */
export async function executeTregCall(options: TregCallOptions): Promise<TregCallResult> {
  const baseUrl = (
    options.baseUrl ||
    process.env.TREG_BASE_URL ||
    "https://treg.to"
  ).replace(/\/$/, "");

  const token =
    options.token ||
    process.env.TREG_TOKEN ||
    process.env.TREG_API_KEY ||
    "";

  // Clean and map params (e.g. username -> uniqueId for tikhub TikTok profile)
  const cleanParams: Record<string, any> = { ...(options.params || {}) };
  if (options.endpointId === "tikhub.tiktok.user.profile") {
    if (cleanParams.username && !cleanParams.uniqueId) {
      cleanParams.uniqueId = cleanParams.username;
      delete cleanParams.username;
    }
  }

  const costCapUsd = options.routeMaxCostUsd !== undefined
    ? String(options.routeMaxCostUsd)
    : "0.05";

  const idemKey = options.idempotencyKey || `idem_${options.jobId}`;

  let targetUrl = `${baseUrl}/call/${options.endpointId}`;
  const headers: Record<string, string> = {
    "X-Treg-Token": token,
    "X-Treg-Route-Max-Cost": costCapUsd,
    "X-Treg-Meta": `customer=${options.userId}, job=${options.jobId}`,
    "Idempotency-Key": idemKey,
  };

  // Only pass test scenario header when running against local fake server
  if (options.testScenario && targetUrl.includes("127.0.0.1")) {
    headers["X-Test-Scenario"] = options.testScenario;
  }

  let requestBody: string | undefined = undefined;

  if (options.method === "GET") {
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
      method: options.method,
      headers,
      body: requestBody,
    });
  } catch (netErr: any) {
    return {
      ok: false,
      httpStatus: 503,
      tregCallId: `err_${Date.now()}`,
      costMicro: 0,
      latencyMs: Date.now() - startTime,
      data: null,
      error: "network_failure",
      errorDetails: netErr.message || "Failed to reach data provider",
      isRouteMaxCost: false,
      isPlatformBalanceLow: false,
    };
  }

  const latencyMs = Date.now() - startTime;
  const costMicro = parseInt(response.headers.get("x-treg-cost-micro") || "0", 10);
  const tregCallId = response.headers.get("x-treg-call-id") || "";

  let responseBody: any = null;
  try {
    responseBody = await response.json();
  } catch {
    responseBody = null;
  }

  const bodyError = responseBody?.error;
  const isRouteMaxCost = response.status === 402 && bodyError === "route_max_cost";
  const isPlatformBalanceLow = response.status === 402 && bodyError !== "route_max_cost";

  return {
    ok: response.ok,
    httpStatus: response.status,
    tregCallId,
    costMicro,
    latencyMs,
    data: responseBody,
    error: bodyError || (response.ok ? undefined : `http_${response.status}`),
    errorDetails: responseBody?.message || (response.ok ? undefined : response.statusText),
    isRouteMaxCost,
    isPlatformBalanceLow,
  };
}
