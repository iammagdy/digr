import { executeTregCall, TregCallOptions, TregCallResult, serializeProviderParams } from "../../functions/shared/tregClient";
import { getEndpointDetails } from "../../functions/shared/catalogClient";
import {
  extractAndFlattenRows,
  parseTikTokProfileResponse,
  parseIcypeasCompaniesResponse,
} from "../../functions/shared/multiStepWorker";
import { getLiveProviderGateStatus } from "./providerGate";

/**
 * Normalizes company search parameters (Arabic/English terms) into Icypeas API shape:
 * POST /find-companies with { query: { location, keyword, industry }, pagination: { size, token } }
 */
export function normalizeIcypeasCompanyParams(
  rawParams: Record<string, any>,
  pageSize: number,
  cursor?: string | null
): Record<string, any> {
  const queryObj: Record<string, any> = (rawParams?.query && typeof rawParams.query === "object")
    ? { ...rawParams.query }
    : {};

  const rawLocation = String(
    rawParams?.location ||
    rawParams?.country ||
    rawParams?.city ||
    queryObj?.location?.include?.[0] ||
    (typeof queryObj?.location === "string" ? queryObj.location : "") ||
    ""
  ).trim();

  const rawKeyword = String(
    rawParams?.keyword ||
    rawParams?.search ||
    rawParams?.query ||
    rawParams?.topic ||
    queryObj?.keyword?.include?.[0] ||
    (typeof queryObj?.keyword === "string" ? queryObj.keyword : "") ||
    ""
  ).trim();

  const rawIndustry = String(
    rawParams?.industry ||
    rawParams?.sector ||
    queryObj?.industry?.include?.[0] ||
    (typeof queryObj?.industry === "string" ? queryObj.industry : "") ||
    ""
  ).trim();

  const translateLocation = (loc: string): string => {
    const l = loc.toLowerCase();
    if (l.includes("مصر") || l.includes("egypt")) return "Egypt";
    if (l.includes("القاهرة") || l.includes("cairo")) return "Cairo, Egypt";
    if (l.includes("الجيزة") || l.includes("giza")) return "Giza, Egypt";
    if (l.includes("الإسكندرية") || l.includes("alexandria")) return "Alexandria, Egypt";
    if (l.includes("السعودية") || l.includes("saudi")) return "Saudi Arabia";
    if (l.includes("الرياض") || l.includes("riyadh")) return "Riyadh, Saudi Arabia";
    if (l.includes("الإمارات") || l.includes("uae") || l.includes("emirates")) return "United Arab Emirates";
    if (l.includes("دبي") || l.includes("dubai")) return "Dubai, United Arab Emirates";
    return loc || "Egypt";
  };

  const translateKeywords = (kw: string): string[] => {
    const k = kw.toLowerCase();
    const results: string[] = [];
    if (
      k.includes("مقاولات") ||
      k.includes("تشييد") ||
      k.includes("بناء") ||
      k.includes("construction") ||
      k.includes("contracting")
    ) {
      results.push("contracting", "construction");
    } else if (k.includes("عقارات") || k.includes("تطوير عقاري") || k.includes("real estate")) {
      results.push("real estate");
    } else if (k.includes("تكنولوجيا") || k.includes("برمجيات") || k.includes("software") || k.includes("tech")) {
      results.push("software", "technology");
    } else if (k.includes("سياحة") || k.includes("فنادق") || k.includes("tourism")) {
      results.push("tourism", "hospitality");
    } else if (k.includes("شحن") || k.includes("لوجستيات") || k.includes("logistics")) {
      results.push("logistics", "freight");
    } else if (k.includes("استشارات") || k.includes("consulting")) {
      results.push("consulting");
    } else if (kw) {
      const cleaned = kw.replace(/[^\w\s\u0600-\u06FF]/g, " ").trim();
      if (cleaned) results.push(cleaned);
    }
    return results.length > 0 ? results : ["contracting"];
  };

  const locationVal = translateLocation(rawLocation || "Egypt");
  const keywordVals = translateKeywords(rawKeyword || rawIndustry || "contracting");

  const finalQuery: Record<string, any> = {
    location: { include: [locationVal] },
    keyword: { include: keywordVals },
  };

  if (rawIndustry) {
    const indVals = translateKeywords(rawIndustry);
    finalQuery.industry = { include: indVals };
  }

  const effectiveSize = Math.max(1, Math.min(100, pageSize || 5));
  const paginationObj: Record<string, any> = {
    size: effectiveSize,
  };

  if (cursor && String(cursor).trim()) {
    paginationObj.token = String(cursor).trim();
  }

  return {
    query: finalQuery,
    pagination: paginationObj,
  };
}

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
  const gate = getLiveProviderGateStatus();
  if (!gate.isReady) {
    return {
      ok: false,
      httpStatus: 503,
      rows: [],
      nextCursor: null,
      costUsd: 0,
      costMicro: 0,
      tregCallId: "",
      errorCode: gate.reasonCode,
      errorMessageAr: gate.messageAr,
    };
  }

  const page = input.step + 1;
  let effectiveEndpointId = input.endpointId;
  if (effectiveEndpointId && effectiveEndpointId.includes("-") && !effectiveEndpointId.includes(".")) {
    try {
      const details = await getEndpointDetails(effectiveEndpointId);
      if (details?.id && details.id.includes(".")) {
        effectiveEndpointId = details.id;
      }
    } catch {
      // Continue
    }
  }

  const isIcypeasCompanies =
    effectiveEndpointId === "icypeas.companies.search" ||
    input.capabilitySlug === "icypeas-companies-search" ||
    input.capabilitySlug === "company-research";

  let pageParams: Record<string, any>;
  if (isIcypeasCompanies) {
    pageParams = normalizeIcypeasCompanyParams(input.params || {}, input.pageSize, input.cursor);
  } else {
    pageParams = serializeProviderParams(input.params || {});
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
  }

  const isSingleAttemptCap =
    effectiveEndpointId === "tikhub.tiktok.user.profile" ||
    input.capabilitySlug === "tiktok-profile";
  const retries = isSingleAttemptCap ? 0 : 3;

  const effectiveMethod = isIcypeasCompanies ? "POST" : input.method;

  const callResult = await executeTregCallWithRetry(
    {
      endpointId: effectiveEndpointId,
      method: effectiveMethod,
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
  let nextCursor: string | null = null;

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
  } else if (isIcypeasCompanies) {
    const parsed = parseIcypeasCompaniesResponse(callResult.data);
    rows = parsed.rows;
    nextCursor = parsed.nextCursor;
  } else {
    rows = extractAndFlattenRows(callResult.data);
  }

  if (rows.length > 0 && !isIcypeasCompanies) {
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
