import { DEFAULT_MISSION_PRICING_SETTINGS } from "../missionPricing";
import { bannedUntilOf } from "./accountSuspension";
import { ACTIVE_DAYS, NEW_DAYS, USERS_SCAN_CAP, type UserSegment, type UserSort } from "../adminUsers";

/**
 * THE USERS LIST'S NUMBERS (DT-20261118-06 phase 1B). Read only. Balances come from ONE grouped read of the ledger per request (pages of 1,000 rows, summed per person in memory):
 * never one read per person (Gate 1 P1-3). The ledger code and the ledger itself are not touched; the sum is the same one `ledgerBalance` makes (Σ delta).
 */

/** «رصيد منخفض»: below the minimum charge of one mission (the pricing default, read only). */
export const LOW_BALANCE_POINTS = DEFAULT_MISSION_PRICING_SETTINGS.minChargePoints;
export const LEDGER_PAGE_ROWS = 1000;
/** At most 500 pages (500,000 ledger rows) per request; more sets `complete: false`. */
export const LEDGER_PAGE_CAP = 500;
export const AUTH_PAGE_USERS = 1000;
const DAY_MS = 86_400_000;

/** Σ delta per person over the whole ledger, in pages of 1,000 rows (user id and amount only). */
export async function readBalances(client: any): Promise<{ balances: Map<string, number>; complete: boolean; failed: boolean }> {
  const balances = new Map<string, number>();
  for (let page = 0; page < LEDGER_PAGE_CAP; page++) {
    const from = page * LEDGER_PAGE_ROWS;
    const { data, error } = await client.from("credit_ledger").select("user_id,delta").order("id", { ascending: true }).range(from, from + LEDGER_PAGE_ROWS - 1);
    if (error) return { balances, complete: false, failed: true };
    const rows: Array<{ user_id: string; delta: unknown }> = Array.isArray(data) ? data : [];
    for (const r of rows) balances.set(r.user_id, (balances.get(r.user_id) ?? 0) + (Number(r.delta) || 0));
    if (rows.length < LEDGER_PAGE_ROWS) return { balances, complete: true, failed: false };
  }
  return { balances, complete: false, failed: false };
}

/** The accounts whose sign-in ban (`banned_until`) is still in the future, read from the sign-in service in pages of 1,000 within the scan cap. */
export async function readSuspendedIds(client: any, now: number): Promise<{ ids: Set<string>; complete: boolean }> {
  const ids = new Set<string>();
  const pages = Math.ceil(USERS_SCAN_CAP / AUTH_PAGE_USERS);
  for (let page = 1; page <= pages; page++) {
    const res = await Promise.resolve(client.auth.admin.listUsers({ page, perPage: AUTH_PAGE_USERS })).catch(() => null);
    const users = res?.data?.users;
    if (!res || res.error || !Array.isArray(users)) return { ids, complete: false };
    for (const u of users) {
      const until = bannedUntilOf(u);
      if (until !== null && until > now) ids.add(String(u.id));
    }
    if (users.length < AUTH_PAGE_USERS) return { ids, complete: true };
  }
  return { ids, complete: false };
}

export interface ListedUser {
  id: string;
  registeredMs: number;
  accessedMs: number;
  balance: number;
  topupsEgp: number;
  paid: boolean;
  suspended: boolean;
}

const ms = (iso: unknown) => {
  const t = typeof iso === "string" ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : -Infinity;
};
export const listedTimes = (u: { registration?: unknown; accessedAt?: unknown }) => ({ registeredMs: ms(u.registration), accessedMs: ms(u.accessedAt) });

/** Is this person in the chip? */
export function inSegment(segment: UserSegment, p: ListedUser, now: number): boolean {
  const month = now - ACTIVE_DAYS * DAY_MS;
  switch (segment) {
    case "active": return p.accessedMs >= month;
    case "inactive": return !(p.accessedMs >= month);
    case "new": return p.registeredMs >= now - NEW_DAYS * DAY_MS;
    case "zero": return !p.paid;
    case "low": return p.balance < LOW_BALANCE_POINTS;
    case "suspended": return p.suspended;
    default: return true;
  }
}

/** Largest first; a tie keeps the newest registration first. */
export function compareUsers(sort: UserSort): (a: ListedUser, b: ListedUser) => number {
  const key = (p: ListedUser) => (sort === "balance" ? p.balance : sort === "topups" ? p.topupsEgp : sort === "registered" ? p.registeredMs : p.accessedMs);
  return (a, b) => {
    const d = key(b) - key(a);
    if (d !== 0 && Number.isFinite(d)) return d;
    if (key(a) !== key(b)) return key(a) === -Infinity ? 1 : -1;
    return b.registeredMs - a.registeredMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  };
}
