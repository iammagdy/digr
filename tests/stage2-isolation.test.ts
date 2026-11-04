import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * STAGE 2 (docs/STAGE-2.md): nothing in this branch changes what a customer sees while the flags are off. Proof by the import graph: no production file outside the Stage 2 folders imports
 * a Stage 2 module, so no customer path can reach it until the wiring (docs/STAGE-2.md, «Left for Sonnet») is added behind `DIGER_STAGE2_*`.
 */
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

describe("Stage 2 modules are reached by tests only", () => {
  it("no file of src/ or agent/src/ outside the stage2 folders imports a stage2 module", () => {
    const prod = [...files(path.join(ROOT, "src")), ...files(path.join(ROOT, "agent", "src"))].filter((f) => !f.includes(`${path.sep}stage2${path.sep}`));
    const importers = prod.filter((f) => /from\s+["'][^"']*\/stage2\/[^"']+["']|import\(\s*["'][^"']*\/stage2\//.test(readFileSync(f, "utf8")));
    expect(importers.map((f) => path.relative(ROOT, f))).toEqual([]);
  });
});
