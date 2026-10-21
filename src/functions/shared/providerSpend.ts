import { TablesDB, Query } from "./dbCompat";
import { onProviderLimitsFlush, resolveProviderLimits } from "../../lib/server/providerLimits";
import { readRealProviderBalance } from "../../lib/server/realProviderBalance";

import { selectAllRows } from "../../lib/server/selectAll";
import { effectiveJobPointsCap, JOB_MAX_POINTS_CAP } from "../../lib/jobPointsCap";
export const DEFAULT_PROVIDER_DAILY_SPEND_CAP_USD = 0.80;
/** The per-job cap: one shared constant (`src/lib/jobPointsCap.ts`). */
export const DEFAULT_JOB_POINTS_CAP = JOB_MAX_POINTS_CAP;
export const DEFAULT_PROVIDER_CREDIT_USD = 1.00;
export const PROVIDER_BALANCE_CACHE_TTL_MS = 60_000;

let memoryDailySpendMicro = 0;
let memoryDailySpendDay = new Date().toISOString().slice(0, 10);
let memoryTotalSpendMicro = 0;

interface BalanceCacheEntry {
  availableBalanceUsd: number;
  totalSpendUsd: number;
  creditUsd: number;
  todaySpendUsd: number;
  todayCapUsd: number;
  isHealthy: boolean;
  cachedAt: string;
  expiresAt: number;
}

let balanceCache: BalanceCacheEntry | null = null;
let testBalanceOverrideUsd: number | null = null;
// A saved limit must show in plan estimates at once, not after the 60 s balance cache.
onProviderLimitsFlush(() => { balanceCache = null; });

function checkAndResetDay(): void {
  const today = new Date().toISOString().slice(0, 10);
  if (memoryDailySpendDay !== today) {
    memoryDailySpendDay = today;
    memoryDailySpendMicro = 0;
  }
}

/** The daily limit in force: the shared resolver (admin-editable, 30 s cache), else the environment or 0.80. */
export async function getEffectiveProviderDailyCapUsd(tables?: any): Promise<number> {
  try {
    return (await resolveProviderLimits(tables)).limits.dailyUsd;
  } catch {
    return getConfiguredProviderSpendCapUsd();
  }
}

export function getConfiguredProviderSpendCapUsd(): number {
  const envVal = Number(process.env.PROVIDER_DAILY_SPEND_CAP_USD);
  return Number.isFinite(envVal) && envVal >= 0 ? envVal : DEFAULT_PROVIDER_DAILY_SPEND_CAP_USD;
}

/** The cap in force: the shared constant, which the environment variable may only lower. */
export function getConfiguredJobPointsCap(): number {
  return effectiveJobPointsCap();
}

export function getConfiguredProviderCreditUsd(): number {
  const envVal = Number(process.env.PROVIDER_CREDIT_USD);
  return Number.isFinite(envVal) && envVal >= 0 ? envVal : DEFAULT_PROVIDER_CREDIT_USD;
}

export async function getDailyProviderSpendUsd(tables?: TablesDB | any | null): Promise<number> {
  checkAndResetDay();

  if (!tables) {
    return memoryDailySpendMicro / 1_000_000;
  }

  if (typeof tables.from === "function") {
    try {
      const todayStart = new Date().toISOString().slice(0, 10) + "T00:00:00.000Z";
      const { data } = await selectAllRows(() => tables
        .from("provider_costs")
        .select("cost_usd")
        .eq("provider", "treg")
        .gte("created_at", todayStart), { orderBy: "id" });
      let dbCostUsd = 0;
      for (const row of data || []) {
        const c = Number(row.cost_usd) || 0;
        if (c > 0) dbCostUsd += c;
      }
      return Math.max(dbCostUsd, memoryDailySpendMicro / 1_000_000);
    } catch {
      return memoryDailySpendMicro / 1_000_000;
    }
  }

  try {
    const todayStart = new Date().toISOString().slice(0, 10) + "T00:00:00.000Z";
    const callsRes = await tables.listRows({
      databaseId: "digr",
      tableId: "job_calls",
      queries: [
        Query.greaterThanEqual("createdAt", todayStart),
        Query.limit(100),
      ],
    });

    let dbCostMicro = 0;
    for (const call of callsRes.rows as any[]) {
      const c = Number(call.costMicro) || 0;
      if (c > 0) dbCostMicro += c;
    }

    const totalMicro = Math.max(dbCostMicro, memoryDailySpendMicro);
    return totalMicro / 1_000_000;
  } catch {
    return memoryDailySpendMicro / 1_000_000;
  }
}

