import { dedupeIdentityFor, type DedupeKind } from "./rowDedupe";
import { excludeKeysFromRows, remainingUnits, approximateTotalPoints, type SampleRestOffer } from "../sampleFirst";

/** How a capability's rows are identified when a later job must not deliver them again. */
export function dedupeKindForCapability(slug: string | undefined): DedupeKind {
  const value = String(slug || "").toLowerCase();
  if (value.includes("people")) return "person";
  if (value.includes("compan")) return "company";
  return "social";
}

/** Most identities a remainder plan carries: a sample is small, and the plan JSON stays small. */
export const MAX_EXCLUDED_ROW_KEYS = 500;

export interface RemainderInput {
  items: Array<{ capabilitySlug: string; params?: Record<string, any>; targetVolumeMin?: number; targetVolumeMax?: number; [key: string]: any }>;
  /** The volume of the whole request (before the sample). */
  fullVolume: number;
  sampleRows: Array<Record<string, any>>;
  sampleDelivered: number;
  sampleChargedPoints: number;
}

export interface RemainderPlan {
  remaining: number;
  items: RemainderInput["items"];
  rest: SampleRestOffer;
}

/**
 * The plan for the rest of a request after a sample: the SAME plan on the remaining volume, carrying the identities of
 * the rows the sample delivered (the worker drops them: they are neither delivered nor billed a second time). The quote
 * is built from this plan by the ordinary quote writer; nothing here prices or reserves anything.
 */
export function buildRemainderPlan(input: RemainderInput, unitPricePoints: number): RemainderPlan | null {
  const first = input.items[0];
  if (!first || input.items.length !== 1) return null;
  const remaining = remainingUnits(input.fullVolume, input.sampleDelivered);
  const keys = excludeKeysFromRows(input.sampleRows, dedupeIdentityFor(dedupeKindForCapability(first.capabilitySlug)), MAX_EXCLUDED_ROW_KEYS);
  const rest: SampleRestOffer = {
    deliveredInSample: input.sampleDelivered,
    sampleChargedPoints: input.sampleChargedPoints,
    remainingUnits: remaining,
    approximateTotalPoints: approximateTotalPoints({ sampleChargedPoints: input.sampleChargedPoints, remainingUnits: remaining, unitPricePoints }),
  };
  if (remaining <= 0) return { remaining: 0, items: [], rest };
  return {
    remaining,
    items: [{
      ...first,
      targetVolumeMin: 1,
      targetVolumeMax: remaining,
      params: { ...(first.params || {}), ...(keys.length ? { excludeRowKeys: keys } : {}) },
    }],
    rest,
  };
}
