import { selectAllRows } from "./selectAll";
/**
 * Provider spend limits, editable from the admin dashboard with immediate effect and no redeploy.
 *
 * ONE resolver for every place that enforces a limit (the worker's reserve call, the chat plan estimate, the multi-step
 * worker, the LLM daily kill switch, the admin tab, the public calculator):
 *   1. settings_private row 'provider_limits' (written only by the SECURITY DEFINER function, with an audit row),
 *   2. the legacy settings_private 'pricing' row (providerDailySpendCapUsd / llmDailySpendCapUsd),
 *   3. the environment, then the built-in constants (0.80 USD per day for the data provider).
 * Results are cached 30 seconds per server instance and flushed at once on the instance that saves. A missing or
 * unreadable store always falls back to the current constants, so the code works before and after the migration.
 */

export const PROVIDER_LIMITS_KEY = "provider_limits";
export const DEFAULT_PROVIDER_DAILY_LIMIT_USD = 0.80;
export const DEFAULT_LLM_DAILY_LIMIT_USD = 50;
export const DEFAULT_WARN_PERCENT = 80;
/** A very large number is allowed on purpose (the owner may set one to effectively disable a limit). */
export const MAX_LIMIT_USD = 1e12;
export const PROVIDER_LIMITS_CACHE_TTL_MS = 30_000;

export interface ProviderLimits {
  /** Daily spend limit for the data provider (USD). 0 blocks all provider spend. */
  dailyUsd: number;
  /** Ceiling for one job's provider spend (USD); null = no job ceiling beyond the existing caps. */
  perJobUsd: number | null;
  /** Ceiling for one user's provider spend per day (USD); null = none. */
  perUserDailyUsd: number | null;
  /** Percent of the daily limit at which the warning shows. */
  warnPercent: number;
  /** Daily spend limit for the language model (USD). */
  llmDailyUsd: number;
}

export type LimitsSource = "settings" | "legacy" | "default";

export interface ResolvedProviderLimits {
  limits: ProviderLimits;
  source: LimitsSource;
}

