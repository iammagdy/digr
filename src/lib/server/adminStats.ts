/** Pure aggregation helpers for the admin dashboard (unit-tested). */

export const DAY_MS = 86400000;

/** 0 = today (last 24h), 1 = the day before, … Returns -1 for future timestamps. */
export function dayIndex(iso: string | undefined | null, now: number): number {
  if (!iso) return -1;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t) || t > now) return -1;
  return Math.floor((now - t) / DAY_MS);
}

/** Sums `value(row)` into 2R day buckets (index 0 = today). */
export function bucketDays<T>(rows: T[], range: number, now: number, at: (r: T) => string | undefined | null, value: (r: T) => number): number[] {
  const out = new Array<number>(range * 2).fill(0);
  for (const r of rows) {
    const i = dayIndex(at(r), now);
    if (i >= 0 && i < range * 2) out[i] += value(r);
  }
  return out;
}

export interface PeriodSplit {
  /** Oldest → newest, length = range */
  current: number[];
  /** Oldest → newest, length = range */
  previous: number[];
  sumCurrent: number;
  sumPrevious: number;
}

export function splitPeriods(daily: number[], range: number): PeriodSplit {
  const cur = daily.slice(0, range).reverse();
  const prev = daily.slice(range, range * 2).reverse();
  return { current: cur, previous: prev, sumCurrent: cur.reduce((a, b) => a + b, 0), sumPrevious: prev.reduce((a, b) => a + b, 0) };
}

/** % change vs the previous period (0 when there is no baseline). */
export function pctChange(current: number, previous: number): number {
  return previous ? ((current - previous) / previous) * 100 : 0;
}

/** Revenue (top-ups) minus provider cost. */
export function netProfit(rev: number, cost: number): number { return rev - cost; }

/** Margin in % (null when there is no revenue). */
export function margin(rev: number, cost: number): number | null {
  return rev > 0 ? ((rev - cost) / rev) * 100 : null;
}

/** Per-job refund = released − charged (a failed job releases everything and charges nothing). */
export function refundPointsByJob(ledger: Array<{ type: string; jobId?: string | null; delta: number; createdAt: string }>): Map<string, { refund: number; at: string }> {
  const m = new Map<string, { release: number; charge: number; at: string }>();
  for (const l of ledger) {
    if (!l.jobId) continue;
    const e = m.get(l.jobId) ?? { release: 0, charge: 0, at: l.createdAt };
    if (l.type === "release") { e.release += Math.abs(l.delta); e.at = l.createdAt; }
    if (l.type === "charge") e.charge += Math.abs(l.delta);
    m.set(l.jobId, e);
  }
  const out = new Map<string, { refund: number; at: string }>();
  for (const [id, e] of m) if (e.release > 0) out.set(id, { refund: Math.max(0, e.release - e.charge), at: e.at });
  return out;
}

export function monthKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** Last `n` calendar months, newest first, as «YYYY-MM» keys. */
export function lastMonths(n: number, now = new Date()): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

const AR_MONTHS = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];
export function monthLabelAr(key: string, current: boolean): string {
  const [y, m] = key.split("-").map(Number);
  const arY = String(y).replace(/\d/g, (d) => String.fromCharCode(0x0660 + Number(d)));
  return `${AR_MONTHS[m - 1]} ${arY}${current ? " (حتى الآن)" : ""}`;
}