export async function getTotalProviderSpendUsd(tables?: TablesDB | any | null): Promise<number> {
  if (!tables) {
    return memoryTotalSpendMicro / 1_000_000;
  }

  if (typeof tables.from === "function") {
    try {
      const { data } = await selectAllRows(() => tables
        .from("provider_costs")
        .select("cost_usd")
        .eq("provider", "treg"), { orderBy: "id" });
      let dbCostUsd = 0;
      for (const row of data || []) {
        const c = Number(row.cost_usd) || 0;
        if (c > 0) dbCostUsd += c;
      }
      return Math.max(dbCostUsd, memoryTotalSpendMicro / 1_000_000);
    } catch {
      return memoryTotalSpendMicro / 1_000_000;
    }
  }

  try {
    const callsRes = await tables.listRows({
      databaseId: "digr",
      tableId: "job_calls",
      queries: [Query.limit(500)],
    });

    let dbCostMicro = 0;
    for (const call of callsRes.rows as any[]) {
      const c = Number(call.costMicro) || 0;
      if (c > 0) dbCostMicro += c;
    }

    const totalMicro = Math.max(dbCostMicro, memoryTotalSpendMicro);
    return totalMicro / 1_000_000;
  } catch {
    return memoryTotalSpendMicro / 1_000_000;
  }
}

export async function recordProviderCallSpend(costMicro: number, tables?: TablesDB | null): Promise<void> {
  checkAndResetDay();
  if (costMicro > 0) {
    memoryDailySpendMicro += costMicro;
    memoryTotalSpendMicro += costMicro;
    balanceCache = null;
  }
}

export async function checkProviderDailySpendCap(
  estimatedCostUsd: number = 0.01,
  tables?: TablesDB | null
): Promise<{ allowed: boolean; currentSpendUsd: number; capUsd: number }> {
  const capUsd = await getEffectiveProviderDailyCapUsd(tables);
  const currentSpendUsd = await getDailyProviderSpendUsd(tables);

  const projectedSpend = currentSpendUsd + Math.max(0, estimatedCostUsd);
  const allowed = projectedSpend <= capUsd;

  return {
    allowed,
    currentSpendUsd,
    capUsd,
  };
}

export interface ProviderBalanceStatus {
  availableBalanceUsd: number;
  totalSpendUsd: number;
  creditUsd: number;
  todaySpendUsd: number;
  todayCapUsd: number;
  isHealthy: boolean;
  cachedAt: string;
}

