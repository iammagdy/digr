import { PLANNER_MODEL_PRICE } from "../../src/lib/modelPlanner/constants";
import { MODEL_HAIKU, MODEL_SONNET } from "../../src/lib/agentMission/constants";

/**
 * What the MODEL cost a mission, USD, so the owner can compare Haiku and Sonnet per mission. Anthropic's list prices per million tokens (cached 2026-10-06 in the claude-api skill):
 * Haiku 5.5 0.10 in / 0.50 out (the website's PLANNER_MODEL_PRICE), Sonnet 5.5 2.00 in / 10.00 out, cache read at 0.1x input, five-minute cache write at 1.25x input.
 * Haiku's price is for prompts up to 100K tokens (above that it is dearer): the SDK's own total, when it reports one, wins over this table.
 */
export interface TokenUsage { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
interface Price { inputPerMillion: number; outputPerMillion: number; cacheReadPerMillion: number; cacheWritePerMillion: number }

export const MODEL_PRICES: Record<string, Price> = {
  [MODEL_HAIKU]: { ...PLANNER_MODEL_PRICE },
  [MODEL_SONNET]: { inputPerMillion: 2, outputPerMillion: 10, cacheReadPerMillion: 0.2, cacheWritePerMillion: 2.5 },
};

export function llmCostFromUsage(model: string, usage: TokenUsage): number {
  const p = MODEL_PRICES[model];
  if (!p) return 0;
  const m = 1_000_000;
  return ((usage.input_tokens ?? 0) * p.inputPerMillion + (usage.output_tokens ?? 0) * p.outputPerMillion + (usage.cache_read_input_tokens ?? 0) * p.cacheReadPerMillion + (usage.cache_creation_input_tokens ?? 0) * p.cacheWritePerMillion) / m;
}

/** The SDK's estimated total when it gave a positive one, else our own figure from the token counts. */
export function chooseLlmCost(sdkTotalUsd: number | undefined, model: string, usage: TokenUsage): number {
  return typeof sdkTotalUsd === "number" && Number.isFinite(sdkTotalUsd) && sdkTotalUsd > 0 ? sdkTotalUsd : llmCostFromUsage(model, usage);
}
