/**
 * THE SPENDING GUARD OF THE LIVE INTELLIGENCE EVALUATION (docs/LIVE-INTELLIGENCE-EVAL.md).
 *
 * Every HTTP attempt the evaluation makes goes through `createSpendingGuard(...).fetch`:
 *   - only `POST https://api.anthropic.com/v1/messages` and `POST https://api.anthropic.com/v1/messages/count_tokens` are allowed; every other host or path throws before any network I/O
 *     (TREG, Firecrawl, Context.dev, Supabase and everything else are hard-blocked);
 *   - before EACH `/v1/messages` attempt (the 400-retry of `callClaudeChatWith` is a second attempt and is counted like any other): refuse at the attempt cap; read the exact input tokens with
 *     `count_tokens` (free) or, when it is unavailable, estimate UTF-8 bytes / 2; reserve the worst case (input × input price + max_tokens × output price); refuse when spent + reserved exceeds the cap;
 *   - after each attempt: record the actual usage, stop reason, truncation, latency and cost; HALT (every later call throws) when the actual cost exceeds its reservation or the response is unexpected;
 *   - THE CUMULATIVE BUDGET (cumulative.ts, the LLM quality mission): every attempt is ALSO reserved in a state file outside the repository, before it is sent, against the owner's total ceiling across every run (restarts, retries,
 *     failures and concurrent runs included); a non-200 answer is charged its input conservatively, a network failure its whole reservation.
 *
 * The API key is never read here: it travels only in the request headers the caller built, which this module forwards unchanged and never records, prints or puts in an error message.
 */
import type { CumulativeBudget } from "./cumulative";

export const EVAL_MODEL = "claude-haiku-5-5";
/** claude-haiku-5-5, Anthropic first-party rates for prompts up to 100K tokens (above that $0.50 / $2.50, which this guard never reaches: it refuses such a prompt). Confirmed against the current model table before the run. */
export const HAIKU_55_PRICE: Price = { inputPerM: 0.1, outputPerM: 0.5 };
export const PRICE_TIER_MAX_INPUT_TOKENS = 100_000;
/** Per-RUN defaults (a run may set lower or higher ones with LIVE_EVAL_MAX_ATTEMPTS / LIVE_EVAL_MAX_USD, never above the cumulative budget below). */
export const MAX_PAID_ATTEMPTS = 30;
export const MAX_USD = 1.0;
/** The chat transport clamps every call to this many output tokens (`CHAT_MODEL_BRIEF_MAX_TOKENS`); a request asking for more is refused unless the guard was given a higher ceiling (the planner driver). */
export const MAX_OUTPUT_TOKENS = 700;
/** The highest output ceiling any evaluation call may ask (the real-planner driver's turns). */
export const PLANNER_MAX_OUTPUT_TOKENS = 4096;
/**
 * THE OWNER'S CUMULATIVE AUTHORIZATION: $30 in total across every evaluation run, retry and failure (raised from $10 by the owner on 2026-11-12, intelligence completion mission). The persistent budget never accepts a ceiling above it.
 * The earlier mission's reported $4.2746 counts inside it: the state of this mission was created with a ceiling of $30 − $4.2746 = $25.7254 (docs/DIGER-INTELLIGENCE-FINAL-ACCEPTANCE.md).
 */
export const AUTHORIZED_TOTAL_USD = 30;
/** The most paid attempts the cumulative budget accepts in total (a second, independent stop). */
export const AUTHORIZED_TOTAL_ATTEMPTS = 9000;
/** Added to every input count: in the live run (2026-11-12) the billed input exceeded count_tokens by up to 5 tokens (the count request then carried no `thinking` field); the margin keeps the reservation a true upper bound. */
export const COUNT_MARGIN_TOKENS = 32;
export const CONFIRM_ENV = "LIVE_EVAL_CONFIRM";
export const CONFIRM_VALUE = "intelligence-30usd-cumulative";
/** The folder of the persistent cumulative budget (state file and lock): must be outside the repository. */
export const BUDGET_DIR_ENV = "LIVE_EVAL_BUDGET_DIR";
export const KEY_ENV = "DIGER_EVAL_ANTHROPIC_KEY";
export const FORBIDDEN_ENV = ["SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL", "TREG_TOKEN", "TREG_API_KEY", "ANTHROPIC_API_KEY"] as const;
export const FORBIDDEN_ENV_PREFIXES = ["FIRECRAWL_", "CONTEXT_DEV_", "CONTEXTDEV_"] as const;
/** Values of these that switch the product's chat transport off (a run would measure nothing). */
const TRANSPORT_OFF: Array<[string, string]> = [["LLM_PROVIDER", "fake"], ["LLM_ENABLED", "false"], ["LLM_LIVE", "false"]];

