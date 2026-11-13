import { resolveProviderKey } from "../server/providerKeys";

/**
 * THE CHAT MODEL'S TRANSPORT (round 22). The chat names the type of every message and writes the reply to a message that is not a data request with the chat model, through the Anthropic key the product already uses
 * (`resolveProviderKey`, the one place keys are read; the key is only ever put in a request header, never in a body, a log or a customer text). ONE request per message, a small token limit, thinking off (as every other short
 * call of the product), a timeout; a failure of any kind is returned as a value (`{ ok: false }`), never thrown, and the caller falls back to the round-21 keyword rules.
 * The model decides no money and starts nothing: what it returns is validated by `conversationModel.ts` and only code routes to planning.
 */
export const CHAT_MODEL_MAX_TOKENS = 400;
/**
 * CONSOLIDATED MISSION, COST CAP (docs/AGENT-UNDERSTANDING-V1.md): in research-brief mode (a server switch, off by default) the SAME one call per message also returns the brief, so its output may be longer. The hard ceiling of ANY chat call is this
 * number of output tokens; there is still exactly one call per customer message and never a second one.
 */
export const CHAT_MODEL_BRIEF_MAX_TOKENS = 700;
export const CHAT_MODEL_TIMEOUT_MS = 12_000;
const DEFAULT_MODEL = "claude-haiku-5-5";

export interface ChatModelInput {
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  maxTokens: number;
  timeoutMs: number;
}
export type ChatModelResult =
  | { ok: true; text: string; usage?: { inputTokens: number; outputTokens: number }; /** The answer stopped at the output ceiling (`stop_reason: "max_tokens"`): its JSON may be cut. */ truncated?: boolean }
  | { ok: false; failure: string };
export type ChatModelCall = (input: ChatModelInput) => Promise<ChatModelResult>;

/** ROUND 57: the statuses that mean «try again in a moment» (overloaded, unavailable, gateway); a refusal (4xx) is never retried. */
export const TRANSIENT_STATUSES: ReadonlySet<number> = new Set([500, 502, 503, 504, 529]);
export const TRANSIENT_RETRY_DELAY_MS = 700;

export interface ChatModelDeps {
  /** Test-only: the pause before the one transient retry. */
  retryDelayMs?: number;
  fetchImpl?: typeof fetch;
  resolveKey?: () => Promise<string>;
  model?: string;
}

/** The request, with its dependencies named so a test can fake the network and the key (nothing in the product passes them). */
export async function callClaudeChatWith(input: ChatModelInput, deps: ChatModelDeps = {}): Promise<ChatModelResult> {
  const fail = (failure: string): ChatModelResult => ({ ok: false, failure });
  const env = (name: string) => (process.env[name] || "").trim().toLowerCase();
  if (env("LLM_PROVIDER") === "fake" || env("LLM_ENABLED") === "false" || env("LLM_LIVE") === "false") return fail("disabled");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Math.min(CHAT_MODEL_TIMEOUT_MS, Number(input.timeoutMs) || CHAT_MODEL_TIMEOUT_MS)));
  try {
    const key = await (deps.resolveKey ?? (async () => (await resolveProviderKey("anthropic")).key))();
    if (!key) return fail("no_key");
    const model = (deps.model ?? (process.env.ANTHROPIC_MODEL || process.env.LLM_MODEL || DEFAULT_MODEL)).trim();
    const send = (withThinkingOff: boolean) => (deps.fetchImpl ?? fetch)("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      signal: controller.signal,
      body: JSON.stringify({ model, max_tokens: Math.min(CHAT_MODEL_BRIEF_MAX_TOKENS, Math.max(1, Math.floor(input.maxTokens))), ...(withThinkingOff ? { thinking: { type: "disabled" } } : {}), system: input.system, messages: input.messages }),
    });
    let response = await send(true);
    // the API refused the request while it carried the thinking parameter: the SAME request once more without it (as the product's other short calls do)
    if (!response.ok && response.status === 400) response = await send(false);
    // ROUND 57: ONE more attempt after a short pause when the API was momentarily unavailable (13 Nov: 5 of 9 turns of a customer's conversation ended «http_503» and were answered by the keyword rules). The same timer bounds both
    // attempts, so the turn never waits longer than before.
    if (!response.ok && TRANSIENT_STATUSES.has(response.status) && !controller.signal.aborted) {
      await new Promise((r) => setTimeout(r, Math.max(0, deps.retryDelayMs ?? TRANSIENT_RETRY_DELAY_MS)));
      if (!controller.signal.aborted) response = await send(true);
    }
    if (!response.ok) return fail(`http_${response.status}`);
    const data: any = await response.json();
    const text = Array.isArray(data?.content) ? data.content.map((part: any) => (typeof part?.text === "string" ? part.text : "")).join("") : "";
    if (text.trim() === "") return fail("empty");
    return { ok: true, text, usage: { inputTokens: Number(data?.usage?.input_tokens) || 0, outputTokens: Number(data?.usage?.output_tokens) || 0 }, ...(data?.stop_reason === "max_tokens" ? { truncated: true } : {}) };
  } catch (err: any) {
    return fail(err?.name === "AbortError" || controller.signal.aborted ? "timeout" : "network");
  } finally {
    clearTimeout(timer);
  }
}

/** The production call. Under a test runner it refuses unless a test put a fake in its place: a test can never make a paid call. */
export const callClaudeChat: ChatModelCall = async (input) => {
  if (process.env.VITEST) return { ok: false, failure: "disabled_in_tests" };
  return callClaudeChatWith(input);
};

let injected: ChatModelCall | null = null;
/** Test-only: replace the model call (null restores the production one). */
export function setChatModelForTesting(model: ChatModelCall | null): void {
  injected = model;
}
export const getChatModel = (): ChatModelCall => injected ?? callClaudeChat;
