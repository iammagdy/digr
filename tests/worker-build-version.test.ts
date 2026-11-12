import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BUILD_INFO_FILE, workerVersion } from "../agent/src/buildVersion";

/**
 * THE WORKER REPORTS THE COMMIT IT RUNS (round 53). Every Heroku heartbeat said `version: "dev"`: SOURCE_VERSION exists only during the build and HEROKU_SLUG_COMMIT only with an infrastructure feature this repository does not turn on.
 * The build now writes the commit into agent/build-info.json and the worker reads it. Nothing in Heroku's settings changes; a build without a commit behaves exactly as before.
 */
const ROOT = path.join(__dirname, "..");
const SHA = "092a010274e5a6a773748b71849f5673d8e984f0";

describe("workerVersion", () => {
  it("runtime variables first, then the build file, else dev", () => {
    expect(workerVersion({ SOURCE_VERSION: SHA }, () => null)).toBe("092a010");
    expect(workerVersion({ HEROKU_SLUG_COMMIT: "abcdef1234" }, () => null)).toBe("abcdef1");
    expect(workerVersion({}, () => JSON.stringify({ commit: SHA }))).toBe("092a010");
    expect(workerVersion({ SOURCE_VERSION: "1111111" }, () => JSON.stringify({ commit: SHA }))).toBe("1111111");
    expect(workerVersion({}, () => null)).toBe("dev");
  });
  it("only a hexadecimal commit id is ever reported", () => {
    expect(workerVersion({ SOURCE_VERSION: "main" }, () => null)).toBe("dev");
    expect(workerVersion({}, () => JSON.stringify({ commit: "<script>" }))).toBe("dev");
    expect(workerVersion({}, () => "not json")).toBe("dev");
    expect(workerVersion({}, () => { throw new Error("unreadable"); })).toBe("dev");
  });
  it("the build file lives in agent/ and is never committed", () => {
    expect(BUILD_INFO_FILE).toBe(path.join(ROOT, "agent", "build-info.json"));
    expect(readFileSync(path.join(ROOT, ".gitignore"), "utf8")).toMatch(/^\/agent\/build-info\.json$/m);
  });
});

describe("scripts/write-build-info.mjs (run by heroku-postbuild)", () => {
  const run = (env: Record<string, string>) => spawnSync(process.execPath, [path.join(ROOT, "scripts", "write-build-info.mjs")], { env: { PATH: process.env.PATH ?? "", ...env } as unknown as NodeJS.ProcessEnv, encoding: "utf8" });
  it("heroku-postbuild runs it after the worker typecheck", () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["heroku-postbuild"]).toBe("npm ci --prefix agent --no-audit --no-fund && tsc -p agent/tsconfig.json && node scripts/write-build-info.mjs");
  });
  it("writes the build commit, which the worker then reports; never fails the build", () => {
    const had = existsSync(BUILD_INFO_FILE);
    const before = had ? readFileSync(BUILD_INFO_FILE, "utf8") : null;
    try {
      const ok = run({ SOURCE_VERSION: SHA });
      expect(ok.status).toBe(0);
      expect(ok.stdout).toMatch(/build-info: 092a010/);
      expect(JSON.parse(readFileSync(BUILD_INFO_FILE, "utf8")).commit).toBe(SHA);
      expect(workerVersion({})).toBe("092a010");
      // no commit, or a value that is not a commit: nothing written, exit 0
      if (existsSync(BUILD_INFO_FILE)) unlinkSync(BUILD_INFO_FILE);
      for (const env of [{}, { SOURCE_VERSION: "$(rm -rf /)" }] as Array<Record<string, string>>) {
        const r = run(env);
        expect(r.status).toBe(0);
        expect(existsSync(BUILD_INFO_FILE)).toBe(false);
      }
    } finally {
      if (existsSync(BUILD_INFO_FILE)) unlinkSync(BUILD_INFO_FILE);
      if (before !== null) writeFileSync(BUILD_INFO_FILE, before);
    }
  });
});
