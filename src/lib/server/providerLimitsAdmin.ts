import { isMissingAtomicRpc } from "../../functions/shared/atomicRpc";
import {
  flushProviderLimitsCache, resolveProviderLimits, spendLevel, spendPercent, validateLimitsInput,
  type LimitsInput, type LimitsSource, type ProviderLimits, type SpendLevel,
} from "./providerLimits";

export const LIMITS_MSG = {
  storeNotReady: "مخزن الإعدادات غير جاهز بعد لأن تحديث قاعدة البيانات لم يُطبَّق. تستمر المنصة على القيم الحالية ولم يتغير شيء.",
  failed: "تعذر حفظ الحدود الآن. لم يتغير شيء وما زالت القيم السابقة سارية.",
  notAdmin: "هذا الإجراء مخصص للمسؤولين فقط.",
  saved: "تم حفظ الحدود وهي سارية الآن على كل الطلبات (قد يستغرق حتى ٣٠ ثانية على الخوادم الأخرى).",
  warn: "اقترب إنفاق المزود اليوم من الحد اليومي.",
  reached: "وصل إنفاق المزود اليوم إلى الحد اليومي؛ لن تبدأ طلبات جديدة تحتاج المزود حتى يُرفع الحد أو يبدأ يوم جديد.",
} as const;

export interface LimitsActionOutcome { ok: boolean; reason: string; messageAr: string; status: number }

export interface LimitsAuditRow { at: string; summaryAr: string }

export interface ProviderLimitsState {
  limits: ProviderLimits;
  source: LimitsSource;
  /** false until the migration is applied: saving is impossible and the current constants stay in force */
  storeReady: boolean;
  spend: { todayUsd: number; percent: number; level: SpendLevel; llmTodayUsd: number; llmPercent: number; llmLevel: SpendLevel };
  audit: LimitsAuditRow[];
  noticesAr: string[];
}

const isMissingTable = (e: any) => {
  const code = String(e?.code || ""); const msg = String(e?.message || "");
  return code === "42P01" || code === "PGRST205" || /does not exist|schema cache/i.test(msg);
};

function utcStartOfDay(): string {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate())).toISOString();
}

const sum = (rows: any[] | null | undefined) => (rows || []).reduce((a, r) => { const c = Number(r?.cost_usd); return Number.isFinite(c) && c > 0 ? a + c : a; }, 0);

const LABEL: Record<string, string> = { dailyUsd: "الحد اليومي للمزود", perJobUsd: "سقف الطلب", perUserDailyUsd: "سقف المستخدم اليومي", warnPercent: "نسبة التنبيه", llmDailyUsd: "الحد اليومي للنموذج" };

/** One readable Arabic line per audit row: only the fields that changed, old to new. */
export function auditSummaryAr(oldValue: any, newValue: any): string {
  const parts: string[] = [];
  const keys = new Set([...Object.keys(oldValue || {}), ...Object.keys(newValue || {})]);
  for (const k of keys) {
    const a = oldValue?.[k]; const b = newValue?.[k];
    if (a === b || !LABEL[k]) continue;
    const show = (v: unknown) => (v === undefined || v === null ? "بلا سقف" : String(v));
    parts.push(`${LABEL[k]}: ${show(a)} ← ${show(b)}`);
  }
  return parts.join("، ") || "حفظ بلا تغيير";
}

export async function loadProviderLimitsState(client: any, options?: { forceRefresh?: boolean }): Promise<ProviderLimitsState> {
  const { limits, source } = await resolveProviderLimits(client, { forceRefresh: options?.forceRefresh ?? true });
  let storeReady = true;
  const audit: LimitsAuditRow[] = [];
  try {
    const { data, error } = await client.from("provider_limits_audit").select("created_at, old_value, new_value").order("created_at", { ascending: false }).limit(5);
    if (error) { if (isMissingTable(error)) storeReady = false; }
    else for (const r of data || []) audit.push({ at: r.created_at, summaryAr: auditSummaryAr(r.old_value, r.new_value) });
  } catch { storeReady = false; }

  let todayUsd = 0; let llmTodayUsd = 0;
  try {
    const { data } = await client.from("provider_costs").select("cost_usd").eq("provider", "treg").gte("created_at", utcStartOfDay());
    todayUsd = sum(data);
  } catch { /* table unavailable: zero */ }
  try {
    const { data } = await client.from("llm_usage").select("cost_usd").gte("created_at", utcStartOfDay());
    llmTodayUsd = sum(data);
  } catch { /* table unavailable: zero */ }

  const level = spendLevel(todayUsd, limits);
  const llmLevel = spendLevel(llmTodayUsd, { dailyUsd: limits.llmDailyUsd, warnPercent: limits.warnPercent });
  const noticesAr: string[] = [];
  if (!storeReady) noticesAr.push(LIMITS_MSG.storeNotReady);
  if (level === "reached") noticesAr.push(LIMITS_MSG.reached);
  else if (level === "warn") noticesAr.push(LIMITS_MSG.warn);
  return {
    limits, source, storeReady,
    spend: { todayUsd, percent: spendPercent(todayUsd, limits.dailyUsd), level, llmTodayUsd, llmPercent: spendPercent(llmTodayUsd, limits.llmDailyUsd), llmLevel },
    audit, noticesAr,
  };
}

/** Validates, then writes through the SECURITY DEFINER function (which verifies the admin again and writes the audit row). */
export async function saveProviderLimits(deps: { client: any }, input: { adminId: string; limits: LimitsInput }): Promise<LimitsActionOutcome> {
  const parsed = validateLimitsInput(input.limits || {});
  if (!parsed.ok) return { ok: false, reason: "invalid", messageAr: parsed.messageAr, status: 400 };
  const { data, error } = await deps.client.rpc("admin_set_provider_limits_atomic", { p_admin_id: input.adminId, p_limits: parsed.value });
  if (error) {
    if (isMissingAtomicRpc(error, "admin_set_provider_limits_atomic")) return { ok: false, reason: "store_not_ready", messageAr: LIMITS_MSG.storeNotReady, status: 409 };
    console.error("[provider_limits:save_failed] code=" + String((error as any)?.code || "unknown"));
    return { ok: false, reason: "failed", messageAr: LIMITS_MSG.failed, status: 500 };
  }
  if (data?.success !== true) {
    const reason = String(data?.error || "failed");
    return { ok: false, reason, messageAr: reason === "not_admin" ? LIMITS_MSG.notAdmin : (typeof data?.error_ar === "string" && data.error_ar) || LIMITS_MSG.failed, status: reason === "not_admin" ? 403 : 400 };
  }
  // Immediate effect on this instance; other instances pick it up within the 30 s cache.
  flushProviderLimitsCache();
  return { ok: true, reason: "saved", messageAr: LIMITS_MSG.saved, status: 200 };
}
