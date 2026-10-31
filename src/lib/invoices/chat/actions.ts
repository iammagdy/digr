import { MAX_QUANTITY, RATE_MAX_E4, RATE_MIN_E4, parseScaled } from "../money";
import { parseUnitUsd } from "../priceInput";
import type { Currency, DiscountKind, DocType } from "../types";
import { cleanText } from "../validate";
import { AGENT_MAX_ACTIONS } from "./limits";

/**
 * The fixed vocabulary of the agent. The model translates the owner's words into this list and NOTHING else: an action outside it, an extra key, a number that is not a
 * number, or a money-looking field anywhere rejects the WHOLE reply. Code executes the actions with the existing money library; the model never computes a price or a total.
 */
export type CountKey = "company" | "manager" | "email" | "phone" | "department";
export const COUNT_KEYS: readonly CountKey[] = ["company", "manager", "email", "phone", "department"];
export type Counts = Partial<Record<CountKey, number>>;

export type Action =
  | { type: "set_rate"; rateE4: number }
  | { type: "set_currencies"; usd?: boolean; points?: boolean; egp?: boolean }
  | { type: "add_sector"; name: string; counts: Counts }
  | { type: "set_counts"; sector: string; counts: Counts }
  | { type: "set_unit_price"; itemType: string; unit: "usd" | "points"; text: string }
  | { type: "set_target_total"; currency: Currency; text: string }
  | { type: "set_discount"; kind: DiscountKind; text: string }
  | { type: "set_doc_type"; docType: DocType }
  | { type: "set_client"; name: string }
  | { type: "set_layout"; maxPages?: number; summaryOnlySectors?: string[]; hideLineIds?: string[]; unhideAll?: boolean; showPhaseSummary?: boolean }
  | { type: "rename_sector"; from: string; to: string }
  | { type: "remove_sector"; sector: string };

export const ACTION_TYPES = ["set_rate", "set_currencies", "add_sector", "set_counts", "set_unit_price", "set_target_total", "set_discount", "set_doc_type", "set_client", "set_layout", "rename_sector", "remove_sector"] as const;

/** Actions that change what the document adds up to (or what its figures are shown in): each shows before/after totals and waits for the owner's «تمام». */
const MONEY_CHANGING = new Set<Action["type"]>(["set_rate", "set_currencies", "add_sector", "set_counts", "set_unit_price", "set_target_total", "set_discount", "set_doc_type", "remove_sector"]);
export const isMoneyAction = (a: Action): boolean => MONEY_CHANGING.has(a.type);

export type ActionRejection = "not_object" | "unknown_action" | "bad_keys" | "bad_value" | "too_many_actions";
export type ActionsParse = { ok: true; actions: Action[] } | { ok: false; reason: ActionRejection; detail?: string };

const fail = (reason: ActionRejection, detail?: string): { ok: false; reason: ActionRejection; detail?: string } => ({ ok: false, reason, detail });
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const keysOk = (o: Record<string, unknown>, required: string[], optional: string[] = []): boolean => {
  const keys = Object.keys(o);
  return required.every((k) => keys.includes(k)) && keys.every((k) => required.includes(k) || optional.includes(k));
};

/** a JSON number or a string -> the plain decimal text the money parsers read; exponent forms and anything else are refused */
export function decimalText(v: unknown): string | null {
  if (typeof v === "number") { if (!Number.isFinite(v) || v < 0) return null; const s = String(v); return /e/i.test(s) ? null : s; }
  if (typeof v === "string") { const s = v.trim(); return s !== "" && s.length <= 24 ? s : null; }
  return null;
}
const name = (v: unknown, max = 80): string | null => { if (typeof v !== "string") return null; const s = cleanText(v).replace(/\s+/g, " "); return s.length >= 1 && s.length <= max ? s : null; };
const whole = (v: unknown, min: number, max: number): number | null => (typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : null);

function countsOf(v: unknown): Counts | null {
  if (!isObj(v) || !keysOk(v, [], [...COUNT_KEYS])) return null;
  const out: Counts = {};
  for (const k of COUNT_KEYS) if (k in v) { const n = whole(v[k], 0, MAX_QUANTITY); if (n === null) return null; out[k] = n; }
  return Object.keys(out).length ? out : null;
}
const nameList = (v: unknown, max: number): string[] | null => {
  if (!Array.isArray(v) || v.length > max) return null;
  const out: string[] = [];
  for (const x of v) { const n = name(x, 80); if (n === null) return null; out.push(n); }
  return out;
};

export interface ActionCtx { lineIds: ReadonlySet<string> }

