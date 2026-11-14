/**
 * PHASE 7: BUILDS `data/shadow/corpus.json`, the stored requests and approved plans the admin shadow view replays. It copies, field by field and with nothing invented, from the committed fixtures:
 *   - the 20 stored missions of `tests/fixtures/live/replay-missions.json` (request, approved stages, planned rows, replies status, delivered counts);
 *   - the 98 labelled requests of `tests/fixtures/semantic-paraphrases.json` (text, answer, the labelled meaning, the known gap).
 * The website cannot read `tests/`, so the corpus is a committed copy; `--check` fails when the copy is stale. Offline and deterministic: no network, no database, no environment variable.
 *   npx tsx scripts/shadow/build-corpus.ts          # writes data/shadow/corpus.json
 *   npx tsx scripts/shadow/build-corpus.ts --check  # exit 1 when it differs
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (p: string) => JSON.parse(readFileSync(path.join(root, p), "utf8"));

export function buildCorpus() {
  const replay = read("tests/fixtures/live/replay-missions.json") as { missions: Array<{ id: string; request: string; stages: Array<{ key: string; parent_key: string | null; endpoint_id: string; planned?: number; gaps?: unknown[] }>; replies_status?: string | null; delivered?: number[] }> };
  const para = read("tests/fixtures/semantic-paraphrases.json") as { now_iso: string; cases: Array<{ id: string; group: string; text: string; answer?: string; expected: Record<string, unknown>; known_gap?: { why: string }; closed_gap?: unknown }> };
  return {
    _about: "PHASE 7 shadow corpus: a committed copy of the stored requests and approved plans in tests/fixtures (live/replay-missions.json, semantic-paraphrases.json). Regenerate with scripts/shadow/build-corpus.ts; never edit by hand.",
    now_iso: para.now_iso,
    stored: replay.missions.map((m) => ({
      id: m.id, request: m.request, replies_status: m.replies_status ?? null, delivered: m.delivered ?? [],
      stages: m.stages.map((s) => ({ key: s.key, parent_key: s.parent_key, endpoint_id: s.endpoint_id, ...(typeof s.planned === "number" ? { planned: s.planned } : {}), ...(Array.isArray(s.gaps) && s.gaps.length > 0 ? { gaps: s.gaps } : {}) })),
    })),
    understanding: para.cases.map((c) => ({ id: c.id, group: c.group, text: c.text, ...(c.answer ? { answer: c.answer } : {}), expected: c.expected, ...(c.known_gap ? { known_gap: c.known_gap.why } : {}) })),
  };
}

export const corpusText = (): string => `${JSON.stringify(buildCorpus(), null, 1)}\n`;
const target = path.join(root, "data", "shadow", "corpus.json");

if (process.argv[1] && /build-corpus\.ts$/.test(process.argv[1])) {
  const text = corpusText();
  if (process.argv.includes("--check")) {
    let current = "";
    try { current = readFileSync(target, "utf8"); } catch { /* missing */ }
    if (current !== text) { console.error("data/shadow/corpus.json is stale: run npx tsx scripts/shadow/build-corpus.ts"); process.exit(1); }
    console.log("data/shadow/corpus.json is current");
  } else { writeFileSync(target, text); console.log(`wrote ${target} (${text.length} bytes)`); }
}
