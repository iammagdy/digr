import { readProviderKeySettings } from "./providerKeyAdmin";
import { resolveProviderKey } from "./providerKeys";
import { getProviderStatus, lastGoodProviderBalance, type FetchLike } from "./providerStatus";

/**
 * The provider balance the plan capacity gate budgets against: the REAL balance, read from the provider with the same authenticated call and
 * the same 60 s cached read the admin «مزودو الخدمة» tab shows, not the configured credit minus the recorded spend (an estimate that drifts
 * the moment the account is recharged or the recorded spend is not the whole story).
 *
 * The plan path is never slowed by it: the read has a short budget, and when it cannot answer in time or at all, the last reading the provider
 * really gave is used if it is no older than a few minutes; otherwise the caller falls back to the estimate it had before.
 */
export const REAL_BALANCE_MAX_AGE_MS = 5 * 60_000;
/** The whole read (key, settings, identity call, balance call) may take this long before the plan goes on without it. */
export const REAL_BALANCE_READ_BUDGET_MS = 700;
/** Each of the two provider calls is cut at this. */
export const REAL_BALANCE_CALL_TIMEOUT_MS = 350;

export interface RealBalanceReading {
  usd: number;
  /** When the provider gave this figure (ms). */
  at: number;
  source: "live" | "last_reading";
}

export type RealBalanceReader = () => Promise<{ usd: number; at: number } | null>;

let injectedReader: RealBalanceReader | null = null;
/** Test-only: replace the live read (null restores it). */
export function setRealBalanceReaderForTesting(reader: RealBalanceReader | null): void {
  injectedReader = reader;
}

let inflight: Promise<{ usd: number; at: number } | null> | null = null;

async function liveRead(client: any, fetchFn?: FetchLike): Promise<{ usd: number; at: number } | null> {
  if (injectedReader) return injectedReader();
  // Offline test runs never reach the provider unless a test hands in its own fetch.
  if (process.env.VITEST === "true" && !fetchFn) return null;
  const key = await resolveProviderKey("treg");
  if (!key.key) return null;
  const settings = client ? await readProviderKeySettings(client) : null;
  const snapshot = await getProviderStatus("treg", key.key, { orgIdOverride: settings?.tregOrgId ?? null, timeoutMs: REAL_BALANCE_CALL_TIMEOUT_MS, ...(fetchFn ? { fetchFn } : {}) });
  if (!snapshot.balance.available || typeof snapshot.balance.balanceUsd !== "number") return null;
  const at = Date.parse(snapshot.balance.checkedAt);
  return { usd: snapshot.balance.balanceUsd, at: Number.isFinite(at) ? at : Date.now() };
}

const usable = (usd: unknown): usd is number => typeof usd === "number" && Number.isFinite(usd) && usd >= 0;

/**
 * The real balance in USD with its age, or null when there is none to rely on (no key, the read failed or timed out and no recent reading
 * exists, or the figure is not a non-negative number). Never throws and never waits longer than REAL_BALANCE_READ_BUDGET_MS.
 */
export async function readRealProviderBalance(client?: any, options?: { now?: () => number; fetchFn?: FetchLike; budgetMs?: number }): Promise<RealBalanceReading | null> {
  const now = options?.now ?? (() => Date.now());
  const budgetMs = options?.budgetMs ?? REAL_BALANCE_READ_BUDGET_MS;
  let fresh: { usd: number; at: number } | null = null;
  try {
    inflight ||= liveRead(client, options?.fetchFn).finally(() => { inflight = null; });
    const attempt = inflight;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), budgetMs); });
    try {
      fresh = await Promise.race([attempt.catch(() => null), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  } catch {
    fresh = null;
  }
  if (fresh && usable(fresh.usd) && now() - fresh.at <= REAL_BALANCE_MAX_AGE_MS) return { usd: fresh.usd, at: fresh.at, source: "live" };
  // The read failed, timed out or was not usable: the last figure the provider really gave, if it is recent enough.
  const last = injectedReader ? null : lastGoodProviderBalance();
  if (last && now() - last.at <= REAL_BALANCE_MAX_AGE_MS) {
    const usd = last.balanceMicro / 1_000_000;
    if (usable(usd)) return { usd, at: last.at, source: "last_reading" };
  }
  return null;
}
