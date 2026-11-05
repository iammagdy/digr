import { ADDON_APPROVE_MESSAGES_AR, ADDON_MAX_HOLD_POINTS, addonSettings, reviewHoldPoints, type AddonKind, type AddonPricing } from "../addonSettlement";
import { measuredCostPerRowUsd, priceMissionByCode, type MeasuredCall } from "../price";
import type { MissionPricingSettings } from "../../missionPricing";
import type { EditIntent } from "./addonRow";
import { holdLineAr, quoteLineAr } from "./quotes";

/**
 * MONEY PR 7a, PHASE 2A: THE CARD OF AN ADD-ON, PRICED BY CODE BEFORE ANY APPROVAL AND WITHOUT ANY PROVIDER CALL (docs/MONEY-PR-7A.md section 2). The old plan (STAGE-4 S4 step 2) knew the real cost of an edit only by
 * running the re-read first, which spends provider money before the customer approves. Here the quote is made from what is ALREADY recorded:
 *   a. the delivered mission's own recorded calls for the same tool (cost and rows: `measuredCostPerRowUsd`), else
 *   b. the catalog's price of the tool for one row, else
 *   c. NO QUOTE (a sentence; nothing held, nothing charged). The gateway's flat guess for unknown prices is never used for money.
 * The chain of tools of a column is an UPPER BOUND (every tool assumed tried for every row). The reading of those rows (mission_calls, the catalog) is the wiring phase's job: this file takes plain numbers.
 * The edit is priced as a ONE-STAGE plan through the existing `priceMissionByCode` (the function normal missions use) with the add-on minimum of 100 points; nothing else computes a price here.
 * Display only: it never reserves, charges or releases (the money file addonSettlement.ts does, and does not import this file).
 */

/** One tool of a column's lookup chain: what its recorded calls show, and the catalog's price of one row. */
export interface ChainTool { measuredCalls?: ReadonlyArray<MeasuredCall>; catalogPerRowUsd?: number | null }

/** Cost per row of a chain, USD: the sum over the tools of each tool's measured cost per row, else its catalog price; null when ANY tool has neither (no quote). An empty chain (no re-read: a rename, cells the customer typed) costs 0. */
export function chainCostPerRowUsd(tools: ReadonlyArray<ChainTool>): number | null {
  let total = 0;
  for (const t of tools) {
    const measured = t.measuredCalls ? measuredCostPerRowUsd(t.measuredCalls) : null;
    const catalog = t.catalogPerRowUsd;
    const cost = measured !== null ? measured : typeof catalog === "number" && Number.isFinite(catalog) && catalog >= 0 ? catalog : null;
    if (cost === null) return null;
    total += cost;
  }
  return total;
}

/** How many units the customer asks to be filled (the cells or rows of a re-read, 1 for a rename). 0 = nothing to do. */
export function unitsOfIntent(edit: EditIntent): number {
  switch (edit.kind) {
    case "add_column": return new Set(edit.rowIds).size;
    case "rename_column": return 1;
    case "set_cells": return new Set(edit.cells.map((c) => `${c.rowId}|${c.column}`)).size;
    case "add_rows": return Number.isInteger(edit.count) && edit.count > 0 ? edit.count : 0;
    default: return 0;
  }
}

export const ADDON_QUOTE_AR = {
  no_quote: "تعذّر تسعير هذا التعديل الآن؛ لم يُحجز ولم يُخصم شيء.",
  nothing_to_do: "لم نجد ما نعدّله في هذا الطلب.",
  too_large: ADDON_APPROVE_MESSAGES_AR.too_large,
  row_removal_not_offered: "حذف عناصر من الملف غير متاح. يبقى ملفك كاملًا، ويمكنك طلب عمود أو تصحيح خانة.",
  unknown_edit: "هذا النوع من التعديل غير متاح.",
} as const;
export type AddonQuoteRefusal = keyof typeof ADDON_QUOTE_AR;

export type AddonCard =
  | { ok: true; kind: AddonKind; pricing: AddonPricing; estimatePoints: number; holdPoints: number; lineAr: string }
  | { ok: false; reason: AddonQuoteRefusal; messageAr: string };
const refuse = (reason: AddonQuoteRefusal): AddonCard => ({ ok: false, reason, messageAr: ADDON_QUOTE_AR[reason] });

/** The card of a paid review: exact price, 1 point per 100 cells (at least 100), held as is. */
export function reviewCard(cells: number): AddonCard {
  if (!Number.isInteger(cells) || cells < 0) return refuse("nothing_to_do");
  const hold = reviewHoldPoints(cells);
  if (hold > ADDON_MAX_HOLD_POINTS) return refuse("too_large");
  return { ok: true, kind: "review", pricing: { requested: 1, cells, settings: addonSettings(), estimatePoints: hold, holdPoints: hold }, estimatePoints: hold, holdPoints: hold, lineAr: quoteLineAr("review", hold) };
}

/**
 * The card of an edit or a review fix: `units` to fill and the chain of tools they are read through (`null` = the chain is not known: no quote; `[]` = no re-read, a cost of 0).
 * The hold is the one pricing rule's reserve (estimate + 15% buffer, at least 100); the line says the estimate and that it will not pass the hold.
 */
export function editCard(input: { kind: "edit" | "review_fix"; units: number; tools: ReadonlyArray<ChainTool> | null; settings?: MissionPricingSettings }): AddonCard {
  if (!Number.isInteger(input.units) || input.units < 1) return refuse("nothing_to_do");
  if (input.tools === null) return refuse("no_quote");
  const costPerRowUsd = chainCostPerRowUsd(input.tools);
  if (costPerRowUsd === null) return refuse("no_quote");
  const settings = addonSettings(input.settings);
  const price = priceMissionByCode([{ rows: input.units, costPerRowUsd, deliver: true, codeOnly: true }], { settings });
  if (price.overCap || price.reservePoints > ADDON_MAX_HOLD_POINTS) return refuse("too_large");
  const pricing: AddonPricing = { requested: input.units, costPerRowUsd, settings, estimatePoints: price.maxChargePoints, holdPoints: price.reservePoints };
  return { ok: true, kind: input.kind, pricing, estimatePoints: price.maxChargePoints, holdPoints: price.reservePoints, lineAr: holdLineAr(price.maxChargePoints, price.reservePoints) };
}

/** The refusal of an edit by what it is, before any price: removing rows is never offered; an unknown kind is not an edit. */
export function intentRefusal(edit: { kind?: unknown }): AddonQuoteRefusal | null {
  if (edit.kind === "remove_rows" || edit.kind === "delete_rows") return "row_removal_not_offered";
  if (edit.kind !== "add_column" && edit.kind !== "rename_column" && edit.kind !== "set_cells" && edit.kind !== "add_rows") return "unknown_edit";
  return null;
}
