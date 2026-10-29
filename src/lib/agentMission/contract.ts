import { filterFieldsRequired, INVISIBLE, isEnabled, type StageFilter } from "./filters";
import { itemNounOf } from "./itemNoun";
import { normalizeText, stripLinksAndMentions } from "./relevance";

/**
 * THE CONTRACT BETWEEN A PLAN AND THE ENGINE (the model plans, code executes). What the engine and the file need from the mapped items of a stage is checked BY CODE at plan time, on the very page the mapping was measured on, before a plan
 * can be approved: every item has an id the store can key it by (or a key code derives it from), every column the card promises is a field the mapping gives, and every field a promised filter reads is there too. A plan whose mapping breaks the
 * contract is refused with the exact issue, so the customer never approves what the engine cannot carry out. Pure: no I/O.
 */
export type MappedRow = Record<string, unknown>;

/** The fields the collection tools and the id derivation read a provider's own row key from, in this order. */
export const ROW_KEY_FIELDS = ["id", "post_id", "comment_id", "review_id", "place_id", "shortcode", "video_id", "personID", "url"] as const;
/** More names the mapped items of a stage use for the same thing: a link or a platform id is as stable as «id». */
export const ID_KEY_FIELDS: ReadonlyArray<string> = [...ROW_KEY_FIELDS, "tweet_id", "status_id", "uid", "link", "permalink", "post_url", "profile_url", "website", "domain"];
/** The id of an item derived from its FINGERPRINT (every stable text field), the last resort: the same item read twice gets the same id, so it is never counted twice. */
export const CONTENT_ID_FIELD = "$content";

const filled = (v: unknown): v is string | number => (typeof v === "string" && v.trim() !== "") || (typeof v === "number" && Number.isFinite(v));

