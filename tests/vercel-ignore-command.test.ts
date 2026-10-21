import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const run = (env: Record<string, string>) =>
  spawnSync("sh", ["scripts/vercel-ignore.sh"], { env: { PATH: process.env.PATH ?? "", ...env } as unknown as NodeJS.ProcessEnv, encoding: "utf8" }).status;

describe("vercel.json ignoreCommand (exit 0 skips the build, exit 1 builds it)", () => {
  it("vercel.json runs the script", () => {
    expect(JSON.parse(readFileSync("vercel.json", "utf8")).ignoreCommand).toBe("sh scripts/vercel-ignore.sh");
  });
  it("a preview whose commit message has [skip ci] or [skip deploy] is skipped", () => {
    expect(run({ VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_MESSAGE: "wip: harness [skip ci]" })).toBe(0);
    expect(run({ VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_MESSAGE: "docs [skip deploy]\n\nbody" })).toBe(0);
  });
  it("a preview without the marker builds", () => {
    expect(run({ VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_MESSAGE: "feat: something" })).toBe(1);
    expect(run({ VERCEL_ENV: "preview" })).toBe(1);
  });
  it("production always builds, even if the message carries the marker", () => {
    expect(run({ VERCEL_ENV: "production", VERCEL_GIT_COMMIT_MESSAGE: "Merge pull request [skip ci]" })).toBe(1);
    expect(run({ VERCEL_ENV: "production", VERCEL_GIT_COMMIT_MESSAGE: "x" })).toBe(1);
  });
  it("an unset or unknown environment builds (fail towards building)", () => {
    expect(run({})).toBe(1);
    expect(run({ VERCEL_ENV: "development" })).toBe(1);
  });
});
