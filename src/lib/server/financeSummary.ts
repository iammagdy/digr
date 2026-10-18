import { isRealIncomeKind, type CreditKind } from "../creditKinds";

export interface FinanceLedgerRow {
  delta: number;
  kind: CreditKind;
  createdAt: string;
}

export interface FinanceTopup {
  /** confirmed amount if set, else the requested amount */
  amountEgp: number;
  /** when the top-up was approved (ledger row time) */
  approvedAt: string | null;
}

export interface CreditSummary {
  /** Approved Instapay top-ups only. */
  realIncome: { egp: number; points: number; count: number };
  promoPoints: number;
  adminGrantPoints: number;
  consumedPoints: number;
  refundedPoints: number;
  /** All points still owed to customers at the end of the period (every row up to `to`, never filtered by kind). */
  outstandingPoints: number;
  from: string | null;
  to: string | null;
}

/**
 * Finance summary with real income kept apart from free credit. `rows` are all ledger rows up to the end of the period
 * (needed for the outstanding total); the in-period figures use only rows inside [from, to).
 */
export function summarizeCredit(
  rows: FinanceLedgerRow[],
  topups: FinanceTopup[],
  period: { from?: string | null; to?: string | null } = {},
): CreditSummary {
  const from = period.from ? new Date(period.from).getTime() : -Infinity;
  const to = period.to ? new Date(period.to).getTime() : Infinity;
  const within = (iso: string | null | undefined) => {
    if (!iso) return false;
    const t = new Date(iso).getTime();
    return t >= from && t < to;
  };
  const upToEnd = rows.filter((r) => new Date(r.createdAt).getTime() < to);

  let incomePoints = 0, incomeCount = 0, promo = 0, admin = 0, consumed = 0, refunded = 0;
  for (const row of upToEnd.filter((r) => within(r.createdAt))) {
    if (isRealIncomeKind(row.kind)) { incomePoints += row.delta; incomeCount += 1; }
    else if (row.kind === "promo_code") promo += row.delta;
    else if (row.kind === "admin_grant") admin += row.delta;
    else if (row.kind === "charge") consumed += Math.abs(row.delta);
    else if (row.kind === "release") refunded += row.delta;
  }
  const incomeEgp = topups.filter((t) => within(t.approvedAt)).reduce((a, t) => a + (Number(t.amountEgp) || 0), 0);
  return {
    realIncome: { egp: incomeEgp, points: incomePoints, count: incomeCount },
    promoPoints: promo,
    adminGrantPoints: admin,
    consumedPoints: consumed,
    refundedPoints: refunded,
    outstandingPoints: upToEnd.reduce((a, r) => a + r.delta, 0),
    from: period.from ?? null,
    to: period.to ?? null,
  };
}
