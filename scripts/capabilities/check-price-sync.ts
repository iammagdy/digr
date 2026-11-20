import path from "node:path";
import { isSellable, loadTregCatalog, loadTregPriceBaseline, PINNED_PRICE_IDS } from "../../src/lib/treg/catalog";
import { unitCost } from "../../src/lib/modelPlanner/pricing";

const dir = process.argv[2];
if (!dir) throw new Error("expected a catalog directory");
const baseline = loadTregPriceBaseline({ dir });
const catalog = loadTregCatalog({ dir, syncFile: path.join(dir, "price_sync.json") });
for (const id of PINNED_PRICE_IDS) {
  if (catalog.byId.get(id)?.cost?.usd !== baseline.byId.get(id)?.cost?.usd) throw new Error(`changed pinned price: ${id}`);
}
for (const endpoint of baseline.endpoints) {
  if (endpoint.kind !== "routed") continue;
  const current = catalog.byId.get(endpoint.id)!;
  if (JSON.stringify(unitCost(endpoint, baseline)) !== JSON.stringify(unitCost(current, catalog))) {
    throw new Error(`changed routed estimate: ${endpoint.id}`);
  }
}
for (const id of catalog.withdrawnIds ?? []) {
  if (isSellable(id, catalog)) throw new Error(`withdrawal is still sellable: ${id}`);
}
