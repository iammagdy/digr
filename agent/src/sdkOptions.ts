import type { ToolSpec } from "./tools";

/**
 * The options the SDK query gets, built in one SDK-free function so the tests can read exactly what the model is given: no built-in tool, only our MCP tools, an environment with the
 * Anthropic key and nothing else, no settings files.
 */
export const MCP_SERVER_NAME = "diger";
export const BUILT_IN_TOOLS = ["Bash", "BashOutput", "KillShell", "Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "Glob", "Grep", "WebFetch", "WebSearch", "Task", "Agent", "TodoWrite", "ExitPlanMode", "EnterPlanMode", "AskUserQuestion", "Skill", "SlashCommand"];

export function mcpToolNames(tools: ReadonlyArray<ToolSpec>): string[] {
  return tools.map((t) => `mcp__${MCP_SERVER_NAME}__${t.name}`);
}

export interface QueryOptionInput { model: string; systemPrompt: string; maxTurns: number; maxBudgetUsd: number; cwd: string; tools: ReadonlyArray<ToolSpec> }

export function buildQueryOptions(input: QueryOptionInput, env: Record<string, string | undefined>) {
  const allowed = mcpToolNames(input.tools);
  return {
    model: input.model,
    systemPrompt: input.systemPrompt,
    tools: [] as string[],
    allowedTools: allowed,
    disallowedTools: BUILT_IN_TOOLS,
    strictMcpConfig: true,
    settingSources: [] as never[],
    persistSession: false,
    maxTurns: input.maxTurns,
    maxBudgetUsd: input.maxBudgetUsd,
    cwd: input.cwd,
    // the SDK's own process: the Anthropic key, a PATH and a HOME, and NOTHING else (never the Supabase key or the TREG token: the tools that use them run in the worker process)
    env: { PATH: env.PATH ?? "/usr/bin:/bin", HOME: env.HOME ?? input.cwd, ...(env.ANTHROPIC_API_KEY ? { ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY } : {}) } as Record<string, string>,
    canUseToolDecision: (toolName: string): boolean => allowed.includes(toolName),
  };
}
