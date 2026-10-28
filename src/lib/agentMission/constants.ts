import { DEFAULT_PRICING_BASIS } from "../recordPricing";
import { JOB_MAX_POINTS_CAP } from "../jobPointsCap";
import { HOLD_SPEND_SHARE, CALL_CEILING_FLOOR_USD } from "../server/callBudget";

/**
 * Everything the AGENT WORKER (agent/) and the admin page «الوكيل» share, named once. Pure: no server import, so the website and the worker read the same numbers.
 *
 * The agent never states a price. The price of a mission is computed by code (price.ts) from the costs the gateway MEASURED and recorded.
 */

/** The only account a mission may run for in Phase A (the test account of docs/HANDOFF.md). Nothing here changes what a customer sees. */
export const AGENT_TEST_ACCOUNT_EMAIL = "iam.magdy+1@outlook.com";

export const MISSION_TABLE = "missions";
export const MISSION_EVENTS_TABLE = "mission_events";
export const MISSION_CALLS_TABLE = "mission_calls";
export const AGENT_HEARTBEAT_TABLE = "agent_worker_heartbeat";
export const AGENT_SETTINGS_TABLE = "agent_settings";
/** Private storage bucket (no policy: only the service role reads or writes) that holds every saved TREG page, code output, saved row set and result file of a mission. */
export const AGENT_BUCKET = "agent-missions";
/** The key of the setting the owner flips to move PLANNING to the stronger model. */
export const PLANNING_MODEL_SETTING_KEY = "planning_model";

export const MODEL_HAIKU = "claude-haiku-5-5";
export const MODEL_SONNET = "claude-sonnet-5-5";
/** The models the owner may choose; anything else in the setting or in AGENT_MODEL is ignored. */
export const AGENT_ALLOWED_MODELS: readonly string[] = [MODEL_HAIKU, MODEL_SONNET];
export const AGENT_MODEL_DEFAULT = MODEL_HAIKU;

/** Mission statuses. `queued` waits for a worker to PLAN it; `approved` waits for a worker to EXECUTE it. */
export const MISSION_STATUSES = ["queued", "planning", "needs_input", "plan_ready", "approved", "executing", "completed", "failed", "unserved", "cancelled"] as const;
export type MissionStatus = (typeof MISSION_STATUSES)[number];
export const MISSION_TERMINAL: ReadonlySet<string> = new Set(["completed", "failed", "unserved", "cancelled"]);

export const EVENT_KINDS = ["progress", "plan", "question", "answer", "call", "result", "system", "refusal"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

// ---------------------------------------------------------------- the worker
/** How many missions one worker process runs at the same time (planning or executing). */
export const AGENT_WORKER_CONCURRENCY = 2;
export const AGENT_POLL_INTERVAL_MS = 5_000;
/** The worker writes a heartbeat row this often; the admin page calls it alive while the last beat is younger than AGENT_HEARTBEAT_ALIVE_MS. */
export const AGENT_HEARTBEAT_INTERVAL_MS = 30_000;
export const AGENT_HEARTBEAT_ALIVE_MS = 90_000;
/** A claimed mission is leased to its worker for this long and the lease is renewed with every heartbeat: a dead worker's mission is taken over after the lease ends. */
export const AGENT_MISSION_LEASE_SECONDS = 120;
/** The lease taken on the JOB of an approved mission (claim_job_chunk), so the website's old driver never runs a chunk of it. complete_chunk clears it when the mission ends. */
export const AGENT_JOB_LEASE_SECONDS = 6 * 3600;
/** The job a mission reserves under carries this capability slug (the old worker knows no such capability and so cannot run it). */
export const AGENT_CAPABILITY_SLUG = "agent-mission";

// ----------------------------------------------------------------- the money
/** TREG USD budget of the PLANNING phase of one mission (the calls made before the customer approves anything). An owner cost, never charged. */
export const AGENT_PLANNING_BUDGET_USD = 0.05;
/** The execution budget is HOLD_SPEND_SHARE (40%) of the approved reserve's value, never below CALL_CEILING_FLOOR_USD (0.005). Same numbers as the website's job budget. */
export const AGENT_EXECUTION_BUDGET_SHARE = HOLD_SPEND_SHARE;
export const AGENT_EXECUTION_BUDGET_FLOOR_USD = CALL_CEILING_FLOOR_USD;
/** What the MODEL itself may cost one mission (USD), per phase. The planning figure is for the Haiku default; the SDK stops the run at it. */
export const AGENT_PLANNING_LLM_BUDGET_USD = 0.30;
export const AGENT_EXECUTION_LLM_BUDGET_SHARE = 0.05;
export const AGENT_EXECUTION_LLM_BUDGET_FLOOR_USD = 0.10;

/** unit price (points) = cost per final row (USD) x 5,500; reserve = ceil(volume x unit x 1.15); cap 25,000 points. The same figures as the website (recordPricing.ts, jobPointsCap.ts). */
export const AGENT_PRICING_BASIS = DEFAULT_PRICING_BASIS;
export const AGENT_RESERVE_MARGIN = 1 + DEFAULT_PRICING_BASIS.safetyBuffer;
export const AGENT_JOB_POINTS_CAP = JOB_MAX_POINTS_CAP;
/** accept_quote_atomic refuses a target volume above this. */
export const AGENT_MAX_DELIVERED_ROWS = 5_000;

// ------------------------------------------------------------- plan and rows
export const MAX_PLAN_STAGES = 4;
export const MAX_SAMPLE_ROWS_PER_STAGE = 3;
export const MAX_COLUMNS_PER_STAGE = 30;
/** What treg_call returns to the model of a saved page: the shape digest plus this many first rows (values cut), never the whole page. */
export const AGENT_FIRST_ROWS = 5;
export const AGENT_VALUE_CHARS = 160;
/** save_rows with rows given inline takes at most this many; larger sets come from a run_code output. */
export const AGENT_INLINE_ROWS_MAX = 200;

// ----------------------------------------------------------------- the model
export const AGENT_PLANNING_MAX_TURNS = 60;
export const AGENT_EXECUTION_MAX_TURNS = 400;
export const AGENT_PLANNING_WALL_MS = 20 * 60_000;
export const AGENT_EXECUTION_WALL_MS = 6 * 3600_000;

// ----------------------------------------------------------------- the sandbox
export const SANDBOX_TIMEOUT_MS = 20_000;
export const SANDBOX_MAX_HEAP_MB = 192;
export const SANDBOX_MAX_INPUT_BYTES = 24 * 1024 * 1024;
export const SANDBOX_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
/** A run_code result up to this size comes back inline; a bigger one is saved as an output file and only a preview comes back. */
export const SANDBOX_INLINE_RESULT_CHARS = 6_000;
