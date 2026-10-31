import { MAX_QUANTITY } from "../money";
import { cleanText } from "../validate";
import { parseActions, type Action, type CountKey } from "./actions";
import { colIndex } from "./profile";
import { ROLES, type FileProfile, type Role, type SheetMapping } from "./types";

/**
 * The model's whole answer, parsed strictly. One JSON object with exactly these optional keys:
 *   say          one short Arabic sentence, NO digits (every number the owner sees is made by code)
 *   mapping      which column is which, per sheet (letters from the profile); code then counts the real cells
 *   image_counts approximate counts read from pictures (shown as «تقريبي», confirmed or edited by the owner)
 *   actions      the fixed action list (see actions.ts)
 * Anything else (an unknown key, a price, a total, an unknown action, a column that does not exist, a prose reply) rejects the WHOLE reply.
 */
export interface ImageCount { image: string; sector: string; itemType: CountKey; quantity: number }
export interface AgentReply { say: string; mapping: SheetMapping[]; imageCounts: ImageCount[]; actions: Action[] }
export type ReplyRejection = "not_json" | "not_object" | "bad_keys" | "bad_mapping" | "bad_image_counts" | "bad_actions" | "money_field";
export type ReplyParse = { ok: true; reply: AgentReply; sayDropped: boolean } | { ok: false; reason: ReplyRejection; detail?: string };

export interface ReplyCtx { profiles: FileProfile[]; imageNames: string[]; lineIds: ReadonlySet<string> }

const MONEY_KEY = /price|cost|total|amount|currency|rate|usd|egp|point|discount|tax|fee|sum|سعر|تكلفة|اجمالي|إجمالي|مبلغ|عملة|جنيه|دولار|نقطة|خصم|ضريبة/i;
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const nameOf = (v: unknown, max = 60): string | null => { if (typeof v !== "string") return null; const s = cleanText(v).replace(/\s+/g, " "); return s.length >= 1 && s.length <= max ? s : null; };

const ITEM_ALIASES: Record<string, CountKey> = {
  company: "company", companies: "company", "شركة": "company", manager: "manager", managers: "manager", "مدير": "manager",
  email: "email", emails: "email", "بريد إلكتروني": "email", phone: "phone", phones: "phone", "رقم هاتف": "phone", department: "department", departments: "department", "جهة تواصل إدارية": "department",
};
export const countKeyOf = (v: unknown): CountKey | null => (typeof v === "string" ? ITEM_ALIASES[v.trim().toLowerCase()] ?? ITEM_ALIASES[v.trim()] ?? null : null);

/** «say» may not state a number: any digit (Latin, Arabic-Indic, Persian) or currency sign makes the code use its own sentence instead. */
export function sanitizeSay(v: unknown): { say: string; dropped: boolean } {
  if (typeof v !== "string") return { say: "", dropped: false };
  const s = cleanText(v).replace(/\s+/g, " ");
  if (/[\d٠-٩۰-۹$€£٪%]/.test(s) || s.length > 300) return { say: "", dropped: true };
  return { say: s, dropped: false };
}

function parseMapping(raw: unknown, profiles: FileProfile[]): SheetMapping[] | null {
  if (!Array.isArray(raw) || raw.length > 40) return null;
  const out: SheetMapping[] = [];
  const seen = new Set<string>();
  for (const e of raw) {
    if (!isObj(e)) return null;
    const keys = Object.keys(e);
    if (!["file", "sheet", "columns"].every((k) => keys.includes(k)) || keys.some((k) => !["file", "sheet", "columns", "sector_name"].includes(k))) return null;
    if (typeof e.file !== "string" || typeof e.sheet !== "string" || !isObj(e.columns)) return null;
    const sheet = profiles.find((p) => p.file === e.file)?.sheets.find((s) => s.sheet === e.sheet);
    if (!sheet) return null;
    const id = `${e.file}\u0000${e.sheet}`;
    if (seen.has(id)) return null;
    seen.add(id);
    const columns: Partial<Record<Role, string>> = {};
    const used = new Set<string>();
    for (const [role, letter] of Object.entries(e.columns)) {
      if (!(ROLES as readonly string[]).includes(role)) return null;
      if (letter === null) continue; // «this sheet has no such column»
      if (typeof letter !== "string" || !/^[A-Za-z]{1,2}$/.test(letter)) return null;
      const L = letter.toUpperCase();
      if (!sheet.columns.some((c) => c.col === L) || colIndex(L) < 0) return null; // a column the profile does not have
      if (used.has(L)) return null; // one column cannot be two things
      used.add(L);
      columns[role as Role] = L;
    }
    if (!columns.company && !columns.manager && !columns.email && !columns.phone) continue; // nothing to count on this sheet (notes, a cover page): skipped, not an error
    let sectorName: string | null = null;
    if ("sector_name" in e && e.sector_name !== null) { sectorName = nameOf(e.sector_name); if (sectorName === null) return null; }
    out.push({ file: e.file, sheet: e.sheet, sectorName, columns });
  }
  return out;
}

function parseImageCounts(raw: unknown, imageNames: string[]): ImageCount[] | null {
  if (!Array.isArray(raw) || raw.length > 200) return null;
  const out: ImageCount[] = [];
  for (const e of raw) {
    if (!isObj(e)) return null;
    const keys = Object.keys(e);
    if (keys.length !== 4 || !["image", "sector", "item_type", "quantity"].every((k) => keys.includes(k))) return null;
    const sector = nameOf(e.sector); const itemType = countKeyOf(e.item_type);
    if (typeof e.image !== "string" || !imageNames.includes(e.image) || sector === null || itemType === null) return null;
    if (typeof e.quantity !== "number" || !Number.isInteger(e.quantity) || e.quantity < 1 || e.quantity > MAX_QUANTITY) return null;
    out.push({ image: e.image, sector, itemType, quantity: e.quantity });
  }
  return out;
}

export function parseAgentReply(reply: string, ctx: ReplyCtx): ReplyParse {
  let text = String(reply ?? "").trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  if (fenced) text = fenced[1].trim();
  let data: unknown;
  try { data = JSON.parse(text); } catch { return { ok: false, reason: "not_json" }; }
  if (!isObj(data)) return { ok: false, reason: "not_object" };
  const keys = Object.keys(data);
  if (keys.some((k) => MONEY_KEY.test(k))) return { ok: false, reason: "money_field", detail: keys.find((k) => MONEY_KEY.test(k)) };
  if (keys.some((k) => !["say", "mapping", "image_counts", "actions"].includes(k))) return { ok: false, reason: "bad_keys" };

  const { say, dropped } = sanitizeSay(data.say);
  let mapping: SheetMapping[] = [];
  if (data.mapping !== undefined && data.mapping !== null) { const m = parseMapping(data.mapping, ctx.profiles); if (m === null) return { ok: false, reason: "bad_mapping" }; mapping = m; }
  let imageCounts: ImageCount[] = [];
  if (data.image_counts !== undefined && data.image_counts !== null) { const m = parseImageCounts(data.image_counts, ctx.imageNames); if (m === null) return { ok: false, reason: "bad_image_counts" }; imageCounts = m; }
  const a = parseActions(data.actions ?? undefined, { lineIds: ctx.lineIds });
  if (!a.ok) return { ok: false, reason: "bad_actions", detail: `${a.reason}${a.detail ? `:${a.detail}` : ""}` };
  return { ok: true, reply: { say, mapping, imageCounts, actions: a.actions }, sayDropped: dropped };
}
