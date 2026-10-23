import { capabilityById } from "../multiProvider/catalog";
import { DATA_PROVIDER_IDS, type DataProviderId } from "../multiProvider/types";
import { selectAllRows } from "./selectAll";
import { resolveAllProviderDailyCaps, readProviderSpendToday } from "./multiProvider/providerCaps";
import { isTestAccount } from "./testAccounts";

/**
 * The admin CALLS LOG: every provider API call (TREG, Firecrawl, Context.dev) in one list, with the user behind it. READ ONLY. It reads
 * provider_costs, jobs (job -> owner) and profiles (owner -> email, name) and writes nothing anywhere. Admin only: provider names, USD and
 * user emails never reach a customer route, and no customer file imports this module.
 *
 * Filtering order: the database narrows by provider, date, status and job; the user, test / real filters are applied to the rows once their
 * owners are resolved. Summary and export are computed from the very same filtered rows, so the numbers cannot disagree with the list.
 */
export const CALLS_LOG_PAGE_SIZE = 50;
/** The most rows one export carries. Larger results are cut at this number, newest first, and the screen says so. */
export const EXPORT_MAX_ROWS = 20_000;
export const CALL_STATUSES = ["success", "failed", "empty"] as const;
export type CallStatus = (typeof CALL_STATUSES)[number];
export type TestFilter = "all" | "test" | "real";

export interface CallsLogQuery {
  provider: DataProviderId | null;
  /** UTC dates, inclusive. */
  from: string | null;
  to: string | null;
  status: CallStatus | null;
  /** Free text matched against the owner's email, name and id. */
  user: string | null;
  test: TestFilter;
  jobId: string | null;
  page: number;
}

export interface CallsLogRow {
  id: number | null;
  at: string;
  provider: DataProviderId;
  capabilityLabelAr: string | null;
  jobId: string | null;
  userId: string | null;
  userEmail: string | null;
  userName: string | null;
  isTestAccount: boolean;
  units: number;
  costUsd: number;
  status: CallStatus | null;
  durationMs: number | null;
  isEstimate: boolean;
}

export interface ProviderSummary { calls: number; costUsd: number; lastCallAt: string | null }

export interface CallsLogSummary {
  calls: number;
  costUsd: number;
  byProvider: Record<DataProviderId, ProviderSummary>;
  byStatus: Record<CallStatus | "unknown", number>;
}

export interface SpendVsLimit { provider: DataProviderId; todayUsd: number | null; limitUsd: number }

export interface CallsLogResult {
  rows: CallsLogRow[];
  page: number;
  pageSize: number;
  total: number;
  summary: CallsLogSummary;
  spendToday: SpendVsLimit[];
  metadataAvailable: boolean;
  filters: { provider: DataProviderId | null; from: string | null; to: string | null; status: CallStatus | null; user: string | null; test: TestFilter; jobId: string | null };
  statusFilterUnavailable: boolean;
  exportCap: number;
  /** The reading stopped at the safety limit (a very large table): totals then cover what was read. */
  truncated: boolean;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const asDate = (v: unknown): string | null => (typeof v === "string" && DATE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) ? v : null);
const isProvider = (v: unknown): v is DataProviderId => typeof v === "string" && (DATA_PROVIDER_IDS as readonly string[]).includes(v);
const JOB_ID = /^[A-Za-z0-9_.:-]{1,120}$/;

export function parseCallsLogQuery(search: URLSearchParams): { ok: true; value: CallsLogQuery } | { ok: false; messageAr: string } {
  const provider = search.get("provider");
  if (provider && provider !== "all" && !isProvider(provider)) return { ok: false, messageAr: "مزود غير معروف." };
  const from = search.get("from"); const to = search.get("to");
  if ((from && !asDate(from)) || (to && !asDate(to))) return { ok: false, messageAr: "التاريخ غير صالح." };
  if (from && to && from > to) return { ok: false, messageAr: "تاريخ البداية بعد تاريخ النهاية." };
  const status = search.get("status");
  if (status && !(CALL_STATUSES as readonly string[]).includes(status)) return { ok: false, messageAr: "حالة غير معروفة." };
  const test = search.get("test") || "all";
  if (!["all", "test", "real"].includes(test)) return { ok: false, messageAr: "قيمة فلتر الحساب غير صالحة." };
  const user = (search.get("user") || "").trim().slice(0, 100);
  const jobId = (search.get("jobId") || "").trim();
  if (jobId && !JOB_ID.test(jobId)) return { ok: false, messageAr: "رقم المهمة غير صالح." };
  const page = Number(search.get("page") ?? 1);
  return {
    ok: true,
    value: {
      provider: provider && provider !== "all" ? (provider as DataProviderId) : null,
      from: from || null,
      to: to || null,
      status: (status as CallStatus) || null,
      user: user || null,
      test: test as TestFilter,
      jobId: jobId || null,
      page: Number.isInteger(page) && page >= 1 && page <= 100_000 ? page : 1,
    },
  };
}

