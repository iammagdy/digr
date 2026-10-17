/**
 * Finds the result list inside a provider response, whatever envelope it arrives in.
 *
 * Catalog services answer in several shapes: a routed service wraps its answer as
 * `{ output, raw, _treg }`, aggregators send `{ code, data: { comments: [...] } }`, recipe services
 * send `{ ok, rows: [...] }`, and older ones put the list at the top level. One reader serves all of
 * them so a valid answer is never mistaken for "no data" or, worse, read as a single junk row.
 */

/** Keys that wrap the real answer; they are opened, never read as a row. */
const ENVELOPE_KEYS = ["output", "data", "result", "response", "payload", "raw", "body"] as const;

/** Keys that hold the list of records, in priority order. */
export const RESULT_LIST_KEYS = [
  "comments",
  "replies",
  "rows",
  "items",
  "results",
  "records",
  "videos",
  "posts",
  "tweets",
  "users",
  "people",
  "companies",
  "leads",
  "entries",
  "hashtags",
  "keywords",
  "reviews",
  "messages",
  "aweme_list",
  "videoList",
  "list",
] as const;

const MAX_ENVELOPE_DEPTH = 4;

export interface ProviderResultList {
  /** The list found (empty when the provider answered with a valid empty list). */
  list: any[];
  /** The key that held it, or null when the answer itself was the list. */
  key: string | null;
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isRecordList(value: unknown): value is any[] {
  return Array.isArray(value) && value.every((item) => item === null || typeof item === "object");
}

/**
 * Walks the envelope chain and returns the record list, or null when the response carries no list
 * at all (which is a different situation from a list that is empty).
 */
export function findProviderResultList(value: unknown, depth = 0): ProviderResultList | null {
  if (Array.isArray(value)) return isRecordList(value) ? { list: value, key: null } : null;
  if (!isPlainObject(value) || depth > MAX_ENVELOPE_DEPTH) return null;

  // 1. A named list at this level.
  let emptyNamedList: ProviderResultList | null = null;
  for (const key of RESULT_LIST_KEYS) {
    const candidate = value[key];
    if (isRecordList(candidate)) {
      if (candidate.length > 0) return { list: candidate, key };
      emptyNamedList = emptyNamedList || { list: candidate, key };
    }
  }

  // 2. An envelope that holds the answer one level deeper.
  for (const key of ENVELOPE_KEYS) {
    const inner = value[key];
    if (Array.isArray(inner)) {
      if (isRecordList(inner) && inner.length > 0) return { list: inner, key };
      if (isRecordList(inner) && !emptyNamedList) emptyNamedList = { list: inner, key };
      continue;
    }
    if (isPlainObject(inner)) {
      const found = findProviderResultList(inner, depth + 1);
      if (found && found.list.length > 0) return found;
      if (found && !emptyNamedList) emptyNamedList = found;
    }
  }

  // 3. Any list of objects at this level (a service with its own key name).
  for (const [key, candidate] of Object.entries(value)) {
    if (Array.isArray(candidate) && candidate.length > 0 && typeof candidate[0] === "object" && candidate[0] !== null) {
      return { list: candidate, key };
    }
  }

  return emptyNamedList;
}

/** First non-empty cursor found at a known place in the answer, through any envelope. */
export function findProviderNextCursor(value: unknown, depth = 0): string | null {
  if (!isPlainObject(value) || depth > MAX_ENVELOPE_DEPTH) return null;
  const cursorKeys = ["next_cursor", "nextCursor", "cursor", "next_max_id", "max_cursor", "next_page_token", "continuation", "continuation_token"];
  for (const key of cursorKeys) {
    const candidate = value[key];
    if ((typeof candidate === "string" && candidate !== "") || (typeof candidate === "number" && Number.isFinite(candidate))) {
      // `has_more: false` next to a numeric cursor means the cursor is a position, not a next page.
      if (value.has_more === false || value.has_more === 0) return null;
      return String(candidate);
    }
  }
  for (const key of ["pagination", "meta", "paging", ...ENVELOPE_KEYS]) {
    const found = findProviderNextCursor(value[key], depth + 1);
    if (found) return found;
  }
  return null;
}
