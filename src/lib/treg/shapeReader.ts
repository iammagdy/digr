import { toBool, toEpochMs, toNumber } from "../coerce";
import type { CatalogEndpoint } from "./catalog";

/**
 * Reads the rows and the next cursor out of ONE real provider answer, using what the catalog says about the endpoint, and never trusting one hint alone.
 *
 * The list: 1. the catalog's `list_path` (a dotted path; «root» is the answer itself); 2. the path where the catalog's own example answer holds its list;
 * 3. the common keys (the envelope and list names every provider uses), a few levels deep; 4. a single object under data / user / profile read as one row.
 * The cursor: 1. the catalog's `cursor_path`; 2. the places where the example holds something cursor-like; 3. the common cursor keys, also inside pagination / meta.
 * (anyapi.x.user.posts: the file says `cursor_path: null`, the live cursor sits at output.data.nextCursor: found by 2.) A boolean flag («has_more») is never taken for
 * a cursor, a masked placeholder («<omitted: expires>») is not a cursor, and a cursor beside `has_more: false` is a position, not a next page.
 *
 * The types: a value read as the catalog declares it when it can be, tolerantly: «True»/«False» and 1/0 as booleans, numbers written as text, Unix seconds as text or
 * as a number. A value that cannot be read as declared is left exactly as it came (never guessed), and counted.
 *
 * Pure: no server imports, no network.
 */

export type ListStrategy = "list_path" | "example" | "common_keys" | "single_object" | "none";
export type CursorStrategy = "cursor_path" | "example" | "common_keys" | "none";

export interface ShapeHints {
  listPath?: string | null;
  cursorPath?: string | null;
  example?: unknown;
  itemFields?: Record<string, { type: string }> | null;
}

export interface ShapeReading {
  rows: Array<Record<string, unknown>>;
  listPath: string | null;
  listStrategy: ListStrategy;
  nextCursor: string | null;
  cursorPath: string | null;
  cursorStrategy: CursorStrategy;
  /** «token»: an opaque next-page value; «offset»: a position number; «url»: the address of the next page (not a value to send back as a parameter). */
  cursorKind: "token" | "offset" | "url" | null;
  hasMore: boolean | null;
  /** How many values were read as the catalog declares them, per field (a string «True» read as a boolean, «1792308962» as a number…). */
  coercions: Record<string, number>;
  /** Values that could not be read as the catalog declares them, per field (kept as they came). */
  unreadable: Record<string, number>;
  warnings: string[];
}

export const hintsOf = (endpoint: Pick<CatalogEndpoint, "list_path" | "cursor_path" | "example_response_trimmed" | "item_fields">): ShapeHints => ({
  listPath: endpoint.list_path,
  cursorPath: endpoint.cursor_path,
  example: endpoint.example_response_trimmed,
  itemFields: endpoint.item_fields,
});

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isObjectList = (v: unknown): v is Obj[] => Array.isArray(v) && v.length > 0 && v.every(isObj);

const MAX_DEPTH = 6;
const COMMON_DEPTH = 4;

/** The envelope keys providers wrap an answer in, and the names a list goes by. */
const ENVELOPE_KEYS = ["output", "data", "result", "response", "payload", "raw", "body"];
const LIST_KEYS = [
  "rows", "items", "results", "records", "comments", "replies", "posts", "tweets", "videos", "users", "people", "companies", "leads", "entries", "hashtags", "keywords",
  "reviews", "messages", "aweme_list", "videoList", "list", "elements", "organic_results", "ads", "products", "jobs",
];
const CURSOR_KEYS = ["next_cursor", "nextCursor", "cursor", "next_max_id", "max_cursor", "next_page_token", "nextPageToken", "continuation", "continuation_token", "continuationToken", "next_token", "nextToken", "end_cursor", "endCursor", "after", "next", "token"];
const HAS_MORE_KEYS = ["has_more", "hasMore", "has_next_page", "hasNextPage", "more"];

