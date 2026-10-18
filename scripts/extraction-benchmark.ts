/**
 * Offline extraction benchmark. Replays the saved raw rows in tests/fixtures/extraction through the gate, de-duplication
 * and Excel normalisation and prints rows kept / rejected / uncertain per capability. No database, no provider call.
 *   npx tsx scripts/extraction-benchmark.ts            print the table
 *   npx tsx scripts/extraction-benchmark.ts --write    also (re)write docs/EXTRACTION_BENCHMARK.md
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runAll, totals, type Fixture } from "../src/lib/server/extractionBenchmark";
import { rowIdentity } from "../src/lib/server/retryReuse";
import { renderBenchmarkMarkdown } from "../src/lib/server/extractionBenchmarkReport";

const dir = path.resolve(__dirname, "../tests/fixtures/extraction");
const fixtures: Fixture[] = readdirSync(dir).filter((f) => f.endsWith(".json") && !f.startsWith("baseline")).sort().map((f) => JSON.parse(readFileSync(path.join(dir, f), "utf8")));

(async () => {
  // --record-baseline replays with the de-duplication identity that existed before this change (record id first for every kind).
  const results = await runAll(fixtures, process.argv.includes("--record-baseline") ? { identityOf: rowIdentity } : {});
  const t = totals(results);
  for (const r of results) {
    console.log(`${r.capability.padEnd(30)} in ${String(r.rowsIn).padStart(2)} | delivered ${String(r.delivered).padStart(2)} | review ${String(r.review).padStart(2)} | rejected ${String(r.rejected).padStart(2)} | duplicates ${r.duplicates} | agreement ${r.agreement}/${r.rowsIn} | false deliveries ${r.falseDeliveries} | lost matches ${r.lostMatches} | latin headers ${r.latinHeaders.length} | format issues ${r.formatIssues}`);
  }
  console.log(`TOTAL in ${t.rowsIn} | delivered ${t.delivered} | review ${t.review} | rejected ${t.rejected} | duplicates ${t.duplicates} | agreement ${t.agreement}/${t.rowsIn} | false deliveries ${t.falseDeliveries} | lost matches ${t.lostMatches}`);
  if (process.argv.includes("--write")) {
    const baselinePath = path.join(dir, "baseline-before.json");
    let baseline: any = null;
    try { baseline = JSON.parse(readFileSync(baselinePath, "utf8")); } catch { /* none */ }
    writeFileSync(path.resolve(__dirname, "../docs/EXTRACTION_BENCHMARK.md"), renderBenchmarkMarkdown(results, baseline));
    console.log("wrote docs/EXTRACTION_BENCHMARK.md");
  }
  if (process.argv.includes("--record-baseline")) {
    writeFileSync(path.join(dir, "baseline-before.json"), JSON.stringify({ recordedFrom: "main e7cf565 (gate and de-duplication before this change)", results }, null, 1));
    console.log("recorded baseline");
  }
})();
