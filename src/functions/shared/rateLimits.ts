import { TablesDB, Query } from "node-appwrite";

export interface RateLimitConfig {
  messagesPerMinute: number;
  messagesPerDay: number;
  conversationMaxTokens: number;
  globalDailySpendCapUsd: number;
  userDailySpendCapUsd?: number;
}

export const DEFAULT_RATE_LIMITS: RateLimitConfig = {
  messagesPerMinute: 10,
  messagesPerDay: 100,
  conversationMaxTokens: 40_000,
  globalDailySpendCapUsd: 1.0,
  userDailySpendCapUsd: 0.10,
};

export interface RateLimitCheckResult {
  allowed: boolean;
  reasonAr?: string;
  statusCode?: 429 | 503;
  type?: "minute_limit" | "daily_limit" | "global_spend_cap" | "user_spend_cap" | "conversation_token_cap";
}

function utcStartOfDay(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

function configuredCap(name: string, fallback: number): number {
  const configured = Number(process.env[name]);
  return Number.isFinite(configured) && configured >= 0 ? configured : fallback;
}

function spendCapResult(type: "global_spend_cap" | "user_spend_cap"): RateLimitCheckResult {
  return {
    allowed: false,
    statusCode: type === "global_spend_cap" ? 503 : 429,
    type,
    reasonAr: type === "global_spend_cap"
      ? "تم بلوغ الحد اليومي لاستخدام المساعد على مستوى المنصة مؤقتاً للحماية. يرجى المحاولة غداً."
      : "تم بلوغ الحد اليومي لاستخدام المساعد لهذا الحساب. يرجى المحاولة غداً.",
  };
}

/** Check per-user message rate limits (per minute and per UTC day). */
export async function checkUserRateLimits(
  tables: TablesDB,
  userId: string,
  config: RateLimitConfig = DEFAULT_RATE_LIMITS,
): Promise<RateLimitCheckResult> {
  const oneMinuteAgo = new Date(Date.now() - 60_000).toISOString();
  const startOfDay = utcStartOfDay();

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
  return totalCostUsd >= cap ? spendCapResult("global_spend_cap") : { allowed: true };
}

/** Check a user's daily provider spend using server-side usage rows only. */
export async function checkUserDailySpendCap(
  tables: TablesDB,
  userId: string,
  config: RateLimitConfig = DEFAULT_RATE_LIMITS,
): Promise<RateLimitCheckResult> {
  const cap = configuredCap("LLM_USER_DAILY_SPEND_CAP_USD", config.userDailySpendCapUsd ?? 0.10);
  const totalCostUsd = await sumDailyUsageCost(tables, userId);
  return totalCostUsd >= cap ? spendCapResult("user_spend_cap") : { allowed: true };
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
