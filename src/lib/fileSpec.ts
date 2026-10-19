import { z } from "zod";

/**
 * File shaping: the customer says how the file should look («شيت لكل محافظة», «رتّب حسب التاريخ»), the model turns that
 * into this small structured spec, and server code VALIDATES it against an allowlist and builds the file from the
 * saved data. The model never writes the file, a formula, a price or a point amount: the schema is strict, so any
 * extra key (price, points, formula, script) makes the whole spec invalid.
 */
export const FILE_SPEC_LIMITS = {
  maxColumns: 60,
  maxFilters: 5,
  maxSorts: 3,
  maxSheets: 25,
  maxTextLength: 100,
  maxColumnNameLength: 80,
  /** a spec travels in a download link, so it stays small */
  maxEncodedLength: 3000,
} as const;

export const FILTER_OPERATORS = ["equals", "not_equals", "contains", "gt", "gte", "lt", "lte", "not_empty"] as const;
export type FilterOperator = (typeof FILTER_OPERATORS)[number];

const columnName = z.string().trim().min(1).max(FILE_SPEC_LIMITS.maxColumnNameLength);

export const FileSpecSchema = z
  .object({
    version: z.literal(1).optional(),
    /** which file this spec shapes; the download link decides, this documents the model's intent */
    format: z.enum(["xlsx", "pdf", "csv"]).optional(),
    /** the columns to keep, in this order */
    columns: z.array(columnName).max(FILE_SPEC_LIMITS.maxColumns).optional(),
    filters: z
      .array(
        z
          .object({
            column: columnName,
            op: z.enum(FILTER_OPERATORS),
            value: z.union([z.string().max(FILE_SPEC_LIMITS.maxTextLength), z.number().finite()]).optional(),
          })
          .strict(),
      )
      .max(FILE_SPEC_LIMITS.maxFilters)
      .optional(),
    sortBy: z
      .array(z.object({ column: columnName, direction: z.enum(["asc", "desc"]).default("asc") }).strict())
      .max(FILE_SPEC_LIMITS.maxSorts)
      .optional(),
    /** one sheet per distinct value of the column (Excel only) */
    groupBy: z.object({ column: columnName, mode: z.literal("sheets").default("sheets") }).strict().optional(),
  })
  .strict();

export type FileSpec = z.infer<typeof FileSpecSchema>;

export interface DatasetColumn {
  /** the key in each row */
  key: string;
  /** the Arabic title the customer sees */
  titleAr: string;
}

export type SpecValidation =
  | { ok: true; spec: FileSpec }
  | { ok: false; errorAr: string };

const norm = (value: string) => value.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
/** «المحافظة» and «محافظة» name the same column. */
const looseNorm = (value: string) => norm(value).replace(/^ال(?=\p{L})/u, "");

/** Match a column the model named to a real column: by key or by its Arabic title. Null when it does not exist. */
export function resolveColumn(name: string, columns: DatasetColumn[]): DatasetColumn | null {
  const wanted = norm(name);
  const loose = looseNorm(name);
  return (
    columns.find((c) => norm(c.key) === wanted) ||
    columns.find((c) => norm(c.titleAr) === wanted) ||
    columns.find((c) => looseNorm(c.titleAr) === loose) ||
    null
  );
}

/**
 * Validates untrusted JSON (from the model or from a link) and rewrites every column name to its real key. Any unknown
 * key, column, operator or oversize value is refused with an Arabic reason; nothing is silently guessed.
 */
