import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import baseline from "./fixtures/golden-quote-parity-baseline.json";
import { pooledHitRate, finderHitRate } from "../src/lib/agentMission/finderStats";
import { buildContactSteps, finderSourcesOf, alternateFinderSourcesOf, verifierSourcesOf, validatorSourcesOf } from "../src/lib/agentMission/contactFinders";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { priceMissionByCode } from "../src/lib/agentMission/price";
import { checkCustomerText } from "../src/lib/agentMission/text";
import { EMAIL_REVERSE_ORDER, PHONE_REVERSE_ORDER, NO_WATERFALL_ENDPOINTS, COMPANY_DOMAIN_ONLY_ENDPOINTS, US_ONLY_PHONE_ENDPOINTS } from "../src/lib/treg/reverseOrder";
import { ROUTE_DEFS, routeCodeOf, estimateRoute } from "../src/lib/multiProvider/routes";
import { ALL_CUSTOMER_STRINGS } from "../src/lib/multiProvider/copy";
import { walletCapacityOf, minimumOrderPoints, BELOW_MINIMUM_AR, CAPACITY_HEAD_AR, CAPACITY_NOTE_AR } from "../src/lib/walletEstimate";
import { APPROVED_CAPABILITY_CATALOG } from "../src/functions/shared/capabilityRegistry";
import { buildMultiProviderCapability } from "../src/functions/shared/multiProviderCapability";
import { unitPricePointsForCapability, calculateCapabilityQuote } from "../src/functions/shared/quotes";

const ROOT = path.resolve(__dirname, "..");

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      collectSourceFiles(full, out);
    } else if (/\.(ts|tsx|js|jsx|mjs)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function isUseClientFile(filePath: string, code: string): boolean {
  const sf = ts.createSourceFile(filePath, code, ts.ScriptTarget.Latest, false);
  const first = sf.statements[0];
  return Boolean(
    first &&
      ts.isExpressionStatement(first) &&
      ts.isStringLiteralLike(first.expression) &&
      first.expression.text === "use client",
  );
}

function extractModuleSpecifiers(filePath: string, code: string): string[] {
  const sf = ts.createSourceFile(filePath, code, ts.ScriptTarget.Latest, false);
  const specs: string[] = [];
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) && stmt.moduleSpecifier && ts.isStringLiteralLike(stmt.moduleSpecifier)) {
      if (stmt.importClause?.isTypeOnly) continue;
      if (stmt.importClause?.namedBindings && ts.isNamedImports(stmt.importClause.namedBindings) && stmt.importClause.namedBindings.elements.every((el) => el.isTypeOnly)) continue;
      specs.push(stmt.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier && ts.isStringLiteralLike(stmt.moduleSpecifier)) {
      if (stmt.isTypeOnly) continue;
      if (stmt.exportClause && ts.isNamedExports(stmt.exportClause) && stmt.exportClause.elements.every((el) => el.isTypeOnly)) continue;
      specs.push(stmt.moduleSpecifier.text);
    }
  }
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.arguments.length >= 1 && ts.isStringLiteralLike(node.arguments[0])) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require")) {
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