const isMissingColumn = (e: any) => String(e?.code || "") === "42703" || /column .* does not exist|could not find the .* column/i.test(String(e?.message || ""));
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const chunk = <T,>(list: T[], size: number): T[][] => { const out: T[][] = []; for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size)); return out; };

export function labelForCapability(id: unknown): string | null {
  return typeof id === "string" && id ? capabilityById(id)?.labelAr ?? id : null;
}

interface OwnerInfo { userId: string; email: string | null; name: string | null }

/** job id -> owner, through jobs.user_id and profiles. Unknown jobs and unreadable owners stay unknown: nothing is guessed. */
async function resolveOwners(client: any, jobIds: string[]): Promise<Map<string, OwnerInfo>> {
  const jobToUser = new Map<string, string>();
  for (const ids of chunk(jobIds, 100)) {
    try {
      const { data } = await client.from("jobs").select("id, user_id").in("id", ids);
      for (const j of data || []) if (j?.id && j?.user_id) jobToUser.set(String(j.id), String(j.user_id));
    } catch { /* an unreadable batch leaves its jobs unknown */ }
  }
  const profiles = new Map<string, { email: string | null; name: string | null }>();
  for (const ids of chunk([...new Set(jobToUser.values())], 100)) {
    try {
      const { data } = await client.from("profiles").select("*").in("id", ids);
      for (const p of data || []) if (p?.id) profiles.set(String(p.id), { email: p.email || null, name: p.name || p.sender_name || null });
    } catch { /* ids without a profile keep only the id */ }
  }
  const out = new Map<string, OwnerInfo>();
  for (const [jobId, userId] of jobToUser) {
    const profile = profiles.get(userId);
    out.set(jobId, { userId, email: profile?.email ?? null, name: profile?.name ?? null });
  }
  return out;
}

const utcStart = (date: string) => `${date}T00:00:00.000Z`;
const utcNextDay = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString();

