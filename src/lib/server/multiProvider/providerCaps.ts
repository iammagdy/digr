import { resolveProviderLimits, PROVIDER_LIMITS_KEY, MAX_LIMIT_USD } from "../providerLimits";
import { selectAllRows } from "../selectAll";
import type { DataProviderId } from "../../multiProvider/types";

/**
 * Per-provider daily caps. TREG keeps the existing `dailyUsd` limit exactly as it is. Firecrawl and Context.dev have their own
 * admin-editable daily limits, stored as two more keys of the SAME settings row (`firecrawlDailyUsd`, `contextdevDailyUsd`), written by
 * the same audited SQL function once the proposal in docs/proposals/multi-provider/ is applied. Until the owner sets one, the cap is 0:
 * a provider with no cap set can spend nothing, so no route that needs it is ever allowed.
 */
export const PROVIDER_CAP_KEYS: Record<Exclude<DataProviderId, "treg">, "firecrawlDailyUsd" | "contextdevDailyUsd"> = {
  firecrawl: "firecrawlDailyUsd",
  contextdev: "contextdevDailyUsd",
};

const validUsd = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= MAX_LIMIT_USD;

async function readStoredCaps(client: any): Promise<Partial<Record<"firecrawlDailyUsd" | "contextdevDailyUsd", number>>> {
  try {
    const { data, error } = await client.from("settings_private").select("value").eq("key", PROVIDER_LIMITS_KEY).maybeSingle();
    if (error) return {};
    const v = data?.value && typeof data.value === "object" ? data.value : {};
    const out: Partial<Record<"firecrawlDailyUsd" | "contextdevDailyUsd", number>> = {};
    if (validUsd(v.firecrawlDailyUsd)) out.firecrawlDailyUsd = v.firecrawlDailyUsd;
    if (validUsd(v.contextdevDailyUsd)) out.contextdevDailyUsd = v.contextdevDailyUsd;
    return out;
  } catch {
    return {};
  }
}

/** The daily cap (USD) of one provider in force: TREG from the existing resolver, the others from the settings row (0 until set). */
export async function resolveProviderDailyCapUsd(client: any, provider: DataProviderId): Promise<number> {
  if (provider === "treg") return (await resolveProviderLimits(client)).limits.dailyUsd;
  const stored = await readStoredCaps(client);
  return stored[PROVIDER_CAP_KEYS[provider]] ?? 0;
}

export async function resolveAllProviderDailyCaps(client: any): Promise<Record<DataProviderId, number>> {
  const [treg, stored] = await Promise.all([resolveProviderLimits(client).then((r) => r.limits.dailyUsd).catch(() => 0), readStoredCaps(client)]);
  return { treg, firecrawl: stored.firecrawlDailyUsd ?? 0, contextdev: stored.contextdevDailyUsd ?? 0 };
}

function utcDayStart(): string {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate())).toISOString();
}

const sum = (rows: any[] | null | undefined) => (rows || []).reduce((a, r) => { const c = Number(r?.cost_usd); return Number.isFinite(c) && c > 0 ? a + c : a; }, 0);

/** What one provider has really cost since the UTC day began, read from provider_costs (read only). Null when it cannot be read. */
export async function readProviderSpendToday(client: any, provider: DataProviderId): Promise<number | null> {
  try {
    const { data, error } = await selectAllRows(() => client.from("provider_costs").select("cost_usd").eq("provider", provider).gte("created_at", utcDayStart()), { orderBy: "id" });
    if (error) return null;
    return sum(data);
  } catch {
    return null;
  }
}

/** What the providers have cost one job so far (all providers), read only. */
export async function readJobProviderSpendUsd(client: any, jobId: string): Promise<number> {
  try {
    const { data } = await selectAllRows(() => client.from("provider_costs").select("cost_usd, provider").eq("job_id", jobId).in("provider", ["treg", "firecrawl", "contextdev"]), { orderBy: "id" });
    return sum(data);
  } catch {
    return 0;
  }
}

export async function readJobProviderSpend(client: any, jobId: string): Promise<{ usd: number; calls: number }> {
  const { data, error, truncated } = await selectAllRows(
    () => client.from("provider_costs").select("cost_usd, provider").eq("job_id", jobId).in("provider", ["treg", "firecrawl", "contextdev"]),
    { orderBy: "id" }
  );
  if (error || !Array.isArray(data) || truncated === true) {
    throw new Error("job_spend_unreadable");
  }
  return { usd: sum(data), calls: data.length };
}

export async function readJobLease(client: any, jobId: string): Promise<{ step: number; status: string; leaseUntil: string | null }> {
  const { data, error } = await client.from("jobs").select("step, status, lease_until").eq("id", jobId).maybeSingle();
  if (error || !data || !Number.isFinite(Number(data.step))) {
    throw new Error("job_lease_unreadable");
  }
  return { step: Number(data.step), status: String(data.status ?? ""), leaseUntil: typeof data.lease_until === "string" ? data.lease_until : null };
}

export async function readJobCreatedAtMs(client: any, jobId: string): Promise<number> {
  const { data, error } = await client.from("jobs").select("created_at").eq("id", jobId).maybeSingle();
  const parsed = data ? Date.parse(String(data.created_at)) : NaN;
  if (error || !data || !Number.isFinite(parsed)) {
    throw new Error("job_created_unreadable");
  }
  return parsed;
}
