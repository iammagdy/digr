import { MISSION_TABLE } from "../constants";
import { reviewCard } from "./addonQuote";
import { canCreateAddon, type AddonRowLike } from "./addonRow";
import { stage4FlagMode } from "./flags";
import { reviewCellsOf } from "./review";
import type { ReviewQuoteView, ReviewVersionChoice } from "./reviewPreviewLabels";
import { readPublishedVersion } from "./versionFile";
import { listVersionSummaries } from "./versionList";

/**
 * MONEY PR 7c, PHASE 2B-2 TASK 2 (docs/MONEY-PR-7A.md section 15): THE REVIEW-PRICE PREVIEW, behind DIGER_STAGE4_REVIEW. READ-ONLY and by code: the version is read from storage (`readPublishedVersion`: the customer's own mission, a published version, checked),
 * its readable cells are counted by the existing `reviewCellsOf`, and the price is the existing `reviewCard`. No model, no provider, no price from the browser, and nothing is written: no hold, no charge, no release, no refund, no add-on row.
 * The offer follows the add-on rules (`canCreateAddon`, the same function the creation will use): one open add-on per file blocks it, and a version that already has a completed review shows that review instead (decision D11: free).
 */

/** Only «on» shows the preview. «test» is NOT served here: telling a test account apart needs the test-account list, which customer-side code must never import (the same rule as the versions list). */
export function reviewPreviewAvailable(env?: Readonly<Record<string, string | undefined>>): boolean {
  return stage4FlagMode("DIGER_STAGE4_REVIEW", env) === "on";
}

type Failure = { ok: false; status: 404 | 500 | 503; error: "not_found" | "damaged" | "unavailable" };
const no = (status: 404 | 500 | 503, error: Failure["error"]): Failure => ({ ok: false, status, error });

/** The add-on rows of this customer on this delivered mission (any status). A read that fails THROWS: «no add-on» is never assumed from an error. */
async function addonRowsOf(client: any, userId: string, missionId: string): Promise<AddonRowLike[]> {
  const { data, error } = await client.from(MISSION_TABLE).select("id,status,plan").eq("user_id", userId).eq("plan->addon->>of", missionId);
  if (error || !Array.isArray(data)) throw new Error("add-on rows unavailable");
  return data.map((r: any) => ({ id: String(r.id), status: String(r.status), plan: r.plan }));
}

export type ReviewVersionsResult = { ok: true; versions: ReviewVersionChoice[] } | Failure;

/** The published versions of the customer's own mission, oldest first: what the page offers to review. Pending versions are not in `versions/`, so they are never listed. */
export async function reviewableVersions(client: any, input: { missionId: string; userId: string }): Promise<ReviewVersionsResult> {
  try {
    const { data, error } = await client.from(MISSION_TABLE).select("id,user_id").eq("id", input.missionId).maybeSingle();
    if (error) return no(503, "unavailable");
    if (!data || data.user_id !== input.userId) return no(404, "not_found");
    const list = await listVersionSummaries(client, input.missionId);
    return { ok: true, versions: list.map((v) => ({ version: v.version, reason: v.reason })) };
  } catch {
    return no(503, "unavailable");
  }
}

export type ReviewQuoteResult = { ok: true; quote: ReviewQuoteView } | Failure;

/** The review quote of published version `version` of the customer's own mission. */
export async function reviewQuoteFor(client: any, input: { missionId: string; userId: string; version: number }): Promise<ReviewQuoteResult> {
  const read = await readPublishedVersion(client, input);
  if (!read.ok) return read;
  let rows: AddonRowLike[];
  try { rows = await addonRowsOf(client, input.userId, input.missionId); } catch { return no(503, "unavailable"); }
  const { reason } = read.version;
  const gate = canCreateAddon({ rows, of: input.missionId, kind: "review", baseVersion: input.version, latestVersion: read.latest });
  if (!gate.ok) return { ok: true, quote: { state: gate.reason === "review_exists" ? "reuse" : "blocked", version: input.version, reason } };
  const cells = reviewCellsOf(read.version);
  if (cells === 0) return { ok: true, quote: { state: "nothing_to_review", version: input.version, reason, cells } };
  const card = reviewCard(cells);
  if (!card.ok) return { ok: true, quote: { state: card.reason === "too_large" ? "too_large" : "nothing_to_review", version: input.version, reason, cells } };
  return { ok: true, quote: { state: "offer", version: input.version, reason, cells, points: card.holdPoints } };
}
