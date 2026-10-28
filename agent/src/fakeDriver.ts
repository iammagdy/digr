import type { ModelDriver, RunInput, RunOutput } from "./driver";

/**
 * A FAKE model: a scripted transcript of tool calls. Each step names a tool and its arguments (or a function that builds them from the results so far); the driver runs them in order
 * through the real tool handlers of the run and stops when the run reaches a terminal tool (propose_plan accepted, ask_question, finish) or the script ends. No model, no network.
 */
export type FakeStep = { tool: string; args: Record<string, unknown> | ((results: Array<{ tool: string; result: Record<string, unknown> }>) => Record<string, unknown>) };

export function createFakeDriver(script: FakeStep[], options: { costUsd?: number; stopAfterTerminal?: boolean } = {}): ModelDriver & { results: Array<{ tool: string; result: Record<string, unknown> }> } {
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
      return { llmCostUsd: options.costUsd ?? 0.01, turns, stop: "end" };
    },
  };
}