/** Value at a dotted path («output.data.tweets», «tasks.0.result»); «root» is the answer itself. */
export function getPath(body: unknown, path: string | null | undefined): unknown {
  if (path === null || path === undefined || path === "") return undefined;
  if (path === "root") return body;
  let cur: unknown = body;
  for (const part of path.split(".")) {
    if (Array.isArray(cur)) {
      if (!/^\d+$/.test(part)) return undefined;
      cur = cur[Number(part)];
    } else if (isObj(cur)) {
      cur = cur[part];
    } else {
      return undefined;
    }
    if (cur === undefined) return undefined;
  }
  return cur;
}

/** Every path in `value` that holds a non-empty list of objects, with its length and the number of keys of its first item. */
export function findListPaths(value: unknown): Array<{ path: string; length: number; keys: number }> {
  const out: Array<{ path: string; length: number; keys: number }> = [];
  const walk = (v: unknown, path: string, depth: number) => {
    if (depth > MAX_DEPTH) return;
    if (isObjectList(v)) {
      out.push({ path: path || "root", length: v.length, keys: Object.keys(v[0]).length });
      return;
    }
    if (isObj(v)) for (const [k, child] of Object.entries(v)) walk(child, path ? `${path}.${k}` : k, depth + 1);
  };
  walk(value, "", 0);
  return out;
}

/** Of the lists an example holds, the one that is the result list: a list under a known list name first, else the shallowest, then the one with the most keys. */
export function chooseResultList(paths: Array<{ path: string; length: number; keys: number }>): string | null {
  if (paths.length === 0) return null;
  const last = (p: string) => p.split(".").pop() as string;
  const named = paths.filter((p) => LIST_KEYS.includes(last(p.path)));
  const pool = named.length > 0 ? named : paths;
  return [...pool].sort((a, b) => a.path.split(".").length - b.path.split(".").length || b.keys - a.keys || a.path.localeCompare(b.path))[0].path;
}

function listAtCommonKeys(value: unknown, path: string, depth: number): { path: string; rows: Obj[] } | null {
  if (depth > COMMON_DEPTH) return null;
  if (isObjectList(value)) return { path: path || "root", rows: value };
  if (!isObj(value)) return null;
  for (const key of LIST_KEYS) {
    const v = value[key];
    if (isObjectList(v)) return { path: path ? `${path}.${key}` : key, rows: v };
  }
  for (const key of LIST_KEYS) {
    if (Array.isArray(value[key]) && (value[key] as unknown[]).length === 0) return { path: path ? `${path}.${key}` : key, rows: [] };
  }
  for (const key of ENVELOPE_KEYS) {
    const found = listAtCommonKeys(value[key], path ? `${path}.${key}` : key, depth + 1);
    if (found) return found;
  }
  for (const [key, v] of Object.entries(value)) {
    if (isObjectList(v)) return { path: path ? `${path}.${key}` : key, rows: v };
  }
  return null;
}

const NO_LIST_PATH = new Set(["", "NOT FOUND", "NOT_FOUND"]);

function readList(body: unknown, hints: ShapeHints): { rows: Obj[]; path: string | null; strategy: ListStrategy; warnings: string[] } {
  const warnings: string[] = [];
  const asRows = (v: unknown): Obj[] | null => (isObjectList(v) ? v : Array.isArray(v) && v.length === 0 ? [] : null);

  // 1. the catalog's own list path
  const hint = hints.listPath;
  if (typeof hint === "string" && !NO_LIST_PATH.has(hint)) {
    const rows = asRows(getPath(body, hint));
    if (rows) return { rows, path: hint, strategy: "list_path", warnings };
    warnings.push(`list_path «${hint}» is not a list in this answer`);
  }
  // 2. where the catalog's example holds its list
  if (hints.example !== undefined && hints.example !== null) {
    const chosen = chooseResultList(findListPaths(hints.example));
    if (chosen && chosen !== hint) {
      const rows = asRows(getPath(body, chosen));
      if (rows) return { rows, path: chosen, strategy: "example", warnings };
    }
  }
  // 3. the common keys
  const common = listAtCommonKeys(body, "", 0);
  if (common) return { rows: common.rows, path: common.path, strategy: "common_keys", warnings };
  // 4. one object that is the record
  if (isObj(body)) {
    for (const key of ["data", "user", "profile", "result", "output"]) {
      const v = body[key];
      if (isObj(v) && Object.keys(v).length > 0 && !Object.values(v).some(isObjectList)) return { rows: [v], path: key, strategy: "single_object", warnings };
    }
  }
  return { rows: [], path: null, strategy: "none", warnings };
}

