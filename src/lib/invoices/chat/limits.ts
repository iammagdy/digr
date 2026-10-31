import { ASSIST_MODEL, ASSIST_PRICE_PER_MTOK } from "../assist";

/**
 * «مساعد الفواتير» (the invoice agent): every limit in one place. The model only TRANSLATES the owner's words into a fixed list of actions and maps file columns;
 * counting and money are done by code. Files are processed in memory, per request: never stored, never logged.
 */
export const AGENT_MODEL = ASSIST_MODEL; // claude-haiku-5-5: the cheapest current model, with vision
export const AGENT_PRICE_PER_MTOK = ASSIST_PRICE_PER_MTOK;
export const AGENT_MAX_CALLS_PER_HOUR = 30;
export const AGENT_MAX_CHARS = 4000;
export const AGENT_MAX_FILES = 5;
export const AGENT_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const AGENT_MAX_ROWS_TOTAL = 50_000;
/** a spreadsheet may have wide sheets; only the first columns are profiled and counted */
export const AGENT_MAX_COLUMNS = 40;
export const AGENT_MAX_SHEETS = 20;
export const AGENT_SAMPLES_PER_COLUMN = 5;
export const AGENT_MAX_OUTPUT_TOKENS = 6000;
export const AGENT_MAX_ACTIONS = 12;
export const AGENT_HISTORY_TURNS = 6;
/** an uploaded .xlsx is a zip: refuse one that would inflate far beyond what 10 MB of real data needs */
export const AGENT_MAX_UNZIPPED_BYTES = 120 * 1024 * 1024;
/** the Messages API takes at most 5 MB per image */
export const AGENT_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Vercel serverless functions accept a request body of about 4.5 MB: the screen stops a bigger upload before it is sent */
export const AGENT_REQUEST_BODY_SOFT_LIMIT = 4 * 1024 * 1024;

export const SPREADSHEET_EXT = ["xlsx", "csv"] as const;
export const IMAGE_EXT = ["png", "jpg", "jpeg"] as const;

export const agentCostUsd = (inputTokens: number, outputTokens: number): number =>
  (inputTokens * AGENT_PRICE_PER_MTOK.input + outputTokens * AGENT_PRICE_PER_MTOK.output) / 1_000_000;
