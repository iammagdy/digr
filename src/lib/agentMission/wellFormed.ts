/**
 * ROUND 19 (4 Nov 2026), THE TEXT THAT REACHES THE DATABASE IS ALWAYS WELL FORMED. The database's REST layer parses the body of every write as strict JSON and answers «Empty or invalid json» (400) for a body it cannot parse.
 * A string that holds half of an emoji (a UTF-16 surrogate with no partner: a provider's own text cut in the middle of a pair, or one of our own `slice` cuts) is written by `JSON.stringify` as a lone `\udXXX` escape, which that parser refuses,
 * and the plan, an event or a call row carrying it could never be saved. A NUL character (`\u0000`) cannot be stored in a text or JSON column either. Both are replaced here, at the one place every store write passes through:
 * a lone surrogate becomes U+FFFD, a NUL is dropped. Pure, no I/O; numbers, booleans, nulls and the shape of the value are untouched.
 */
// eslint-disable-next-line no-control-regex
const BAD = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|\u0000/;
// eslint-disable-next-line no-control-regex
const BAD_G = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|\u0000/g;

/** One string, repaired (the same string object when nothing is wrong). */
export function wellFormedText(s: string): string {
  return BAD.test(s) ? s.replace(BAD_G, (m) => (m === "\u0000" ? "" : "�")) : s;
}

/** A copy of `value` with every string repaired (objects and arrays are copied only where something below them changed). */
export function wellFormedDeep<T>(value: T, depth = 0): T {
  if (typeof value === "string") return wellFormedText(value) as unknown as T;
  if (value === null || typeof value !== "object" || depth > 64) return value;
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((v) => { const r = wellFormedDeep(v, depth + 1); if (r !== v) changed = true; return r; });
    return (changed ? out : value) as unknown as T;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const key = wellFormedText(k);
    const r = wellFormedDeep(v, depth + 1);
    if (r !== v || key !== k) changed = true;
    out[key] = r;
  }
  return (changed ? out : value) as T;
}

/** The paths (keys only, never the text) of the first strings that need repair: what the worker logs when it repaired something, so a recurrence shows WHERE the text came from. */
export function illFormedPaths(value: unknown, limit = 5): string[] {
  const out: string[] = [];
  const walk = (v: unknown, path: string, depth: number): void => {
    if (out.length >= limit || depth > 64) return;
    if (typeof v === "string") { if (BAD.test(v)) out.push(path); return; }
    if (v === null || typeof v !== "object") return;
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${path}.${i}`, depth + 1)); return; }
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) { if (BAD.test(k)) out.push(`${path}.<key>`); walk(x, `${path}.${k}`, depth + 1); }
  };
  walk(value, "", 0);
  return out.map((p) => p.replace(/^\./, "") || "(root)");
}
