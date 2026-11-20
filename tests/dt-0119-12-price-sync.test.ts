import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { isSellable, loadTregCatalog, loadTregPriceBaseline, parseCatalog, type CatalogEndpoint, type TregCatalog, PINNED_PRICE_IDS } from "../src/lib/treg/catalog";
import { applyPriceSync, type PriceSyncEntry, type PriceSyncFile } from "../src/lib/treg/priceSyncFile";
import { buildPriceSync, type PriceObservation } from "../src/lib/treg/priceSync";
import { main, observePrice, priceSyncRevisionMatches } from "../scripts/capabilities/sync-prices";
import { CATALOG_PRICE_REV } from "../src/lib/treg/priceRev";

const root = process.cwd();
const catalogDir = path.join(root, "data/treg");
const empty: PriceSyncFile = { revision: 1, entries: [] };
const id = "test.direct";
const stored = { id, kind: "direct", scope: "public", inputs: [], siblings: [], cost: { usd: 0.000495, unit: "record", per: 1, type: "per_result" } } as unknown as CatalogEndpoint;
const live = { id, cost: { ...stored.cost, usd: 0.001 }, input: {} };
const date = "2026-11-20";
const baseline = () => parseCatalog({ endpoints: [structuredClone(stored)] }, []);
const build = (previous: PriceSyncFile, observations: Record<string, PriceObservation>) =>
  buildPriceSync(baseline(), previous, new Map(Object.entries(observations)), new Set(), date);

it.each([
  [0.001, "apply"],
  [0.001485, "apply"],
  [0.0002475, "apply"],
  [0.000495, "same"],
  [0.001485001, "rise_over_bound"],
  [0.000247499, "fall_over_bound"],
  [null, "price_invalid"],
  [0, "price_invalid"],
  [-1, "price_invalid"],
  [Number.NaN, "price_invalid"],
  [Number.POSITIVE_INFINITY, "price_invalid"],
  [0.0000000001, "price_invalid"],
  [1000.1, "price_invalid"],
  ["0.001", "price_invalid"],
])("uses validated nano-dollar values for %s (%s)", (usd, reason) => {
  const { rows, file } = build(empty, { [id]: { kind: "live", endpoint: { ...live, cost: { ...live.cost, usd } } } });
  expect(rows[0].reason).toBe(reason);
  expect(file.entries).toHaveLength(reason === "apply" ? 1 : 0);
});

it("holds incomplete, differently billed, and differently limited inputs before applying a drop", () => {
  const base = baseline();
  base.endpoints[0].inputs = [
    { name: "size", minimum: null, maximum: null, default: null, enum: null, note: "1 to 50", in: "body" },
    { name: "mode", minimum: null, maximum: null, default: "normal", enum: ["normal"], note: null, in: "body" },
  ] as CatalogEndpoint["inputs"];
  const complete = { ...live, input: { body: { size: { note: "1 to 50" }, mode: { default: "normal", enum: ["normal"] } } }, cost: { ...live.cost, usd: 0.0003 } };
  const read = (endpoint: Record<string, unknown>) => buildPriceSync(base, empty, new Map([[id, { kind: "live", endpoint }]]), new Set(), date).rows[0].reason;
  expect(read(complete)).toBe("apply");
  expect(read({ ...complete, cost: { ...complete.cost, per: undefined } })).toBe("basis_unproven");
  expect(read({ ...complete, cost: { ...complete.cost, unit: undefined } })).toBe("basis_unproven");
  expect(read({ ...complete, cost: { ...complete.cost, type: "per_success" } })).toBe("billing_label_changed");
  expect(read({ ...complete, input: { body: { ...complete.input.body, size: { note: "1 to 60" } } } })).toBe("size_note_changed");
  expect(read({ ...complete, input: { body: { ...complete.input.body, mode: { default: "normal" } } } })).toBe("input_limits_changed");
});

it("keeps previous corrections against the immutable baseline and records verified returns", () => {
  const first = build(empty, { [id]: { kind: "live", endpoint: live } }).file;
  const higher = { ...live, cost: { ...live.cost, usd: 0.0012 } };
  const second = build(first, { [id]: { kind: "live", endpoint: higher } }).file;
  expect(second.entries).toHaveLength(1);
  expect(second.entries[0].was.usd).toBe(0.000495);
  const cold = baseline();
  applyPriceSync(cold, second, new Set());
  expect(cold.byId.get(id)?.cost?.usd).toBe(0.0012);
  expect(build(first, {}).file).toEqual(first);
  expect(build(first, { [id]: { kind: "unverified" } }).file).toEqual(first);
  expect(build(first, { [id]: { kind: "live", endpoint: { ...live, cost: { ...live.cost, per: null } } } }).file).toEqual(first);
  const gone = build(first, { [id]: { kind: "gone" } }).file;
  const withdrawn = baseline();
  applyPriceSync(withdrawn, gone, new Set());
  expect(isSellable(id, withdrawn)).toBe(false);
  expect(build(gone, { [id]: { kind: "unverified" } }).file).toEqual(gone);
  const reverted = build(gone, { [id]: { kind: "live", endpoint: { ...live, cost: { ...live.cost, usd: 0.0005 } } } }).file;
  const restored = build(reverted, { [id]: { kind: "live", endpoint: { ...live, cost: stored.cost } } }).file;
  const restoredCatalog = baseline();
  applyPriceSync(restoredCatalog, restored, new Set());
  expect(isSellable(id, restoredCatalog)).toBe(true);
  expect(restoredCatalog.byId.get(id)?.cost?.usd).toBe(0.000495);
  expect(restored.entries.map((entry) => entry.id)).toEqual([id]);
});

