import { toBool, toEpochMs, toIsoTimestamp, toNumber } from "../coerce";
import { getPath } from "../treg/shapeReader";
import type { PlanColumn, PlanFilter, PlanFieldMap, Role, Transform } from "./types";

/**
 * The deterministic reader of a source row: the plan's FIELD MAP says which field becomes which column, the plan's FILTERS say which rows are kept. Nothing here knows a
 * platform: a transform is one of a closed list, a filter is one of three kinds, a field is a dotted path. No code from the model is ever run.
 *
 * A column with a ROLE is written under the platform's standard column key (so the result screen, the workbook and the codebook give it their standard Arabic title); a
 * column with no role is written under its own Arabic header (a title already in Arabic is shown as it is).
 */
export const ROLE_KEYS: Record<Role, string> = {
  id: "source_id",
  author_handle: "username",
  author_name: "author_name",
  text: "text",
  date: "published_at",
  url: "url",
  likes: "likes_count",
  replies: "replies_count",
  shares: "retweets_count",
  views: "views_count",
  followers: "followers_count",
  title: "video_title",
  is_reply: "is_reply",
  is_repost: "is_repost",
  language: "lang",
  email: "work_email",
  phone: "phone",
  company: "company_name",
  job_title: "job_title",
  location: "location",
  website: "website",
};

type Obj = Record<string, unknown>;

export function readField(row: Obj, path: string): unknown {
  if (path in row) return row[path];
  return getPath(row, path);
}

function joinList(v: unknown): string {
  if (Array.isArray(v)) return v.map((x) => (typeof x === "object" && x !== null ? "" : String(x ?? ""))).filter(Boolean).join("، ");
  return v === undefined || v === null ? "" : String(v);
}

/** An ISO time without milliseconds, the form the shared date helpers write («2026-10-18T07:36:02Z»). */
const isoNoMs = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

export function applyTransform(value: unknown, transform: Transform | undefined): unknown {
  if (value === undefined || value === null) return value;
  switch (transform) {
    case "unix_s_to_iso": { const ms = toEpochMs(value); return ms === undefined ? value : isoNoMs(ms); }
    case "unix_ms_to_iso": { const n = toNumber(value); return n === undefined ? value : isoNoMs(n); }
    case "bool": { const b = toBool(value); return b === undefined ? value : b; }
    case "number": { const n = toNumber(value); return n === undefined ? value : n; }
    case "strip_at": return typeof value === "string" ? value.replace(/^@+/, "") : value;
    case "lower": return typeof value === "string" ? value.toLowerCase() : value;
    case "first": return Array.isArray(value) ? value[0] : value;
    case "join": return joinList(value);
    case "domain": { const m = /^(?:https?:\/\/)?(?:www\.)?([^/\s:?#]+)/i.exec(String(value)); return m ? m[1].toLowerCase() : value; }
    case "text": return typeof value === "object" ? JSON.stringify(value) : String(value);
    default:
      // a date with no transform: a Unix time or a date text is made an ISO time when it can be read, never guessed
      return value;
  }
}

/** The date of a row value as an ISO time, when it can be read (Unix seconds or milliseconds as a number or text, or a date text). */
export function readDateIso(value: unknown, format?: "unix_s" | "unix_ms" | "iso"): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (format === "unix_ms") { const n = toNumber(value); return n === undefined ? undefined : isoNoMs(n); }
  if (format === "unix_s") { const ms = toEpochMs(value); return ms === undefined ? undefined : isoNoMs(ms); }
  return toIsoTimestamp(value) ?? (() => { const ms = toEpochMs(value); return ms === undefined ? undefined : isoNoMs(ms); })();
}

export interface MappedRow { record: Record<string, unknown>; raw: Obj }

/** One source row as the plan's record: each column read from its field, transformed, and written under its key. A row the map cannot read at all gives null. */
export function mapRow(raw: Obj, map: Pick<PlanFieldMap, "columns">): Record<string, unknown> | null {
  const record: Record<string, unknown> = {};
  let any = false;
  for (const col of map.columns) {
    let value = readField(raw, col.field);
    if (col.role === "date" && !col.transform) {
      const iso = readDateIso(value);
      if (iso !== undefined) value = iso;
    } else {
      value = applyTransform(value, col.transform);
    }
    const key = col.role ? ROLE_KEYS[col.role] : col.headerAr;
    if (value !== undefined && value !== null && value !== "") any = true;
    record[key] = value === undefined || value === null ? "" : value;
  }
  return any ? record : null;
}

const norm = (s: unknown) => String(s ?? "").trim().replace(/^@+/, "").toLowerCase();

/** Why a row was dropped by a filter, or null when it is kept. A row a filter cannot read is HELD (never delivered, never charged): the reason says so. */
export function rowFilterVerdict(raw: Obj, filters: ReadonlyArray<PlanFilter>): { keep: boolean; reason: "author" | "excluded" | "window" | "unreadable" | null } {
  for (const f of filters) {
    const v = readField(raw, f.field);
    if (f.kind === "author_equals") {
      if (v === undefined || v === null || v === "") return { keep: false, reason: "unreadable" };
      if (norm(v) !== norm(f.value)) return { keep: false, reason: "author" };
    } else if (f.kind === "exclude_true") {
      const b = toBool(v);
      if (b === undefined) return { keep: false, reason: "unreadable" };
      if (b) return { keep: false, reason: "excluded" };
    } else if (f.kind === "exclude_prefix") {
      if (v === undefined || v === null) return { keep: false, reason: "unreadable" };
      if (String(v).trimStart().toLowerCase().startsWith(f.prefix.toLowerCase())) return { keep: false, reason: "excluded" };
    } else if (f.kind === "date_window") {
      const iso = readDateIso(v, f.format);
      if (!iso) return { keep: false, reason: "unreadable" };
      const day = iso.slice(0, 10);
      if (day < f.from || day > f.to) return { keep: false, reason: "window" };
    }
  }
  return { keep: true, reason: null };
}

export interface ApplyResult {
  records: Array<Record<string, unknown>>;
  rawKept: Obj[];
  seen: number;
  dropped: { author: number; excluded: number; window: number; unreadable: number; empty: number };
}

/** The records of one page: the filters first, then the map. */
export function applyPlanToRows(rows: ReadonlyArray<Obj>, map: Pick<PlanFieldMap, "columns">, filters: ReadonlyArray<PlanFilter>): ApplyResult {
  const out: ApplyResult = { records: [], rawKept: [], seen: rows.length, dropped: { author: 0, excluded: 0, window: 0, unreadable: 0, empty: 0 } };
  for (const raw of rows) {
    const verdict = rowFilterVerdict(raw, filters);
    if (!verdict.keep) { out.dropped[verdict.reason as keyof ApplyResult["dropped"]] += 1; continue; }
    const record = mapRow(raw, map);
    if (!record) { out.dropped.empty += 1; continue; }
    out.records.push(record);
    out.rawKept.push(raw);
  }
  return out;
}

/** Of a field map, the key a role is written under (so a caller can find «the date column» or «the id column» of a record). */
export function keyOfRole(map: Pick<PlanFieldMap, "columns">, role: Role): string | null {
  return map.columns.some((c) => c.role === role) ? ROLE_KEYS[role] : null;
}

export function columnsOfMap(map: Pick<PlanFieldMap, "columns">): Array<{ key: string; titleAr: string; role?: Role }> {
  return map.columns.map((c: PlanColumn) => ({ key: c.role ? ROLE_KEYS[c.role] : c.headerAr, titleAr: c.headerAr, ...(c.role ? { role: c.role } : {}) }));
}
