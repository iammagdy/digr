import type { ModelDriver, RunInput, RunOutput } from "./driver";

/**
 * A FAKE model: a scripted transcript of tool calls. Each step names a tool and its arguments (or a function that builds them from the results so far); the driver runs them in order
 * through the real tool handlers of the run and stops when the run reaches a terminal tool (propose_plan accepted, ask_question, finish) or the script ends. No model, no network.
 */
export type FakeStep = { tool: string; args: Record<string, unknown> | ((results: Array<{ tool: string; result: Record<string, unknown> }>) => Record<string, unknown>) };

export function createFakeDriver(script: FakeStep[], options: { costUsd?: number; stopAfterTerminal?: boolean; usage?: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } } = {}): ModelDriver & { results: Array<{ tool: string; result: Record<string, unknown> }> } {
  const results: Array<{ tool: string; result: Record<string, unknown> }> = [];
  return {
    results,
    async run(input: RunInput): Promise<RunOutput> {
      let turns = 0;
      for (const step of script) {
        const tool = input.tools.find((t) => t.name === step.tool);
        turns += 1;
        if (!tool) { results.push({ tool: step.tool, result: { ok: false, error: `no such tool in this phase: ${step.tool}` } }); continue; }
        const args = typeof step.args === "function" ? step.args(results) : step.args;
        const result = await tool.handler(args);
        results.push({ tool: step.tool, result });
        if (input.state.terminal && options.stopAfterTerminal !== false) break;
      }
      const usage = options.usage ?? { input_tokens: 1200 * turns, output_tokens: 150 * turns, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
      await input.onUsage?.({ usage, costUsd: options.costUsd ?? 0.01 });
      return { llmCostUsd: options.costUsd ?? 0.01, turns, usage, stop: "end" };
    },
  };
}