function envNumber(name: string): number | null {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** The constants used whenever the store holds nothing: the current behaviour before this feature. */
export function defaultProviderLimits(): ProviderLimits {
  return {
    dailyUsd: envNumber("PROVIDER_DAILY_SPEND_CAP_USD") ?? DEFAULT_PROVIDER_DAILY_LIMIT_USD,
    perJobUsd: null,
    perUserDailyUsd: null,
    warnPercent: DEFAULT_WARN_PERCENT,
    llmDailyUsd: envNumber("LLM_DAILY_SPEND_CAP_USD") ?? DEFAULT_LLM_DAILY_LIMIT_USD,
  };
}

const validUsd = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= MAX_LIMIT_USD;

/** Reads a stored value defensively: any field that is not a clean number is ignored (the default applies). */
export function normalizeStoredLimits(raw: unknown): Partial<ProviderLimits> {
  const v = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out: Partial<ProviderLimits> = {};
  if (validUsd(v.dailyUsd)) out.dailyUsd = v.dailyUsd;
  if (validUsd(v.perJobUsd)) out.perJobUsd = v.perJobUsd;
  if (validUsd(v.perUserDailyUsd)) out.perUserDailyUsd = v.perUserDailyUsd;
  if (typeof v.warnPercent === "number" && Number.isFinite(v.warnPercent) && v.warnPercent >= 0 && v.warnPercent <= 100) out.warnPercent = v.warnPercent;
  if (validUsd(v.llmDailyUsd)) out.llmDailyUsd = v.llmDailyUsd;
  return out;
}

// ---- Cache (30 s per server instance) ----------------------------------------------------------------------------
let cache: { at: number; value: ResolvedProviderLimits } | null = null;
const flushListeners = new Set<() => void>();

/** Other modules that cache values derived from the limits (for example the plan-estimate balance) register here. */
export function onProviderLimitsFlush(listener: () => void): void { flushListeners.add(listener); }

export function flushProviderLimitsCache(): void {
  cache = null;
  for (const listener of flushListeners) { try { listener(); } catch { /* best effort */ } }
}

async function readRow(client: any, key: string): Promise<unknown | undefined> {
  const query = client?.from?.("settings_private")?.select?.("value");
  if (!query || typeof query.eq !== "function") return undefined;
  const { data, error } = await query.eq("key", key).maybeSingle();
  if (error) return undefined;
  return data?.value !== undefined ? data.value : undefined;
}

async function readFromStore(client: any): Promise<ResolvedProviderLimits> {
  const base = defaultProviderLimits();
  let source: LimitsSource = "default";
  try {
    const stored = normalizeStoredLimits(await readRow(client, PROVIDER_LIMITS_KEY));
    const legacyRaw = await readRow(client, "pricing");
    const legacy = legacyRaw && typeof legacyRaw === "object" ? (legacyRaw as Record<string, unknown>) : {};
    const merged: ProviderLimits = { ...base };
    if (typeof legacy.providerDailySpendCapUsd === "number" && legacy.providerDailySpendCapUsd > 0 && validUsd(legacy.providerDailySpendCapUsd)) {
      merged.dailyUsd = legacy.providerDailySpendCapUsd; source = "legacy";
    }
    if (typeof legacy.llmDailySpendCapUsd === "number" && legacy.llmDailySpendCapUsd > 0 && validUsd(legacy.llmDailySpendCapUsd)) {
      merged.llmDailyUsd = legacy.llmDailySpendCapUsd; source = "legacy";
    }
    if (Object.keys(stored).length > 0) { Object.assign(merged, stored); source = "settings"; }
    return { limits: merged, source };
  } catch {
    // The store is unreadable: keep working on the current constants and say so once, with nothing secret in the line.
    console.warn("[provider_limits:fallback_to_defaults]");
    return { limits: base, source: "default" };
  }
}

/**
 * The limits in force. With a client it reads the store (cached for 30 s); without one it uses the cache or the
 * constants. `forceRefresh` bypasses the cache (the admin tab uses it after a save).
 */
export async function resolveProviderLimits(client?: any, options?: { forceRefresh?: boolean; now?: number }): Promise<ResolvedProviderLimits> {
  const now = options?.now ?? Date.now();
  if (!options?.forceRefresh && cache && now - cache.at < PROVIDER_LIMITS_CACHE_TTL_MS) return cache.value;
  if (!client || typeof client.from !== "function") return cache?.value ?? { limits: defaultProviderLimits(), source: "default" };
  const value = await readFromStore(client);
  cache = { at: now, value };
  return value;
}

// ---- Validation (the same rules in the route and, again, in the SQL function) -----------------------------------
const ARABIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";

/** Accepts what a person types on a phone: Arabic-Indic digits, «٫» or «،» as the decimal mark. Not a number = null. */
export function parseLimitNumber(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== "string") return null;
  const text = raw.trim().replace(/[٠-٩]/g, (d) => String(ARABIC_DIGITS.indexOf(d))).replace(/[٫،,]/g, ".").replace(/\s+/g, "");
  if (!/^\d+(\.\d+)?(e\+?\d+)?$/i.test(text)) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

export interface LimitsInput {
  dailyUsd?: unknown;
  perJobUsd?: unknown;
  perUserDailyUsd?: unknown;
  warnPercent?: unknown;
  llmDailyUsd?: unknown;
  /** Daily limits of the two extra data providers (see multiProvider/providerCaps.ts). */
  firecrawlDailyUsd?: unknown;
  contextdevDailyUsd?: unknown;
}

export type LimitsPatch = Partial<{ dailyUsd: number; perJobUsd: number | null; perUserDailyUsd: number | null; warnPercent: number; llmDailyUsd: number; firecrawlDailyUsd: number; contextdevDailyUsd: number }>;

const FIELD_LABEL_AR: Record<string, string> = {
  dailyUsd: "الحد اليومي لإنفاق المزود",
  perJobUsd: "سقف المزود لكل طلب",
  perUserDailyUsd: "سقف المزود اليومي لكل مستخدم",
  warnPercent: "نسبة التنبيه",
  llmDailyUsd: "الحد اليومي للنموذج الذكي",
  firecrawlDailyUsd: "الحد اليومي لمزود قراءة المواقع",
  contextdevDailyUsd: "الحد اليومي لمزود البحث والقراءة",
};

/** Partial update: only the fields present are validated. An empty ceiling clears it (no ceiling). */
export function validateLimitsInput(input: LimitsInput): { ok: true; value: LimitsPatch } | { ok: false; messageAr: string } {
  const value: LimitsPatch = {};
  const has = (k: keyof LimitsInput) => input[k] !== undefined;
  const fail = (k: string, why: string) => ({ ok: false as const, messageAr: `${FIELD_LABEL_AR[k]}: ${why}` });

  for (const k of ["dailyUsd", "llmDailyUsd", "firecrawlDailyUsd", "contextdevDailyUsd"] as const) {
    if (!has(k)) continue;
    const n = parseLimitNumber(input[k]);
    if (n === null) return fail(k, "اكتب رقمًا صحيحًا (مثال: ٠٫٨٠).");
    if (n < 0) return fail(k, "لا يمكن أن يكون سالبًا.");
    if (n > MAX_LIMIT_USD) return fail(k, "الرقم أكبر من الحد المسموح.");
    value[k] = n;
  }
  for (const k of ["perJobUsd", "perUserDailyUsd"] as const) {
    if (!has(k)) continue;
    const raw = input[k];
    if (raw === null || (typeof raw === "string" && raw.trim() === "")) { value[k] = null; continue; }
    const n = parseLimitNumber(raw);
    if (n === null) return fail(k, "اكتب رقمًا صحيحًا أو اتركه فارغًا لإلغاء السقف.");
    if (n < 0) return fail(k, "لا يمكن أن يكون سالبًا.");
    if (n > MAX_LIMIT_USD) return fail(k, "الرقم أكبر من الحد المسموح.");
    value[k] = n;
  }
  if (has("warnPercent")) {
    const n = parseLimitNumber(input.warnPercent);
    if (n === null) return fail("warnPercent", "اكتب رقمًا بين ٠ و١٠٠.");
    if (n < 0 || n > 100) return fail("warnPercent", "يجب أن تكون بين ٠ و١٠٠.");
    value.warnPercent = n;
  }
  if (Object.keys(value).length === 0) return { ok: false, messageAr: "لم يصل أي تعديل." };
  return { ok: true, value };
}

// ---- Spend level and ceilings (pure) ------------------------------------------------------------------------------
export type SpendLevel = "ok" | "warn" | "reached";

export function spendPercent(spentUsd: number, limitUsd: number): number {
  if (!(limitUsd > 0)) return spentUsd > 0 ? 100 : 0;
  return Math.min(100, (spentUsd / limitUsd) * 100);
}

export function spendLevel(spentUsd: number, limits: Pick<ProviderLimits, "dailyUsd" | "warnPercent">): SpendLevel {
  if (limits.dailyUsd <= 0) return "reached";
  if (spentUsd >= limits.dailyUsd) return "reached";
  return (spentUsd / limits.dailyUsd) * 100 >= limits.warnPercent ? "warn" : "ok";
}

export type CeilingReason = "job" | "user";

/** The per-job and per-user ceilings: true spend so far plus this call's estimate must stay within them. */
export function evaluateSpendCeilings(
  limits: Pick<ProviderLimits, "perJobUsd" | "perUserDailyUsd">,
  spend: { jobUsd: number; userTodayUsd: number },
  estimatedUsd: number,
): CeilingReason | null {
  const estimate = Math.max(0, estimatedUsd);
  if (limits.perJobUsd !== null && spend.jobUsd + estimate > limits.perJobUsd + 1e-12) return "job";
  if (limits.perUserDailyUsd !== null && spend.userTodayUsd + estimate > limits.perUserDailyUsd + 1e-12) return "user";
  return null;
}

export const CEILING_MESSAGE_AR: Record<CeilingReason, string> = {
  job: "تم الوصول إلى الحد الأقصى المسموح لمعالجة هذا الطلب؛ حجز مؤقت مُحرَّر كاملًا ولم يُخصم أي رصيد.",
  user: "تم الوصول إلى الحد اليومي المسموح لهذا الحساب؛ حاول مرة أخرى لاحقاً. حجز مؤقت مُحرَّر كاملًا ولم يُخصم أي رصيد.",
};

function utcDayStart(): string {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate())).toISOString();
}

