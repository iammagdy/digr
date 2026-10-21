# Reuse the day's model-spend sum for 45 seconds (APPLIED, owner-authorized 2026-10-21)

Status: APPLIED after the owner's explicit authorization ("cache the READ of the daily model-spend sum ... for 30 to 60 seconds per
server instance, adding the current instance's own spend since the read ... failing safe"). Code: `src/functions/shared/rateLimits.ts`
(`SPEND_READ_CACHE_MS = 45_000`, `noteLocalLlmSpend`), wired in `src/app/api/chat/route.ts` and `src/functions/shared/chatHandler.ts`.
Tests: `tests/daily-spend-read-cache.test.ts`, `tests/conference-load-harness.test.ts`. No cap, limit, price or constant changed. The cached
sum is used only when it is under 80% of the cap (near the cap every turn reads fresh), within the same UTC day, and never when the read
failed. The text below is the original proposal.

## What the harness showed

`src/app/api/chat/route.ts` calls `checkGlobalDailySpendCap(tables)` on every chat turn. That calls `sumTodayLlmCostSupabase`, which
reads every `llm_usage` row of the current UTC day:

* first a plain `select cost_usd where created_at >= today` (the API returns at most 1000 rows);
* if that returns 1000 rows, the whole day is re-read page by page (1000 rows per request, up to 50 pages) in sequence.

So the cost of one chat turn grows with the number of model calls made so far today: about 1 request while the day holds under
1000 rows, 2 to 3 sequential requests at 2000 rows, and 51 requests at the 50-page ceiling (50 000 rows). At 50 000 rows the check
fails closed and every chat turn answers 503 («المساعد متوقف مؤقتاً للحماية»). For a room of 500 people each sending several
messages, the first 1000 rows are reached within the first hour.

## Proposed change (about 20 lines, no money code, no limit value)

Let one server instance reuse a sum it read less than 20 seconds ago, only while the day is below 80% of the cap:

```ts
let spendReadCache: { day: string; totalUsd: number; readAt: number } | null = null;

export async function checkGlobalDailySpendCap(tables, config = DEFAULT_RATE_LIMITS, options: { cacheMs?: number } = {}) {
  // ... cap resolved as today ...
  const dayStart = utcStartOfDay();
  const cached = spendReadCache;
  if (options.cacheMs && cached && cached.day === dayStart && Date.now() - cached.readAt < options.cacheMs && cached.totalUsd < cap * 0.8) {
    totalCostUsd = cached.totalUsd;
  } else {
    totalCostUsd = await sumTodayLlmCostSupabase(tables, dayStart);
    if (options.cacheMs) spendReadCache = { day: dayStart, totalUsd: totalCostUsd, readAt: Date.now() };
  }
  // ... compare with cap as today ...
}
```

and in the chat route: `checkGlobalDailySpendCap(tables, undefined, { cacheMs: 20_000 })`.

* The cap value, the resolver and the fail-closed behaviour on read errors are unchanged.
* Existing tests call the function without `options`, so they do not see the cache.
* Worst case: an instance serves a sum up to 20 seconds old, below 80% of the cap; the overshoot is bounded by 20 seconds of
  model spend, and from 80% of the cap on every turn reads fresh.
* A durable alternative (needs SQL, so also only a proposal): a one-row `settings_private` counter or a `sum()` view/RPC so the
  read is one small request. Not needed if the cache is accepted.

## Measured effect

Measured today (no cache) by `tests/conference-load-harness.test.ts` ("one turn late in a busy day", API row ceiling 1000): a chat
turn issues 1 spend-read request when the day holds up to 900 rows, 5 at 2500 rows and 12 at 10 000 rows. With the cache, a turn
issues at most one such read per instance per 20 seconds while the day is below 80% of the cap.
