/**
 * Regenerates docs/CAPABILITY_COVERAGE.md from the code's own tables.
 *   npx tsx scripts/generate-coverage-doc.ts
 * A test compares the committed file with a fresh build, so the document cannot drift from the platform.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { buildCoverageDoc } from "../src/lib/coverageDoc";

writeFileSync(path.join(process.cwd(), "docs", "CAPABILITY_COVERAGE.md"), buildCoverageDoc());
console.log("wrote docs/CAPABILITY_COVERAGE.md");
