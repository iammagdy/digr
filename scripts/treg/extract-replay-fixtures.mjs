#!/usr/bin/env node
/**
 * Writes the replay fixtures that come from the catalog snapshot: for each endpoint the product sells, the catalog's own trimmed example answer. A fixture
 * made this way is a CATALOG EXAMPLE, named so (`catalog-example_<endpoint>.json`): it has the right field NAMES but its types can differ from a live call
 * (anyapi.x.user.posts: the example has isReply as a boolean and createdUtc as a number, live rows carry the text «True»/«False» and Unix seconds as text),
 * it is trimmed to the first list item, strings are cut at 120 characters and emails are masked. It makes no network call.
 *
 *   node scripts/treg/extract-replay-fixtures.mjs <path to treg_catalog_sellable.json> [outDir]
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";

const [src, outDir = "tests/fixtures/replay"] = process.argv.slice(2);
if (!src) { console.error("usage: extract-replay-fixtures.mjs <treg_catalog_sellable.json> [outDir]"); process.exit(2); }
const bytes = readFileSync(src);
const catalog = JSON.parse(bytes.toString("utf8"));
const sha256 = createHash("sha256").update(bytes).digest("hex");
const byId = new Map(catalog.endpoints.map((e) => [e.id, e]));
mkdirSync(outDir, { recursive: true });

const SELLING = [
  "anyapi.x.search.posts", "anyapi.x.user.posts", "tikhub.tiktok.video.comments", "crawl4ai.tiktok.video.comments", "crawl4ai.youtube.video.comments",
  "scrapecreators.x.v1-facebook-post-comments", "icypeas.companies.search", "icypeas.people.search",
  // added for the model planner's replays (listing steps and a company e-mail source)
  "anyapi.tiktok.search.videos", "justoneapi.x.facebook-search-post-v1", "tomba.companies.emails.list",
];

function write(name, doc) {
  writeFileSync(`${outDir}/${name}.json`, JSON.stringify(doc, null, 1) + "\n");
  console.log("wrote", `${outDir}/${name}.json`);
}

for (const id of SELLING) {
  const e = byId.get(id);
  if (!e) throw new Error(`endpoint ${id} is not in the snapshot`);
  write(`catalog-example_${id}`, {
    name: `catalog-example_${id}`,
    kind: "catalog example",
    endpointId: id,
    source: { file: "treg_catalog_sellable.json", sha256, snapshot: catalog.source, field: "example_response_trimmed" },
    costMicro: Math.round((e.cost?.usd ?? 0) * 1e6),
    listPath: e.list_path,
    cursorPath: e.cursor_path,
    pages: [e.example_response_trimmed],
    repeatLastPage: false,
  });
}

// The runaway job of 22 Oct 2026 (blitzapi.jobs.search: 175 pages, 0 rows accepted). The catalog example has ONE row and a null cursor; to replay a source that keeps
// answering, ten rows are cloned from that one example item (a different url each) and the cursor is a fixed string, so every page is a full page with a next cursor.
{
  const e = byId.get("blitzapi.jobs.search");
  const page = structuredClone(e.example_response_trimmed);
  const item = page.results[0];
  page.results = Array.from({ length: 10 }, (_, i) => ({ ...structuredClone(item), url: `https://example.com/jobs/engineer-${i + 1}` }));
  page.results_length = 10; page.total_results = 10_000; page.max_results = 10; page.cursor = "replay-cursor";
  write("catalog-example_blitzapi.jobs.search", {
    name: "catalog-example_blitzapi.jobs.search",
    kind: "catalog example",
    endpointId: "blitzapi.jobs.search",
    source: { file: "treg_catalog_sellable.json", sha256, snapshot: catalog.source, field: "example_response_trimmed" },
    synthetic: "ten rows cloned from the one example item (url differs) and cursor set to a fixed string, so every page is full and has a next cursor, as the live job's pages were",
    costMicro: Math.round((e.cost?.usd ?? 0) * 1e6) * 10,
    listPath: e.list_path,
    cursorPath: e.cursor_path,
    pages: [page],
    repeatLastPage: true,
  });
}
