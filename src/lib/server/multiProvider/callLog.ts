import { capabilityById } from "../../multiProvider/catalog";
import { DATA_PROVIDER_IDS, type DataProviderId } from "../../multiProvider/types";
import { selectAllRows } from "../selectAll";

/**
 * The per-provider API call log of the admin tab. READ ONLY: it reads provider_costs and never writes (admin pages never write to money
 * tables). Every row of one provider's tab is a row with THAT provider's identifier; the totals are sums of the same rows.
 *
 * What a call row carries beyond the existing columns (capability, status, duration) arrives with the SQL proposal in
 * docs/proposals/multi-provider/. Before it is applied the log still lists every call (time, job, units, cost) and says «غير متاح»
 * for the three fields it cannot know: it never invents them.
 */
export const CALL_LOG_PAGE_SIZE = 25;
export const CALL_STATUSES = ["success", "failed", "empty"] as const;
export type CallLogStatus = (typeof CALL_STATUSES)[number];

export const isDataProviderId = (v: unknown): v is DataProviderId => typeof v === "string" && (DATA_PROVIDER_IDS as readonly string[]).includes(v);

export interface CallLogQuery {
  provider: DataProviderId;
  /** UTC dates, inclusive: «2026-10-22». */
  from?: string | null;
  to?: string | null;
  status?: CallLogStatus | null;
  page?: number;
}

export interface CallLogRow {
  id: number | null;
  at: string;
  /** Arabic internal label of the capability (admin only), or null when the row does not say. */
  capabilityLabelAr: string | null;
  jobId: string | null;
  units: number;
  costUsd: number;
  status: CallLogStatus | null;
  durationMs: number | null;
  /** A reserved estimate that was never committed (a call in flight, or one that did not report back). */
  isEstimate: boolean;
}

export interface CallLogResult {
  provider: DataProviderId;
  rows: CallLogRow[];
  page: number;
  pageSize: number;
  total: number;
  /** Whether the database knows capability, status and duration (the SQL proposal is applied). */
  metadataAvailable: boolean;
  filtersApplied: { from: string | null; to: string | null; status: CallLogStatus | null };
  /** The status filter cannot be applied before the proposal is applied; the screen says so. */
  statusFilterUnavailable: boolean;
  summary: {
    todayUsd: number;
    totalUsd: number;
    totalCalls: number;
    /** Last 30 UTC days, newest first, only days with rows. */
    daily: Array<{ day: string; costUsd: number; calls: number }>;
  };
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const asDate = (v: unknown): string | null => (typeof v === "string" && DATE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) ? v : null);

export function parseCallLogQuery(search: URLSearchParams): { ok: true; value: CallLogQuery } | { ok: false; messageAr: string } {
  const provider = search.get("provider");
  if (!isDataProviderId(provider)) return { ok: false, messageAr: "مزود غير معروف." };
  const from = search.get("from"); const to = search.get("to");
  if ((from && !asDate(from)) || (to && !asDate(to))) return { ok: false, messageAr: "التاريخ غير صالح." };
  const status = search.get("status");
  if (status && !(CALL_STATUSES as readonly string[]).includes(status)) return { ok: false, messageAr: "حالة غير معروفة." };
  const page = Number(search.get("page") ?? 1);
  return { ok: true, value: { provider, from: from || null, to: to || null, status: (status as CallLogStatus) || null, page: Number.isInteger(page) && page >= 1 && page <= 100_000 ? page : 1 } };
}

const isMissingColumn = (e: any) => String(e?.code || "") === "42703" || /column .* does not exist|could not find the .* column/i.test(String(e?.message || ""));

const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

function utcDayStart(date: Date = new Date()): string {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())).toISOString();
}

export function labelForCapability(id: unknown): string | null {
  return typeof id === "string" && id ? capabilityById(id)?.labelAr ?? id : null;
}

export async function readProviderCallLog(client: any, query: CallLogQuery, now: Date = new Date()): Promise<CallLogResult> {
  const page = query.page && query.page >= 1 ? query.page : 1;
  const from = asDate(query.from);
  const to = asDate(query.to);

  // Does the table carry the three extra columns? (a read of one row of the column; read only)
  let metadataAvailable = true;
  try {
    const probe = await client.from("provider_costs").select("capability, status, duration_ms").limit(1);
    if (probe?.error && isMissingColumn(probe.error)) metadataAvailable = false;
    else if (probe?.error) metadataAvailable = false;
  } catch { metadataAvailable = false; }

  const statusFilter = metadataAvailable ? query.status ?? null : null;
  const columns = metadataAvailable
    ? "id, job_id, units, cost_usd, created_at, is_estimate, capability, status, duration_ms"
    : "id, job_id, units, cost_usd, created_at, is_estimate";

  let listQuery = client.from("provider_costs").select(columns, { count: "exact" }).eq("provider", query.provider);
  if (from) listQuery = listQuery.gte("created_at", `${from}T00:00:00.000Z`);
  if (to) listQuery = listQuery.lt("created_at", new Date(Date.parse(`${to}T00:00:00Z`) + 86_400_000).toISOString());
  if (statusFilter) listQuery = listQuery.eq("status", statusFilter);
  const offset = (page - 1) * CALL_LOG_PAGE_SIZE;
  const { data, count } = await listQuery.order("created_at", { ascending: false }).range(offset, offset + CALL_LOG_PAGE_SIZE - 1);

  const rows: CallLogRow[] = (data || []).map((r: any) => ({
    id: r.id ?? null,
    at: r.created_at,
    capabilityLabelAr: metadataAvailable ? labelForCapability(r.capability) : null,
    jobId: r.job_id ?? null,
    units: num(r.units),
    costUsd: num(r.cost_usd),
    status: metadataAvailable && (CALL_STATUSES as readonly string[]).includes(r.status) ? (r.status as CallLogStatus) : null,
    durationMs: metadataAvailable && r.duration_ms !== null && r.duration_ms !== undefined ? num(r.duration_ms) : null,
    isEstimate: Boolean(r.is_estimate),
  }));

  // Summary: the same table, the same provider, read in full pages (a request returns at most 1,000 rows).
  const { data: all } = await selectAllRows<any>(() => client.from("provider_costs").select("cost_usd, created_at").eq("provider", query.provider), { orderBy: "id" });
  const todayStart = utcDayStart(now);
  const horizon = now.getTime() - 30 * 86_400_000;
  let todayUsd = 0; let totalUsd = 0;
  const byDay = new Map<string, { costUsd: number; calls: number }>();
  for (const r of all || []) {
    const cost = Math.max(0, num(r.cost_usd));
    totalUsd += cost;
    const at = String(r.created_at || "");
    if (at >= todayStart) todayUsd += cost;
    const t = Date.parse(at);
    if (Number.isFinite(t) && t >= horizon) {
      const day = at.slice(0, 10);
      const d = byDay.get(day) ?? { costUsd: 0, calls: 0 };
      d.costUsd += cost; d.calls += 1;
      byDay.set(day, d);
    }
  }
  const daily = [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([day, d]) => ({ day, costUsd: d.costUsd, calls: d.calls }));

  return {
    provider: query.provider,
    rows,
    page,
    pageSize: CALL_LOG_PAGE_SIZE,
    total: typeof count === "number" ? count : rows.length,
    metadataAvailable,
    filtersApplied: { from, to, status: statusFilter },
    statusFilterUnavailable: !metadataAvailable && Boolean(query.status),
    summary: { todayUsd, totalUsd, totalCalls: (all || []).length, daily },
  };
}
