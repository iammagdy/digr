import { executeTregCall, TregCallOptions, TregCallResult, serializeProviderParams } from "../../functions/shared/tregClient";
import { extractAndFlattenRows, parseTikTokProfileResponse } from "../../functions/shared/multiStepWorker";

export interface ProviderAdapterCallInput {
  jobId: string;
  userId: string;
  step: number;
  endpointId: string;
  capabilitySlug: string;
  method: "GET" | "POST";
  params: Record<string, any>;
  paginationStrategy: "cursor" | "offset" | "page" | "none";
  cursor: string | null;
  pageSize: number;
  remainingNeeded: number;
  targetVolumeMax: number;
  deliveredSoFar: number;
}

export interface ProviderAdapterCallOutput {
  ok: boolean;
  httpStatus: number;
  rows: Record<string, any>[];
  rawProfile?: Record<string, any> | null;
  nextCursor: string | null;
  costUsd: number;
  costMicro: number;
  tregCallId: string;
  errorCode?: string;
  errorMessageAr?: string;
}

export type ProviderAdapterFn = (
  input: ProviderAdapterCallInput
) => Promise<ProviderAdapterCallOutput>;

let injectedTestAdapter: ProviderAdapterFn | null = null;

/**
 * Registers a test-only provider adapter.
 * Note: /api/worker/chunk strictly blocks injected/mock adapters with HTTP 403
 * whenever NODE_ENV === 'production' or ENABLE_MOCK_PROVIDER !== 'true'.
 */
export function setProviderAdapterForTesting(adapter: ProviderAdapterFn | null): void {
  injectedTestAdapter = adapter;
}

export function getInjectedProviderAdapter(): ProviderAdapterFn | null {
  return injectedTestAdapter;
}

export async function executeTregCallWithRetry(
  options: TregCallOptions,
  maxRetries: number = 3
): Promise<TregCallResult> {
  // First real TikTok profile test requires exactly ONE outbound provider attempt maximum
  const isSingleAttemptEndpoint = options.endpointId === "tikhub.tiktok.user.profile";
  const effectiveMaxRetries = isSingleAttemptEndpoint ? 0 : maxRetries;
  let attempt = 0;
  let lastResult: TregCallResult | null = null;

  while (attempt <= effectiveMaxRetries) {
    lastResult = await executeTregCall(options);
    if (lastResult.ok) {
      return lastResult;
    }

    const isRetryable =
      lastResult.httpStatus === 429 ||
      (lastResult.httpStatus >= 500 && lastResult.httpStatus <= 599) ||
      lastResult.error === "network_failure" ||
      lastResult.error === "rate_limit";

    if (!isRetryable || attempt === effectiveMaxRetries) {
      return lastResult;
    }

    attempt++;
    const backoffMs = Math.min(1000, 50 * Math.pow(2, attempt - 1));
    await new Promise((r) => setTimeout(r, backoffMs));
  }

  return lastResult!;
}

/**
 * Real TREG provider adapter calling https://treg.to/call/{endpoint-id}.
 * Strictly gated by TREG_LIVE === 'true' and TREG_TOKEN.
 */
