import { toBool, toEpochMs, toNumber } from "../coerce";
import type { CatalogEndpoint } from "./catalog";
import providerMetadata from "../../../data/capabilities/provider-metadata.json";

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

export interface MissionPageMetadata {
  listPath: string;
  nextPath: string;
  cursorParam: string;
  cursorType: "string" | "integer";
  hasMorePath?: string;
  nilMarkerPath?: string;
  terminalFlag?: { path: string; equals: string | number | boolean };
  preferForCount?: boolean;
}

export function missionPageOf(endpointId: string): MissionPageMetadata | undefined {
  const contract = (providerMetadata as any)?.treg?.contracts?.[endpointId];
  return contract?.missionPage;
}

export function pageInputValue(cursor: unknown, contract: MissionPageMetadata): string | number | null {
  if (contract.cursorType === "string") {
    if (typeof cursor !== "string") return null;
    const text = cursor.trim();
    return text && !/^(null|undefined)$/i.test(text) && !MASKED.test(text) && !/^https?:\/\//i.test(text) ? cursor : null;
  }
  if (typeof cursor !== "string" && typeof cursor !== "number") return null;
  if (!/^\d+$/.test(String(cursor).trim())) return null;
  const n = Number(cursor);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

export type ListStrategy = "list_path" | "declared_missing" | "example" | "common_keys" | "inferred_list" | "single_object" | "root_object" | "none";
export type CursorStrategy = "cursor_path" | "example" | "common_keys" | "none";

export interface ShapeHints {
  id?: string;
  missionPage?: MissionPageMetadata;
  listPath?: string | null;
  cursorPath?: string | null;
  example?: unknown;
  itemFields?: Record<string, { type: string }> | null;
  /** The endpoint answers ONE record as the answer itself (no list, no envelope): the whole answer is the row. Set by a caller that knows the endpoint has no list (the catalog's list path is null). */
  rootObjectIsRow?: boolean;
  /** Offline replay or catalog fixture mode: placeholder strings like «<omitted: ...>» are not flagged as malformed live cursors. */
  isReplay?: boolean;
  /** Opt-in (OFF by default): when `body` is a TREG routed envelope (`output` / `raw` / `_treg`), read rows ONLY from `body.output`; never fall back to `raw` or `_treg`. */
  routedOutputOnly?: boolean;
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

export const hintsOf = (endpoint: Pick<CatalogEndpoint, "list_path" | "cursor_path" | "example_response_trimmed" | "item_fields"> & { id?: string }): ShapeHints => ({
  id: endpoint.id,
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
  "reviews", "messages", "aweme_list", "videoList", "list", "elements", "organic_results", "ads", "products", "jobs", "listings",
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
      if (v.length > 0 && isObj(v[0])) {
        for (const [k, child] of Object.entries(v[0])) {
          walk(child, path ? `${path}.0.${k}` : `0.${k}`, depth + 2);
        }
      }
      return;
    }
    if (isObj(v)) for (const [k, child] of Object.entries(v)) walk(child, path ? `${path}.${k}` : k, depth + 1);
    if (Array.isArray(v)) {
      for (let i = 0; i < Math.min(v.length, 1); i++) {
        walk(v[i], path ? `${path}.${i}` : `${i}`, depth + 1);
      }
    }
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
  if (isObjectList(value)) {
    if (value.some((item) => Object.values(item).some(isObjectList))) return null;
    return { path: path || "root", rows: value };
  }
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
    if (isObjectList(v)) {
      if (v.some((item) => Object.values(item).some(isObjectList))) continue;
      return { path: path ? `${path}.${key}` : key, rows: v };
    }
  }
  return null;
}

const NO_LIST_PATH = new Set(["", "NOT FOUND", "NOT_FOUND"]);

/** Keys of an answer's wrapper (status, errors, usage meters): they never make an answer a record. */
const WRAPPER_KEYS = new Set(["ok", "success", "status", "code", "message", "message_zh", "msg", "error", "errors", "detail", "details", "meta", "usage", "version", "recipe", "warnings", "elapsed_ms", "from_cache", "cached", "request_id", "requestid", "trace_id", "cost", "credits", "credits_remaining", "credits_charged", "time", "time_stamp", "time_zone", "support", "docs", "router", "cache_url", "cache_message", "cache_message_zh", "job_id", "state", "ms", "count", "total"]);

/**
 * An answer that is itself ONE record (a profile, a company detail): an object with at least three non-empty plain values outside the wrapper keys, and no error. NOT part of the general
 * reader (which would read a status or a job answer as a record): a caller that SEES the answer (the sample call, whose rows the model checks) may ask for it.
 */
export function looksLikeOneRecord(body: Obj): boolean {
  const failed = ["error", "errors"].some((k) => body[k] !== undefined && body[k] !== null && body[k] !== false && body[k] !== "");
  if (failed) return false;
  let values = 0;
  for (const [k, v] of Object.entries(body)) {
    if (WRAPPER_KEYS.has(k.toLowerCase())) continue;
    if (typeof v === "string" ? v.trim() !== "" : typeof v === "number" || typeof v === "boolean") values += 1;
  }
  return values >= 3;
}


const ECHO_KEYS = new Set(["params", "request", "query", "input", "echo", "_request", "request_params", "requestparams"]);
const MASKED = /^<\s*omitted[^>]*>$/i;

interface ReviewedPageVerdict {
  hasMore: boolean | null;
  explicitNoMore: boolean;
  parsedNext: string | number | null;
  malformedNext: boolean;
  isTerminalWrapper: boolean;
  isTerminalCursor: boolean;
}

function evaluateReviewedPage(body: unknown, mp: MissionPageMetadata, rawList: unknown, isReplay?: boolean): ReviewedPageVerdict {
  let hasMore: boolean | null = null;
  let explicitNoMore = false;
  if (mp.hasMorePath) {
    const rawMore = getPath(body, mp.hasMorePath);
    if (rawMore === false || rawMore === 0 || rawMore === "0" || rawMore === "false" || rawMore === "False") {
      hasMore = false;
      explicitNoMore = true;
    } else if (rawMore === true || rawMore === 1 || rawMore === "1" || rawMore === "true" || rawMore === "True") {
      hasMore = true;
    }
  }
  const rawNext = getPath(body, mp.nextPath);
  const parsedNext = pageInputValue(rawNext, mp);
  const cursorAbsentOrNull = rawNext === null || rawNext === undefined;
  const isMasked = typeof rawNext === "string" && MASKED.test(rawNext.trim());
  const malformedNext = !explicitNoMore && !cursorAbsentOrNull && (!isReplay || !isMasked) && parsedNext === null;
  const flagOk = mp.terminalFlag ? getPath(body, mp.terminalFlag.path) === mp.terminalFlag.equals : true;
  const markerOk = Boolean(mp.nilMarkerPath && isObj(getPath(body, mp.nilMarkerPath)));
  const isTerminalWrapper =
    (rawList === null || rawList === undefined) &&
    !malformedNext &&
    markerOk &&
    flagOk &&
    (mp.hasMorePath ? explicitNoMore : cursorAbsentOrNull);
  const isEmptyDeclaredArray = Array.isArray(rawList) && rawList.length === 0 && !mp.hasMorePath && cursorAbsentOrNull && !malformedNext && flagOk;
  const isTerminalCursor = !malformedNext && (explicitNoMore || isTerminalWrapper || isEmptyDeclaredArray);
  if (isTerminalCursor && hasMore === null) hasMore = false;
  return { hasMore, explicitNoMore, parsedNext, malformedNext, isTerminalWrapper, isTerminalCursor };
}

const hasOwn = (o: Obj, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const ROUTED_RECORD_KEYS = new Set([
  "full_name", "first_name", "last_name", "name", "display_name", "person_name",
  "title", "job_title", "headline", "company", "company_name", "company_domain",
  "domain", "brand_name", "employer", "linkedin", "linkedin_url", "profile_url",
  "work_email", "personal_email", "email", "phone", "phone_number", "location",
]);

function readRoutedOutput(body: unknown, hints: ShapeHints, warnings: string[], asRows: (v: unknown) => Obj[] | null): { rows: Obj[]; path: string | null; strategy: ListStrategy; warnings: string[] } {
  if (!isObj(body)) return { rows: [], path: null, strategy: "none", warnings };
  if (!hasOwn(body, "output") && !hasOwn(body, "raw") && !hasOwn(body, "_treg")) {
    return readListDefault(body, hints, warnings, asRows);
  }
  const output = body.output;
  if (output === null || output === undefined) return { rows: [], path: null, strategy: "none", warnings };
  if (Array.isArray(output)) {
    const rows = asRows(output);
    return rows ? { rows, path: "output", strategy: "list_path", warnings } : { rows: [], path: null, strategy: "none", warnings };
  }
  if (!isObj(output) || Object.keys(output).length === 0) return { rows: [], path: null, strategy: "none", warnings };
  const hint = hints.listPath;
  if (typeof hint === "string" && (hint === "output" || hint.startsWith("output."))) {
    const rows = asRows(getPath(body, hint));
    if (rows) return { rows, path: hint, strategy: "list_path", warnings };
  }
  const looksLikeEntity = Object.keys(output).some((k) => ROUTED_RECORD_KEYS.has(k.toLowerCase()));
  if (!looksLikeEntity) {
    for (const key of LIST_KEYS) {
      const rows = asRows(output[key]);
      if (rows) return { rows, path: `output.${key}`, strategy: "common_keys", warnings };
    }
    for (const env of ["data", "result", "response"]) {
      const inner = output[env];
      if (!isObj(inner)) continue;
      for (const key of LIST_KEYS) {
        const rows = asRows(inner[key]);
        if (rows) return { rows, path: `output.${env}.${key}`, strategy: "common_keys", warnings };
      }
    }
    const candidates = findListPaths(output).filter((p) => !p.path.split(".").some((k) => ECHO_KEYS.has(k.toLowerCase())));
    const chosen = chooseResultList(candidates);
    if (chosen) {
      const rows = asRows(getPath(output, chosen));
      if (rows && rows.length > 0) return { rows, path: `output.${chosen}`, strategy: "inferred_list", warnings };
    }
  }
  return { rows: [output], path: "output", strategy: "single_object", warnings };
}

function readList(body: unknown, hints: ShapeHints): { rows: Obj[]; path: string | null; strategy: ListStrategy; warnings: string[] } {
  const warnings: string[] = [];
  const asRows = (v: unknown): Obj[] | null => (isObjectList(v) ? v : Array.isArray(v) && v.length === 0 ? [] : null);

  if (hints.missionPage) {
    const mp = hints.missionPage;
    const rawList = getPath(body, mp.listPath);
    const ev = evaluateReviewedPage(body, mp, rawList, hints.isReplay);
    if (Array.isArray(rawList)) {
      if (rawList.length === 0 || rawList.every(isObj)) {
        if (ev.malformedNext && rawList.length === 0) {
          return { rows: [], path: mp.listPath, strategy: "declared_missing", warnings: [`declared next_path «${mp.nextPath}» is malformed`] };
        }
        return { rows: rawList as Obj[], path: mp.listPath, strategy: "list_path", warnings: ev.malformedNext ? [`declared next_path «${mp.nextPath}» is malformed`] : [] };
      }
      return { rows: [], path: mp.listPath, strategy: "declared_missing", warnings: [`declared list_path «${mp.listPath}» contains non-object rows`] };
    }
    if (ev.isTerminalWrapper) {
      return { rows: [], path: mp.listPath, strategy: "list_path", warnings: [] };
    }
    return { rows: [], path: mp.listPath, strategy: "declared_missing", warnings: [`declared list_path «${mp.listPath}» is absent or malformed`] };
  }

  if (hints.routedOutputOnly) {
    return readRoutedOutput(body, hints, warnings, asRows);
  }
  return readListDefault(body, hints, warnings, asRows);
}

function readListDefault(body: unknown, hints: ShapeHints, warnings: string[], asRows: (v: unknown) => Obj[] | null): { rows: Obj[]; path: string | null; strategy: ListStrategy; warnings: string[] } {
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
  // 3b. inferred list: find list paths in the live response body (ignoring echo keys)
  const candidates = findListPaths(body).filter((p) => !p.path.split(".").some((k) => ECHO_KEYS.has(k.toLowerCase())));
  const chosen = chooseResultList(candidates);
  if (chosen) {
    const rows = asRows(getPath(body, chosen));
    if (rows && rows.length > 0) return { rows, path: chosen, strategy: "inferred_list", warnings };
  }
  // 4. one object that is the record
  if (isObj(body)) {
    for (const key of ["data", "user", "profile", "result", "output"]) {
      const v = body[key];
      if (isObj(v) && Object.keys(v).length > 0 && !Object.values(v).some(isObjectList)) return { rows: [v], path: key, strategy: "single_object", warnings };
    }
    for (const [key, v] of Object.entries(body)) {
      if (ECHO_KEYS.has(key.toLowerCase()) || WRAPPER_KEYS.has(key.toLowerCase())) continue;
      if (isObj(v) && looksLikeOneRecord(v) && !Object.values(v).some(isObjectList)) {
        return { rows: [v], path: key, strategy: "single_object", warnings };
      }
    }
  }
  // 5. an endpoint that answers one record as the answer itself
  if (isObj(body)) {
    if (hints.rootObjectIsRow && Object.values(body).some((v) => v !== null && v !== undefined && v !== "")) {
      return { rows: [body], path: "root", strategy: "root_object", warnings };
    }
    const noListHint = !hints.listPath || NO_LIST_PATH.has(hints.listPath);
    const noExample = hints.example === undefined || hints.example === null;
    if (noListHint && noExample && looksLikeOneRecord(body) && !Object.values(body).some(isObjectList)) {
      return { rows: [body], path: "root", strategy: "root_object", warnings };
    }
  }
  return { rows: [], path: null, strategy: "none", warnings };
}

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
  if (hints.missionPage) {
    const mp = hints.missionPage;
    const ev = evaluateReviewedPage(body, mp, getPath(body, mp.listPath), hints.isReplay);
    if (ev.malformedNext) return { found: null, strategy: "none", hasMore: null };
    if (ev.isTerminalCursor) return { found: null, strategy: "none", hasMore: false };
    if (ev.parsedNext === null) return { found: null, strategy: "none", hasMore: ev.hasMore };
    return {
      found: { value: String(ev.parsedNext), path: mp.nextPath, kind: mp.cursorType === "integer" ? "offset" : "token" },
      strategy: "cursor_path",
      hasMore: ev.hasMore,
    };
  }

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
  let cursor = readCursor(body, hints);
  if (list.strategy === "declared_missing") {
    cursor = { found: null, strategy: "none", hasMore: cursor.hasMore };
  }
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
