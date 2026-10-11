import { executeTregCall } from "./tregClient";

export const HARD_TOTAL_COST_CAP_USD = 0.02; // $0.02 USD hard cap
export const HARD_TOTAL_COST_CAP_MICRO = Math.round(HARD_TOTAL_COST_CAP_USD * 1_000_000); // 20,000 micro-USD

export interface SmokeCallSummary {
  platform: string;
  ok: boolean;
  status: number;
  latency_ms: number;
  cost_usd: number;
  note?: string;
  profile_name?: string;
}

export interface SmokeTestResult {
  auth_ok: boolean;
  provider_token_present: boolean;
  live_switch: boolean;
  results: SmokeCallSummary[];
  total_cost_usd: number;
  message_ar: string;
}

export async function runSmokeTests(userId: string): Promise<SmokeTestResult> {
  const providerTokenPresent = Boolean(
    (process.env.TREG_TOKEN && process.env.TREG_TOKEN.trim().length > 0) ||
    (process.env.TREG_API_KEY && process.env.TREG_API_KEY.trim().length > 0)
  );

  const liveSwitch = process.env.TREG_LIVE === "true";

  if (!liveSwitch) {
    return {
      auth_ok: true,
      provider_token_present: providerTokenPresent,
      live_switch: false,
      results: [],
      total_cost_usd: 0,
      message_ar: "المفتاح المباشر معطل حالياً في البيئة (TREG_LIVE!=true). لم يتم تنفيذ أي استدعاءات خارجية للحفاظ على الرصيد.",
    };
  }

  if (!providerTokenPresent) {
    return {
      auth_ok: true,
      provider_token_present: false,
      live_switch: true,
      results: [],
      total_cost_usd: 0,
      message_ar: "رمز مزود البيانات غير موجود (TREG_TOKEN أو TREG_API_KEY). تعذر إجراء الفحص.",
    };
  }

  const results: SmokeCallSummary[] = [];
  let totalCostMicro = 0;

  // 1. TikTok Public Profile Check
  if (totalCostMicro + 7000 <= HARD_TOTAL_COST_CAP_MICRO) {
    try {
      const tikRes = await executeTregCall({
        endpointId: "tikhub.tiktok.user.profile",
        method: "POST",
        params: { username: "iammagdy" },
        userId,
        jobId: "smoke_tiktok",
        routeMaxCostUsd: "0.007",
      });

      const costUsd = Number(((tikRes.costMicro || 0) / 1_000_000).toFixed(6));
      totalCostMicro += tikRes.costMicro || 0;

      const profileName =
        tikRes.data?.data?.userInfo?.user?.nickname ||
        tikRes.data?.userInfo?.user?.nickname ||
        tikRes.data?.data?.nickname ||
        tikRes.data?.nickname ||
        (tikRes.ok ? "Verified Profile" : undefined);

      results.push({
        platform: "tiktok",
        ok: tikRes.ok,
        status: tikRes.httpStatus,
        latency_ms: tikRes.latencyMs,
        cost_usd: costUsd,
        profile_name: profileName,
        note: tikRes.ok ? "نجح التحقق من الملف الشخصي" : (tikRes.errorDetails || "فشل الاتصال"),
      });
    } catch (err: any) {
      results.push({
        platform: "tiktok",
        ok: false,
        status: 500,
        latency_ms: 0,
        cost_usd: 0,
        note: err.message,
      });
    }
  }

  // 2. Facebook Search Check (limit 1)
  if (totalCostMicro + 7000 <= HARD_TOTAL_COST_CAP_MICRO) {
    try {
      const fbRes = await executeTregCall({
        endpointId: "facebook-search",
        method: "POST",
        params: { query: "news", limit: 1 },
        userId,
        jobId: "smoke_facebook",
        routeMaxCostUsd: "0.007",
      });

      const costUsd = Number(((fbRes.costMicro || 0) / 1_000_000).toFixed(6));
      totalCostMicro += fbRes.costMicro || 0;

      results.push({
        platform: "facebook",
        ok: fbRes.ok,
        status: fbRes.httpStatus,
        latency_ms: fbRes.latencyMs,
        cost_usd: costUsd,
        note: fbRes.ok ? "نجح البحث التجريبي" : (fbRes.errorDetails || "استجابة المصدر"),
      });
    } catch (err: any) {
      results.push({
        platform: "facebook",
        ok: false,
        status: 500,
        latency_ms: 0,
        cost_usd: 0,
        note: err.message,
      });
    }
  }

  // 3. X Search Check (limit 1)
  if (totalCostMicro + 7000 <= HARD_TOTAL_COST_CAP_MICRO) {
    try {
      const xRes = await executeTregCall({
        endpointId: "x-keyword-search",
        method: "POST",
        params: { query: "tech", limit: 1 },
        userId,
        jobId: "smoke_x",
        routeMaxCostUsd: "0.007",
      });

      const costUsd = Number(((xRes.costMicro || 0) / 1_000_000).toFixed(6));
      totalCostMicro += xRes.costMicro || 0;

      results.push({
        platform: "x",
        ok: xRes.ok,
        status: xRes.httpStatus,
        latency_ms: xRes.latencyMs,
        cost_usd: costUsd,
        note: xRes.ok ? "نجح البحث التجريبي" : (xRes.errorDetails || "استجابة المصدر"),
      });
    } catch (err: any) {
      results.push({
        platform: "x",
        ok: false,
        status: 500,
        latency_ms: 0,
        cost_usd: 0,
        note: err.message,
      });
    }
  }

  const totalCostUsd = Number((totalCostMicro / 1_000_000).toFixed(6));
  const successfulCount = results.filter((r) => r.ok).length;

  let message_ar = "تم فحص الاتصال بمزود البيانات بنجاح لجميع المنصات المختبرة.";
  if (successfulCount === 0) {
    message_ar = "فشل الاتصال بمزود البيانات في كافة الفحوصات المختبرة.";
  } else if (successfulCount < results.length) {
    message_ar = `تم فحص الاتصال بمزود البيانات جزئياً (${successfulCount}/${results.length} نجحت).`;
  }

  return {
    auth_ok: true,
    provider_token_present: providerTokenPresent,
    live_switch: liveSwitch,
    results,
    total_cost_usd: totalCostUsd,
    message_ar,
  };
}
