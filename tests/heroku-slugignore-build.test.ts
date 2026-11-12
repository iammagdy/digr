import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * HEROKU REMOVES .slugignore PATHS BEFORE THE BUILD (12 Nov 2026). The builds of dd6c9ec and a577d16 failed with
 * `Error: Cannot find module '/tmp/build_…/scripts/write-build-info.mjs'`: the root .slugignore lists `scripts/`, Heroku deletes those paths
 * right after checkout and BEFORE `heroku-postbuild` runs, so `node scripts/write-build-info.mjs` exited 1 and the push was rejected
 * (the worker stayed on 092a010). The script now lives in agent/scripts/.
 *
 * These tests simulate that pruning: every file the build runs, and every file the worker loads at runtime (the Procfile entry, its whole
 * static import graph, the system prompt), must survive .slugignore.
 */
const ROOT = path.join(__dirname, "..");
const rel = (p: string) => path.relative(ROOT, p).split(path.sep).join("/");

/** The .slugignore rules as root-anchored path prefixes. Any syntax this simple matcher does not understand fails the test (so it never silently passes). */
function slugignoreRules(): string[] {
  return readFileSync(path.join(ROOT, ".slugignore"), "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      if (/[*?[\]!]/.test(l)) throw new Error(`.slugignore rule "${l}" uses glob syntax: extend heroku-slugignore-build.test.ts before adding it`);
      return l.replace(/^\/+/, "").replace(/\/+$/, "");
    });
}
export function removedBySlugignore(file: string, rules: string[] = slugignoreRules()): string | null {
  const f = file.replace(/^\.\//, "");
  return rules.find((r) => f === r || f.startsWith(`${r}/`)) ?? null;
}

/** Relative paths the heroku-postbuild script runs or points at (`node X`, `tsc -p X`, `--prefix X`). */
function postbuildPaths(cmd: string): string[] {
  const out: string[] = [];
  for (const m of cmd.matchAll(/\bnode\s+([^\s&|;]+)/g)) out.push(m[1]);
  for (const m of cmd.matchAll(/\btsc\s+-p\s+([^\s&|;]+)/g)) out.push(m[1]);
  for (const m of cmd.matchAll(/--prefix\s+([^\s&|;]+)/g)) out.push(`${m[1]}/package.json`);
  return out;
}

const IMPORT = /(?:import|export)\s+(?:type\s+)?(?:[^"';]*?\sfrom\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
function resolveTs(fromFile: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = path.join(ROOT, "src", spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(fromFile), spec);
  else return null; // a package or node: builtin
  const stem = base.replace(/\.(js|mjs|cjs)$/, "");
  for (const c of [base, `${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) if (existsSync(c) && statSync(c).isFile()) return c;
  throw new Error(`${rel(fromFile)} imports "${spec}", which does not resolve`);
}
/** Every source file the worker loads, from the Procfile entry (static and literal dynamic imports, type-only imports included: tsc -p agent checks them during the build). */
function workerImportGraph(entry: string): string[] {
  const seen = new Set<string>();
  const stack = [path.join(ROOT, entry)];
  while (stack.length) {
    const f = stack.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(IMPORT)) {
      const r = resolveTs(f, m[1] ?? m[2]);
      if (r && !seen.has(r)) stack.push(r);
    }
  }
  return [...seen].map(rel).sort();
}

describe(".slugignore never removes what the Heroku build or worker needs", () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
  const procfile = readFileSync(path.join(ROOT, "Procfile"), "utf8");
  const workerLine = procfile.split("\n").find((l) => l.startsWith("worker:")) ?? "";
  const entry = (workerLine.match(/(\S+\.ts)\s*$/) ?? [])[1];

  it("the simulated pruning reproduces the 12 Nov failure (the old path is removed, the new one kept)", () => {
    expect(removedBySlugignore("scripts/write-build-info.mjs")).toBe("scripts");
    expect(removedBySlugignore("agent/scripts/write-build-info.mjs")).toBeNull();
    expect(postbuildPaths("npm ci --prefix agent && tsc -p agent/tsconfig.json && node scripts/write-build-info.mjs")).toContain("scripts/write-build-info.mjs");
  });

  it("every path heroku-postbuild runs exists in the repository and survives .slugignore", () => {
    const paths = postbuildPaths(pkg.scripts["heroku-postbuild"]);
    expect(paths).toEqual(["agent/scripts/write-build-info.mjs", "agent/tsconfig.json", "agent/package.json"]);
    for (const p of paths) {
      expect(existsSync(path.join(ROOT, p)), `${p} exists`).toBe(true);
      expect(removedBySlugignore(p), `${p} is removed by .slugignore before the build`).toBeNull();
    }
  });

  it("the worker's Procfile entry, its whole import graph and its system prompt survive .slugignore", () => {
    expect(entry).toBe("agent/src/main.ts");
    const graph = workerImportGraph(entry!);
    expect(graph.length).toBeGreaterThan(50);
    expect(graph).toContain("agent/src/buildVersion.ts");
    const removed = graph.filter((f) => removedBySlugignore(f));
    expect(removed).toEqual([]);
    expect(removedBySlugignore("agent/prompts/system.md")).toBeNull();
    expect(existsSync(path.join(ROOT, "agent/prompts/system.md"))).toBe(true);
  });

  it("the build-info script is not under the root scripts/ directory any more", () => {
    expect(existsSync(path.join(ROOT, "scripts/write-build-info.mjs"))).toBe(false);
    expect(existsSync(path.join(ROOT, "agent/scripts/write-build-info.mjs"))).toBe(true);
  });
});
