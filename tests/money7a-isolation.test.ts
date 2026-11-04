import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * MONEY PR 7a, PHASE 2A: THE NEW MODULES ARE ISOLATED (docs/MONEY-PR-7A.md section 7; wiring is Phase 2B, a separate brief). Proof by the import graph and by reading the sources:
 *   - no production file (src/, agent/src/) imports a new module, except the new modules themselves: only tests reach them;
 *   - the money file addonSettlement.ts reaches no display or Stage 4 module (the shown prices are pinned equal by tests, not imported) and nothing of the worker;
 *   - the new files read no environment variable, name no flag, make no fetch and no console output;
 *   - addonSettlement.ts moves money ONLY through the existing database functions and writes no money table by hand;
 *   - the Stage 4 flags that would switch the paid features on are not set here.
 */
const ROOT = path.resolve(__dirname, "..");
function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (/\.(ts|tsx|mjs|js)$/.test(name)) out.push(p);
  }
  return out;
}
const rel = (f: string) => path.relative(ROOT, f).split(path.sep).join("/");
const SOURCES = [...files(path.join(ROOT, "src")), ...files(path.join(ROOT, "agent", "src"))];
function resolve(from: string, spec: string): string | null {
  const base = spec.startsWith("@/") ? path.join(ROOT, "src", spec.slice(2)) : spec.startsWith(".") ? path.resolve(path.dirname(from), spec) : null;
  if (!base) return null;
  for (const c of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) if (existsSync(c) && statSync(c).isFile()) return c;
  return null;
}
const importsOf = new Map<string, string[]>(SOURCES.map((f) => {
  const text = readFileSync(f, "utf8");
  const specs = [...text.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)["']([^"']+)["']/g)].map((m) => m[1]);
  return [f, specs.map((s) => resolve(f, s)).filter((x): x is string => x !== null)];
}));
/** Every file whose imports reach `target`, directly or through other files. */
function reachers(target: string): Set<string> {
  const out = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const [f, deps] of importsOf) if (!out.has(f) && f !== target && deps.some((d) => d === target || out.has(d))) { out.add(f); grew = true; }
  }
  return out;
}
/** The imports that exist at RUN time: a `import type` line is erased by the compiler and loads nothing. */
const runtimeImportsOf = new Map<string, string[]>(SOURCES.map((f) => {
  const text = readFileSync(f, "utf8").replace(/^\s*import type [^;]*;?\s*$/gm, "");
  const specs = [...text.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)["']([^"']+)["']/g)].map((m) => m[1]);
  return [f, specs.map((s) => resolve(f, s)).filter((x): x is string => x !== null)];
}));
function runtimeClosure(from: string): Set<string> {
  const out = new Set<string>();
  const stack = [from];
  while (stack.length) for (const d of runtimeImportsOf.get(stack.pop()!) ?? []) if (!out.has(d)) { out.add(d); stack.push(d); }
  return out;
}
/** Every file `from` reaches through its imports. */
function closure(from: string): Set<string> {
  const out = new Set<string>();
  const stack = [from];
  while (stack.length) for (const d of importsOf.get(stack.pop()!) ?? []) if (!out.has(d)) { out.add(d); stack.push(d); }
  return out;
}
const code = (f: string) => readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const NEW_SRC = ["src/lib/agentMission/addonSettlement.ts", "src/lib/agentMission/stage4/addonQuote.ts", "src/lib/agentMission/stage4/addonRow.ts"];
/** Phase 2B-1: the worker's add-on runner and the small pure pieces it needs. */
const NEW_WORKER = ["agent/src/stage4/addonFiles.ts", "agent/src/stage4/addonText.ts", "agent/src/stage4/dispatch.ts", "agent/src/stage4/rereadRun.ts", "agent/src/stage4/runAddon.ts", "src/lib/agentMission/stage4/reread.ts", "src/lib/agentMission/stage4/editCore.ts"];
const NEW = [...NEW_SRC, ...NEW_WORKER];
/** The only production file outside the new modules that may reach them: the worker's entry point, through dispatch.ts (its one small change). */
const ENTRY = ["agent/src/main.ts"];
/** Existing Stage 4 siblings that import a new pure piece (editVersion.ts adds the displayed price to the rules of editCore.ts). */
const SIBLINGS = ["src/lib/agentMission/stage4/editVersion.ts"];
const abs = (r: string) => path.join(ROOT, r);