/** Every row matching the query (no paging yet), newest first, owners resolved, test / real and user filters applied. */
export async function readFilteredCalls(client: any, query: CallsLogQuery): Promise<{ rows: CallsLogRow[]; metadataAvailable: boolean; truncated: boolean }> {
  let metadataAvailable = true;
  try {
    const probe = await client.from("provider_costs").select("capability, status, duration_ms").limit(1);
    if (probe?.error) metadataAvailable = false;
  } catch { metadataAvailable = false; }

  const statusFilter = metadataAvailable ? query.status : null;
  const columns = metadataAvailable
    ? "id, provider, job_id, units, cost_usd, created_at, is_estimate, capability, status, duration_ms"
    : "id, provider, job_id, units, cost_usd, created_at, is_estimate";
  const providers = query.provider ? [query.provider] : [...DATA_PROVIDER_IDS];

  const { data, truncated } = await selectAllRows<any>(() => {
    let q = client.from("provider_costs").select(columns).in("provider", providers);
    if (query.from) q = q.gte("created_at", utcStart(query.from));
    if (query.to) q = q.lt("created_at", utcNextDay(query.to));
    if (statusFilter) q = q.eq("status", statusFilter);
    if (query.jobId) q = q.eq("job_id", query.jobId);
    return q;
  }, { orderBy: "id" });

  const jobIds = [...new Set((data || []).map((r: any) => r.job_id).filter((j: unknown): j is string => typeof j === "string" && j.length > 0))];
  const owners = jobIds.length ? await resolveOwners(client, jobIds) : new Map<string, OwnerInfo>();

  let rows: CallsLogRow[] = (data || []).map((r: any) => {
    const owner = r.job_id ? owners.get(String(r.job_id)) : undefined;
    return {
      id: r.id ?? null,
      at: String(r.created_at),
      provider: r.provider as DataProviderId,
      capabilityLabelAr: metadataAvailable ? labelForCapability(r.capability) : null,
      jobId: r.job_id ?? null,
      userId: owner?.userId ?? null,
      userEmail: owner?.email ?? null,
      userName: owner?.name ?? null,
      isTestAccount: owner ? isTestAccount({ id: owner.userId, email: owner.email }) : false,
      units: num(r.units),
      costUsd: Math.max(0, num(r.cost_usd)),
      status: metadataAvailable && (CALL_STATUSES as readonly string[]).includes(r.status) ? (r.status as CallStatus) : null,
      durationMs: metadataAvailable && r.duration_ms !== null && r.duration_ms !== undefined ? num(r.duration_ms) : null,
      isEstimate: Boolean(r.is_estimate),
    };
  });

  if (query.test === "test") rows = rows.filter((r) => r.isTestAccount);
  else if (query.test === "real") rows = rows.filter((r) => !r.isTestAccount);
  if (query.user) {
    const needle = query.user.toLowerCase();
    rows = rows.filter((r) => [r.userEmail, r.userName, r.userId].some((v) => typeof v === "string" && v.toLowerCase().includes(needle)));
  }
  rows.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : (b.id ?? 0) - (a.id ?? 0)));
  return { rows, metadataAvailable, truncated };
}

export function summarizeCalls(rows: CallsLogRow[]): CallsLogSummary {
  const empty = (): ProviderSummary => ({ calls: 0, costUsd: 0, lastCallAt: null });
  const byProvider: Record<DataProviderId, ProviderSummary> = { treg: empty(), firecrawl: empty(), contextdev: empty() };
  const byStatus: Record<CallStatus | "unknown", number> = { success: 0, failed: 0, empty: 0, unknown: 0 };
  let costUsd = 0;
  for (const r of rows) {
    costUsd += r.costUsd;
    const p = byProvider[r.provider];
    if (p) {
      p.calls += 1;
      p.costUsd += r.costUsd;
      if (!p.lastCallAt || r.at > p.lastCallAt) p.lastCallAt = r.at;
    }
    byStatus[r.status ?? "unknown"] += 1;
  }
  return { calls: rows.length, costUsd, byProvider, byStatus };
}

export async function readCallsLog(client: any, query: CallsLogQuery): Promise<CallsLogResult> {
  const { rows: all, metadataAvailable, truncated } = await readFilteredCalls(client, query);
  const caps = await resolveAllProviderDailyCaps(client).catch(() => ({ treg: 0, firecrawl: 0, contextdev: 0 }));
  const spendToday: SpendVsLimit[] = [];
  for (const id of DATA_PROVIDER_IDS) spendToday.push({ provider: id, todayUsd: await readProviderSpendToday(client, id), limitUsd: caps[id] ?? 0 });
  const start = (query.page - 1) * CALLS_LOG_PAGE_SIZE;
  return {
    rows: all.slice(start, start + CALLS_LOG_PAGE_SIZE),
    page: query.page,
    pageSize: CALLS_LOG_PAGE_SIZE,
    total: all.length,
    summary: summarizeCalls(all),
    spendToday,
    metadataAvailable,
    filters: { provider: query.provider, from: query.from, to: query.to, status: metadataAvailable ? query.status : null, user: query.user, test: query.test, jobId: query.jobId },
    statusFilterUnavailable: !metadataAvailable && Boolean(query.status),
    exportCap: EXPORT_MAX_ROWS,
    truncated,
  };
}

/** The rows an export carries: the same filtered rows, newest first, at most EXPORT_MAX_ROWS. */
export async function readCallsForExport(client: any, query: CallsLogQuery): Promise<{ rows: CallsLogRow[]; total: number; capped: boolean }> {
  const { rows } = await readFilteredCalls(client, query);
  return { rows: rows.slice(0, EXPORT_MAX_ROWS), total: rows.length, capped: rows.length > EXPORT_MAX_ROWS };
}
