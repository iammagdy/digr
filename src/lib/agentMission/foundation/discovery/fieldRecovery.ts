import type { ToolCard } from "../toolCards/types";
import { mapPage } from "../toolCards/mapCode";
import type { WantedField } from "../../requestContract";
import { APPROX_FIELD_NOTE_AR, parseRelativeAge } from "../../relativeDates";
import { toArabicDigits } from "../../../arabicDigits";

/**
 * ROUND 36: THE DELIVERABLE FIELDS A CUSTOMER NAMED («مع النصوص والروابط والتواريخ وعدد المشاهدات»), checked against what the source REALLY returned.
 * Live (msn_30093b19…, a reels search): the request named dates; the plan carried text, link, views and the topic mark, and said nothing about dates or the account. The cause: the catalog lists only the first fields of that tool's item («… 10 more field(s) truncated»),
 * so the card derived from the catalog never mapped a date or an author, and nothing compared the request's fields with the card's.
 * Three honest outcomes per requested field, decided on the REAL first page the planner already read (no extra call, no price change):
 *  - `card`: the card's mapping already fills it on that page;
 *  - `recovered`: the card does not map it, but every item of the real page carries it under a key the provider itself named (a short list of well-known names, each value checked to be of the right kind: a plausible date, a non-empty name); the mapping is extended with that PATH and the report keeps the path (the provenance);
 *  - `unavailable`: neither. The plan says so BEFORE approval, the column stays and its cells say «غير متاح»; no value is ever invented, and no other tool is chosen just to obtain the field.
 * Pure: no I/O.
 */
/** `approximate` (round 38): the source dates its items ONLY by a relative text («2 weeks ago»); the date column is filled with the approximate day computed from it, marked approximate in the file; never exact, never invented. */
/** `partial` (NOV 7 2026): the rows CHOSEN for the file carry the field on some of them only (`of`: how many of how many); the others read «غير متاح». */
export type FieldStatus = "card" | "recovered" | "approximate" | "partial" | "unavailable";
export interface FieldReport { key: WantedField; status: FieldStatus; /** The path inside an item the value was read from (recovered or card), as the provider wrote it. */ path?: string; /** `partial` only: the chosen rows that carry a value, of all the chosen rows. */ of?: { n: number; total: number } }

/** The names a provider uses for the same fact, most specific first. A nested path is allowed (`owner.username`). */
const CANDIDATES: Partial<Record<WantedField, ReadonlyArray<ReadonlyArray<string>>>> = {
  posted_at: [["taken_at_timestamp"], ["taken_at"], ["createdUtc"], ["created_at"], ["createTime"], ["create_time"], ["created_time"], ["timestamp"], ["published_at"], ["publishedAt"], ["date"], ["posted_at"], ["node", "taken_at_timestamp"]],
  author: [["owner", "username"], ["user", "username"], ["username"], ["author", "username"], ["authorUsername"], ["author_username"], ["owner", "full_name"], ["user", "full_name"], ["author"], ["authorName"], ["nickname"]],
};
const MIN_SECONDS = Date.UTC(2010, 0, 1) / 1000;

const at = (o: unknown, path: ReadonlyArray<string>): unknown => { let v = o; for (const k of path) { if (v === null || v === undefined || typeof v !== "object") return undefined; v = (v as Record<string, unknown>)[k]; } return v; };

/** A plausible moment: seconds or milliseconds since 1970 after 2010 and not later than a day from now, or an ISO date string that parses. */
function isDate(v: unknown, nowMs: number): boolean {
  if (typeof v === "number" || (typeof v === "string" && /^\d{9,13}$/.test(v.trim()))) { const n = Number(v); const sec = n > 1e11 ? n / 1000 : n; return Number.isFinite(sec) && sec >= MIN_SECONDS && sec * 1000 <= nowMs + 86_400_000; }
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v.trim()) && Number.isFinite(Date.parse(v));
}
const isName = (v: unknown): boolean => typeof v === "string" && v.trim() !== "" && v.length <= 120;
const KIND: Partial<Record<WantedField, (v: unknown, nowMs: number) => boolean>> = { posted_at: isDate, author: (v) => isName(v) };

/** The items of a real page, at the card's own list path. */
function itemsOf(card: ToolCard, page: unknown): unknown[] {
  const list = at(page, card.page.list);
  return Array.isArray(list) ? list : [];
}

/**
 * ROUND 38: THE SOURCE DATES ITS ITEMS ONLY RELATIVELY. The card maps the relative text («published_time» = «2 weeks ago») and the planner places each item at the moment that text gives; the file then holds an approximate day. The field check used to look for a date KEY only
 * and called such a source «unavailable» (live msn_f6caeacd…: the plan said the dates were unavailable and the file delivered dates). A source is «approximate» only when the mapped relative text is READ by the same reader the file uses on at least 80% of the page's items.
 */
