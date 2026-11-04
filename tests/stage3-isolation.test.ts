import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * STAGE 3 (docs/STAGE-3.md): nothing in this branch changes what a customer sees while the flags are off. Proof by the import graph: only the WIRING files below import a Stage 3 module,
 * and each of them reads a `DIGER_STAGE3_*` flag (off when unset) before it does anything new. A new importer must be added here on purpose, with its own flag test.
 */
const WIRING: ReadonlyArray<string> = [
  "src/lib/agentMission/customerView.ts", // S5: the new queue line only when the loader passes `stage3Queue` (DIGER_STAGE3_QUEUE on)
  "src/lib/agentMission/customerActions.ts", // S5: reads approved_at and passes `stage3Queue` only when DIGER_STAGE3_QUEUE is on
];
const ROOT = path.resolve(__dirname, "..");
function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (/\.(ts|tsx|mjs|js)$/.test(name)) out.push(p);
  }
  return out;
}

describe("Stage 3 modules are reached by tests only", () => {
  it("no file of src/ or agent/src/ outside the stage3 folders imports a stage3 module, except the listed wiring files", () => {
    const prod = [...files(path.join(ROOT, "src")), ...files(path.join(ROOT, "agent", "src"))].filter((f) => !f.includes(`${path.sep}stage3${path.sep}`));
    const importers = prod.filter((f) => /from\s+["'][^"']*\/stage3\/[^"']+["']|import\(\s*["'][^"']*\/stage3\//.test(readFileSync(f, "utf8")));
    expect(importers.map((f) => path.relative(ROOT, f).split(path.sep).join("/")).sort()).toEqual([...WIRING].sort());
  });
});
