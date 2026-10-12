import { ID, TablesDB } from "node-appwrite";

let cachedRate: { value: number; at: number } | null = null;

/** USD → EGP from the private settings row (falls back to USD_TO_EGP / 55). Cached for 10 minutes. */
async function usdToEgp(tables: TablesDB): Promise<number> {
  if (cachedRate && Date.now() - cachedRate.at < 600000) return cachedRate.value;
  let rate = Number(process.env.USD_TO_EGP) || 55;
  try {
    const row: any = await tables.getRow({ databaseId: "digr", tableId: "settings", rowId: "pricing" });
    if (Number(row?.usdToEgp) > 0) rate = Number(row.usdToEgp);
  } catch { /* keep the fallback */ }
  cachedRate = { value: rate, at: Date.now() };
  return rate;
}

export interface ProviderCostInput {
  jobId?: string | null;
  provider: "treg" | "llm";
  /** TREG: calls (1); LLM: total tokens */
  units: number;
  costUsd: number;
}

/**
 * Every call to TREG and to the model writes `{ jobId, provider, units, costEgp, at }` so the admin
 * profit numbers are real. Best effort: logging must never fail the user's request or job.
 */
export async function logProviderCost(tables: TablesDB, input: ProviderCostInput): Promise<void> {
  if (!(input.costUsd > 0)) return;
  try {
    const rate = await usdToEgp(tables);
    await tables.createRow({
      databaseId: "digr",
      tableId: "provider_costs",
      rowId: ID.unique(),
      data: {
        jobId: input.jobId ?? null,
        provider: input.provider,
        units: input.units,
        costEgp: Number((input.costUsd * rate).toFixed(4)),
        at: new Date().toISOString(),
      },
    });
  } catch (e: any) {
    console.warn("[provider_costs:LOG_FAILED]", e?.message || e);
  }
}
