import { MODEL_HAIKU, MODEL_SONNET } from "../../agentMission/constants";
import { MAX_SINGLE_OPERATION_USD, ceilMicroUsd } from "./bounds";

/**
 * ROUND 61, HARD SPEND GATE: the most ONE model request may cost, computed from the request body BEFORE it is sent (SPEC-v2 §3.2).
 *
 * Output: the API stops a response at `max_tokens` (thinking included): an enforced per-response ceiling. The gate also lowers `max_tokens` to its own cap
 * (the Agent SDK asks for 128,000 on every request, measured on 0.3.312 against a local fake upstream), so the bound is small enough to reserve.
 * Input: every token of a byte-level tokenizer covers at least one byte, so the tokens of the request are at most its bytes plus a fixed template allowance.
 * This is an ASSUMPTION about the tokenizer, not a documented guarantee; the gate checks it on every answer (`usage` against the bound) and a single
 * violation trips the grant (SPEC-v2 §4). Content whose tokens are NOT bounded by its bytes is refused: images, documents, files, URLs.
 * Anything in the request that can add a charge the bytes do not show is refused: server tools (billed per use), fast mode, fallbacks to another
 * model, server-kept threads, compaction, containers, MCP servers, a service tier, an inference region.
 */

export interface ModelBoundPrice {
  inputPerMillion: number;
  outputPerMillion: number;
  /** Above this many input tokens the whole request is billed at the long-context prices (null: no long-context price). */
  longContextAbove: number | null;
  longInputPerMillion?: number;
  longOutputPerMillion?: number;
}

/** Anthropic list prices (claude-api skill, cached 2026-11-03): Haiku 5.5 0.10 / 0.50 up to 100K input tokens, 0.50 / 2.50 beyond; Sonnet 5.5 2 / 10. */
export const MODEL_BOUND_PRICES: Record<string, ModelBoundPrice> = {
  [MODEL_HAIKU]: { inputPerMillion: 0.1, outputPerMillion: 0.5, longContextAbove: 100_000, longInputPerMillion: 0.5, longOutputPerMillion: 2.5 },
  [MODEL_SONNET]: { inputPerMillion: 2, outputPerMillion: 10, longContextAbove: null },
};
/** A five-minute cache write is billed at 1.25 x input, a one-hour write at 2 x: the bound prices every input token at the dearest rate the request allows. */
export const CACHE_WRITE_5M_MULTIPLIER = 1.25;
export const CACHE_WRITE_1H_MULTIPLIER = 2;
/** Tokens the API adds around the body (role markers, the tool-use preamble): a fixed allowance on top of the bytes. */
export const TEMPLATE_TOKEN_ALLOWANCE = 4096;
/** The gate's own output cap per request (owner-tunable in the grant). */
export const DEFAULT_GATE_MAX_OUTPUT_TOKENS = 32_000;

const ALLOWED_TOP_LEVEL = new Set(["model", "messages", "system", "tools", "tool_choice", "metadata", "max_tokens", "thinking", "context_management", "output_config", "stream", "stop_sequences", "temperature", "top_p", "top_k", "cache_control"]);
const ALLOWED_BLOCKS = new Set(["text", "tool_use", "tool_result", "thinking", "redacted_thinking"]);
const ALLOWED_OUTPUT_CONFIG = new Set(["effort", "task_budget", "format"]);

export type ModelBound =
  | { ok: true; usd: number; model: string; maxTokens: number; inputTokenBound: number; longContext: boolean; body: Record<string, unknown> }
  | { ok: false; reason: "no_safe_bound"; detail: string };

const refuse = (detail: string): ModelBound => ({ ok: false, reason: "no_safe_bound", detail });

function contentProblem(content: unknown, where: string): string | null {
  if (typeof content === "string") return null;
  if (!Array.isArray(content)) return content === undefined ? null : `${where}: content is not text or a list of blocks`;
  for (const block of content) {
    const type = (block as { type?: unknown })?.type;
    if (typeof type !== "string" || !ALLOWED_BLOCKS.has(type)) return `${where}: a ${String(type)} block (its tokens are not bounded by its bytes)`;
    if (type === "tool_result") {
      const inner = contentProblem((block as { content?: unknown }).content, `${where} tool_result`);
      if (inner) return inner;
    }
  }
  return null;
}

function usesOneHourCache(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(usesOneHourCache);
  const v = value as Record<string, unknown>;
  const cc = v.cache_control as { ttl?: unknown } | undefined;
  if (cc && typeof cc === "object" && cc.ttl === "1h") return true;
  return Object.values(v).some((x) => typeof x === "object" && x !== null && usesOneHourCache(x));
}

/**
 * The bound of one /v1/messages request. `bodyBytes` is the UTF-8 length of the body as received; the returned `body` is the one to send (max_tokens lowered to the cap).
 */
