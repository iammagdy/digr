import { resolveProviderKey } from "../../lib/server/providerKeys";
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
  detail?: string;
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
  const providerTokenPresent = Boolean((await resolveProviderKey("treg")).key);

  const liveRaw = (process.env.TREG_LIVE || "").trim().toLowerCase();
  const liveSwitch = liveRaw === "true" || liveRaw === "1" || liveRaw === "yes" || liveRaw === "on";

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

  // 1. TikTok Public Profile Check (GET)
  if (totalCostMicro + 7000 <= HARD_TOTAL_COST_CAP_MICRO) {
    try {
      const tikRes = await executeTregCall({
        endpointId: "tikhub.tiktok.user.profile",
        method: "GET",
        params: { uniqueId: "iammagdy" },
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
        detail: tikRes.detail || tikRes.errorDetails,
      });
    } catch (err: any) {
      results.push({
        platform: "tiktok",
        ok: false,
        status: 500,
        latency_ms: 0,
        cost_usd: 0,
        note: err.message,
        detail: String(err.message || "").slice(0, 300),
      });
    }
  }

  // 2. Facebook Profile Posts Check (GET)
  if (totalCostMicro + 7000 <= HARD_TOTAL_COST_CAP_MICRO) {
    try {
      const fbRes = await executeTregCall({
        endpointId: "scrapecreators.x.v1-facebook-profile-posts",
        method: "GET",
        params: { url: "https://www.facebook.com/nike" },
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
        note: fbRes.ok ? "نجح فحص منشورات فيسبوك" : (fbRes.errorDetails || "استجابة المصدر"),
        detail: fbRes.detail || fbRes.errorDetails,
      });
    } catch (err: any) {
      results.push({
        platform: "facebook",
        ok: false,
        status: 500,
        latency_ms: 0,
        cost_usd: 0,
        note: err.message,
        detail: String(err.message || "").slice(0, 300),
      });
    }
  }

  // 3. X Search Check (POST)
  if (totalCostMicro + 7000 <= HARD_TOTAL_COST_CAP_MICRO) {
    try {
      const xRes = await executeTregCall({
        endpointId: "anyapi.x.search.posts",
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
        note: xRes.ok ? "نجح البحث التجريبي على منصة X" : (xRes.errorDetails || "استجابة المصدر"),
        detail: xRes.detail || xRes.errorDetails,
      });
    } catch (err: any) {
      results.push({
        platform: "x",
        ok: false,
        status: 500,
        latency_ms: 0,
        cost_usd: 0,
        note: err.message,
        detail: String(err.message || "").slice(0, 300),
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
