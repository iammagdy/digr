import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { ModelDriver, RunInput, RunOutput } from "./driver";
import { chooseLlmCost, llmCostFromUsage, type TokenUsage } from "./llmCost";
import { buildQueryOptions, MCP_SERVER_NAME } from "./sdkOptions";
import type { ParamSpec, ToolSpec } from "./tools";
import { acquireSession, clipToolResult, releaseSession, trackRun, untrackRun } from "./sessions";

/**
 * THE REAL MODEL DRIVER: the Claude Agent SDK (@anthropic-ai/claude-agent-sdk) running a Claude agent whose ONLY tools are the ones in tools.ts, served by an in-process MCP server.
 *
 *  - `tools: []` removes every built-in tool of the SDK (shell, file read/write/edit, web fetch, web search, sub-agents...), `disallowedTools` names them again, and `canUseTool` refuses
 *    anything that is not one of our MCP tools: three layers, so no one of them is the only thing standing between the model and a shell;
 *  - the SDK's child process gets an environment of its own (the Anthropic key, PATH, HOME) and NOTHING else: it never sees the Supabase service-role key or the TREG token (the
 *    MCP tools run in THIS process, which holds them);
 *  - settingSources is empty (no CLAUDE.md, no settings files) and the working directory is an empty temp folder;
 *  - maxTurns, maxBudgetUsd (what the model may cost) and a wall-clock abort bound every run.
 * This file is the only one that imports the SDK; the tests never load it (they use fakeDriver.ts through the same tool handlers).
 */
function zodOf(spec: ParamSpec): z.ZodTypeAny {
  const base: z.ZodTypeAny =
    spec.type === "string" ? z.string()
    : spec.type === "number" ? z.number()
    : spec.type === "boolean" ? z.boolean()
    : spec.type === "string[]" ? z.array(z.string())
    : spec.type === "array" ? z.array(z.any())
    : z.record(z.string(), z.any());
  const described = base.describe(spec.description);
  return spec.optional ? described.optional() : described;
}

function toSdkTool(spec: ToolSpec, input: RunInput) {
  const shape = Object.fromEntries(Object.entries(spec.params).map(([k, p]) => [k, zodOf(p)]));
  return tool(spec.name, spec.description, shape, async (args: Record<string, unknown>) => {
    // once the run has reached its end (a plan, a question, finish) nothing else is executed
    const result = input.state.terminal && spec.name !== "report_progress" ? { ok: false, error: "the run is over; stop now and write nothing more" } : await spec.handler(args);
    const text = JSON.stringify(result);
    return { content: [{ type: "text" as const, text: clipToolResult(text) }], isError: (result as { ok?: boolean }).ok === false };
  });
}

export function createSdkDriver(env: Record<string, string | undefined> = process.env): ModelDriver {
  return {
    async run(input: RunInput): Promise<RunOutput> {
      await acquireSession();
      const server = createSdkMcpServer({ name: MCP_SERVER_NAME, version: "1.0.0", tools: input.tools.map((t) => toSdkTool(t, input)) });
      const run = trackRun();
      const abort = run.abort;
      const timer = setTimeout(() => abort.abort(), input.wallMs);
      const cwd = mkdtempSync(path.join(tmpdir(), "diger-agent-"));
      let q: ReturnType<typeof query> | null = null;
      const usage: TokenUsage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
      let turns = 0;
      let sdkTotal: number | undefined;
      let stop = "end";
      let error: string | undefined;
      try {
        const o = buildQueryOptions({ model: input.model, systemPrompt: input.systemPrompt, maxTurns: input.maxTurns, maxBudgetUsd: input.maxBudgetUsd, cwd, tools: input.tools }, env);
        q = query({
          prompt: input.userPrompt,
          options: {
            model: o.model, systemPrompt: o.systemPrompt, tools: o.tools, allowedTools: o.allowedTools, disallowedTools: o.disallowedTools,
            mcpServers: { [MCP_SERVER_NAME]: server }, strictMcpConfig: o.strictMcpConfig, settingSources: o.settingSources, persistSession: o.persistSession,
            maxTurns: o.maxTurns, maxBudgetUsd: o.maxBudgetUsd, cwd: o.cwd, abortController: abort, env: o.env,
            canUseTool: async (toolName, toolInput) => (o.canUseToolDecision(toolName) ? { behavior: "allow", updatedInput: toolInput } : { behavior: "deny", message: "this tool is not available" }),
          },
        });
        for await (const message of q) {
          if (message.type === "assistant") {
            turns += 1;
            const u = (message as { message?: { usage?: TokenUsage } }).message?.usage;
            if (u) {
              try { await input.onTurn?.({ turn: turns, usage: { input_tokens: u.input_tokens ?? 0, output_tokens: u.output_tokens ?? 0, cache_read_input_tokens: u.cache_read_input_tokens ?? 0, cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0 } }); } catch { /* telemetry never stops a run */ }
              usage.input_tokens! += u.input_tokens ?? 0; usage.output_tokens! += u.output_tokens ?? 0; usage.cache_read_input_tokens! += u.cache_read_input_tokens ?? 0; usage.cache_creation_input_tokens! += u.cache_creation_input_tokens ?? 0;
              // checkpoint: the tokens and the cost so far, so a run that is killed still leaves its cost on the mission (our own figure from the API's token counts: the SDK's total only arrives with its final result)
              try { await input.onUsage?.({ usage: { ...usage }, costUsd: llmCostFromUsage(input.model, usage) }); } catch { /* a lost checkpoint never stops the run */ }
            }
          } else if (message.type === "result") {
            sdkTotal = message.total_cost_usd;
            // the result's own per-model usage is the token account the SDK itself prices (list prices, an estimate not a bill); it replaces our running sum of assistant messages
            const mu = (message as { modelUsage?: Record<string, { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number }> }).modelUsage;
            if (mu && typeof mu === "object") {
              const sum = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
              for (const m of Object.values(mu)) { sum.input_tokens += m?.inputTokens ?? 0; sum.output_tokens += m?.outputTokens ?? 0; sum.cache_read_input_tokens += m?.cacheReadInputTokens ?? 0; sum.cache_creation_input_tokens += m?.cacheCreationInputTokens ?? 0; }
              if (sum.input_tokens + sum.output_tokens + sum.cache_read_input_tokens + sum.cache_creation_input_tokens > 0) Object.assign(usage, sum);
            }
            stop = message.subtype === "success" ? "end" : String(message.subtype);
            if (message.is_error) error = `the model run ended with ${String(message.subtype)}`;
          }
        }
        if (abort.signal.aborted && run.reason.value) stop = run.reason.value;
      } catch (e) {
        stop = abort.signal.aborted ? (run.reason.value ?? "time") : "error";
        error = String((e as Error)?.message ?? e).slice(0, 300);
      } finally {
        clearTimeout(timer);
        untrackRun(run);
        // release the session: its native process, its in-process tool server and its working folder go before the next one starts
        try { q?.close(); } catch { /* already closed */ }
        q = null;
        try { rmSync(cwd, { recursive: true, force: true }); } catch { /* a temp folder */ }
        releaseSession();
      }
      return { llmCostUsd: chooseLlmCost(sdkTotal, input.model, usage), turns, usage: { ...usage }, stop, ...(error ? { error } : {}) };
    },
  };
}
