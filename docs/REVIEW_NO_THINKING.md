# Thinking off on the model-review calls

**Evidence.** `review_sample` of the job of 22 Oct 2026 06:12 UTC: a clean 578-character reply that starts with `{`, no reasons, `stop_reason end_turn`, yet 1,935 output tokens billed for 17 rows (the whole job: 28,205 output tokens in 15 calls, about 1,880 a call). About 1,700 tokens a call are not in the text we receive. Anthropic bills thinking as output tokens even when the thinking text is not returned, and claude-haiku-5-5 runs adaptive thinking by default.

## What the docs say (read 22 Oct 2026)
- `platform.claude.com/docs/en/build-with-claude/effort`, "Recommended effort levels for Claude Haiku 5.5": *"To get less thinking, lower the effort level. You can also send `thinking: {"type": "disabled"}` at `high` effort or below. At `xhigh` or `max`, it returns a 400 error."* The default effort is `medium`, and sending nothing equals `medium`. With `thinking` disabled, a per-message effort that differs from the one in effect is a 400 (not used here).
- `.../thinking-steering-and-cost`: thinking is "billed as output tokens", `usage.output_tokens_details.thinking_tokens` reports how many; telling Haiku 5.5 in the prompt to answer directly "didn't stop it from thinking", so the prompt is not the lever; effort or `disabled` is.
- `.../models/haiku-5-5/migration-guide`: adaptive thinking is on by default; `budget_tokens` is a 400. Not used.

**Parameter used:** `"thinking": {"type": "disabled"}` on the Messages request. Nothing else changes (model string, `max_tokens`, prompt, no `effort`, no sampling fields). The model supports disabling it, so no alternative is needed.

## Where and how
- One flag: `REVIEW_THINKING = "off" | "default"` in `src/lib/server/rowReviewAdvisor.ts` (default `off`). `default` sends no `thinking` field, which is exactly the previous request. The owner reverts with that one line.
- Applied only in `callClaudeRowAdvisor` (the first call and the retry of missing rows). Chat and planning use `LlmClient`, which has no such field (a test checks a real chat request body and that its source does not mention the flag). The separate company-relevance review (`companyRelevanceReview.ts`) is another function and is not changed. `callClaudeRowAdvisor` also serves the company advisory, so those review calls get the parameter too.
- **HTTP 400 on it:** the same request is repeated ONCE without the parameter (never a third request), and one internal `review_failure` row says `kind=thinking_param_rejected code=http_400 detail=... action=repeated_without_thinking_param`. Other statuses (401, 429, 5xx) and network failures behave as before; with the flag on `default` a 400 is not retried.
- Unchanged: verdict-only compact format, partial-reply salvage, retry-missing-only, fail-closed, budgets, the strict-format rule and the sharper match definition.
- `review_sample` now also records `thinking_tokens=` (from the API) and `thinking=off|default|fallback`, next to the existing `out=` tokens, so the next job shows the effect.

## Expected effect (an estimate, no live call was made)
A verdict-only reply for 17 to 20 rows is about 300 to 350 output tokens. At the recorded rates (0.80 / 4.00 USD per million) a call goes from about 0.0099 to about 0.0038 USD (about 60% less), so the same 0.15 USD job budget would review about 2.5 times the rows. The per-call cost estimate (`REVIEW_CALL_COST_ESTIMATE_USD`, 0.0083 per 25 rows) is left as it is: it cannot be derived from measured data before a live job; it stays conservative (a lower real cost only leaves budget unused), and the first live job's `review_sample` and `review_cost` rows give the real number.

**Risk.** Without thinking the model may be less precise on borderline rows. The first job after this change shows the verdict mix (match / uncertain / no_match); if precision drops, set `REVIEW_THINKING` to `default`.

## A pricing finding for the owner (not changed here)
The recorded model price for claude-haiku-5-5 is 0.80 input / 4.00 output USD per million (`DEFAULT_LLM_PRICING` in `src/functions/shared/llmClient.ts`). Anthropic's pricing page lists **0.10 / 0.50** for prompts up to 100,000 tokens (`platform.claude.com/docs/en/about-claude/pricing`). If that is the real rate, every recorded model cost (review, chat, planning) is about 8 times the real bill: the 06:12 job's review would have been about 0.019 USD, not 0.148, against 0.018 USD of revenue. The budgets and caps are set against the recorded numbers, so correcting it changes them all: it needs the owner's decision and a check of the real bill in the Anthropic console, so it is not part of this change.