const ECHO_KEYS = new Set(["params", "request", "query", "input", "echo", "_request", "request_params", "requestparams"]);
const MASKED = /^<\s*omitted[^>]*>$/i;
const isCursorString = (v: unknown): v is string => typeof v === "string" && v.trim() !== "" && v.trim().toLowerCase() !== "null" && !MASKED.test(v.trim());

interface CursorFound { value: string; path: string; kind: "token" | "offset" | "url" }

function cursorAt(body: unknown, path: string): CursorFound | null {
  const v = getPath(body, path);
  if (isCursorString(v)) return { value: v, path, kind: /^https?:\/\//i.test(v.trim()) ? "url" : "token" };
  if (typeof v === "number" && Number.isFinite(v)) return { value: String(v), path, kind: "offset" };
  return null; // a boolean flag, an object, an empty or masked value
}

/** Paths in an example that hold something cursor-like (a cursor key with a string or number, or a position under pagination/meta). */
export function findCursorPaths(example: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown, path: string, depth: number) => {
    if (depth > MAX_DEPTH || !isObj(v)) return;
    for (const [k, child] of Object.entries(v)) {
      // the echo of the REQUEST (params, request, query…) holds the cursor and offset that were SENT, not the next one
      if (ECHO_KEYS.has(k.toLowerCase())) continue;
      const here = path ? `${path}.${k}` : k;
      if (/cursor|next_?page|next_?token|continuation|page_?token|^after$|^offset$|^token$/i.test(k) && (typeof child === "string" || typeof child === "number")) out.push(here);
      if (isObj(child)) walk(child, here, depth + 1);
    }
  };
  walk(example, "", 0);
  return out;
}

function hasMoreAt(body: unknown, container: string): boolean | null {
  const holder = container ? getPath(body, container) : body;
  if (!isObj(holder)) return null;
  for (const key of HAS_MORE_KEYS) {
    const flag = toBool(holder[key]);
    if (flag !== undefined) return flag;
  }
  return null;
}

function cursorAtCommonKeys(value: unknown, path: string, depth: number): CursorFound | null {
  if (!isObj(value) || depth > COMMON_DEPTH) return null;
  for (const key of CURSOR_KEYS) {
    const here = path ? `${path}.${key}` : key;
    const found = cursorAt(value, key);
    if (found) return { ...found, path: here };
  }
  for (const key of ["pagination", "meta", "paging", ...ENVELOPE_KEYS]) {
    const found = cursorAtCommonKeys(value[key], path ? `${path}.${key}` : key, depth + 1);
    if (found) return found;
  }
  return null;
}

function readCursor(body: unknown, hints: ShapeHints): { found: CursorFound | null; strategy: CursorStrategy; hasMore: boolean | null } {
  let found: CursorFound | null = null;
  let strategy: CursorStrategy = "none";
  const hint = hints.cursorPath;
  if (typeof hint === "string" && hint !== "") {
    found = cursorAt(body, hint);
    if (found) strategy = "cursor_path";
  }
  if (!found && hints.example !== undefined && hints.example !== null) {
    for (const p of findCursorPaths(hints.example)) {
      if (p === hint) continue;
      found = cursorAt(body, p);
      if (found) { strategy = "example"; break; }
    }
  }
  if (!found) {
    found = cursorAtCommonKeys(body, "", 0);
    if (found) strategy = "common_keys";
  }
  const container = found ? found.path.split(".").slice(0, -1).join(".") : "";
  let hasMore = hasMoreAt(body, container);
  if (hasMore === null && typeof hint === "string" && /has_?more/i.test(hint)) {
    const flag = toBool(getPath(body, hint));
    if (flag !== undefined) hasMore = flag;
  }
  // a cursor beside «has_more: false» is a position, not a next page
  if (found && hasMore === false) return { found: null, strategy: "none", hasMore };
  return { found, strategy: found ? strategy : "none", hasMore };
}

