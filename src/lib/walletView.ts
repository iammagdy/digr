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
  /**
   * The same releases as the ledger lines show them: each release row lifts the WHOLE hold of a search (release first), and the charge for what was
   * delivered is a separate line after it. `releasedHold` is this figure minus those charges.
   */
  releasedGross: number;
}

/** The business clock of the month: Cairo. A release made at 01:00 on the 1st in Cairo is in that month, whatever the server's own zone is. */
const BUSINESS_TIME_ZONE = "Africa/Cairo";

/**
 * The instant the Cairo calendar month of `now` starts (00:00 Cairo time). Read through Intl, so the Cairo offset of that very date (summer or winter)
 * is used, never a fixed one. The server's own zone (UTC on the hosting) must not decide the boundary: that was the off-by-one of the wallet counter.
 */
export function cairoMonthStartMs(now: Date): number {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: BUSINESS_TIME_ZONE, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
  const wallMs = (ms: number) => {
    const p: Record<string, string> = {};
    for (const part of fmt.formatToParts(new Date(ms))) p[part.type] = part.value;
    return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  };
  const offsetAt = (ms: number) => wallMs(ms) - ms;
  const cairoNow = new Date(wallMs(now.getTime()));
  const wallStart = Date.UTC(cairoNow.getUTCFullYear(), cairoNow.getUTCMonth(), 1);
  const guess = wallStart - offsetAt(now.getTime());
  return wallStart - offsetAt(guess);
}

/** Month figures from the ledger. `now` is injected so the month boundary can be tested. */
export function walletMonthStats(rows: WalletLedgerRow[], now: Date = new Date()): WalletMonthStats {
  const startMs = cairoMonthStartMs(now);
  const inMonth = (r: WalletLedgerRow) => new Date(r.createdAt).getTime() >= startMs;
  const byJob = new Map<string, { reserve: number; release: number; charge: number; releaseInMonth: boolean }>();
  for (const r of rows) {
    if (!r.jobId) continue;
    const j = byJob.get(r.jobId) ?? { reserve: 0, release: 0, charge: 0, releaseInMonth: false };
    if (r.type === "reserve") j.reserve += Math.abs(r.delta);
    if (r.type === "release") { j.release += Math.abs(r.delta); j.releaseInMonth = inMonth(r); }
    if (r.type === "charge") j.charge += Math.abs(r.delta);
    byJob.set(r.jobId, j);
  }
  let held = 0, releasedHold = 0, releasedJobs = 0, releasedGross = 0;
  for (const j of byJob.values()) {
    if (j.reserve > 0 && j.release === 0) held += j.reserve;
    if (j.releaseInMonth) {
      const lifted = Math.max(0, j.release - j.charge);
      if (lifted > 0) { releasedHold += lifted; releasedJobs += 1; releasedGross += j.release; }
    }
  }
  const charged = rows.filter((r) => r.type === "charge" && inMonth(r)).reduce((a, r) => a + Math.abs(r.delta), 0);
  return { held, charged, releasedHold, releasedJobs, releasedGross };
}


/**
 * WHAT ONE JOB'S LEDGER ROWS SAY, the numbers a wallet line is built from. The same grouping and the same reading of a row as `walletMonthStats` above (by `job_id`; by `type` reserve / release / charge; the size of a row is
 * `Math.abs(delta)`), and the same sign the balance uses (`calculateBalance` in supabase/ledger.ts sums `delta` over the customer's rows: a reserve and a charge are negative, a release positive). `net` is that plain sum for the
 * job's rows: reserved, released and charged always satisfy `net === released - reserved - charged` while the job has only those three types. A job linked to a row of ANOTHER type (a goodwill adjustment, for example)
 * is marked `otherTypes`: its net no longer equals what these three numbers say, so no summary line is made for it and its rows are listed one by one (the balance and the line can then never disagree).
 */
export interface JobLedgerTotals {
  /** Points held when the job was approved (the reserve rows). */
  reserved: number;
  /** Points lifted from the hold (the release rows). A release lifts the WHOLE hold, and the charge for what was delivered is a separate row after it. */
  released: number;
  /** Points deducted for what was delivered (the charge rows). */
  charged: number;
  /** The plain sum of the job's `delta`, exactly what the balance adds up for these rows. */
  net: number;
  otherTypes: boolean;
  rows: number;
}

export interface JobLedgerRow { jobId?: string | null; type?: string; delta: number }

export function jobLedgerTotals(rows: ReadonlyArray<JobLedgerRow>): Map<string, JobLedgerTotals> {
  const byJob = new Map<string, JobLedgerTotals>();
  for (const r of rows) {
    if (!r.jobId) continue;
    const j = byJob.get(r.jobId) ?? { reserved: 0, released: 0, charged: 0, net: 0, otherTypes: false, rows: 0 };
    if (r.type === "reserve") j.reserved += Math.abs(r.delta);
    else if (r.type === "release") j.released += Math.abs(r.delta);
    else if (r.type === "charge") j.charged += Math.abs(r.delta);
    else j.otherTypes = true;
    j.net += r.delta;
    j.rows += 1;
    byJob.set(r.jobId, j);
  }
  return byJob;
}

/** A ledger row as the wallet groups it: any row; the ones that belong to a finished mission carry its one money line (the server computed it from the mission's own numbers). */
export interface MissionGroupableRow { $id?: string; id?: string; jobId?: string | null; missionLineAr?: string | null }
export type WalletEntry<T extends MissionGroupableRow> = { kind: "row"; row: T } | { kind: "mission"; jobId: string; lineAr: string; rows: T[] };

/**
 * THE WALLET LISTS A MISSION ONCE. The rows of one mission (the hold, the charge, the released hold) are separate ledger rows and stay exactly as they are; the wallet shows them under ONE line («خُصم ١٢٨ نقطة مقابل ١٩٢ تغريدة»)
 * with the rows themselves as collapsible details. The group sits where its newest row is; rows of no finished mission (a top-up, a promo, a hold of a mission that is still running) stay single entries.
 */
export function groupMissionRows<T extends MissionGroupableRow>(rows: ReadonlyArray<T>): Array<WalletEntry<T>> {
  const out: Array<WalletEntry<T>> = [];
  const at = new Map<string, number>();
  for (const row of rows) {
    const jobId = row.jobId ?? null;
    const line = row.missionLineAr ?? null;
    if (!jobId || !line) { out.push({ kind: "row", row }); continue; }
    const i = at.get(jobId);
    if (i === undefined) { at.set(jobId, out.length); out.push({ kind: "mission", jobId, lineAr: line, rows: [row] }); }
    else (out[i] as Extract<WalletEntry<T>, { kind: "mission" }>).rows.push(row);
  }
  return out;
}
