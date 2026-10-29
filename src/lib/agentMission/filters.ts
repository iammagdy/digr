import { toArabicDigits } from "../arabicDigits";
import { parseMoment } from "./dateCells";
import { isPlaceEvidenceKey, placeVerdict } from "./places";
import { normalizeText } from "./relevance";

/**
 * EVERY PROMISE OF THE PLAN CARD IS A CHECK IN CODE. The card says «دون الردود»، «باللغة العربية فقط»، «آخر ٣٠ يومًا»، «من حسابات محددة»، «في القاهرة»: each of those is a typed FILTER on the stage that code applies to every mapped item BEFORE it is saved
 * (an item the filter rejects is neither delivered nor charged, and is kept with its reason for the admin). The card's sentence is BUILT from the filter by code (`filterLineAr`), so the card can never promise what no code enforces. A free sentence of the
 * model that promises one of these without a filter is refused at plan time (`promiseIssues`). The customer may switch a filter on or off, and change its period or language, before approving (planEdit.ts). Pure: no I/O.
 */
export type FilterKind = "exclude_replies" | "exclude_reposts" | "language" | "period" | "account" | "place";
export const FILTER_KINDS: ReadonlyArray<FilterKind> = ["exclude_replies", "exclude_reposts", "language", "period", "account", "place"];

export interface StageFilter {
  kind: FilterKind;
  /** Default true. A filter that is off is neither applied nor promised (it stays in the plan so the customer can switch it on). */
  enabled?: boolean;
  /** The MAPPED field the check reads (a key of the mapped item, not necessarily a column of the file): the reply flag, the date, the username, the place, the language code. Filled by code from the mapping. */
  field?: string;
  /** language: «ar» or «en». */
  lang?: "ar" | "en";
  /** period: the last N days counted from the moment the item is checked. */
  days?: number;
  /** period: an explicit range (ISO dates). */
  from?: string;
  to?: string;
  /** account: the usernames; place: the place words (one of them must appear in the field). */
  values?: string[];
  /** place: the countries and cities (places.ts keys) the words name, filled by code. With them the check reads EVIDENCE of the place from every mapped field in `fields` (country, city, address, website domain, phone prefix). */
  places?: string[];
  /** place: the mapped fields that can carry evidence of a place, found by code from the mapping. */
  fields?: string[];
}

export type FilterReason = "filter_reply" | "filter_repost" | "filter_language" | "filter_period" | "filter_account" | "filter_place";
export const FILTER_REASONS: ReadonlyArray<FilterReason> = ["filter_reply", "filter_repost", "filter_language", "filter_period", "filter_account", "filter_place"];
export const REASON_OF_KIND: Record<FilterKind, FilterReason> = { exclude_replies: "filter_reply", exclude_reposts: "filter_repost", language: "filter_language", period: "filter_period", account: "filter_account", place: "filter_place" };
export const FILTER_REASON_LABEL_AR: Record<FilterReason, string> = {
  filter_reply: "استبعاد: رد", filter_repost: "استبعاد: إعادة نشر", filter_language: "استبعاد: لغة أخرى", filter_period: "استبعاد: خارج الفترة", filter_account: "استبعاد: حساب آخر", filter_place: "استبعاد: مكان آخر",
};

export const isEnabled = (f: StageFilter): boolean => f.enabled !== false;

