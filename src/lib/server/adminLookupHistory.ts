import { randomUUID } from "node:crypto";
import { maskLookupValue } from "./sensitiveAccess";
import { FIELD_KEYS, type LookupFields } from "../adminLookupResult";
import { classifyLookupInput } from "./adminLookup";

/**
 * The HISTORY of the admin «بحث عكسي»: each finished lookup is stored (the typed value MASKED, the fields found with the source of each, the attempts and their cost) so an earlier result can be
 * reopened later WITHOUT a new call. The server table `admin_lookup_history` is a PROPOSAL not applied yet (docs/proposals/admin-lookup-history/); until the owner applies it the table is
 * missing, `loadLookupHistory` says so (`available: false`) and the screen keeps the history in the admin's own browser instead. Nothing here touches a customer's data or money.
 */
export const LOOKUP_HISTORY_TABLE = "admin_lookup_history";
export const LOOKUP_HISTORY_LIMIT = 30;

export interface HistoryAttempt { endpointId: string; outcome: string; costUsd: number; note: string }
export interface HistoryEntry {
  id: string;
  createdAt: string;
  kind: "phone" | "email";
  maskedInput: string;
  found: boolean;
  fields: LookupFields;
  attempts: HistoryAttempt[];
  costUsd: number;
}

const clip = (v: unknown, n: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/** The entry the screen sends, cleaned: only known fields, bounded text, the typed value replaced by its mask. Null when the input is not a phone or an e-mail. */
export function sanitizeEntry(raw: any, rawInput: unknown): Omit<HistoryEntry, "id" | "createdAt"> | null {
  const parsed = classifyLookupInput(rawInput);
  if (!parsed) return null;
  const fields: LookupFields = {};
  for (const key of FIELD_KEYS) {
    const f = raw?.fields?.[key];
    if (f && typeof f.value === "string" && f.value.trim()) fields[key] = { value: clip(f.value, 160), source: clip(f.source, 80) };
  }
  const attempts: HistoryAttempt[] = (Array.isArray(raw?.attempts) ? raw.attempts : []).slice(0, 16).map((a: any) => ({ endpointId: clip(a?.endpointId, 80), outcome: clip(a?.outcome, 24), costUsd: Math.max(0, Number(a?.costUsd) || 0), note: clip(a?.note, 120) }));
  return { kind: parsed.kind, maskedInput: maskLookupValue(parsed.value), found: Object.keys(fields).length > 0, fields, attempts, costUsd: Number(attempts.reduce((s, a) => s + a.costUsd, 0).toFixed(6)) };
}

export async function loadLookupHistory(client: any): Promise<{ available: boolean; rows: HistoryEntry[] }> {
  if (typeof client?.from !== "function") return { available: false, rows: [] };
  try {
    const { data, error } = await client.from(LOOKUP_HISTORY_TABLE).select("id, created_at, kind, masked_input, found, result, cost_usd").order("created_at", { ascending: false }).limit(LOOKUP_HISTORY_LIMIT);
    if (error || !Array.isArray(data)) return { available: false, rows: [] };
    return { available: true, rows: data.map((r: any) => ({ id: String(r.id), createdAt: String(r.created_at), kind: r.kind === "email" ? "email" : "phone", maskedInput: String(r.masked_input ?? ""), found: Boolean(r.found), fields: r.result?.fields ?? {}, attempts: Array.isArray(r.result?.attempts) ? r.result.attempts : [], costUsd: Number(r.cost_usd) || 0 })) };
  } catch { return { available: false, rows: [] }; }
}

/** Stores one finished lookup. `stored: false` when the table is not there (the screen then keeps it in the browser). */
export async function saveLookupHistory(client: any, adminId: string, entry: Omit<HistoryEntry, "id" | "createdAt">): Promise<{ stored: boolean; id: string | null }> {
  if (typeof client?.from !== "function") return { stored: false, id: null };
  try {
    const id = randomUUID();
    const { error } = await client.from(LOOKUP_HISTORY_TABLE).insert({ id, admin_id: adminId, kind: entry.kind, masked_input: entry.maskedInput, found: entry.found, result: { fields: entry.fields, attempts: entry.attempts }, cost_usd: entry.costUsd });
    if (error) return { stored: false, id: null };
    return { stored: true, id };
  } catch { return { stored: false, id: null }; }
}
