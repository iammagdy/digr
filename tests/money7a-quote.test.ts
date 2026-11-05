import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkAddon, addonId, ADDON_MAX_HOLD_POINTS } from "../src/lib/agentMission/addonSettlement";
import { priceMissionByCode } from "../src/lib/agentMission/price";
import { ADDON_QUOTE_AR, chainCostPerRowUsd, editCard, intentRefusal, reviewCard, unitsOfIntent } from "../src/lib/agentMission/stage4/addonQuote";
import { holdLineAr, quoteLineAr, reviewQuote } from "../src/lib/agentMission/stage4/quotes";
import { SETTINGS } from "./helpers/addonWorld";

/**
 * MONEY PR 7a, PHASE 2A: THE CARD IS PRICED BY CODE, WITH NO PROVIDER CALL (docs/MONEY-PR-7A.md section 2): from the delivered mission's recorded calls, else the catalog, else no quote; through the existing
 * `priceMissionByCode` on a one-stage plan with the add-on minimum of 100 points. `fetch` is stubbed to throw.
 */
const fetchSpy = vi.fn(() => { throw new Error("a real call was attempted"); });
beforeEach(() => { vi.stubGlobal("fetch", fetchSpy); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("the cost per row of a chain of tools", () => {
  it("a tool's recorded calls win over its catalog price; the chain is the SUM (an upper bound: every tool tried for every row)", () => {
    expect(chainCostPerRowUsd([{ measuredCalls: [{ costUsd: 0.02, rows: 10 }, { costUsd: 0.01, rows: 10 }], catalogPerRowUsd: 0.5 }])).toBeCloseTo(0.0015, 8);
    expect(chainCostPerRowUsd([{ catalogPerRowUsd: 0.001 }, { measuredCalls: [{ costUsd: 0.04, rows: 20 }] }])).toBeCloseTo(0.003, 8);
  });
  it("a tool with neither recorded rows nor a catalog price means NO QUOTE for the whole chain (never the gateway's flat guess)", () => {
    expect(chainCostPerRowUsd([{ catalogPerRowUsd: 0.001 }, {}])).toBeNull();
    expect(chainCostPerRowUsd([{ measuredCalls: [{ costUsd: 0.5, rows: 0 }] }])).toBeNull();
    expect(chainCostPerRowUsd([{ catalogPerRowUsd: null }])).toBeNull();
    expect(chainCostPerRowUsd([{ catalogPerRowUsd: Number.NaN }])).toBeNull();
    expect(chainCostPerRowUsd([{ catalogPerRowUsd: -1 }])).toBeNull();
  });
  it("no tool at all (a rename, cells the customer typed) costs nothing in provider calls", () => { expect(chainCostPerRowUsd([])).toBe(0); });
});

describe("the edit card", () => {
  it("is priced through priceMissionByCode on a one-stage plan: the hold is its reserve, the estimate its full charge, the add-on minimum is 100", () => {
    const tools = [{ measuredCalls: [{ costUsd: 0.05, rows: 100 }] }];
    const card = editCard({ kind: "edit", units: 40, tools });
    if (!card.ok) throw new Error("no card");
    const price = priceMissionByCode([{ rows: 40, costPerRowUsd: 0.0005, deliver: true, codeOnly: true }], { settings: SETTINGS });
    expect(card.holdPoints).toBe(price.reservePoints);
    expect(card.estimatePoints).toBe(price.maxChargePoints);
    expect(card.holdPoints).toBeGreaterThanOrEqual(card.estimatePoints);
    expect(card.pricing).toMatchObject({ requested: 40, holdPoints: price.reservePoints, estimatePoints: price.maxChargePoints, settings: { markup: 10, minChargePoints: 100 } });
    expect(checkAddon(addonId("msn_a", 1, 1), { v: 1, kind: "edit", of: "msn_a", baseVersion: 1, newVersion: 2, attempt: 1, request: {}, pricing: card.pricing })).toMatchObject({ ok: true, holdPoints: card.holdPoints });
    expect(card.lineAr).toBe(holdLineAr(card.estimatePoints, card.holdPoints));
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("no re-read (an empty chain): the hold is the 100-point minimum", () => {
    const card = editCard({ kind: "edit", units: 1, tools: [] });
    expect(card).toMatchObject({ ok: true, holdPoints: 100, estimatePoints: 100 });
  });
  it("a review fix is priced the same way, and carries its own kind", () => {
    const a = editCard({ kind: "edit", units: 30, tools: [{ catalogPerRowUsd: 0.0004 }] });
    const b = editCard({ kind: "review_fix", units: 30, tools: [{ catalogPerRowUsd: 0.0004 }] });
    expect(a.ok && b.ok && b.holdPoints === a.holdPoints && b.kind === "review_fix").toBe(true);
  });
  it("no quote: an unknown chain, an unknown price, nothing to do; and a hold over 5,000 points is refused with its sentence", () => {
    expect(editCard({ kind: "edit", units: 5, tools: null })).toMatchObject({ ok: false, reason: "no_quote", messageAr: ADDON_QUOTE_AR.no_quote });
    expect(editCard({ kind: "edit", units: 5, tools: [{}] })).toMatchObject({ ok: false, reason: "no_quote" });
    expect(editCard({ kind: "edit", units: 0, tools: [] })).toMatchObject({ ok: false, reason: "nothing_to_do" });
    expect(editCard({ kind: "edit", units: 1.5, tools: [] })).toMatchObject({ ok: false, reason: "nothing_to_do" });
    expect(editCard({ kind: "edit", units: 10_000, tools: [{ catalogPerRowUsd: 0.0001 }] })).toMatchObject({ ok: false, reason: "too_large", messageAr: ADDON_QUOTE_AR.too_large });
    expect(ADDON_MAX_HOLD_POINTS).toBe(5000);
  });
  it("the owner's markup is used, with the add-on minimum of 100 instead of the mission's 200", () => {
    const m5 = editCard({ kind: "edit", units: 400, tools: [{ catalogPerRowUsd: 0.001 }], settings: { markup: 5, minChargePoints: 200 } });
    const m10 = editCard({ kind: "edit", units: 400, tools: [{ catalogPerRowUsd: 0.001 }] });
    if (!m5.ok || !m10.ok) throw new Error("no card");
    expect(m5.holdPoints).toBeLessThan(m10.holdPoints);
    expect(m5.pricing.settings).toEqual({ markup: 5, minChargePoints: 100 });
  });
});

describe("the review card", () => {
  it("exact price, held as is: 1 point per 100 cells, at least 100; the line is the existing one", () => {
    for (const cells of [0, 50, 10_000, 12_345, 500_000]) {
      const card = reviewCard(cells);
      expect(card).toMatchObject({ ok: true, kind: "review", holdPoints: reviewQuote(cells), estimatePoints: reviewQuote(cells), lineAr: quoteLineAr("review", reviewQuote(cells)) });
    }
  });
  it("a review above 5,000 points is refused; a bad cell count is nothing to do", () => {
    expect(reviewCard(500_001)).toMatchObject({ ok: false, reason: "too_large" });
    expect(reviewCard(-1)).toMatchObject({ ok: false, reason: "nothing_to_do" });
  });
});

describe("what the customer asked, as units", () => {
  it("counts the rows of a new column, the distinct cells of a correction, the rows to add, and one for a rename; removing rows is never offered", () => {
    expect(unitsOfIntent({ kind: "add_column", sheet: "a", titleAr: "ب", rowIds: ["r1", "r2", "r2"] })).toBe(2);
    expect(unitsOfIntent({ kind: "set_cells", sheet: "a", cells: [{ rowId: "r1", column: "x" }, { rowId: "r1", column: "x" }, { rowId: "r2", column: "x" }] })).toBe(2);
    expect(unitsOfIntent({ kind: "add_rows", sheet: "a", count: 3 })).toBe(3);
    expect(unitsOfIntent({ kind: "add_rows", sheet: "a", count: 0 })).toBe(0);
    expect(unitsOfIntent({ kind: "rename_column", sheet: "a", from: "x", to: "y" })).toBe(1);
    expect(intentRefusal({ kind: "remove_rows" })).toBe("row_removal_not_offered");
    expect(intentRefusal({ kind: "delete_rows" })).toBe("row_removal_not_offered");
    expect(intentRefusal({ kind: "teleport" })).toBe("unknown_edit");
    expect(intentRefusal({ kind: "set_cells" })).toBeNull();
  });
});

describe("the card file prices only through priceMissionByCode and calls no provider", () => {
  const src = readFileSync(new URL("../src/lib/agentMission/stage4/addonQuote.ts", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  it("one pricing call, no fetch, no environment, no flag", () => {
    expect([...src.matchAll(/priceMissionByCode\(/g)]).toHaveLength(1);
    expect(src).not.toMatch(/\bfetch\s*\(|process\.env|DIGER_STAGE4|\.rpc\(|from\("/);
  });
});
