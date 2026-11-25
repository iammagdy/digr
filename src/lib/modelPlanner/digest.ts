import type { CatalogEndpoint } from "../treg/catalog";
import { getPath, hintsOf, looksLikeOneRecord, missionPageOf, pageInputValue, readShape, type MissionPageMetadata, type ShapeReading } from "../treg/shapeReader";
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

const MASKED = /^<\s*omitted[^>]*>$/i;

export interface BuildShapeDigestOptions {
  /** Explicit opt-in for Stage 4 single-cell reread (agent/src/stage4/rereadRun.ts) to read unreviewed singleton answers. */
  allowSingleRecordLookup?: boolean;
  /** Replay/fixture mode: masked placeholders are not flagged malformed. */
  isReplay?: boolean;
  /** Explicit opt-in for approved legacy fixture envelope compatibility ({ output: { data: { items: [...] } } }). Default false. */
  allowLegacyEnvelope?: boolean;
}

interface LegacyArrayEnvelopeResult {
  rows: Obj[];
  path: string;
  nextCursor: string | null;
  cursorPath: string | null;
}

function extractLegacyArrayEnvelope(
  body: unknown,
  mp: MissionPageMetadata,
  isReplay?: boolean,
): LegacyArrayEnvelopeResult | null {
  if (!isObj(body)) return null;

  // 1. Declared list must be ABSENT (present-but-malformed e.g. [42] or [] or null -> 0 rows, rejected)
  const rawList = getPath(body, mp.listPath);
  if (rawList !== undefined) return null;

  // 2. Reject validated terminal responses
  if (mp.nilMarkerPath && isObj(getPath(body, mp.nilMarkerPath))) return null;
  if (mp.terminalFlag && getPath(body, mp.terminalFlag.path) === mp.terminalFlag.equals) return null;
  if (mp.hasMorePath) {
    const rawMore = getPath(body, mp.hasMorePath);
    if (rawMore === false || rawMore === 0 || rawMore === "0" || rawMore === "false" || rawMore === "False") {
      return null;
    }
  }

  // 3. Reject malformed cursors on the declared cursor path
  if (mp.nextPath) {
    const rawNext = getPath(body, mp.nextPath);
    if (rawNext !== undefined && rawNext !== null) {
      const parsed = pageInputValue(rawNext, mp);
      if (parsed === null) {
        if (!isReplay || typeof rawNext !== "string" || !MASKED.test(rawNext.trim())) return null;
      }
    }
  }

  // 4. Must match approved alternate envelope: { output: { data: { items: [...] } } } or { output: { items: [...] } }
  const output = (body as Record<string, unknown>).output;
  if (!isObj(output)) return null;
  const data = (output as Record<string, unknown>).data;
  let path: string | null = null;
  let list: unknown = null;

  const dataItems = isObj(data) ? (data as Record<string, unknown>).items : undefined;
  const outputItems = (output as Record<string, unknown>).items;

  if (Array.isArray(dataItems) && dataItems.length > 0 && dataItems.every(isObj)) {
    path = "output.data.items";
    list = dataItems;
  } else if (Array.isArray(outputItems) && outputItems.length > 0 && outputItems.every(isObj)) {
    path = "output.items";
    list = outputItems;
  }
  if (!path || !list) return null;

  // 5. Check cursor in envelope (if present)
  let nextCursor: string | null = null;
  let cursorPath: string | null = null;
  const altNext = (mp.nextPath ? getPath(body, mp.nextPath) : undefined)
    ?? (isObj(data) ? (data as Record<string, unknown>).nextCursor ?? (data as Record<string, unknown>).cursor : undefined)
    ?? (output as Record<string, unknown>).nextCursor
    ?? (output as Record<string, unknown>).cursor;

  if (altNext !== undefined && altNext !== null) {
    const parsed = pageInputValue(altNext, mp);
    if (parsed === null) {
      if (!isReplay || typeof altNext !== "string" || !MASKED.test(altNext.trim())) return null;
    } else {
      nextCursor = String(parsed);
      cursorPath = mp.nextPath && getPath(body, mp.nextPath) !== undefined
        ? mp.nextPath
        : isObj(data) && ((data as Record<string, unknown>).nextCursor !== undefined || (data as Record<string, unknown>).cursor !== undefined)
          ? ((data as Record<string, unknown>).nextCursor !== undefined ? "output.data.nextCursor" : "output.data.cursor")
          : ((output as Record<string, unknown>).nextCursor !== undefined ? "output.nextCursor" : "output.cursor");
    }
  }

  return { rows: list as Obj[], path, nextCursor, cursorPath };
}

