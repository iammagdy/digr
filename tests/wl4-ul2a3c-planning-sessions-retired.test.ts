import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * DT-20261126-wl4-ul2a-3 step C-1 (D-0248): the planning_sessions table does not exist in production, so no planning session can be created or resumed. The two page routes that stepped a session and the
 * driver's resume call are gone; the session code (planningSession.ts, plannedAnswer.ts, planningClient.ts) was only reached from chatHandler.ts and the chat page and is deleted by C-2a
 * (the model planner's branch of the handler goes with it, so the handler no longer imports modelPlanner/chatTurn.ts). This test pins exactly that, so nothing new grows back on the retired path.
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

  it("C-2a: the session modules and the page's client are deleted, nothing imports them, and the chat handler no longer holds the model planner (its branch, fields, input and response field)", () => {
    for (const gone of ["src/lib/modelPlanner/planningSession.ts", "src/lib/modelPlanner/plannedAnswer.ts", "src/lib/planningClient.ts"]) expect(existsSync(gone), gone).toBe(false);
    const importers = sources.filter((f) => /from\s+["'][^"']*(modelPlanner\/planningSession|modelPlanner\/plannedAnswer|\/planningClient)["']/.test(readFileSync(f, "utf8")));
    expect(importers).toEqual([]);
    const handler = readFileSync("src/functions/shared/chatHandler.ts", "utf8");
    expect(handler).not.toMatch(/modelPlanner\/chatTurn|answerWithModelPlanner|modelPlannerFor|public modelPlanner\b|plannerRequestId|planning\?:/);
    expect(readFileSync("src/app/api/chat/route.ts", "utf8")).not.toContain("plannerRequestId");
    expect(readFileSync("src/app/dashboard/chat/page.tsx", "utf8")).not.toContain("resolvePlanningPending");
  });

  it("counter-case: the handler's agent turn, the file-shaping turn and the greeting turn are still there", () => {
    const handler = readFileSync("src/functions/shared/chatHandler.ts", "utf8");
    for (const needle of ["answerWithAgent(", "agentChatTurn", "this.agentChat?.enabled", "isFileShapingTurn"]) expect(handler).toContain(needle);
  });

  it("counter-case: the live agent-mission driver paths are still there (drive dispatches, notifies stalls, reconciles groups)", () => {
    const drive = readFileSync("src/app/api/cron/drive/route.ts", "utf8");
    for (const needle of ["dispatchWorkerChunk", "notifyStalledJobs", "reconcileJobGroups", "recordDriverTick"]) expect(drive).toContain(needle);
  });
});