it("never writes a routed price or a direct adjustment that would move a routed estimate", () => {
  const routed = { ...stored, id: "test.route", kind: "routed", siblings: [id], cost: { ...stored.cost!, usd: 0.0008 } };
  const base = parseCatalog({ endpoints: [structuredClone(stored), routed] }, []);
  const decisions = buildPriceSync(base, empty, new Map([
    [routed.id, { kind: "live", endpoint: { ...live, id: routed.id } }],
    [id, { kind: "live", endpoint: live }],
  ]), new Set(), date);
  expect(decisions.rows.map((row) => row.reason)).toEqual(["routed_sibling_changes_estimate", "routed_report_only"]);
  expect(decisions.file.entries).toEqual([]);
  const harmless = buildPriceSync(base, empty, new Map([[id, { kind: "live", endpoint: { ...live, cost: { ...live.cost, usd: 0.0006 } } }]]), new Set(), date);
  expect(harmless.file.entries.map((entry) => entry.id)).toEqual([id]);
});

it.each([
  [{ ok: true, status: 404, text: '{"detail":{"error":"Unknown endpoint test.direct"}}' }, "gone"],
  [{ ok: true, status: 404, text: '{"detail":{"error":"Not found"}}' }, "unverified"],
  [{ ok: true, status: 503, text: '{"detail":{"error":"Unknown endpoint test.direct"}}' }, "unverified"],
  [{ ok: false, error: "timed out" }, "unverified"],
] as const)("distinguishes an explicit removal from an outage (%j)", (response, kind) => {
  expect(observePrice(id, response).kind).toBe(kind);
});

it("holds the saved response with absent per, even though its USD is within band", () => {
  const id = "sixtyfour.people.search";
  const payload = JSON.parse(readFileSync(`tests/fixtures/dt-0119-12/${id}.json`, "utf8"));
  const result = buildPriceSync(loadTregPriceBaseline(), empty, new Map([[id, { kind: "live", endpoint: payload.endpoint }]]), new Set(), date);
  expect(result.rows[0].reason).toBe("basis_unproven");
  expect(result.file.entries).toEqual([]);
});

it("refuses a mismatched revision even when the candidate's bytes are rehashed", () => {
  const data = readFileSync(path.join(catalogDir, "price_sync.json"));
  expect(priceSyncRevisionMatches(data)).toBe(true);
  expect(priceSyncRevisionMatches(Buffer.concat([data, Buffer.from("\n")]))).toBe(false);
  expect(priceSyncRevisionMatches(data, CATALOG_PRICE_REV + 1)).toBe(false);
});