function parseOne(raw: unknown, ctx: ActionCtx): { ok: true; action: Action } | { ok: false; reason: ActionRejection; detail?: string } {
  if (!isObj(raw)) return fail("not_object");
  const type = raw.action;
  if (typeof type !== "string" || !(ACTION_TYPES as readonly string[]).includes(type)) return fail("unknown_action", String(type));
  const bad = (d: string) => fail("bad_value", `${type}.${d}`);
  const keys = (req: string[], opt: string[] = []) => keysOk(raw, ["action", ...req], opt);
  switch (type) {
    case "set_rate": {
      if (!keys(["egp_per_usd"])) return fail("bad_keys", type);
      const t = decimalText(raw.egp_per_usd); const e4 = t === null ? null : parseScaled(t, 4);
      if (e4 === null || e4 < RATE_MIN_E4 || e4 > RATE_MAX_E4) return bad("egp_per_usd");
      return { ok: true, action: { type, rateE4: e4 } };
    }
    case "set_currencies": {
      if (!keys([], ["usd", "points", "egp"])) return fail("bad_keys", type);
      const flags = { usd: raw.usd, points: raw.points, egp: raw.egp };
      for (const v of Object.values(flags)) if (v !== undefined && typeof v !== "boolean") return bad("flags");
      if (flags.usd === undefined && flags.points === undefined && flags.egp === undefined) return bad("flags");
      // an omitted flag means «leave as is»: it is resolved against the draft at apply time (encoded as null -> undefined)
      return { ok: true, action: { type, ...(flags.usd !== undefined ? { usd: flags.usd as boolean } : {}), ...(flags.points !== undefined ? { points: flags.points as boolean } : {}), ...(flags.egp !== undefined ? { egp: flags.egp as boolean } : {}) } };
    }
    case "add_sector": case "set_counts": {
      const key = type === "add_sector" ? "name" : "sector";
      if (!keys([key, "counts"])) return fail("bad_keys", type);
      const n = name(raw[key]); const counts = countsOf(raw.counts);
      if (n === null) return bad(key); if (counts === null) return bad("counts");
      return { ok: true, action: type === "add_sector" ? { type, name: n, counts } : { type, sector: n, counts } };
    }
    case "set_unit_price": {
      if (!keys(["item_type", "value", "unit"])) return fail("bad_keys", type);
      const item = name(raw.item_type, 40); const t = decimalText(raw.value);
      if (item === null) return bad("item_type");
      if (raw.unit !== "usd" && raw.unit !== "points") return bad("unit");
      if (t === null) return bad("value");
      if (raw.unit === "usd" ? !parseUnitUsd(t).ok : parseScaled(t, 2) === null) return bad("value");
      return { ok: true, action: { type, itemType: item, unit: raw.unit, text: t } };
    }
    case "set_target_total": {
      if (!keys(["amount", "currency"])) return fail("bad_keys", type);
      if (raw.currency !== "usd" && raw.currency !== "points" && raw.currency !== "egp") return bad("currency");
      const t = decimalText(raw.amount); const v = t === null ? null : parseScaled(t, raw.currency === "points" ? 0 : 2);
      if (t === null || v === null || v <= 0) return bad("amount");
      return { ok: true, action: { type, currency: raw.currency, text: t } };
    }
    case "set_discount": {
      if (!keys(["kind"], ["value"])) return fail("bad_keys", type);
      if (raw.kind !== "none" && raw.kind !== "percent" && raw.kind !== "amount") return bad("kind");
      if (raw.kind === "none") return { ok: true, action: { type, kind: "none", text: "" } };
      const t = decimalText(raw.value); const v = t === null ? null : parseScaled(t, 2);
      if (t === null || v === null || v <= 0 || (raw.kind === "percent" && v > 10000)) return bad("value");
      return { ok: true, action: { type, kind: raw.kind, text: t } };
    }
    case "set_doc_type": {
      if (!keys(["doc_type"])) return fail("bad_keys", type);
      if (raw.doc_type !== "invoice" && raw.doc_type !== "quote" && raw.doc_type !== "statement") return bad("doc_type");
      return { ok: true, action: { type, docType: raw.doc_type } };
    }
    case "set_client": {
      if (!keys(["name"])) return fail("bad_keys", type);
      const n = name(raw.name, 120); if (n === null) return bad("name");
      return { ok: true, action: { type, name: n } };
    }
    case "set_layout": {
      if (!keys([], ["max_pages", "summary_only_sectors", "hide_line_ids", "unhide_all", "show_phase_summary"])) return fail("bad_keys", type);
      const out: Extract<Action, { type: "set_layout" }> = { type };
      if ("max_pages" in raw) { const n = whole(raw.max_pages, 1, 20); if (n === null) return bad("max_pages"); out.maxPages = n; }
      if ("summary_only_sectors" in raw) { const l = nameList(raw.summary_only_sectors, 50); if (l === null) return bad("summary_only_sectors"); out.summaryOnlySectors = l; }
      if ("hide_line_ids" in raw) {
        const l = nameList(raw.hide_line_ids, 500);
        if (l === null || l.some((id) => !ctx.lineIds.has(id))) return bad("hide_line_ids");
        out.hideLineIds = l;
      }
      if ("unhide_all" in raw) { if (typeof raw.unhide_all !== "boolean") return bad("unhide_all"); out.unhideAll = raw.unhide_all; }
      if ("show_phase_summary" in raw) { if (typeof raw.show_phase_summary !== "boolean") return bad("show_phase_summary"); out.showPhaseSummary = raw.show_phase_summary; }
      if (Object.keys(out).length === 1) return bad("empty");
      return { ok: true, action: out };
    }
    case "rename_sector": {
      if (!keys(["from", "to"])) return fail("bad_keys", type);
      const from = name(raw.from); const to = name(raw.to);
      if (from === null || to === null) return bad("names");
      return { ok: true, action: { type, from, to } };
    }
    case "remove_sector": {
      if (!keys(["sector"])) return fail("bad_keys", type);
      const s = name(raw.sector); if (s === null) return bad("sector");
      return { ok: true, action: { type, sector: s } };
    }
  }
  return fail("unknown_action", type);
}

export function parseActions(raw: unknown, ctx: ActionCtx): ActionsParse {
  if (raw === undefined) return { ok: true, actions: [] };
  if (!Array.isArray(raw)) return fail("not_object");
  if (raw.length > AGENT_MAX_ACTIONS) return fail("too_many_actions");
  const actions: Action[] = [];
  for (const entry of raw) {
    const r = parseOne(entry, ctx);
    if (!r.ok) return r;
    actions.push(r.action);
  }
  return { ok: true, actions };
}
