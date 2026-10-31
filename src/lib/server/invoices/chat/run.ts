import { COUNT_KEYS, type Action, type CountKey } from "@/lib/invoices/chat/actions";
import type { DraftSummary } from "@/lib/invoices/chat/apply";
import { countByMapping } from "@/lib/invoices/chat/count";
import { AGENT_MAX_CALLS_PER_HOUR, AGENT_MAX_CHARS, AGENT_MAX_FILES, AGENT_MAX_OUTPUT_TOKENS, AGENT_MODEL, agentCostUsd } from "@/lib/invoices/chat/limits";
import { buildAgentRequest, cleanHistory, estimateTextTokens, type ContentBlock } from "@/lib/invoices/chat/prompt";
import { profileSheet } from "@/lib/invoices/chat/profile";
import { parseAgentReply, type ImageCount } from "@/lib/invoices/chat/reply";
import type { CountResult, FileProfile, ParsedSheetFile, SheetMapping } from "@/lib/invoices/chat/types";
import { cleanText } from "@/lib/invoices/validate";
import type { ModelReply } from "../assist";
import { AgentInputError, newRowBudget, parseAgentFile } from "./parseFiles";

/**
 * One turn of the invoice agent, server side. Order: validate the owner's text and files (nothing is sent anywhere yet) -> read the files with code, in memory ->
 * take one slot of the hourly allowance in the audit table BEFORE the model is called -> one model call with the masked profiles -> parse the reply strictly ->
 * COUNT the real cells with code from the mapping. Nothing is stored: not the files, not their values, not the reply.
 */
export const AGENT_ERRORS_AR = {
  empty: "اكتب رسالتك أو أرفق ملفًا.",
  tooLong: "الرسالة أطول من ٤٠٠٠ حرف. اختصرها أو قسّمها.",
  tooManyFiles: "الحد الأقصى ٥ ملفات في الرسالة الواحدة.",
  rate: "وصلت للحد المسموح: ٣٠ رسالة للمساعد في الساعة. حاول بعد قليل أو أكمل يدويًا من الخانات.",
  parse: "ما قدرتش أفهم رد المساعد. أعد صياغة طلبك بكلمات أوضح. رسالتك لم تُمسح.",
  unavailable: "مساعد الفواتير غير متاح الآن. أكمل يدويًا من الخانات أو حاول لاحقًا.",
  failed: "تعذّر الاتصال بالمساعد الآن. أعد المحاولة بعد قليل. رسالتك لم تُمسح.",
  draft: "تعذّر قراءة حالة المسودة. أعد تحميل الصفحة وحاول مرة أخرى.",
} as const;

export interface AgentDeps {
  now: () => Date;
  countAttempts: (adminId: string, sinceIso: string) => Promise<number>;
  recordAttempt: (adminId: string, meta: { chars: number; files: number }) => Promise<boolean>;
  recordUsage?: (adminId: string, usage: { model: string; inputTokens: number; outputTokens: number; costUsd: number }) => Promise<void>;
  callModel: (system: string, content: ContentBlock[], maxTokens: number) => Promise<ModelReply>;
}

export interface AgentFileIn { name: string; bytes: Uint8Array }
export interface AgentInput { adminId: string; message: string; history: unknown; draft: unknown; files: AgentFileIn[]; itemTypeNames: string[] }

export interface FileReport { name: string; kind: "sheet" | "image"; sheets: Array<{ sheet: string; rows: number }> }
export interface AgentSuccess {
  ok: true;
  say: string;
  sayDropped: boolean;
  actions: Action[];
  files: FileReport[];
  mapping: SheetMapping[];
  /** sheets the model did not map (notes, cover pages, or columns it could not tell apart) */
  unmapped: Array<{ file: string; sheet: string }>;
  count: CountResult | null;
  imageCounts: ImageCount[];
  usage: { model: string; inputTokens: number; outputTokens: number; costUsd: number };
}
export type AgentOutcome = AgentSuccess | { ok: false; status: number; code: string; message: string };

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown, max: number): string => (typeof v === "string" ? cleanText(v).replace(/\s+/g, " ").slice(0, max) : "");

