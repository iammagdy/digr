/**
 * A MAPPING MUST NOT CUT A TIME TO A DAY. The agent's mapping code turns the source's timestamp into a column; the live search-tweets mapping wrote
 *   date: new Date(r.createdUtc * 1000).toISOString().slice(0,10)
 * so the source's time of day («2026-10-29 17:21») was thrown away before the file existed, and the file showed the day only. The source gave the time; the file must keep it (Cairo time, written by dateCells.ts).
 *
 * Code repairs the three ways such a cut is written (`.toISOString().slice(0, 10)`, `.toISOString().substring(0, 10)`, `.toISOString().split('T')[0]`) by dropping the cut, and the repair is PROVEN before it is used: run on the very page the mapping was
 * measured on, the repaired code must give the same rows, and every value that changed must be the same day with a time added. A mapping that cuts a day in another way is left as it is (a source that gives a date only has no time to keep).
 * Pure: no I/O.
 */
const CUTS: ReadonlyArray<RegExp> = [
  /\.toISOString\(\)\s*\.slice\(\s*0\s*,\s*10\s*\)/g,
  /\.toISOString\(\)\s*\.substring\(\s*0\s*,\s*10\s*\)/g,
  /\.toISOString\(\)\s*\.split\(\s*(['"])T\1\s*\)\s*\[\s*0\s*\]/g,
];

/** The mapping code with the cut removed, or null when it has none. */
export function withoutDayCut(code: string): string | null {
  let out = code;
  for (const re of CUTS) out = out.replace(re, ".toISOString()");
  return out === code ? null : out;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_AND_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/** True when the repaired rows are the original rows, except that some day-only text gained a time of the same day. */
export function onlyTimesAdded(before: ReadonlyArray<Record<string, unknown>>, after: ReadonlyArray<Record<string, unknown>>): boolean {
  if (before.length !== after.length || before.length === 0) return false;
  let added = 0;
  let withTime = 0;
  for (let i = 0; i < before.length; i += 1) {
    const keys = new Set([...Object.keys(before[i]), ...Object.keys(after[i])]);
    for (const k of keys) {
      const a = before[i][k];
      const b = after[i][k];
      if (JSON.stringify(a) === JSON.stringify(b)) continue;
      if (typeof a === "string" && typeof b === "string" && DAY.test(a) && DAY_AND_TIME.test(b) && b.startsWith(a)) { added += 1; if (!/T00:00(?::00(?:\.0+)?)?(?:Z|[+-]00:?00)?$/.test(b)) withTime += 1; continue; }
      return false;
    }
  }
  // a time that is midnight on every row was never in the source (a day computed from «20 hours ago» is a day, not a moment): the cut is kept, never a made-up time of day
  return added > 0 && withTime * 2 >= added;
}
