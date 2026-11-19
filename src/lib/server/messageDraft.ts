import { ASSIST_MODEL, assistCostUsd } from "@/lib/invoices/assist";
import { callAnthropicBlocks, type ModelReply } from "@/lib/server/invoices/assist";
import type { MessageField } from "@/lib/campaignText";
import {
  DRAFT_ERRORS_AR, DRAFT_MAX_CALLS_PER_HOUR, DRAFT_MAX_NOTE_CHARS, DRAFT_MAX_OUTPUT_TOKENS, draftIssues, draftSystemPrompt, draftUserText, isDraftAudience, isDraftTone,
  parseDraftReply, type MessageDraft,
} from "@/lib/messageDraft";

/**
 * «اكتب بالذكاء الاصطناعي», server side (DT-20261118-06 phase 2A; admin only: the route runs authenticateAdmin first). Modelled on the invoice helper's runAssist:
 * the hourly allowance (20 per admin) is counted in the admin audit table and one slot is taken BEFORE the model is called (no slot recorded = no call);
 * the model call is the invoice helper's own `callAnthropicBlocks` (same server-side key, same cheap model; no model choice here). A draft the guard refuses gets ONE retry
 * with the reasons appended; if it is still refused, the fields come back with the guard sentence, for the admin to fix by hand. Nothing is saved or sent here.
 */
export type DraftUsage = { model: string; inputTokens: number; outputTokens: number; costUsd: number };
export type DraftOutcome =
  | { ok: true; refused: false; draft: MessageDraft; remaining: number; usage: DraftUsage | null }
  | { ok: true; refused: true; draft: MessageDraft; fields: MessageField[]; message: string; remaining: number; usage: DraftUsage | null }
  | { ok: false; status: 400 | 429 | 502 | 503 | 504; code: "empty" | "too_long" | "bad_input" | "rate_limited" | "unavailable" | "failed"; message: string };

export interface DraftDeps {
  now: () => Date;
  /** how many drafts this admin asked for since `sinceIso` (durable: the audit table) */
  countAttempts: (adminId: string, sinceIso: string) => Promise<number>;
  /** takes one slot of the hourly allowance BEFORE the model is called; false = it could not be recorded (then nothing is sent) */
  recordAttempt: (adminId: string, chars: number) => Promise<boolean>;
  recordUsage?: (adminId: string, usage: DraftUsage) => Promise<void>;
  callModel: (system: string, userText: string) => Promise<ModelReply>;
}

export async function runDraft(input: { adminId: string; note: string; tone: string; audience: string }, deps: DraftDeps): Promise<DraftOutcome> {
  const note = String(input.note ?? "").replace(/\r\n?/g, "\n").trim();
  if (note.length === 0) return { ok: false, status: 400, code: "empty", message: DRAFT_ERRORS_AR.empty };
  if (note.length > DRAFT_MAX_NOTE_CHARS) return { ok: false, status: 400, code: "too_long", message: DRAFT_ERRORS_AR.tooLong };
  const tone = String(input.tone ?? "");
  const audience = String(input.audience ?? "");
  if (!isDraftTone(tone) || !isDraftAudience(audience)) return { ok: false, status: 400, code: "bad_input", message: DRAFT_ERRORS_AR.badInput };

  const since = new Date(deps.now().getTime() - 3_600_000).toISOString();
  const used = await deps.countAttempts(input.adminId, since);
  if (used >= DRAFT_MAX_CALLS_PER_HOUR) return { ok: false, status: 429, code: "rate_limited", message: DRAFT_ERRORS_AR.rate };
  if (!(await deps.recordAttempt(input.adminId, note.length))) return { ok: false, status: 503, code: "unavailable", message: DRAFT_ERRORS_AR.unavailable };
  const remaining = Math.max(0, DRAFT_MAX_CALLS_PER_HOUR - used - 1);

  const system = draftSystemPrompt();
  let inputTokens = 0;
  let outputTokens = 0;
  let calls = 0;
  const usage = (): DraftUsage | null => (calls === 0 ? null : { model: ASSIST_MODEL, inputTokens, outputTokens, costUsd: assistCostUsd(inputTokens, outputTokens) });
  const finish = async <T extends DraftOutcome>(out: T): Promise<T> => {
    const u = usage();
    if (u) { try { await deps.recordUsage?.(input.adminId, u); } catch { /* a cost line is not worth failing the admin's request */ } }
    return out;
  };

  let problems: string[] = [];
  let last: { draft: MessageDraft; fields: MessageField[] } | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const reply = await deps.callModel(system, draftUserText({ note, tone, audience }, problems));
    if (!reply.ok) {
      if (reply.code === "no_key") return finish({ ok: false, status: 503, code: "unavailable", message: DRAFT_ERRORS_AR.unavailable });
      return finish({ ok: false, status: reply.code === "timeout" ? 504 : 502, code: "failed", message: DRAFT_ERRORS_AR.failed });
    }
    calls += 1;
    inputTokens += reply.inputTokens;
    outputTokens += reply.outputTokens;
    const parsed = parseDraftReply(reply.text);
    if (!parsed.ok) {
      problems = ['the reply was not the JSON object {"subject","badge","heading","body","ctaLabel"} with text values'];
      continue;
    }
    const issues = draftIssues(parsed.draft, note);
    if (issues.length === 0) return finish({ ok: true, refused: false, draft: parsed.draft, remaining, usage: usage() });
    last = { draft: parsed.draft, fields: [...new Set(issues.map((i) => i.field ?? "body"))] };
    problems = issues.flatMap((i) => i.issues.map((t) => `${i.field ?? "message"}: ${t}`));
  }
  if (!last) return finish({ ok: false, status: 502, code: "failed", message: DRAFT_ERRORS_AR.failed });
  return finish({ ok: true, refused: true, draft: last.draft, fields: last.fields, message: DRAFT_ERRORS_AR.refused, remaining, usage: usage() });
}

// ---------- production dependencies ----------

const TARGET = "message_draft";

/** The hourly allowance in the admin audit table (durable across restarts and server instances), like the invoice helper's, under its own target type. */
export function draftAuditDeps(client: { from: (table: string) => any }): Pick<DraftDeps, "countAttempts" | "recordAttempt" | "recordUsage"> {
  return {
    async countAttempts(adminId, sinceIso) {
      const res = await client.from("admin_audit_log").select("id", { count: "exact", head: true }).eq("actor_id", adminId).eq("target_type", TARGET).eq("target_id", "attempt").gte("created_at", sinceIso);
      return Number(res?.count ?? 0);
    },
    async recordAttempt(adminId, chars) {
      const res = await client.from("admin_audit_log").insert({ actor_id: adminId, action: "email", target_type: TARGET, target_id: "attempt", details: { label: "الكاتب الذكي للرسائل", chars } });
      return !res?.error;
    },
    async recordUsage(adminId, usage) {
      await client.from("admin_audit_log").insert({ actor_id: adminId, action: "email", target_type: TARGET, target_id: "usage", details: { ...usage } });
    },
  };
}

/** The model call: the invoice helper's own function (server-side key, fixed cheap model), with the drafting output cap. */
export function callDraftModel(system: string, userText: string): Promise<ModelReply> {
  return callAnthropicBlocks(system, userText, DRAFT_MAX_OUTPUT_TOKENS);
}
