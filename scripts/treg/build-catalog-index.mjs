#!/usr/bin/env node
/**
 * Builds data/treg/treg_catalog_index.json from the sellable TREG catalog snapshot: the ids and providers only (a few hundred KB), so the hard
 * block list in the worker never loads the 10 MB snapshot. Reads the snapshot, writes nothing else, makes no network call.
 *
 *   node scripts/treg/build-catalog-index.mjs <path to treg_catalog_sellable.json> [out]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const [src, out = "data/treg/treg_catalog_index.json"] = process.argv.slice(2);
if (!src) { console.error("usage: build-catalog-index.mjs <treg_catalog_sellable.json> [out]"); process.exit(2); }
const bytes = readFileSync(src);
const catalog = JSON.parse(bytes.toString("utf8"));
const ids = catalog.endpoints.map((e) => e.id).sort();
if (new Set(ids).size !== ids.length) throw new Error("duplicate endpoint ids in the snapshot");
const providers = [...new Set(catalog.endpoints.map((e) => e.provider))].sort();
const index = {
  source: { file: "treg_catalog_sellable.json", sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length, snapshot: catalog.source, count: ids.length, excluded: catalog.excluded },
  providers,
  ids,
};
writeFileSync(out, JSON.stringify(index) + "\n");
console.log(`wrote ${out}: ${ids.length} ids, ${providers.length} providers`);
