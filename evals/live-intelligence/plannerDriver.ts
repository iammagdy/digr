import type { ModelDriver, RunInput, RunOutput } from "../../agent/src/driver";
import type { ParamSpec, ToolSpec } from "../../agent/src/tools";
import { clipToolResult } from "../../agent/src/sessions";
import { llmCostFromUsage, type TokenUsage } from "../../agent/src/llmCost";

/**
 * THE REAL PLANNING MODEL, ISOLATED (docs/LIVE-INTELLIGENCE-EVAL.md, the LLM quality mission). The worker's own `runPlanning` builds the prompt, the tools and their handlers exactly as in production; only the TRANSPORT differs:
 * production runs the Claude Agent SDK in a child process (which this evaluation's in-process spending guard could not see), so this driver speaks the Messages API tool-use loop itself, through the guarded fetch. Every tool call the
 * model makes runs the SAME handler the SDK's in-process MCP server would run (propose_plan validated by the production plan checks, sample calls through the production gateways, whose provider transport is synthetic here).
 *
 * Differences from production, stated: no Agent SDK (its tool names carry an `mcp__diger__` prefix; here the plain names), thinking off, `max_tokens` per turn capped by the guard. The model's text and tool calls are recorded for the report.
 * The API key is read by the caller's `key()` and only placed in a request header.
 */
const API = "https://api.anthropic.com/v1/messages";

function schemaOf(p: ParamSpec): Record<string, unknown> {
  switch (p.type) {
    case "string": return { type: "string", description: p.description };
    case "number": return { type: "number", description: p.description };
    case "boolean": return { type: "boolean", description: p.description };
    case "string[]": return { type: "array", items: { type: "string" }, description: p.description };
    case "array": return { type: "array", items: {}, description: p.description };
    default: return { type: "object", description: p.description, additionalProperties: true };
  }
}
export function toolDefinitionOf(t: ToolSpec) {
  const required = Object.entries(t.params).filter(([, p]) => !p.optional).map(([k]) => k);
  return { name: t.name, description: t.description, input_schema: { type: "object", properties: Object.fromEntries(Object.entries(t.params).map(([k, p]) => [k, schemaOf(p)])), ...(required.length > 0 ? { required } : {}) } };
}

export interface PlannerTurnRecord { turn: number; stopReason: string | null; text: string; toolCalls: Array<{ name: string; input: unknown; ok: boolean | null; error: string | null }>; inputTokens: number; outputTokens: number }

export function createEvalPlannerDriver(o: { fetch: typeof fetch; key: () => string; model: string; maxOutputTokens: number; /** a lower turn ceiling for the evaluation than production's (never higher) */ maxTurns?: number; onTurnRecord?: (r: PlannerTurnRecord) => void }): ModelDriver {
  return {
    async run(input: RunInput): Promise<RunOutput> {
      const tools = input.tools.map(toolDefinitionOf);
      const byName = new Map(input.tools.map((t) => [t.name, t]));
      const messages: Array<{ role: "user" | "assistant"; content: unknown }> = [{ role: "user", content: input.userPrompt }];
      const usage: TokenUsage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
      const maxTurns = Math.min(input.maxTurns, o.maxTurns ?? input.maxTurns);
      let turns = 0;
      let stop = "end";
      let error: string | undefined;
      try {
        while (turns < maxTurns) {
          if (input.state.terminal) break;
          // the run's own model budget (production's maxBudgetUsd, enforced by the SDK there)
          if (llmCostFromUsage(input.model, usage) >= input.maxBudgetUsd) { stop = "budget"; break; }
          const res = await o.fetch(API, {
            method: "POST",
            headers: { "content-type": "application/json", "x-api-key": o.key(), "anthropic-version": "2023-06-01" },
            body: JSON.stringify({ model: o.model, max_tokens: o.maxOutputTokens, thinking: { type: "disabled" }, system: input.systemPrompt, messages, tools }),
          });
          turns += 1;
          const data: any = await res.json().catch(() => null);
          if (!res.ok || !data || data.type !== "message") { stop = "error"; error = `http_${res.status}:${String(data?.error?.type ?? "unreadable").slice(0, 60)}`; break; }
          const u = data.usage ?? {};
          usage.input_tokens! += Number(u.input_tokens) || 0;
          usage.output_tokens! += Number(u.output_tokens) || 0;
          usage.cache_read_input_tokens! += Number(u.cache_read_input_tokens) || 0;
          usage.cache_creation_input_tokens! += Number(u.cache_creation_input_tokens) || 0;
          try { await input.onTurn?.({ turn: turns, usage: { input_tokens: Number(u.input_tokens) || 0, output_tokens: Number(u.output_tokens) || 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }); } catch { /* telemetry */ }
          try { await input.onUsage?.({ usage: { ...usage }, costUsd: llmCostFromUsage(input.model, usage) }); } catch { /* checkpoint */ }
          const content = Array.isArray(data.content) ? data.content : [];
          messages.push({ role: "assistant", content });
          const record: PlannerTurnRecord = { turn: turns, stopReason: typeof data.stop_reason === "string" ? data.stop_reason : null, text: content.filter((b: any) => b?.type === "text").map((b: any) => String(b.text)).join("\n").slice(0, 2000), toolCalls: [], inputTokens: Number(u.input_tokens) || 0, outputTokens: Number(u.output_tokens) || 0 };
          const uses = content.filter((b: any) => b?.type === "tool_use");
          if (uses.length === 0 || data.stop_reason !== "tool_use") { o.onTurnRecord?.(record); stop = data.stop_reason === "max_tokens" ? "max_tokens" : "end"; break; }
          const results: unknown[] = [];
          for (const b of uses) {
            const spec = byName.get(String(b.name));
            let result: Record<string, unknown>;
            if (!spec) result = { ok: false, error: `no such tool: ${String(b.name).slice(0, 40)}` };
            else if (input.state.terminal && spec.name !== "report_progress") result = { ok: false, error: "the run is over; stop now and write nothing more" };
            else { try { result = await spec.handler((b.input ?? {}) as Record<string, unknown>); } catch (e) { result = { ok: false, error: String((e as Error)?.message ?? e).slice(0, 200) }; } }
            record.toolCalls.push({ name: String(b.name), input: b.input, ok: typeof result.ok === "boolean" ? result.ok : null, error: result.ok === false ? JSON.stringify({ error: result.error, ...Object.fromEntries(Object.entries(result).filter(([k]) => k !== "ok" && k !== "error" && /issue|problem|error|reason|fix/i.test(k))) }).slice(0, 900) : null });
            results.push({ type: "tool_result", tool_use_id: b.id, content: clipToolResult(JSON.stringify(result)), ...(result.ok === false ? { is_error: true } : {}) });
          }
          o.onTurnRecord?.(record);
          messages.push({ role: "user", content: results });
        }
        if (turns >= maxTurns && !input.state.terminal) stop = "turns";
      } catch (e) {
        stop = "error";
        error = String((e as Error)?.message ?? e).slice(0, 200);
      }
      return { llmCostUsd: llmCostFromUsage(input.model, usage), turns, usage: { ...usage }, stop, ...(error ? { error } : {}) };
    },
  };
}