export async function getProviderBalanceStatus(
  tables?: TablesDB | null,
  forceRefresh: boolean = false
): Promise<ProviderBalanceStatus> {
  const now = Date.now();
  if (!forceRefresh && balanceCache && balanceCache.expiresAt > now && testBalanceOverrideUsd === null) {
    // The limit is re-read from the shared resolver (30 s cache), never frozen in the 60 s balance cache.
    const todayCapUsd = await getEffectiveProviderDailyCapUsd(tables);
    return {
      availableBalanceUsd: balanceCache.availableBalanceUsd,
      totalSpendUsd: balanceCache.totalSpendUsd,
      creditUsd: balanceCache.creditUsd,
      todaySpendUsd: balanceCache.todaySpendUsd,
      todayCapUsd,
      isHealthy: balanceCache.availableBalanceUsd > 0.02 && balanceCache.todaySpendUsd < todayCapUsd,
      cachedAt: balanceCache.cachedAt,
    };
  }

  const creditUsd = getConfiguredProviderCreditUsd();
  const todayCapUsd = await getEffectiveProviderDailyCapUsd(tables);
  const totalSpendUsd = await getTotalProviderSpendUsd(tables);
  const todaySpendUsd = await getDailyProviderSpendUsd(tables);

  let availableBalanceUsd: number;
  if (testBalanceOverrideUsd !== null) {
    availableBalanceUsd = Math.max(0, testBalanceOverrideUsd);
  } else {
    availableBalanceUsd = Math.max(0, creditUsd - totalSpendUsd);
  }

  availableBalanceUsd = Math.round(availableBalanceUsd * 10000) / 10000;
  const isHealthy = availableBalanceUsd > 0.02 && todaySpendUsd < todayCapUsd;
  const cachedAt = new Date().toISOString();

  balanceCache = {
    availableBalanceUsd,
    totalSpendUsd,
    creditUsd,
    todaySpendUsd,
    todayCapUsd,
    isHealthy,
    cachedAt,
    expiresAt: now + PROVIDER_BALANCE_CACHE_TTL_MS,
  };

  return {
    availableBalanceUsd,
    totalSpendUsd,
    creditUsd,
    todaySpendUsd,
    todayCapUsd,
    isHealthy,
    cachedAt,
  };
}

export async function getProviderAvailableBalanceUsd(
  tables?: TablesDB | null,
  forceRefresh: boolean = false
): Promise<number> {
  const status = await getProviderBalanceStatus(tables, forceRefresh);
  return status.availableBalanceUsd;
}

export interface PlanCapacityCheckResult {
  allowed: boolean;
  /** Where the balance the budget came from: the provider's own reading, or the configured credit minus the recorded spend. */
  balanceSource?: "real" | "estimate";
  safeBudgetUsd: number;
  availableBalanceUsd: number;
  originalVolume: number;
  maxSafeVolume: number;
  downscaled: boolean;
  reasonAr?: string;
}

export async function checkPlanProviderCapacity(
  targetVolume: number,
  primaryUnitCostUsd: number,
  tables?: TablesDB | null,
  /** What this customer may still spend today under the admin's per-user daily limit (USD), when that limit is set. */
  options: { userRemainingUsd?: number | null } = {},
): Promise<PlanCapacityCheckResult> {
  const status = await getProviderBalanceStatus(tables);
  const remainingDailyUsd = Math.max(0, status.todayCapUsd - status.todaySpendUsd);
  // The balance is the provider's REAL one when a recent reading exists; otherwise the estimate (credit minus recorded spend), as before.
  // A test that fixes the balance keeps its fixed figure.
  const real = testBalanceOverrideUsd !== null ? null : await readRealProviderBalance(tables);
  const balanceUsd = real ? real.usd : status.availableBalanceUsd;
  const balanceSource: "real" | "estimate" = real ? "real" : "estimate";
  const userCapUsd = options.userRemainingUsd != null && Number.isFinite(options.userRemainingUsd) ? Math.max(0, options.userRemainingUsd) : Number.POSITIVE_INFINITY;
  const effectiveAvailableUsd = testBalanceOverrideUsd !== null
    ? Math.min(testBalanceOverrideUsd, userCapUsd)
    : Math.min(balanceUsd, remainingDailyUsd, userCapUsd);
  // 10% safety margin on effective available balance
  const safeBudgetUsd = Math.max(0, effectiveAvailableUsd * 0.90);

  const unitCost = primaryUnitCostUsd > 0 ? primaryUnitCostUsd : 0.001;
  const estimatedCostUsd = targetVolume * unitCost;

  if (estimatedCostUsd <= safeBudgetUsd) {
    return {
      allowed: true,
      balanceSource,
      safeBudgetUsd,
      availableBalanceUsd: balanceUsd,
      originalVolume: targetVolume,
      maxSafeVolume: targetVolume,
      downscaled: false,
    };
  }

  const maxSafeVolume = Math.max(0, Math.floor(safeBudgetUsd / unitCost));
  return {
    allowed: maxSafeVolume > 0,
    balanceSource,
    safeBudgetUsd,
    availableBalanceUsd: balanceUsd,
    originalVolume: targetVolume,
    maxSafeVolume,
    downscaled: true,
    reasonAr: maxSafeVolume > 0
      ? `تم تعديل الحد الأقصى إلى ${maxSafeVolume} سجل لضمان دقة وسرعة التنفيذ المباشر`
      : "سعة الاستخراج الفورية مكتملة حالياً، يرجى المحاولة لاحقاً",
  };
}

