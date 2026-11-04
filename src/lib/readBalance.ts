import { balanceFailed, balanceReady, type BalanceView } from "./honestDisplay";

/**
 * One read of the signed-in customer's balance, for the header and the wallet.
 * The source and its rules are unchanged: the shared server endpoint first (it sums the whole ledger), then the customer's own ledger rows (filtered by their account) when
 * the endpoint does not answer; a failure of both is «failed», never a zero.
 * New: the account comes from the stored session itself (read once), so the read does not have to wait for the page to render the user first.
 * `knownUserId` is only used when the session carries no id (never in practice).
 */
export interface SessionReader {
  auth: { getSession: () => Promise<{ data: { session: { access_token?: string; user?: { id?: string } } | null } | null }> };
  from: (table: string) => any;
}

export async function readBalanceForSession(
  supabase: SessionReader,
  fetchFn: typeof fetch,
  knownUserId: string | null,
): Promise<{ ownerId: string; balance: BalanceView } | null> {
  const { data: sessionData } = await supabase.auth.getSession();
  const session = sessionData?.session ?? null;
  const ownerId = session?.user?.id ?? knownUserId;
  if (!ownerId) return null;
  try {
    const headers: Record<string, string> = {};
    if (session?.access_token) headers["Authorization"] = `Bearer ${session.access_token}`;

    // 1. Primary: the shared server-side balance endpoint.
    const res = await fetchFn("/api/wallet/balance", { headers }).catch(() => null);
    if (res && res.ok) {
      const json = await res.json().catch(() => null);
      if (json?.success && typeof json.balance === "number") return { ownerId, balance: balanceReady(json.balance) };
    }

    // 2. Direct client fallback, strictly filtered by the account.
    const { data, error } = await supabase.from("credit_ledger").select("delta").eq("user_id", ownerId);
    if (error) return { ownerId, balance: balanceFailed() };
    const total = ((data as Array<{ delta?: unknown }> | null) || []).reduce((sum, row) => sum + (Number(row.delta) || 0), 0);
    return { ownerId, balance: balanceReady(total) };
  } catch {
    return { ownerId, balance: balanceFailed() };
  }
}
