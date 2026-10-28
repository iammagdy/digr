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
/** Owner decision: 0.05 USD per customer request (raised from 0.02 so a 0.0295 USD endpoint such as the Facebook keyword search can take one real sample); the day's cap is unchanged. */
export const EXPLORATION_REQUEST_CAP_USD = 0.05;
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

/**
 * The loop: at most this many model turns for one request. A refusal of the validator goes back to the model as a tool_result with the exact reason on EVERY turn that is left
 * (the model corrects the step); the turn ends without a plan only when the turns, the time or the exploration budget are spent.
 */
export const MAX_PLANNER_TURNS = 6;
/**
 * THE PLANNING BUDGET of a planning SESSION (named constants; nothing ends a request in «غير متاحة» for want of time): when any of them is spent the customer gets what was found and ONE question.
 *  - turns: the planning model's calls; model USD: its own spend; wall time: from the first step to the last; exploration USD is EXPLORATION_REQUEST_CAP_USD (the owner's cap per request).
 */
export const PLANNING_MAX_TURNS = 14;
export const PLANNING_MODEL_BUDGET_USD = 0.06;
export const PLANNING_MAX_WALL_MS = 6 * 60_000;
/** One function invocation of a planning session: it ends before this (the route allows 60 s), and a step that calls the model or a source is not started after PLANNING_STEP_SOFT_MS. */
export const PLANNING_STEP_DEADLINE_MS = 44_000;
export const PLANNING_STEP_SOFT_MS = 16_000;
/** The chat request's own first attempt (it holds the HTTP request open): a request that is done by then answers at once, like a single-stage one always did. */
export const PLANNING_INLINE_SOFT_MS = 26_000;
/** A running session nobody has stepped for this long is picked up by the background driver (the page may have been closed). */
export const PLANNING_SESSION_STALE_MS = 45_000;
/** A step holds the session's lease for this long. */
export const PLANNING_SESSION_LEASE_MS = 60_000;
/** A failed model call is tried again this many times (in later steps) before the session ends. */
export const MODEL_ERROR_RETRIES = 3;
/** The planner's own time for one chat request (ms from the start of the turn): the route allows 60 s and the page gives up at 55 s; the quote and the answer are written after it. */
export const PLANNER_TURN_BUDGET_MS = 48_000;
/** A further model turn is started only when at least this much time is left, and a model call is cut this long before the budget ends. */
export const PLANNER_MIN_TURN_MS = 7_000;
/** The most real sample calls (calls that REACH a source) one request may make, the model's own and the alternatives the code tries after a failure together. */
export const MAX_SAMPLE_CALLS = 5;
/** Alternatives (catalog siblings) tried for ONE sample the model asked for, after the first endpoint failed, returned nothing or was refused by a cap. */
export const MAX_SAMPLE_ALTERNATIVES = 3;
/** A sample of a PER-RECORD priced endpoint may spend at most this share of the exploration budget left for the request (at least one row is always asked when it fits). */
export const SAMPLE_BUDGET_SHARE_PER_RECORD = 0.4;
/** A sample call is given up after this long (ms); an alternative then gets its turn. */
export const SAMPLE_CALL_TIMEOUT_MS = 12_000;
/** The siblings an approved plan keeps for the worker to try when its call fails (cheaper or equal per call, in order of cost and observed success). */
export const MAX_RUNTIME_ALTERNATES = 2;
export const PLANNER_MAX_TOKENS = 2048;
export const PLANNER_TIMEOUT_MS = 30_000;

/** A plan has at most this many stages: roots (steps with no earlier step) and steps run once for each row of an earlier step. */
export const MAX_PLAN_STAGES = 4;
/** The interpreter reads at most this many listed items to fan out over, and at most this many provider calls in one worker chunk. */
export const MAX_FAN_OUT_PARENTS = 40;
export const MAX_CALLS_PER_CHUNK = 3;

/** The topic review (only when the request has a topic): rows per advisor call, and the most the review may cost one job (USD); past it the rows are HELD, never delivered unreviewed. */
export const TOPIC_REVIEW_ROWS_PER_CALL = 25;
export const TOPIC_REVIEW_JOB_CAP_USD = 0.15;
export const TOPIC_REVIEW_CALL_ESTIMATE_USD = 0.0083;

/** The model's own spend while it MANAGES an approved mission (first-page checks, stage transitions, the final review): 5% of the mission's reserve value, never below the floor. */
export const MANAGER_BUDGET_SHARE = 0.05;
export const MANAGER_BUDGET_FLOOR_USD = 0.01;
/** One management call is cut after this long (ms); a mission never waits on the model past it. */
export const MANAGER_CALL_TIMEOUT_MS = 12_000;
/** Without a typed number the customer's hold stays at or below this many points. */
export const DEFAULT_HOLD_CEILING_POINTS = 1000;
/** The reserve is the expected cost plus this share (the same 15% the quote writer adds). */
export const RESERVE_MARGIN = 1.15;
/** A sample of a per-call endpoint takes a second page (when the first answered a next-page token and the budget allows) so rows per call is measured on two pages. */
export const SAMPLE_PAGES_FOR_MEASURE = 2;
/** The most parent rows one stage of a mission keeps waiting for the next stage (the cursor carries them from chunk to chunk). */
export const MAX_MISSION_QUEUE = 120;
