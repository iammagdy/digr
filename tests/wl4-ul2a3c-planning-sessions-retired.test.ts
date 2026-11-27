import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * DT-20261126-wl4-ul2a-3 step C-1 (D-0248): the planning_sessions table does not exist in production, so no planning session can be created or resumed. The two page routes that stepped a session and the
 * driver's resume call are gone; what is left of the session code (planningSession.ts, plannedAnswer.ts, planningClient.ts, chatTurn.ts) is only reached from chatHandler.ts and the chat page, and is deleted by C-2
 * once the open PRs that edit those two files are merged. This test pins exactly that, so nothing new grows back on the retired path.
 */
const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const full = path.join(dir, name);
  return statSync(full).isDirectory() ? walk(full) : [full];
});
const sources = walk("src").filter((f) => /\.(ts|tsx)$/.test(f)).map((f) => f.split(path.sep).join("/"));

describe("planning sessions: retired callers (C-1)", () => {
  it("the routes that stepped or read a planning session no longer exist", () => {
    expect(existsSync("src/app/api/chat/planning/[id]/route.ts")).toBe(false);
    expect(existsSync("src/app/api/chat/planning/[id]/step/route.ts")).toBe(false);
  });

  it("the always-on driver does not resume planning sessions and its answer has no `planning` field", () => {
    const drive = readFileSync("src/app/api/cron/drive/route.ts", "utf8");
    expect(drive).not.toMatch(/planningSession|resumeStalePlanningSessions|modelPlanner/);
    expect(drive).not.toMatch(/^\s*planning,?$/m);
  });

  it("only chatHandler.ts still imports the session module (C-2 removes it with the chat page's client)", () => {
    const importers = sources.filter((f) => /from\s+["'][^"']*modelPlanner\/planningSession["']/.test(readFileSync(f, "utf8")));
    expect(importers).toEqual(["src/functions/shared/chatHandler.ts"]);
  });

  it("counter-case: the live agent-mission driver paths are still there (drive dispatches, notifies stalls, reconciles groups)", () => {
    const drive = readFileSync("src/app/api/cron/drive/route.ts", "utf8");
    for (const needle of ["dispatchWorkerChunk", "notifyStalledJobs", "reconcileJobGroups", "recordDriverTick"]) expect(drive).toContain(needle);
  });
});
