import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * DT-20261118-06 phase 2A: the model key stays on the server. The AI drafting helper lives in src/lib/server/messageDraft.ts and is called only by its admin route;
 * no browser file (the admin pages and components) may pull in a server module that can read a key. `npm run build` is not run by the team, so this static check stands in
 * for the client-bundle secret check on the new files.
 */
const ROOT = process.cwd();
const IMPORT = /(?:^|\n)\s*(import|export)\s+(type\s+)?(?:[^;'"]*?\s+from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|require\(\s*["']([^"']+)["']\s*\)/g;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
  });
}
/** The modules a file imports at run time (`import type` is erased by the compiler and never reaches the browser). */
function valueImports(file: string): string[] {
  const src = readFileSync(file, "utf8");
  const out: string[] = [];
  for (const m of src.matchAll(IMPORT)) {
    if (m[2]) continue;
    out.push(m[3] ?? m[4] ?? m[5]);
  }
  return out;
}
function resolve(from: string, spec: string): string | null {
  const base = spec.startsWith("@/") ? path.join(ROOT, "src", spec.slice(2)) : spec.startsWith(".") ? path.resolve(path.dirname(from), spec) : null;
  if (!base) return null;
  for (const c of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) if (existsSync(c) && statSync(c).isFile()) return c;
  return null;
}
/** Every source file reachable from `file` through run-time imports. */
function closure(file: string): string[] {
  const seen = new Set<string>();
  const stack = [file];
  while (stack.length) {
    const f = stack.pop() as string;
    if (seen.has(f)) continue;
    seen.add(f);
    for (const spec of valueImports(f)) { const r = resolve(f, spec); if (r) stack.push(r); }
  }
  return [...seen].map((f) => path.relative(ROOT, f));
}

const CLIENT_FILES = [...walk(path.join(ROOT, "src/components")), ...walk(path.join(ROOT, "src/app/admin"))];
/** Pre-existing value imports of two pure label modules (the jobs and conference pages, before this work); nothing else under lib/server may reach the browser. */
const GRANDFATHERED = new Set(["@/lib/server/adminJobState", "@/lib/server/adminTestAccounts"]);

describe("the drafting key never reaches browser code", () => {
  it("no admin page or component imports src/lib/server/** at run time (two pre-existing label modules aside), the key resolver or the model call", () => {
    const bad: string[] = [];
    for (const f of CLIENT_FILES) {
      const src = readFileSync(f, "utf8");
      if (/resolveProviderKey|callAnthropicBlocks/.test(src)) bad.push(`${path.relative(ROOT, f)}: names the key resolver or the model call`);
      for (const spec of valueImports(f)) {
        if (/(^|\/)lib\/server\//.test(spec) && !GRANDFATHERED.has(spec)) bad.push(`${path.relative(ROOT, f)}: ${spec}`);
        if (/invoices\/assist/.test(spec) && /server/.test(spec)) bad.push(`${path.relative(ROOT, f)}: ${spec}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it.each(["src/lib/messageDraft.ts", "src/components/admin/MessageComposer.tsx", "src/components/admin/CustomerEmailPanel.tsx", "src/app/admin/messages/page.tsx"])(
    "%s reaches no server module, at any depth", (file) => {
      expect(existsSync(path.join(ROOT, file)), file).toBe(true);
      const reached = closure(path.join(ROOT, file));
      expect(reached.filter((f) => /src\/lib\/server\/|supabase\/server|providerKeys/.test(f))).toEqual([]);
    },
  );

  it("the model is called only from the server helper, and the route checks the admin first", () => {
    expect(readFileSync("src/lib/server/messageDraft.ts", "utf8")).toMatch(/callAnthropicBlocks/);
    const route = readFileSync("src/app/api/admin/messages/draft/route.ts", "utf8");
    const body = route.slice(route.indexOf("export async function POST"));
    expect(body.indexOf("authenticateAdmin(")).toBeGreaterThan(-1);
    expect(body.indexOf("authenticateAdmin(")).toBeLessThan(body.indexOf("req.json"));
    expect(closure(path.join(ROOT, "src/lib/messageDraft.ts")).every((f) => !/server/.test(f))).toBe(true);
  });
});
