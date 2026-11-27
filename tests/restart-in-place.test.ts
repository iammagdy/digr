import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { restartInPlace, shouldRestartInPlace } from "../agent/src/restartInPlace";

/**
 * A RECYCLE MUST NOT LOOK LIKE A CRASH (DT-20261126-planning-budget-llm FU-C). Heroku counts every exit, even status 0, as a dyno crash and delays the second restart; the recycle now replaces the process in place (`process.execve`).
 * A platform stop (a deploy) must still EXIT: the new slug has to run, not a copy of the old code.
 */
const base = () => ({ execPath: "/app/bin/node", execArgv: ["--max-old-space-size=192", "--max-semi-space-size=4", "--import", "tsx"], argv: ["/app/bin/node", "/app/agent/src/main.ts"], env: { A: "1" } as unknown as NodeJS.ProcessEnv });

describe("restartInPlace", () => {
  it("replaces the process with the same node, the same flags, the same script and the same environment", () => {
    const execve = vi.fn(() => undefined as never);
    const log = vi.fn();
    restartInPlace({ ...base(), execve, log });
    expect(execve).toHaveBeenCalledTimes(1);
    expect(execve).toHaveBeenCalledWith("/app/bin/node", ["/app/bin/node", "--max-old-space-size=192", "--max-semi-space-size=4", "--import", "tsx", "/app/agent/src/main.ts"], { A: "1" });
  });
  it("without process.execve (an older Node) nothing is replaced and the caller is told to exit as before", () => {
    const log = vi.fn();
    expect(restartInPlace({ ...base(), execve: undefined, log })).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("not available"));
  });
  it("a failing execve is logged and the caller exits as before (never an unhandled throw)", () => {
    const log = vi.fn();
    const execve = vi.fn(() => { throw new Error("EPERM boom"); });
    expect(restartInPlace({ ...base(), execve, log })).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("EPERM boom"));
  });
});

describe("when the process restarts in place and when it exits", () => {
  it("a recycle restarts in place", () => expect(shouldRestartInPlace({ recycleRequested: true, platformStop: false })).toBe(true));
  it("a platform stop always exits, even if a recycle was also requested", () => {
    expect(shouldRestartInPlace({ recycleRequested: true, platformStop: true })).toBe(false);
    expect(shouldRestartInPlace({ recycleRequested: false, platformStop: true })).toBe(false);
  });
  it("nothing requested: exit as before", () => expect(shouldRestartInPlace({ recycleRequested: false, platformStop: false })).toBe(false));
});

describe("the entry point wiring", () => {
  const main = readFileSync(path.join(__dirname, "..", "agent/src/main.ts"), "utf8");
  it("only the recycle callback asks for the in-place restart; the platform stop sets its own flag", () => {
    expect(main).toContain("onRecycle: () => { recycleRequested = true; worker.stop(); },");
    expect(main).toMatch(/const shutdown = \(\) => \{ platformStop = true;/);
    expect(main).toContain("if (shouldRestartInPlace({ recycleRequested, platformStop })) restartInPlace(");
    expect((main.match(/restartInPlace\(/g) ?? []).length).toBe(1);
  });
});

describe.skipIf(typeof (process as unknown as { execve?: unknown }).execve !== "function")("the real thing (this Node has process.execve)", () => {
  it("a node process that restarts itself keeps its pid and its flags and starts with a fresh heap", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "restart-in-place-"));
    const script = path.join(dir, "child.mjs");
    const modulePath = path.resolve(__dirname, "..", "agent/src/restartInPlace.ts");
    // the child prints its pid per generation and restarts itself once through the SAME function the worker uses
    writeFileSync(script, [
      `const n = Number(process.env.GEN ?? 0);`,
      `console.log(JSON.stringify({ gen: n, pid: process.pid, flags: process.execArgv }));`,
      `if (n < 1) { const { restartInPlace } = await import(${JSON.stringify(modulePath)}); restartInPlace({ execve: process.execve.bind(process), execPath: process.execPath, execArgv: process.execArgv, argv: process.argv, env: { ...process.env, GEN: String(n + 1) }, log: () => {} }); }`,
    ].join("\n"));
    const run = spawnSync(process.execPath, ["--import", "tsx", "--max-old-space-size=192", script], { encoding: "utf8", cwd: path.resolve(__dirname, ".."), timeout: 60_000 });
    expect(run.status).toBe(0);
    const lines = run.stdout.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => l.gen)).toEqual([0, 1]);
    expect(lines[1].pid).toBe(lines[0].pid);
    expect(lines[1].flags).toEqual(lines[0].flags);
    expect(lines[1].flags).toContain("--max-old-space-size=192");
  }, 90_000);
});
