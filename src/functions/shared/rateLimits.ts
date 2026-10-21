import { TablesDB, Query } from "./dbCompat";
import { resolveProviderLimits } from "../../lib/server/providerLimits";

export interface RateLimitConfig {
  /** Per-account burst protection: max USER messages per minute. No daily quota. */
  messagesPerMinute: number;
  conversationMaxTokens: number;
  globalDailySpendCapUsd: number;
}

export const DEFAULT_RATE_LIMITS: RateLimitConfig = {
  // The assistant is open and free: no per-account daily limit. Only a burst
  // guard (per USER message, never per model call) plus the global kill switch.
  messagesPerMinute: 20,
  conversationMaxTokens: 40_000,
  // Global kill switch (platform protection). Override via LLM_DAILY_SPEND_CAP_USD or settings_private.
  globalDailySpendCapUsd: 50.0,
};

export interface RateLimitCheckResult {
  allowed: boolean;
  reasonAr?: string;
  statusCode?: 429 | 503 | 413;
  type?: "minute_limit" | "message_too_long" | "global_spend_cap" | "conversation_token_cap";
}

function utcStartOfDay(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

function configuredCap(name: string, fallback: number): number {
  const configured = Number(process.env[name]);
  return Number.isFinite(configured) && configured >= 0 ? configured : fallback;
}

function spendCapResult(): RateLimitCheckResult {
  return {
    allowed: false,
    statusCode: 503,
    type: "global_spend_cap",
    // Honest and generic: never mention limits, quotas, or "tomorrow".
    reasonAr: "المساعد مشغول الآن، حاول بعد قليل.",
  };
}

/**
 * Per-account burst protection only: max USER messages per minute. There is no
 * daily quota — internal model calls and tool iterations never count.
 * Supports Supabase client and query compatibility layer.
 */
export async function checkUserRateLimits(
  tables: any,
  userId: string,
  config: RateLimitConfig = DEFAULT_RATE_LIMITS,
): Promise<RateLimitCheckResult> {
  const oneMinuteAgo = new Date(Date.now() - 60_000).toISOString();
  const burstLimit = configuredCap("CHAT_MESSAGES_PER_MINUTE", config.messagesPerMinute);

  let totalCount = 0;

  if (tables && typeof tables.from === "function") {
    // Supabase client: uses idx_messages_rate_limit index on (user_id, role, created_at DESC)
    const { count, error } = await tables
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("role", "user")
      .gte("created_at", oneMinuteAgo);

    if (error) {
      console.warn("[rate_limit:check_failed]", error.message);
      return { allowed: true };
    }
    totalCount = count || 0;
  } else if (tables && typeof tables.listRows === "function") {
    // Appwrite TablesDB
    const minuteRes = await tables.listRows({
      databaseId: "digr",
      tableId: "messages",
      queries: [
        Query.equal("userId", userId),
        Query.equal("role", "user"),
        Query.greaterThanEqual("createdAt", oneMinuteAgo),
        Query.limit(burstLimit + 1),
      ],
    });
    totalCount = minuteRes.total;
  }

  if (totalCount >= burstLimit) {
    return {
      allowed: false,
      statusCode: 429,
      type: "minute_limit",
      reasonAr: "لحظة من فضلك، أرسلت رسائل كثيرة بسرعة. استنى دقيقة وكمل عادي.",
    };
  }
  return { allowed: true };
}

/** Maximum input size per user message (characters). Friendly rejection. */
export function checkMessageLength(
  message: string,
  maxChars: number = configuredCap("CHAT_MAX_MESSAGE_CHARS", 4000),
): RateLimitCheckResult {
  if ((message || "").length > maxChars) {
    return {
      allowed: false,
      statusCode: 413,
      type: "message_too_long",
      reasonAr: `رسالتك طويلة شوية (أكتر من ${maxChars} حرف). اختصرها أو قسمها على رسالتين وهكمل معاك عادي.`,
    };
  }
  return { allowed: true };
}

async function sumDailyUsageCost(tables: TablesDB, userId?: string): Promise<number> {
  const queries = [
    ...(userId ? [Query.equal("userId", userId)] : []),
    Query.greaterThanEqual("createdAt", utcStartOfDay()),
  ];
  let totalCostUsd = 0;
  let offset = 0;
  const limit = 100;
  while (true) {
    const res = await tables.listRows({
      databaseId: "digr",
      tableId: "llm_usage",
      queries: [...queries, Query.limit(limit), Query.offset(offset)],
    });
    for (const row of res.rows) {
      const rowCost = Number((row as any).costUsd);
      if (Number.isFinite(rowCost) && rowCost > 0) totalCostUsd += rowCost;
    }
    if (res.rows.length < limit) break;
    offset += limit;
    if (Number.isFinite(res.total) && offset >= res.total) break;
  }
  return totalCostUsd;
}

/** The API returns at most this many rows per request by default; a read that returns this many may be cut short. */
export const SPEND_READ_PAGE_SIZE = 1000;
/** Ceiling on the pages read for the daily sum (50 000 rows). Past it the check fails closed instead of guessing. */
export const SPEND_READ_MAX_PAGES = 50;

function sumCostRows(rows: any[] | null | undefined): number {
  let total = 0;
  for (const row of rows || []) {
    const cost = Number(row?.cost_usd);
    if (Number.isFinite(cost) && cost > 0) total += cost;
  }
  return total;
}

/**
 * Today's LLM spend from llm_usage. The first read is the plain one; only when it comes back as many rows as the API
 * returns per request (so it may be incomplete) the day is re-read page by page in a stable order (by id), counting only
 * rows that cost something. Any error, and a day too large for the page ceiling, throws: the chat route turns that into
 * its existing 503 "protection" answer, so the cap never silently under-counts.
 */
export async function sumTodayLlmCostSupabase(tables: any, sinceIso: string): Promise<number> {
  const { data, error } = await tables
    .from("llm_usage")
    .select("cost_usd")
    .gte("created_at", sinceIso);
  if (error) {
    throw error;
  }
  if ((data || []).length < SPEND_READ_PAGE_SIZE) return sumCostRows(data);

  let total = 0;
  let offset = 0;
  for (let page = 0; page < SPEND_READ_MAX_PAGES; page++) {
    const { data: rows, error: pageError } = await tables
      .from("llm_usage")
      .select("cost_usd")
      .gt("cost_usd", 0)
      .gte("created_at", sinceIso)
      .order("id", { ascending: true })
      .range(offset, offset + SPEND_READ_PAGE_SIZE - 1);
    if (pageError) {
      throw pageError;
    }
    if (!rows || rows.length === 0) return total;
    total += sumCostRows(rows);
    // Advance by what the server actually returned, so a lower server-side row limit cannot skip rows.
    offset += rows.length;
  }
  throw new Error("llm_usage_daily_sum_exceeds_page_ceiling");
}

/**
 * Check platform-wide global daily LLM spend cap.
 * Supports both Supabase client and Appwrite TablesDB.
 */
/**
 * The chat route checks the daily model-spend cap on EVERY turn, and the check used to read the whole day's usage rows each time (1
 * request up to 900 rows, 5 at 2 500, 12 at 10 000, a refusal for everyone at 50 000). With `readCacheMs` the SUM that was read is kept
 * by this server instance for a short time. Only the READ is cached: the cap, its resolver and the rule (total >= cap refuses) are
 * untouched, and the cached sum can never under-count this instance's own traffic:
 *  - the spend this instance records after the read is added to the cached sum (`noteLocalLlmSpend`, called before each usage row is
 *    written, so a failed write only over-counts);
 *  - once the sum (with that addition) reaches CACHE_FRESH_ABOVE_SHARE of the cap, every check reads fresh again;
 *  - a read that fails throws as before (the route answers 503): a stale sum is never served after its time is up or after a failure.
 * Other instances' spend reaches this one at the next read, at most `readCacheMs` later.
 */
export const SPEND_READ_CACHE_MS = 45_000;
const CACHE_FRESH_ABOVE_SHARE = 0.8;

let ownLlmSpendTotalUsd = 0;
let spendReadCache: { day: string; totalUsd: number; readAt: number; ownAtReadStart: number } | null = null;

/** Records spend of THIS instance (USD), before its usage row is written, so a cached sum can add it. */
export function noteLocalLlmSpend(costUsd: number): void {
  if (Number.isFinite(costUsd) && costUsd > 0) ownLlmSpendTotalUsd += costUsd;
}

export function resetSpendReadCacheForTesting(): void {
  spendReadCache = null;
  ownLlmSpendTotalUsd = 0;
}

export interface SpendCapOptions {
  /** When set, the day's sum read by this instance less than this many milliseconds ago is reused (see above). */
  readCacheMs?: number;
  /** Test clock. */
  now?: number;
}

export async function checkGlobalDailySpendCap(
  tables: any,
  config: RateLimitConfig = DEFAULT_RATE_LIMITS,
  options: SpendCapOptions = {},
): Promise<RateLimitCheckResult> {
  let configuredLimit = config.globalDailySpendCapUsd;

  let cap: number;
  if (tables && typeof tables.from === "function") {
    // One shared resolver (admin-editable, 30 s cache): settings, then legacy pricing row, then the environment or 50.
    const resolved = await resolveProviderLimits(tables);
    cap = resolved.source === "default" ? configuredCap("LLM_DAILY_SPEND_CAP_USD", configuredLimit) : resolved.limits.llmDailyUsd;
  } else {
    cap = configuredCap("LLM_DAILY_SPEND_CAP_USD", configuredLimit);
  }
  let totalCostUsd = 0;

  if (tables && typeof tables.from === "function") {
    // Supabase client: uses idx_llm_usage_created_at index
    const dayStart = utcStartOfDay();
    const nowMs = options.now ?? Date.now();
    const cached = spendReadCache;
    const cachedTotal = cached ? cached.totalUsd + (ownLlmSpendTotalUsd - cached.ownAtReadStart) : 0;
    if (options.readCacheMs && cached && cached.day === dayStart && nowMs - cached.readAt < options.readCacheMs && cachedTotal < cap * CACHE_FRESH_ABOVE_SHARE) {
      totalCostUsd = cachedTotal;
    } else {
      const ownAtReadStart = ownLlmSpendTotalUsd;
      totalCostUsd = await sumTodayLlmCostSupabase(tables, dayStart);
      // a failed read threw above: nothing is kept; the next check reads again
      if (options.readCacheMs) spendReadCache = { day: dayStart, totalUsd: totalCostUsd, readAt: nowMs, ownAtReadStart };
    }
  } else if (tables && typeof tables.listRows === "function") {
    // Appwrite TablesDB
    totalCostUsd = await sumDailyUsageCost(tables);
  }

  return totalCostUsd >= cap ? spendCapResult() : { allowed: true };
}

/** Check an individual conversation context token cap. */
export function checkConversationTokenCap(
  totalConversationTokens: number,
  config: RateLimitConfig = DEFAULT_RATE_LIMITS,
): RateLimitCheckResult {
  if (totalConversationTokens >= config.conversationMaxTokens) {
    return {
      allowed: false,
      statusCode: 429,
      type: "conversation_token_cap",
      reasonAr: `تم بلوغ الحد الأقصى لسياق هذه المحادثة (${config.conversationMaxTokens.toLocaleString()} توكن). يرجى بدء محادثة جديدة.`,
    };
  }
  return { allowed: true };
}