const BOOL_NAME = /^(?:is|has|can|was|should)[A-Z_]/;
const COUNT_NAME = /(?:count|likes|views|replies|retweets|quotes|bookmarks|followers|following|shares|size|total)$/i;
const TIME_NAME = /(?:Utc|utc|_at|At|Time|time|Timestamp|timestamp|Date|date)$/;

function coerceValue(key: string, value: unknown, declared: string | undefined, counts: Record<string, number>, bad: Record<string, number>): unknown {
  // a field the example held as null has no declared type worth trusting: its NAME decides, as for a field the catalog does not list
  const trusted = declared === "null" ? undefined : declared;
  const type = trusted ?? (BOOL_NAME.test(key) ? "boolean" : COUNT_NAME.test(key) ? "number" : TIME_NAME.test(key) ? "unix-time" : undefined);
  if (!type || value === null || value === undefined) return value;
  // a time with no declared type is read only when it is Unix seconds or milliseconds written as text (a date text stays text)
  if (type === "unix-time") {
    if (typeof value === "string" && /^\d{9,13}$/.test(value.trim())) { counts[key] = (counts[key] ?? 0) + 1; return Number(value); }
    return value;
  }
  const note = (map: Record<string, number>) => { map[key] = (map[key] ?? 0) + 1; };
  if (type === "boolean") {
    if (typeof value === "boolean") return value;
    const b = toBool(value);
    if (b !== undefined) { note(counts); return b; }
    if (trusted) note(bad);
    return value;
  }
  if (type === "number") {
    if (typeof value === "number") return value;
    if (typeof value === "string") {
      // a Unix time written as text is read as a number (seconds stay seconds; the date reader decides), a count with a thousands separator too
      const n = toNumber(value);
      if (n !== undefined && Math.abs(n) <= Number.MAX_SAFE_INTEGER) { note(counts); return n; }
      if (trusted) note(bad);
    }
    return value;
  }
  if (type === "string") {
    if (typeof value === "number" || typeof value === "bigint") { note(counts); return String(value); }
    return value;
  }
  return value;
}

/** A row with its values read as the catalog declares them (the keys of the row are never added or dropped). */
export function coerceRow(row: Obj, itemFields: Record<string, { type: string }> | null | undefined, counts: Record<string, number> = {}, bad: Record<string, number> = {}): Obj {
  const out: Obj = {};
  for (const [key, value] of Object.entries(row)) out[key] = coerceValue(key, value, itemFields?.[key]?.type, counts, bad);
  return out;
}

/** Unix seconds (a number or a numeric text) as epoch milliseconds, or undefined. Re-exported for the callers that read a date from a coerced row. */
export const readEpochMs = toEpochMs;

export function readShape(body: unknown, hints: ShapeHints = {}): ShapeReading {
  const list = readList(body, hints);
  const cursor = readCursor(body, hints);
  const coercions: Record<string, number> = {};
  const unreadable: Record<string, number> = {};
  const rows = list.rows.map((row) => coerceRow(row, hints.itemFields, coercions, unreadable));
  return {
    rows,
    listPath: list.path,
    listStrategy: list.strategy,
    nextCursor: cursor.found?.value ?? null,
    cursorPath: cursor.found?.path ?? null,
    cursorStrategy: cursor.strategy,
    cursorKind: cursor.found?.kind ?? null,
    hasMore: cursor.hasMore,
    coercions,
    unreadable,
    warnings: list.warnings,
  };
}
