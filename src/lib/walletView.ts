import { classifyLedgerRow, type CreditKind } from "./creditKinds";

/** The fields of a ledger row the wallet screen reads (the page's LedgerRow satisfies it). */
export interface WalletLedgerRow {
  $id?: string;
  id?: string;
  type?: string;
  kind?: string;
  delta: number;
  jobId?: string | null;
  topupId?: string | null;
  createdAt: string;
}

export type WalletLedgerKind = "topup" | "charge" | "refund";
export type WalletLedgerFilter = "all" | WalletLedgerKind;

export const kindOfLedgerRow = (row: Pick<WalletLedgerRow, "type" | "kind">): WalletLedgerKind => {
  const kind: CreditKind = classifyLedgerRow({ type: row.type, kind: row.kind });
  return kind === "release" ? "refund" : kind === "reserve" || kind === "charge" ? "charge" : "topup";
};

/** «الكل» lists every row; a typed tab lists the rows of that kind. Never stricter than a typed tab. */
export const visibleLedgerRows = <T extends WalletLedgerRow>(rows: T[], filter: WalletLedgerFilter): T[] =>
  rows.filter((row) => filter === "all" || kindOfLedgerRow(row) === filter);

/**
 * The top-up a ledger row credited. `approve_topup_atomic` writes the row as `top_<topupId>` and leaves `topup_id` empty; the
 * older fallback writer sets `topup_id`. Both are the same row of the same top-up.
 */
export function ledgerTopupId(row: Pick<WalletLedgerRow, "id" | "$id" | "type" | "topupId">): string | null {
  if (row.topupId) return row.topupId;
  const id = row.id || row.$id || "";
  return row.type === "topup" && id.startsWith("top_") && id.length > 4 ? id.slice(4) : null;
}

/** Points each approved top-up credited, exactly as stored in the ledger row (sum of its positive top-up rows). */
export function creditedPointsByTopup(rows: WalletLedgerRow[]): Map<string, number> {
  const byTopup = new Map<string, number>();
  for (const row of rows) {
    const topupId = row.type === "topup" && row.delta > 0 ? ledgerTopupId(row) : null;
    if (topupId) byTopup.set(topupId, (byTopup.get(topupId) || 0) + row.delta);
  }
  return byTopup;
}

/**
 * The points an approved top-up credited, or null when neither the top-up row nor its ledger row is known (yet). Never recomputed
 * from the amount: an unknown figure is shown as unknown, not as zero.
 */
export function creditedPointsOf(topup: { $id: string; credits?: number | null }, byTopup: Map<string, number>): number | null {
  if (topup.credits && topup.credits > 0) return topup.credits;
  return byTopup.get(topup.$id) ?? null;
}

export interface WalletMonthStats {
  /** Points held by searches still running (reserved, not yet released). */
  held: number;
  /** Points deducted for delivered records this month (charge rows). */
  charged: number;
  /**
   * Points held this month and then lifted without being deducted: the unused part of a finished search's hold (reserve buffer
   * included) and the whole hold of a failed one. This is NOT a refund of money the customer paid.
   */
  releasedHold: number;
  releasedJobs: number;
}

/** Month figures from the ledger. `now` is injected so the month boundary can be tested. */
export function walletMonthStats(rows: WalletLedgerRow[], now: Date = new Date()): WalletMonthStats {
  const start = new Date(now); start.setDate(1); start.setHours(0, 0, 0, 0);
  const inMonth = (r: WalletLedgerRow) => new Date(r.createdAt) >= start;
  const byJob = new Map<string, { reserve: number; release: number; charge: number; releaseInMonth: boolean }>();
  for (const r of rows) {
    if (!r.jobId) continue;
    const j = byJob.get(r.jobId) ?? { reserve: 0, release: 0, charge: 0, releaseInMonth: false };
    if (r.type === "reserve") j.reserve += Math.abs(r.delta);
    if (r.type === "release") { j.release += Math.abs(r.delta); j.releaseInMonth = inMonth(r); }
    if (r.type === "charge") j.charge += Math.abs(r.delta);
    byJob.set(r.jobId, j);
  }
  let held = 0, releasedHold = 0, releasedJobs = 0;
  for (const j of byJob.values()) {
    if (j.reserve > 0 && j.release === 0) held += j.reserve;
    if (j.releaseInMonth) {
      const lifted = Math.max(0, j.release - j.charge);
      if (lifted > 0) { releasedHold += lifted; releasedJobs += 1; }
    }
  }
  const charged = rows.filter((r) => r.type === "charge" && inMonth(r)).reduce((a, r) => a + Math.abs(r.delta), 0);
  return { held, charged, releasedHold, releasedJobs };
}
