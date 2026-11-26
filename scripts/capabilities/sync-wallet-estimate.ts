#!/usr/bin/env tsx
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export interface WalletEstimateCosts {
  discoveryUsdPerRow: number;
  commentsUsdPerRow: number;
  repliesUsdPerRow: number;
  postsUsdPerRow: number;
}

interface SlotConfig {
  endpointId?: unknown;
  rowsPerPage?: unknown;
}

type WalletEstimateSlots = Record<string, Record<string, SlotConfig>>;

function computeSlotRate(
  slots: WalletEstimateSlots,
  group: string,
  slot: string,
  byId: Map<string, { id: string; cost?: { usd?: unknown } }>,
): number {
  const groupObj = slots[group];
  if (!groupObj || typeof groupObj !== "object") {
    throw new Error(`Missing treg.walletEstimateSlots.${group}`);
  }
  const cfg = groupObj[slot];
  if (!cfg || typeof cfg !== "object") {
    throw new Error(`Missing treg.walletEstimateSlots.${group}.${slot}`);
  }
  if (typeof cfg.endpointId !== "string" || cfg.endpointId.length === 0) {
    throw new Error(`Invalid endpointId in treg.walletEstimateSlots.${group}.${slot}`);
  }
  if (typeof cfg.rowsPerPage !== "number" || !Number.isFinite(cfg.rowsPerPage) || cfg.rowsPerPage < 1) {
    throw new Error(`Invalid rowsPerPage (${String(cfg.rowsPerPage)}) in treg.walletEstimateSlots.${group}.${slot}`);
  }
  const ep = byId.get(cfg.endpointId);
  const usd = ep?.cost?.usd;
  if (typeof usd !== "number" || !Number.isFinite(usd) || usd <= 0) {
    throw new Error(`Invalid catalog cost.usd (${String(usd)}) for ${cfg.endpointId}`);
  }
  return usd / cfg.rowsPerPage;
}

export function computeWalletEstimateCostsFromData(
  catalog: { endpoints?: Array<{ id: string; cost?: { usd?: unknown } }> },
  metadata: { treg?: { walletEstimateSlots?: WalletEstimateSlots } },
): WalletEstimateCosts {
  const slots = metadata?.treg?.walletEstimateSlots;
  if (!slots || typeof slots !== "object") {
    throw new Error("Missing treg.walletEstimateSlots in provider-metadata.json");
  }
  const endpoints = Array.isArray(catalog?.endpoints) ? catalog.endpoints : [];
  const byId = new Map(endpoints.map((ep) => [ep.id, ep]));

  return {
    discoveryUsdPerRow: computeSlotRate(slots, "youtube-comments", "discovery", byId),
    commentsUsdPerRow: computeSlotRate(slots, "youtube-comments", "comments", byId),
    repliesUsdPerRow: computeSlotRate(slots, "youtube-comments", "replies", byId),
    postsUsdPerRow: computeSlotRate(slots, "x-posts", "posts", byId),
  };
}

export function runSyncWalletEstimate(args: string[] = process.argv.slice(2), baseDir: string = process.cwd()): void {
  const catalogPath = path.resolve(baseDir, "data/treg/treg_catalog_sellable.json");
  const metadataPath = path.resolve(baseDir, "data/capabilities/provider-metadata.json");
  const outPath = path.resolve(baseDir, "data/treg/wallet_estimate_costs.json");

  const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8")) as { endpoints?: Array<{ id: string; cost?: { usd?: unknown } }> };
  const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as { treg?: { walletEstimateSlots?: WalletEstimateSlots } };

  const costs = computeWalletEstimateCostsFromData(catalog, metadata);
  const expectedText = JSON.stringify(costs, null, 2) + "\n";

  if (args.includes("--check")) {
    if (!fs.existsSync(outPath)) {
      console.error(`Missing ${path.relative(baseDir, outPath)}; run npx tsx scripts/capabilities/sync-wallet-estimate.ts`);
      process.exit(1);
    }
    const currentText = fs.readFileSync(outPath, "utf8");
    if (currentText !== expectedText) {
      console.error(`Drift detected in ${path.relative(baseDir, outPath)}; run npx tsx scripts/capabilities/sync-wallet-estimate.ts`);
      process.exit(1);
    }
    console.log("OK: data/treg/wallet_estimate_costs.json is in sync");
    return;
  }

  fs.writeFileSync(outPath, expectedText, "utf8");
  console.log(`Wrote ${path.relative(baseDir, outPath)} (${Buffer.byteLength(expectedText, "utf8")} bytes)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runSyncWalletEstimate();
}