/** A short stable hash (53 bits, base 36) of a text: no I/O, the same in the worker and in a test. */
function hash53(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** The fingerprint of an item: its text and boolean fields in key order (numbers are left out: a like count changes between two reads of the same item). */
export function contentFingerprint(row: MappedRow): string {
  const parts = Object.keys(row).filter((k) => k !== "id" && k !== "parent_id").sort().map((k) => (typeof row[k] === "string" || typeof row[k] === "boolean" ? `${k}=${String(row[k]).trim()}` : "")).filter(Boolean);
  return `c_${hash53(parts.join("\u0001"))}`;
}

/**
 * The id of one mapped item: its own `id`; else the field the stage's recipe chose (`idField`); else the first of the known key fields it has; else its fingerprint. An item always has an id (never rejected for lacking one),
 * and the same item read twice gets the same id.
 */
export function deriveItemId(row: MappedRow, idField: string | null = null): string {
  if (filled(row.id)) return String(row.id).trim();
  if (idField && idField !== CONTENT_ID_FIELD && filled(row[idField])) return String(row[idField]).trim();
  if (!idField || idField !== CONTENT_ID_FIELD) for (const k of ID_KEY_FIELDS) if (k !== "id" && filled(row[k])) return String(row[k]).trim();
  return contentFingerprint(row);
}

/** Which field of the mapped items keys them: «id» when every item has one; else the first key field every item has and that is (almost) unique; else the fingerprint. */
export function chooseIdField(rows: ReadonlyArray<MappedRow>): { field: string; basis: "id" | "key" | "content" } {
  if (rows.length > 0 && rows.every((r) => filled(r.id))) return { field: "id", basis: "id" };
  for (const k of ID_KEY_FIELDS) {
    if (k === "id") continue;
    if (!rows.every((r) => filled(r[k]))) continue;
    const unique = new Set(rows.map((r) => String(r[k]).trim())).size;
    if (unique === rows.length || unique >= Math.ceil(rows.length * 0.9)) return { field: k, basis: "key" };
  }
  return { field: CONTENT_ID_FIELD, basis: "content" };
}

/** The mapped item with its id set (and nothing else changed). */
export function withDerivedId(row: MappedRow, idField: string | null): MappedRow {
  return filled(row.id) ? row : { ...row, id: deriveItemId(row, idField) };
}

export interface ProofInput {
  rows: ReadonlyArray<MappedRow>;
  /** The keys of the columns the card promises for the stage. */
  columnKeys: ReadonlyArray<string>;
  /** The relevance rule's text columns. */
  textColumns?: ReadonlyArray<string>;
  filters?: ReadonlyArray<StageFilter>;
  label: string;
}
export interface ProofResult { idField: string; idBasis: "id" | "key" | "content"; mappedKeys: string[]; issues: string[] }

/** The contract check of one stage's mapped items (the measured page, run through the recipe's mapping). */
export function proveMappedRows(input: ProofInput): ProofResult {
  const issues: string[] = [];
  const keys = new Set<string>();
  for (const r of input.rows) for (const k of Object.keys(r)) keys.add(k);
  const mappedKeys = [...keys];
  if (input.rows.length === 0) issues.push(`${input.label}: the mapping gave no item for the measured page`);
  const id = chooseIdField(input.rows);
  // every column the card promises must be a field the mapping gives (an «id» or «parent_id» column is added by code and never promised)
  for (const c of input.columnKeys) if (c !== "id" && c !== "parent_id" && !keys.has(c)) issues.push(`${input.label}: the card promises the column «${c}» but the mapping gives no such field; map it in your run_code (every row of the page) or remove the column`);
  for (const t of input.textColumns ?? []) if (!keys.has(t)) issues.push(`${input.label}: the relevance rule reads «${t}» but the mapping gives no such field`);
  for (const f of filterFieldsRequired(input.filters)) if (!keys.has(f)) issues.push(`${input.label}: a filter on the card reads the field «${f}» but the mapping gives no such field; map it in your run_code or remove the filter`);
  return { idField: id.field, idBasis: id.basis, mappedKeys, issues };
}

/** The mapped keys of the filters' text field for the checks that read the text («@» for a reply, the language): the first text column of the relevance rule, else the one the plan's columns name. */
export function textKeyOf(stage: { relevance?: { text_columns: string[] }; columns: ReadonlyArray<{ key: string }>; filters?: ReadonlyArray<StageFilter> }, mappedKeys: ReadonlyArray<string> = []): string | null {
  const t = stage.relevance?.text_columns?.[0];
  if (t) return t;
  const keys = [...stage.columns.map((c) => c.key), ...mappedKeys];
  return keys.find((k) => /(^|_)(text|content|body|message|comment|caption|description)$/i.test(k)) ?? null;
}

// ------------------------------------------------------------------------------------------------- the same text twice

/** The kinds of item whose TEXT is the item: a post, a tweet, a comment, a reply, a review, a message. Two of them with the same normalized text are one item. */
const TEXT_ITEM_NOUNS = new Set(["تغريده", "منشور", "تعليق", "رد", "مراجعه", "تقييم", "رساله"].map((n) => normalizeText(n)));
const MIN_DEDUPE_CHARS = 12;

/** True when a stage's items are posts or comments (judged from the noun of the stage title, the same noun the card uses). */
export const isTextItemStage = (stage: { title_ar: string }): boolean => TEXT_ITEM_NOUNS.has(itemNounOf(stage.title_ar).key);

/** Words that open a post to say what KIND of post it is («عاجل», «بالفيديو», «الآن»): the same news is often posted again with another one in front. Written as the normalized text has them. */
const LEADING_MARKERS = /^(?:(?:خبر\s+)?عاجل|الان|بالفيديو|بالصور|بالفيديو\s+والصور|شاهد|فيديو|صور|تحديث|متابعه|رسميا|حصري|حصريا|قبل\s+قليل|breaking(?:\s+news)?|urgent|update|just\s+in|rt)(?![\p{L}\p{N}])\s*/u;
/** An emoji, a keycap digit («1️⃣»), a symbol: shown, never said. */
const PICTOGRAPH = /[0-9#*]\ufe0f?\u20e3|[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\p{S}]/gu;

/**
 * The key two items with the same text share: the text without links, mentions, hashtags, emoji, invisible characters, punctuation and diacritics, and without the markers that open a repeated post («عاجل», «بالفيديو»), in one comparable
 * form. Two posts that differ only in such decoration are ONE item. A text shorter than twelve letters (a reaction: «شكرًا», «👍») has no key: short answers that happen to be the same are different people's answers, not a repeated item.
 */
export function textDedupeKey(text: unknown): string | null {
  let t = normalizeText(stripLinksAndMentions(String(text ?? "").replace(INVISIBLE, "")))
    .replace(/(^|\s)#[^\s#]*/gu, " ")
    .replace(PICTOGRAPH, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  // markers in front come off, one after the other («🔴 عاجل | بالفيديو …»)
  for (let n = 0; n < 4; n += 1) { const next = t.replace(LEADING_MARKERS, ""); if (next === t) break; t = next; }
  return [...t].length >= MIN_DEDUPE_CHARS ? t : null;
}

/** The scope a text is unique in: a stage's items, and for a child stage (comments) the items of the same parent. */
export const dedupeScope = (parentId: string | null | undefined): string => (parentId ? `p:${parentId}` : "root");

export { isEnabled };
