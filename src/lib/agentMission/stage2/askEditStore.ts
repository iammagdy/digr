import { parseAskEdit, type AskEdit } from "./askCard";

/**
 * STAGE 2, WHERE THE CUSTOMER'S CARD EDITS ARE KEPT (docs/STAGE-2.md S2/S3): one create-only object per accepted edit in the mission's own storage folder, `ask_edits/e0001.json`,
 * `e0002.json`, ... (never overwritten, so a reader never sees a stale copy; no table, no column). The site writes them (the «ask_edit» action), the worker reads them all, in order, when it
 * plans the mission again. Pure helpers: names and parsing only.
 */
export const ASK_EDITS_FOLDER = "ask_edits";
const NAME = /^e(\d{4})\.json$/;

/** The path (inside the mission's folder) of the n-th edit. */
export const askEditPath = (n: number): string => `${ASK_EDITS_FOLDER}/e${String(Math.max(1, Math.floor(n))).padStart(4, "0")}.json`;

/** The number of the next edit, from the names already in the folder (bare names, «e0001.json», or full paths). */
export function nextAskEditIndex(names: ReadonlyArray<string>): number {
  let max = 0;
  for (const raw of names) { const m = NAME.exec(String(raw).split("/").pop() ?? ""); if (m) max = Math.max(max, Number(m[1])); }
  return max + 1;
}

/** The edits of a folder, in order, from (name, body) pairs: a body that is not a valid edit is skipped (it was checked when written). */
export function askEditsOf(files: ReadonlyArray<{ name: string; body: string | null }>): AskEdit[] {
  return [...files]
    .map((f) => ({ n: Number(NAME.exec(String(f.name).split("/").pop() ?? "")?.[1] ?? NaN), body: f.body }))
    .filter((f) => Number.isFinite(f.n) && f.body !== null)
    .sort((a, b) => a.n - b.n)
    .flatMap((f) => {
      try { const p = parseAskEdit(JSON.parse(f.body!)); return p.ok ? [p.edit] : []; } catch { return []; }
    });
}
