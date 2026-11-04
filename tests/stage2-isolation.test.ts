import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * STAGE 2 (docs/STAGE-2.md): nothing in this branch changes what a customer sees while the flags are off. Proof by the import graph: only the WIRING files below import a Stage 2
 * module, and each of them reads a `DIGER_STAGE2_*` flag (off when unset) before it does anything new. A new importer must be added here on purpose, with its own flag test.
 */
const WIRING: ReadonlyArray<string> = [
  "agent/src/compiled.ts", // S2/S5: applies the card edits it is GIVEN and asks the Stage 2 cards only when told (`questionCards`)
  "agent/src/runMission.ts", // S2/S5/S6: the edits only when DIGER_STAGE2_ASK_CARD is on; the question cards only when DIGER_STAGE2_QUESTION_CARDS is on; live snapshots only when DIGER_STAGE2_LIVE_SHEET is on
  "src/app/api/missions/[id]/route.ts", // S3/S4: «ask_edit» answers 404 and the GET sends no «askCard» unless DIGER_STAGE2_ASK_CARD is on for the viewer
  "src/components/mission/AskCard.tsx", // S4: draws only the card the server sent
  "src/components/mission/AgentMissionCard.tsx", // S4: shows the card only when the answer carries it and the page asked for Stage 2 (the requests page)
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

describe("Stage 2 modules are reached by tests only", () => {
  it("no file of src/ or agent/src/ outside the stage2 folders imports a stage2 module, except the listed wiring files", () => {
    const prod = [...files(path.join(ROOT, "src")), ...files(path.join(ROOT, "agent", "src"))].filter((f) => !f.includes(`${path.sep}stage2${path.sep}`));
    const importers = prod.filter((f) => /from\s+["'][^"']*\/stage2\/[^"']+["']|import\(\s*["'][^"']*\/stage2\//.test(readFileSync(f, "utf8")));
    expect(importers.map((f) => path.relative(ROOT, f).split(path.sep).join("/")).sort()).toEqual([...WIRING].sort());
  });
});