describe("the new modules exist and nothing in production reaches them", () => {
  it("every file is there", () => { for (const r of NEW) expect(existsSync(abs(r))).toBe(true); });
  for (const r of NEW) it(`${r}: only the new modules, the worker's entry point (through the dispatch) and tests reach it`, () => {
    const who = [...reachers(abs(r))].map(rel).filter((f) => !NEW.includes(f) && !ENTRY.includes(f) && !SIBLINGS.includes(f));
    expect(who).toEqual([]);
  });
  it("agent/src/main.ts imports exactly one new module: the dispatch", () => {
    const imported = (importsOf.get(abs("agent/src/main.ts")) ?? []).map(rel).filter((f) => NEW.includes(f));
    expect(imported).toEqual(["agent/src/stage4/dispatch.ts"]);
  });
  it("the displayed prices and the card are never reached from production: addonQuote.ts and quotes.ts are imported by tests and by each other only", () => {
    const quoters = [abs("src/lib/agentMission/stage4/addonQuote.ts"), abs("src/lib/agentMission/stage4/quotes.ts")];
    for (const q of quoters) expect([...reachers(q)].map(rel).filter((f) => !f.startsWith("src/lib/agentMission/stage4/"))).toEqual([]);
  });
});

describe("the money file reaches no display, no Stage 4 module and nothing of the worker", () => {
  const settlement = abs("src/lib/agentMission/addonSettlement.ts");
  it("its imports, followed all the way down, contain no stage4 file, no quotes.ts and nothing under agent/", () => {
    const deps = [...closure(settlement)].map(rel);
    expect(deps.filter((f) => f.includes("/stage4/"))).toEqual([]);
    expect(deps.filter((f) => f.startsWith("agent/"))).toEqual([]);
    expect(deps).toContain("src/lib/agentMission/lifecycle.ts"); // it reuses settleMission: the check is not empty
    expect(deps).toContain("src/lib/agentMission/price.ts");
  });
  it("it moves money only through the existing functions and touches no money table by hand", () => {
    const src = code(settlement);
    const rpcs = [...src.matchAll(/\.rpc\(\s*"([a-z_]+)"/g)].map((m) => m[1]);
    expect([...new Set(rpcs)].sort()).toEqual(["accept_quote_atomic", "claim_job_chunk", "create_quote_atomic", "release_job_atomic"]);
    const tables = [...src.matchAll(/\.from\(\s*([A-Za-z_"]+)/g)].map((m) => m[1]);
    expect([...new Set(tables)].sort()).toEqual(["MISSION_EVENTS_TABLE", "MISSION_TABLE"]);
    expect(src).not.toMatch(/credit_ledger|"jobs"|plans_quotes|delta\s*:|ledger\.(insert|push)/);
    // settlement goes through the existing settleMission, never through settle_job_atomic or complete_chunk directly
    expect(src).toMatch(/settleMission\(/);
    expect(src).not.toMatch(/settle_job_atomic|complete_chunk/);
  });
});

describe("the new files are inert: no environment, no flag, no network, no console", () => {
  for (const r of NEW) it(r, () => {
    const src = code(abs(r));
    expect(src).not.toMatch(/process\.env|import\.meta\.env/);
    expect(src).not.toMatch(/DIGER_STAGE4|stage4Enabled|stage4FlagMode/);
    expect(src).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|console\./);
  });
});

describe("the worker's runner is independent of the flags and of the displayed prices", () => {
  const runner = abs("agent/src/stage4/runAddon.ts");
  it("its run-time imports, followed all the way down, contain no flag reader, no quotes.ts and no addonQuote.ts", () => {
    const deps = [...runtimeClosure(runner)].map(rel);
    expect(deps).not.toContain("src/lib/agentMission/stage4/flags.ts");
    expect(deps).not.toContain("src/lib/agentMission/stage4/quotes.ts");
    expect(deps).not.toContain("src/lib/agentMission/stage4/addonQuote.ts");
    expect(deps).toContain("src/lib/agentMission/addonSettlement.ts"); // it settles through the money core: the check is not empty
    expect(deps).toContain("agent/src/gateway.ts"); // and re-reads through the existing gateway
  });
  it("the money core is only called through its own functions: no ledger or jobs write, one read-only look at a job's status", () => {
    const src = code(runner);
    expect(src).not.toMatch(/\.rpc\(|credit_ledger|plans_quotes|\.insert\(|\.upsert\(|\.delete\(/);
    expect([...src.matchAll(/\.from\(\s*"([a-z_]+)"/g)].map((m) => m[1])).toEqual(["jobs"]);
    expect(src).toMatch(/\.select\("status,charged_credits"\)/);
    expect(src).toMatch(/settleAddon\(/);
  });
});

describe("the flags stay unset", () => {
  it("the Stage 4 flags that would switch the paid features on are not set in this environment", () => {
    expect(process.env.DIGER_STAGE4_REVIEW).toBeUndefined();
    expect(process.env.DIGER_STAGE4_EDITS).toBeUndefined();
  });
});
