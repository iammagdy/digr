import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * STAGE 4 (docs/STAGE-4.md): nothing in this branch changes what a customer sees while the flags are off. Proof by the import graph: no production file outside the Stage 4 folders imports
 * a Stage 4 module EXCEPT the wiring files listed here, each of which reads its flag first (docs/STAGE-4.md section 8). A new importer is a failure until it is listed, reviewed and tested flags-off.
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

/** The wiring: S1 and S2 behind DIGER_STAGE4_VERSIONS (the worker's version 1; the list route and its page), and the worker's dispatch of an add-on row (no flag: see below). */
const WIRING = ["agent/src/main.ts", "agent/src/runMission.ts", "src/app/api/missions/[id]/versions/route.ts", "src/app/api/missions/[id]/file/route.ts", "src/app/api/missions/[id]/review-quote/route.ts", "src/app/api/missions/[id]/review-request/route.ts", "src/app/api/missions/[id]/addon-approval/route.ts", "src/app/api/missions/[id]/review-report/route.ts", "src/app/api/missions/[id]/edit-request/route.ts", "src/app/api/missions/[id]/workflow/route.ts", "src/components/mission/VersionList.tsx", "src/components/mission/ReviewQuote.tsx", "src/components/mission/ReviewReport.tsx", "src/components/mission/EditRequestCard.tsx", "src/components/mission/FileWorkflow.tsx"];
// MONEY PR 7c (2B-2 task 2): the review-price PREVIEW. The route reads DIGER_STAGE4_REVIEW FIRST (off: 404 before anyone is asked who they are); the component imports only the client-safe words and the click's helper and draws nothing while the
// route answers 404 (tests/stage4-review-quote.test.ts, tests/stage4-review-quote-ui.test.ts). Read-only: no hold, no charge.
// MONEY PR 7d (2B-2 task 3): the review REQUEST route (create, find again, cancel an unpaid request) reads DIGER_STAGE4_REVIEW FIRST as well (tests/stage4-review-request.test.ts); the component keeps importing only client-safe words and helpers.
// STAGE A: the review REPORT route reads DIGER_STAGE4_REVIEW FIRST (off: 404 before anyone is asked who they are) and is read-only; its component imports only the client-safe words and helpers and draws nothing while the route answers 404 (tests/stage4-review-report.test.ts, tests/stage4-review-report-ui.test.ts).
// STAGE B: the EDIT REQUEST route (quote, create and cancel an unpaid request; the editor's schema) reads DIGER_STAGE4_EDITS FIRST (off: 404 before anyone is asked who they are); its component imports only client-safe words, form and client helpers and draws nothing while the route answers 404 (tests/stage4-edit-request.test.ts, tests/stage4-edit-request-ui.test.ts).
// STAGE C: the file WORKFLOW status route reads DIGER_STAGE4_REVIEW or DIGER_STAGE4_EDITS FIRST (both off: 404 before anyone is asked who they are) and is read-only; its component imports only the client-safe words and client and draws nothing while the route answers 404 (tests/stage4-file-workflow.test.ts, tests/stage4-file-workflow-ui.test.ts).
// src/app/api/missions/[id]/file/route.ts (MONEY PR 7b, 2B-2 task 1): a request with `?version=N` is the customer's download of one published version. It reads DIGER_STAGE4_VERSIONS FIRST (off: 404 before anyone is asked who they are);
// a request without `version` never reaches a Stage 4 module (tests/stage4-version-download.test.ts proves the same answers flag off and on).
// agent/src/main.ts (MONEY PR 7a, 2B-1): the worker's one entry point sends a claimed row whose plan has an `addon` key to the add-on runner and every other row to the mission runner (agent/src/stage4/dispatch.ts). It reads no flag:
// the flags gate the creation and the approval of an add-on, and a hold that was made is always run to its end.

describe("Stage 4 modules are reached by the listed wiring only", () => {
  it("no file of src/ or agent/src/ outside the stage4 folders imports a stage4 module, except the wiring", () => {
    const prod = [...files(path.join(ROOT, "src")), ...files(path.join(ROOT, "agent", "src"))].filter((f) => !f.includes(`${path.sep}stage4${path.sep}`));
    const importers = prod.filter((f) => /from\s+["'][^"']*\/stage4\/[^"']+["']|import\(\s*["'][^"']*\/stage4\//.test(readFileSync(f, "utf8")));
    expect(importers.map((f) => path.relative(ROOT, f).split(path.sep).join("/")).sort()).toEqual([...WIRING].sort());
  });
});