/** The draft the browser sends is re-built field by field (types, lengths, line-id shape), never passed through. */
export function sanitizeDraft(raw: unknown): { summary: DraftSummary; lineIds: Set<string> } | null {
  if (!isObj(raw) || !isObj(raw.currencies) || !Array.isArray(raw.sectors) || !Array.isArray(raw.lines)) return null;
  const docType = ["invoice", "quote", "statement"].includes(String(raw.doc_type)) ? String(raw.doc_type) : null;
  const discount = ["none", "percent", "amount"].includes(String(raw.discount)) ? String(raw.discount) : null;
  if (!docType || !discount || raw.sectors.length > 50 || raw.lines.length > 150) return null;
  const sectors: DraftSummary["sectors"] = [];
  for (const s of raw.sectors) {
    if (!isObj(s) || !isObj(s.counts)) return null;
    const counts: Partial<Record<CountKey, number>> = {};
    for (const k of COUNT_KEYS) { const n = s.counts[k]; if (n !== undefined) { if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > 10_000_000) return null; counts[k] = n; } }
    sectors.push({ name: str(s.name, 80), summary_only: s.summary_only === true, counts });
  }
  const lineIds = new Set<string>();
  const lines: DraftSummary["lines"] = [];
  for (const l of raw.lines) {
    if (!isObj(l) || typeof l.id !== "string" || !/^L\d{1,4}$/.test(l.id)) return null;
    lineIds.add(l.id);
    lines.push({ id: l.id, sector: str(l.sector, 80), item_type: str(l.item_type, 80), hidden: l.hidden === true });
  }
  const c = raw.currencies;
  return {
    summary: { doc_type: docType, currencies: { usd: c.usd === true, points: c.points === true, egp: c.egp === true }, rate_set: raw.rate_set === true, discount, client: str(raw.client, 120), sectors, lines, lines_listed: raw.lines_listed === true },
    lineIds,
  };
}

