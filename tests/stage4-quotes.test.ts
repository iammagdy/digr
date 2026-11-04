import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { pointsPerCostUsd } from "../src/lib/missionPricing";
import { EDIT_MIN_POINTS, REVIEW_MIN_POINTS, editQuote, quoteLineAr, reviewQuote } from "../src/lib/agentMission/stage4/quotes";
import { checkCustomerText } from "../src/lib/agentMission/text";

/**
 * STAGE 4 (docs/STAGE-4.md), THE PRICES SHOWN BY CODE (display only, never a charge): the review is 1 point per 100 cells, at least 100; an edit after delivery is the real cost times the
 * markup, at least 100 (our own mistake is not free). These functions are not reachable from any money path (an import-graph check over the sources).
 */
describe("the review's price", () => {
  it("1 point per 100 cells, rounded up, never below 100", () => {
    expect(REVIEW_MIN_POINTS).toBe(100);
    expect([0, 1, 100, 9_999, 10_000, 10_001, 25_000, 1_000_000].map(reviewQuote)).toEqual([100, 100, 100, 100, 100, 101, 250, 10_000]);
  });
  it("a count that is not a whole number of cells is refused", () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => reviewQuote(bad)).toThrow();
  });
});

describe("the edit's price", () => {
  it("the real cost (USD) times the markup in points, rounded up, never below 100; with the default settings 1 USD is 5,500 points", () => {
    expect(EDIT_MIN_POINTS).toBe(100);
    expect(pointsPerCostUsd()).toBe(5500);
    expect(editQuote(0)).toBe(100);
    expect(editQuote(0.01)).toBe(100);
    expect(editQuote(0.02)).toBe(110);
    expect(editQuote(1)).toBe(5500);
    expect(editQuote(1, { markup: 20, minChargePoints: 200 })).toBe(11_000);
  });
  it("there is no free path: the function takes no reason, so an edit that fixes our own mistake is priced the same", () => {
    expect(editQuote.length).toBeLessThanOrEqual(2);
    expect(editQuote(0)).toBeGreaterThanOrEqual(100);
  });
  it("a cost that is not a real number is refused", () => {
    for (const bad of [-0.01, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => editQuote(bad)).toThrow();
  });
  it("the line shown says it is a price computed by code and that nothing was charged", () => {
    const line = quoteLineAr("review", 250);
    expect(line).toBe("سعر المراجعة: ٢٥٠ نقطة، محسوب بالكود. لم يُخصم شيء.");
    expect(checkCustomerText(line).issues).toEqual([]);
    expect(checkCustomerText(quoteLineAr("edit", 5500)).issues).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------ the import graph
const ROOT = path.resolve(__dirname, "..");
function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}
const SOURCES = [...files(path.join(ROOT, "src")), ...files(path.join(ROOT, "agent", "src")), ...files(path.join(ROOT, "supabase"))];
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
const MONEY = /(?:^|\/)(?:gateway|price|jobPointsCap|finalize|missionPricing|recordPricing|approval|lifecycle|runMission)\.tsx?$|ledger|billing|charge|settle|reserve|topup|wallet|payment|invoice|credit|(?:^|\/)functions\/|(?:^|\/)supabase\//i;

describe("the quotes are display only: no money path can reach them", () => {
  const quotes = path.join(ROOT, "src/lib/agentMission/stage4/quotes.ts");
  it("the money files of the repo exist (the check is not empty)", () => {
    const money = SOURCES.map((f) => path.relative(ROOT, f)).filter((f) => MONEY.test(f));
    expect(money).toContain("agent/src/gateway.ts");
    expect(money).toContain("agent/src/finalize.ts");
    expect(money).toContain("src/lib/agentMission/price.ts");
    // the lifecycle (approve and settle) and the add-on money file are under the same rule: neither may reach quotes.ts
    expect(money).toContain("src/lib/agentMission/lifecycle.ts");
    expect(money).toContain("src/lib/agentMission/addonSettlement.ts");
    expect(money.length).toBeGreaterThan(20);
  });
  it("no money file imports quotes.ts, directly or through any chain of imports; only stage4 files may import it", () => {
    const r = [...reachers(quotes)].map((f) => path.relative(ROOT, f));
    expect(r.filter((f) => MONEY.test(f))).toEqual([]);
    // MONEY PR 7c and 7d: the production page-side readers are the READ-ONLY review-price preview route and the review REQUEST route (an unpaid `plan_ready` row, nothing held) (it shows the card's price; it holds and charges nothing: tests/money7a-isolation.test.ts and tests/stage4-review-quote.test.ts)
    expect(r.filter((f) => !f.startsWith("src/lib/agentMission/stage4/") && f !== "src/app/api/missions/[id]/review-quote/route.ts" && f !== "src/app/api/missions/[id]/review-request/route.ts")).toEqual([]);
  });
  it("quotes.ts itself imports no ledger, billing, charge or settlement code (only the read-only points rate)", () => {
    const deps = (importsOf.get(quotes) ?? []).map((f) => path.relative(ROOT, f));
    expect(deps.filter((f) => /ledger|billing|charge|settle|reserve|gateway|finalize/i.test(f))).toEqual([]);
  });
});