describe("Golden Quote Parity Baseline (Phase 5A / 13A / 13B)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("matches recorded mission pricing baselines byte-for-byte", () => {
    const msn1 = priceMissionByCode([{ rows: 1, costPerRowUsd: 0.00539 / 215, deliver: true }], { capPoints: 25_000 });
    const msn2 = priceMissionByCode([{ rows: 1, costPerRowUsd: 0.00291 / 19, deliver: true }], { capPoints: 25_000 });
    expect(msn1).toEqual(baseline.recordedMissions.msn_c41586cf9d40986250d0);
    expect(msn2).toEqual(baseline.recordedMissions.msn_f91f7e220bbf60fd7c9c);
  });

  it("matches finder hit rates, finder chains, and B2B companies + decision-makers quote", () => {
    const catalog = loadTregCatalog();
    const allowAll = () => true;
    const emailFinders = finderSourcesOf("email", catalog, allowAll);
    const phoneFinders = finderSourcesOf("phone", catalog, allowAll);
    const emailAlts = alternateFinderSourcesOf("email", catalog, allowAll);
    const phoneAlts = alternateFinderSourcesOf("phone", catalog, allowAll);

    expect(pooledHitRate("email")).toBe(baseline.finderStats.pooledHitRate.email);
    expect(pooledHitRate("phone")).toBe(baseline.finderStats.pooledHitRate.phone);
    expect(finderHitRate("blitzapi.people.email.find", "email")).toBe(baseline.finderStats.sampleHitRates["blitzapi.people.email.find"]);
    expect(finderHitRate("quickenrich.people.email.find", "email")).toBe(baseline.finderStats.sampleHitRates["quickenrich.people.email.find"]);
    expect(finderHitRate("anyapi.linkedin.email.work.find", "email")).toBe(baseline.finderStats.sampleHitRates["anyapi.linkedin.email.work.find"]);
    expect(finderHitRate("blitzapi.people.phone.find", "phone")).toBe(baseline.finderStats.sampleHitRates["blitzapi.people.phone.find"]);
    expect(finderHitRate("unmeasured.email.finder", "email")).toBe(baseline.finderStats.sampleHitRates["unmeasured.email.finder"]);
    expect(finderHitRate("unmeasured.phone.finder", "phone")).toBe(baseline.finderStats.sampleHitRates["unmeasured.phone.finder"]);

    expect(emailFinders.map((f) => f.id)).toEqual(baseline.finderStats.finderSourcesOf.email);
    expect(emailAlts.map((f) => f.id)).toEqual(baseline.finderStats.finderSourcesOf.alternateEmail);
    expect(phoneFinders.map((f) => f.id)).toEqual(baseline.finderStats.finderSourcesOf.phone);
    expect(phoneAlts.map((f) => f.id)).toEqual(baseline.finderStats.finderSourcesOf.alternatePhone);

    const steps = buildContactSteps(
      [{
        key: "people",
        title_ar: "موظفو كل شركة",
        parent_key: "companies",
        deliver: true,
        role_preference: { role: "manager" },
        columns: [
          { key: "name" },
          { key: "title" },
          { key: "linkedin" },
          { key: "email", kind: "work_email" },
          { key: "phone", kind: "personal_phone" },
        ],
      }] as any,
      "شركات وصناع قرار بالإيميل ورقم التليفون",
      (kind) => (kind === "email" ? emailFinders : phoneFinders),
      (kind) => (kind === "email" ? { verifiers: verifierSourcesOf(catalog, allowAll) } : { validators: validatorSourcesOf(catalog, allowAll), alternates: phoneAlts }),
    );
    const eStep = steps.find((s) => s.kind === "email")!;
    const pStep = steps.find((s) => s.kind === "phone")!;
    expect({ per_person_usd: eStep.per_person_usd, max_person_usd: eStep.max_person_usd }).toEqual(baseline.b2bSteps.email);
    expect({ per_person_usd: pStep.per_person_usd, max_person_usd: pStep.max_person_usd }).toEqual(baseline.b2bSteps.phone);

    const b2bPrice = priceMissionByCode([
      { rows: 10, costPerRowUsd: 0.000576, deliver: true },
      { rows: 20, costPerRowUsd: 0.003 + eStep.per_person_usd + pStep.per_person_usd, deliver: true },
    ], { capPoints: 25_000 });
    expect(b2bPrice).toEqual(baseline.b2bPrice);
  });

  it("matches fixed-price listed capabilities and execution-funded social quotes", () => {
    for (const [slug, expectedUnit] of Object.entries(baseline.listedUnitPoints)) {
      const cap = APPROVED_CAPABILITY_CATALOG.find((c) => c.slug === slug);
      expect(cap, `missing capability ${slug}`).toBeDefined();
      expect(unitPricePointsForCapability(cap!)).toBe(expectedUnit);
    }

    vi.stubEnv("JOB_MAX_POINTS_CAP", "25000");
    const fbComments = priceMissionByCode([
      { stageKey: "posts", parentKey: null, rows: 20, costPerRowUsd: 0.002 / 3, deliver: false, executionFunding: [{ rowsPerPage: 3, callUsdMicro: 2_000, mode: "paged" }] },
      { stageKey: "comments", parentKey: "posts", rows: 200, costPerRowUsd: 0.00188 / 2, deliver: true, listedRate: { unitPoints: unitPricePointsForCapability({ slug: "social-facebook-comments", unitCostUsd: 0 }), nounAr: "تعليق" }, executionFunding: [{ rowsPerPage: 2, callUsdMicro: 1_880, mode: "paged" }] },
    ], { capPoints: 25_000 });
    expect(fbComments).toEqual(baseline.listedMissions.fbComments);

    const yt5 = priceMissionByCode([{ rows: 5, costPerRowUsd: 0, deliver: true, listedRate: { unitPoints: baseline.listedUnitPoints["social-youtube-videos"], nounAr: "فيديو" } }], { capPoints: 25_000 });
    const yt60 = priceMissionByCode([{ rows: 60, costPerRowUsd: 0, deliver: true, listedRate: { unitPoints: baseline.listedUnitPoints["social-youtube-videos"], nounAr: "فيديو" } }], { capPoints: 25_000 });
    const ytCapQuote60 = calculateCapabilityQuote(60, 0.0009, 100000, undefined, "social-youtube-videos");
    expect(yt5).toEqual(baseline.listedMissions.yt5);
    expect(yt60).toEqual(baseline.listedMissions.yt60);
    expect(ytCapQuote60).toEqual(baseline.listedMissions.ytCapQuote60);
  });

  it("matches wallet capacity estimates and reverse-lookup order lists", () => {
    expect(minimumOrderPoints()).toBe(baseline.wallet.minimumOrderPoints);
    for (const [points, expected] of Object.entries(baseline.wallet.capacities)) {
      expect(walletCapacityOf(Number(points))).toEqual(expected);
    }

    expect([...EMAIL_REVERSE_ORDER]).toEqual(baseline.reverseOrder.EMAIL_REVERSE_ORDER);
    expect([...PHONE_REVERSE_ORDER]).toEqual(baseline.reverseOrder.PHONE_REVERSE_ORDER);
    expect([...NO_WATERFALL_ENDPOINTS]).toEqual(baseline.reverseOrder.NO_WATERFALL_ENDPOINTS);
    expect([...COMPANY_DOMAIN_ONLY_ENDPOINTS]).toEqual(baseline.reverseOrder.COMPANY_DOMAIN_ONLY_ENDPOINTS);
    expect([...US_ONLY_PHONE_ENDPOINTS]).toEqual(baseline.reverseOrder.US_ONLY_PHONE_ENDPOINTS);
  });

  it("matches multi-provider route ids, opaque codes, and route estimates", () => {
    expect(ROUTE_DEFS.map((r) => r.id)).toEqual(baseline.multiProvider.routeIds);
    for (const r of ROUTE_DEFS) {
      expect(routeCodeOf(r.id)).toBe((baseline.multiProvider.routeCodes as Record<string, string>)[r.id]);
    }
    const estimates = ROUTE_DEFS.map((r) => estimateRoute(r, { count: 20, requiredFields: ["work_email"] }));
    expect(estimates).toEqual(baseline.multiProvider.estimates);
  });

  it("A1 browser safety: no 'use client' file under src/ transitively imports finderStats/reverseOrder/provider-metadata, and routes.ts does not import provider-metadata.json", () => {
    const providerMetadataPath = path.resolve(ROOT, "data/capabilities/provider-metadata.json");
    const forbidden = new Set([
      path.resolve(ROOT, "src/lib/agentMission/finderStats.ts"),
      path.resolve(ROOT, "src/lib/treg/reverseOrder.ts"),
      providerMetadataPath,
    ]);
    const srcFiles = collectSourceFiles(path.join(ROOT, "src"));
    const clientFiles = srcFiles.filter((f) => isUseClientFile(f, fs.readFileSync(f, "utf8")));
    expect(clientFiles.length).toBeGreaterThan(0);

    const violations: string[] = [];
    for (const entry of clientFiles) {
      const seen = new Set<string>([path.resolve(entry)]);
      const queue = [path.resolve(entry)];
      while (queue.length > 0) {
        const cur = queue.shift()!;
        if (!/\.(ts|tsx|js|jsx|mjs)$/.test(cur)) continue;
        const code = fs.readFileSync(cur, "utf8");
        for (const spec of extractModuleSpecifiers(cur, code)) {
          const resolved = resolveImportPath(cur, spec);
          if (!resolved) continue;
          if (forbidden.has(resolved)) {
            violations.push(`${path.relative(ROOT, entry)} -> ${path.relative(ROOT, resolved)}`);
          }
          if (!seen.has(resolved)) {
            seen.add(resolved);
            queue.push(resolved);
          }
        }
      }
    }
    expect(violations).toEqual([]);

    const routesEntry = path.resolve(ROOT, "src/lib/multiProvider/routes.ts");
    const routesSeen = new Set<string>([routesEntry]);
    const routesQueue = [routesEntry];
    const routesMetadataViolations: string[] = [];
    while (routesQueue.length > 0) {
      const cur = routesQueue.shift()!;
      if (!/\.(ts|tsx|js|jsx|mjs)$/.test(cur)) continue;
      const code = fs.readFileSync(cur, "utf8");
      for (const spec of extractModuleSpecifiers(cur, code)) {
        const resolved = resolveImportPath(cur, spec);
        if (!resolved) continue;
        if (resolved === providerMetadataPath) {
          routesMetadataViolations.push(`${path.relative(ROOT, cur)} -> ${path.relative(ROOT, resolved)}`);
        }
        if (!routesSeen.has(resolved)) {
          routesSeen.add(resolved);
          routesQueue.push(resolved);
        }
      }
    }
    expect(routesMetadataViolations).toEqual([]);
  });

  it("A5: route ids are rejected by checkCustomerText and neither route ids nor route codes appear in customer copy", () => {
    const mpCap = buildMultiProviderCapability();
    const customerTexts = [
      ...ALL_CUSTOMER_STRINGS(),
      mpCap.nameAr,
      mpCap.descriptionAr,
      BELOW_MINIMUM_AR(200),
      CAPACITY_HEAD_AR,
      CAPACITY_NOTE_AR,
      ...APPROVED_CAPABILITY_CATALOG.flatMap((c) => [c.nameAr, c.descriptionAr]),
    ].join("\n");

    for (const r of ROUTE_DEFS) {
      expect(checkCustomerText(r.id).issues.length).toBeGreaterThan(0);
      expect(customerTexts).not.toContain(r.id);
      expect(customerTexts).not.toContain(routeCodeOf(r.id));
    }
  });
});