export const PROVIDER_DAILY_CAP_MESSAGE_AR = "وصلنا إلى الحد اليومي لجمع البيانات، فلا يتسع هذا الطلب الآن. لم يُخصم أي رصيد؛ جرّب غدًا أو قلّل العدد.";
export const PROVIDER_BALANCE_LOW_MESSAGE_AR = "خدمة الجمع غير متاحة لهذا الحجم الآن. لم يُخصم أي رصيد؛ قلّل العدد أو حاول بعد قليل.";
export const PROVIDER_USER_CAP_MESSAGE_AR = "وصلت إلى حدك اليومي لجمع البيانات في حسابك، فلا يتسع هذا الطلب الآن. لم يُخصم أي رصيد؛ جرّب غدًا أو قلّل العدد.";

export type ProviderStartDecision =
  | { allowed: true }
  | { allowed: false; code: "provider_daily_cap" | "provider_balance_low" | "provider_user_cap"; messageAr: string };

/**
 * The approve-time check of the plan against the provider side: the daily allowance left, the real provider balance (the estimate when
 * no recent real reading exists) and the account's own daily allowance, each with the same 10% margin the plan-time check keeps.
 * `estimatedUsd` is volume x the cost of one DELIVERED record. Read only; nothing is reserved here.
 */
export async function evaluateProviderStartGate(
  estimatedUsd: number,
  tables?: TablesDB | null,
  options: { userRemainingUsd?: number | null } = {},
): Promise<ProviderStartDecision> {
  const status = await getProviderBalanceStatus(tables);
  const remainingDailyUsd = Math.max(0, status.todayCapUsd - status.todaySpendUsd);
  const real = testBalanceOverrideUsd !== null ? null : await readRealProviderBalance(tables);
  const balanceUsd = testBalanceOverrideUsd !== null ? testBalanceOverrideUsd : real ? real.usd : status.availableBalanceUsd;
  const needed = Math.max(0, estimatedUsd);
  const margin = 0.9;
  if (options.userRemainingUsd != null && Number.isFinite(options.userRemainingUsd) && needed > Math.max(0, options.userRemainingUsd) * margin) {
    return { allowed: false, code: "provider_user_cap", messageAr: PROVIDER_USER_CAP_MESSAGE_AR };
  }
  if (needed > remainingDailyUsd * margin) return { allowed: false, code: "provider_daily_cap", messageAr: PROVIDER_DAILY_CAP_MESSAGE_AR };
  if (needed > Math.max(0, balanceUsd) * margin) return { allowed: false, code: "provider_balance_low", messageAr: PROVIDER_BALANCE_LOW_MESSAGE_AR };
  return { allowed: true };
}

export function resetProviderBalanceCacheForTesting(): void {
  balanceCache = null;
  testBalanceOverrideUsd = null;
  memoryTotalSpendMicro = 0;
  resetProviderDailySpendForTesting();
}

export function setProviderBalanceForTesting(usd: number): void {
  testBalanceOverrideUsd = usd;
  balanceCache = null;
}

export function resetProviderDailySpendForTesting(): void {
  memoryDailySpendMicro = 0;
  memoryDailySpendDay = new Date().toISOString().slice(0, 10);
}

export function setMemoryProviderDailySpendUsdForTesting(usd: number): void {
  memoryDailySpendDay = new Date().toISOString().slice(0, 10);
  memoryDailySpendMicro = Math.round(usd * 1_000_000);
}
