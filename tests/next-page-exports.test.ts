import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Next.js App Router allowed page/layout/template/loading/error/not-found exports.
 * Exporting arbitrary helper functions or constants causes Vercel/Next production build errors.
 */
export const ALLOWED_NEXT_PAGE_EXPORTS = new Set<string>([
  "default",
  "metadata",
  "generateMetadata",
  "generateStaticParams",
  "viewport",
  "generateViewport",
  "revalidate",
  "dynamic",
  "dynamicParams",
  "fetchCache",
  "runtime",
  "preferredRegion",
  "maxDuration",
  "experimental_ppr",
]);

/**
 * Matches Next.js App Router page/layout entrypoints.
 * route.ts files are exempt (they export HTTP method handlers).
 */
export const NEXT_PAGE_ENTRY_REGEX = /^(page|layout|template|loading|error|not-found)\.(tsx?|jsx?)$/;

export function extractExports(code: string, fileName = "file.tsx"): string[] {
  const sf = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true);
  const exports: string[] = [];

  function visit(node: ts.Node) {
    // export default / export function / export const / export class
    const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
    if (modifiers && modifiers.some((m: ts.ModifierLike) => m.kind === ts.SyntaxKind.ExportKeyword)) {
      if (modifiers.some((m: ts.ModifierLike) => m.kind === ts.SyntaxKind.DefaultKeyword)) {
        exports.push("default");
      } else if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) {
        if (node.name) exports.push(node.name.text);
      } else if (ts.isVariableStatement(node)) {
        for (const decl of node.declarationList.declarations) {
          if (ts.isIdentifier(decl.name)) {
            exports.push(decl.name.text);
          }
        }
      }
    }

    // export { a, b as c, default }
    if (ts.isExportDeclaration(node)) {
      if (!node.isTypeOnly && node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const el of node.exportClause.elements) {
          if (!el.isTypeOnly) {
            exports.push(el.name.text);
          }
        }
      }
    }

    // export default expression (e.g. export default Page;)
    if (ts.isExportAssignment(node)) {
      exports.push("default");
    }

    ts.forEachChild(node, visit);
  }

  visit(sf);
  return exports;
}

export function findDisallowedExports(code: string, fileName = "file.tsx"): string[] {
  const allExports = extractExports(code, fileName);
  return allExports.filter((exp) => !ALLOWED_NEXT_PAGE_EXPORTS.has(exp));
}

describe("Next.js App Router Page & Layout Export Guard (DT-20261122-page-export-guard)", () => {
  it("all page, layout, template, loading, error, not-found files in src/app have ONLY allowed Next.js exports", () => {
    const rootDir = process.cwd();
    const appDir = join(rootDir, "src/app");
    const violations: { file: string; disallowed: string[] }[] = [];
    let scannedFilesCount = 0;

    function scan(dir: string) {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const ent of entries) {
        const full = join(dir, ent.name);
        if (ent.isDirectory()) {
          scan(full);
        } else if (NEXT_PAGE_ENTRY_REGEX.test(ent.name)) {
          scannedFilesCount++;
          const code = readFileSync(full, "utf8");
          const disallowed = findDisallowedExports(code, ent.name);
          if (disallowed.length > 0) {
            violations.push({
              file: relative(rootDir, full),
              disallowed,
            });
          }
        }
      }
    }

    scan(appDir);

    expect(scannedFilesCount).toBeGreaterThanOrEqual(50);
    expect(violations).toEqual([]);
  });

  it("counter-case: a fixture page string with `export function helper()` is reported as disallowed", () => {
    const fixtureCode = `
      import React from "react";

      export default function Page() {
        return <div>Hello</div>;
      }

      export function helper() {
        return "I broke Vercel production build!";
      }
    `;

    const disallowed = findDisallowedExports(fixtureCode, "page.tsx");
    expect(disallowed).toEqual(["helper"]);
  });

  it("counter-case: fixture with exported variables, classes, and re-exports are reported", () => {
    const fixtureCode = `
      export default function Layout({ children }: { children: React.ReactNode }) {
        return <main>{children}</main>;
      }

      export const myHelperConst = 42;
      export let mutableHelper = "bad";
      export class HelperService {}
      const internalFn = () => {};
      export { internalFn as exportedHelper };
    `;

    const disallowed = findDisallowedExports(fixtureCode, "layout.tsx");
    expect(disallowed).toEqual([
      "myHelperConst",
      "mutableHelper",
      "HelperService",
      "exportedHelper",
    ]);
  });

  it("route.ts files are exempt from page export restrictions", () => {
    const routeCode = `
      import { NextResponse } from "next/server";

      export async function GET() {
        return NextResponse.json({ ok: true });
      }

      export async function POST(req: Request) {
        return NextResponse.json({ ok: true });
      }
    `;

    // A route file exports HTTP methods, which are valid for route.ts but not page.tsx
    const isPageFile = NEXT_PAGE_ENTRY_REGEX.test("route.ts");
    expect(isPageFile).toBe(false);

    // If evaluated as a page, it would be caught
    const asPageDisallowed = findDisallowedExports(routeCode, "page.tsx");
    expect(asPageDisallowed).toEqual(["GET", "POST"]);
  });

  it("valid Next.js App Router metadata and config exports pass cleanly without violations", () => {
    const validConfigCode = `
      import type { Metadata, Viewport } from "next";

      export const dynamic = "force-dynamic";
      export const revalidate = 3600;
      export const fetchCache = "default-no-store";
      export const runtime = "nodejs";
      export const maxDuration = 60;

      export const metadata: Metadata = {
        title: "Test Page",
      };

      export const viewport: Viewport = {
        themeColor: "#000",
      };

      export async function generateMetadata(): Promise<Metadata> {
        return { title: "Generated" };
      }

      export async function generateStaticParams() {
        return [{ id: "1" }];
      }

      export default function Page() {
        return <div>Clean</div>;
      }
    `;

    const disallowed = findDisallowedExports(validConfigCode, "page.tsx");
    expect(disallowed).toEqual([]);
  });
});