const ANTHROPIC_HOST = "api.anthropic.com";
const MESSAGES_PATH = "/v1/messages";
const COUNT_PATH = "/v1/messages/count_tokens";

export interface Price { inputPerM: number; outputPerM: number }

/** The isolation preflight: the NAMES of the problems (never a value). Empty: the run may start. */
export function preflight(env: Record<string, string | undefined>): string[] {
  const problems: string[] = [];
  const set = (name: string) => typeof env[name] === "string" && env[name]!.trim() !== "";
  for (const name of FORBIDDEN_ENV) if (set(name)) problems.push(`forbidden_env_set:${name}`);
  for (const name of Object.keys(env)) if (FORBIDDEN_ENV_PREFIXES.some((p) => name.startsWith(p)) && set(name)) problems.push(`forbidden_env_set:${name}`);
  if (env[CONFIRM_ENV] !== CONFIRM_VALUE) problems.push(`confirmation_missing:${CONFIRM_ENV}`);
  if (!set(KEY_ENV)) problems.push(`key_missing:${KEY_ENV}`);
  if (!set(BUDGET_DIR_ENV)) problems.push(`budget_dir_missing:${BUDGET_DIR_ENV}`);
  for (const [name, off] of TRANSPORT_OFF) if ((env[name] ?? "").trim().toLowerCase() === off) problems.push(`transport_disabled:${name}`);
  return problems;
}

export class GuardRefusal extends Error {
  constructor(public readonly code: string) {
    super(`live-eval guard refused: ${code}`);
    this.name = "GuardRefusal";
  }
}

export interface LedgerEntry {
  attempt: number;
  caseId: string;
  at: string;
  httpStatus: number;
  stopReason: string | null;
  truncated: boolean;
  inputTokensCounted: number;
  countSource: "count_tokens" | "estimate_bytes_div_2";
  inputTokens: number;
  outputTokens: number;
  reservedUsd: number;
  actualUsd: number;
  spentUsd: number;
  latencyMs: number;
  errorType: string | null;
}

export interface RefusalEntry { caseId: string; at: string; code: string }

export interface GuardState {
  paidAttempts: number;
  countCalls: number;
  spentUsd: number;
  ledger: LedgerEntry[];
  refusals: RefusalEntry[];
  halted: boolean;
  haltReason: string | null;
  caseId: string;
}

export interface GuardOptions {
  /** The network fetch (the real one in the run, a fake in the guard's tests). */
  realFetch: typeof fetch;
  model?: string;
  maxAttempts?: number;
  maxUsd?: number;
  price?: Price;
  /** Multiplies every reservation and actual cost (10 when the price could not be confirmed). */
  safetyFactor?: number;
  /** Called after every attempt (the run appends it to the scratchpad ledger). */
  onEntry?: (e: LedgerEntry) => void;
  /** THE PERSISTENT CUMULATIVE BUDGET (cumulative.ts): every attempt is reserved there, on disk, before it is sent, and settled after. Absent: the per-run caps only (the offline tests). */
  cumulative?: CumulativeBudget;
  /** The highest max_tokens a request may ask (default MAX_OUTPUT_TOKENS; at most PLANNER_MAX_OUTPUT_TOKENS). */
  maxOutputTokens?: number;
  now?: () => number;
}

const urlOf = (input: unknown): URL => {
  if (typeof input === "string") return new URL(input);
  if (input instanceof URL) return new URL(input.href);
  if (input && typeof (input as { url?: unknown }).url === "string") return new URL((input as { url: string }).url);
  throw new GuardRefusal("unreadable_url");
};

