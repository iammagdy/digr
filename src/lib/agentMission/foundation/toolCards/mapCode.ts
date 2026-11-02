import { buildReplyMapCode, replyColumnKeysOf } from "../../replies";
import type { ToolCard } from "./types";

/** The Arabic name of the countries a row may carry as a code (the file is read by the customer: Arabic only). Any other code stays as it is. */
export const COUNTRY_AR: Readonly<Record<string, string>> = {
  EG: "مصر", SA: "السعودية", AE: "الإمارات", KW: "الكويت", QA: "قطر", BH: "البحرين", OM: "عمان", JO: "الأردن", LB: "لبنان", IQ: "العراق", SY: "سوريا", LY: "ليبيا",
  TN: "تونس", DZ: "الجزائر", MA: "المغرب", SD: "السودان", PS: "فلسطين", YE: "اليمن",
};

/** The columns of a comments or replies stage (their keys are what the code-built replies mapping fills). */
export const CHILD_COLUMNS = [
  { key: "text", title_ar: "نص التعليق" },
  { key: "author", title_ar: "صاحب التعليق" },
  { key: "posted_at", title_ar: "تاريخ ووقت التعليق" },
  { key: "likes", title_ar: "الإعجابات" },
  { key: "replies_count", title_ar: "عدد الردود" },
] as const;

/**
 * THE MAPPING CODE OF A CARD: the body of a function over `inputs` (the page is its first value), as the engine runs it in the sandbox. Generated from the card's data only:
 * a parent card maps its fields; a comments or replies card uses the code-built replies mapping (`buildReplyMapCode`, already proven on every provider's comment shape).
 * An item with no id is not a row.
 */
export function cardMapCode(card: ToolCard): string {
  if (card.mapping.kind === "replies") return buildReplyMapCode(replyColumnKeysOf(CHILD_COLUMNS)).replace("const P = inputs.page;", "const P = Object.values(inputs)[0];");
  return `const P = Object.values(inputs)[0];
const LIST = ${JSON.stringify(card.page.list)};
const ITEM = ${JSON.stringify(card.page.item ?? [])};
const F = ${JSON.stringify(card.mapping.fields)};
const AR = ${JSON.stringify(COUNTRY_AR)};
const at = (o, path) => { let v = o; for (const k of path) { if (v === null || v === undefined || typeof v !== 'object') return undefined; v = v[k]; } return v; };
const iso = (v) => { if (v === null || v === undefined || v === '') return null; if (typeof v === 'number' || /^\\d{9,13}$/.test(String(v))) { const n = Number(v); const d = new Date(n < 1e12 ? n * 1000 : n); return Number.isNaN(d.getTime()) ? null : d.toISOString(); } const d = new Date(String(v)); return Number.isNaN(d.getTime()) ? String(v) : d.toISOString(); };
const list = at(P, LIST);
if (!Array.isArray(list)) return [];
return list.map((w) => {
  const it = ITEM.length > 0 ? at(w, ITEM) : w;
  if (!it || typeof it !== 'object') return null;
  const out = {};
  for (const k of Object.keys(F)) {
    let v = at(it, F[k]);
    if (v === undefined) v = null;
    if (k === 'posted_at') v = iso(v);
    else if (k === 'link' && typeof v === 'string') v = v.split('?')[0];
    else if (k === 'country' && typeof v === 'string' && v !== '') v = AR[v.toUpperCase()] || v;
    out[k] = v;
  }
  if (out.id === null || out.id === undefined || out.id === '') return null;
  out.id = String(out.id);
  return out;
}).filter((r) => r !== null);`;
}

/** The rows a card's mapping gives for one page, run here the way the sandbox runs it (pure: the code reads only its input). */
export function mapPage(card: ToolCard, page: unknown): Array<Record<string, unknown>> {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn = new Function("inputs", cardMapCode(card)) as (inputs: Record<string, unknown>) => unknown;
  const out = fn({ page });
  return Array.isArray(out) ? (out.filter((r) => r && typeof r === "object") as Array<Record<string, unknown>>) : [];
}
