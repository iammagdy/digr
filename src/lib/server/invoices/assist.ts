import {
  ASSIST_ERRORS_AR, ASSIST_MAX_CALLS_PER_HOUR, ASSIST_MAX_CHARS, ASSIST_MAX_OUTPUT_TOKENS, ASSIST_MODEL, assistCostUsd, assistSystemPrompt, parseAssistReply,
  type AssistRejection,
} from "@/lib/invoices/assist";
import type { AssistSector } from "@/lib/invoices/sectors";
import { cleanText } from "@/lib/invoices/validate";
import { reportProviderHttpStatus, resolveProviderKey } from "@/lib/server/providerKeys";

/**
 * The Claude helper, server side (admin only: the route runs authenticateAdmin first). It sends the owner's note and the item-type NAMES to the model and reads back
 * `[{sector, item_type, quantity}]`; nothing else. It never sends or reads a price, a total or a currency, and it never saves anything.
 * The key comes from the same server-side store the rest of the app uses; it is never returned, logged or put in an error.
 */
export type AssistOutcome =
  | { ok: true; sectors: AssistSector[]; usage: { model: string; inputTokens: number; outputTokens: number; costUsd: number } | null }
  | { ok: false; status: 400 | 422 | 429 | 502 | 503; code: "empty" | "too_long" | "rate_limited" | "unavailable" | "failed" | "unreadable" | "nothing"; message: string; reason?: AssistRejection };

export type ModelReply =
  | { ok: true; text: string; inputTokens: number; outputTokens: number; stopReason: string | null }
  | { ok: false; code: "no_key" | "http" | "network" | "timeout" };

export interface AssistDeps {
  now: () => Date;
  /** how many helper calls this admin made since `sinceIso` (durable: the audit table) */
  countAttempts: (adminId: string, sinceIso: string) => Promise<number>;
  /** takes one slot of the hourly allowance BEFORE the model is called; false = it could not be recorded (then nothing is sent) */
  recordAttempt: (adminId: string, chars: number) => Promise<boolean>;
  recordUsage?: (adminId: string, usage: { model: string; inputTokens: number; outputTokens: number; costUsd: number }) => Promise<void>;
  callModel: (system: string, note: string) => Promise<ModelReply>;
}

export async function runAssist(input: { adminId: string; text: string; types: Array<{ id: string; nameAr: string }> }, deps: AssistDeps): Promise<AssistOutcome> {
  const note = cleanText(String(input.text ?? ""));
  if (note.length === 0) return { ok: false, status: 400, code: "empty", message: ASSIST_ERRORS_AR.empty };
  if (note.length > ASSIST_MAX_CHARS) return { ok: false, status: 400, code: "too_long", message: ASSIST_ERRORS_AR.tooLong };
  if (input.types.length === 0) return { ok: false, status: 503, code: "unavailable", message: ASSIST_ERRORS_AR.unavailable };

  const since = new Date(deps.now().getTime() - 3_600_000).toISOString();
  const used = await deps.countAttempts(input.adminId, since);
  if (used >= ASSIST_MAX_CALLS_PER_HOUR) return { ok: false, status: 429, code: "rate_limited", message: ASSIST_ERRORS_AR.rate };
  if (!(await deps.recordAttempt(input.adminId, note.length))) return { ok: false, status: 503, code: "unavailable", message: ASSIST_ERRORS_AR.unavailable };

  const reply = await deps.callModel(assistSystemPrompt(input.types.map((t) => t.nameAr)), note);
  if (!reply.ok) {
    return reply.code === "no_key"
      ? { ok: false, status: 503, code: "unavailable", message: ASSIST_ERRORS_AR.unavailable }
      : { ok: false, status: 502, code: "failed", message: ASSIST_ERRORS_AR.failed };
  }
  const usage = { model: ASSIST_MODEL, inputTokens: reply.inputTokens, outputTokens: reply.outputTokens, costUsd: assistCostUsd(reply.inputTokens, reply.outputTokens) };
  try { await deps.recordUsage?.(input.adminId, usage); } catch { /* a cost line is not worth failing the owner's request */ }

  const parsed = parseAssistReply(reply.text, input.types);
  if (!parsed.ok) {
    return parsed.reason === "empty"
      ? { ok: false, status: 422, code: "nothing", message: ASSIST_ERRORS_AR.nothing, reason: parsed.reason }
      : { ok: false, status: 422, code: "unreadable", message: ASSIST_ERRORS_AR.parse, reason: parsed.reason };
  }
  return { ok: true, sectors: parsed.sectors, usage };
}

// ---------- production dependencies ----------

const TARGET = "invoice_assist";

/** The hourly allowance is counted in the admin audit table (durable across restarts and server instances), like the key checker's. */
export function auditDeps(client: { from: (table: string) => any }): Pick<AssistDeps, "countAttempts" | "recordAttempt" | "recordUsage"> {
  return {
    async countAttempts(adminId, sinceIso) {
      const res = await client.from("admin_audit_log").select("id", { count: "exact", head: true }).eq("actor_id", adminId).eq("target_type", TARGET).eq("target_id", "attempt").gte("created_at", sinceIso);
      return Number(res?.count ?? 0);
    },
    async recordAttempt(adminId, chars) {
      const res = await client.from("admin_audit_log").insert({ actor_id: adminId, action: "invoice", target_type: TARGET, target_id: "attempt", details: { label: "مساعد ترتيب الفاتورة", chars } });
      return !res?.error;
    },
    async recordUsage(adminId, usage) {
      await client.from("admin_audit_log").insert({ actor_id: adminId, action: "invoice", target_type: TARGET, target_id: "usage", details: { ...usage } });
    },
  };
}

/** One call to the Messages API with the app's server-side key (same plain fetch the app's other model calls use). Low effort, no prices in the request. */
export async function callAnthropic(system: string, note: string): Promise<ModelReply> {
  let key = "";
  let source: "store" | "env" | "none" | "pool" = "none";
  try { const resolved = await resolveProviderKey("anthropic"); key = resolved.key; source = resolved.source; } catch { key = ""; }
  if (!key) return { ok: false, code: "no_key" };

  const send = async (withEffort: boolean): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      return await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: ASSIST_MODEL, max_tokens: ASSIST_MAX_OUTPUT_TOKENS, ...(withEffort ? { output_config: { effort: "low" } } : {}), system, messages: [{ role: "user", content: note }] }),
        signal: controller.signal,
      });
    } finally { clearTimeout(timer); }
  };

  try {
    let res = await send(true);
    if (res.status === 400) res = await send(false); // the API refused the effort field: ask again once without it
    if (!res.ok) {
      reportProviderHttpStatus("anthropic", res.status, source);
      return { ok: false, code: "http" };
    }
    const data: any = await res.json();
    const text = Array.isArray(data?.content) ? data.content.filter((b: any) => b?.type === "text").map((b: any) => String(b.text ?? "")).join("") : "";
    return { ok: true, text, inputTokens: Number(data?.usage?.input_tokens ?? 0), outputTokens: Number(data?.usage?.output_tokens ?? 0), stopReason: data?.stop_reason ?? null };
  } catch (e) {
    return { ok: false, code: (e as { name?: string })?.name === "AbortError" ? "timeout" : "network" };
  }
}
