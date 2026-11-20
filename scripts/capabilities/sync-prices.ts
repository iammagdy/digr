import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { estimateCallUsd } from "../../agent/src/gateway";
import { TOOL_CARDS } from "../../src/lib/agentMission/foundation/toolCards";
import { B2B_CARDS } from "../../src/lib/agentMission/stage3/b2bCards";
import { callMoneyCapUsd } from "../../src/lib/server/callBudget";
import { unitPricePointsFromCost } from "../../src/lib/recordPricing";
import { loadTregPriceBaseline, PINNED_PRICE_IDS, type TregCatalog } from "../../src/lib/treg/catalog";
import { buildPriceSync, type PriceObservation, type PriceSyncRow } from "../../src/lib/treg/priceSync";
import { validatePriceSyncFile } from "../../src/lib/treg/priceSyncFile";
import { CATALOG_PRICE_REV, PRICE_SYNC_SHA256 } from "../../src/lib/treg/priceRev";
import { createLiveFetcher, metadataUrls, type Fetched, type Fetcher } from "./sync-providers";

const root = fileURLToPath(new URL("../../", import.meta.url));
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const parse = (text: string) => {
  try { return JSON.parse(text); } catch { return null; }
};

export function priceSyncRevisionMatches(bytes: Buffer, revision = CATALOG_PRICE_REV, digest = PRICE_SYNC_SHA256): boolean {
  return parse(bytes.toString("utf8"))?.revision === revision && hash(bytes) === digest;
}

export function observePrice(id: string, response: Fetched): PriceObservation {
  if (!response.ok) return { kind: "unverified" };
  const body = parse(response.text);
  if (response.status === 200 && body?.endpoint?.id === id) return { kind: "live", endpoint: body.endpoint };
  if (response.status === 404 && typeof body?.detail?.error === "string" && /^unknown endpoint\b/i.test(body.detail.error)) return { kind: "gone" };
  return { kind: "unverified" };
}

function savedObservations(dir: string, ids: string[]): Map<string, PriceObservation> {
  const sums = new Map(readFileSync(path.join(dir, "SHA256SUMS"), "utf8").trim().split(/\r?\n/).map((line) => {
    const [digest, file] = line.split(/\s+/);
    return [file, digest];
  }));
  return new Map(ids.map((id) => {
    if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error(`invalid fixture id: ${id}`);
    const name = `${id}.json`;
    if (!sums.has(name)) return [id, { kind: "unverified" }];
    const bytes = readFileSync(path.join(dir, name));
    if (hash(bytes) !== sums.get(name)) throw new Error(`checksum mismatch for ${name}`);
    return [id, observePrice(id, { ok: true, status: 200, text: bytes.toString("utf8") })];
  }));
}

async function liveObservations(ids: string[], fetchText: Fetcher) {
  const meta = await fetchText(metadataUrls.tregMeta);
  const document = meta.ok && meta.status === 200 ? parse(meta.text) : null;
  if (!document || typeof document !== "object" || Array.isArray(document) || Object.keys(document).length === 0) {
    return { healthy: false, observations: new Map<string, PriceObservation>(ids.map((id) => [id, { kind: "unverified" }])) };
  }
  const observations = new Map<string, PriceObservation>();
  for (let i = 0; i < ids.length; i += 5) {
    await Promise.all(ids.slice(i, i + 5).map(async (id) => observations.set(id, observePrice(id, await fetchText(metadataUrls.tregEndpoint(id))))));
  }
  const results = [...observations.values()];
  const gone = results.filter((observation) => observation.kind === "gone").length;
  const massNotFound = gone > Math.max(5, Math.floor(ids.length * 0.2)) || (gone > 1 && gone === ids.length);
  if (massNotFound) {
    for (const [id, observation] of observations) if (observation.kind === "gone") observations.set(id, { kind: "unverified" });
  }
  const healthy = !massNotFound && results.filter((observation) => observation.kind === "unverified").length <= ids.length * 0.2;
  return { healthy, observations };
}

function writeChecked(dir: string, target: string, previous: Buffer, next: Buffer) {
  const candidateDir = mkdtempSync(path.join(dir, ".price-sync-"));
  try {
    for (const name of ["treg_catalog_sellable.json", "treg_write_actions.json"]) symlinkSync(path.join(dir, name), path.join(candidateDir, name));
    const candidate = path.join(candidateDir, "price_sync.json");
    writeFileSync(candidate, next);
    const child = spawnSync(process.execPath, ["--import", "tsx", "scripts/capabilities/check-price-sync.ts", candidateDir], {
      cwd: root, encoding: "utf8", timeout: 30_000,
    });
    if (child.status !== 0) throw new Error(`cold catalog check failed: ${child.error?.message ?? child.stderr.trim()}`);
    const lock = `${target}.lock`;
    const descriptor = openSync(lock, "wx");
    try {
      if (!readFileSync(target).equals(previous)) throw new Error("the price file changed during review; rerun sync");
      renameSync(candidate, target);
    } finally {
      closeSync(descriptor);
      rmSync(lock);
    }
  } finally {
    rmSync(candidateDir, { recursive: true, force: true });
  }
}

