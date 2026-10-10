export interface TregCallOptions {
  baseUrl?: string;
  apiKey?: string;
  endpointId: string;
  method: "GET" | "POST";
  params?: Record<string, any>;
  userId: string;
  jobId: string;
  maxCostMicro: number;
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
 * Client for executing upstream TREG API calls with mandatory white-label & tracking headers:
 * - Authorization: Bearer <TREG_API_KEY>
 * - Idempotency-Key: idem_<jobId>
 * - X-Treg-Max-Cost-Micro: <maxCostMicro>
 * - X-Treg-Tag: customer:<userId>
 */
export async function executeTregCall(options: TregCallOptions): Promise<TregCallResult> {
  const baseUrl = (
    options.baseUrl ||
    process.env.TREG_BASE_URL ||
    "https://api.treg.to"
  ).replace(/\/$/, "");

  const apiKey =
    options.apiKey ||
    process.env.TREG_API_KEY ||
    "treg_placeholder_key";

  const idemKey = `idem_${options.jobId}_${options.endpointId.replace(/[^a-zA-Z0-9]/g, "_")}`;
  const urlPath = `/v1/routes/${options.endpointId.replace(/\./g, "/")}`;
  
  if (options.testScenario && (!process.env.TREG_BASE_URL || !options.baseUrl || options.baseUrl.includes("api.treg.to"))) {
    const usernameParam = options.params?.username || "mock_user";
    if (options.testScenario === "route_max_cost") {
      return {
        ok: false,
        httpStatus: 402,
        tregCallId: `call_mock_cap_${Date.now()}`,
        costMicro: 0,
        latencyMs: 35,
        data: { error: "route_max_cost", message: "Estimated or actual cost exceeded route cost ceiling" },
        error: "route_max_cost",
        errorDetails: "Estimated or actual cost exceeded route cost ceiling",
        isRouteMaxCost: true,
        isPlatformBalanceLow: false,
      };
    }
    if (options.testScenario === "insufficient_balance") {
      return {
        ok: false,
        httpStatus: 402,
        tregCallId: `call_mock_bal_${Date.now()}`,
        costMicro: 0,
        latencyMs: 30,
        data: { error: "insufficient_balance", message: "Account credits exhausted" },
        error: "insufficient_balance",
        errorDetails: "Account credits exhausted",
        isRouteMaxCost: false,
        isPlatformBalanceLow: true,
      };
    }
    if (options.testScenario === "rate_limit") {
      return {
        ok: false,
        httpStatus: 429,
        tregCallId: `call_mock_429_${Date.now()}`,
        costMicro: 0,
        latencyMs: 20,
        data: { error: "rate_limit_exceeded" },
        error: "rate_limit_exceeded",
        isRouteMaxCost: false,
        isPlatformBalanceLow: false,
      };
    }
    if (options.testScenario === "upstream_error") {
      return {
        ok: false,
        httpStatus: 502,
        tregCallId: `call_mock_500_${Date.now()}`,
        costMicro: 0,
        latencyMs: 50,
        data: { error: "provider_unavailable" },
        error: "provider_unavailable",
        isRouteMaxCost: false,
        isPlatformBalanceLow: false,
      };
    }
    // Default test scenario (mock_ok / test):
    return {
      ok: true,
      httpStatus: 200,
      tregCallId: `call_mock_ok_${Date.now()}`,
      costMicro: 1200,
      latencyMs: 110,
      data: {
        code: 0,
        msg: "success",
        data: {
          user: {
            id: "72194820194820194",
            uniqueId: usernameParam,
            nickname: `TikTok Creator (${usernameParam})`,
            avatarLarger: `https://p16-sign.tiktokcdn.com/${usernameParam}_avatar.jpeg`,
            signature: "Digital content creator • Exploring data scraping with Digr",
            verified: true,
            secUid: "MS4wLjABAAAAk39f_1...",
            region: "EG",
          },
          stats: {
            followerCount: 182400,
            followingCount: 340,
            heartCount: 4210000,
            videoCount: 78,
            diggCount: 450,
          },
        },
      },
      isRouteMaxCost: false,
      isPlatformBalanceLow: false,
    };
  }

  let targetUrl = `${baseUrl}${urlPath}`;
  const headers: Record<string, string> = {
    "Authorization": `Bearer ${apiKey}`,
    "Idempotency-Key": idemKey,
    "X-Treg-Max-Cost-Micro": String(options.maxCostMicro || 10000),
    "X-Treg-Tag": `customer:${options.userId}`,
    "Content-Type": "application/json",
  };

  if (options.testScenario) {
    headers["X-Test-Scenario"] = options.testScenario;
  }

  let requestBody: string | undefined = undefined;

  if (options.method === "GET") {
    if (options.params && Object.keys(options.params).length > 0) {
      const searchParams = new URLSearchParams();
      for (const [k, v] of Object.entries(options.params)) {
        if (v !== undefined && v !== null) {
          searchParams.append(k, String(v));
        }
      }
      targetUrl += (targetUrl.includes("?") ? "&" : "?") + searchParams.toString();
    }
  } else {
    requestBody = JSON.stringify(options.params || {});
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
  const tregCallId = response.headers.get("x-treg-call-id") || `call_${Date.now()}`;

  let responseBody: any = null;
  try {
    responseBody = await response.json();
  } catch {
    responseBody = null;
  }

  // Evaluate error semantics according to TREG integrate.md spec:
  // Body { error: "route_max_cost" } vs Body { error: "insufficient_balance" }
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