it("allows an archived price in a dry report but rejects applying it over a newer rate", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "dt12-price-replay-"));
  try {
    const data = path.join(dir, "data/treg");
    const registry = path.join(dir, "data/capabilities/registry.json");
    const overlay = path.join(data, "price_sync.json");
    mkdirSync(data, { recursive: true });
    mkdirSync(path.dirname(registry), { recursive: true });
    for (const name of ["treg_catalog_sellable.json", "treg_write_actions.json"]) {
      symlinkSync(path.join(catalogDir, name), path.join(data, name));
    }
    const endpointId = "blitzapi.companies.search";
    const newer: PriceSyncFile = { revision: 3, entries: [{
      id: endpointId,
      was: { unit: "record", usd: 0.000495 },
      now: { unit: "record", usd: 0.0012 },
      since: "2026-11-23",
    }] };
    writeFileSync(overlay, JSON.stringify(newer));
    copyFileSync(path.join(root, "data/capabilities/registry.json"), registry);
    const overlayBefore = readFileSync(overlay);
    const registryBefore = readFileSync(registry);
    const args = [
      "--import", "tsx", "scripts/capabilities/sync-prices.ts",
      "--dir", data, "--scope", endpointId, "--date", "2026-11-27",
      "--offline", "tests/fixtures/dt-0119-12",
    ];

    const dryRun = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 30_000 });
    expect(dryRun.status).toBe(0);
    expect(dryRun.stdout).toContain("0.0012 → 0.001");
    expect(readFileSync(overlay)).toEqual(overlayBefore);
    expect(readFileSync(registry)).toEqual(registryBefore);

    const rejected = spawnSync(process.execPath, [...args, "--apply"], { encoding: "utf8", timeout: 30_000 });
    expect({
      rejected: rejected.status === 1,
      clearError: /--offline.*--apply/.test(rejected.stderr),
      overlayUnchanged: readFileSync(overlay).equals(overlayBefore),
      registryUnchanged: readFileSync(registry).equals(registryBefore),
    }).toEqual({ rejected: true, clearError: true, overlayUnchanged: true, registryUnchanged: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("checks the full file in a fresh process and preserves corrupt target bytes on apply", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "dt12-price-sync-"));
  try {
    for (const name of ["treg_catalog_sellable.json", "treg_write_actions.json"]) symlinkSync(path.join(catalogDir, name), path.join(dir, name));
    const target = path.join(dir, "price_sync.json");
    const endpointId = "blitzapi.companies.search";
    const observation = readFileSync(`tests/fixtures/dt-0119-12/${endpointId}.json`, "utf8");
    writeFileSync(target, JSON.stringify(empty));
    await expect(main([
      "--dir", dir, "--date", date, "--scope", endpointId, "--apply", "--out", path.join(dir, "report.md"),
    ], async (url) => ({
      ok: true, status: 200, text: url.endsWith("/meta") ? '{"treg_version":"test"}' : observation,
    }))).resolves.toBe(0);
    const first: PriceSyncFile = JSON.parse(readFileSync(target, "utf8"));
    expect(first.revision).toBe(2);
    const child = spawnSync(process.execPath, ["--import", "tsx", "scripts/capabilities/check-price-sync.ts", dir], { encoding: "utf8" });
    expect(child.stderr).toBe("");
    expect(child.status).toBe(0);
    expect(loadTregCatalog({ dir, syncFile: target }).byId.get(endpointId)?.cost?.usd).toBe(0.001);
    const corrupt = JSON.stringify({ ...first, entries: [{ ...first.entries[0], now: { unit: "record", usd: 1e-12 } }] });
    writeFileSync(target, corrupt);
    const rejected = spawnSync(process.execPath, ["--import", "tsx", "scripts/capabilities/check-price-sync.ts", dir], { encoding: "utf8" });
    expect(rejected.status).not.toBe(0);
    await expect(main(["--dir", dir, "--date", date, "--apply"], async () => { throw new Error("unexpected fetch"); })).rejects.toThrow(/invalid price sync/);
    expect(readFileSync(target, "utf8")).toBe(corrupt);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


it("only the proven fixture rates change and all other catalog fields are retained", () => {
  const fixtureDir = "tests/fixtures/dt-0119-12";
  const observations = new Map<string, PriceObservation>();
  for (const file of readdirSync(fixtureDir).filter((name) => name.endsWith(".json"))) {
    const id = file.slice(0, -5);
    observations.set(id, observePrice(id, { ok: true, status: 200, text: readFileSync(path.join(fixtureDir, file), "utf8") }));
  }
  const before = loadTregPriceBaseline();
  const { file, rows } = buildPriceSync(before, empty, observations, PINNED_PRICE_IDS, date);
  expect(rows.map((row) => row.reason)).toEqual([
    "apply", "apply", "apply", "apply",
    "size_note_changed", "size_note_changed", "size_note_changed", "input_added",
    "basis_unproven", "basis_unproven", "basis_unproven",
  ]);
  expect(file).toEqual(JSON.parse(readFileSync(path.join(catalogDir, "price_sync.json"), "utf8")));

  const rates = new Map(file.entries.map((entry) => [entry.id, entry.now?.usd]));
  const assertOnlyProvenPricesChanged = (catalog: TregCatalog) => {
    for (const stored of before.endpoints) {
      const usd = rates.get(stored.id);
      const expected = usd === undefined ? stored : { ...stored, cost: { ...stored.cost, usd } };
      assert.deepEqual(catalog.byId.get(stored.id), expected, stored.id);
    }
  };
  assertOnlyProvenPricesChanged(loadTregCatalog());
  const control = before.endpoints.find((endpoint) => !rates.has(endpoint.id) && endpoint.cost?.usd)!;
  const mutant = loadTregCatalog({ syncFile: path.join(catalogDir, "price_sync.json") });
  const observed = mutant.byId.get(control.id)!;
  observed.cost = { ...observed.cost!, usd: observed.cost!.usd! + 0.000001 };
  expect(() => assertOnlyProvenPricesChanged(mutant)).toThrow(control.id);
});

it("rejects invalid anchors, foreign units, and duplicate or pinned entries before changing the catalog", () => {
  const valid = { id, was: { unit: "record", usd: 0.000495 }, now: { unit: "record", usd: 0.001 }, since: date };
  const cases: Array<{ entries: PriceSyncEntry[]; pinned?: Set<string> }> = [
    { entries: [{ ...valid, was: { ...valid.was, usd: 0.0005 } }] },
    { entries: [{ ...valid, now: { ...valid.now, unit: "page" } }] },
    { entries: [valid, valid] },
    { entries: [valid], pinned: new Set([id]) },
  ];
  for (const { entries, pinned } of cases) {
    const cold = baseline();
    expect(() => applyPriceSync(cold, { revision: 2, entries }, pinned ?? new Set())).toThrow(/invalid price sync/);
    expect(cold.byId.get(id)?.cost?.usd).toBe(0.000495);
  }
});
