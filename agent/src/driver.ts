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
}

export interface RunOutput {
  /** What the model cost this run (USD). */
  llmCostUsd: number;
  turns: number;
  /** "end" when the model stopped, or the reason it was stopped (budget, turns, time, error). */
  stop: string;
  error?: string;
}

export interface ModelDriver {
  run(input: RunInput): Promise<RunOutput>;
}
