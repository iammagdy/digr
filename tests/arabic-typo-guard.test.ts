import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { platformCostNotesAr } from "../src/lib/agentMission/platformNotes";

/**
 * S1 LIVE FINDINGS fix 6 (docs/S1-LIVE-FINDINGS.md section 6, item 8): the reviewer reported «والقزار لك» on the plan card of the Facebook mission. The investigation found the misspelling NOWHERE: not in the repository and not in any stored plan, event or message of the live
 * database; the code sentence is «والقرار لك». This is a GUARD, not a fix of a code line: it fails if the misspelling is ever written into a customer-facing string, and pins the correct sentence.
 */
const walk = (dir: string, out: string[] = []): string[] => {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|md|json|txt)$/.test(name)) out.push(p);
  }
  return out;
};

describe("the Facebook cost sentence", () => {
  it("reads «والقرار لك» (decision) and never «والقزار»", () => {
    const notes = platformCostNotesAr([{ endpoint_id: "anyapi.facebook.user.posts" }]);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("والقرار لك");
    expect(notes[0]).not.toContain("القزار");
  });
  it("no source, prompt or data file of the product contains the misspelling", () => {
    const roots = ["src", "agent/src", "agent/prompts"];
    const hits = roots.flatMap((r) => walk(r)).filter((f) => readFileSync(f, "utf8").includes("القزار"));
    expect(hits).toEqual([]);
  });
});
