// Writes agent/build-info.json with the commit Heroku is building (SOURCE_VERSION is set only during the build), so the worker can report it
// in its heartbeat (agent/src/buildVersion.ts). It NEVER fails the build: any problem is printed and the script exits 0.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

try {
  const commit = String(process.env.SOURCE_VERSION ?? process.env.HEROKU_SLUG_COMMIT ?? "").trim();
  if (/^[0-9a-f]{7,40}$/i.test(commit)) {
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "agent", "build-info.json");
    writeFileSync(file, `${JSON.stringify({ commit, built_at: new Date().toISOString() })}\n`);
    console.log(`build-info: ${commit.slice(0, 7)}`);
  } else console.log("build-info: no build commit in this environment (the worker will report \"dev\")");
} catch (e) {
  console.log(`build-info: not written (${String(e?.message ?? e).slice(0, 120)})`);
}
process.exit(0);
