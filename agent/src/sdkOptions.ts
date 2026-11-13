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

/**
 * ROUND 62: `gateEnv` is the model gate's child environment (agent/src/modelGate.ts: ANTHROPIC_BASE_URL, the gate's own token as ANTHROPIC_API_KEY and,
 * in enforce mode, CLAUDE_CODE_MAX_OUTPUT_TOKENS). With it the child NEVER gets the real key: every request it makes goes to the gate on 127.0.0.1.
 * Without it (the spend gate off) the options are exactly what they always were.
 */
export function buildQueryOptions(input: QueryOptionInput, env: Record<string, string | undefined>, gateEnv?: Readonly<Record<string, string>>) {
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
    env: (gateEnv ? gatedChildEnv(env, input.cwd, gateEnv) : { PATH: env.PATH ?? "/usr/bin:/bin", HOME: env.HOME ?? input.cwd, ...(env.ANTHROPIC_API_KEY ? { ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY } : {}) }) as Record<string, string>,
    canUseToolDecision: (toolName: string): boolean => allowed.includes(toolName),
  };
}

/** The keys a gated child may receive from the gate, and nothing else: never the real key, never another Anthropic credential or base URL. */
export const GATE_CHILD_ENV_KEYS = ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "CLAUDE_CODE_MAX_OUTPUT_TOKENS"] as const;

function gatedChildEnv(env: Record<string, string | undefined>, cwd: string, gateEnv: Readonly<Record<string, string>>): Record<string, string> {
  if (typeof gateEnv.ANTHROPIC_BASE_URL !== "string" || !/^http:\/\/127\.0\.0\.1:\d+$/.test(gateEnv.ANTHROPIC_BASE_URL)) throw new Error("spend gate: the model gate's base URL is not a loopback address");
  if (typeof gateEnv.ANTHROPIC_API_KEY !== "string" || !gateEnv.ANTHROPIC_API_KEY.startsWith("gate-")) throw new Error("spend gate: the child token is not a gate token");
  if (env.ANTHROPIC_API_KEY && gateEnv.ANTHROPIC_API_KEY === env.ANTHROPIC_API_KEY) throw new Error("spend gate: the child would get the real key");
  const out: Record<string, string> = { PATH: env.PATH ?? "/usr/bin:/bin", HOME: env.HOME ?? cwd };
  for (const k of GATE_CHILD_ENV_KEYS) if (typeof gateEnv[k] === "string") out[k] = gateEnv[k];
  return out;
}
