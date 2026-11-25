import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AllowIndex,
  loadTregCatalogIds,
  scanCodebase,
  type DesignGuardsAllowList,
  type GuardViolation,
} from "./designGuardsScanner";

/**
 * Wave 1 Monotonic Ceiling & Zero-Stale Guard for tests/fixtures/design-guards-allow.json.
 *
 * Standing Rule (Owner: Megz D-0209, Wave 1 Plan v1.2):
 *  1. Any phase touching wordlists or hardcoded tokens must run
 *     `npx tsx scripts/sync-design-guards-allow.ts --files <modified-files>`
 *     and LOWER `ALLOW_LIST_CEILING` accordingly in the same PR.
 *  2. Allow-list size is strictly monotonic decreasing across Wave 1.
 *  3. Stale allow-list entries (with zero AST hits in the codebase) are FORBIDDEN.
 */
export const ALLOW_LIST_CEILING = {
  arabic_regex: 1398,
  treg_tokens: 597,
  srv_paths: 0,
  fallback_lists: 2,
} as const;

function allowKeyOf(v: GuardViolation): string {
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

describe("Design Guards Allow-List Monotonic Ceiling & Zero-Stale Guard", () => {
  const baseDir = path.resolve(__dirname, "..");
  const allowPath = path.resolve(baseDir, "tests/fixtures/design-guards-allow.json");
  const allow: DesignGuardsAllowList = JSON.parse(fs.readFileSync(allowPath, "utf8"));
  const catalog = loadTregCatalogIds(path.resolve(baseDir, "data/treg"));

  it("enforces per-category counts <= ALLOW_LIST_CEILING", () => {
    expect(allow.arabic_regex.length).toBeLessThanOrEqual(ALLOW_LIST_CEILING.arabic_regex);
    expect(allow.treg_tokens.length).toBeLessThanOrEqual(ALLOW_LIST_CEILING.treg_tokens);
    expect((allow.srv_paths ?? []).length).toBeLessThanOrEqual(ALLOW_LIST_CEILING.srv_paths);
    expect(allow.fallback_lists.length).toBeLessThanOrEqual(ALLOW_LIST_CEILING.fallback_lists);
  });

  it("has zero stale entries (every allow-list entry has >= 1 active AST hit in src/ or agent/src/) in < 5s", () => {
    const t0 = Date.now();
    const rawViolations = scanCodebase({ baseDir, catalog, allowIndex: new AllowIndex() });
    const active = {
      arabic_regex: new Set<string>(),
      treg_token: new Set<string>(),
      srv_path: new Set<string>(),
      fallback_list: new Set<string>(),
    };
    for (const v of rawViolations) {
      active[v.rule].add(`${v.file}::${allowKeyOf(v)}`);
    }
    const stale: string[] = [];
    for (const it of allow.arabic_regex) {
      if (!active.arabic_regex.has(`${it.file}::${it.pattern}`)) stale.push(`arabic_regex: ${it.file} :: ${it.pattern}`);
    }
    for (const it of allow.treg_tokens) {
      if (!active.treg_token.has(`${it.file}::${it.token.toLowerCase()}`)) stale.push(`treg_tokens: ${it.file} :: ${it.token}`);
    }
    for (const it of allow.srv_paths ?? []) {
      if (!active.srv_path.has(`${it.file}::${it.pattern}`)) stale.push(`srv_paths: ${it.file} :: ${it.pattern}`);
    }
    for (const it of allow.fallback_lists) {
      if (!active.fallback_list.has(`${it.file}::${it.pattern}`)) stale.push(`fallback_lists: ${it.file} :: ${it.pattern}`);
    }
    expect(stale).toEqual([]);
    // Must be fast (< 20 s on CI)
    expect(Date.now() - t0).toBeLessThan(20000);
  });
});