/** Job ids sent to the database per request. */
const JOB_ID_GROUP = 100;

const sumCost = (rows: any[] | null | undefined) => (rows || []).reduce((a, r) => { const c = Number(r?.cost_usd); return Number.isFinite(c) && c > 0 ? a + c : a; }, 0);

const DAY_JOB_GROUP = JOB_ID_GROUP;

/** This user's recorded provider spend today (USD): the cost rows of THIS user's own jobs of the day, nothing of other customers. Read only. */
export async function readUserSpendToday(client: any, userId: string): Promise<number> {
  // This user's spend today: the cost rows of THIS user's jobs only (their own few jobs, then their cost rows by job), never every
  // customer's cost rows of the day. At a full room the old read grew with all customers' spend on every chunk of every job.
  const dayStart = utcDayStart();
  const { data: myJobs } = await selectAllRows(() => client.from("jobs").select("id").eq("user_id", userId).gte("updated_at", dayStart), { orderBy: "id" });
  const myIds = [...new Set((myJobs || []).map((row: any) => row.id).filter(Boolean))] as string[];
  let total = 0;
  // the ids go to the database in groups: one request with thousands of ids is too long a URL
  for (let i = 0; i < myIds.length; i += DAY_JOB_GROUP) {
    const group = myIds.slice(i, i + DAY_JOB_GROUP);
    // a request returns at most 1,000 rows: the group's cost rows are read page by page
    const { data: mine } = await selectAllRows(() => client.from("provider_costs").select("cost_usd").eq("provider", "treg").gte("created_at", dayStart).in("job_id", group), { orderBy: "id" });
    total += sumCost(mine);
  }
  return total;
}

/** This job's recorded provider spend so far (USD). Read only; an unreadable store counts as 0 (the daily limit still applies). */
export async function readJobSpendUsd(client: any, jobId: string): Promise<number> {
  try {
    const { data: jobRows } = await selectAllRows(() => client.from("provider_costs").select("cost_usd").eq("provider", "treg").eq("job_id", jobId), { orderBy: "id" });
    return sumCost(jobRows);
  } catch {
    return 0;
  }
}

/** Real recorded provider spend (read-only): this job so far, and this user today across their jobs. */
export async function readSpendForCeilings(client: any, ids: { jobId: string; userId: string }): Promise<{ jobUsd: number; userTodayUsd: number }> {
  try {
    const { data: jobRows } = await selectAllRows(() => client.from("provider_costs").select("cost_usd").eq("provider", "treg").eq("job_id", ids.jobId), { orderBy: "id" });
    const jobUsd = sumCost(jobRows);
    return { jobUsd, userTodayUsd: await readUserSpendToday(client, ids.userId) };
  } catch {
    // Unreadable spend must not stop customers' jobs; the daily limit in the reserve function still applies.
    return { jobUsd: 0, userTodayUsd: 0 };
  }
}
