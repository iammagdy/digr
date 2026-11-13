import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkCustomerText } from "../src/lib/agentMission/text";
import { PLAN_NOT_READY_AR } from "../src/lib/agentMission/chatTurn";

/**
 * ROUND 58: NO WEBSITE PATH CANCELS A MISSION THE WORKER IS PLANNING (the deferred «stale planner» race of round 57, inspected again).
 *
 * The worker writes its planning result without re-reading the status (agent/src/runMission.ts). That is safe ONLY while nothing on the website can cancel a mission in `planning` (or one the worker is executing):
 * a cancelled row could otherwise be written back to `plan_ready` by a late planner run. Today every cancel is a compare-and-set on waiting statuses only (customer, chat, admin, expiry, add-on, free re-run).
 * This test reads every website write of `status: "cancelled"` and fails if one of them could match `planning`, `approved` or `executing`: adding such a path needs the worker-side fence first (docs/CUSTOMER-JOURNEY-R58.md).
 */
const ROOT = path.resolve(__dirname, "../src");
const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = path.join(dir, f); return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(f) ? [p] : []; });
const RUNNING = ["planning", "approved", "executing"];

describe("every website cancel is a compare-and-set on waiting statuses only", () => {
  const writes = files(ROOT).flatMap((file) => {
    const src = readFileSync(file, "utf8");
    return [...src.matchAll(/update\(\{\s*status:\s*"cancelled"[\s\S]{0,700}?;/g)].map((m) => ({ file: path.relative(ROOT, file), stmt: m[0] }));
  });
  it("finds the known cancel paths", () => {
    expect(writes.length).toBeGreaterThanOrEqual(10);
  });
  it.each(writes.map((w) => [w.file, w.stmt] as const))("%s", (_file, stmt) => {
    // the status filter is a literal list, a named list of waiting statuses, or one literal status; never a running one
    const filter = stmt.match(/\.(?:in|eq)\("status",\s*([^)]*)\)/);
    expect(filter, `no status filter in: ${stmt.slice(0, 160)}`).not.toBeNull();
    for (const s of RUNNING) expect(filter![1]).not.toContain(`"${s}"`);
  });
  it("the named lists those cancels use hold no running status", async () => {
    const chat = readFileSync(path.join(ROOT, "lib/agentMission/chatTurn.ts"), "utf8");
    const actions = readFileSync(path.join(ROOT, "lib/agentMission/customerActions.ts"), "utf8");
    const expiry = readFileSync(path.join(ROOT, "lib/requests/expiry.ts"), "utf8");
    for (const [src, name] of [[chat, "REPLACEABLE"], [chat, "WITHDRAWABLE"], [actions, "CANCELLABLE"], [expiry, "WAITING_STATUSES"]] as const) {
      const decl = src.match(new RegExp(`(?:const|export const) ${name}\\b[^=]*=\\s*([^;]+);`));
      expect(decl, name).not.toBeNull();
      for (const s of RUNNING) expect(decl![1], name).not.toContain(`"${s}"`);
    }
  });
  it("a change typed while the plan is prepared is said NOT to be applied yet, and how to make it reach the plan", () => {
    expect(PLAN_NOT_READY_AR).toContain("لم يُطبَّق عليها تعديلك بعد");
    expect(checkCustomerText(PLAN_NOT_READY_AR, { maxChars: 400 }).issues).toEqual([]);
  });
});
