#!/usr/bin/env tsx
import fs from "node:fs";
import path from "node:path";
import {
  AllowIndex,
  loadTregCatalogIds,
  scanCodebase,
  scanSourceCode,
  type DesignGuardsAllowList,
  type GuardViolation,
} from "../tests/designGuardsScanner";

export function allowKeyOfViolation(v: GuardViolation): string {
  switch (v.rule) {
    case "arabic_regex":
      return v.detail.replace(/^Arabic (?:regex literal|RegExp call): /, "");
    case "treg_token": {
      const m = v.detail.match(/^Hardcoded (?:endpoint|provider) ID: "(.*)"$/);
      return (m ? m[1] : v.detail).toLowerCase();
    }
    case "srv_path": {
      const m = v.detail.match(/^String literal containing «\/srv\/»: "(.*)"$/);
      return m ? m[1] : v.detail;
    }
    case "fallback_list": {
      const m = v.detail.match(/\[(.*)\]$/);
      return m ? m[1] : v.detail;
    }
  }
}

function normalizeRelPath(p: string, baseDir: string): string {
  const abs = path.isAbsolute(p) ? p : path.resolve(baseDir, p);
  return path.relative(baseDir, abs).replace(/\\/g, "/");
}

export function main(): void {
  const baseDir = process.cwd();
  const allowPath = path.resolve(baseDir, "tests/fixtures/design-guards-allow.json");
  const allow: DesignGuardsAllowList = JSON.parse(fs.readFileSync(allowPath, "utf8"));
  const catalog = loadTregCatalogIds(path.resolve(baseDir, "data/treg"));
  const args = process.argv.slice(2);

  if (args.includes("--check")) {
    const unallowed = scanCodebase({ baseDir, catalog, allowIndex: new AllowIndex(allow) });
    const allRaw = scanCodebase({ baseDir, catalog, allowIndex: new AllowIndex() });
    const active = {
      arabic_regex: new Set<string>(),
      treg_token: new Set<string>(),
      srv_path: new Set<string>(),
      fallback_list: new Set<string>(),
    };
    for (const v of allRaw) {
      active[v.rule].add(`${v.file}::${allowKeyOfViolation(v)}`);
    }
    const stale: string[] = [];
    for (const it of allow.arabic_regex ?? []) {
      if (!active.arabic_regex.has(`${it.file}::${it.pattern}`)) stale.push(`[arabic_regex] ${it.file} :: ${it.pattern}`);
    }
    for (const it of allow.treg_tokens ?? []) {
      if (!active.treg_token.has(`${it.file}::${it.token.toLowerCase()}`)) stale.push(`[treg_tokens] ${it.file} :: ${it.token}`);
    }
    for (const it of allow.srv_paths ?? []) {
      if (!active.srv_path.has(`${it.file}::${it.pattern}`)) stale.push(`[srv_paths] ${it.file} :: ${it.pattern}`);
    }
    for (const it of allow.fallback_lists ?? []) {
      if (!active.fallback_list.has(`${it.file}::${it.pattern}`)) stale.push(`[fallback_lists] ${it.file} :: ${it.pattern}`);
    }
    if (unallowed.length > 0 || stale.length > 0) {
      if (unallowed.length > 0) {
        console.error(`Unallowed design-guard violations (${unallowed.length}):\n` + unallowed.map((v) => `  ${v.formatted}`).join("\n"));
      }
      if (stale.length > 0) {
        console.error(`Stale design-guard allow-list entries with 0 hits (${stale.length}):\n` + stale.map((s) => `  ${s}`).join("\n"));
      }
      process.exit(1);
    }
    console.log(
      `OK: 0 unallowed hits, 0 stale entries (arabic_regex=${allow.arabic_regex.length}, treg_tokens=${allow.treg_tokens.length}, srv_paths=${(allow.srv_paths ?? []).length}, fallback_lists=${allow.fallback_lists.length})`
    );
    return;
  }

  const filesIdx = args.indexOf("--files");
  if (filesIdx !== -1) {
    const targetFiles = new Set(
      args
        .slice(filesIdx + 1)
        .filter((a) => !a.startsWith("--"))
        .map((f) => normalizeRelPath(f, baseDir))
    );
    if (targetFiles.size === 0) {
      console.error("Usage: npx tsx scripts/sync-design-guards-allow.ts --files <file1> [file2 ...]");
      process.exit(1);
    }
    const activeForTargets = {
      arabic_regex: new Set<string>(),
      treg_token: new Set<string>(),
      srv_path: new Set<string>(),
      fallback_list: new Set<string>(),
    };
    for (const relFile of targetFiles) {
      const full = path.resolve(baseDir, relFile);
      if (!fs.existsSync(full)) continue; // deleted file -> 0 active keys -> all its entries are removed
      const code = fs.readFileSync(full, "utf8");
      const hits = scanSourceCode(relFile, code, catalog, new AllowIndex());
      for (const v of hits) {
        activeForTargets[v.rule].add(`${v.file}::${allowKeyOfViolation(v)}`);
      }
    }
    const next: DesignGuardsAllowList = {
      arabic_regex: (allow.arabic_regex ?? []).filter((it) => !targetFiles.has(it.file) || activeForTargets.arabic_regex.has(`${it.file}::${it.pattern}`)),
      treg_tokens: (allow.treg_tokens ?? []).filter((it) => !targetFiles.has(it.file) || activeForTargets.treg_token.has(`${it.file}::${it.token.toLowerCase()}`)),
      srv_paths: (allow.srv_paths ?? []).filter((it) => !targetFiles.has(it.file) || activeForTargets.srv_path.has(`${it.file}::${it.pattern}`)),
      fallback_lists: (allow.fallback_lists ?? []).filter((it) => !targetFiles.has(it.file) || activeForTargets.fallback_list.has(`${it.file}::${it.pattern}`)),
    };
    fs.writeFileSync(allowPath, JSON.stringify(next, null, 2) + "\n", "utf8");
    console.log(
      `Synced ${targetFiles.size} file(s): arabic_regex ${allow.arabic_regex.length}->${next.arabic_regex.length}, treg_tokens ${allow.treg_tokens.length}->${next.treg_tokens.length}, srv_paths ${(allow.srv_paths ?? []).length}->${next.srv_paths.length}, fallback_lists ${allow.fallback_lists.length}->${next.fallback_lists.length}`
    );
    return;
  }

  if (args.includes("--prune-all-stale")) {
    const allRaw = scanCodebase({ baseDir, catalog, allowIndex: new AllowIndex() });
    const active = {
      arabic_regex: new Set<string>(),
      treg_token: new Set<string>(),
      srv_path: new Set<string>(),
      fallback_list: new Set<string>(),
    };
    for (const v of allRaw) {
      active[v.rule].add(`${v.file}::${allowKeyOfViolation(v)}`);
    }
    const next: DesignGuardsAllowList = {
      arabic_regex: (allow.arabic_regex ?? []).filter((it) => active.arabic_regex.has(`${it.file}::${it.pattern}`)),
      treg_tokens: (allow.treg_tokens ?? []).filter((it) => active.treg_token.has(`${it.file}::${it.token.toLowerCase()}`)),
      srv_paths: (allow.srv_paths ?? []).filter((it) => active.srv_path.has(`${it.file}::${it.pattern}`)),
      fallback_lists: (allow.fallback_lists ?? []).filter((it) => active.fallback_list.has(`${it.file}::${it.pattern}`)),
    };
    fs.writeFileSync(allowPath, JSON.stringify(next, null, 2) + "\n", "utf8");
    console.log(
      `Pruned stale entries: arabic_regex ${allow.arabic_regex.length}->${next.arabic_regex.length}, treg_tokens ${allow.treg_tokens.length}->${next.treg_tokens.length}, srv_paths ${(allow.srv_paths ?? []).length}->${next.srv_paths.length}, fallback_lists ${allow.fallback_lists.length}->${next.fallback_lists.length}`
    );
    return;
  }

  console.error("Usage: sync-design-guards-allow.ts [--check | --prune-all-stale | --files <files...>]");
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("sync-design-guards-allow.ts")) {
  main();
}
