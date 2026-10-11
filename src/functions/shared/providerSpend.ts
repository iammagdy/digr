import { TablesDB, Query } from "node-appwrite";

export const DEFAULT_PROVIDER_DAILY_SPEND_CAP_USD = 0.80;
export const DEFAULT_JOB_POINTS_CAP = 600;

let memoryDailySpendMicro = 0;
let memoryDailySpendDay = new Date().toISOString().slice(0, 10);

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

export async function recordProviderCallSpend(costMicro: number, tables?: TablesDB | null): Promise<void> {
  checkAndResetDay();
  if (costMicro > 0) {
    memoryDailySpendMicro += costMicro;
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

export function resetProviderDailySpendForTesting(): void {
  memoryDailySpendMicro = 0;
  memoryDailySpendDay = new Date().toISOString().slice(0, 10);
}

export function setMemoryProviderDailySpendUsdForTesting(usd: number): void {
  memoryDailySpendDay = new Date().toISOString().slice(0, 10);
  memoryDailySpendMicro = Math.round(usd * 1_000_000);
}
