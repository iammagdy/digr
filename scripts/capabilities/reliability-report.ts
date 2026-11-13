#!/usr/bin/env tsx
/**
 * PHASE 3, THE RELIABILITY REPORT (read-only, offline; audit PR-3.3). Renders docs/intelligence/RELIABILITY-REPORT.md from data/capabilities/registry.json (Diger's own recorded calls, aggregated read-only from mission_calls).
 *   npx tsx scripts/capabilities/reliability-report.ts           writes the report
 *   npx tsx scripts/capabilities/reliability-report.ts --check   exits 1 when the committed report is out of date
 * No network, no database, no paid call.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RegistryArtifact } from "../../src/lib/agentMission/capabilities/artifact";
import { reliabilityMarkdown, reliabilityReport } from "../../src/lib/agentMission/capabilities/reliability";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const REPORT_PATH = path.join(ROOT, "docs/intelligence/RELIABILITY-REPORT.md");

export function generateReliabilityMarkdown(): string {
  const artifact = JSON.parse(readFileSync(path.join(ROOT, "data/capabilities/registry.json"), "utf8")) as RegistryArtifact;
  const snap = JSON.parse(readFileSync(path.join(ROOT, "data/capabilities/reliability-snapshot.json"), "utf8")) as { through: string; rows: Array<[string, ...unknown[]]> };
  return reliabilityMarkdown(reliabilityReport(artifact, snap.rows.map((r) => r[0])), snap.through);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const md = generateReliabilityMarkdown();
  if (process.argv.includes("--check")) {
    if (!existsSync(REPORT_PATH) || readFileSync(REPORT_PATH, "utf8") !== md) { console.error("docs/intelligence/RELIABILITY-REPORT.md is out of date"); process.exit(1); }
    console.log("docs/intelligence/RELIABILITY-REPORT.md is up to date");
  } else { writeFileSync(REPORT_PATH, md); console.log("wrote docs/intelligence/RELIABILITY-REPORT.md"); }
}