const usd = (tokensIn: number, tokensOut: number, p: Price, factor: number) => ((tokensIn * p.inputPerM + tokensOut * p.outputPerM) / 1_000_000) * factor;

export function createSpendingGuard(options: GuardOptions) {
  const model = options.model ?? EVAL_MODEL;
  const maxAttempts = options.maxAttempts ?? MAX_PAID_ATTEMPTS;
  const maxUsd = options.maxUsd ?? MAX_USD;
  const price = options.price ?? HAIKU_55_PRICE;
  const factor = options.safetyFactor ?? 1;
  const maxOutput = Math.min(options.maxOutputTokens ?? MAX_OUTPUT_TOKENS, PLANNER_MAX_OUTPUT_TOKENS);
  const now = options.now ?? Date.now;
  const state: GuardState = { paidAttempts: 0, countCalls: 0, spentUsd: 0, ledger: [], refusals: [], halted: false, haltReason: null, caseId: "-" };

  const refuse = (code: string): never => {
    state.refusals.push({ caseId: state.caseId, at: new Date(now()).toISOString(), code });
    throw new GuardRefusal(code);
  };
  const halt = (reason: string) => { state.halted = true; state.haltReason = reason; };

  async function countInput(headers: HeadersInit | undefined, body: Record<string, unknown>, rawBody: string): Promise<{ tokens: number; source: LedgerEntry["countSource"] }> {
    // a bounded number of count calls (they are free, but never unbounded)
    if (state.countCalls < maxAttempts * 2) {
      state.countCalls += 1;
      try {
        const r = await options.realFetch(`https://${ANTHROPIC_HOST}${COUNT_PATH}`, {
          method: "POST", headers,
          body: JSON.stringify({ model: body.model, system: body.system, messages: body.messages, ...(body.thinking !== undefined ? { thinking: body.thinking } : {}), ...(body.tools !== undefined ? { tools: body.tools } : {}), ...(body.tool_choice !== undefined ? { tool_choice: body.tool_choice } : {}) }),
        });
        if (r.ok) {
          const j: any = await r.json();
          const n = Number(j?.input_tokens);
          if (Number.isFinite(n) && n > 0) return { tokens: n + COUNT_MARGIN_TOKENS, source: "count_tokens" };
        }
      } catch { /* the estimate below */ }
    }
    return { tokens: Math.ceil(Buffer.byteLength(rawBody, "utf8") / 2), source: "estimate_bytes_div_2" };
  }

  const guardedFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (state.halted) refuse(`halted:${state.haltReason}`);
    const url = urlOf(input);
    if (url.protocol !== "https:" || url.hostname !== ANTHROPIC_HOST) refuse(`blocked_host:${url.hostname}`);
    const method = String(init?.method ?? (typeof input === "object" && input && "method" in (input as Request) ? (input as Request).method : "GET")).toUpperCase();
    if (method !== "POST" || (url.pathname !== MESSAGES_PATH && url.pathname !== COUNT_PATH)) refuse(`blocked_path:${method} ${url.pathname}`);
    if (typeof init?.body !== "string") refuse("body_not_string");
    const rawBody = init!.body as string;
    let body: Record<string, unknown>;
    try { body = JSON.parse(rawBody); } catch { return refuse("body_not_json"); }
    if (body.model !== model) refuse(`model_not_allowed:${String(body.model).slice(0, 40)}`);
    if (url.pathname === COUNT_PATH) {
      // a caller's own count request: free, bounded like the guard's own
      if (state.countCalls >= maxAttempts * 2) refuse("count_cap");
      state.countCalls += 1;
      return options.realFetch(url.href, init);
    }
    const maxTokens = Number(body.max_tokens);
    if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > maxOutput) refuse("max_tokens_not_allowed");
    if (body.stream === true) refuse("stream_not_allowed");
    if (state.paidAttempts >= maxAttempts) refuse("attempt_cap");
    const counted = await countInput(init!.headers, body, rawBody);
    if (counted.tokens > PRICE_TIER_MAX_INPUT_TOKENS) refuse("input_above_price_tier");
    const reservedUsd = usd(counted.tokens, maxTokens, price, factor);
    if (state.spentUsd + reservedUsd > maxUsd) refuse("usd_cap");
    // the cumulative budget: reserved ON DISK before the request leaves (refused when every run together would pass the owner's ceiling)
    let reservation: string | null = null;
    if (options.cumulative) {
      try { reservation = options.cumulative.reserve(reservedUsd, state.caseId); } catch (e) { refuse(e instanceof GuardRefusal ? e.code : "cumulative_unavailable"); }
    }
    const settle = (usdActual: number) => {
      if (!options.cumulative || reservation === null) return;
      // a settlement that cannot be written leaves the whole reservation counted on disk; the run stops
      try { options.cumulative.settle(reservation, usdActual); } catch { halt("cumulative_settle_failed"); }
    };
    state.paidAttempts += 1;
    const attempt = state.paidAttempts;
    const t0 = now();
    let response: Response;
    try {
      response = await options.realFetch(url.href, init);
    } catch (e) {
      // a network failure after the request may have reached the API: its whole reservation is counted as spent, and the run stops
      state.spentUsd += reservedUsd;
      settle(reservedUsd);
      halt("network_error");
      const entry: LedgerEntry = { attempt, caseId: state.caseId, at: new Date(t0).toISOString(), httpStatus: 0, stopReason: null, truncated: false, inputTokensCounted: counted.tokens, countSource: counted.source, inputTokens: 0, outputTokens: 0, reservedUsd, actualUsd: reservedUsd, spentUsd: state.spentUsd, latencyMs: now() - t0, errorType: (e as Error)?.name === "AbortError" ? "abort" : "network" };
      state.ledger.push(entry);
      options.onEntry?.(entry);
      throw e;
    }
    const latencyMs = now() - t0;
    let data: any = null;
    try { data = await response.clone().json(); } catch { data = null; }
    const u = data?.usage ?? null;
    const cacheWrite = u ? Number(u.cache_creation_input_tokens) || 0 : 0;
    const inputTokens = u ? (Number(u.input_tokens) || 0) + cacheWrite + (Number(u.cache_read_input_tokens) || 0) : 0;
    const outputTokens = u ? Number(u.output_tokens) || 0 : 0;
    let actualUsd = 0;
    let errorType: string | null = null;
    if (response.status === 200) {
      if (!u || data?.type !== "message") { actualUsd = reservedUsd; halt("unexpected_response_shape"); }
      // a cache write is charged at twice the input price (the dearest cache-write rate), a cache read at the full input price: upper bounds (the evaluation sets no cache_control)
      else actualUsd = usd(inputTokens + cacheWrite, outputTokens, price, factor);
    } else if (response.status === 400) {
      // an invalid request is not billed by the API; it is still charged its input conservatively. The transport retries it once (a second, separately counted attempt)
      errorType = typeof data?.error?.type === "string" ? data.error.type : "http_400";
      actualUsd = usd(counted.tokens, 0, price, factor);
    } else {
      errorType = typeof data?.error?.type === "string" ? data.error.type : `http_${response.status}`;
      actualUsd = usd(counted.tokens, 0, price, factor);
      halt(`unexpected_status_${response.status}`);
    }
    state.spentUsd += actualUsd;
    settle(actualUsd);
    if (actualUsd > reservedUsd + 1e-12) halt("actual_exceeded_reservation");
    const entry: LedgerEntry = {
      attempt, caseId: state.caseId, at: new Date(t0).toISOString(), httpStatus: response.status, stopReason: typeof data?.stop_reason === "string" ? data.stop_reason : null,
      truncated: data?.stop_reason === "max_tokens", inputTokensCounted: counted.tokens, countSource: counted.source, inputTokens, outputTokens, reservedUsd, actualUsd, spentUsd: state.spentUsd, latencyMs, errorType,
    };
    state.ledger.push(entry);
    options.onEntry?.(entry);
    return response;
  };

  return {
    fetch: guardedFetch as typeof fetch,
    state,
    setCase(caseId: string) { state.caseId = caseId; },
  };
}
