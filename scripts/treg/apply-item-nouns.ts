#!/usr/bin/env tsx
/**
 * THE UNIT NOUN OF EVERY CATALOG ENDPOINT (DT-20261126-wordlist-wave4, D-0239 B3). One row of an endpoint's result is a tweet, a video, a company, a place… The old overlay (DT-20261125-wordlist-wave2 P3) froze a code rule into data
 * (every `serp` endpoint an article, every vendor `x` endpoint a tweet): it was wrong for most of the catalog. The nouns are now LABELS: one per catalog endpoint, in `data/treg/item_noun_labels.json`
 * ({ "<endpoint id>": ["<noun>", "<basis>"] }), written by reading each endpoint's own catalog entry (id, platform, category, capability, name, summary, item fields) — a one-time, model-assisted labelling that people can review row by row;
 * the basis says why. A noun is one of the closed set `ITEM_NOUNS` (or «عنصر», the honest generic when a row is not clearly one thing). THIS script writes the five Arabic forms of each label into `data/treg/endpoint_metadata_overlay.json`
 * (`item_noun_ar`), leaving every other key of every entry alone, and leaves the overlay-only entries (the direct web providers' own tools, which are not catalog endpoints) as they are.
 *
 *   npx tsx scripts/treg/apply-item-nouns.ts          rewrites the overlay from the labels
 *   npx tsx scripts/treg/apply-item-nouns.ts --check  exits 1 when the overlay is not what the labels say
 * Nothing here runs at request time and nothing reads a customer's words.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GENERIC_ITEM_NOUN, ITEM_NOUNS, type ItemNoun } from "../../src/lib/agentMission/itemNoun";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const LABELS_PATH = path.join(ROOT, "data/treg/item_noun_labels.json");
const OVERLAY_PATH = path.join(ROOT, "data/treg/endpoint_metadata_overlay.json");

export const nounTable = (): Map<string, ItemNoun> => new Map([...ITEM_NOUNS, GENERIC_ITEM_NOUN].map((n) => [n.singular, n] as const));
export const overlayFormsOf = (n: ItemNoun) => ({ singular: n.singular, dual: n.dual, dual_gen: n.dualGen, plural: n.plural, tamyiz: n.tamyiz, feminine: n.feminine });

export function applyLabels(overlay: Record<string, any>, labels: Record<string, [string, string]>): Record<string, any> {
  const table = nounTable();
  const out: Record<string, any> = {};
  for (const [id, entry] of Object.entries(overlay)) {
    const label = labels[id];
    if (!label) { out[id] = entry; continue; }
    const noun = table.get(label[0]);
    if (!noun) throw new Error(`${id}: «${label[0]}» is not a noun of the closed set`);
    out[id] = { ...entry, item_noun_ar: overlayFormsOf(noun) };
  }
  return out;
}

function main(): void {
  const labels = JSON.parse(readFileSync(LABELS_PATH, "utf8")) as Record<string, [string, string]>;
  const raw = readFileSync(OVERLAY_PATH, "utf8");
  const next = JSON.stringify(applyLabels(JSON.parse(raw), labels), null, 2) + "\n";
  if (process.argv.includes("--check")) {
    if (next !== raw) { console.error("the overlay is not what data/treg/item_noun_labels.json says: run `npx tsx scripts/treg/apply-item-nouns.ts`"); process.exit(1); }
    console.log("OK: the overlay matches the labels");
    return;
  }
  writeFileSync(OVERLAY_PATH, next);
  console.log(`wrote ${OVERLAY_PATH}`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
