import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

export type GuardRule = "arabic_regex" | "treg_token" | "srv_path" | "fallback_list";

export interface GuardViolation {
  file: string;
  line: number;
  rule: GuardRule;
  detail: string;
  formatted: string;
}

export interface DesignGuardsAllowList {
  arabic_regex: Array<{ file: string; pattern: string }>;
  treg_tokens: Array<{ file: string; token: string }>;
  srv_paths: Array<{ file: string; pattern: string }>;
  fallback_lists: Array<{ file: string; pattern: string }>;
}

export class AllowIndex {
  private arabicRegexSet = new Set<string>();
  private tregTokensSet = new Set<string>();
  private srvPathsSet = new Set<string>();
  private fallbackListsSet = new Set<string>();

  constructor(allowList?: Partial<DesignGuardsAllowList>) {
    if (!allowList) return;
    for (const item of allowList.arabic_regex ?? []) {
      this.arabicRegexSet.add(`${item.file}::${item.pattern}`);
    }
    for (const item of allowList.treg_tokens ?? []) {
      this.tregTokensSet.add(`${item.file}::${item.token.toLowerCase()}`);
    }
    for (const item of allowList.srv_paths ?? []) {
      this.srvPathsSet.add(`${item.file}::${item.pattern}`);
    }
    for (const item of allowList.fallback_lists ?? []) {
      this.fallbackListsSet.add(`${item.file}::${item.pattern}`);
    }
  }

  isAllowed(file: string, rule: GuardRule, key: string): boolean {
    const k = `${file}::${key}`;
    switch (rule) {
      case "arabic_regex":
        return this.arabicRegexSet.has(k);
      case "treg_token":
        return this.tregTokensSet.has(`${file}::${key.toLowerCase()}`);
      case "srv_path":
        return this.srvPathsSet.has(k);
      case "fallback_list":
        return this.fallbackListsSet.has(k);
    }
  }
}

export interface TregCatalogIds {
  providers: Set<string>;
  endpoints: Set<string>;
  providerQuickRegex: RegExp;
  providerQuickRegexNoX: RegExp;
}

export function loadTregCatalogIds(tregDir: string = path.resolve(__dirname, "../data/treg")): TregCatalogIds {
  const providers = new Set<string>();
  const endpoints = new Set<string>();

  if (!fs.existsSync(tregDir)) {
    return { providers, endpoints, providerQuickRegex: /(?!)/, providerQuickRegexNoX: /(?!)/ };
  }

  for (const file of fs.readdirSync(tregDir)) {
    if (!file.endsWith(".json")) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(tregDir, file), "utf8"));
      if (Array.isArray(data.providers)) {
        for (const p of data.providers) {
          if (typeof p === "string") providers.add(p.toLowerCase());
        }
      }
      if (Array.isArray(data.ids)) {
        for (const id of data.ids) {
          if (typeof id === "string") endpoints.add(id.toLowerCase());
        }
      }
      if (Array.isArray(data.pausedProviders)) {
        for (const p of data.pausedProviders) {
          if (typeof p === "string") providers.add(p.toLowerCase());
        }
      }
      if (data.endpoints) {
        if (Array.isArray(data.endpoints)) {
          for (const ep of data.endpoints) {
            if (typeof ep === "string") endpoints.add(ep.toLowerCase());
            else if (ep && typeof ep === "object") {
              if (typeof ep.id === "string") endpoints.add(ep.id.toLowerCase());
              if (typeof ep.endpoint_id === "string") endpoints.add(ep.endpoint_id.toLowerCase());
              if (typeof ep.provider === "string") providers.add(ep.provider.toLowerCase());
            }
          }
        } else if (typeof data.endpoints === "object") {
          for (const [k, ep] of Object.entries(data.endpoints as Record<string, any>)) {
            endpoints.add(k.toLowerCase());
            if (ep && typeof ep.provider === "string") providers.add(ep.provider.toLowerCase());
          }
        }
      }
      if (Array.isArray(data)) {
        for (const item of data) {
          if (item && typeof item === "object") {
            if (typeof item.id === "string") endpoints.add(item.id.toLowerCase());
            if (typeof item.provider === "string") providers.add(item.provider.toLowerCase());
          }
        }
      }
    } catch {
      // Ignore unparseable files
    }
  }

  const escaped = Array.from(providers)
    .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const providerQuickRegex = escaped.length > 0 ? new RegExp(`\\b(?:${escaped})\\b`, "i") : /(?!)/;

  const providersNoX = Array.from(providers).filter((p) => p !== "x");
  const escapedNoX = providersNoX.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const providerQuickRegexNoX = escapedNoX.length > 0 ? new RegExp(`\\b(?:${escapedNoX})\\b`, "i") : /(?!)/;

  return { providers, endpoints, providerQuickRegex, providerQuickRegexNoX };
}

