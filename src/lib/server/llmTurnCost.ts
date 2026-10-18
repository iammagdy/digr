import { DEFAULT_LLM_PRICING } from "../../functions/shared/llmClient";
import { estimateTokens } from "../../functions/shared/chatHandler";
import { buildSystemPromptParts } from "../../functions/shared/systemPrompt";
import { APPROVED_CAPABILITY_CATALOG, sanitizeCapabilitiesForLlm } from "../../functions/shared/capabilityRegistry";

/** Target set by the owner: the average model turn should cost no more than this (USD). */
export const TARGET_TURN_COST_USD = 0.005;

/** Anthropic prompt caching: reads cost 0.1x of normal input, writes 1.25x (same weights the live client applies). */
const CACHE_READ_WEIGHT = 0.1;
const CACHE_WRITE_WEIGHT = 1.25;

export interface TurnCostInput {
  staticTokens: number;
  dynamicTokens: number;
  historyTokens: number;
  outputTokens: number;
  /** true: the fixed rules come from the prompt cache; false: first turn, they are written to the cache */
  cacheHit: boolean;
  model?: string;
}

export function estimateTurnCostUsd(input: TurnCostInput): number {
  const pricing = DEFAULT_LLM_PRICING[input.model || "claude-haiku-5-5"];
  const weightedInput = input.cacheHit
    ? input.staticTokens * CACHE_READ_WEIGHT + input.dynamicTokens + input.historyTokens
    : input.staticTokens * CACHE_WRITE_WEIGHT + input.dynamicTokens + input.historyTokens;
  return (weightedInput * pricing.inputCostPerMillion + input.outputTokens * pricing.outputCostPerMillion) / 1_000_000;
}

export interface PromptMeasurement {
  staticTokens: number;
  dynamicTokens: number;
  capabilityCount: number;
  /** chars/4, the heuristic the chat handler uses */
  perTurn: Array<{ scenario: string; usd: number }>;
  /** chars/2.5: Arabic text uses more tokens per character, so this is the cautious reading */
  perTurnConservative: Array<{ scenario: string; usd: number }>;
  targetUsd: number;
  /** "met" when the typical cached turn is at or below the target even on the cautious reading */
  status: "met" | "above_target";
}

/**
 * Offline measurement from the real prompt text (no model call, no spend): token counts use the same chars/4
 * heuristic as the chat handler, and the full capability list stays in the prompt.
 */
export function measurePromptCost(): PromptMeasurement {
  const capabilities = sanitizeCapabilitiesForLlm(APPROVED_CAPABILITY_CATALOG);
  const parts = buildSystemPromptParts({ sanitizedCapabilities: capabilities, userBalancePoints: 500 });
  const build = (charsPerToken: number) => {
    const tokens = (text: string) => Math.ceil(text.length / charsPerToken);
    const staticTokens = tokens(parts.staticText);
    const dynamicTokens = tokens(parts.dynamicText);
    const scenario = (name: string, historyTokens: number, outputTokens: number, cacheHit: boolean) => ({
      scenario: name,
      usd: estimateTurnCostUsd({ staticTokens, dynamicTokens, historyTokens, outputTokens, cacheHit }),
    });
    return {
      staticTokens,
      dynamicTokens,
      perTurn: [
        scenario("first turn, cache write, short reply", 200, 150, false),
        scenario("typical turn, cache hit, short reply", 600, 150, true),
        scenario("typical turn, cache hit, plan reply", 1500, 450, true),
        scenario("long conversation, cache hit, plan reply", 6000, 450, true),
      ],
    };
  };
  const base = build(4);
  const cautious = build(2.5);
  return {
    staticTokens: base.staticTokens,
    dynamicTokens: base.dynamicTokens,
    capabilityCount: capabilities.length,
    perTurn: base.perTurn,
    perTurnConservative: cautious.perTurn,
    targetUsd: TARGET_TURN_COST_USD,
    status: cautious.perTurn[1].usd <= TARGET_TURN_COST_USD ? "met" : "above_target",
  };
}
