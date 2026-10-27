/**
 * The MODEL PLANNER (Phase 2 of «AI in the loop»): the model decides which catalog endpoint to call and how; code only validates, prices, budgets and protects.
 *
 * ROLLOUT is by ACCOUNT, not by a global switch: only the accounts in this list take the model path (chat planning). Every other account keeps the old hand-coded path,
 * unchanged. Matching is on the signed-in account's verified e-mail, case-insensitive and exact. A guest has no e-mail of its own, so a guest stays on the old path until this
 * rule is widened. The worker runs any stored model plan whatever the account (a plan the customer approved is always executed).
 */
export const MODEL_PLANNER_ALLOWED_EMAILS: readonly string[] = ["magdy.saber@outlook.com", "iam.magdy+1@outlook.com"];

/** Does this account take the model path? The signed-in account's e-mail must be in the allowlist; a guest never is. */
export function isModelPlannerAccount(account: { email?: string | null; isGuest?: boolean } | null | undefined): boolean {
  if (!account || account.isGuest) return false;
  const email = String(account.email ?? "").trim().toLowerCase();
  return email.length > 0 && MODEL_PLANNER_ALLOWED_EMAILS.some((allowed) => allowed.toLowerCase() === email);
}

/** The capability slug every model-planned quote item carries; the real endpoint, the field map and the filters live in the item's params. */
export const MODEL_PLAN_SLUG = "model-planned";
/** The param key that holds the approved step spec on a stored quote item. Starts with «_», so the gateway client never sends it to a source. */
export const MODEL_PLAN_PARAM = "_modelStep";
/** The customer's own words that justified the plan, kept for the topic review (a prefix «_»: never sent to a source). */
export const MODEL_PLAN_REQUEST_PARAM = "_customerRequest";
/** The purpose a customer account gave for a sensitive step (never sent to a source). */
export const MODEL_PLAN_PURPOSE_PARAM = "_purpose";

export const PLANNER_MODEL_DEFAULT = "claude-haiku-5-5";

/**
 * Price of the planning model per million tokens, USD (Anthropic's public price list for Haiku 5.5, read in Phase 0): 0.10 in, 0.50 out, cache read 0.01, 5-minute
 * cache write 0.125. The global table `DEFAULT_LLM_PRICING` still carries 0.80 / 4.00 for this model (an 8x error that Phase 0 reported and the owner has not asked to
 * change), so the planner prices ITS OWN tokens with this constant and leaves that table alone.
 */
export const PLANNER_MODEL_PRICE = { inputPerMillion: 0.10, outputPerMillion: 0.50, cacheReadPerMillion: 0.01, cacheWritePerMillion: 0.125 } as const;

/** What exploration (real sample calls made BEFORE the customer approves) may spend: an owner cost, never charged to the customer. */
export const EXPLORATION_REQUEST_CAP_USD = 0.02;
export const EXPLORATION_DAY_CAP_USD = 0.50;
/** The capability marker exploration rows carry in provider_costs (that table has no reason column: `capability` is the reason). */
export const EXPLORATION_COST_MARKER = "exploration";
export const EXPLORATION_JOB_PREFIX = "explore_";

/** Largest page a sample asks for, and the rows of it the model gets back. */
export const SAMPLE_ROWS_REQUESTED = 10;
/** The page a sample of a per-CALL-priced endpoint asks for (the price is per call, so a fuller page costs the same and measures the rows one call returns). */
export const SAMPLE_PAGE_ROWS_PER_CALL = 20;
export const SAMPLE_ROWS_IN_DIGEST = 3;
export const SAMPLE_ROWS_ON_CARD = 3;
/** Cap on the characters of one value in a digest or on the card. */
export const DIGEST_VALUE_CHARS = 120;

/** The loop: at most this many model turns, and this many validation failures (the first goes back to the model as a tool_result, the second ends the turn). */
export const MAX_PLANNER_TURNS = 8;
export const MAX_VALIDATION_FAILURES = 2;
export const PLANNER_MAX_TOKENS = 2048;
export const PLANNER_TIMEOUT_MS = 40_000;

/** A plan has at most this many stages (a listing step, then one step run for each listed item). */
export const MAX_PLAN_STAGES = 2;
/** The interpreter reads at most this many listed items to fan out over, and at most this many provider calls in one worker chunk. */
export const MAX_FAN_OUT_PARENTS = 40;
export const MAX_CALLS_PER_CHUNK = 3;

/** The topic review (only when the request has a topic): rows per advisor call, and the most the review may cost one job (USD); past it the rows are HELD, never delivered unreviewed. */
export const TOPIC_REVIEW_ROWS_PER_CALL = 25;
export const TOPIC_REVIEW_JOB_CAP_USD = 0.15;
export const TOPIC_REVIEW_CALL_ESTIMATE_USD = 0.0083;