export function loadAllowList(
  allowListPath: string = path.resolve(__dirname, "fixtures/design-guards-allow.json")
): AllowIndex {
  if (!fs.existsSync(allowListPath)) {
    return new AllowIndex();
  }
  const raw = JSON.parse(fs.readFileSync(allowListPath, "utf8"));
  return new AllowIndex(raw);
}

export function getSourceFiles(rootDirs: string[] = ["src", "agent/src"], baseDir: string = process.cwd()): string[] {
  const result: string[] = [];

  function collect(dir: string) {
    if (!fs.existsSync(dir)) return;
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) {
        collect(full);
      } else if (/\.(ts|tsx|js|mjs|cjs)$/.test(item.name)) {
        result.push(path.relative(baseDir, full).replace(/\\/g, "/"));
      }
    }
  }

  for (const r of rootDirs) {
    collect(path.resolve(baseDir, r));
  }

  return result.sort();
}

const ARABIC_LETTERS_REGEX = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

export function scanSourceCode(
  filePath: string,
  code: string,
  catalog: TregCatalogIds,
  allowIndex?: AllowIndex
): GuardViolation[] {
  const hasArabic = ARABIC_LETTERS_REGEX.test(code);
  const hasSrv = code.includes("/srv/");
  const hasFindSome = code.includes(".find(") || code.includes(".some(");
  const hasXLiteral = code.includes('"x"') || code.includes("'x'") || code.includes("`x`") || code.includes(".x.");
  const hasProviderOrEp = catalog.providerQuickRegexNoX.test(code) || hasXLiteral;

  // If none of the guard triggers are present, skip AST parsing entirely
  if (!hasArabic && !hasSrv && !hasFindSome && !hasProviderOrEp) {
    return [];
  }

  const violations: GuardViolation[] = [];
  const sf = ts.createSourceFile(filePath, code, ts.ScriptTarget.Latest, false);

  function isModuleSpecifier(node: ts.Node, parent: ts.Node | undefined): boolean {
    if (!parent) return false;
    // static: import ... from "..." or export ... from "..."
    if (ts.isImportDeclaration(parent) && parent.moduleSpecifier === node) return true;
    if (ts.isExportDeclaration(parent) && parent.moduleSpecifier === node) return true;
    // dynamic import: import("...") or require("...")
    if (ts.isCallExpression(parent)) {
      if (parent.expression.kind === ts.SyntaxKind.ImportKeyword && parent.arguments[0] === node) return true;
      if (ts.isIdentifier(parent.expression) && parent.expression.text === "require" && parent.arguments[0] === node) return true;
    }
    // type import: import("...").Type
    if ((ts as any).isImportTypeNode && (ts as any).isImportTypeNode(parent) && (parent as any).argument === node) return true;
    return false;
  }

  function checkAndAdd(node: ts.Node, rule: GuardRule, detail: string, allowKey: string) {
    if (allowIndex && allowIndex.isAllowed(filePath, rule, allowKey)) {
      return;
    }
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    violations.push({
      file: filePath,
      line,
      rule,
      detail,
      formatted: `${filePath}:${line}: [${rule}] ${detail}`,
    });
  }

  function walk(node: ts.Node, parent?: ts.Node) {
    // 1. Regex literal or RegExp() call with Arabic letters
    if (hasArabic) {
      if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) {
        const text = node.getText(sf);
        if (ARABIC_LETTERS_REGEX.test(text)) {
          checkAndAdd(node, "arabic_regex", `Arabic regex literal: ${text}`, text);
        }
      } else if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const expr = node.expression;
        if (expr && ts.isIdentifier(expr) && expr.text === "RegExp") {
          const arg = node.arguments && node.arguments[0];
          if (arg) {
            const argText = arg.getText(sf);
            if (ARABIC_LETTERS_REGEX.test(argText)) {
              checkAndAdd(node, "arabic_regex", `Arabic RegExp call: ${argText}`, argText);
            }
          }
        }
      }
    }

    // 2. Treg tokens (endpoint id / provider id) & 3. srv paths
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && !isModuleSpecifier(node, parent)) {
      const text = node.text;

      // Rule 3: /srv/ paths
      if (hasSrv && text.includes("/srv/")) {
        checkAndAdd(node, "srv_path", `String literal containing «/srv/»: "${text}"`, text);
      }

      // Rule 2: Endpoint ID or Provider ID from data/treg/*.json
      if (hasProviderOrEp && text.length >= 1) {
        const lower = text.toLowerCase();

        // Exact endpoint match or dot-separated endpoint token
        if (catalog.endpoints.has(lower)) {
          checkAndAdd(node, "treg_token", `Hardcoded endpoint ID: "${lower}"`, lower);
        } else if (lower.includes(".") && catalog.providerQuickRegex.test(lower)) {
          const epTokens = lower.split(/[^a-z0-9_.-]+/).filter(Boolean);
          for (const tok of epTokens) {
            if (catalog.endpoints.has(tok)) {
              checkAndAdd(node, "treg_token", `Hardcoded endpoint ID: "${tok}"`, tok);
            }
          }
        }

        // Exact provider match or provider token
        if (catalog.providers.has(lower)) {
          checkAndAdd(node, "treg_token", `Hardcoded provider ID: "${lower}"`, lower);
        } else if (catalog.providerQuickRegex.test(lower)) {
          const provTokens = lower.split(/[^a-z0-9_-]+/).filter(Boolean);
          for (const tok of provTokens) {
            if (catalog.providers.has(tok)) {
              checkAndAdd(node, "treg_token", `Hardcoded provider ID: "${tok}"`, tok);
            }
          }
        }
      }
    }

    // 4. Array literal fallback: ["a", "b", "c", "d"...].find(...) or .some(...)
    if (hasFindSome && ts.isCallExpression(node)) {
      const expr = node.expression;
      if (ts.isPropertyAccessExpression(expr)) {
        const prop = expr.name.text;
        if (prop === "find" || prop === "some") {
          const arrayNode = expr.expression;
          if (ts.isArrayLiteralExpression(arrayNode)) {
            const elements = arrayNode.elements;
            if (elements.length >= 4) {
              const allShortLower = elements.every((el) => {
                if (ts.isStringLiteral(el) || ts.isNoSubstitutionTemplateLiteral(el)) {
                  const val = el.text;
                  return val === val.toLowerCase() && val.length <= 30;
                }
                return false;
              });
              if (allShortLower) {
                const items = elements.map((e) => (e as ts.StringLiteral).text);
                const pattern = items.join(",");
                checkAndAdd(
                  node,
                  "fallback_list",
                  `Fallback array literal of 4+ short lowercase strings (.${prop}): [${pattern}]`,
                  pattern
                );
              }
            }
          }
        }
      }
    }

    ts.forEachChild(node, (child) => walk(child, node));
  }

  walk(sf);
  return violations;
}

export function scanCodebase(
  options: {
    rootDirs?: string[];
    baseDir?: string;
    allowIndex?: AllowIndex;
    catalog?: TregCatalogIds;
  } = {}
): GuardViolation[] {
  const baseDir = options.baseDir ?? process.cwd();
  const rootDirs = options.rootDirs ?? ["src", "agent/src"];
  const catalog = options.catalog ?? loadTregCatalogIds(path.resolve(baseDir, "data/treg"));
  const allowIndex = options.allowIndex ?? loadAllowList(path.resolve(baseDir, "tests/fixtures/design-guards-allow.json"));
  const files = getSourceFiles(rootDirs, baseDir);

  const allViolations: GuardViolation[] = [];

  for (const relFile of files) {
    const fullPath = path.resolve(baseDir, relFile);
    const code = fs.readFileSync(fullPath, "utf8");
    const fileViolations = scanSourceCode(relFile, code, catalog, allowIndex);
    allViolations.push(...fileViolations);
  }

  return allViolations;
}
