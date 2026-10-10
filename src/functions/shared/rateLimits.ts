import { TablesDB, Query } from "node-appwrite";

export interface RateLimitConfig {
  messagesPerMinute: number;
  messagesPerDay: number;
  conversationMaxTokens: number;
  globalDailySpendCapUsd: number;
}

export const DEFAULT_RATE_LIMITS: RateLimitConfig = {
  messagesPerMinute: 10,
  messagesPerDay: 100,
  conversationMaxTokens: 15000,
  globalDailySpendCapUsd: 1.0, // $1.00 USD hard global daily safety cap
};

export interface RateLimitCheckResult {
  allowed: boolean;
  reasonAr?: string;
  statusCode?: 429 | 503;
  type?: "minute_limit" | "daily_limit" | "global_spend_cap" | "conversation_token_cap";
}

/**
 * Check per-user message rate limits (per minute and per day)
 */
export async function checkUserRateLimits(
  tables: TablesDB,
  userId: string,
  config: RateLimitConfig = DEFAULT_RATE_LIMITS
): Promise<RateLimitCheckResult> {
  const now = new Date();
  const oneMinuteAgo = new Date(now.getTime() - 60 * 1000).toISOString();
  
  // Start of day UTC (midnight)
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();

  // 1. Check Messages Per Minute
  const minuteRes = await tables.listRows({
    databaseId: "digr",
    tableId: "messages",
    queries: [
      Query.equal("userId", userId),
      Query.equal("role", "user"),
      Query.greaterThanEqual("createdAt", oneMinuteAgo),
      Query.limit(config.messagesPerMinute + 1),
    ],
  });

  if (minuteRes.total >= config.messagesPerMinute) {
    return {
      allowed: false,
      statusCode: 429,
      type: "minute_limit",
      reasonAr: `لقد أرسلت عدة رسائل بسرعة. يرجى الانتظار دقيقة واحدة قبل المتابعة (الحد الأقصى: ${config.messagesPerMinute} رسائل/دقيقة).`,
    };
  }

  // 2. Check Messages Per Day
  const dayRes = await tables.listRows({
    databaseId: "digr",
    tableId: "messages",
    queries: [
      Query.equal("userId", userId),
      Query.equal("role", "user"),
      Query.greaterThanEqual("createdAt", startOfDay),
      Query.limit(config.messagesPerDay + 1),
    ],
  });

  if (dayRes.total >= config.messagesPerDay) {
    return {
      allowed: false,
      statusCode: 429,
      type: "daily_limit",
      reasonAr: `تم بلوغ الحد الأقصى اليومي المسموح به من الرسائل (${config.messagesPerDay} رسالة/يوم). يتجدد الرصيد غداً.`,
    };
  }

  return { allowed: true };
}

/**
 * Check platform-wide global daily LLM spend cap
 */
export async function checkGlobalDailySpendCap(
  tables: TablesDB,
  config: RateLimitConfig = DEFAULT_RATE_LIMITS
): Promise<RateLimitCheckResult> {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();

  let totalCostUsd = 0;
  let offset = 0;
  const limit = 100;

  while (true) {
    const res = await tables.listRows({
      databaseId: "digr",
      tableId: "llm_usage",
      queries: [
        Query.greaterThanEqual("createdAt", startOfDay),
        Query.limit(limit),
        Query.offset(offset),
      ],
    });

    for (const row of res.rows) {
      totalCostUsd += (row as any).costUsd || 0;
    }

    if (res.rows.length < limit || offset > 500) {
      break;
    }
    offset += limit;
  }

  if (totalCostUsd >= config.globalDailySpendCapUsd) {
    return {
      allowed: false,
      statusCode: 503,
      type: "global_spend_cap",
      reasonAr: "تم بلوغ الحد الأقصى لميزانية المساعد الذكي اليومية للمنصة مؤقتاً للحماية. يرجى المحاولة غداً أو التواصل مع الإدارة.",
    };
  }

  return { allowed: true };
}

/**
 * Check individual conversation context token cap
 */
export function checkConversationTokenCap(
  totalConversationTokens: number,
  config: RateLimitConfig = DEFAULT_RATE_LIMITS
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