export const defaultTregAdapter: ProviderAdapterFn = async (
  input: ProviderAdapterCallInput
): Promise<ProviderAdapterCallOutput> => {
  if (process.env.TREG_LIVE !== "true" || !process.env.TREG_TOKEN?.trim()) {
    return {
      ok: false,
      httpStatus: 503,
      rows: [],
      nextCursor: null,
      costUsd: 0,
      costMicro: 0,
      tregCallId: "",
      errorCode: "treg_live_disabled",
      errorMessageAr:
        "محرك استخراج البيانات المباشر غير مفعل حالياً؛ تم استرداد كامل الرصيد المحجوز دون أي خصم.",
    };
  }

  const page = input.step + 1;
  const pageParams: Record<string, any> = serializeProviderParams(input.params || {});

  if (input.paginationStrategy === "cursor") {
    if (input.cursor) {
      pageParams.cursor = input.cursor;
      pageParams.next_cursor = input.cursor;
    }
  } else if (input.paginationStrategy === "offset") {
    const numericOffset = input.cursor ? Number(input.cursor) : input.step * input.pageSize;
    pageParams.offset = Number.isFinite(numericOffset) ? numericOffset : input.step * input.pageSize;
    pageParams.limit = input.pageSize;
  } else if (input.paginationStrategy === "page") {
    pageParams.page = page;
    pageParams.limit = input.pageSize;
  }

  const isSingleAttemptCap =
    input.endpointId === "tikhub.tiktok.user.profile" ||
    input.capabilitySlug === "tiktok-profile";
  const retries = isSingleAttemptCap ? 0 : 3;

  const callResult = await executeTregCallWithRetry(
    {
      endpointId: input.endpointId,
      method: input.method,
      params: pageParams,
      userId: input.userId,
      jobId: input.jobId,
      stepId: `step_${input.step}`,
      page,
      routeMaxCostUsd: "0.05",
    },
    retries
  );

  const costMicro = Math.max(0, Number(callResult.costMicro) || 0);
  const costUsd = Number((costMicro / 1_000_000).toFixed(6));

  if (!callResult.ok) {
    let errorMessageAr = "تعذر استخراج البيانات من المصدر بعد عدة محاولات.";
    if (callResult.isRouteMaxCost) {
      errorMessageAr = "تجاوز الطلب سقف التكلفة المسموح به للمصدر.";
    } else if (callResult.isPlatformBalanceLow) {
      errorMessageAr = "الخدمة غير متاحة مؤقتاً، يرجى المحاولة لاحقاً.";
    } else if (callResult.httpStatus === 404) {
      errorMessageAr = "الهدف المطلوب غير موجود أو غير متاح للعامة.";
    } else if (callResult.httpStatus === 422) {
      errorMessageAr = "تعذر معالجة مدخلات الطلب لدى المصدر.";
    } else if (callResult.httpStatus === 429) {
      errorMessageAr = "المصدر مشغول حالياً بعد استنفاد محاولات الإعادة.";
    }

    return {
      ok: false,
      httpStatus: callResult.httpStatus,
      rows: [],
      nextCursor: null,
      costUsd,
      costMicro,
      tregCallId: callResult.tregCallId || "",
      errorCode: callResult.error || `http_${callResult.httpStatus}`,
      errorMessageAr,
    };
  }

  let rows: Record<string, any>[] = [];
  let rawProfile: Record<string, any> | null = null;

  if (
    input.endpointId === "tikhub.tiktok.user.profile" ||
    input.capabilitySlug === "tiktok-profile"
  ) {
    const requestedUser = String(
      input.params?.username || input.params?.uniqueId || ""
    );
    const parsed = parseTikTokProfileResponse(callResult.data, requestedUser);
    if (parsed) {
      rawProfile = parsed;
      rows = [parsed];
    } else {
      rows = extractAndFlattenRows(callResult.data);
    }
  } else {
    rows = extractAndFlattenRows(callResult.data);
  }

  let nextCursor: string | null = null;
  if (rows.length > 0) {
    if (input.paginationStrategy === "cursor") {
      const candidateCursor =
        callResult.data?.next_cursor ??
        callResult.data?.cursor ??
        callResult.data?.nextCursor ??
        callResult.data?.pagination?.next_cursor ??
        callResult.data?.meta?.next_cursor ??
        callResult.data?.next_max_id ??
        null;
      if (
        candidateCursor !== null &&
        candidateCursor !== undefined &&
        String(candidateCursor) !== "" &&
        String(candidateCursor) !== String(input.cursor || "")
      ) {
        nextCursor = String(candidateCursor);
      }
    } else if (input.paginationStrategy === "offset") {
      if (rows.length >= input.pageSize) {
        const baseOffset = input.cursor ? Number(input.cursor) : input.step * input.pageSize;
        nextCursor = String((Number.isFinite(baseOffset) ? baseOffset : 0) + rows.length);
      }
    } else if (input.paginationStrategy === "page") {
      if (rows.length >= input.pageSize) {
        nextCursor = String(page + 1);
      }
    }
  }

  return {
    ok: true,
    httpStatus: callResult.httpStatus,
    rows,
    rawProfile,
    nextCursor,
    costUsd,
    costMicro,
    tregCallId: callResult.tregCallId || "",
  };
};

/**
 * Built-in test adapter for legacy mockProvider body/header requests in non-production tests.
 */
export function createBuiltInMockAdapter(bodyOptions: {
  simulateProviderError?: boolean;
  mockBatchSize?: number;
  mockCostUsd?: number;
}): ProviderAdapterFn {
  return async (input: ProviderAdapterCallInput): Promise<ProviderAdapterCallOutput> => {
    if (bodyOptions.simulateProviderError) {
      return {
        ok: false,
        httpStatus: 502,
        rows: [],
        nextCursor: null,
        costUsd: 0,
        costMicro: 0,
        tregCallId: `mock_err_${input.jobId}_${input.step}`,
        errorCode: "simulated_provider_error",
        errorMessageAr: "خطأ محاكى من مزود البيانات لاختبار إعادة المحاولة.",
      };
    }

    const batchSize =
      typeof bodyOptions.mockBatchSize === "number" && bodyOptions.mockBatchSize > 0
        ? Math.min(input.pageSize, Math.floor(bodyOptions.mockBatchSize))
        : Math.min(input.pageSize, input.remainingNeeded);

    const countToProduce = Math.max(0, Math.min(batchSize, input.remainingNeeded));
    const rows: Record<string, any>[] = Array.from({ length: countToProduce }, (_, idx) => {
      const globalIndex = input.deliveredSoFar + idx + 1;
      return {
        id: `rec_${globalIndex}`,
        uniqueId: `user_${globalIndex}`,
        nickname: `حساب بحثي ${globalIndex}`,
        signature: `بيانات عامة مستخرجة رقم ${globalIndex}`,
        verified: globalIndex % 2 === 0,
        followerCount: 1000 * globalIndex,
        followingCount: 150 + globalIndex,
        heartCount: 25000 * globalIndex,
        videoCount: 40 + globalIndex,
        bioLink: `https://example.org/u/${globalIndex}`,
        profileUrl: `https://www.tiktok.com/@user_${globalIndex}`,
        collectedDate: new Date().toISOString().slice(0, 10),
      };
    });

    const totalAfter = input.deliveredSoFar + rows.length;
    const nextCursor =
      totalAfter < input.targetVolumeMax && rows.length > 0
        ? `cursor_step_${input.step + 1}`
        : null;
    const costUsd = typeof bodyOptions.mockCostUsd === "number" ? bodyOptions.mockCostUsd : 0.004;

    return {
      ok: true,
      httpStatus: 200,
      rows,
      rawProfile: rows[0] || null,
      nextCursor,
      costUsd,
      costMicro: Math.round(costUsd * 1_000_000),
      tregCallId: `mock_call_${input.jobId}_${input.step}`,
    };
  };
}

const inMemoryPartialStepFallback = new Map<string, any>();

export function getInMemoryPartialStepFallback(): Map<string, any> {
  return inMemoryPartialStepFallback;
}

export function clearInMemoryPartialStepFallbackForTesting(): void {
  inMemoryPartialStepFallback.clear();
}