function report(date: string, rows: PriceSyncRow[], healthy: boolean, catalog: TregCatalog): string {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.state, (counts.get(row.state) ?? 0) + 1);
  const points = (usd: number | null) => usd === null ? "—" : String(unitPricePointsFromCost(usd));
  const cell = (value: string | null) => value?.replaceAll("|", "\\|").replace(/[\r\n]/g, " ") ?? "—";
  const applied = new Map(rows.filter((row) => row.state === "applied" || row.state === "restored").map((row) => [row.id, row.observed]));
  const cards = [...B2B_CARDS, ...TOOL_CARDS.map((card) => ({ endpointId: card.endpointId, costUsd: card.costUsdPerPage }))];
  const copyMismatches = cards.filter((card) => applied.has(card.endpointId) && card.costUsd !== applied.get(card.endpointId));
  const aboveCap = rows.filter((row) => {
    const endpoint = catalog.byId.get(row.id);
    if (row.state !== "held" || row.observed === null || !endpoint?.cost ||
      row.before === null || row.observed <= row.before) return false;
    // Compare the default call on the stored unit and input basis. A changed basis requires manual review.
    const old = { ...endpoint, cost: { ...endpoint.cost, usd: row.before } };
    const next = { ...endpoint, cost: { ...endpoint.cost, usd: row.observed } };
    return estimateCallUsd(next, {}, catalog) > callMoneyCapUsd(estimateCallUsd(old, {}, catalog));
  });
  return [
    `# Catalog price sync, ${date}`, "",
    `Checked ${rows.length} endpoints. ${[...counts].sort().map(([state, count]) => `${count} ${state}`).join(", ")}.`,
    healthy ? "Changes require a reviewed PR." : "Metadata coverage failed. Apply is disabled for this run.",
    "", "| Endpoint | Unit | Billing label, stored → observed | USD, stored → observed | Change | Provider points, stored → proposed | Effective routed USD | Decision |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | --- |",
    ...rows.map((row) => {
      const effective = row.state === "applied" || row.state === "restored" ? row.observed : row.before;
      const reason = row.field ? `${row.reason} (${row.field.replaceAll("|", "\\|").replace(/[\r\n]/g, " ")})` : row.reason;
      const pct = row.before && row.observed !== null ? `${((row.observed / row.before - 1) * 100).toFixed(2)}%` : "—";
      return `| ${row.id} | ${cell(row.unit)} | ${cell(row.billingBefore)} → ${cell(row.billingObserved)} | ${row.before ?? "—"} → ${row.observed ?? "—"} | ${pct} | ${points(row.before)} → ${points(effective)} | ${row.routedEstimate ?? "—"} | ${row.state}/${reason} |`;
    }),
    "", "## Card prices to review", "",
    ...(copyMismatches.length ? copyMismatches.map((card) => `- ${card.endpointId}: ${card.costUsd} → ${applied.get(card.endpointId)} USD.`) : ["None."]),
    "", "## Held rises above D-0138 on a default call using the stored billing basis", "",
    ...(aboveCap.length ? aboveCap.map((row) => `- ${row.id}: ${row.before} → ${row.observed} USD per stored billing unit.`) : ["None."]),
    "", "COMMANDER merges only after a read-only check shows zero approved or running jobs. Recheck immediately after deployment.",
    "When the overlay changes, regenerate the registry and update the price revision and its SHA-256 pin in the same PR.", "",
  ].join("\n");
}

export async function main(argv: string[], fetchOverride?: Fetcher): Promise<number> {
  const { values } = parseArgs({ args: argv, options: {
    date: { type: "string" }, dir: { type: "string", default: path.join(root, "data/treg") },
    scope: { type: "string", default: "all" }, offline: { type: "string" }, out: { type: "string" },
    apply: { type: "boolean" },
  } });
  const { date, apply, offline, out } = values;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("provide --date YYYY-MM-DD");
  const dir = path.resolve(values.dir);
  const target = path.join(dir, "price_sync.json");
  const previous = readFileSync(target);
  const baseline = loadTregPriceBaseline({ dir });
  const current = validatePriceSyncFile(JSON.parse(previous.toString("utf8")), baseline, PINNED_PRICE_IDS);
  if (apply && dir === path.join(root, "data/treg") && !priceSyncRevisionMatches(previous)) {
    throw new Error("price file and revision pin disagree; review the uncommitted change before running apply again");
  }
  const ids = (values.scope === "all" ? [...baseline.byId.keys()] : [...new Set(values.scope.split(","))]).sort();
  if (ids.some((id) => !baseline.byId.has(id))) throw new Error("--scope must be all or a comma-separated list of snapshot ids");
  const { healthy, observations } = offline
    ? { healthy: true, observations: savedObservations(path.resolve(offline), ids) }
    : await liveObservations(ids, fetchOverride ?? createLiveFetcher());
  const proposal = buildPriceSync(baseline, current, observations, PINNED_PRICE_IDS, date);
  if (apply && !healthy) throw new Error("metadata coverage failed; no file written");
  if (apply && proposal.file !== current) {
    const bytes = Buffer.from(`${JSON.stringify(proposal.file, null, 2)}\n`);
    writeChecked(dir, target, previous, bytes);
    process.stderr.write(`Update priceRev.ts to revision ${proposal.file.revision}, SHA-256 ${hash(bytes)}\n`);
  }
  const rendered = report(date, proposal.rows, healthy, baseline);
  if (out) writeFileSync(path.resolve(out), rendered);
  else process.stdout.write(rendered);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error: Error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
