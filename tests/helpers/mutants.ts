import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * MUTATION HELPER (safety round). A protection is only proved if the tests FAIL when it is removed. This loads a copy of a source file with ONE exact text edit applied (the edit must match exactly once, so a refactor that moves the guard breaks the mutation test instead of silently
 * passing), under `tests/.mutants/`, with its relative imports pointed at the original sources (or at another mutant, through `rewire`). The copies are deleted after the run. Nothing here is imported by production code.
 */
const ROOT = resolve(process.cwd());
const DIR = join(ROOT, "tests", ".mutants");
let counter = 0;

export interface Mutation { from: string; to: string }
export async function loadMutant<T = any>(file: string, edits: ReadonlyArray<Mutation>, rewire: Readonly<Record<string, string>> = {}): Promise<{ module: T; path: string }> {
  const source = resolve(ROOT, file);
  let text = readFileSync(source, "utf8");
  for (const e of edits) {
    const first = text.indexOf(e.from);
    if (first < 0) throw new Error(`mutation target not found in ${file}: ${e.from.slice(0, 80)}`);
    if (text.indexOf(e.from, first + 1) >= 0) throw new Error(`mutation target is not unique in ${file}: ${e.from.slice(0, 80)}`);
    text = text.replace(e.from, () => e.to);
  }
  // relative imports -> absolute paths of the originals (or the given mutant)
  text = text.replace(/from\s+"(\.{1,2}\/[^"]+)"/g, (_m, spec: string) => {
    if (rewire[spec]) return `from "${rewire[spec]}"`;
    return `from "${resolve(dirname(source), spec)}"`;
  });
  mkdirSync(DIR, { recursive: true });
  counter += 1;
  const path = join(DIR, `m${counter}_${file.split("/").pop()!.replace(/\.ts$/, "")}.mutant.ts`);
  writeFileSync(path, text);
  return { module: (await import(/* @vite-ignore */ path)) as T, path };
}
export const cleanMutants = (): void => { rmSync(DIR, { recursive: true, force: true }); };
