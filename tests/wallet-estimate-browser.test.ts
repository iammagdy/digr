import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { loadTregCatalogIds } from "./designGuardsScanner";

const ROOT = path.resolve(__dirname, "..");

function extractModuleSpecifiers(filePath: string, code: string): string[] {
  const sf = ts.createSourceFile(filePath, code, ts.ScriptTarget.Latest, false);
  const specs: string[] = [];
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) && stmt.moduleSpecifier && ts.isStringLiteralLike(stmt.moduleSpecifier)) {
      if (stmt.importClause?.isTypeOnly) continue;
      if (
        stmt.importClause?.namedBindings &&
        ts.isNamedImports(stmt.importClause.namedBindings) &&
        stmt.importClause.namedBindings.elements.every((el) => el.isTypeOnly)
      ) {
        continue;
      }
      specs.push(stmt.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier && ts.isStringLiteralLike(stmt.moduleSpecifier)) {
      if (stmt.isTypeOnly) continue;
      if (stmt.exportClause && ts.isNamedExports(stmt.exportClause) && stmt.exportClause.elements.every((el) => el.isTypeOnly)) {
        continue;
      }
      specs.push(stmt.moduleSpecifier.text);
    }
  }
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.arguments.length >= 1 && ts.isStringLiteralLike(node.arguments[0])) {
      if (
        node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require")
      ) {
        specs.push(node.arguments[0].text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return specs;
}

function resolveImportPath(fromFile: string, specifier: string): string | null {
  let base: string | null = null;
  if (specifier.startsWith("@/")) {
    base = path.join(ROOT, "src", specifier.slice(2));
  } else if (specifier.startsWith("./") || specifier.startsWith("../")) {
    base = path.resolve(path.dirname(fromFile), specifier);
  }
  if (!base) return null;
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.mjs`,
    `${base}.json`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
    path.join(base, "index.js"),
  ];
  for (const cand of candidates) {
    if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return path.resolve(cand);
  }
  return null;
}

describe("walletEstimate browser safety and generated cost sync (Phase 13A)", () => {
  it("transitive AST import walk from src/lib/walletEstimate.ts has 0 node built-ins, catalog, metadata, or toolCards imports", () => {
    const entry = path.resolve(ROOT, "src/lib/walletEstimate.ts");
    const forbiddenBuiltins = new Set(["fs", "path", "crypto", "child_process"]);
    const forbiddenFiles = new Set([
      path.resolve(ROOT, "src/lib/treg/catalog.ts"),
      path.resolve(ROOT, "data/treg/treg_catalog_sellable.json"),
      path.resolve(ROOT, "data/capabilities/provider-metadata.json"),
    ]);
    const toolCardsDir = path.resolve(ROOT, "src/lib/agentMission/foundation/toolCards") + path.sep;

    const seen = new Set<string>([entry]);
    const queue = [entry];
    const violations: string[] = [];

    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (!/\.(ts|tsx|js|jsx|mjs)$/.test(cur)) continue;
      const code = fs.readFileSync(cur, "utf8");
      for (const spec of extractModuleSpecifiers(cur, code)) {
        if (spec.startsWith("node:") || forbiddenBuiltins.has(spec)) {
          violations.push(`${path.relative(ROOT, cur)} -> ${spec}`);
          continue;
        }
        const resolved = resolveImportPath(cur, spec);
        if (!resolved) continue;
        if (forbiddenFiles.has(resolved) || resolved.startsWith(toolCardsDir) || resolved.endsWith("/toolCards.ts")) {
          violations.push(`${path.relative(ROOT, cur)} -> ${path.relative(ROOT, resolved)}`);
        }
        if (!seen.has(resolved)) {
          seen.add(resolved);
          queue.push(resolved);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("data/treg/wallet_estimate_costs.json is pure numeric with 0 catalog IDs and 0 provider/platform tokens", () => {
    const costsPath = path.resolve(ROOT, "data/treg/wallet_estimate_costs.json");
    const raw = fs.readFileSync(costsPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    expect(Object.keys(parsed).sort()).toEqual([
      "commentsUsdPerRow",
      "discoveryUsdPerRow",
      "postsUsdPerRow",
      "repliesUsdPerRow",
    ]);
    for (const [k, v] of Object.entries(parsed)) {
      expect(typeof v, `${k} must be finite positive number`).toBe("number");
      expect(Number.isFinite(v as number) && (v as number) > 0, `${k} > 0`).toBe(true);
    }

    const catalogIds = loadTregCatalogIds(path.resolve(ROOT, "data/treg"));
    const lowerRaw = raw.toLowerCase();
    for (const epId of catalogIds.endpoints) {
      expect(lowerRaw.includes(epId), `endpoint id leaked: ${epId}`).toBe(false);
    }
    const tokens = lowerRaw.split(/[^a-z0-9_-]+/).filter(Boolean);
    const tokenSet = new Set(tokens);
    for (const prov of catalogIds.providers) {
      expect(tokenSet.has(prov), `provider token leaked: ${prov}`).toBe(false);
    }
    for (const tok of ["tikhub", "anyapi", "treg", "firecrawl", "youtube", "x"]) {
      expect(tokenSet.has(tok), `forbidden token leaked: ${tok}`).toBe(false);
    }
  });

  it("data/treg/wallet_estimate_costs.json matches rates derived from treg_catalog_sellable.json and treg.walletEstimateSlots", () => {
    const costsPath = path.resolve(ROOT, "data/treg/wallet_estimate_costs.json");
    const costs = JSON.parse(fs.readFileSync(costsPath, "utf8")) as Record<string, number>;

    const catalog = JSON.parse(
      fs.readFileSync(path.resolve(ROOT, "data/treg/treg_catalog_sellable.json"), "utf8"),
    ) as { endpoints: Array<{ id: string; cost?: { usd?: number } }> };
    const byId = new Map(catalog.endpoints.map((ep) => [ep.id, ep]));

    const metadata = JSON.parse(
      fs.readFileSync(path.resolve(ROOT, "data/capabilities/provider-metadata.json"), "utf8"),
    ) as {
      treg?: {
        walletEstimateSlots?: Record<string, Record<string, { endpointId: string; rowsPerPage: number }>>;
      };
    };
    const slots = metadata.treg?.walletEstimateSlots;
    expect(slots).toBeDefined();

    const rateFor = (group: string, slot: string): number => {
      const cfg = slots?.[group]?.[slot];
      expect(cfg, `missing slot ${group}.${slot}`).toBeDefined();
      const ep = byId.get(cfg!.endpointId);
      expect(ep?.cost?.usd, `missing catalog cost for ${cfg!.endpointId}`).toBeGreaterThan(0);
      expect(cfg!.rowsPerPage).toBeGreaterThanOrEqual(1);
      return ep!.cost!.usd! / cfg!.rowsPerPage;
    };

    expect(costs).toEqual({
      discoveryUsdPerRow: rateFor("youtube-comments", "discovery"),
      commentsUsdPerRow: rateFor("youtube-comments", "comments"),
      repliesUsdPerRow: rateFor("youtube-comments", "replies"),
      postsUsdPerRow: rateFor("x-posts", "posts"),
    });
  });
});
