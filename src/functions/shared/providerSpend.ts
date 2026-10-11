import { TablesDB, Query } from "node-appwrite";

export const DEFAULT_PROVIDER_DAILY_SPEND_CAP_USD = 0.80;
export const DEFAULT_JOB_POINTS_CAP = 600;
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

function checkAndResetDay(): void {
  const today = new Date().toISOString().slice(0, 10);
  if (memoryDailySpendDay !== today) {
    memoryDailySpendDay = today;
    memoryDailySpendMicro = 0;
  }
}

export function getConfiguredProviderSpendCapUsd(): number {
  const envVal = Number(process.env.PROVIDER_DAILY_SPEND_CAP_USD);
  return Number.isFinite(envVal) && envVal >= 0 ? envVal : DEFAULT_PROVIDER_DAILY_SPEND_CAP_USD;
}

export function getConfiguredJobPointsCap(): number {
  const envVal = Number(process.env.JOB_MAX_POINTS_CAP);
  return Number.isFinite(envVal) && envVal > 0 ? Math.floor(envVal) : DEFAULT_JOB_POINTS_CAP;
}

export function getConfiguredProviderCreditUsd(): number {
  const envVal = Number(process.env.PROVIDER_CREDIT_USD);
  return Number.isFinite(envVal) && envVal >= 0 ? envVal : DEFAULT_PROVIDER_CREDIT_USD;
}

export async function getDailyProviderSpendUsd(tables?: TablesDB | null): Promise<number> {
  checkAndResetDay();

  if (!tables) {
    return memoryDailySpendMicro / 1_000_000;
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

export async function getTotalProviderSpendUsd(tables?: TablesDB | null): Promise<number> {
  if (!tables) {
    return memoryTotalSpendMicro / 1_000_000;
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
  const capUsd = getConfiguredProviderSpendCapUsd();
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
    return {
      availableBalanceUsd: balanceCache.availableBalanceUsd,
      totalSpendUsd: balanceCache.totalSpendUsd,
      creditUsd: balanceCache.creditUsd,
      todaySpendUsd: balanceCache.todaySpendUsd,
      todayCapUsd: balanceCache.todayCapUsd,
      isHealthy: balanceCache.isHealthy,
      cachedAt: balanceCache.cachedAt,
    };
  }

  const creditUsd = getConfiguredProviderCreditUsd();
  const todayCapUsd = getConfiguredProviderSpendCapUsd();
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
  tables?: TablesDB | null
): Promise<PlanCapacityCheckResult> {
  const status = await getProviderBalanceStatus(tables);
  const remainingDailyUsd = Math.max(0, status.todayCapUsd - status.todaySpendUsd);
  const effectiveAvailableUsd = testBalanceOverrideUsd !== null
    ? testBalanceOverrideUsd
    : Math.min(status.availableBalanceUsd, remainingDailyUsd);
  // 10% safety margin on effective available balance
  const safeBudgetUsd = Math.max(0, effectiveAvailableUsd * 0.90);

  const unitCost = primaryUnitCostUsd > 0 ? primaryUnitCostUsd : 0.001;
  const estimatedCostUsd = targetVolume * unitCost;

  if (estimatedCostUsd <= safeBudgetUsd) {
    return {
      allowed: true,
      safeBudgetUsd,
      availableBalanceUsd: status.availableBalanceUsd,
      originalVolume: targetVolume,
      maxSafeVolume: targetVolume,
      downscaled: false,
    };
  }

  const maxSafeVolume = Math.max(0, Math.floor(safeBudgetUsd / unitCost));
  return {
    allowed: maxSafeVolume > 0,
    safeBudgetUsd,
    availableBalanceUsd: status.availableBalanceUsd,
    originalVolume: targetVolume,
    maxSafeVolume,
    downscaled: true,
    reasonAr: maxSafeVolume > 0
      ? `تم تعديل الحد الأقصى إلى ${maxSafeVolume} سجل لضمان دقة وسرعة التنفيذ المباشر`
      : "سعة الاستخراج الفورية مكتملة حالياً، يرجى المحاولة لاحقاً",
  };
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