export function modelRequestBound(raw: unknown, bodyBytes: number, opts: { maxOutputTokens?: number; prices?: Record<string, ModelBoundPrice> } = {}): ModelBound {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return refuse("the request body is not a JSON object");
  const body = raw as Record<string, unknown>;
  for (const key of Object.keys(body)) if (!ALLOWED_TOP_LEVEL.has(key)) return refuse(`the field «${key}» may add a charge the gate cannot bound`);
  const prices = opts.prices ?? MODEL_BOUND_PRICES;
  const model = typeof body.model === "string" ? body.model : "";
  const price = Object.prototype.hasOwnProperty.call(prices, model) ? prices[model] : undefined;
  if (!price) return refuse(`no price for the model «${model}»`);
  if (!Array.isArray(body.messages)) return refuse("no messages");
  for (const [i, m] of (body.messages as unknown[]).entries()) {
    const p = contentProblem((m as { content?: unknown })?.content, `messages[${i}]`);
    if (p) return refuse(p);
  }
  const sysProblem = contentProblem(body.system, "system");
  if (sysProblem) return refuse(sysProblem);
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) return refuse("tools is not a list");
    for (const t of body.tools as Array<Record<string, unknown>>) {
      const type = t?.type;
      if (type !== undefined && type !== "custom") return refuse(`the server tool «${String(type)}» is billed per use`);
    }
  }
  if (body.context_management !== undefined) {
    const edits = (body.context_management as { edits?: unknown })?.edits;
    if (!Array.isArray(edits) || Object.keys(body.context_management as object).some((k) => k !== "edits")) return refuse("context_management other than clearing edits");
    for (const e of edits) if (!String((e as { type?: unknown })?.type ?? "").startsWith("clear_")) return refuse(`the context edit «${String((e as { type?: unknown })?.type)}» may run extra sampling`);
  }
  if (body.output_config !== undefined) {
    if (!body.output_config || typeof body.output_config !== "object") return refuse("output_config is not an object");
    for (const k of Object.keys(body.output_config as object)) if (!ALLOWED_OUTPUT_CONFIG.has(k)) return refuse(`output_config.${k} is not bounded`);
  }
  const asked = Number(body.max_tokens);
  if (!Number.isInteger(asked) || asked < 1) return refuse("max_tokens is missing: the output has no ceiling");
  const cap = Math.max(1, Math.floor(opts.maxOutputTokens ?? DEFAULT_GATE_MAX_OUTPUT_TOKENS));
  const maxTokens = Math.min(asked, cap);
  const bytes = Math.max(0, Math.floor(bodyBytes));
  const inputTokenBound = bytes + TEMPLATE_TOKEN_ALLOWANCE;
  const longContext = price.longContextAbove !== null && inputTokenBound > price.longContextAbove;
  if (longContext && (price.longInputPerMillion === undefined || price.longOutputPerMillion === undefined)) return refuse(`no long-context price for «${model}»`);
  const inRate = (longContext ? price.longInputPerMillion! : price.inputPerMillion) * (usesOneHourCache(body) ? CACHE_WRITE_1H_MULTIPLIER : CACHE_WRITE_5M_MULTIPLIER);
  const outRate = longContext ? price.longOutputPerMillion! : price.outputPerMillion;
  const usd = (inputTokenBound * inRate + maxTokens * outRate) / 1_000_000;
  if (!(usd > 0 && usd <= MAX_SINGLE_OPERATION_USD)) return refuse(`a request bound of ${usd.toFixed(6)} USD is outside (0, ${MAX_SINGLE_OPERATION_USD}]`);
  return { ok: true, usd: ceilMicroUsd(usd), model, maxTokens, inputTokenBound, longContext, body: { ...body, max_tokens: maxTokens } };
}

export interface ModelUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
}

/** What a finished request cost by its reported usage, and whether the usage broke the bound's assumptions (input above the byte bound, output above max_tokens). */
export function modelUsageCost(model: string, usage: ModelUsage, bound: { inputTokenBound: number; maxTokens: number }, prices: Record<string, ModelBoundPrice> = MODEL_BOUND_PRICES): { usd: number; boundViolated: boolean } {
  const p = prices[model];
  const n = (v: unknown) => Math.max(0, Number(v) || 0);
  const read = n(usage.cache_read_input_tokens);
  const created = n(usage.cache_creation_input_tokens);
  const oneHour = Math.min(created, n(usage.cache_creation?.ephemeral_1h_input_tokens));
  const plain = n(usage.input_tokens);
  const out = n(usage.output_tokens);
  const totalIn = plain + read + created;
  if (!p) return { usd: Number.POSITIVE_INFINITY, boundViolated: true };
  const long = p.longContextAbove !== null && totalIn > p.longContextAbove;
  const inRate = long ? p.longInputPerMillion ?? p.inputPerMillion : p.inputPerMillion;
  const outRate = long ? p.longOutputPerMillion ?? p.outputPerMillion : p.outputPerMillion;
  const usd = (plain * inRate + read * inRate * 0.1 + (created - oneHour) * inRate * CACHE_WRITE_5M_MULTIPLIER + oneHour * inRate * CACHE_WRITE_1H_MULTIPLIER + out * outRate) / 1_000_000;
  return { usd: Number(usd.toFixed(9)), boundViolated: totalIn > bound.inputTokenBound || out > bound.maxTokens };
}
