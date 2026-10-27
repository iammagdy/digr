#!/usr/bin/env node
/**
 * Which hand-coded planning code has NO caller left once the model planner serves EVERY account (today only the allowlist of src/lib/modelPlanner/constants.ts)? (Nothing is deleted: this only reads the sources.)
 *
 *   node scripts/agent-loop/dead-code-when-planner-on.mjs            writes docs/proposals/agent-loop/DEAD_CODE_WHEN_PLANNER_SERVES_ALL.md
 *   node scripts/agent-loop/dead-code-when-planner-on.mjs --check    exits 1 when that file is out of date
 *
 * Method (textual, by import graph; NOT a type-aware call graph):
 *  - the hook is the line `if (this.modelPlanner && ...)` in src/functions/shared/chatHandler.ts; everything after it in handleUserMessageInner is the «post-hook region»;
 *  - a symbol imported by chatHandler.ts is «post-hook only» when every use of it in that file is after the hook;
 *  - a file is DEAD when every non-test importer is chatHandler.ts (and every value it imports from the file is post-hook only) or is itself a dead file, repeated to a fixed point;
 *  - a symbol of a live file is DEAD when it is post-hook only and no other non-test source file outside the dead files mentions its name.
 * Caveat (printed in the report): the post-hook region still runs for guest, greeting, general-question, file-shaping and test-scenario turns, which the hook does not take.
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CH = "src/functions/shared/chatHandler.ts";
const OUT = path.join(ROOT, "docs/proposals/agent-loop/DEAD_CODE_WHEN_PLANNER_SERVES_ALL.md");

const walk = (dir) => readdirSync(path.join(ROOT, dir)).flatMap((n) => {
  const rel = `${dir}/${n}`;
  return statSync(path.join(ROOT, rel)).isDirectory() ? walk(rel) : /\.(ts|tsx)$/.test(n) ? [rel] : [];
});
const files = walk("src");
const text = Object.fromEntries(files.map((f) => [f, readFileSync(path.join(ROOT, f), "utf-8")]));

function resolveImport(from, spec) {
  // relative imports and the «@/» alias (tsconfig paths: @/* = src/*)
  if (!spec.startsWith(".") && !spec.startsWith("@/")) return null;
  const base = spec.startsWith("@/") ? path.posix.normalize(`src/${spec.slice(2)}`) : path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  for (const c of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`, base]) if (text[c] !== undefined) return c;
  return null;
}
function importsOf(file) {
  const out = [];
  const re = /(?:import|export)\s+(type\s+)?(?:([\w*\s{},$]+?)\s+from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
  for (let m; (m = re.exec(text[file])); ) {
    const spec = m[3] ?? m[4];
    const target = resolveImport(file, spec);
    if (!target) continue;
    const typeOnly = Boolean(m[1]);
    const names = [];
    const clause = m[2] ?? "";
    const brace = /\{([^}]*)\}/.exec(clause);
    if (brace) for (const n of brace[1].split(",")) { const t = n.trim(); if (t && !t.startsWith("type ")) names.push(t.split(/\s+as\s+/)[0].trim()); }
    if (/^\s*[\w$]+\s*(,|$)/.test(clause) && !clause.trim().startsWith("{")) names.push("default");
    if (/\*\s+as\s/.test(clause) || m[4]) names.push("*");
    out.push({ target, typeOnly, names });
  }
  return out;
}
const importers = new Map(files.map((f) => [f, []]));
for (const f of files) for (const imp of importsOf(f)) importers.get(imp.target)?.push({ from: f, ...imp });

const lines = text[CH].split("\n");
const hookLine = lines.findIndex((l) => l.includes("if (this.modelPlanner && this.modelPlannerFor")) + 1;
if (hookLine === 0) throw new Error("the hook line was not found in chatHandler.ts");
const usesIn = (name) => lines.map((l, i) => [i + 1, l]).filter(([i, l]) => i > 140 && new RegExp(`(?<![\\w$.])${name.replace(/\$/g, "\\$")}(?![\\w$])`).test(l)).map(([i]) => i);

// symbols chatHandler imports (values), per file
const chImports = importsOf(CH).filter((i) => !i.typeOnly);
const postOnlyByFile = new Map();
const preUsedByFile = new Map();
for (const imp of chImports) {
  for (const n of imp.names) {
    const uses = n === "default" || n === "*" ? [] : usesIn(n);
    if (uses.length === 0) continue;
    const bucket = uses.every((u) => u > hookLine) ? postOnlyByFile : preUsedByFile;
    if (!bucket.has(imp.target)) bucket.set(imp.target, new Set());
    bucket.get(imp.target).add(n);
  }
}

const isLiveRoot = (f) => f.startsWith("src/app/") || f === CH;
const dead = new Set();
for (let changed = true; changed; ) {
  changed = false;
  for (const f of files) {
    if (dead.has(f) || isLiveRoot(f)) continue;
    const imps = importers.get(f);
    if (imps.length === 0) continue; // nothing imports it: not «reached only by the post-hook region», it is simply unused already
    const onlyViaPost = imps.every((i) => (i.from === CH ? !i.typeOnly && !preUsedByFile.has(f) && postOnlyByFile.has(f) : dead.has(i.from) || i.typeOnly && i.from !== CH && dead.has(i.from)));
    const chHasOnlyTypes = imps.some((i) => i.from === CH) ? true : true;
    if (onlyViaPost && chHasOnlyTypes) { dead.add(f); changed = true; }
  }
}

const mentionedElsewhere = (name, file) => files.some((g) => g !== file && g !== CH && !dead.has(g) && new RegExp(`(?<![\\w$])${name.replace(/\$/g, "\\$")}(?![\\w$])`).test(text[g]));
const deadSymbols = [];
for (const [f, names] of postOnlyByFile) {
  if (dead.has(f)) continue;
  const ds = [...names].filter((n) => !mentionedElsewhere(n, f));
  const keep = [...names].filter((n) => !ds.includes(n));
  if (ds.length) deadSymbols.push({ file: f, dead: ds, shared: keep });
}

const md = [];
md.push("# What becomes dead once the model planner serves every account");
md.push("");
md.push("Generated by `node scripts/agent-loop/dead-code-when-planner-on.mjs` (textual import analysis, not a type-aware call graph). **Nothing is deleted in this PR.**");
md.push("");
md.push(`The hook is at \`${CH}:${hookLine}\`. Everything after it in \`handleUserMessageInner\` is the **post-hook region**: the hand-coded planning path (studies detector, coverage, discovery questions, social intent, deterministic plans, the old model call, plan validation, the plan card text).`);
md.push("");
md.push("## Read this first: what the hook does NOT take");
md.push("");
md.push("Today the model path is taken ONLY by the accounts of `MODEL_PLANNER_ALLOWED_EMAILS` (`src/lib/modelPlanner/constants.ts`); every other account, and every guest (a guest has no e-mail of its own), keeps the hand-coded path unchanged. So **nothing below is dead yet**: it becomes dead only when the allowlist is widened to every account and guests. Even then the hook skips test-scenario, file-shaping, greeting and general-question turns, which still run the post-hook region. The lists are the code that has **no other caller** than the post-hook region of the chat handler.");md.push("");
md.push(`## Files with no caller left (${dead.size})`);
md.push("");
md.push("Every non-test importer is the chat handler's post-hook region or another file in this list.");
md.push("");
for (const f of [...dead].sort()) md.push(`- \`${f}\``);
md.push("");
md.push(`## Functions and constants with no caller left, in files that stay (${deadSymbols.reduce((n, d) => n + d.dead.length, 0)})`);
md.push("");
md.push("Imported by the chat handler and used only after the hook, and mentioned by no other non-test source file outside the files above.");
md.push("");
for (const d of deadSymbols.sort((a, b) => a.file.localeCompare(b.file))) md.push(`- \`${d.file}\`: ${d.dead.map((n) => `\`${n}\``).join(", ")}`);
md.push("");
const sharedRows = [...postOnlyByFile].filter(([f]) => !dead.has(f)).map(([f, names]) => ({ f, shared: [...names].filter((n) => mentionedElsewhere(n, f)) })).filter((r) => r.shared.length);
md.push("## Used after the hook only by the chat handler, but also by other code (stay live)");
md.push("");
for (const r of sharedRows.sort((a, b) => a.f.localeCompare(b.f))) md.push(`- \`${r.f}\`: ${r.shared.map((n) => `\`${n}\``).join(", ")}`);
md.push("");
md.push("## Not covered by this analysis");
md.push("");
md.push("- Private methods and local helpers of `chatHandler.ts` itself that only the post-hook region calls (the analysis follows imports, not calls inside one file).");
md.push("- Symbols reached only through a barrel file, a dynamic key or a string.");
md.push("- Tests of the code above (they keep passing: nothing is removed).");
md.push("");
const body = md.join("\n");
if (process.argv.includes("--check")) {
  const same = existsSync(OUT) && readFileSync(OUT, "utf-8") === body;
  if (!same) { console.error("DEAD_CODE_WHEN_PLANNER_SERVES_ALL.md is out of date: run node scripts/agent-loop/dead-code-when-planner-on.mjs"); process.exit(1); }
  console.log("up to date");
} else {
  writeFileSync(OUT, body);
  console.log(JSON.stringify({ hookLine, deadFiles: dead.size, deadSymbols: deadSymbols.reduce((n, d) => n + d.dead.length, 0) }));
}