/** What a REAL answer looks like, read with the shape reader and the catalog's own hints: for the model's field map and for the code's check of it. */
export function buildShapeDigest(
  body: unknown,
  endpoint: Pick<CatalogEndpoint, "list_path" | "cursor_path" | "example_response_trimmed" | "item_fields"> & { id?: string; kind?: CatalogEndpoint["kind"] | null },
  options?: BuildShapeDigestOptions,
): { digest: ShapeDigest; reading: ShapeReading } {
  const missionPage = endpoint.id ? missionPageOf(endpoint.id) : undefined;
  const noList = !missionPage && (!endpoint.list_path || endpoint.list_path === "NOT FOUND");
  const isReplay = Boolean(options?.isReplay);
  let reading = readShape(body, {
    ...hintsOf(endpoint),
    ...(missionPage ? { missionPage } : {}),
    ...(noList ? { rootObjectIsRow: true } : {}),
    ...(isReplay ? { isReplay: true } : {}),
  });

  // Stage 4 single-cell reread (agent/src/stage4/rereadRun.ts): an explicit lookup-only opt-in for singleton compatibility
  if (options?.allowSingleRecordLookup && reading.rows.length === 0) {
    const unreviewed = readShape(body, { ...hintsOf(endpoint), rootObjectIsRow: true });
    if (unreviewed.rows.length > 0) {
      reading = unreviewed;
    }
  }

  // Legacy array envelope compatibility (e.g. foundation-flags-off fixture: { output: { data: { items: [...] } } })
  // Requires explicit opt-in, declared list absent, non-terminal, valid cursor, and binds directly to the validated alternate path
  if (options?.allowLegacyEnvelope && missionPage && reading.rows.length === 0) {
    const legacy = extractLegacyArrayEnvelope(body, missionPage, isReplay);
    if (legacy && legacy.rows.length > 0) {
      reading = {
        rows: legacy.rows,
        listPath: legacy.path,
        listStrategy: "common_keys",
        nextCursor: legacy.nextCursor,
        cursorPath: legacy.cursorPath,
        cursorStrategy: legacy.nextCursor !== null ? "common_keys" : "none",
        cursorKind: legacy.nextCursor !== null ? (/^\d+$/.test(legacy.nextCursor) ? "offset" : /^https?:\/\//i.test(legacy.nextCursor) ? "url" : "token") : null,
        hasMore: legacy.nextCursor !== null ? true : null,
        coercions: {},
        unreadable: {},
        warnings: [`list_path «${missionPage.listPath}» is not a list in this answer`],
      };
    }
  }

  // the catalog's list hint may be wrong for the live answer (a profile endpoint whose «list» is not there): an answer that is itself ONE record is ONE row, never an empty list
  if (!missionPage && reading.rows.length === 0 && reading.listStrategy === "none" && typeof body === "object" && body !== null && !Array.isArray(body) && looksLikeOneRecord(body as Record<string, unknown>)) {
    reading = readShape(body, { ...hintsOf(endpoint), rootObjectIsRow: true });
  }
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
export function digestFromCatalogExample(endpoint: Pick<CatalogEndpoint, "list_path" | "cursor_path" | "example_response_trimmed" | "item_fields"> & { id?: string; kind?: CatalogEndpoint["kind"] | null }): { digest: ShapeDigest; reading: ShapeReading } | null {
  if (endpoint.example_response_trimmed === undefined || endpoint.example_response_trimmed === null) return null;
  return buildShapeDigest(endpoint.example_response_trimmed, endpoint, { isReplay: true });
}
