import { resolveProviderKey, reportProviderHttpStatus } from "../server/providerKeys";
import { PLANNER_MAX_TOKENS, PLANNER_MODEL_DEFAULT, PLANNER_MODEL_PRICE, PLANNER_TIMEOUT_MS } from "./constants";

/** Messages and content blocks in the shape of the provider's tool-use protocol: the model asks for a tool, the app answers with a tool_result. */
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

export interface PlannerMessage { role: "user" | "assistant"; content: string | ContentBlock[] }

export interface PlannerUsage { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
export interface PlannerResponse { content: ContentBlock[]; stopReason: string; usage: PlannerUsage; model: string }

export interface PlannerRequest {
  /** The longest this call may take (ms); the transport cuts it at PLANNER_TIMEOUT_MS or this, whichever is shorter. */
  timeoutMs?: number;
  system: string;
  messages: PlannerMessage[];
  tools: Array<Record<string, unknown>>;
}

export interface PlannerTransport {
  readonly model: string;
  send(request: PlannerRequest): Promise<PlannerResponse>;
}

export const emptyUsage = (): PlannerUsage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
export function addUsage(a: PlannerUsage, b: PlannerUsage): PlannerUsage {
  return { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens, cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens, cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens };
}

/** USD of planner usage at the planner's own price (see PLANNER_MODEL_PRICE). `inputTokens` is the UNCACHED input; cache reads and writes are priced apart. */
export function plannerCostUsd(u: PlannerUsage): number {
  const p = PLANNER_MODEL_PRICE;
  return (u.inputTokens * p.inputPerMillion + u.outputTokens * p.outputPerMillion + u.cacheReadTokens * p.cacheReadPerMillion + u.cacheWriteTokens * p.cacheWritePerMillion) / 1_000_000;
}

/** The real transport: the provider's messages endpoint with `tool_choice: auto` (the model decides when to call a tool and when to answer). */
export function createAnthropicTransport(options: { model?: string; fetchFn?: typeof fetch } = {}): PlannerTransport {
  const model = (options.model || process.env.ANTHROPIC_MODEL || process.env.LLM_MODEL || PLANNER_MODEL_DEFAULT).trim();
  const doFetch = options.fetchFn ?? fetch;
  return {
    model,
    async send(request) {
      const key = await resolveProviderKey("anthropic");
      if (!key.key) throw new Error("planner_key_missing");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(1_000, Math.min(PLANNER_TIMEOUT_MS, request.timeoutMs ?? PLANNER_TIMEOUT_MS)));
      try {
        const tools = request.tools.map((t, i, all) => (i === all.length - 1 ? { ...t, cache_control: { type: "ephemeral" } } : t));
        const response = await doFetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-api-key": key.key, "anthropic-version": "2023-06-01" },
          signal: controller.signal,
          body: JSON.stringify({
            model, max_tokens: PLANNER_MAX_TOKENS,
            system: [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }],
            tools, tool_choice: { type: "auto" }, messages: request.messages,
          }),
        });
        reportProviderHttpStatus("anthropic", response.status, key.source);
        if (!response.ok) { const err: any = new Error(`planner_http_${response.status}`); err.status = response.status; throw err; }
        const data: any = await response.json();
        const u = data?.usage ?? {};
        return {
          content: Array.isArray(data?.content) ? data.content : [],
          stopReason: String(data?.stop_reason ?? ""),
          model,
          usage: { inputTokens: Number(u.input_tokens) || 0, outputTokens: Number(u.output_tokens) || 0, cacheReadTokens: Number(u.cache_read_input_tokens) || 0, cacheWriteTokens: Number(u.cache_creation_input_tokens) || 0 },
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * A RECORDED transport for tests and replays: it answers each request with the next scripted response (or with a function of the request). It never reaches the network, and it
 * reports usage from the size of what it was sent and what it answered (4 characters per token: an ESTIMATE, labelled as one wherever it is reported).
 */
export function createScriptedTransport(script: Array<PlannerResponse["content"] | ((request: PlannerRequest) => PlannerResponse["content"])>, options: { model?: string } = {}): PlannerTransport & { requests: PlannerRequest[] } {
  const requests: PlannerRequest[] = [];
  let i = 0;
  return {
    model: options.model ?? "recorded",
    requests,
    async send(request) {
      requests.push(JSON.parse(JSON.stringify(request)));
      const step = script[Math.min(i, script.length - 1)];
      i += 1;
      const content = typeof step === "function" ? step(request) : step;
      const hasToolUse = content.some((b) => b.type === "tool_use");
      const inputChars = request.system.length + JSON.stringify(request.tools).length + JSON.stringify(request.messages).length;
      return { content, stopReason: hasToolUse ? "tool_use" : "end_turn", model: options.model ?? "recorded", usage: { inputTokens: Math.ceil(inputChars / 4), outputTokens: Math.ceil(JSON.stringify(content).length / 4), cacheReadTokens: 0, cacheWriteTokens: 0 } };
    },
  };
}