/** The filters that never apply to the items of a CHILD stage (comments, replies, reviews, employees): they are delivered as the source gives them, in its order. The language and the place are rules for choosing the parents and the top-level items. */
export const CHILD_RAW_FILTER_KINDS: ReadonlyArray<FilterKind> = ["language", "place"];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const MAX_VALUES = 20;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The filters a plan stage declares, cleaned and checked (kinds, parameters). The issues name exactly what to fix. */
export function parseFilters(input: unknown, label: string): { filters: StageFilter[]; issues: string[] } {
  const issues: string[] = [];
  const filters: StageFilter[] = [];
  if (input === undefined || input === null) return { filters, issues };
  if (!Array.isArray(input) || input.length > FILTER_KINDS.length) return { filters, issues: [`${label}: filters must be a list of at most ${FILTER_KINDS.length} filters`] };
  const seen = new Set<string>();
  for (const raw of input) {
    if (!isRecord(raw) || !FILTER_KINDS.includes(raw.kind as FilterKind)) { issues.push(`${label}: a filter needs kind: ${FILTER_KINDS.join(", ")}`); continue; }
    const kind = raw.kind as FilterKind;
    if (seen.has(kind)) { issues.push(`${label}: filter «${kind}» is given twice`); continue; }
    seen.add(kind);
    const f: StageFilter = { kind, ...(raw.enabled === false ? { enabled: false } : {}) };
    if (typeof raw.field === "string" && /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(raw.field)) f.field = raw.field;
    if (kind === "language") {
      if (raw.lang !== "ar" && raw.lang !== "en") { issues.push(`${label}: filter «language» needs lang "ar" or "en"`); continue; }
      f.lang = raw.lang;
    }
    if (kind === "period") {
      const days = Number(raw.days);
      const hasDays = raw.days !== undefined && raw.days !== null;
      const hasRange = typeof raw.from === "string" || typeof raw.to === "string";
      if (hasDays) {
        if (!Number.isInteger(days) || days < 1 || days > 3650) { issues.push(`${label}: filter «period» days must be a whole number from 1 to 3650`); continue; }
        f.days = days;
      } else if (hasRange) {
        if ((raw.from !== undefined && !(typeof raw.from === "string" && ISO_DAY.test(raw.from))) || (raw.to !== undefined && !(typeof raw.to === "string" && ISO_DAY.test(raw.to)))) { issues.push(`${label}: filter «period» from/to are dates written YYYY-MM-DD`); continue; }
        if (typeof raw.from === "string") f.from = raw.from;
        if (typeof raw.to === "string") f.to = raw.to;
        if (f.from && f.to && f.from > f.to) { issues.push(`${label}: filter «period» starts after it ends`); continue; }
      } else { issues.push(`${label}: filter «period» needs days, or from and/or to`); continue; }
    }
    if (kind === "place" && Array.isArray(raw.places)) f.places = raw.places.map(String).filter((k) => /^[A-Z]{2}(?::[a-z]+)?$/.test(k)).slice(0, 20);
    if (kind === "place" && Array.isArray(raw.fields)) f.fields = raw.fields.map(String).filter((k) => /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(k)).slice(0, 12);
    if (kind === "account" || kind === "place") {
      const values = Array.isArray(raw.values) ? raw.values.map((v) => String(v ?? "").trim()).filter(Boolean) : [];
      if (values.length < 1 || values.length > MAX_VALUES) { issues.push(`${label}: filter «${kind}» needs values (1 to ${MAX_VALUES})`); continue; }
      f.values = values;
    }
    filters.push(f);
  }
  return { filters, issues };
}

// ------------------------------------------------------------------------------------------------------------ the checks

/** A flag the source gives in many shapes: nothing, false, «لا», «no», 0 are «not»; anything else filled is «yes» (a reply's parent id is a «yes» too). */
export function flagIsSet(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0 && Number.isFinite(value);
  const t = normalizeText(String(value));
  if (!t) return false;
  return !["false", "no", "0", "null", "none", "undefined", "لا", "ليس", "كلا", "-", "—"].includes(t);
}

