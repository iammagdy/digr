/**
 * Tolerant readers of provider values. A provider documents one type and sends another (anyapi.x.user.posts: the catalog example has `isReply` as a
 * boolean and `createdUtc` as an integer; the live rows carry the TEXT «True» / «False» and Unix seconds as a TEXT). Every reader below accepts the real
 * boolean or number, and the text forms, and answers `undefined` for anything else: a value that cannot be read is NEVER turned into a guess.
 * Pure module: no server imports.
 */

/** A boolean from `true`/`false`, `1`/`0`, and the text «true»/«false»/«1»/«0»/«yes»/«no» in any letter case (blanks around it ignored). Anything else: undefined. */
export function toBool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1 ? true : value === 0 ? false : undefined;
  if (typeof value !== "string") return undefined;
  const text = value.trim().toLowerCase();
  if (text === "true" || text === "1" || text === "yes") return true;
  if (text === "false" || text === "0" || text === "no") return false;
  return undefined;
}

/** True only when the value reads as true (a flag that is missing or unreadable is not set). */
export function isTrueFlag(value: unknown): boolean {
  return toBool(value) === true;
}

/** A finite number from a number or a numeric text («1792308962», «1,250», «٣٠»); anything else undefined. */
export function toNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const text = value
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[,\s]/g, "")
    .trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(text)) return undefined;
  const n = Number(text);
  return Number.isFinite(n) ? n : undefined;
}

/** Milliseconds since the epoch from Unix seconds or milliseconds, as a number or a numeric text; undefined when it is not a plausible timestamp. */
export function toEpochMs(value: unknown): number | undefined {
  const n = toNumber(value);
  if (n === undefined || n <= 0) return undefined;
  const ms = n < 1e11 ? n * 1000 : n;
  // 1990-01-01 .. 2100-01-01: a count or an id is not a date
  if (ms < 631_152_000_000 || ms > 4_102_444_800_000) return undefined;
  return Math.round(ms);
}

/** An ISO-8601 UTC timestamp (to the second) from an epoch value, or from an ISO text; undefined otherwise. */
export function toIsoTimestamp(value: unknown): string | undefined {
  const ms = toEpochMs(value);
  if (ms !== undefined) return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}/.test(text)) return undefined;
  const t = Date.parse(text.length === 10 ? `${text}T00:00:00Z` : text);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");
}
