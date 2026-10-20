/**
 * Regenerates the landing page's sample workbooks (public/samples/*.xlsx) from FAKE data with the real generator.
 *   npx tsx scripts/generate-sample-files.ts
 * A test checks the committed files against a fresh build, so they cannot drift from what a customer receives.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { SAMPLE_FILES, type OutputKind } from "../src/lib/outputStandard";
import { buildSampleWorkbook } from "../src/lib/server/sampleFiles";

async function main() {
  const dir = path.join(process.cwd(), "public", "samples");
  mkdirSync(dir, { recursive: true });
  for (const kind of Object.keys(SAMPLE_FILES) as OutputKind[]) {
    const buffer = await buildSampleWorkbook(kind);
    writeFileSync(path.join(dir, SAMPLE_FILES[kind].fileName), buffer);
    console.log(`wrote public/samples/${SAMPLE_FILES[kind].fileName} (${buffer.length} bytes)`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
