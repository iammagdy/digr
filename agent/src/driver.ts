import type { TokenUsage } from "./llmCost";
import type { RunState, ToolSpec } from "./tools";
import type { CallPhase } from "./types";

/**
 * The model side of a run, behind one small interface. The real one (sdkRuntime.ts) runs the Claude Agent SDK with the tools above in an in-process MCP server; the tests use a fake
 * driver that replays a scripted transcript of tool calls through THE SAME handlers (fakeDriver.ts). Nothing else in the worker knows which one it is talking to.
 */
export interface RunInput {
  phase: CallPhase;
  systemPrompt: string;
  userPrompt: string;
  tools: ToolSpec[];
  state: RunState;
  model: string;
  maxTurns: number;
  /** What the MODEL may cost this run (USD). */
  maxBudgetUsd: number;
  wallMs: number;
  /** Called after every model message with the run's cumulative tokens and cost so far: the worker saves them, so the cost of a run that is killed is still on the mission. Must not throw. */
  onUsage?: (progress: { usage: TokenUsage; costUsd: number }) => Promise<void> | void;
}

export interface RunOutput {
  /** What the model cost this run (USD). */
  llmCostUsd: number;
  turns: number;
  /** The tokens the run used (input, output, cache read, cache write), from the API's own usage fields. */
  usage?: TokenUsage;
  /** "end" when the model stopped, or the reason it was stopped (budget, turns, time, error). */
  stop: string;
  error?: string;
}

export interface ModelDriver {
  run(input: RunInput): Promise<RunOutput>;
}