const ARABIC_LETTER = /[؀-ۿݐ-ݿ]/g;
const LATIN_LETTER = /[A-Za-z]/g;
const stripNoise = (s: string): string => s.replace(/https?:\/\/\S+|www\.\S+/gi, " ").replace(/[@#]\S+/g, " ");

/** The script of a text: the share of Arabic letters among the letters it writes (links, mentions and hashtags are not words). Null when it has too few letters to say. */
export function arabicShare(text: string): number | null {
  const t = stripNoise(text);
  const ar = (t.match(ARABIC_LETTER) ?? []).length;
  const la = (t.match(LATIN_LETTER) ?? []).length;
  return ar + la < 3 ? null : ar / (ar + la);
}

const langCodeOf = (v: unknown): "ar" | "en" | null => {
  const t = normalizeText(String(v ?? ""));
  if (!t) return null;
  if (t === "ar" || t.startsWith("ar-") || t === "arabic" || t === "عربي" || t === "عربيه") return "ar";
  if (t === "en" || t.startsWith("en-") || t === "english" || t === "انجليزي" || t === "انجليزيه") return "en";
  return null;
};

export interface FilterContext {
  /** The mapped column that holds the text (language, the «@» reply mark, the «RT» mark read it). */
  textKey: string | null;
  /** «Now» for a period counted in days. */
  now: number;
}

/** Characters that show nothing: zero-width and direction marks, the byte-order mark, the non-breaking space. A text that «starts with» a handle may have any of them in front of it. */
export const INVISIBLE = /[\u00a0\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0]/g;
/** True when a text starts with an @handle (after whitespace and invisible characters): on X and the platforms that copy it, that is how a reply is written, whatever the source's own flag says. */
export const startsWithHandle = (text: unknown): boolean => /^@[\p{L}\p{N}_.]{1,30}/u.test(String(text ?? "").replace(INVISIBLE, "").replace(/^\s+/, ""));

const normName = (s: string): string => normalizeText(s).replace(/^@/, "");

/** The FIRST enabled filter that rejects a mapped item, as its reason; null when the item passes every enabled filter. */
export function filterVerdict(filters: ReadonlyArray<StageFilter> | undefined, mapped: Record<string, unknown>, ctx: FilterContext): FilterReason | null {
  if (!filters || filters.length === 0) return null;
  const text = ctx.textKey ? String(mapped[ctx.textKey] ?? "") : "";
  for (const f of filters) {
    if (!isEnabled(f)) continue;
    switch (f.kind) {
      case "exclude_replies": {
        // the source's flag AND the text itself: a reply the source did not flag (a thread, a mention in front) still starts with the handle it answers
        const isReply = (f.field ? flagIsSet(mapped[f.field]) : false) || startsWithHandle(text);
        if (isReply) return "filter_reply";
        break;
      }
      case "exclude_reposts": {
        const isRepost = f.field ? flagIsSet(mapped[f.field]) : /^\s*RT\s+@/.test(text);
        if (isRepost) return "filter_repost";
        break;
      }
      case "language": {
        const fromField = f.field ? langCodeOf(mapped[f.field]) : null;
        if (fromField) { if (fromField !== f.lang) return "filter_language"; break; }
        const share = arabicShare(text);
        // a text with no letters of its own (only a link, a mention, an emoji) has no language to reject
        if (share === null) break;
        if (f.lang === "ar" ? share < 0.5 : share > 0.5) return "filter_language";
        break;
      }
      case "period": {
        const moment = f.field ? parseMoment(mapped[f.field]) : null;
        if (!moment) return "filter_period";
        const t = moment.getTime();
        const from = f.days !== undefined ? ctx.now - f.days * 86_400_000 : f.from ? Date.parse(`${f.from}T00:00:00Z`) : Number.NEGATIVE_INFINITY;
        const to = f.days !== undefined ? Number.POSITIVE_INFINITY : f.to ? Date.parse(`${f.to}T23:59:59Z`) : Number.POSITIVE_INFINITY;
        if (t < from || t > to) return "filter_period";
        break;
      }
      case "account": {
        const who = f.field ? normName(String(mapped[f.field] ?? "")) : "";
        if (!who || !(f.values ?? []).some((v) => normName(v) === who)) return "filter_account";
        break;
      }
      case "place": {
        // WITH named places: the item must carry evidence of one of them from a mapped field; another country or no evidence is not delivered
        if (f.places && f.places.length > 0) {
          if (placeVerdict(f.places, mapped, f.fields && f.fields.length > 0 ? f.fields : f.field ? [f.field] : []) !== "pass") return "filter_place";
          break;
        }
        const where = f.field ? normalizeText(String(mapped[f.field] ?? "")) : "";
        if (!where || !(f.values ?? []).some((v) => where.includes(normalizeText(v)))) return "filter_place";
        break;
      }
    }
  }
  return null;
}

// ------------------------------------------------------------------------------------------------- finding the fields

const TEXT_KEY = /(^|_)(text|content|body|message|comment|caption|description|full_text|fulltext)$/i;
const DATE_KEY = /(^|_)(date|time|datetime|timestamp|created|createdat|created_at|created_utc|createdutc|createtime|create_time|published|published_at|posted|posted_at|publish_time)$/i;
const ACCOUNT_KEY = /(^|_)(username|user_name|screen_name|handle|author_username|authorusername|account|author_handle)$/i;
const PLACE_KEY = /(^|_)(place|location|city|country|address|region|governorate)$/i;
const REPLY_FLAG_KEY = /^(is_?reply|isreply|is_comment_reply|in_?reply_?to\w*|reply_?to\w*|replying_?to\w*|parent_comment\w*)$/i;
const REPOST_FLAG_KEY = /^(is_?(re)?(post|tweet|share)|is_?retweet|retweeted_status\w*|is_?repost|reshare\w*)$/i;
const LANG_KEY = /^(lang|language|lang_code|language_code)$/i;

const pick = (keys: ReadonlyArray<string>, re: RegExp): string | null => keys.find((k) => re.test(k)) ?? null;

export interface FilterFields { text: string | null; date: string | null; account: string | null; place: string | null; /** Every mapped field that can carry evidence of a place: a location text, a website, a phone. */ placeFields: string[]; replyFlag: string | null; repostFlag: string | null; lang: string | null }

/**
 * The mapped fields the checks can read, found by CODE from what the mapping really gives (the keys of the mapped items, the stage's columns, the relevance rule's text columns). Never the model's guess.
 * `mappedKeys` is the union of the keys of the items of the measured page (the proof's rows); with none, the columns' keys stand in.
 */
export function findFilterFields(input: { mappedKeys: ReadonlyArray<string>; columnKeys: ReadonlyArray<string>; textColumns?: ReadonlyArray<string>; columnTitles?: Readonly<Record<string, string>> }): FilterFields {
  const keys = [...new Set([...input.mappedKeys, ...input.columnKeys])];
  const titleOf = (k: string) => input.columnTitles?.[k] ?? "";
  const byTitle = (re: RegExp): string | null => keys.find((k) => re.test(titleOf(k))) ?? null;
  return {
    text: input.textColumns?.find((k) => keys.includes(k)) ?? pick(keys, TEXT_KEY),
    date: pick(keys, DATE_KEY) ?? byTitle(/تاريخ|وقت النشر|وقت التغريد/),
    account: pick(keys, ACCOUNT_KEY) ?? byTitle(/اسم المستخدم/),
    place: pick(keys, PLACE_KEY) ?? byTitle(/مكان|موقع|مدينة|دولة|عنوان/),
    placeFields: [...new Set([...keys.filter((k) => isPlaceEvidenceKey(k)), ...keys.filter((k) => /مكان|موقع|مدينة|دولة|عنوان|بلد/.test(titleOf(k)))])],
    replyFlag: pick(keys, REPLY_FLAG_KEY) ?? byTitle(/هل هي رد|هل هو رد/),
    repostFlag: pick(keys, REPOST_FLAG_KEY),
    lang: pick(keys, LANG_KEY),
  };
}

/**
 * Fills the `field` of each declared filter from what the mapping gives, adds (switched OFF) every filter the mapping could support but the plan did not ask for, so the customer can switch it on in the editor, and
 * returns the issues for a filter that cannot be enforced (no field to read): such a filter is refused, so the card never promises it.
 */
export function resolveFilters(declared: ReadonlyArray<StageFilter>, fields: FilterFields, label: string): { filters: StageFilter[]; issues: string[] } {
  const issues: string[] = [];
  const out: StageFilter[] = [];
  for (const f of declared) {
    const g: StageFilter = { ...f };
    let problem: string | null = null;
    switch (f.kind) {
      case "exclude_replies":
        g.field = f.field ?? fields.replyFlag ?? undefined;
        if (!g.field && !fields.text) problem = `${label}: «exclude replies» needs a mapped field that says an item is a reply (for example is_reply) or the text column (a reply starts with «@»); the mapping gives neither`;
        break;
      case "exclude_reposts":
        g.field = f.field ?? fields.repostFlag ?? undefined;
        if (!g.field && !fields.text) problem = `${label}: «exclude reposts» needs a mapped repost flag or the text column; the mapping gives neither`;
        break;
      case "language":
        g.field = f.field ?? fields.lang ?? undefined;
        if (!g.field && !fields.text) problem = `${label}: a language filter needs the text column or a mapped language field; the mapping gives neither`;
        break;
      case "period":
        g.field = f.field ?? fields.date ?? undefined;
        if (!g.field) problem = `${label}: a period filter needs a mapped date field (a column about the date of the item); the mapping gives none`;
        break;
      case "account":
        g.field = f.field ?? fields.account ?? undefined;
        if (!g.field) problem = `${label}: an account filter needs a mapped username field; the mapping gives none`;
        break;
      case "place":
        g.field = f.field ?? fields.place ?? fields.placeFields[0] ?? undefined;
        if (f.places && f.places.length > 0) g.fields = [...new Set([...(g.field ? [g.field] : []), ...fields.placeFields])];
        if (!g.field) problem = `${label}: a place filter needs a mapped place field (city, country, address ...); the mapping gives none`;
        break;
    }
    if (g.field === undefined) delete g.field;
    if (g.fields !== undefined && g.fields.length === 0) delete g.fields;
    // a filter that is switched on and cannot be enforced is refused (the card would promise it); one that is off and cannot be enforced simply is not offered
    if (problem) { if (isEnabled(f)) issues.push(problem); continue; }
    out.push(g);
  }
  const has = (k: FilterKind) => out.some((f) => f.kind === k) || declared.some((f) => f.kind === k);
  // available to the customer, switched off
  if (!has("exclude_replies") && (fields.replyFlag || fields.text)) out.push({ kind: "exclude_replies", enabled: false, ...(fields.replyFlag ? { field: fields.replyFlag } : {}) });
  if (!has("exclude_reposts") && (fields.repostFlag || fields.text)) out.push({ kind: "exclude_reposts", enabled: false, ...(fields.repostFlag ? { field: fields.repostFlag } : {}) });
  if (!has("language") && (fields.lang || fields.text)) out.push({ kind: "language", enabled: false, lang: "ar", ...(fields.lang ? { field: fields.lang } : {}) });
  if (!has("period") && fields.date) out.push({ kind: "period", enabled: false, days: 30, field: fields.date });
  return { filters: out, issues };
}

/**
 * The same, against the keys the PROOF found (the mapped items of the measured page): a field a filter reads that the mapping does not give is dropped and found again from what it does give (the sample rows the model wrote may have
 * had fewer keys than the mapping).
 */
export function refitFilters(filters: ReadonlyArray<StageFilter>, fields: FilterFields, mappedKeys: ReadonlyArray<string>, label: string): { filters: StageFilter[]; issues: string[] } {
  const keys = new Set(mappedKeys);
  const cleared = filters.map((f) => { const g: StageFilter = { ...f }; if (g.field !== undefined && !keys.has(g.field)) delete g.field; if (g.fields !== undefined) { g.fields = g.fields.filter((k) => keys.has(k)); if (g.fields.length === 0) delete g.fields; } return g; });
  return resolveFilters(cleared, fields, label);
}

/** Every field a filter of the stage reads (the proof requires each to be a key the mapping really gives). */
export function filterFieldsRequired(filters: ReadonlyArray<StageFilter> | undefined): string[] {
  return [...new Set((filters ?? []).filter(isEnabled).flatMap((f) => [f.field, ...(f.fields ?? [])]).filter((x): x is string => typeof x === "string"))];
}

// ------------------------------------------------------------------------------------------------- the customer's sentence

const daysAr = (n: number): string => (n === 1 ? "آخر يوم" : n === 2 ? "آخر يومين" : n <= 10 ? `آخر ${toArabicDigits(n)} أيام` : `آخر ${toArabicDigits(n)} يومًا`);

/** The sentence the card shows for an ENABLED filter, built from it by code. */
export function filterLineAr(f: StageFilter): string {
  switch (f.kind) {
    case "exclude_replies": return "دون الردود.";
    case "exclude_reposts": return "دون إعادة النشر.";
    case "language": return f.lang === "en" ? "باللغة الإنجليزية فقط." : "باللغة العربية فقط.";
    case "period": return f.days !== undefined ? `${daysAr(f.days)}.` : `من ${f.from ? toArabicDigits(f.from) : "البداية"} إلى ${f.to ? toArabicDigits(f.to) : "اليوم"}.`;
    case "account": return `من ${(f.values ?? []).length === 1 ? "حساب محدد" : "حسابات محددة"} فقط.`;
    case "place": return `في: ${(f.values ?? []).join("، ")}.`;
  }
}

/** The label of a filter in the editor (what a switch is called). */
export function filterLabelAr(f: StageFilter): string {
  switch (f.kind) {
    case "exclude_replies": return "استبعاد الردود";
    case "exclude_reposts": return "استبعاد إعادة النشر";
    case "language": return "اللغة";
    case "period": return "الفترة الزمنية";
    case "account": return "حسابات محددة";
    case "place": return "المكان";
  }
}

// ------------------------------------------------------------------------------------------------- no promise without a check

interface PromiseRule { kind: FilterKind | "relevance"; test: RegExp; what: string }
const PROMISE_RULES: ReadonlyArray<PromiseRule> = [
  { kind: "exclude_replies", what: "replies", test: /(?:دون|بدون|بلا|استبعاد|تستبعد|يستبعد|عدا|ما\s?عدا|غير|لا\s(?:تشمل|يشمل|تتضمن))\s+(?:ال)?ردود|(?:^|\s)أصلية(?:\s|$|،|\.)|الأصلية|الاصلية/ },
  { kind: "exclude_reposts", what: "reposts", test: /إعادة\s(?:ال)?(?:تغريد|نشر)|اعادة\s(?:ال)?(?:تغريد|نشر)|ريتويت|دون\s(?:ال)?مشاركات/ },
  { kind: "language", what: "language", test: /عربي(?:ة|ا|ًا)?(?![\u0621-\u064A])|بالعربية|باللغة|إنجليزي|انجليزي|الإنجليزية|الانجليزية/ },
  { kind: "period", what: "period", test: /آخر\s+\S+\s+(?:يوم|أيام|يومًا|يوما|أسبوع|أسابيع|شهر|أشهر|شهور|سنة|سنوات|ساعة|ساعات)|خلال\s+(?:ال)?(?:أسبوع|شهر|عام|سنة|يوم)|منذ\s|من\s+تاريخ|بين\s+تاريخ|(?:في|خلال)\s+(?:عام|سنة)\s+[0-9٠-٩]/ },
  { kind: "account", what: "account", test: /من\s+(?:الحساب|حساب|حسابات)\s|حسابات\s+محددة/ },
  { kind: "place", what: "place", test: /(?:داخل|ضمن)\s+(?:دولة|مدينة|محافظة|منطقة)|في\s+(?:مدينة|دولة|محافظة)\s/ },
  { kind: "relevance", what: "namesakes", test: /بالاسم\sنفسه|يحملون\sالاسم|أشخاص\sآخرين|شخص\sآخر/ },
];

/** True when a free sentence makes the promise a filter of this kind enforces. */
export const promisesKind = (text: string, kind: FilterKind | "relevance"): boolean => PROMISE_RULES.some((r) => r.kind === kind && r.test.test(text));

/**
 * NO PROMISE WITHOUT A CHECK. A sentence the model wrote for the card (the summary, a stage's «how», an assumption) that promises one of the things code can enforce must have its filter enabled on the stage (or, for «other people with the
 * same name», a relevance rule). The issue names exactly what to add or what to remove.
 */
export function promiseIssues(sentences: ReadonlyArray<{ where: string; text: string }>, stages: ReadonlyArray<{ key: string; filters?: ReadonlyArray<StageFilter>; hasRelevance: boolean }>): string[] {
  const issues: string[] = [];
  const delivered = stages.length > 0 ? stages : [];
  for (const s of sentences) {
    for (const rule of PROMISE_RULES) {
      if (!rule.test.test(s.text)) continue;
      const enforced = rule.kind === "relevance" ? delivered.some((st) => st.hasRelevance) : delivered.some((st) => (st.filters ?? []).some((f) => f.kind === rule.kind && isEnabled(f)));
      if (!enforced) issues.push(rule.kind === "relevance" ? `${s.where}: promises to leave out other people with the same name, but no stage has a relevance rule (subject_ar, terms, exclude_terms); add it or remove the sentence` : `${s.where}: promises something about ${rule.what} that no code enforces; add the filter {kind:"${rule.kind}"} to the stage, or remove that part of the sentence (the card must not promise what code cannot check)`);
    }
  }
  return issues;
}

/** The filter kinds a free sentence promises. */
export const kindsPromisedBy = (text: string): FilterKind[] => PROMISE_RULES.filter((r) => r.kind !== "relevance" && r.test.test(text)).map((r) => r.kind as FilterKind);

/**
 * THE ASSUMPTION LINES THE CARD SHOWS. A line of the model that promises something a filter enforces is shown only while that filter is ON (a customer who switches it off must not keep reading the promise); a filter that is on and
 * that no shown line promises gets its own sentence, built by code. So every promise on the card is backed by a switched-on check, whatever wording the model used, and nothing is said twice.
 */
export function assumptionLinesShown(modelLines: ReadonlyArray<string>, filters: ReadonlyArray<StageFilter>): string[] {
  const on = new Set(filters.filter(isEnabled).map((f) => f.kind));
  const shown = modelLines.filter((line) => kindsPromisedBy(line).every((k) => on.has(k)));
  const covered = new Set(shown.flatMap(kindsPromisedBy));
  const added = [...new Set(filters.filter(isEnabled).filter((f) => !covered.has(f.kind)).map(filterLineAr))];
  return [...shown, ...added];
}

// ------------------------------------------------------------------------------------------------- the language of the request

/** The request says it wants the items in some OTHER language, or in all of them. */
const OTHER_LANGUAGE_CUE = /(?:ب|بال)?(?:ال)?(?:انجليزي|إنجليزي|انجليزيه|إنجليزية|انجلش|فرنسي|فرنسية|تركي|تركية|اسباني|إسباني|ألماني|المانى|ألمانية)|english|french|turkish|spanish|german|(?:بكل|كل|أي|اي|جميع)\s+(?:ال)?لغ|كل\s+اللغات|بأي\s+لغة|باي\s+لغة|متعدد(?:ة)?\s+اللغ/i;

/**
 * THE ONE LANGUAGE RULE: the language the customer wrote the request in is the default language of the CONTENT they want, on every platform (tweets, posts, comments, reviews). An Arabic request gets Arabic items unless it asks
 * for another language or for every language; an English request, English ones. Null when the request does not decide (too few letters, mixed, or it names another language).
 */
export function defaultLanguageOf(...texts: Array<string | null | undefined>): "ar" | "en" | null {
  const t = texts.filter(Boolean).join(" ");
  if (!t.trim() || OTHER_LANGUAGE_CUE.test(t)) return null;
  const ar = (t.match(ARABIC_LETTER) ?? []).length;
  const la = (t.match(LATIN_LETTER) ?? []).length;
  if (ar >= 3 && ar >= la) return "ar";
  if (la >= 6 && ar === 0) return "en";
  return null;
}
