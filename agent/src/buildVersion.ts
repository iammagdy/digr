import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * WHICH COMMIT THE WORKER RUNS (round 53). The heartbeat reported `version: "dev"` on every Heroku dyno: Heroku sets `SOURCE_VERSION` only DURING the build, and `HEROKU_SLUG_COMMIT` only with the dyno-metadata feature (an
 * infrastructure setting this repository does not change). The build now writes the commit it built into `agent/build-info.json` (scripts/write-build-info.mjs, run by `heroku-postbuild`), and the worker reads it at start.
 * Order: the runtime variables when present, then the build file, else "dev". Only a hexadecimal commit id is ever reported.
 */
const here = typeof __dirname !== "undefined" ? __dirname : path.dirname(fileURLToPath(import.meta.url));
export const BUILD_INFO_FILE = path.join(here, "..", "build-info.json");
const SHA = /^[0-9a-f]{7,40}$/i;

export function workerVersion(env: Record<string, string | undefined>, readBuildInfo: () => string | null = () => { try { return readFileSync(BUILD_INFO_FILE, "utf8"); } catch { return null; } }): string {
  for (const v of [env.SOURCE_VERSION, env.HEROKU_SLUG_COMMIT]) if (typeof v === "string" && SHA.test(v.trim())) return v.trim().slice(0, 7);
  try {
    const raw = readBuildInfo();
    const commit = raw ? (JSON.parse(raw) as { commit?: unknown }).commit : null;
    if (typeof commit === "string" && SHA.test(commit)) return commit.slice(0, 7);
  } catch { /* an unreadable build file is the same as none */ }
  return "dev";
}
