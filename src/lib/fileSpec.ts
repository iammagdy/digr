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
  return /(?:شيت|ورقة|ورقه|تبويب|ملف)\s+(?:منفصل\s+|مستقل\s+)?لكل\s+\p{L}+|(?:قسّم|قسم|قسمي|وزّع|وزع)\s+(?:لي\s+)?(?:ال)?(?:ملف|اكسل|إكسل|شيت|نتايج|نتائج)|رتّب(?:ها|ه|لي)?\s+(?:الملف\s+|الشيت\s+)?حسب|رتب(?:ها|ه|لي)?\s+(?:الملف\s+|الشيت\s+)?حسب|فلتر(?:ها|ه)?\s+(?:الملف\s+|الشيت\s+)?(?:على|حسب|ب)|(?:سيب|خلي|اعرض|اظهر|أظهر)\s+(?:لي\s+)?(?:بس\s+|فقط\s+)?(?:الأعمدة|الاعمدة|عمود)/u.test(t);
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
