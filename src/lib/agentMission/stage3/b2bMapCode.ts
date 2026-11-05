import type { B2BCard } from "./b2bCards";

/**
 * STAGE 3, PART A: THE MAPPING CODE OF A B2B LIST CARD, written by code from the card (the same idea as `cardMapCode` of the social cards). It is the body of a function over `inputs` (the one saved
 * page), run by the engine in its sandbox, and it gives EXACTLY the rows `readB2BRows` gives for that page (tests/stage3-b2b-plan.test.ts checks it on every stored companies page): each field read
 * at the card's own path (or the card's joined paths), a missing or empty value left out, the id as text. A field the card does not map (tomba's boolean `phone_number`) is never read.
 * Null for a card whose reader is not a list (a lookup's one answer is read by the contact steps, never by a stage). Pure.
 */
export function b2bMapCode(card: B2BCard): string | null {
  if (card.reader.kind !== "list" || !card.page.list) return null;
  return `const P = Object.values(inputs)[0];
const LIST = ${JSON.stringify(card.page.list)};
const F = ${JSON.stringify(card.reader.fields)};
const at = (o, path) => { let v = o; for (const k of path) { if (v === null || v === undefined || typeof v !== 'object') return undefined; v = v[k]; } return v; };
const valueOf = (item, spec) => { if (Array.isArray(spec)) return at(item, spec); const parts = spec.join.map((p) => at(item, p)).filter((v) => typeof v === 'string' && v.trim() !== '').map((v) => String(v).trim()); return parts.length > 0 ? parts.join(' ') : undefined; };
const idText = (v) => (typeof v === 'string' ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : '');
const list = at(P, LIST);
if (!Array.isArray(list)) return [];
return list.map((item) => { const row = {}; for (const k of Object.keys(F)) { const v = valueOf(item, F[k]); if (v !== undefined && v !== null && v !== '') row[k] = v; } row.id = idText(row.id); return row; });`;
}