export async function runAgent(input: AgentInput, deps: AgentDeps): Promise<AgentOutcome> {
  const message = cleanText(String(input.message ?? ""));
  if (message.length > AGENT_MAX_CHARS) return { ok: false, status: 400, code: "too_long", message: AGENT_ERRORS_AR.tooLong };
  if (message.length === 0 && input.files.length === 0) return { ok: false, status: 400, code: "empty", message: AGENT_ERRORS_AR.empty };
  if (input.files.length > AGENT_MAX_FILES) return { ok: false, status: 400, code: "too_many_files", message: AGENT_ERRORS_AR.tooManyFiles };
  const draft = sanitizeDraft(input.draft);
  if (!draft) return { ok: false, status: 400, code: "bad_draft", message: AGENT_ERRORS_AR.draft };

  // 1. the files, read with code, in memory (an unreadable file is the owner's to fix: no model call, no allowance used)
  const sheets: ParsedSheetFile[] = [];
  const images: Array<{ name: string; mediaType: "image/png" | "image/jpeg"; bytes: Uint8Array }> = [];
  const reports: FileReport[] = [];
  try {
    const budget = newRowBudget();
    for (const f of input.files) {
      const parsed = await parseAgentFile(String(f.name).slice(0, 120), f.bytes, budget);
      if (parsed.kind === "image") { images.push({ name: parsed.name, mediaType: parsed.mediaType, bytes: parsed.bytes }); reports.push({ name: parsed.name, kind: "image", sheets: [] }); }
      else { sheets.push(parsed); reports.push({ name: parsed.name, kind: "sheet", sheets: parsed.sheets.map((s) => ({ sheet: s.name, rows: Math.max(0, s.rows.length - 1) })) }); }
    }
  } catch (e) {
    if (e instanceof AgentInputError) return { ok: false, status: e.status, code: e.code, message: e.message };
    return { ok: false, status: 400, code: "bad_file", message: "تعذّرت قراءة أحد الملفات." };
  }
  const profiles: FileProfile[] = sheets.map((f) => ({ file: f.name, sheets: f.sheets.map(profileSheet) }));
  const req = buildAgentRequest({ message, history: cleanHistory(input.history), draft: draft.summary, profiles, images, itemTypeNames: input.itemTypeNames });

  // 2. the hourly allowance, taken BEFORE the model is called
  const since = new Date(deps.now().getTime() - 3_600_000).toISOString();
  if ((await deps.countAttempts(input.adminId, since)) >= AGENT_MAX_CALLS_PER_HOUR) return { ok: false, status: 429, code: "rate_limited", message: AGENT_ERRORS_AR.rate };
  if (!(await deps.recordAttempt(input.adminId, { chars: message.length, files: input.files.length }))) return { ok: false, status: 503, code: "unavailable", message: AGENT_ERRORS_AR.unavailable };

  // 3. the model
  const reply = await deps.callModel(req.system, req.content, AGENT_MAX_OUTPUT_TOKENS);
  if (!reply.ok) {
    return reply.code === "no_key" ? { ok: false, status: 503, code: "unavailable", message: AGENT_ERRORS_AR.unavailable } : { ok: false, status: 502, code: "failed", message: AGENT_ERRORS_AR.failed };
  }
  const usage = { model: AGENT_MODEL, inputTokens: reply.inputTokens, outputTokens: reply.outputTokens, costUsd: agentCostUsd(reply.inputTokens, reply.outputTokens) };
  try { await deps.recordUsage?.(input.adminId, usage); } catch { /* a cost line is not worth failing the owner's request */ }

  const parsed = parseAgentReply(reply.text, { profiles, imageNames: images.map((i) => i.name), lineIds: draft.lineIds });
  if (!parsed.ok) return { ok: false, status: 422, code: `unreadable_${parsed.reason}`, message: AGENT_ERRORS_AR.parse };

  // 4. the counts, by code, from the mapping
  const count = sheets.length && parsed.reply.mapping.length ? countByMapping(sheets, parsed.reply.mapping) : null;
  const mappedIds = new Set(parsed.reply.mapping.map((m) => `${m.file}\u0000${m.sheet}`));
  const unmapped = sheets.flatMap((f) => f.sheets.filter((s) => !mappedIds.has(`${f.name}\u0000${s.name}`)).map((s) => ({ file: f.name, sheet: s.name })));
  return { ok: true, say: parsed.reply.say, sayDropped: parsed.sayDropped, actions: parsed.reply.actions, files: reports, mapping: parsed.reply.mapping, unmapped, count, imageCounts: parsed.reply.imageCounts, usage };
}

export { estimateTextTokens };

const TARGET = "invoice_agent";
/** the hourly allowance is counted in the admin audit table, like the assistant's; a row records the SIZE of the request, never its content or its file names */
export function agentAuditDeps(client: { from: (table: string) => any }): Pick<AgentDeps, "countAttempts" | "recordAttempt" | "recordUsage"> {
  return {
    async countAttempts(adminId, sinceIso) {
      const res = await client.from("admin_audit_log").select("id", { count: "exact", head: true }).eq("actor_id", adminId).eq("target_type", TARGET).eq("target_id", "attempt").gte("created_at", sinceIso);
      return Number(res?.count ?? 0);
    },
    async recordAttempt(adminId, meta) {
      const res = await client.from("admin_audit_log").insert({ actor_id: adminId, action: "invoice", target_type: TARGET, target_id: "attempt", details: { label: "مساعد الفواتير", chars: meta.chars, files: meta.files } });
      return !res?.error;
    },
    async recordUsage(adminId, usage) {
      await client.from("admin_audit_log").insert({ actor_id: adminId, action: "invoice", target_type: TARGET, target_id: "usage", details: { ...usage } });
    },
  };
}