function relativeOnly(card: ToolCard, rows: ReadonlyArray<Record<string, unknown>>, nowMs: number): boolean {
  if (card.mapping.kind !== "fields" || card.mapping.fields.published === undefined || rows.length === 0) return false;
  const readable = rows.filter((r) => parseRelativeAge(r.published, nowMs) !== null).length;
  return readable >= 1 && readable / rows.length >= 0.8;
}

export interface FieldRecovery { card: ToolCard; report: FieldReport[] }

/**
 * `wants` against the real `page` read with `card`. A field already in the card's mapping is `card` when at least one mapped row has a value for it; a field not mapped is looked for under the provider's own names in EVERY item of the page
 * (at least 80% of them, and at least one), and the mapping gains that path only for a card DERIVED from the catalog (a hand-written, verified card is never changed: its gap is said, not patched).
 */
export function recoverFields(card: ToolCard, page: unknown, wants: ReadonlyArray<WantedField> | undefined, nowMs: number = Date.now()): FieldRecovery {
  if (!wants || wants.length === 0 || card.mapping.kind !== "fields") return { card, report: [] };
  const items = itemsOf(card, page).filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null);
  const rows = (() => { try { return mapPage(card, page); } catch { return []; } })();
  const fields: Record<string, ReadonlyArray<string>> = { ...card.mapping.fields };
  const report: FieldReport[] = [];
  let changed = false;
  for (const key of wants) {
    if (key === "views" || key === "likes") {
      // counters are never recovered from a guessed name: they are reported as the card gives them
      const mapped = fields[key] !== undefined && rows.some((r) => r[key] !== null && r[key] !== undefined && r[key] !== "");
      report.push({ key, status: mapped ? "card" : "unavailable", ...(mapped ? { path: fields[key]!.join(".") } : {}) });
      continue;
    }
    if (fields[key] !== undefined && rows.some((r) => r[key] !== null && r[key] !== undefined && r[key] !== "")) { report.push({ key, status: "card", path: fields[key]!.join(".") }); continue; }
    // the ACCOUNT is given by the card's handle column as well as by a display name (NOV 6 2026: an «account» column is never «غير متاح» while the handle is on every row)
    if (key === "author" && fields.username !== undefined && rows.some((r) => r.username !== null && r.username !== undefined && r.username !== "")) { report.push({ key, status: "card", path: fields.username.join(".") }); continue; }
    const ok = KIND[key];
    const found = card.derived && ok && items.length > 0
      ? (CANDIDATES[key] ?? []).find((path) => { const n = items.filter((it) => ok(at(it, path), nowMs)).length; return n >= 1 && n / items.length >= 0.8; })
      : undefined;
    if (found) { fields[key] = found; changed = true; report.push({ key, status: "recovered", path: found.join(".") }); }
    else if (key === "posted_at" && relativeOnly(card, rows, nowMs)) report.push({ key, status: "approximate", path: fields.published!.join(".") });
    else report.push({ key, status: "unavailable" });
  }
  return { card: changed ? { ...card, mapping: { ...card.mapping, fields } } : card, report };
}

/** A cell the source really filled: not nothing, not an empty text, not the «غير متاح» the file writes for a missing value. A real 0 counts. */
const filled = (v: unknown): boolean => v !== null && v !== undefined && !(typeof v === "string" && (v.trim() === "" || v.trim() === "غير متاح"));

/**
 * NOV 7 2026 (Facebook retest msn_365928deea447ca8ae92): THE FIELD CHECK IS JUDGED ON THE ROWS CHOSEN FOR THE FILE, not only on the first page of the first tool. The first keyword search answered empty, the rows were chosen from the second
 * search of the same platform (a test account reads both), and every chosen post carried its page's name; the check had run on the empty page and the card said «طلبت أسماء أصحاب الحسابات، لكن المصدر المختار لا يعيدها».
 * A `card` or `unavailable` report is re-decided on `rows` (the chosen parents, as mapped from their own source): every row has the value: `card`; some: `partial` with the count; none: `unavailable`. `recovered` and `approximate` keep their
 * provenance. The account also counts when the row carries the handle (`username`), as `recoverFields` does. No value is ever written here: only what the rows already hold is counted. Pure.
 */
