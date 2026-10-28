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

/**
 * THE ROLLBACK SWITCH (Phase 1). true: every customer request in the chat goes to the agent (a mission is created for the signed-in user, or for the guest, who must sign up before approving).
 * false: the chat answers with the old planner path exactly as before; nothing else needs to change. To roll back, set this one constant to false and redeploy the website.
 */
export const AGENT_SERVES_CHAT = true;
/** One account may have this many missions at once in the worker's hands (waiting, planning, or asked a question); the next request is told to wait for one. A plan that waits for approval holds nothing and does not count. */
export const AGENT_MAX_OPEN_MISSIONS_PER_USER = 3;
/** And at most this many new missions in one hour (every plan costs the owner a planning run): the next request is told to try again later. */
export const AGENT_MAX_MISSIONS_PER_HOUR = 20;
/** The sentence shown right after the customer approves, and in the in-site notice: the work continues without the page, and an e-mail follows. */
export const AGENT_CLOSE_PAGE_LINE_AR = "تقدر تقفل الصفحة وتروح تشرب قهوة، هنكمّل الشغل وهنبعتلك إيميل أول ما نخلص.";
/** Shown while a mission waits for the worker to be free. */
export const AGENT_QUEUE_LINE_AR = "مهمتك في الدور وهتبدأ خلال دقائق";
/** A running mission with no new event for this long gets the honest «المصدر أبطأ» line. */
export const AGENT_SLOW_AFTER_MS = 90_000;

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
/** The fixed keys of an event's `counts` (numbers never go in the text). `stage_<n>_rows` (rows saved in stage n) is also allowed. */
export const MISSION_EVENT_COUNT_KEYS = ["stages", "rows", "stage", "saved", "planned", "pages", "sources", "delivered", "charged_points", "reserve_points", "unit_points_x1000", "queue_ahead", "seconds_left", "requeued", "samples"] as const;
export type MissionEventCountKey = (typeof MISSION_EVENT_COUNT_KEYS)[number];

// ---------------------------------------------------------------- the worker
/**
 * How many missions one worker process runs at the same time (planning or executing). The default is 1: a Heroku Basic dyno has 512 MB, and the Claude Agent SDK runs a native
 * process of its own for each running mission. The owner raises it with the environment variable AGENT_CONCURRENCY (never above AGENT_CONCURRENCY_MAX).
 */
export const AGENT_WORKER_CONCURRENCY = 1;
export const AGENT_CONCURRENCY_ENV = "AGENT_CONCURRENCY";
export const AGENT_CONCURRENCY_MAX = 4;
/** The memory of a Heroku Basic dyno (MB), and the share of it above which the admin page warns. */
export const AGENT_DYNO_MEMORY_MB = 512;
export const AGENT_MEMORY_WARN_SHARE = 0.8;
/**
 * MEMORY ON THE 512 MB DYNO. All of it is the memory of the worker AND the processes it started (tree RSS, read from /proc), the figure the dyno's limit counts.
 *
 * WHERE THE NUMBERS COME FROM (evidence, not guesses):
 *  - idle readings of the worker after a restart: 208, 214, 217, 238, 250 MB tree (agent_worker_heartbeat, 2026-10-28);
 *  - the owner saw ONE normal planning run (a tweets / companies request) peak at 486 MB tree on this dyno WITHOUT crashing: so the SDK's own process costs about 486 - 216 = 270 MB (AGENT_SDK_CHILD_PEAK_MB);
 *  - the guard of PR #275 stopped a normal one-stage planning about 10 s after it started, at a hard limit of 450 MB: the limit was below what a normal run needs.
 * So: the hard limit sits above the measured normal peak (AGENT_MEMORY_OBSERVED_PLANNING_PEAK_MB), just over the dyno's quota (an overrun of the quota is the platform's R14 warning, not a kill; the kill threshold is NOT measured),
 * and a NEW mission is admitted only when the idle memory plus a normal run's SDK process still fits under that limit (admit = hard - SDK child). Every run now records its own peak (an internal event), so these numbers are
 * re-set from the dyno's real peaks, not from this reasoning.
 *  - a NEW mission is not taken (it stays queued, nothing is leased) while the tree is at or above AGENT_MEMORY_ADMIT_LIMIT_MB; an IDLE worker that stays at or above it for AGENT_MEMORY_RECYCLE_AFTER_MS exits so the platform
 *    restarts it with a fresh heap (otherwise the queue could wait for ever);
 *  - a RUNNING mission whose tree reaches AGENT_MEMORY_HARD_LIMIT_MB is stopped by the worker before the platform kills the dyno and put back in the queue (a mission that holds a reserve goes back to «approved» with everything
 *    it saved), at most AGENT_MEMORY_REQUEUES_MAX times; after that it finishes with what is saved (settled like any other end).
 */
