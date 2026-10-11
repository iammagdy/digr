import { TablesDB, Query } from "node-appwrite";

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
  // Global kill switch (platform protection). Override via LLM_DAILY_SPEND_CAP_USD.
  globalDailySpendCapUsd: 1.0,
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
 */
export async function checkUserRateLimits(
  tables: TablesDB,
  userId: string,
  config: RateLimitConfig = DEFAULT_RATE_LIMITS,
): Promise<RateLimitCheckResult> {
  const oneMinuteAgo = new Date(Date.now() - 60_000).toISOString();
  const burstLimit = configuredCap("CHAT_MESSAGES_PER_MINUTE", config.messagesPerMinute);

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
  if (minuteRes.total >= burstLimit) {
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

/** Check platform-wide global daily LLM spend cap. */
export async function checkGlobalDailySpendCap(
  tables: TablesDB,
  config: RateLimitConfig = DEFAULT_RATE_LIMITS,
): Promise<RateLimitCheckResult> {
  const cap = configuredCap("LLM_DAILY_SPEND_CAP_USD", config.globalDailySpendCapUsd);
  const totalCostUsd = await sumDailyUsageCost(tables);
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