export function confirmFieldsOnRows(report: ReadonlyArray<FieldReport>, rows: ReadonlyArray<Record<string, unknown>>): FieldReport[] {
  if (rows.length === 0) return [...report];
  return report.map((f) => {
    if (f.status !== "card" && f.status !== "unavailable" && f.status !== "partial") return f;
    const n = rows.filter((r) => filled(r[COLUMN_OF[f.key]]) || (f.key === "author" && filled(r.username))).length;
    const path = f.path !== undefined ? { path: f.path } : {};
    if (n === rows.length) return { key: f.key, status: "card", ...path };
    if (n === 0) return { key: f.key, status: "unavailable" };
    return { key: f.key, status: "partial", ...path, of: { n, total: rows.length } };
  });
}

const NAME_AR: Record<WantedField, string> = { posted_at: "التواريخ", author: "أسماء أصحاب الحسابات", views: "المشاهدات", likes: "الإعجابات" };

/**
 * NOV 6 2026 (Instagram msn_34dcf09434697a62995c: the Reels sheet was «النص، الرابط، المشاهدات، علاقة النص بالموضوع» only): THE STANDARD FIELDS of a platform's parent sheet. They are columns of every such sheet whether or not the
 * customer named them: read from the card, recovered from the real page's own keys (a catalog-derived card), or «غير متاح» on every row with a sentence before approval. Never a value written by us.
 */
export const STANDARD_PARENT_FIELDS: Partial<Record<string, ReadonlyArray<WantedField>>> = { instagram: ["author", "posted_at", "likes"] };
/** The fields a parent sheet must account for: the ones the customer named, then the platform's standard ones. */
export function sheetWantsOf(ask: { platform: string | null; wants?: ReadonlyArray<WantedField> }): WantedField[] {
  const out = [...(ask.wants ?? [])];
  for (const k of (ask.platform ? STANDARD_PARENT_FIELDS[ask.platform] : undefined) ?? []) if (!out.includes(k)) out.push(k);
  return out;
}

/**
 * What the customer reads before approval about the fields of the sheet (Arabic only; no provider, no tool name, no field path). Nothing is said when every field is delivered from the card as it was. `requested`: the fields the
 * customer NAMED (absent: all of the report); a standard field that is missing is said without «طلبت».
 */
export function fieldNotesAr(report: ReadonlyArray<FieldReport>, requested?: ReadonlyArray<WantedField>): string[] {
  const asked = (k: WantedField): boolean => requested === undefined || requested.includes(k);
  const missingStandard = report.filter((r) => r.status === "unavailable" && !asked(r.key)).map((r) => NAME_AR[r.key]);
  const missing = report.filter((r) => r.status === "unavailable" && asked(r.key)).map((r) => NAME_AR[r.key]);
  const approximate = report.some((r) => r.status === "approximate");
  const recovered = report.filter((r) => r.status === "recovered").map((r) => NAME_AR[r.key]);
  const partial = report.filter((r) => r.status === "partial" && r.of !== undefined);
  const out: string[] = [];
  if (recovered.length > 0) out.push(`قرأنا ${recovered.join(" و")} من بيانات المصدر نفسها كما أعادها، ولم نحسبها ولم نخمّنها.`);
  if (approximate) out.push(APPROX_FIELD_NOTE_AR);
  if (missing.length > 0) out.push(`طلبت ${missing.join(" و")}، لكن المصدر المختار لا يعيدها في ما قرأناه: ${missing.length === 1 ? "سيظهر عمودها" : "ستظهر أعمدتها"} في الملف و«غير متاح» في كل صفوفه، ولم نكتب أي قيمة من عندنا. ولم نختر مصدرًا بعيدًا عن طلبك لمجرد الحصول عليها.`);
  for (const r of partial) out.push(`${NAME_AR[r.key]}: أعادها المصدر في ${toArabicDigits(r.of!.n)} من ${toArabicDigits(r.of!.total)} من العناصر المختارة؛ الباقي يظهر «غير متاح» في الملف، ولم نكتب أي قيمة من عندنا.`);
  if (missingStandard.length > 0) out.push(`لا يعيد المصدر المختار ${missingStandard.join(" و")} في ما قرأناه: ${missingStandard.length === 1 ? "سيظهر عمودها" : "ستظهر أعمدتها"} في الملف و«غير متاح» في كل صفوفه، ولم نكتب أي قيمة من عندنا.`);
  return out;
}

/** The row key a wanted field fills. */
export const COLUMN_OF: Record<WantedField, string> = { posted_at: "posted_at", author: "author", views: "views", likes: "likes" };

/** How many of the wanted fields a card (by its catalog-derived or hand-written mapping) is known to supply: what the choice of a source ranks by. */
export const suppliedWants = (card: ToolCard, wants: ReadonlyArray<WantedField> | undefined): number => !wants || card.mapping.kind !== "fields" ? 0 : wants.filter((k) => card.mapping.kind === "fields" && card.mapping.fields[COLUMN_OF[k]] !== undefined).length;