export const AGENT_MEMORY_PLANNING_TARGET_MB = 400;
export const AGENT_MEMORY_OBSERVED_PLANNING_PEAK_MB = 486;
export const AGENT_SDK_CHILD_PEAK_MB = 270;
export const AGENT_MEMORY_HARD_LIMIT_MB = 520;
export const AGENT_MEMORY_ADMIT_LIMIT_MB = AGENT_MEMORY_HARD_LIMIT_MB - AGENT_SDK_CHILD_PEAK_MB;
export const AGENT_MEMORY_REQUEUES_MAX = 2;
export const AGENT_MEMORY_RECYCLE_AFTER_MS = 120_000;
/** How often the worker reads its memory while a mission runs (the peak of the run is the highest reading). */
export const AGENT_MEMORY_WATCH_MS = 2_000;
/** The Claude Agent SDK starts a native process for each session: one at a time. */
export const AGENT_SDK_SESSIONS_AT_ONCE = 1;
/** The Node heap of the worker process (MB), set by the Procfile (`--max-old-space-size`). */
export const AGENT_NODE_HEAP_MB = 192;

/**
 * THE REAL BUCKET'S MIME RULES (docs/proposals/agent-worker/03_agent_storage.sql, read back from storage.buckets on 2026-10-28): anything else is refused by Storage («mime type text/plain is not supported»).
 * The in-memory store of the tests enforces this same list, so a write the real bucket would refuse fails in the tests too.
 */
export const AGENT_BUCKET_ALLOWED_MIME = ["application/json", "text/csv", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"] as const;
/** What a mission remembers about its own runs (starts, requeues by cause), as JSON in its own folder of the bucket. */
export const AGENT_RUN_STATE_FILE = "run_state.json";
/** A run that ends with an exception puts the mission back in the queue at most this many times; after that it ends honestly (planning: no hold, a clear message; execution: settled with what is saved). */
export const AGENT_ERROR_REQUEUES_MAX = 2;
/** The most times a phase may START for one mission (the first start, answers, requeues, takeovers after a dead worker). A mission that keeps killing its worker ends honestly instead of looping. */
export const AGENT_PHASE_STARTS_MAX = 8;
/** Planning with no new event for this long gets the honest «still working, nothing held» line (never an ETA). */
export const AGENT_STALL_AFTER_MS = 180_000;
/** Events that carry the run's measured memory (internal: the admin sees them, the customer never does). */
export const MISSION_INTERNAL_COUNT_KEYS = ["mem_phase", "mem_start_rss_mb", "mem_peak_rss_mb", "mem_start_tree_mb", "mem_peak_tree_mb", "mem_samples", "mem_seconds", "mem_stopped"] as const;
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
/** The same budget for a MULTI-STAGE request (a parent and its children: posts and their comments, companies and their employees and contacts): every stage needs its own sample. Raised on 2026-10-28 (owner decision). */
export const AGENT_PLANNING_BUDGET_MULTI_STAGE_USD = 0.10;
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
/** collect_pages: most pages one call may fetch (the mission's execution budget still decides how many it may pay for). */
export const AGENT_COLLECT_MAX_PAGES = 60;
export const AGENT_PLANNING_MAX_TURNS = 60;
export const AGENT_EXECUTION_MAX_TURNS = 400;
export const AGENT_PLANNING_WALL_MS = 20 * 60_000;
export const AGENT_EXECUTION_WALL_MS = 6 * 3600_000;

// ----------------------------------------------------------------- the sandbox
export const SANDBOX_TIMEOUT_MS = 20_000;
export const SANDBOX_MAX_HEAP_MB = 96;
export const SANDBOX_MAX_INPUT_BYTES = 12 * 1024 * 1024;
export const SANDBOX_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
/** A run_code result up to this size comes back inline; a bigger one is saved as an output file and only a preview comes back. */
export const SANDBOX_INLINE_RESULT_CHARS = 3_000;
