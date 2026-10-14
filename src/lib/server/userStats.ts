import { Query, listAll } from "./adminAuth";

/** Available points = sum of ledger deltas (holds are negative entries). */
export async function ledgerBalance(tables: any, userId: string): Promise<number> {
  const rows = await listAll(tables, "credit_ledger", [Query.equal("userId", userId)], 5000);
  return rows.reduce((a, r) => a + (r.delta || 0), 0);
}

export interface TopupSummary { total: number; last: string | null; count: number; approvedCount: number }

export function summarizeTopups(rows: any[]): TopupSummary {
  const approved = rows.filter((r) => r.status === "approved");
  const last = approved.map((r) => r.reviewedAt || r.createdAt).sort().pop() ?? null;
  return { total: approved.reduce((a, r) => a + (r.confirmedAmountEgp || r.amountEgp || 0), 0), last, count: rows.length, approvedCount: approved.length };
}