export function validateFileSpec(raw: unknown, columns: DatasetColumn[]): SpecValidation {
  const parsed = FileSpecSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, errorAr: "طلب تنسيق الملف غير مفهوم. وضّح الشكل المطلوب، مثل: شيت لكل محافظة، أو ترتيب حسب التاريخ." };
  const spec = parsed.data;
  const unknown: string[] = [];
  const key = (name: string): string => {
    const hit = resolveColumn(name, columns);
    if (!hit) unknown.push(name);
    return hit?.key ?? name;
  };
  const out: FileSpec = { version: 1 };
  if (spec.format) out.format = spec.format;
  if (spec.columns) out.columns = [...new Set(spec.columns.map(key))];
  if (spec.filters) {
    out.filters = spec.filters.map((f) => {
      const needsValue = f.op !== "not_empty";
      if (needsValue && (f.value === undefined || f.value === "")) unknown.push(`قيمة الفلتر للعمود ${f.column}`);
      if ((f.op === "gt" || f.op === "gte" || f.op === "lt" || f.op === "lte") && f.value !== undefined && !Number.isFinite(Number(f.value))) {
        unknown.push(`قيمة رقمية للعمود ${f.column}`);
      }
      return { column: key(f.column), op: f.op, ...(f.value !== undefined ? { value: f.value } : {}) };
    });
  }
  if (spec.sortBy) out.sortBy = spec.sortBy.map((s) => ({ column: key(s.column), direction: s.direction }));
  if (spec.groupBy) out.groupBy = { column: key(spec.groupBy.column), mode: "sheets" };
  if (unknown.length > 0) {
    return { ok: false, errorAr: `لا أجد في بياناتك: ${[...new Set(unknown)].map((c) => `«${c}»`).join("، ")}. اختر من الأعمدة الموجودة في الملف.` };
  }
  return { ok: true, spec: out };
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return "";
  return String(value);
}

const num = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = cell(value).replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d))).replace(/[,٬\s]/g, "");
  if (!text || !/^-?\d+(\.\d+)?$/.test(text)) return null;
  return Number(text);
};

function matches(row: Record<string, any>, f: NonNullable<FileSpec["filters"]>[number]): boolean {
  const actual = row[f.column];
  const text = cell(actual);
  switch (f.op) {
    case "not_empty": return text.trim() !== "";
    case "equals": return norm(text) === norm(String(f.value ?? ""));
    case "not_equals": return norm(text) !== norm(String(f.value ?? ""));
    case "contains": return norm(text).includes(norm(String(f.value ?? "")));
    default: {
      const left = num(actual);
      const right = num(f.value);
      if (left === null || right === null) return false;
      return f.op === "gt" ? left > right : f.op === "gte" ? left >= right : f.op === "lt" ? left < right : left <= right;
    }
  }
}

const collator = new Intl.Collator("ar", { numeric: true, sensitivity: "base" });

/** Filters, then sorts. Pure; never mutates the input. Grouping and column choice are applied by the builders. */
export function applySpecToRows<T extends Record<string, any>>(rows: T[], spec: FileSpec): T[] {
  let out = rows.filter((row) => (spec.filters || []).every((f) => matches(row, f)));
  if (spec.sortBy?.length) {
    const sorts = spec.sortBy;
    out = [...out].sort((a, b) => {
      for (const s of sorts) {
        const na = num(a[s.column]);
        const nb = num(b[s.column]);
        const c = na !== null && nb !== null ? na - nb : collator.compare(cell(a[s.column]), cell(b[s.column]));
        if (c !== 0) return s.direction === "desc" ? -c : c;
      }
      return 0;
    });
  }
  return out;
}

export function specColumns(allColumns: string[], spec: FileSpec): string[] {
  if (!spec.columns?.length) return allColumns;
  const known = new Set(allColumns);
  return spec.columns.filter((c) => known.has(c));
}

const FORBIDDEN_SHEET_CHARS = /[\\/?*[\]:]/g;

/** Excel sheet names: at most 31 characters, none of \ / ? * [ ] :, no leading or trailing apostrophe, unique. */
export function sheetNames(values: string[], fallback = "بيانات"): string[] {
  const used = new Set<string>();
  return values.map((value) => {
    let base = String(value ?? "").replace(FORBIDDEN_SHEET_CHARS, " ").replace(/\s+/g, " ").replace(/^'+|'+$/g, "").trim().slice(0, 31).trim() || fallback;
    let name = base;
    let i = 2;
    while (used.has(name.toLowerCase())) {
      const suffix = ` ${i++}`;
      name = `${base.slice(0, 31 - suffix.length)}${suffix}`;
    }
    used.add(name.toLowerCase());
    return name;
  });
}

