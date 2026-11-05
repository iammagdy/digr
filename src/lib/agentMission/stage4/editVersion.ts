import { applyEditCore, EDIT_NOT_SEARCHED_AR, EDIT_REJECTIONS, EDIT_REJECTION_AR, type EditCoreResult, type EditRejection, type EditRequest } from "./editCore";
import { editQuote } from "./quotes";
import type { FileVersion, VersionDiff } from "./versions";

/**
 * STAGE 4, AN EDIT AFTER DELIVERY IS A NEW VERSION OF THE SAME FILE (docs/STAGE-4.md, FOUNDATION-PLAN PR 6). The rules are in editCore.ts (no price there); this file adds the price SHOWN by code (quotes.ts `editQuote`: the real cost
 * times the markup, at least 100; our own mistake is not free). It never charges: the charge is the money side's (addonSettlement.ts). Pure.
 */
export { EDIT_NOT_SEARCHED_AR, EDIT_REJECTIONS, EDIT_REJECTION_AR };
export type { EditRejection, EditRequest };

export type EditResult =
  | { ok: true; version: FileVersion; diff: VersionDiff; reread: { sheet: string; columns: string[]; rows: number }; /** The price SHOWN by code (null when the real cost is not known yet). Never charged here. */ quotePoints: number | null }
  | { ok: false; reason: EditRejection };

/** `meta.reason`: «edit» (default) or «review_fix» (an edit that corrects the cells of one review issue: same rules, its own reason on the version). */
export function applyEditRequest(prev: FileVersion, req: EditRequest, meta: { createdAt: string; realCostUsd?: number; reason?: "edit" | "review_fix" }): EditResult {
  const out: EditCoreResult = applyEditCore(prev, req, { createdAt: meta.createdAt, ...(meta.reason ? { reason: meta.reason } : {}) });
  return out.ok ? { ...out, quotePoints: typeof meta.realCostUsd === "number" ? editQuote(meta.realCostUsd) : null } : out;
}
