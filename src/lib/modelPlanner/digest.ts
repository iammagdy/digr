import type { CatalogEndpoint } from "../treg/catalog";
import { hintsOf, readShape, type ShapeReading } from "../treg/shapeReader";
import { maskText } from "../server/rawCapture";
import { DIGEST_VALUE_CHARS, SAMPLE_ROWS_IN_DIGEST } from "./constants";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** One field of a row as the model sees it: where it is, what type it holds in the sample, how many rows carry it, and one truncated example. */
export interface DigestField { path: string; type: string; presentIn: number; example: string }

export interface ShapeDigest {
  rowsInSample: number;
  listPath: string | null;
  listStrategy: ShapeReading["listStrategy"];
  nextCursorPath: string | null;
  cursorKind: ShapeReading["cursorKind"];
  hasMore: boolean | null;
  fields: DigestField[];
  /** Up to three rows, masked and truncated. */
  sampleRows: Obj[];
  warnings: string[];
}

const typeOf = (v: unknown): string => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

/** A value for the model: masked (emails, phones), cut, and flat (objects as «{…n keys}»). */
export function digestValue(v: unknown): unknown {
  if (typeof v === "string") { const m = maskText(v); return m.length > DIGEST_VALUE_CHARS ? `${m.slice(0, DIGEST_VALUE_CHARS)}…` : m; }
  if (Array.isArray(v)) return v.slice(0, 3).map(digestValue);
  if (isObj(v)) return Object.fromEntries(Object.entries(v).slice(0, 12).map(([k, x]) => [k, digestValue(x)]));
  return v;
}

const isEmptyValue = (v: unknown) => v === null || v === undefined || v === "";

/** Fields of the rows down to two levels («user.screen_name»), at most 60 of them: type, number of rows that carry a value, one truncated example. */
export function digestFields(rows: ReadonlyArray<Obj>): DigestField[] {
  const stats = new Map<string, { type: string; present: number; example: unknown }>();
  const note = (path: string, value: unknown) => {
    const t = typeOf(value);
    const prior = stats.get(path);
    if (!prior) { stats.set(path, { type: t, present: isEmptyValue(value) ? 0 : 1, example: value }); return; }
    if (prior.type === "null" && t !== "null") prior.type = t;
    if (!isEmptyValue(value)) { prior.present += 1; if (isEmptyValue(prior.example)) prior.example = value; }
  };
  const flatten = (value: unknown, path: string, depth: number) => {
    if (isObj(value) && depth < 2 && Object.keys(value).length > 0) { for (const [k, child] of Object.entries(value)) flatten(child, path ? `${path}.${k}` : k, depth + 1); return; }
    if (path) note(path, value);
  };
  for (const row of rows) flatten(row, "", 0);
  return [...stats.entries()].slice(0, 60).map(([path, s]) => ({
    path, type: s.type, presentIn: s.present,
    example: (typeof s.example === "string" ? String(digestValue(s.example)) : JSON.stringify(digestValue(s.example)) ?? "").slice(0, DIGEST_VALUE_CHARS),
  }));
}

/** What a REAL answer looks like, read with the shape reader and the catalog's own hints: for the model's field map and for the code's check of it. */
export function buildShapeDigest(body: unknown, endpoint: Pick<CatalogEndpoint, "list_path" | "cursor_path" | "example_response_trimmed" | "item_fields">): { digest: ShapeDigest; reading: ShapeReading } {
  const noList = !endpoint.list_path || endpoint.list_path === "NOT FOUND";
  const reading = readShape(body, { ...hintsOf(endpoint), ...(noList ? { rootObjectIsRow: true } : {}) });
  const digest: ShapeDigest = {
    rowsInSample: reading.rows.length,
    listPath: reading.listPath,
    listStrategy: reading.listStrategy,
    nextCursorPath: reading.cursorPath,
    cursorKind: reading.cursorKind,
    hasMore: reading.hasMore,
    fields: digestFields(reading.rows),
    sampleRows: reading.rows.slice(0, SAMPLE_ROWS_IN_DIGEST).map((r) => digestValue(r) as Obj),
    warnings: reading.warnings,
  };
  return { digest, reading };
}

/** The same digest made from the catalog's trimmed EXAMPLE answer, for an endpoint nobody sampled (a recipe, a sensitive endpoint that is never sampled). */
export function digestFromCatalogExample(endpoint: Pick<CatalogEndpoint, "list_path" | "cursor_path" | "example_response_trimmed" | "item_fields">): { digest: ShapeDigest; reading: ShapeReading } | null {
  if (endpoint.example_response_trimmed === undefined || endpoint.example_response_trimmed === null) return null;
  return buildShapeDigest(endpoint.example_response_trimmed, endpoint);
}