/** Groups rows by a column. Empty values go to «غير محدد». Throws no error: the caller checks the sheet count. */
export function groupRows<T extends Record<string, any>>(rows: T[], column: string): Array<{ value: string; rows: T[] }> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const value = cell(row[column]).trim() || "غير محدد";
    if (!groups.has(value)) groups.set(value, []);
    groups.get(value)!.push(row);
  }
  return [...groups.entries()].map(([value, groupRowsList]) => ({ value, rows: groupRowsList }));
}

/** A spec travels in a download link as base64url JSON (works in the browser and on the server). */
export function encodeFileSpec(spec: FileSpec): string {
  const bytes = new TextEncoder().encode(JSON.stringify(spec));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeFileSpec(encoded: string): unknown | null {
  if (!encoded || encoded.length > FILE_SPEC_LIMITS.maxEncodedLength || !/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  try {
    const padded = encoded.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (encoded.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

/**
 * True when the customer is asking how the result on screen should look (a sheet per region, a sort, a filter, chosen
 * columns). Such a turn is a chat turn about an existing file, not a new research request, so it skips discovery.
 */
export function looksLikeFileShapingRequest(text: string): boolean {
  const t = String(text || "");
  if (t.length > 300) return false;
  return /(?:شيت|ورقة|ورقه|تبويب|ملف)\s+(?:منفصل\s+|مستقل\s+)?لكل\s+\p{L}+|(?:قسّم|قسم|قسمي|وزّع|وزع)\s+(?:لي\s+)?(?:ال)?(?:ملف|اكسل|إكسل|شيت|نتايج|نتائج)|رتّ?ب(?:ها|ه|لي|لنا)?\s+(?:(?:ال)?(?:ملف|شيت|اكسل|إكسل|نتايج|نتائج|سجلات|بيانات)\s+)?(?:حسب|بحسب|على\s+حسب)|فلتر(?:ها|ه)?\s+(?:(?:ال)?(?:ملف|شيت|اكسل|إكسل|نتايج|نتائج|سجلات|بيانات)\s+)?(?:على|حسب|ب)|(?:سيب|خلي|اعرض|اظهر|أظهر)\s+(?:لي\s+)?(?:بس\s+|فقط\s+)?(?:الأعمدة|الاعمدة|عمود)/u.test(t);
}

/** Arabic word without diacritics or the article, with the usual letter variants folded, for matching column words. */
function arabicWordKey(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\u064B-\u0652\u0640]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^ال(?=\p{L})/u, "");
}

/** The words a customer uses for a column, mapped to the key that column has in a delivered file. */
const GROUP_WORD_KEYS: Record<string, string> = {
  "مدينه": "city", "مدن": "city",
  "دوله": "country", "دول": "country", "بلد": "country", "بلدان": "country",
  "نشاط": "industry", "انشطه": "industry", "مجال": "industry", "مجالات": "industry", "قطاع": "industry", "قطاعات": "industry", "صناعه": "industry",
  "منصه": "platform", "منصات": "platform",
  "لغه": "language", "لغات": "language",
  "هاتف": "phone", "تليفون": "phone", "موبايل": "phone", "جوال": "phone",
  "ايميل": "work_email", "بريد": "work_email", "موقع": "website",
};

const GROUP_PHRASES: RegExp[] = [
  /(?:شيتات|شيت|أوراق|اوراق|ورقة|ورقه|تبويبات|تبويب)\s+(?:منفصل(?:ة|ه)?\s+|مستقل(?:ة|ه)?\s+)?(?:لكل|حسب|بحسب|على\s+حسب)\s+([^،,.!؟?\n]+)/u,
  /(?:قسّم|قسم|قسمي|وزّع|وزع)(?:\s+لي)?\s+(?:(?:ال)?(?:ملف|اكسل|إكسل|شيت|نتايج|نتائج)\s+)?(?:(?:على\s+)?(?:شيتات|أوراق|اوراق|تبويبات)\s+)?(?:حسب|بحسب|على\s+حسب|لكل)\s+([^،,.!؟?\n]+)/u,
];

/**
 * The column a customer names in a «sheet per X» request («قسّم الملف شيت لكل مدينة» gives «مدينة»), or null when the
 * request is anything else (a sort, a filter, a column choice, or a split mixed with another shaping step).
 */
export function shapingGroupName(text: string): string | null {
  const t = String(text || "").trim();
  if (!t || t.length > 300) return null;
  if (/رتّ?ب|فلتر|الأعمدة|الاعمدة|عمود|(?:^|\s)(?:و|ثم)\s*(?:اعرض|سيب|خلي)/u.test(t)) return null;
  for (const pattern of GROUP_PHRASES) {
    const hit = pattern.exec(t);
    if (!hit) continue;
    const name = hit[1].replace(/\s*(?:لو\s+سمحت|من\s+فضلك|please)\s*$/iu, "").trim();
    if (!name || name.length > FILE_SPEC_LIMITS.maxColumnNameLength || name.split(/\s+/).length > 4) return null;
    return name;
  }
  return null;
}

/** The real column a named word points to: its key or Arabic title, else the usual word for a known column that exists. */
export function resolveGroupColumn(name: string, columns: DatasetColumn[]): DatasetColumn | null {
  const direct = resolveColumn(name, columns);
  if (direct) return direct;
  const key = GROUP_WORD_KEYS[arabicWordKey(name)];
  if (key) return columns.find((c) => c.key === key) || null;
  // «المتابعين» and «المتابعون» (and any title that differs only in the plural ending or the article) name one column.
  const fold = (value: string) => arabicWordKey(value).replace(/(?:ون|ين)$/u, "ين");
  const wanted = fold(name);
  return (wanted && columns.find((c) => fold(c.titleAr) === wanted || fold(c.key) === wanted)) || null;
}

const FILLER_TAIL = /\s*(?:لو\s+سمحت|من\s+فضلك|please)\s*$/iu;
const FILE_WORDS = "(?:(?:ال)?(?:ملف|شيت|اكسل|إكسل|نتايج|نتائج|سجلات|بيانات)\\s+)?";
const SORT_PHRASE = new RegExp(`رتّ?ب(?:ها|ه|لي|لنا)?\\s+${FILE_WORDS}(?:حسب|بحسب|على\\s+حسب)\\s+([^،,.!؟?\\n]+)`, "u");
const FILTER_PHRASE = new RegExp(`فلتر(?:ها|ه)?\\s+${FILE_WORDS}(?:على|حسب|ب)\\s+([^،,.!؟?\\n]+)`, "u");
const COLUMNS_PHRASE = /(?:سيب|خلي|اعرض|اظهر|أظهر)(?:\s+لي)?\s+(?:بس\s+|فقط\s+)?(?:ال)?(?:أعمدة|اعمدة|عمودين|عمود)\s+([^.!؟?\n]+)/u;
const DESC_WORDS = /(?:تنازلي(?:اً|ًا|ا)?|من\s+(?:الأكبر|الاكبر|الأعلى|الاعلى)(?:\s+(?:إلى|الى|ل)\s*\S+)?)/u;
const ASC_WORDS = /(?:تصاعدي(?:اً|ًا|ا)?|من\s+(?:الأصغر|الاصغر|الأقل|الاقل)(?:\s+(?:إلى|الى|ل)\s*\S+)?)/u;

/** The shaping steps a message carries; a message with more than one is compound and is left to the model. */
function shapingSteps(text: string): number {
  const t = String(text || "");
  // «رتب الشيت حسب المدينة» is a sort, not also a split: look for a split in what the other phrases leave over.
  const rest = t.replace(SORT_PHRASE, " ").replace(FILTER_PHRASE, " ").replace(COLUMNS_PHRASE, " ");
  return [GROUP_PHRASES.some((p) => p.test(rest)), SORT_PHRASE.test(t), FILTER_PHRASE.test(t), COLUMNS_PHRASE.test(t)].filter(Boolean).length;
}

function sortSpec(text: string, columns: DatasetColumn[]): FileSpec | null {
  const hit = SORT_PHRASE.exec(text);
  if (!hit) return null;
  const direction: "asc" | "desc" = DESC_WORDS.test(text) ? "desc" : "asc";
  if (DESC_WORDS.test(text) && ASC_WORDS.test(text)) return null;
  const name = hit[1].replace(DESC_WORDS, "").replace(ASC_WORDS, "").replace(FILLER_TAIL, "").replace(/[\u064B-\u0652]/g, "").trim();
  if (!name || name.length > FILE_SPEC_LIMITS.maxColumnNameLength || /(?:^|\s)(?:و|ثم)\s/u.test(` ${name} `) || name.split(/\s+/).length > 3) return null;
  const column = resolveGroupColumn(name, columns);
  return { version: 1, sortBy: [{ column: column ? column.key : name, direction }] };
}

const FILTER_OPS: Array<{ re: RegExp; op: FilterOperator }> = [
  { re: /^(.+?)\s+(?:أكبر|اكبر)\s+من\s+(.+)$/u, op: "gt" },
  { re: /^(.+?)\s+(?:أقل|اقل)\s+من\s+(.+)$/u, op: "lt" },
  { re: /^(.+?)\s+(?:يحتوي|يحتوى|فيه|يشمل|بيشمل)\s+(.+)$/u, op: "contains" },
  { re: /^(.+?)\s+(?:يساوي|=|هو|هي)\s+(.+)$/u, op: "equals" },
];

/** «فلتر الملف على <عمود> أكبر من <قيمة>»: only with an explicit operator word; a bare value is ambiguous and the model's. */
function filterSpec(text: string, columns: DatasetColumn[]): FileSpec | null {
  const hit = FILTER_PHRASE.exec(text);
  if (!hit) return null;
  const rest = hit[1].replace(FILLER_TAIL, "").trim();
  if (/(?:^|\s)(?:و|ثم)\s/u.test(` ${rest} `)) return null;
  for (const { re, op } of FILTER_OPS) {
    const parts = re.exec(rest);
    if (!parts) continue;
    const name = parts[1].trim();
    const raw = parts[2].trim();
    if (!name || name.split(/\s+/).length > 3 || !raw || raw.length > FILE_SPEC_LIMITS.maxTextLength) return null;
    const column = resolveGroupColumn(name, columns);
    const value: string | number = op === "gt" || op === "lt" ? Number(num(raw) ?? NaN) : raw;
    if ((op === "gt" || op === "lt") && !Number.isFinite(value)) return null;
    return { version: 1, filters: [{ column: column ? column.key : name, op, value }] };
  }
  return null;
}

/** «سيب الأعمدة الاسم والمدينة والهاتف فقط»: the named columns, in that order. */
function columnsSpec(text: string, columns: DatasetColumn[]): FileSpec | null {
  const hit = COLUMNS_PHRASE.exec(text);
  if (!hit) return null;
  const list = hit[1].replace(/\s*(?:بس|فقط)\s*$/u, "").replace(FILLER_TAIL, "").trim();
  const names = list.split(/\s*(?:،|,|\sو\s|\sو(?=\S)|\sثم\s)\s*/u).map((n) => n.replace(/^و(?=\p{L}{3,})/u, "").trim()).filter(Boolean);
  if (names.length === 0 || names.length > 12 || names.some((n) => n.split(/\s+/).length > 3 || n.length > FILE_SPEC_LIMITS.maxColumnNameLength)) return null;
  return { version: 1, columns: names.map((n) => resolveGroupColumn(n, columns)?.key ?? n) };
}

/**
 * A shaping request read by code against the REAL columns of the delivered file: no model call, no guessing. Covers one
 * step: a sheet per column, a sort, a filter with an explicit operator, or a column choice. A column that exists gives
 * a spec with its real key; one that does not gives a spec naming the word as written, which the usual validation
 * turns into a question about the columns the file has. Null when the text is compound or ambiguous (the model's) or
 * is not a shaping request.
 */
export function deterministicShapeSpec(text: string, columns: DatasetColumn[]): FileSpec | null {
  const t = String(text || "").trim();
  if (!t || t.length > 300 || shapingSteps(t) !== 1) return null;
  const name = shapingGroupName(t);
  if (name) {
    const column = resolveGroupColumn(name, columns);
    return { version: 1, groupBy: { column: column ? column.key : name, mode: "sheets" } };
  }
  return sortSpec(t, columns) ?? filterSpec(t, columns) ?? columnsSpec(t, columns);
}

/** The questions asked when a shaping request names a column the delivered file does not have. Each is answered in code. */
export const SHAPE_QUESTION_IDS = [
  "shape_column_required",
  "shape_sort_asc_required",
  "shape_sort_desc_required",
  "shape_filter_column_required",
  "shape_columns_required",
] as const;
export type ShapeQuestionId = (typeof SHAPE_QUESTION_IDS)[number];

export function isShapeQuestionId(id: unknown): id is ShapeQuestionId {
  return typeof id === "string" && (SHAPE_QUESTION_IDS as readonly string[]).includes(id);
}

/** The customer's answer to a shaping question, read from the card payload; null when the message is anything else. */
export function shapeAnswerFromMessage(message: string): { questionId: ShapeQuestionId; value: string } | null {
  const text = String(message || "").trim();
  if (!text.startsWith("{") || !text.includes("clarification_answers")) return null;
  try {
    const parsed = JSON.parse(text);
    if (parsed?.type !== "clarification_answers" || !Array.isArray(parsed.answers)) return null;
    for (const answer of parsed.answers) {
      if (isShapeQuestionId(answer?.questionId)) {
        const value = Array.isArray(answer.value) ? answer.value.find((v: unknown) => typeof v === "string") : answer.value;
        return { questionId: answer.questionId, value: typeof value === "string" ? value.trim() : "" };
      }
    }
  } catch {
    return null;
  }
  return null;
}

export interface ShapeQuestion {
  id: ShapeQuestionId;
  textAr: string;
  /** the word the customer wrote for a column the file does not have */
  unknownName: string;
}

const isKnownColumn = (name: string, columns: DatasetColumn[]) => resolveGroupColumn(name, columns) !== null;

/** Which question a spec with an unknown column needs, or null when every column it names exists. */
export function shapeQuestionForSpec(spec: FileSpec | null | undefined, columns: DatasetColumn[]): ShapeQuestion | null {
  if (!spec) return null;
  if (spec.groupBy && !isKnownColumn(spec.groupBy.column, columns)) {
    return { id: "shape_column_required", textAr: "بأي عمود تريد تقسيم الملف إلى شيتات؟", unknownName: spec.groupBy.column };
  }
  const sort = spec.sortBy?.find((entry) => !isKnownColumn(entry.column, columns));
  if (sort) {
    return { id: sort.direction === "desc" ? "shape_sort_desc_required" : "shape_sort_asc_required", textAr: "بأي عمود تريد ترتيب الملف؟", unknownName: sort.column };
  }
  const filter = spec.filters?.find((entry) => !isKnownColumn(entry.column, columns));
  if (filter) {
    return { id: "shape_filter_column_required", textAr: "على أي عمود تريد تطبيق الفلتر؟", unknownName: filter.column };
  }
  const column = spec.columns?.find((name) => !isKnownColumn(name, columns));
  if (column) {
    return { id: "shape_columns_required", textAr: "أي عمود من أعمدة ملفك تقصد؟", unknownName: column };
  }
  return null;
}

export type ShapeAnswerResolution =
  | { ok: true; spec: FileSpec; ignored: string[] }
  | { ok: false; errorAr: string };

const SHAPE_ANSWER_FAILED_AR = "لم أستطع تحديد الشكل المطلوب للملف من اختيارك. اكتب مثلًا: رتب الملف حسب المدينة، أو شيت لكل مدينة. لن يُخصم أي رصيد.";

/**
 * The answer to a shaping question, resolved in code: the chosen column plus the shaping step the question belongs to give
 * the spec, validated against the REAL columns. A split and a sort carry their step in the question id; a filter and a
 * column choice recover theirs (operator, value, the other columns) from the customer's original request. No model, no price.
 */
export function resolveShapeAnswer(input: {
  questionId: ShapeQuestionId;
  value: string;
  originalText?: string;
  columns: DatasetColumn[];
}): ShapeAnswerResolution {
  const failed: ShapeAnswerResolution = { ok: false, errorAr: SHAPE_ANSWER_FAILED_AR };
  const chosen = input.value ? resolveGroupColumn(input.value, input.columns) : null;
  if (!chosen) return failed;
  let spec: FileSpec | null = null;
  const ignored: string[] = [];
  switch (input.questionId) {
    case "shape_column_required":
      spec = { version: 1, groupBy: { column: chosen.key, mode: "sheets" } };
      break;
    case "shape_sort_asc_required":
      spec = { version: 1, sortBy: [{ column: chosen.key, direction: "asc" }] };
      break;
    case "shape_sort_desc_required":
      spec = { version: 1, sortBy: [{ column: chosen.key, direction: "desc" }] };
      break;
    case "shape_filter_column_required": {
      const original = input.originalText ? deterministicShapeSpec(input.originalText, input.columns) : null;
      const filter = original?.filters?.[0];
      if (!filter) return failed;
      spec = { version: 1, filters: [{ ...filter, column: chosen.key }] };
      break;
    }
    case "shape_columns_required": {
      const original = input.originalText ? deterministicShapeSpec(input.originalText, input.columns) : null;
      if (!original?.columns?.length) return failed;
      let replaced = false;
      const kept: string[] = [];
      for (const name of original.columns) {
        if (isKnownColumn(name, input.columns)) kept.push(resolveGroupColumn(name, input.columns)!.key);
        else if (!replaced) { kept.push(chosen.key); replaced = true; }
        else ignored.push(name);
      }
      spec = { version: 1, columns: [...new Set(kept)] };
      break;
    }
  }
  const checked = validateFileSpec(spec, input.columns);
  return checked.ok ? { ok: true, spec: checked.spec, ignored } : failed;
}

/** Plain-Arabic description of what the spec will do, shown to the customer before they download. */
export function describeFileSpecAr(spec: FileSpec, columns: DatasetColumn[]): string {
  const title = (key: string) => columns.find((c) => c.key === key)?.titleAr || key;
  const parts: string[] = [];
  if (spec.groupBy) parts.push(`شيت منفصل لكل قيمة في «${title(spec.groupBy.column)}»`);
  if (spec.filters?.length) parts.push(`تصفية ${spec.filters.length === 1 ? "بشرط واحد" : "بـ" + spec.filters.length + " شروط"}`.replace(/\d+/g, (d) => d.replace(/\d/g, (x) => "٠١٢٣٤٥٦٧٨٩"[Number(x)])));
  if (spec.sortBy?.length) parts.push(`ترتيب حسب «${spec.sortBy.map((s) => title(s.column)).join("» ثم «")}»`);
  if (spec.columns?.length) parts.push(`الأعمدة المختارة فقط`);
  return parts.length ? parts.join("، ") : "الملف بالتنسيق المعتاد";
}
